import { and, eq, gte, lt, or, sql } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  telegramDeliveries,
  telegramIntegrationStatus,
  telegramMessageLinks,
  telegramOwnerLinks,
  telegramPendingClarifications,
  telegramPollState,
  telegramUpdates,
  users,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export const TELEGRAM_PROCESSING_MAX_ATTEMPTS = 3;
const TELEGRAM_PROCESSING_LEASE_MS = 5 * 60_000;

export type TelegramProcessingFailure = Readonly<{
  kind: 'retryable' | 'terminal';
  category: string;
}>;

export type TelegramProcessingFailureResult =
  | Readonly<{ status: 'retryable'; nextProcessingAttemptAt: string }>
  | Readonly<{ status: 'failed' | 'already_terminal'; nextProcessingAttemptAt: null }>;

export type PersistableTelegramUpdate =
  | Readonly<{
      kind: 'ignored';
      updateId: bigint;
      reason: string;
      chatId: bigint | null;
      senderId: bigint | null;
      messageId: bigint | null;
    }>
  | Readonly<{
      kind: 'message';
      message: Readonly<{
        updateId: bigint;
        chatId: bigint;
        senderId: bigint;
        messageId: bigint;
        sentAt: string;
        text: string;
        textHash: string;
        locale: 'en' | 'ru';
        localeDetected: boolean;
        chatType: 'private' | 'group' | 'supergroup' | 'channel';
        senderIsBot: boolean;
        forwarded: boolean;
        replyToMessageId: bigint | null;
      }>;
    }>;

export type PersistedTelegramDraft = Readonly<{
  kind: 'cash_income' | 'future_expense' | 'unknown';
  amountMinor?: string;
  label?: string;
  dueDate?: string;
  economicDate?: string;
  effectiveAt?: string;
  locale: 'en' | 'ru';
}>;

export type ClaimedTelegramUpdate = Readonly<{
  sourceKey: string;
  updateId: bigint;
  ownerId: string;
  chatId: bigint;
  senderId: bigint;
  messageId: bigint;
  replyToMessageId: bigint | null;
  messageDate: string;
  messageText: string;
  textHash: string;
  locale: 'en' | 'ru';
  attemptCount: number;
}>;

export type TelegramClarification = Readonly<{
  id: string;
  ownerId: string;
  sourceKey: string;
  chatId: bigint;
  senderId: bigint;
  originUpdateId: bigint;
  originMessageId: bigint;
  proposalKind: string;
  missingField: string;
  draft: PersistedTelegramDraft;
  locale: 'en' | 'ru';
  invalidAttempts: number;
  expiresAt: string;
}>;

function processingFailureReply(locale: 'en' | 'ru'): string {
  return locale === 'ru'
    ? 'Не удалось обработать запись. Отправьте её ещё раз.'
    : 'I couldn’t process this entry. Please send it again.';
}

export async function configureTelegramOwnerLink(
  db: Database,
  input: Readonly<{
    sourceKey: string;
    telegramUserId: bigint;
    ownerId: string;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const owner = await tx.query.users.findFirst({ where: eq(users.id, input.ownerId) });
    if (owner === undefined)
      throw new DataInvariantError('telegram.owner_not_found', 'TELEGRAM_OWNER_ID does not exist.');
    const existingIdentity = await tx.query.telegramOwnerLinks.findFirst({
      where: and(
        eq(telegramOwnerLinks.sourceKey, input.sourceKey),
        eq(telegramOwnerLinks.telegramUserId, input.telegramUserId),
      ),
    });
    if (existingIdentity !== undefined && existingIdentity.ownerId !== input.ownerId) {
      throw new DataConflictError(
        'telegram.owner_link_conflict',
        'Telegram identity is already linked to another owner.',
      );
    }
    const existingOwner = await tx.query.telegramOwnerLinks.findFirst({
      where: and(
        eq(telegramOwnerLinks.sourceKey, input.sourceKey),
        eq(telegramOwnerLinks.ownerId, input.ownerId),
      ),
    });
    if (existingOwner !== undefined) {
      await tx
        .update(telegramOwnerLinks)
        .set({ telegramUserId: input.telegramUserId, updatedAt: input.now })
        .where(
          and(
            eq(telegramOwnerLinks.sourceKey, input.sourceKey),
            eq(telegramOwnerLinks.ownerId, input.ownerId),
          ),
        );
      return;
    }
    await tx
      .insert(telegramOwnerLinks)
      .values({
        sourceKey: input.sourceKey,
        telegramUserId: input.telegramUserId,
        ownerId: input.ownerId,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing();
  });
}

export async function setTelegramIntegrationStatus(
  db: Database,
  value: Readonly<{
    enabled: boolean;
    sourceKey: string | null;
    status: string;
    errorCategory?: string | null;
    now: string;
  }>,
): Promise<void> {
  await db
    .insert(telegramIntegrationStatus)
    .values({
      name: 'default',
      enabled: value.enabled,
      sourceKey: value.sourceKey,
      status: value.status,
      lastProcessedUpdateId: null,
      lastProcessedAt: null,
      lastErrorCategory: value.errorCategory ?? null,
      updatedAt: value.now,
    })
    .onConflictDoUpdate({
      target: telegramIntegrationStatus.name,
      set: {
        enabled: value.enabled,
        sourceKey: value.sourceKey,
        status: value.status,
        lastErrorCategory: value.errorCategory ?? null,
        updatedAt: value.now,
      },
    });
}

export async function loadTelegramPollOffset(
  db: Database,
  sourceKey: string,
): Promise<bigint | null> {
  const row = await db.query.telegramPollState.findFirst({
    where: eq(telegramPollState.sourceKey, sourceKey),
  });
  return row?.nextOffset ?? null;
}

export async function persistTelegramUpdatePage(
  db: Database,
  input: Readonly<{
    sourceKey: string;
    ownerId: string;
    allowedUserId: bigint;
    updates: readonly PersistableTelegramUpdate[];
    now: string;
  }>,
): Promise<Readonly<{ nextOffset: bigint | null; inserted: number }>> {
  return db.transaction(async (tx) => {
    const configuredOwner = await tx.query.users.findFirst({
      where: eq(users.id, input.ownerId),
    });
    if (configuredOwner === undefined) {
      throw new DataInvariantError('telegram.owner_not_found', 'Telegram owner does not exist.');
    }
    const ownerLocale = configuredOwner.locale === 'ru' ? 'ru' : 'en';
    let inserted = 0;
    let maximum: bigint | null = null;
    for (const normalized of input.updates) {
      const normalizedUpdateId =
        normalized.kind === 'message' ? normalized.message.updateId : normalized.updateId;
      maximum = maximum === null || normalizedUpdateId > maximum ? normalizedUpdateId : maximum;
      if (normalized.kind === 'ignored') {
        const rows = await tx
          .insert(telegramUpdates)
          .values({
            sourceKey: input.sourceKey,
            updateId: normalized.updateId,
            ownerId: null,
            chatId: normalized.chatId,
            senderId: normalized.senderId,
            messageId: normalized.messageId,
            replyToMessageId: null,
            updateType: normalized.reason,
            messageDate: null,
            messageText: null,
            textHash: null,
            locale: null,
            status: 'rejected',
            parserOutcome: null,
            proposalKind: null,
            commandId: null,
            entityType: null,
            entityId: null,
            safeErrorCategory: normalized.reason,
            attemptCount: 0,
            receivedAt: input.now,
            processingStartedAt: null,
            processedAt: input.now,
          })
          .onConflictDoNothing()
          .returning({ updateId: telegramUpdates.updateId });
        inserted += rows.length;
        continue;
      }
      const message = normalized.message;
      const authorized =
        message.senderId === input.allowedUserId &&
        message.chatType === 'private' &&
        !message.senderIsBot &&
        !message.forwarded;
      const rows = await tx
        .insert(telegramUpdates)
        .values({
          sourceKey: input.sourceKey,
          updateId: message.updateId,
          ownerId: authorized ? input.ownerId : null,
          chatId: message.chatId,
          senderId: message.senderId,
          messageId: message.messageId,
          replyToMessageId: message.replyToMessageId,
          updateType: 'message',
          messageDate: message.sentAt,
          messageText: authorized ? message.text : null,
          textHash: message.textHash,
          locale: message.localeDetected ? message.locale : ownerLocale,
          status: authorized ? 'received' : 'rejected',
          parserOutcome: null,
          proposalKind: null,
          commandId: null,
          entityType: null,
          entityId: null,
          safeErrorCategory: authorized ? null : 'unauthorized_or_unsafe_context',
          attemptCount: 0,
          receivedAt: input.now,
          processingStartedAt: null,
          processedAt: authorized ? null : input.now,
        })
        .onConflictDoNothing()
        .returning({ updateId: telegramUpdates.updateId });
      inserted += rows.length;
    }
    const previousOffset = await loadOffsetInTransaction(tx, input.sourceKey);
    const candidateOffset = maximum === null ? null : maximum + 1n;
    const nextOffset =
      previousOffset === null
        ? candidateOffset
        : candidateOffset === null || previousOffset > candidateOffset
          ? previousOffset
          : candidateOffset;
    await tx
      .insert(telegramPollState)
      .values({
        sourceKey: input.sourceKey,
        nextOffset,
        lastPolledAt: input.now,
        lastErrorCategory: null,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: telegramPollState.sourceKey,
        set: { nextOffset, lastPolledAt: input.now, lastErrorCategory: null, updatedAt: input.now },
      });
    return Object.freeze({ nextOffset, inserted });
  });
}

async function loadOffsetInTransaction(
  tx: DatabaseTransaction,
  sourceKey: string,
): Promise<bigint | null> {
  const row = await tx.query.telegramPollState.findFirst({
    where: eq(telegramPollState.sourceKey, sourceKey),
  });
  return row?.nextOffset ?? null;
}

export async function claimTelegramUpdate(
  db: Database,
  sourceKey: string,
  now: string,
): Promise<ClaimedTelegramUpdate | null> {
  const stale = new Date(new Date(now).getTime() - TELEGRAM_PROCESSING_LEASE_MS).toISOString();
  const rows = await db.transaction(async (tx) => {
    const exhausted = await tx.execute(sql<Record<string, unknown>>`
      update telegram_updates
         set status = 'failed',
             message_text = null,
             parser_outcome = 'failed',
             proposal_kind = null,
             safe_error_category = 'processing_lease_exhausted',
             processing_started_at = null,
             next_processing_attempt_at = null,
             processed_at = ${now}::timestamptz
       where source_key = ${sourceKey}
         and status = 'processing'
         and attempt_count >= ${TELEGRAM_PROCESSING_MAX_ATTEMPTS}
         and processing_started_at < ${stale}::timestamptz
      returning source_key, update_id, owner_id, chat_id, message_id, locale
    `);
    for (const row of exhausted.rows) {
      if (
        typeof row['owner_id'] !== 'string' ||
        row['chat_id'] === null ||
        row['message_id'] === null ||
        (row['locale'] !== 'en' && row['locale'] !== 'ru')
      )
        continue;
      await tx
        .insert(telegramDeliveries)
        .values({
          id: generateUuidV7('telegram-delivery'),
          sourceKey: String(row['source_key']),
          ownerId: row['owner_id'],
          updateId: BigInt(row['update_id'] as string),
          chatId: BigInt(row['chat_id'] as string),
          replyToMessageId: BigInt(row['message_id'] as string),
          purpose: 'processing_failed',
          responseText: processingFailureReply(row['locale']),
          status: 'pending',
          attemptCount: 0,
          botMessageId: null,
          safeErrorCategory: null,
          nextAttemptAt: now,
          createdAt: now,
          completedAt: null,
        })
        .onConflictDoNothing();
    }
    if (exhausted.rows.length > 0) {
      await tx
        .insert(telegramIntegrationStatus)
        .values({
          name: 'default',
          enabled: true,
          sourceKey,
          status: 'degraded',
          lastProcessedUpdateId: null,
          lastProcessedAt: null,
          lastErrorCategory: 'processing_lease_exhausted',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: telegramIntegrationStatus.name,
          set: {
            status: 'degraded',
            lastErrorCategory: 'processing_lease_exhausted',
            updatedAt: now,
          },
        });
    }
    return tx.execute(sql<Record<string, unknown>>`
      with candidate as (
        select source_key, update_id
        from telegram_updates
        where source_key = ${sourceKey}
          and (
            status = 'received'
            or (
              status = 'retryable'
              and next_processing_attempt_at <= ${now}::timestamptz
              and attempt_count < ${TELEGRAM_PROCESSING_MAX_ATTEMPTS}
            )
            or (
              status = 'processing'
              and processing_started_at < ${stale}::timestamptz
              and attempt_count < ${TELEGRAM_PROCESSING_MAX_ATTEMPTS}
            )
          )
        order by update_id
        for update skip locked
        limit 1
      )
      update telegram_updates u
         set status = 'processing',
             processing_started_at = ${now}::timestamptz,
             next_processing_attempt_at = null,
             safe_error_category = null,
             attempt_count = u.attempt_count + 1
        from candidate c
       where u.source_key = c.source_key and u.update_id = c.update_id
      returning u.source_key, u.update_id, u.owner_id, u.chat_id, u.sender_id,
                u.message_id, u.reply_to_message_id, u.message_date, u.message_text,
                u.text_hash, u.locale, u.attempt_count
    `);
  });
  const row = rows.rows[0];
  if (row === undefined) return null;
  if (
    typeof row['source_key'] !== 'string' ||
    typeof row['owner_id'] !== 'string' ||
    typeof row['message_date'] !== 'string' ||
    typeof row['message_text'] !== 'string' ||
    typeof row['text_hash'] !== 'string' ||
    (row['locale'] !== 'en' && row['locale'] !== 'ru')
  ) {
    throw new DataInvariantError(
      'telegram.invalid_claim',
      'Claimed Telegram update is incomplete.',
    );
  }
  return Object.freeze({
    sourceKey: row['source_key'],
    updateId: BigInt(row['update_id'] as string),
    ownerId: row['owner_id'],
    chatId: BigInt(row['chat_id'] as string),
    senderId: BigInt(row['sender_id'] as string),
    messageId: BigInt(row['message_id'] as string),
    replyToMessageId:
      row['reply_to_message_id'] === null ? null : BigInt(row['reply_to_message_id'] as string),
    messageDate: new Date(row['message_date']).toISOString(),
    messageText: row['message_text'],
    textHash: row['text_hash'],
    locale: row['locale'],
    attemptCount: Number(row['attempt_count']),
  });
}

export async function loadNextTelegramProcessingAttemptAt(
  db: Database,
  sourceKey: string,
): Promise<string | null> {
  const result = await db.execute(sql<{ next_attempt_at: string | null }>`
    select min(next_processing_attempt_at)::text as next_attempt_at
      from telegram_updates
     where source_key = ${sourceKey} and status = 'retryable'
  `);
  const value = result.rows[0]?.['next_attempt_at'];
  return typeof value === 'string' ? new Date(value).toISOString() : null;
}

export async function expireTelegramState(
  db: Database,
  sourceKey: string,
  now: string,
): Promise<void> {
  const rawCutoff = new Date(new Date(now).getTime() - 24 * 60 * 60_000).toISOString();
  const deliveryLeaseCutoff = new Date(new Date(now).getTime() - 5 * 60_000).toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(telegramPendingClarifications)
      .set({ status: 'expired', knownFields: null, resolvedAt: now })
      .where(
        and(
          eq(telegramPendingClarifications.sourceKey, sourceKey),
          eq(telegramPendingClarifications.status, 'active'),
          lt(telegramPendingClarifications.expiresAt, now),
        ),
      );
    await tx
      .update(telegramUpdates)
      .set({
        status: 'expired',
        messageText: null,
        processingStartedAt: null,
        nextProcessingAttemptAt: null,
        processedAt: now,
        safeErrorCategory: 'retention_expired',
      })
      .where(
        and(
          eq(telegramUpdates.sourceKey, sourceKey),
          or(
            eq(telegramUpdates.status, 'received'),
            eq(telegramUpdates.status, 'processing'),
            eq(telegramUpdates.status, 'retryable'),
          ),
          lt(telegramUpdates.receivedAt, rawCutoff),
        ),
      );
    await tx
      .update(telegramDeliveries)
      .set({
        status: 'failed',
        responseText: null,
        completedAt: now,
        safeErrorCategory: 'retention_expired',
      })
      .where(
        and(
          eq(telegramDeliveries.sourceKey, sourceKey),
          or(eq(telegramDeliveries.status, 'pending'), eq(telegramDeliveries.status, 'retryable')),
          lt(telegramDeliveries.createdAt, rawCutoff),
        ),
      );
    await tx
      .update(telegramDeliveries)
      .set({
        status: 'uncertain',
        responseText: null,
        completedAt: now,
        safeErrorCategory: 'delivery_interrupted',
        nextAttemptAt: null,
      })
      .where(
        and(
          eq(telegramDeliveries.sourceKey, sourceKey),
          eq(telegramDeliveries.status, 'sending'),
          lt(telegramDeliveries.nextAttemptAt, deliveryLeaseCutoff),
        ),
      );
  });
}

export async function loadActiveTelegramClarification(
  db: Database | DatabaseTransaction,
  ownerId: string,
  sourceKey: string,
  chatId: bigint,
  now: string,
): Promise<TelegramClarification | null> {
  const row = await db.query.telegramPendingClarifications.findFirst({
    where: and(
      eq(telegramPendingClarifications.ownerId, ownerId),
      eq(telegramPendingClarifications.sourceKey, sourceKey),
      eq(telegramPendingClarifications.chatId, chatId),
      eq(telegramPendingClarifications.status, 'active'),
    ),
  });
  if (row === undefined || new Date(row.expiresAt).getTime() <= new Date(now).getTime())
    return null;
  if (row.knownFields === null) return null;
  return Object.freeze({
    id: row.id,
    ownerId: row.ownerId,
    sourceKey: row.sourceKey,
    chatId: row.chatId,
    senderId: row.senderId,
    originUpdateId: row.originUpdateId,
    originMessageId: row.originMessageId,
    proposalKind: row.proposalKind,
    missingField: row.missingField,
    draft: decodeSourceJson(row.knownFields) as PersistedTelegramDraft,
    locale: row.locale as 'en' | 'ru',
    invalidAttempts: row.invalidAttempts,
    expiresAt: new Date(row.expiresAt).toISOString(),
  });
}

export async function createTelegramClarification(
  tx: DatabaseTransaction,
  input: Readonly<{
    update: ClaimedTelegramUpdate;
    proposalKind: string;
    missingField: string;
    draft: PersistedTelegramDraft;
    question: string;
    now: string;
  }>,
): Promise<void> {
  await tx
    .update(telegramPendingClarifications)
    .set({ status: 'superseded', knownFields: null, resolvedAt: input.now })
    .where(
      and(
        eq(telegramPendingClarifications.ownerId, input.update.ownerId),
        eq(telegramPendingClarifications.sourceKey, input.update.sourceKey),
        eq(telegramPendingClarifications.chatId, input.update.chatId),
        eq(telegramPendingClarifications.status, 'active'),
      ),
    );
  await tx.insert(telegramPendingClarifications).values({
    id: generateUuidV7('telegram-clarification'),
    ownerId: input.update.ownerId,
    sourceKey: input.update.sourceKey,
    chatId: input.update.chatId,
    senderId: input.update.senderId,
    originUpdateId: input.update.updateId,
    originMessageId: input.update.messageId,
    proposalKind: input.proposalKind,
    missingField: input.missingField,
    knownFields: encodeSourceJson(input.draft),
    locale: input.draft.locale,
    invalidAttempts: 0,
    status: 'active',
    createdAt: input.now,
    expiresAt: new Date(new Date(input.now).getTime() + 15 * 60_000).toISOString(),
    resolvedAt: null,
    resolvedByUpdateId: null,
  });
  await finalizeTelegramUpdate(tx, {
    update: input.update,
    status: 'awaiting_clarification',
    parserOutcome: 'needs_clarification',
    proposalKind: input.proposalKind,
    now: input.now,
  });
  await queueTelegramDelivery(tx, {
    update: input.update,
    purpose: 'clarification',
    text: input.question,
    now: input.now,
  });
}

export async function incrementOrCancelClarification(
  tx: DatabaseTransaction,
  clarification: TelegramClarification,
  update: ClaimedTelegramUpdate,
  question: string,
  now: string,
): Promise<boolean> {
  const cancel = clarification.invalidAttempts + 1 >= 2;
  await tx
    .update(telegramPendingClarifications)
    .set(
      cancel
        ? {
            status: 'cancelled',
            knownFields: null,
            resolvedAt: now,
            resolvedByUpdateId: update.updateId,
          }
        : {
            invalidAttempts: clarification.invalidAttempts + 1,
            missingField: clarification.missingField,
          },
    )
    .where(eq(telegramPendingClarifications.id, clarification.id));
  await finalizeTelegramUpdate(tx, {
    update,
    status: cancel ? 'unsupported' : 'awaiting_clarification',
    parserOutcome: cancel ? 'clarification_cancelled' : 'needs_clarification',
    proposalKind: clarification.proposalKind,
    now,
  });
  await queueTelegramDelivery(tx, {
    update,
    purpose: cancel ? 'clarification_cancelled' : 'clarification',
    text: cancel
      ? update.locale === 'ru'
        ? 'Не получилось уточнить. Отправьте команду заново целиком.'
        : 'I could not complete that. Please resend the full command.'
      : question,
    now,
  });
  return cancel;
}

export async function advanceTelegramClarification(
  tx: DatabaseTransaction,
  clarification: TelegramClarification,
  update: ClaimedTelegramUpdate,
  draft: PersistedTelegramDraft,
  missingField: string,
  question: string,
  now: string,
): Promise<void> {
  await tx
    .update(telegramPendingClarifications)
    .set({ knownFields: encodeSourceJson(draft), missingField })
    .where(
      and(
        eq(telegramPendingClarifications.id, clarification.id),
        eq(telegramPendingClarifications.status, 'active'),
      ),
    );
  await finalizeTelegramUpdate(tx, {
    update,
    status: 'awaiting_clarification',
    parserOutcome: 'needs_clarification',
    proposalKind: clarification.proposalKind,
    now,
  });
  await queueTelegramDelivery(tx, {
    update,
    purpose: 'clarification',
    text: question,
    now,
  });
}

export async function resolveTelegramClarification(
  tx: DatabaseTransaction,
  clarificationId: string,
  updateId: bigint,
  now: string,
  status: 'resolved' | 'superseded' = 'resolved',
): Promise<void> {
  await tx
    .update(telegramPendingClarifications)
    .set({ status, knownFields: null, resolvedAt: now, resolvedByUpdateId: updateId })
    .where(
      and(
        eq(telegramPendingClarifications.id, clarificationId),
        eq(telegramPendingClarifications.status, 'active'),
      ),
    );
}

export async function cancelTelegramClarification(
  tx: DatabaseTransaction,
  update: ClaimedTelegramUpdate,
  now: string,
): Promise<boolean> {
  const rows = await tx
    .update(telegramPendingClarifications)
    .set({
      status: 'cancelled',
      knownFields: null,
      resolvedAt: now,
      resolvedByUpdateId: update.updateId,
    })
    .where(
      and(
        eq(telegramPendingClarifications.ownerId, update.ownerId),
        eq(telegramPendingClarifications.sourceKey, update.sourceKey),
        eq(telegramPendingClarifications.chatId, update.chatId),
        eq(telegramPendingClarifications.status, 'active'),
      ),
    )
    .returning({ id: telegramPendingClarifications.id });
  return rows.length > 0;
}

export async function finalizeTelegramUpdate(
  tx: DatabaseTransaction,
  input: Readonly<{
    update: ClaimedTelegramUpdate;
    status: 'completed' | 'unsupported' | 'awaiting_clarification' | 'failed';
    parserOutcome: string;
    proposalKind: string | null;
    now: string;
    commandId?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    errorCategory?: string | null;
  }>,
): Promise<void> {
  await tx
    .update(telegramUpdates)
    .set({
      status: input.status,
      messageText: null,
      parserOutcome: input.parserOutcome,
      proposalKind: input.proposalKind,
      commandId: input.commandId ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      safeErrorCategory: input.errorCategory ?? null,
      processingStartedAt: null,
      nextProcessingAttemptAt: null,
      processedAt: input.now,
    })
    .where(
      and(
        eq(telegramUpdates.sourceKey, input.update.sourceKey),
        eq(telegramUpdates.updateId, input.update.updateId),
      ),
    );
  await tx
    .insert(telegramIntegrationStatus)
    .values({
      name: 'default',
      enabled: true,
      sourceKey: input.update.sourceKey,
      status: input.status === 'failed' ? 'degraded' : 'running',
      lastProcessedUpdateId: input.update.updateId,
      lastProcessedAt: input.now,
      lastErrorCategory: input.errorCategory ?? null,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: telegramIntegrationStatus.name,
      set: {
        status: input.status === 'failed' ? 'degraded' : 'running',
        lastProcessedUpdateId: input.update.updateId,
        lastProcessedAt: input.now,
        lastErrorCategory: input.errorCategory ?? null,
        updatedAt: input.now,
      },
    });
}

export async function queueTelegramDelivery(
  tx: DatabaseTransaction,
  input: Readonly<{
    update: ClaimedTelegramUpdate;
    purpose: string;
    text: string;
    now: string;
  }>,
): Promise<string> {
  const id = generateUuidV7('telegram-delivery');
  await tx
    .insert(telegramDeliveries)
    .values({
      id,
      sourceKey: input.update.sourceKey,
      ownerId: input.update.ownerId,
      updateId: input.update.updateId,
      chatId: input.update.chatId,
      replyToMessageId: input.update.messageId,
      purpose: input.purpose,
      responseText: input.text,
      status: 'pending',
      attemptCount: 0,
      botMessageId: null,
      safeErrorCategory: null,
      nextAttemptAt: input.now,
      createdAt: input.now,
      completedAt: null,
    })
    .onConflictDoNothing();
  return id;
}

export async function createTelegramMessageLink(
  tx: DatabaseTransaction,
  input: Readonly<{
    update: ClaimedTelegramUpdate;
    commandId: string;
    proposalKind: string;
    entityType: string;
    entityId: string;
    now: string;
  }>,
): Promise<string> {
  const id = generateUuidV7('telegram-message-link');
  await tx.insert(telegramMessageLinks).values({
    id,
    ownerId: input.update.ownerId,
    sourceKey: input.update.sourceKey,
    chatId: input.update.chatId,
    userMessageId: input.update.messageId,
    botMessageId: null,
    updateId: input.update.updateId,
    commandId: input.commandId,
    proposalKind: input.proposalKind,
    entityType: input.entityType,
    entityId: input.entityId,
    status: 'current',
    supersededBy: null,
    createdAt: input.now,
  });
  return id;
}

export async function findTelegramCorrectionTarget(
  tx: DatabaseTransaction,
  input: Readonly<{
    ownerId: string;
    sourceKey: string;
    chatId: bigint;
    botMessageId: bigint;
    now: string;
  }>,
) {
  const cutoff = new Date(new Date(input.now).getTime() - 30 * 24 * 60 * 60_000).toISOString();
  return (
    (await tx.query.telegramMessageLinks.findFirst({
      where: and(
        eq(telegramMessageLinks.ownerId, input.ownerId),
        eq(telegramMessageLinks.sourceKey, input.sourceKey),
        eq(telegramMessageLinks.chatId, input.chatId),
        eq(telegramMessageLinks.botMessageId, input.botMessageId),
        eq(telegramMessageLinks.status, 'current'),
        gte(telegramMessageLinks.createdAt, cutoff),
      ),
    })) ?? null
  );
}

export async function supersedeTelegramMessageLink(
  tx: DatabaseTransaction,
  currentId: string,
  successorId: string | null,
  cancelled: boolean,
): Promise<void> {
  await tx
    .update(telegramMessageLinks)
    .set({ status: cancelled ? 'cancelled' : 'superseded', supersededBy: successorId })
    .where(eq(telegramMessageLinks.id, currentId));
}

export type ClaimedTelegramDelivery = Readonly<{
  id: string;
  sourceKey: string;
  updateId: bigint;
  chatId: bigint;
  replyToMessageId: bigint | null;
  text: string;
  attemptCount: number;
}>;

export async function claimTelegramDelivery(
  db: Database,
  sourceKey: string,
  now: string,
): Promise<ClaimedTelegramDelivery | null> {
  const rows = await db.execute(sql<Record<string, unknown>>`
    with candidate as (
      select id
      from telegram_deliveries
      where source_key = ${sourceKey}
        and status in ('pending', 'retryable')
        and (next_attempt_at is null or next_attempt_at <= ${now}::timestamptz)
      order by created_at
      for update skip locked
      limit 1
    )
    update telegram_deliveries d
       set status = 'sending',
           attempt_count = d.attempt_count + 1,
           next_attempt_at = ${now}::timestamptz
      from candidate c
     where d.id = c.id
    returning d.id, d.source_key, d.update_id, d.chat_id, d.reply_to_message_id,
              d.response_text, d.attempt_count
  `);
  const row = rows.rows[0];
  if (row === undefined || typeof row['response_text'] !== 'string') return null;
  return Object.freeze({
    id: String(row['id']),
    sourceKey: String(row['source_key']),
    updateId: BigInt(row['update_id'] as string),
    chatId: BigInt(row['chat_id'] as string),
    replyToMessageId:
      row['reply_to_message_id'] === null ? null : BigInt(row['reply_to_message_id'] as string),
    text: row['response_text'],
    attemptCount: Number(row['attempt_count']),
  });
}

export async function completeTelegramDelivery(
  db: Database,
  input: Readonly<{
    delivery: ClaimedTelegramDelivery;
    outcome: 'sent' | 'retryable' | 'failed' | 'uncertain';
    botMessageId?: bigint | null;
    errorCategory?: string | null;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const terminal =
      input.outcome === 'sent' || input.outcome === 'failed' || input.outcome === 'uncertain';
    await tx
      .update(telegramDeliveries)
      .set({
        status: input.outcome,
        responseText: terminal ? null : input.delivery.text,
        botMessageId: input.botMessageId ?? null,
        safeErrorCategory: input.errorCategory ?? null,
        nextAttemptAt:
          input.outcome === 'retryable'
            ? new Date(
                new Date(input.now).getTime() +
                  Math.min(30, 2 ** input.delivery.attemptCount) * 1000,
              ).toISOString()
            : null,
        completedAt: terminal ? input.now : null,
      })
      .where(eq(telegramDeliveries.id, input.delivery.id));
    if (
      input.outcome === 'sent' &&
      input.botMessageId !== null &&
      input.botMessageId !== undefined
    ) {
      await tx
        .update(telegramMessageLinks)
        .set({ botMessageId: input.botMessageId })
        .where(
          and(
            eq(telegramMessageLinks.sourceKey, input.delivery.sourceKey),
            eq(telegramMessageLinks.updateId, input.delivery.updateId),
          ),
        );
    }
  });
}

export async function recordTelegramProcessingFailure(
  db: Database,
  update: ClaimedTelegramUpdate,
  failure: TelegramProcessingFailure,
  now: string,
): Promise<TelegramProcessingFailureResult> {
  return db.transaction(async (tx) => {
    const retryable =
      failure.kind === 'retryable' && update.attemptCount < TELEGRAM_PROCESSING_MAX_ATTEMPTS;
    const nextProcessingAttemptAt = retryable
      ? new Date(
          new Date(now).getTime() + 1000 * 2 ** Math.max(0, update.attemptCount - 1),
        ).toISOString()
      : null;
    const rows = await tx
      .update(telegramUpdates)
      .set(
        retryable
          ? {
              status: 'retryable',
              processingStartedAt: null,
              nextProcessingAttemptAt,
              processedAt: null,
              safeErrorCategory: failure.category,
            }
          : {
              status: 'failed',
              messageText: null,
              parserOutcome: 'failed',
              proposalKind: null,
              commandId: null,
              entityType: null,
              entityId: null,
              safeErrorCategory: failure.category,
              processingStartedAt: null,
              nextProcessingAttemptAt: null,
              processedAt: now,
            },
      )
      .where(
        and(
          eq(telegramUpdates.sourceKey, update.sourceKey),
          eq(telegramUpdates.updateId, update.updateId),
          eq(telegramUpdates.status, 'processing'),
          eq(telegramUpdates.attemptCount, update.attemptCount),
        ),
      )
      .returning({ updateId: telegramUpdates.updateId });
    if (rows.length === 0) {
      return Object.freeze({ status: 'already_terminal' as const, nextProcessingAttemptAt: null });
    }
    if (!retryable && failure.kind === 'retryable') {
      await queueTelegramDelivery(tx, {
        update,
        purpose: 'processing_failed',
        text: processingFailureReply(update.locale),
        now,
      });
    }
    await tx
      .insert(telegramIntegrationStatus)
      .values({
        name: 'default',
        enabled: true,
        sourceKey: update.sourceKey,
        status: 'degraded',
        lastProcessedUpdateId: retryable ? null : update.updateId,
        lastProcessedAt: retryable ? null : now,
        lastErrorCategory: failure.category,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: telegramIntegrationStatus.name,
        set: {
          status: 'degraded',
          ...(retryable ? {} : { lastProcessedUpdateId: update.updateId, lastProcessedAt: now }),
          lastErrorCategory: failure.category,
          updatedAt: now,
        },
      });
    return retryable
      ? Object.freeze({
          status: 'retryable' as const,
          nextProcessingAttemptAt: nextProcessingAttemptAt!,
        })
      : Object.freeze({ status: 'failed' as const, nextProcessingAttemptAt: null });
  });
}
