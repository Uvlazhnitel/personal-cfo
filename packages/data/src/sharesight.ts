import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { and, eq, isNotNull, lte } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import {
  accounts,
  sharesightRawReceipts,
  sharesightSourceRevisions,
  sharesightSyncRuns,
  sharesightSyncStates,
  users,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

const LEASE_MILLISECONDS = 15 * 60_000;
const RAW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;

export type SharesightReceiptKey = Uint8Array & { readonly __sharesightReceiptKey: unique symbol };

export type SharesightSyncLease = Readonly<{
  leaseId: string;
  runId: string;
  ownerId: string;
  portfolioId: string;
  investmentAccountId: string;
  connectionId: string;
  continuation: Readonly<Record<string, string>> | null;
}>;

export type PersistedSharesightReceipt = Readonly<{
  id: string;
  runId: string;
  capability: string;
  requestKey: string;
  requestFrom: string | null;
  requestTo: string | null;
  receivedAt: string;
  payloadSha256: string;
  payload: string;
}>;

export type SharesightRevisionInput = Readonly<{
  sourceId: string;
  revisionSha256: string;
  recordKind: string;
}>;

export type SharesightRevisionDisposition = Readonly<{
  sourceId: string;
  revisionSha256: string;
  disposition: 'new' | 'replay' | 'revision';
}>;

function date(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DataInvariantError('sharesight.invalid_instant', 'Sharesight instant is invalid.');
  }
  return parsed;
}

export function parseSharesightReceiptKey(value: string): SharesightReceiptKey {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new DataInvariantError(
      'sharesight.invalid_receipt_key',
      'SHARESIGHT_RAW_RECEIPT_KEY must be a base64-encoded 32-byte key.',
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new DataInvariantError(
      'sharesight.invalid_receipt_key',
      'SHARESIGHT_RAW_RECEIPT_KEY must be a base64-encoded 32-byte key.',
    );
  }
  return Uint8Array.from(decoded) as SharesightReceiptKey;
}

function encryptPayload(payload: string, key: SharesightReceiptKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  });
}

function decryptPayload(
  ciphertext: string,
  iv: string,
  authTag: string,
  key: SharesightReceiptKey,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DataInvariantError(
      'sharesight.receipt_decryption_failed',
      'Sharesight raw receipt could not be decrypted.',
    );
  }
}

export async function beginSharesightSync(
  db: Database,
  input: Readonly<{
    ownerId: string;
    portfolioId: string;
    investmentAccountId: string;
    connectionId: string;
    now: string;
  }>,
): Promise<SharesightSyncLease> {
  return db.transaction(async (tx) => {
    const owner = await tx.query.users.findFirst({ where: eq(users.id, input.ownerId) });
    if (owner === undefined) {
      throw new DataInvariantError(
        'sharesight.owner_not_found',
        'Sharesight owner does not exist.',
      );
    }
    const account = await tx.query.accounts.findFirst({
      where: and(eq(accounts.id, input.investmentAccountId), eq(accounts.ownerId, input.ownerId)),
    });
    if (
      account === undefined ||
      account.kind !== 'investment' ||
      account.valueSource !== 'portfolio_valuation' ||
      account.currency !== 'EUR' ||
      (account.payload as Record<string, unknown>)['includeInNetWorth'] !== true
    ) {
      throw new DataInvariantError(
        'sharesight.invalid_investment_account',
        'Sharesight account must be an included EUR investment account owned by the configured owner.',
      );
    }
    const existing = await tx.query.sharesightSyncStates.findFirst({
      where: and(
        eq(sharesightSyncStates.ownerId, input.ownerId),
        eq(sharesightSyncStates.providerPortfolioId, input.portfolioId),
      ),
    });
    if (
      existing !== undefined &&
      (existing.investmentAccountId !== input.investmentAccountId ||
        existing.connectionId !== input.connectionId)
    ) {
      throw new DataConflictError(
        'sharesight.binding_conflict',
        'Sharesight portfolio is already bound to a different canonical account.',
      );
    }
    const nowDate = date(input.now);
    if (
      existing?.leaseId !== null &&
      existing?.leaseId !== undefined &&
      existing.leaseExpiresAt !== null &&
      date(existing.leaseExpiresAt).getTime() > nowDate.getTime()
    ) {
      throw new DataConflictError(
        'sharesight.sync_in_progress',
        'A Sharesight synchronization is already running.',
      );
    }
    const leaseId = generateUuidV7('sharesight-lease');
    const recoverableRun =
      existing?.activeRunId === null || existing?.activeRunId === undefined
        ? undefined
        : await tx.query.sharesightSyncRuns.findFirst({
            where: and(
              eq(sharesightSyncRuns.id, existing.activeRunId),
              eq(sharesightSyncRuns.status, 'running'),
            ),
          });
    const runId = recoverableRun?.id ?? generateUuidV7('sharesight-sync-run');
    const leaseExpiresAt = new Date(nowDate.getTime() + LEASE_MILLISECONDS).toISOString();
    if (recoverableRun === undefined) {
      await tx.insert(sharesightSyncRuns).values({
        id: runId,
        ownerId: input.ownerId,
        providerPortfolioId: input.portfolioId,
        status: 'running',
        scanFrom: null,
        scanTo: null,
        continuation: null,
        counts: {},
        sourceFreshness: 'unconfirmed',
        startedAt: input.now,
        completedAt: null,
        failureCategory: null,
      });
    }
    await tx
      .insert(sharesightSyncStates)
      .values({
        ownerId: input.ownerId,
        providerPortfolioId: input.portfolioId,
        investmentAccountId: input.investmentAccountId,
        connectionId: input.connectionId,
        leaseId,
        leaseExpiresAt,
        activeRunId: runId,
        lastSuccessfulSyncAt: null,
        lastFailureCategory: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [sharesightSyncStates.ownerId, sharesightSyncStates.providerPortfolioId],
        set: { leaseId, leaseExpiresAt, activeRunId: runId, updatedAt: input.now },
      });
    return Object.freeze({
      leaseId,
      runId,
      ownerId: input.ownerId,
      portfolioId: input.portfolioId,
      investmentAccountId: input.investmentAccountId,
      connectionId: input.connectionId,
      continuation:
        (recoverableRun?.continuation as Readonly<Record<string, string>> | null) ?? null,
    });
  });
}

export async function setSharesightSyncBounds(
  db: Database,
  lease: SharesightSyncLease,
  scanFrom: string,
  scanTo: string,
): Promise<void> {
  const updated = await db
    .update(sharesightSyncRuns)
    .set({ scanFrom, scanTo })
    .where(and(eq(sharesightSyncRuns.id, lease.runId), eq(sharesightSyncRuns.status, 'running')))
    .returning({ id: sharesightSyncRuns.id });
  if (updated.length !== 1) {
    throw new DataConflictError(
      'sharesight.run_not_active',
      'Sharesight synchronization run is not active.',
    );
  }
}

export async function renewSharesightSyncLease(
  db: Database,
  lease: SharesightSyncLease,
  now: string,
): Promise<void> {
  const expires = new Date(date(now).getTime() + LEASE_MILLISECONDS).toISOString();
  const updated = await db
    .update(sharesightSyncStates)
    .set({ leaseExpiresAt: expires, updatedAt: now })
    .where(
      and(
        eq(sharesightSyncStates.ownerId, lease.ownerId),
        eq(sharesightSyncStates.providerPortfolioId, lease.portfolioId),
        eq(sharesightSyncStates.leaseId, lease.leaseId),
        eq(sharesightSyncStates.activeRunId, lease.runId),
      ),
    )
    .returning({ ownerId: sharesightSyncStates.ownerId });
  if (updated.length !== 1) {
    throw new DataConflictError(
      'sharesight.lease_lost',
      'Sharesight synchronization lease was lost.',
    );
  }
}

export async function persistSharesightRawReceipt(
  db: Database,
  lease: SharesightSyncLease,
  key: SharesightReceiptKey,
  input: Readonly<{
    capability: string;
    requestKey: string;
    requestFrom: string | null;
    requestTo: string | null;
    receivedAt: string;
    payload: string;
    normalizationVersion: string;
  }>,
): Promise<PersistedSharesightReceipt> {
  const encrypted = encryptPayload(input.payload, key);
  const payloadSha256 = createHash('sha256').update(input.payload).digest('hex');
  const id = generateUuidV7('sharesight-receipt');
  const payloadExpiresAt = new Date(
    date(input.receivedAt).getTime() + RAW_RETENTION_MILLISECONDS,
  ).toISOString();
  await db.insert(sharesightRawReceipts).values({
    id,
    runId: lease.runId,
    ownerId: lease.ownerId,
    providerPortfolioId: lease.portfolioId,
    capability: input.capability,
    requestKey: input.requestKey,
    requestFrom: input.requestFrom,
    requestTo: input.requestTo,
    receivedAt: input.receivedAt,
    payloadSha256,
    payloadCiphertext: encrypted.ciphertext,
    payloadIv: encrypted.iv,
    payloadAuthTag: encrypted.authTag,
    payloadExpiresAt,
    status: 'received',
    normalizationVersion: input.normalizationVersion,
    sourceIds: [],
    revisionIds: [],
    failureCategory: null,
    processedAt: null,
  });
  return Object.freeze({ id, runId: lease.runId, payloadSha256, ...input });
}

export async function loadPendingSharesightReceipts(
  db: Database,
  lease: SharesightSyncLease,
  key: SharesightReceiptKey,
): Promise<readonly PersistedSharesightReceipt[]> {
  const rows = await db.query.sharesightRawReceipts.findMany({
    where: and(
      eq(sharesightRawReceipts.ownerId, lease.ownerId),
      eq(sharesightRawReceipts.providerPortfolioId, lease.portfolioId),
      eq(sharesightRawReceipts.status, 'received'),
    ),
    orderBy: (table, { asc }) => [asc(table.receivedAt), asc(table.id)],
  });
  return Object.freeze(
    rows.map((row) => {
      if (row.payloadCiphertext === null || row.payloadIv === null || row.payloadAuthTag === null) {
        throw new DataInvariantError(
          'sharesight.receipt_payload_expired',
          'Pending Sharesight receipt payload is unavailable.',
        );
      }
      return Object.freeze({
        id: row.id,
        runId: row.runId,
        capability: row.capability,
        requestKey: row.requestKey,
        requestFrom: row.requestFrom,
        requestTo: row.requestTo,
        receivedAt: row.receivedAt,
        payloadSha256: row.payloadSha256,
        payload: decryptPayload(row.payloadCiphertext, row.payloadIv, row.payloadAuthTag, key),
      });
    }),
  );
}

export async function finalizeSharesightReceipt(
  db: Database,
  lease: SharesightSyncLease,
  input: Readonly<{
    receiptId: string;
    status: 'normalized' | 'quarantined';
    revisions: readonly SharesightRevisionInput[];
    continuation: Readonly<Record<string, string>> | null;
    now: string;
    failureCategory?: string | null;
  }>,
): Promise<readonly SharesightRevisionDisposition[]> {
  return db.transaction(async (tx) => {
    const receipt = await tx.query.sharesightRawReceipts.findFirst({
      where: and(
        eq(sharesightRawReceipts.id, input.receiptId),
        eq(sharesightRawReceipts.runId, lease.runId),
        eq(sharesightRawReceipts.status, 'received'),
      ),
    });
    if (receipt === undefined) {
      throw new DataConflictError(
        'sharesight.receipt_already_processed',
        'Sharesight receipt is no longer pending.',
      );
    }
    const dispositions: SharesightRevisionDisposition[] = [];
    for (const revision of input.revisions) {
      const current = await tx.query.sharesightSourceRevisions.findFirst({
        where: and(
          eq(sharesightSourceRevisions.ownerId, lease.ownerId),
          eq(sharesightSourceRevisions.sourceId, revision.sourceId),
          eq(sharesightSourceRevisions.isCurrent, true),
        ),
      });
      if (current?.revisionSha256 === revision.revisionSha256) {
        await tx
          .update(sharesightSourceRevisions)
          .set({ lastSeenAt: input.now, receiptId: input.receiptId })
          .where(
            and(
              eq(sharesightSourceRevisions.ownerId, lease.ownerId),
              eq(sharesightSourceRevisions.sourceId, revision.sourceId),
              eq(sharesightSourceRevisions.revisionSha256, revision.revisionSha256),
            ),
          );
        dispositions.push({ ...revision, disposition: 'replay' });
        continue;
      }
      if (current !== undefined) {
        await tx
          .update(sharesightSourceRevisions)
          .set({ isCurrent: false })
          .where(
            and(
              eq(sharesightSourceRevisions.ownerId, lease.ownerId),
              eq(sharesightSourceRevisions.sourceId, revision.sourceId),
              eq(sharesightSourceRevisions.isCurrent, true),
            ),
          );
      }
      await tx.insert(sharesightSourceRevisions).values({
        ownerId: lease.ownerId,
        sourceId: revision.sourceId,
        revisionSha256: revision.revisionSha256,
        recordKind: revision.recordKind,
        receiptId: input.receiptId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        isCurrent: true,
      });
      dispositions.push({
        ...revision,
        disposition: current === undefined ? 'new' : 'revision',
      });
    }
    await tx
      .update(sharesightRawReceipts)
      .set({
        status: input.status,
        sourceIds: input.revisions.map((item) => item.sourceId),
        revisionIds: input.revisions.map((item) => item.revisionSha256),
        failureCategory: input.failureCategory ?? null,
        processedAt: input.now,
      })
      .where(eq(sharesightRawReceipts.id, input.receiptId));
    await tx
      .update(sharesightSyncRuns)
      .set({ continuation: input.continuation })
      .where(and(eq(sharesightSyncRuns.id, lease.runId), eq(sharesightSyncRuns.status, 'running')));
    return Object.freeze(dispositions.map((item) => Object.freeze(item)));
  });
}

export async function failSharesightReceipt(
  db: Database,
  receiptId: string,
  category: string,
  now: string,
): Promise<void> {
  await db
    .update(sharesightRawReceipts)
    .set({ status: 'failed', failureCategory: category, processedAt: now })
    .where(
      and(eq(sharesightRawReceipts.id, receiptId), eq(sharesightRawReceipts.status, 'received')),
    );
}

export async function completeSharesightSync(
  db: Database,
  lease: SharesightSyncLease,
  counts: Readonly<Record<string, number>>,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sharesightSyncRuns)
      .set({ status: 'completed', continuation: null, counts, completedAt: now })
      .where(and(eq(sharesightSyncRuns.id, lease.runId), eq(sharesightSyncRuns.status, 'running')));
    const released = await tx
      .update(sharesightSyncStates)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        activeRunId: null,
        lastSuccessfulSyncAt: now,
        lastFailureCategory: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sharesightSyncStates.ownerId, lease.ownerId),
          eq(sharesightSyncStates.providerPortfolioId, lease.portfolioId),
          eq(sharesightSyncStates.leaseId, lease.leaseId),
        ),
      )
      .returning({ ownerId: sharesightSyncStates.ownerId });
    if (released.length !== 1) {
      throw new DataConflictError(
        'sharesight.lease_lost',
        'Sharesight synchronization lease was lost.',
      );
    }
  });
}

export async function failSharesightSync(
  db: Database,
  lease: SharesightSyncLease,
  category: string,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(sharesightSyncRuns)
      .set({ status: 'failed', completedAt: now, failureCategory: category })
      .where(and(eq(sharesightSyncRuns.id, lease.runId), eq(sharesightSyncRuns.status, 'running')));
    await tx
      .update(sharesightSyncStates)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        activeRunId: null,
        lastFailureCategory: category,
        updatedAt: now,
      })
      .where(
        and(
          eq(sharesightSyncStates.ownerId, lease.ownerId),
          eq(sharesightSyncStates.providerPortfolioId, lease.portfolioId),
          eq(sharesightSyncStates.leaseId, lease.leaseId),
        ),
      );
  });
}

export async function expireSharesightRawPayloads(db: Database, now: string): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .update(sharesightRawReceipts)
      .set({
        status: 'failed',
        failureCategory: 'sharesight_receipt_expired',
        processedAt: now,
      })
      .where(
        and(
          lte(sharesightRawReceipts.payloadExpiresAt, now),
          eq(sharesightRawReceipts.status, 'received'),
        ),
      );
    const rows = await tx
      .update(sharesightRawReceipts)
      .set({ payloadCiphertext: null, payloadIv: null, payloadAuthTag: null })
      .where(
        and(
          lte(sharesightRawReceipts.payloadExpiresAt, now),
          isNotNull(sharesightRawReceipts.payloadCiphertext),
        ),
      )
      .returning({ id: sharesightRawReceipts.id });
    return rows.length;
  });
}
