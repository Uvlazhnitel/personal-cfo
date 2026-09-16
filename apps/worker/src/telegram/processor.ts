import type { PgBoss } from 'pg-boss';
import {
  STANDARD_SPENDING_CATEGORIES,
  EUR,
  createAccountEntry,
  createCanonicalTransaction,
  createCashReconciliation,
  createEconomicFlow,
  createMoney,
  createSinkingFund,
  createSpendingObservation,
  parseEconomicFlowId,
  parseCashReconciliationId,
  parseEntryId,
  parseInstant,
  parseLocalDate,
  parseSinkingFundId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  AccountId,
  EconomicFlow,
  SpendingObservation,
  StandardSpendingCategoryCode,
} from '@personal-cfo/domain';
import {
  DataInvariantError,
  advanceTelegramClarification,
  appendCashActivity,
  appendCashReconciliation,
  appendSinkingFund,
  cancelTelegramClarification,
  createTelegramClarification,
  createTelegramMessageLink,
  executeFinancialCommand,
  failTelegramUpdate,
  finalizeTelegramUpdate,
  findTelegramCorrectionTarget,
  generateUuidV7,
  incrementOrCancelClarification,
  loadActiveTelegramClarification,
  loadCashActivityByTransaction,
  loadEvaluationParts,
  loadSingleCashAccountState,
  queueTelegramDelivery,
  resolveTelegramClarification,
  supersedeTelegramMessageLink,
} from '@personal-cfo/data';
import type { ClaimedTelegramUpdate, Database, PersistedTelegramDraft } from '@personal-cfo/data';
import { mergeClarification, parseTelegramText } from '@personal-cfo/integrations';
import type {
  CashExpenseProposal,
  CashIncomeProposal,
  CorrectionProposal,
  TelegramFinancialProposal,
  TelegramMessage,
  TelegramParseResult,
} from '@personal-cfo/integrations';

import type { WorkerEventLogger } from '../job-handlers.js';

function rigaDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function asMessage(update: ClaimedTelegramUpdate): TelegramMessage {
  return Object.freeze({
    updateId: update.updateId,
    chatId: update.chatId,
    senderId: update.senderId,
    messageId: update.messageId,
    sentAt: update.messageDate,
    text: update.messageText,
    textHash: update.textHash,
    locale: update.locale,
    localeDetected: true,
    chatType: 'private',
    senderIsBot: false,
    forwarded: false,
    replyToMessageId: update.replyToMessageId,
  });
}

function euro(amountMinor: bigint): string {
  const absolute = amountMinor < 0n ? -amountMinor : amountMinor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${amountMinor < 0n ? '−' : ''}€${whole.toLocaleString('en-US')}.${fraction}`;
}

function help(locale: 'en' | 'ru'): string {
  return locale === 'ru'
    ? 'Быстрый ввод:\n12 евро наличкой обед\nполучил 120 евро наличными за подработку\nналичных сейчас 125 евро\nпоездка Япония 1500 евро до 2027-05-01\n/cancel — отменить уточнение'
    : 'Quick input:\n€12 lunch paid in cash\nreceived €120 cash from side hustle\ncash count €125\ntrip Japan €1500 by 2027-05-01\n/cancel — cancel clarification';
}

function unsupportedResponse(result: Extract<TelegramParseResult, { confidence: 'unsupported' }>) {
  return result.reason === 'bot_command' ? null : result.response;
}

function safeInvariantResponse(error: DataInvariantError, locale: 'en' | 'ru'): string | null {
  switch (error.code) {
    case 'cash_account.not_unique':
      return locale === 'ru'
        ? 'Наличный счёт не настроен однозначно. Используйте внутренний интерфейс.'
        : 'The Cash Account is not configured unambiguously. Use the internal flow.';
    case 'telegram.correction_target_invalid':
      return locale === 'ru'
        ? 'Эту запись нельзя исправить из данного сообщения. Используйте внутренний интерфейс.'
        : 'That confirmation can no longer be corrected. Use the internal flow.';
    case 'telegram.invalid_correction':
      return locale === 'ru'
        ? 'Ответьте одним новым значением: сумма, дата, категория, источник или «отмени».'
        : 'Reply with one new amount, date, category, source, or “cancel”.';
    case 'telegram.missing_materiality':
      return locale === 'ru'
        ? 'Сверка наличных сейчас недоступна. Проверьте настройки во внутреннем интерфейсе.'
        : 'Cash reconciliation is unavailable. Check settings in the internal flow.';
    default:
      return null;
  }
}

function categoryObservation(
  flowId: string,
  economicDate: string,
  category: StandardSpendingCategoryCode,
): SpendingObservation {
  const standard = STANDARD_SPENDING_CATEGORIES[category];
  return createSpendingObservation({
    economicFlowId: parseEconomicFlowId(flowId),
    economicDate: parseLocalDate(economicDate),
    categoryId: standard.id,
    necessity: standard.necessity,
    cadence: 'variable',
    irregular: false,
  });
}

function cashBundle(
  accountId: AccountId,
  proposal: CashExpenseProposal | CashIncomeProposal,
): Readonly<{
  transaction: ReturnType<typeof createCanonicalTransaction>;
  flow: EconomicFlow;
  observation: SpendingObservation | null;
}> {
  const transactionId = generateUuidV7('transaction');
  const flowId = generateUuidV7('economic-flow');
  const expense = proposal.kind === 'cash_expense';
  const transaction = createCanonicalTransaction({
    id: parseTransactionId(transactionId),
    effectiveAt: parseInstant(proposal.effectiveAt),
    bookingStatus: 'booked',
    kind: 'external_flow',
    entries: [
      createAccountEntry({
        id: parseEntryId(generateUuidV7('entry')),
        transactionId: parseTransactionId(transactionId),
        accountId,
        amount: createMoney(expense ? -proposal.amountMinor : proposal.amountMinor, EUR),
        role: 'external_flow',
      }),
    ],
  });
  const flow = createEconomicFlow(
    expense
      ? {
          id: parseEconomicFlowId(flowId),
          transactionId: transaction.id,
          effectiveAt: transaction.effectiveAt,
          amount: createMoney(proposal.amountMinor, EUR),
          kind: 'consumption',
          reimbursable: false,
        }
      : {
          id: parseEconomicFlowId(flowId),
          transactionId: transaction.id,
          effectiveAt: transaction.effectiveAt,
          amount: createMoney(proposal.amountMinor, EUR),
          kind: 'earned_income',
          source: proposal.source,
        },
  );
  return Object.freeze({
    transaction,
    flow,
    observation: expense
      ? categoryObservation(flow.id, proposal.economicDate, proposal.category)
      : null,
  });
}

async function loadMaterialityThreshold(
  db: Database,
  ownerId: string,
  effectiveDate: string,
): Promise<bigint> {
  const parts = await loadEvaluationParts(db, ownerId);
  const candidates = parts.settingsHistory
    .filter(
      (value): value is Record<string, unknown> => typeof value === 'object' && value !== null,
    )
    .filter(
      (value) =>
        typeof value['effectiveFrom'] === 'string' && value['effectiveFrom'] <= effectiveDate,
    )
    .sort((left, right) =>
      String(left['effectiveFrom']).localeCompare(String(right['effectiveFrom'])),
    );
  const settings = candidates.at(-1);
  const spending = settings?.['spendingBaseline'];
  const threshold =
    typeof spending === 'object' && spending !== null
      ? (spending as Record<string, unknown>)['materialityThreshold']
      : null;
  const amount =
    typeof threshold === 'object' && threshold !== null
      ? (threshold as Record<string, unknown>)['amountMinor']
      : null;
  if (typeof amount !== 'bigint') {
    throw new DataInvariantError(
      'telegram.missing_materiality',
      'Effective financial settings do not expose a materiality threshold.',
    );
  }
  return amount;
}

function clarificationDraft(value: unknown): PersistedTelegramDraft {
  return value as PersistedTelegramDraft;
}

async function ordinaryReply(
  db: Database,
  update: ClaimedTelegramUpdate,
  input: Readonly<{
    status: 'completed' | 'unsupported';
    outcome: string;
    kind: string | null;
    text: string | null;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await finalizeTelegramUpdate(tx, {
      update,
      status: input.status,
      parserOutcome: input.outcome,
      proposalKind: input.kind,
      now: input.now,
    });
    if (input.text !== null) {
      await queueTelegramDelivery(tx, {
        update,
        purpose: input.outcome,
        text: input.text,
        now: input.now,
      });
    }
  });
}

async function executeProposal(
  db: Database,
  boss: PgBoss,
  update: ClaimedTelegramUpdate,
  proposal: TelegramFinancialProposal,
  now: string,
  clarification: Readonly<{ id: string; status: 'resolved' | 'superseded' }> | null,
): Promise<void> {
  const effectiveDate = rigaDate(now);
  if (proposal.kind === 'correction') {
    await executeCorrection(db, boss, update, proposal, now, effectiveDate, clarification);
    return;
  }
  const kind =
    proposal.kind === 'future_expense'
      ? 'sinking_fund_creation'
      : proposal.kind === 'cash_count'
        ? 'cash_reconciliation'
        : 'cash_activity';
  const threshold =
    proposal.kind === 'cash_count'
      ? await loadMaterialityThreshold(db, update.ownerId, effectiveDate)
      : null;
  await executeFinancialCommand(
    db,
    boss,
    {
      ownerId: update.ownerId,
      kind,
      idempotencyKey: `telegram:${update.sourceKey}:${update.updateId}:${proposal.kind}`,
      request: proposal,
      asOf: now,
      effectiveDate,
      now,
    },
    async (tx, commandId) => {
      if (clarification !== null) {
        await resolveTelegramClarification(
          tx,
          clarification.id,
          update.updateId,
          now,
          clarification.status,
        );
      }
      let mutation;
      let confirmation: string;
      if (proposal.kind === 'cash_expense' || proposal.kind === 'cash_income') {
        const cash = await loadSingleCashAccountState(tx, update.ownerId, proposal.effectiveAt);
        const bundle = cashBundle(cash.account.id, proposal);
        mutation = await appendCashActivity(
          tx,
          update.ownerId,
          bundle.transaction,
          bundle.flow,
          bundle.observation,
          now,
        );
        confirmation =
          proposal.kind === 'cash_expense'
            ? proposal.locale === 'ru'
              ? `Записано: расход наличными ${euro(proposal.amountMinor)} — ${proposal.category} — ${proposal.economicDate}.`
              : `Recorded: cash expense ${euro(proposal.amountMinor)} — ${proposal.category} — ${proposal.economicDate}.`
            : proposal.locale === 'ru'
              ? `Записано: доход наличными ${euro(proposal.amountMinor)} — ${proposal.source} — ${proposal.economicDate}.`
              : `Recorded: cash income ${euro(proposal.amountMinor)} — ${proposal.source} — ${proposal.economicDate}.`;
      } else if (proposal.kind === 'future_expense') {
        mutation = await appendSinkingFund(
          tx,
          update.ownerId,
          createSinkingFund({
            id: parseSinkingFundId(generateUuidV7('sinking-fund')),
            label: proposal.label,
            target: createMoney(proposal.targetMinor, EUR),
            dueDate: parseLocalDate(proposal.dueDate),
            priority: 0,
            committed: true,
            status: 'active',
            allocationPolicy: 'manual',
            createdAt: parseInstant(update.messageDate),
          }),
        );
        confirmation =
          proposal.locale === 'ru'
            ? `Будущая трата создана: ${proposal.label} ${euro(proposal.targetMinor)} до ${proposal.dueDate}.`
            : `Future expense created: ${proposal.label} ${euro(proposal.targetMinor)} by ${proposal.dueDate}.`;
      } else {
        const cash = await loadSingleCashAccountState(tx, update.ownerId, proposal.effectiveAt);
        const variance = proposal.countedMinor - cash.balanceMinor;
        if (variance === 0n) {
          const unchanged = Object.freeze({
            mutated: false,
            entityType: 'cash_reconciliation',
            entityId: cash.account.id,
            earliestAffectedAt: null,
            result: Object.freeze({ accountId: cash.account.id, matched: true }),
          });
          await finalizeTelegramUpdate(tx, {
            update,
            status: 'completed',
            parserOutcome: 'high',
            proposalKind: proposal.kind,
            commandId,
            entityType: unchanged.entityType,
            entityId: unchanged.entityId,
            now,
          });
          await queueTelegramDelivery(tx, {
            update,
            purpose: 'confirmation',
            text:
              proposal.locale === 'ru'
                ? `Наличные уже совпадают: ${euro(proposal.countedMinor)}.`
                : `Cash already matches: ${euro(proposal.countedMinor)}.`,
            now,
          });
          return unchanged;
        }
        const transactionId = generateUuidV7('transaction');
        const transaction = createCanonicalTransaction({
          id: parseTransactionId(transactionId),
          effectiveAt: parseInstant(proposal.effectiveAt),
          bookingStatus: 'booked',
          kind: 'valuation_adjustment',
          entries: [
            createAccountEntry({
              id: parseEntryId(generateUuidV7('entry')),
              transactionId: parseTransactionId(transactionId),
              accountId: cash.account.id,
              amount: createMoney(variance, EUR),
              role: 'valuation_adjustment',
            }),
          ],
        });
        const flow = createEconomicFlow({
          id: parseEconomicFlowId(generateUuidV7('economic-flow')),
          transactionId: transaction.id,
          effectiveAt: transaction.effectiveAt,
          amount: createMoney(variance, EUR),
          kind: 'cash_reconciliation_adjustment',
        });
        const reconciliation = createCashReconciliation({
          id: parseCashReconciliationId(generateUuidV7('cash-reconciliation')),
          accountId: cash.account.id,
          calculatedBalance: createMoney(cash.balanceMinor, EUR),
          countedBalance: createMoney(proposal.countedMinor, EUR),
          variance: createMoney(variance, EUR),
          reconciledAt: parseInstant(proposal.effectiveAt),
          actor: 'telegram_user',
          reason: 'Physical cash count',
          materiality:
            threshold !== null && (variance < 0n ? -variance : variance) >= threshold
              ? 'material'
              : 'non_material',
          adjustmentTransactionId: transaction.id,
        });
        mutation = await appendCashReconciliation(
          tx,
          update.ownerId,
          transaction,
          flow,
          reconciliation,
        );
        confirmation =
          proposal.locale === 'ru'
            ? `Наличные сверены до ${euro(proposal.countedMinor)}. Разница: ${euro(variance)}.`
            : `Cash reconciled to ${euro(proposal.countedMinor)}. Difference: ${euro(variance)}.`;
      }
      await finalizeTelegramUpdate(tx, {
        update,
        status: 'completed',
        parserOutcome: 'high',
        proposalKind: proposal.kind,
        commandId,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        now,
      });
      await queueTelegramDelivery(tx, {
        update,
        purpose: 'confirmation',
        text: confirmation,
        now,
      });
      await createTelegramMessageLink(tx, {
        update,
        commandId,
        proposalKind: proposal.kind,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        now,
      });
      return mutation;
    },
  );
}

function correctedExpenseProposal(
  original: Readonly<{
    amountMinor: bigint;
    effectiveAt: string;
    economicDate: string;
    category: StandardSpendingCategoryCode;
  }>,
  proposal: CorrectionProposal,
): CashExpenseProposal {
  const patch = proposal.patch;
  return Object.freeze({
    kind: 'cash_expense',
    amountMinor: patch.field === 'amount' ? patch.amountMinor : original.amountMinor,
    effectiveAt: patch.field === 'date' ? patch.effectiveAt : original.effectiveAt,
    economicDate: patch.field === 'date' ? patch.economicDate : original.economicDate,
    category: patch.field === 'category' ? patch.category : original.category,
    locale: proposal.locale,
  });
}

async function executeCorrection(
  db: Database,
  boss: PgBoss,
  update: ClaimedTelegramUpdate,
  proposal: CorrectionProposal,
  now: string,
  effectiveDate: string,
  clarification: Readonly<{ id: string; status: 'resolved' | 'superseded' }> | null,
): Promise<void> {
  await executeFinancialCommand(
    db,
    boss,
    {
      ownerId: update.ownerId,
      kind: 'cash_correction',
      idempotencyKey: `telegram:${update.sourceKey}:${update.updateId}:correction`,
      request: proposal,
      asOf: now,
      effectiveDate,
      now,
    },
    async (tx, commandId) => {
      if (clarification !== null) {
        await resolveTelegramClarification(
          tx,
          clarification.id,
          update.updateId,
          now,
          clarification.status,
        );
      }
      const target = await findTelegramCorrectionTarget(tx, {
        ownerId: update.ownerId,
        sourceKey: update.sourceKey,
        chatId: update.chatId,
        botMessageId: proposal.replyToMessageId,
        now,
      });
      if (
        target === null ||
        (target.proposalKind !== 'cash_expense' && target.proposalKind !== 'cash_income')
      ) {
        throw new DataInvariantError(
          'telegram.correction_target_invalid',
          'Correction target is unavailable.',
        );
      }
      const original = await loadCashActivityByTransaction(tx, update.ownerId, target.entityId);
      const entry = original.transaction.entries[0]!;
      const reversalTransactionId = generateUuidV7('transaction');
      const reversalFlowId = generateUuidV7('economic-flow');
      const expense = original.flow.kind === 'consumption';
      if (!expense && original.flow.kind !== 'earned_income') {
        throw new DataInvariantError(
          'telegram.correction_target_invalid',
          'Only cash expense or income can be corrected.',
        );
      }
      const reversalTransaction = createCanonicalTransaction({
        id: parseTransactionId(reversalTransactionId),
        effectiveAt: original.transaction.effectiveAt,
        bookingStatus: 'booked',
        kind: 'external_flow',
        entries: [
          createAccountEntry({
            id: parseEntryId(generateUuidV7('entry')),
            transactionId: parseTransactionId(reversalTransactionId),
            accountId: entry.accountId,
            amount: createMoney(-entry.amount.amountMinor, EUR),
            role: 'external_flow',
          }),
        ],
      });
      const reversalFlow = createEconomicFlow(
        expense
          ? {
              id: parseEconomicFlowId(reversalFlowId),
              transactionId: reversalTransaction.id,
              effectiveAt: reversalTransaction.effectiveAt,
              amount: original.flow.amount,
              kind: 'refund',
              relatedTransactionId: original.transaction.id,
            }
          : {
              id: parseEconomicFlowId(reversalFlowId),
              transactionId: reversalTransaction.id,
              effectiveAt: reversalTransaction.effectiveAt,
              amount: createMoney(-original.flow.amount.amountMinor, EUR),
              kind: 'earned_income',
              source: original.flow.source,
            },
      );
      const reversalObservation =
        expense && original.observation !== null
          ? createSpendingObservation({ ...original.observation, economicFlowId: reversalFlow.id })
          : null;
      await appendCashActivity(
        tx,
        update.ownerId,
        reversalTransaction,
        reversalFlow,
        reversalObservation,
        now,
      );
      let entityId = reversalTransaction.id;
      let confirmation = proposal.locale === 'ru' ? 'Запись отменена.' : 'Entry cancelled.';
      if (proposal.patch.field !== 'cancel') {
        let replacement;
        if (expense) {
          if (proposal.patch.field === 'income_source') {
            throw new DataInvariantError(
              'telegram.invalid_correction',
              'Income source cannot correct an expense.',
            );
          }
          const observation = original.observation;
          if (observation === null)
            throw new DataInvariantError(
              'telegram.invalid_correction',
              'Expense classification is missing.',
            );
          const currentCategory =
            Object.values(STANDARD_SPENDING_CATEGORIES).find(
              (value) => value.id === observation.categoryId,
            )?.code ?? 'other';
          replacement = correctedExpenseProposal(
            {
              amountMinor: original.flow.amount.amountMinor,
              effectiveAt: original.flow.effectiveAt,
              economicDate: observation.economicDate,
              category: currentCategory,
            },
            proposal,
          );
        } else {
          if (proposal.patch.field === 'category') {
            throw new DataInvariantError(
              'telegram.invalid_correction',
              'Expense category cannot correct income.',
            );
          }
          replacement = Object.freeze({
            kind: 'cash_income' as const,
            amountMinor:
              proposal.patch.field === 'amount'
                ? proposal.patch.amountMinor
                : original.flow.amount.amountMinor,
            economicDate:
              proposal.patch.field === 'date'
                ? proposal.patch.economicDate
                : original.flow.effectiveAt.slice(0, 10),
            effectiveAt:
              proposal.patch.field === 'date'
                ? proposal.patch.effectiveAt
                : original.flow.effectiveAt,
            source:
              proposal.patch.field === 'income_source'
                ? proposal.patch.source
                : original.flow.source === 'side_hustle'
                  ? 'side_hustle'
                  : 'other',
            locale: proposal.locale,
          });
        }
        const bundle = cashBundle(entry.accountId, replacement);
        await appendCashActivity(
          tx,
          update.ownerId,
          bundle.transaction,
          bundle.flow,
          bundle.observation,
          now,
        );
        entityId = bundle.transaction.id;
        confirmation =
          proposal.locale === 'ru'
            ? `Исправлено: ${euro(replacement.amountMinor)} — ${replacement.economicDate}.`
            : `Corrected: ${euro(replacement.amountMinor)} — ${replacement.economicDate}.`;
      }
      await finalizeTelegramUpdate(tx, {
        update,
        status: 'completed',
        parserOutcome: 'high',
        proposalKind: proposal.patch.field === 'cancel' ? 'cash_cancellation' : target.proposalKind,
        commandId,
        entityType: 'cash_activity',
        entityId,
        now,
      });
      await queueTelegramDelivery(tx, { update, purpose: 'confirmation', text: confirmation, now });
      const successorId = await createTelegramMessageLink(tx, {
        update,
        commandId,
        proposalKind: proposal.patch.field === 'cancel' ? 'cash_cancellation' : target.proposalKind,
        entityType: 'cash_activity',
        entityId,
        now,
      });
      await supersedeTelegramMessageLink(
        tx,
        target.id,
        successorId,
        proposal.patch.field === 'cancel',
      );
      return Object.freeze({
        entityType: 'cash_correction',
        entityId,
        earliestAffectedAt: original.transaction.effectiveAt,
        result: Object.freeze({
          originalTransactionId: original.transaction.id,
          replacementTransactionId: proposal.patch.field === 'cancel' ? null : entityId,
        }),
      });
    },
  );
}

export async function processTelegramUpdate(
  db: Database,
  boss: PgBoss,
  update: ClaimedTelegramUpdate,
  clock: Readonly<{ now: () => string }> = { now: () => new Date().toISOString() },
  log: WorkerEventLogger = () => undefined,
): Promise<void> {
  const now = clock.now();
  try {
    const text = update.messageText.trim();
    if (text === '/start' || text === '/help') {
      await ordinaryReply(db, update, {
        status: 'completed',
        outcome: text.slice(1),
        kind: null,
        text: help(update.locale),
        now,
      });
      return;
    }
    if (text === '/cancel') {
      await db.transaction(async (tx) => {
        const cancelled = await cancelTelegramClarification(tx, update, now);
        await finalizeTelegramUpdate(tx, {
          update,
          status: 'completed',
          parserOutcome: 'cancel',
          proposalKind: null,
          now,
        });
        await queueTelegramDelivery(tx, {
          update,
          purpose: 'cancel',
          text:
            update.locale === 'ru'
              ? cancelled
                ? 'Уточнение отменено.'
                : 'Нет активного уточнения.'
              : cancelled
                ? 'Clarification cancelled.'
                : 'No active clarification.',
          now,
        });
      });
      return;
    }
    const active = await loadActiveTelegramClarification(
      db,
      update.ownerId,
      update.sourceKey,
      update.chatId,
      now,
    );
    const fresh = parseTelegramText(asMessage(update));
    let parsed = fresh;
    let clarification: Readonly<{ id: string; status: 'resolved' | 'superseded' }> | null = null;
    if (active !== null) {
      if (fresh.confidence === 'high') {
        clarification = Object.freeze({ id: active.id, status: 'superseded' });
      } else {
        parsed = mergeClarification(active.draft, asMessage(update));
        if (parsed.confidence === 'high') {
          clarification = Object.freeze({ id: active.id, status: 'resolved' });
        } else {
          if (
            parsed.confidence === 'needs_clarification' &&
            JSON.stringify(parsed.draft) !== JSON.stringify(active.draft)
          ) {
            const advanced = parsed;
            await db.transaction((tx) =>
              advanceTelegramClarification(
                tx,
                active,
                update,
                clarificationDraft(advanced.draft),
                advanced.missingField,
                advanced.question,
                now,
              ),
            );
          } else {
            await db.transaction((tx) =>
              incrementOrCancelClarification(
                tx,
                active,
                update,
                parsed.confidence === 'needs_clarification'
                  ? parsed.question
                  : fresh.confidence === 'unsupported'
                    ? fresh.response
                    : help(update.locale),
                now,
              ),
            );
          }
          return;
        }
      }
    }
    if (parsed.confidence === 'needs_clarification') {
      await db.transaction((tx) =>
        createTelegramClarification(tx, {
          update,
          proposalKind: parsed.draft.kind,
          missingField: parsed.missingField,
          draft: clarificationDraft(parsed.draft),
          question: parsed.question,
          now,
        }),
      );
      return;
    }
    if (parsed.confidence === 'unsupported') {
      await ordinaryReply(db, update, {
        status: 'unsupported',
        outcome: parsed.reason,
        kind: null,
        text: unsupportedResponse(parsed),
        now,
      });
      return;
    }
    await executeProposal(db, boss, update, parsed.proposal, now, clarification);
    log('telegram.update.completed', {
      updateId: update.updateId.toString(),
      proposalKind: parsed.proposal.kind,
    });
  } catch (error) {
    if (error instanceof DataInvariantError) {
      const response = safeInvariantResponse(error, update.locale);
      if (response !== null) {
        await ordinaryReply(db, update, {
          status: 'unsupported',
          outcome: error.code,
          kind: null,
          text: response,
          now,
        });
        log('telegram.update.unsupported', {
          updateId: update.updateId.toString(),
          category: error.code,
        });
        return;
      }
    }
    const category =
      error instanceof DataInvariantError ? error.code : 'telegram_processing_failed';
    await failTelegramUpdate(db, update, category, now);
    log('telegram.update.failed', { updateId: update.updateId.toString(), category });
  }
}
