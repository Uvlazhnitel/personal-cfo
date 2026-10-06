import { and, eq } from 'drizzle-orm';
import { EUR, createEconomicFlow } from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant, encodeEconomicFlowClassification } from './financial-facts.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  accountEntries,
  economicFlows,
  flowAmbiguities,
  flowClassifications,
  primarySalaryTriggers,
  transactionVersions,
  users,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type BankPrimarySalaryInput = Readonly<{
  transactionId: string;
  now: string;
  reason: string;
}>;

function localDateAtInstant(instant: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export async function classifyBankTransactionAsPrimarySalary(
  tx: DatabaseTransaction,
  ownerId: string,
  input: BankPrimarySalaryInput,
): Promise<CommandMutationResult> {
  const now = canonicalDatabaseInstant(input.now);
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'bank_salary.invalid_reason',
      'Primary salary classification requires a reason of at most 500 characters.',
    );
  }

  const owner = await tx.query.users.findFirst({ where: eq(users.id, ownerId) });
  if (owner === undefined) {
    throw new DataInvariantError(
      'bank_salary.owner_not_found',
      'The authenticated owner is missing.',
    );
  }
  const ambiguities = await tx
    .select()
    .from(flowAmbiguities)
    .where(
      and(
        eq(flowAmbiguities.ownerId, ownerId),
        eq(flowAmbiguities.transactionId, input.transactionId),
        eq(flowAmbiguities.kind, 'unclassified_external_flow'),
        eq(flowAmbiguities.status, 'unresolved'),
      ),
    );
  if (ambiguities.length !== 1) {
    throw new DataConflictError(
      'bank_salary.not_unresolved',
      'The bank transaction is missing, already resolved, or not an unclassified external flow.',
    );
  }

  const transaction = await tx.query.transactionVersions.findFirst({
    where: and(
      eq(transactionVersions.ownerId, ownerId),
      eq(transactionVersions.transactionId, input.transactionId),
      eq(transactionVersions.isCurrent, true),
    ),
  });
  if (
    transaction === undefined ||
    transaction.kind !== 'external_flow' ||
    transaction.bookingStatus !== 'booked'
  ) {
    throw new DataInvariantError(
      'bank_salary.invalid_transaction',
      'Primary salary classification requires a current booked external-flow transaction.',
    );
  }
  const entries = await tx
    .select()
    .from(accountEntries)
    .where(
      and(
        eq(accountEntries.ownerId, ownerId),
        eq(accountEntries.transactionId, input.transactionId),
        eq(accountEntries.transactionRevision, transaction.revision),
      ),
    );
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    entry.role !== 'external_flow' ||
    entry.currency !== 'EUR' ||
    entry.amountMinor <= 0n
  ) {
    throw new DataInvariantError(
      'bank_salary.invalid_credit',
      'Primary salary classification requires one positive EUR external-flow entry.',
    );
  }
  const existingFlow = await tx.query.economicFlows.findFirst({
    where: and(
      eq(economicFlows.ownerId, ownerId),
      eq(economicFlows.transactionId, input.transactionId),
    ),
  });
  const existingTrigger = await tx.query.primarySalaryTriggers.findFirst({
    where: and(
      eq(primarySalaryTriggers.ownerId, ownerId),
      eq(primarySalaryTriggers.transactionId, input.transactionId),
    ),
  });
  if (existingFlow !== undefined || existingTrigger !== undefined) {
    throw new DataConflictError(
      'bank_salary.already_classified',
      'The bank transaction already has authoritative economic meaning.',
    );
  }

  const flow = createEconomicFlow({
    id: generateUuidV7('bank-primary-salary-flow') as never,
    transactionId: input.transactionId as never,
    effectiveAt: canonicalDatabaseInstant(transaction.effectiveAt) as never,
    amount: { amountMinor: entry.amountMinor, currency: EUR },
    kind: 'earned_income',
    source: 'salary',
  });
  const effectiveDate = localDateAtInstant(flow.effectiveAt, owner.timeZone);
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
    reason,
    payload: encodeEconomicFlowClassification({
      kind: 'earned_income',
      earnedIncomeSource: 'salary',
      primarySalary: true,
    }),
    decidedAt: now,
    isCurrent: true,
  });
  await tx.insert(primarySalaryTriggers).values({
    ownerId,
    transactionId: input.transactionId,
    effectiveDate,
  });
  const resolved = await tx
    .update(flowAmbiguities)
    .set({ status: 'rejected_transfer', resolvedAt: now, resolver: 'user', reason })
    .where(
      and(
        eq(flowAmbiguities.ownerId, ownerId),
        eq(flowAmbiguities.id, ambiguities[0]!.id),
        eq(flowAmbiguities.status, 'unresolved'),
      ),
    )
    .returning({ id: flowAmbiguities.id });
  if (resolved.length !== 1) {
    throw new DataConflictError(
      'bank_salary.not_unresolved',
      'The bank transaction ambiguity was resolved concurrently.',
    );
  }

  return Object.freeze({
    entityType: 'economic_flow',
    entityId: flow.id,
    earliestAffectedAt: flow.effectiveAt,
    result: Object.freeze({
      transactionId: input.transactionId,
      flowId: flow.id,
      effectiveDate,
      earnedIncomeSource: 'salary',
      primarySalary: true,
    }),
  });
}
