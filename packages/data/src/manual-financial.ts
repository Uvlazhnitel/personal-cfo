import { and, eq, sql } from 'drizzle-orm';
import {
  createAccount,
  createCanonicalTransaction,
  createEconomicFlow,
  createSinkingFund,
  createSpendingObservation,
} from '@personal-cfo/domain';
import type {
  Account,
  CanonicalTransaction,
  EconomicFlow,
  SinkingFund,
  SpendingObservation,
} from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataInvariantError } from './errors.js';
import {
  canonicalDatabaseInstant,
  classificationFromEconomicFlow,
  encodeEconomicFlowClassification,
} from './financial-facts.js';
import { decodeSourceJson, encodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  accountEntries,
  accounts,
  economicFlows,
  financialTransactions,
  flowClassifications,
  sinkingFunds,
  spendingObservations,
  transactionVersions,
} from './schema.js';

export type CashAccountState = Readonly<{
  account: Account;
  balanceMinor: bigint;
}>;

export async function loadSingleCashAccountState(
  tx: DatabaseTransaction,
  ownerId: string,
  at: string,
): Promise<CashAccountState> {
  const rows = await tx
    .select()
    .from(accounts)
    .where(
      and(
        eq(accounts.ownerId, ownerId),
        eq(accounts.kind, 'cash'),
        eq(accounts.valueSource, 'ledger'),
        eq(accounts.currency, 'EUR'),
      ),
    );
  const candidates = rows
    .map((row) => createAccount(decodeSourceJson(row.payload) as Account))
    .filter((account) => account.brokerageCashFor === null);
  if (candidates.length !== 1) {
    throw new DataInvariantError(
      'cash_account.not_unique',
      'The owner must have exactly one non-brokerage EUR Cash Account.',
    );
  }
  const account = candidates[0]!;
  const result = await tx.execute(sql<{ balance: bigint }>`
    select coalesce(sum(e.amount_minor), 0)::bigint as balance
    from account_entries e
    join transaction_versions v
      on v.owner_id = e.owner_id
     and v.transaction_id = e.transaction_id
     and v.revision = e.transaction_revision
    where e.owner_id = ${ownerId}
      and e.account_id = ${account.id}
      and v.is_current = true
      and v.booking_status = 'booked'
      and v.effective_at <= ${at}::timestamptz
  `);
  const rawBalance = result.rows[0]?.['balance'];
  if (typeof rawBalance !== 'bigint' && typeof rawBalance !== 'string') {
    throw new DataInvariantError(
      'cash_account.invalid_balance',
      'Cash Account balance query returned an invalid value.',
    );
  }
  return Object.freeze({
    account,
    balanceMinor: BigInt(rawBalance),
  });
}

function expectedEntryAmount(flow: EconomicFlow): bigint {
  switch (flow.kind) {
    case 'consumption':
      return -flow.amount.amountMinor;
    case 'earned_income':
    case 'cash_reconciliation_adjustment':
    case 'other_external_flow':
      return flow.amount.amountMinor;
    case 'refund':
    case 'reimbursement':
      return flow.amount.amountMinor;
  }
}

export async function appendCashActivity(
  tx: DatabaseTransaction,
  ownerId: string,
  transactionInput: CanonicalTransaction,
  flowInput: EconomicFlow,
  observationInput: SpendingObservation | null,
  createdAt: string,
): Promise<CommandMutationResult> {
  const transaction = createCanonicalTransaction(transactionInput);
  const flow = createEconomicFlow(flowInput);
  const observation =
    observationInput === null ? null : createSpendingObservation(observationInput);
  const entry = transaction.entries[0];
  if (
    transaction.kind !== 'external_flow' ||
    transaction.bookingStatus !== 'booked' ||
    transaction.entries.length !== 1 ||
    entry === undefined ||
    entry.role !== 'external_flow' ||
    flow.transactionId !== transaction.id ||
    flow.effectiveAt !== transaction.effectiveAt ||
    entry.amount.currency !== 'EUR' ||
    flow.amount.currency !== 'EUR' ||
    entry.amount.amountMinor !== expectedEntryAmount(flow) ||
    (flow.kind === 'consumption' && observation?.economicFlowId !== flow.id) ||
    ((flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      observation?.economicFlowId !== flow.id) ||
    (flow.kind !== 'consumption' &&
      flow.kind !== 'refund' &&
      flow.kind !== 'reimbursement' &&
      observation !== null)
  ) {
    throw new DataInvariantError(
      'cash_activity.invalid_bundle',
      'Cash transaction, economic flow, and spending observation are inconsistent.',
    );
  }
  const account = await tx.query.accounts.findFirst({
    where: and(
      eq(accounts.ownerId, ownerId),
      eq(accounts.id, entry.accountId),
      eq(accounts.kind, 'cash'),
      eq(accounts.valueSource, 'ledger'),
      eq(accounts.currency, 'EUR'),
    ),
  });
  if (account === undefined)
    throw new DataInvariantError(
      'cash_activity.invalid_account',
      'Cash activity requires the owner Cash Account.',
    );
  await tx.insert(financialTransactions).values({ id: transaction.id, ownerId, createdAt });
  await tx.insert(transactionVersions).values({
    ownerId,
    transactionId: transaction.id,
    revision: 1,
    kind: transaction.kind,
    bookingStatus: transaction.bookingStatus,
    effectiveAt: transaction.effectiveAt,
    payload: encodeSourceJson(transaction),
    isCurrent: true,
    supersededAt: null,
  });
  await tx.insert(accountEntries).values({
    ownerId,
    transactionId: transaction.id,
    transactionRevision: 1,
    entryId: entry.id,
    accountId: entry.accountId,
    amountMinor: entry.amount.amountMinor,
    currency: entry.amount.currency,
    role: entry.role,
  });
  await tx.insert(economicFlows).values({
    id: flow.id,
    ownerId,
    transactionId: flow.transactionId,
    effectiveAt: flow.effectiveAt,
    amountMinor: flow.amount.amountMinor,
    currency: flow.amount.currency,
  });
  await tx.insert(flowClassifications).values({
    ownerId,
    flowId: flow.id,
    revision: 1,
    kind: flow.kind,
    source: 'user',
    reason: 'Telegram text input',
    payload: encodeEconomicFlowClassification(classificationFromEconomicFlow(flow)),
    decidedAt: createdAt,
    isCurrent: true,
  });
  if (observation !== null) {
    await tx.insert(spendingObservations).values({
      ownerId,
      economicFlowId: observation.economicFlowId,
      economicDate: observation.economicDate,
      categoryId: observation.categoryId,
      necessity: observation.necessity,
      cadence: observation.cadence,
      irregular: observation.irregular,
    });
  }
  return Object.freeze({
    entityType: 'cash_activity',
    entityId: transaction.id,
    earliestAffectedAt: transaction.effectiveAt,
    result: Object.freeze({ transactionId: transaction.id, flowId: flow.id }),
  });
}

export async function appendSinkingFund(
  tx: DatabaseTransaction,
  ownerId: string,
  input: SinkingFund,
): Promise<CommandMutationResult> {
  const fund = createSinkingFund(input);
  const current = await tx
    .select({ priority: sinkingFunds.priority })
    .from(sinkingFunds)
    .where(eq(sinkingFunds.ownerId, ownerId));
  const priority = current.reduce((maximum, row) => Math.max(maximum, row.priority), -1) + 1;
  const canonical = createSinkingFund({ ...fund, priority });
  await tx.insert(sinkingFunds).values({
    id: canonical.id,
    ownerId,
    targetMinor: canonical.target.amountMinor,
    currency: canonical.target.currency,
    dueDate: canonical.dueDate,
    priority: canonical.priority,
    status: canonical.status,
    allocationPolicy: canonical.allocationPolicy,
    createdAt: canonical.createdAt,
    payload: encodeSourceJson(canonical),
  });
  return Object.freeze({
    entityType: 'sinking_fund',
    entityId: canonical.id,
    earliestAffectedAt: canonical.createdAt,
    result: Object.freeze({ fundId: canonical.id }),
  });
}

export async function loadCashActivityByTransaction(
  tx: DatabaseTransaction,
  ownerId: string,
  transactionId: string,
): Promise<
  Readonly<{
    transaction: CanonicalTransaction;
    flow: EconomicFlow;
    observation: SpendingObservation | null;
  }>
> {
  const version = await tx.query.transactionVersions.findFirst({
    where: and(
      eq(transactionVersions.ownerId, ownerId),
      eq(transactionVersions.transactionId, transactionId),
      eq(transactionVersions.isCurrent, true),
    ),
  });
  const flowRow = await tx.query.economicFlows.findFirst({
    where: and(eq(economicFlows.ownerId, ownerId), eq(economicFlows.transactionId, transactionId)),
  });
  if (version === undefined || flowRow === undefined)
    throw new DataInvariantError(
      'cash_correction.not_found',
      'The Telegram cash activity no longer exists.',
    );
  const transaction = createCanonicalTransaction(
    decodeSourceJson(version.payload) as CanonicalTransaction,
  );
  const classification = await tx.query.flowClassifications.findFirst({
    where: and(
      eq(flowClassifications.ownerId, ownerId),
      eq(flowClassifications.flowId, flowRow.id),
      eq(flowClassifications.isCurrent, true),
    ),
  });
  if (classification === undefined)
    throw new DataInvariantError(
      'cash_correction.not_found',
      'The Telegram cash classification no longer exists.',
    );
  const payload = decodeSourceJson(classification.payload) as Record<string, unknown>;
  const common = {
    id: flowRow.id as never,
    transactionId: flowRow.transactionId as never,
    effectiveAt: canonicalDatabaseInstant(flowRow.effectiveAt) as never,
    amount: { amountMinor: flowRow.amountMinor, currency: flowRow.currency as never },
  };
  const flow = createEconomicFlow(
    classification.kind === 'earned_income'
      ? { ...common, kind: 'earned_income', source: payload['earnedIncomeSource'] as never }
      : classification.kind === 'consumption'
        ? { ...common, kind: 'consumption', reimbursable: payload['reimbursable'] as boolean }
        : classification.kind === 'refund' || classification.kind === 'reimbursement'
          ? {
              ...common,
              kind: classification.kind,
              relatedTransactionId: payload['relatedTransactionId'] as never,
            }
          : { ...common, kind: classification.kind as 'other_external_flow' },
  );
  const observationRow = await tx.query.spendingObservations.findFirst({
    where: and(
      eq(spendingObservations.ownerId, ownerId),
      eq(spendingObservations.economicFlowId, flowRow.id),
    ),
  });
  const observation =
    observationRow === undefined
      ? null
      : createSpendingObservation({
          economicFlowId: observationRow.economicFlowId as never,
          economicDate: observationRow.economicDate as never,
          categoryId: observationRow.categoryId as never,
          necessity: observationRow.necessity as never,
          cadence: observationRow.cadence as never,
          irregular: observationRow.irregular,
        });
  return Object.freeze({ transaction, flow, observation });
}
