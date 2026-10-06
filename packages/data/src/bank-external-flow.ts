import { and, eq, inArray } from 'drizzle-orm';
import { EUR, createEconomicFlow } from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant, encodeEconomicFlowClassification } from './financial-facts.js';
import { decodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  accountEntries,
  economicFlows,
  flowAmbiguities,
  flowClassifications,
  transactionVersions,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type BankExternalFlowClassification =
  | Readonly<{ kind: 'consumption'; reimbursable: boolean }>
  | Readonly<{
      kind: 'refund' | 'reimbursement';
      relatedTransactionId: string;
    }>
  | Readonly<{ kind: 'other_external_flow' }>;

export type BankExternalFlowInput = Readonly<{
  transactionId: string;
  classification: BankExternalFlowClassification;
  now: string;
  reason: string;
}>;

async function requireLinkedConsumption(
  tx: DatabaseTransaction,
  ownerId: string,
  classification: Extract<BankExternalFlowClassification, { kind: 'refund' | 'reimbursement' }>,
  transactionId: string,
  amountMinor: bigint,
): Promise<void> {
  if (classification.relatedTransactionId === transactionId) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_related_transaction',
      'A reversal cannot reference its own transaction.',
    );
  }
  const relatedFlow = await tx.query.economicFlows.findFirst({
    where: and(
      eq(economicFlows.ownerId, ownerId),
      eq(economicFlows.transactionId, classification.relatedTransactionId),
    ),
  });
  if (relatedFlow === undefined) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_related_transaction',
      'The related owner-scoped consumption does not exist.',
    );
  }
  const relatedClassification = await tx.query.flowClassifications.findFirst({
    where: and(
      eq(flowClassifications.ownerId, ownerId),
      eq(flowClassifications.flowId, relatedFlow.id),
      eq(flowClassifications.isCurrent, true),
    ),
  });
  if (relatedClassification === undefined || relatedClassification.kind !== 'consumption') {
    throw new DataInvariantError(
      'bank_external_flow.invalid_related_transaction',
      'A refund or reimbursement must reference current canonical consumption.',
    );
  }
  const decoded = decodeSourceJson(relatedClassification.payload) as Record<string, unknown>;
  if (classification.kind === 'reimbursement' && decoded['reimbursable'] !== true) {
    throw new DataInvariantError(
      'bank_external_flow.non_reimbursable_target',
      'A reimbursement must reference reimbursable consumption.',
    );
  }
  if (relatedFlow.currency !== 'EUR') {
    throw new DataInvariantError(
      'bank_external_flow.invalid_related_transaction',
      'The related consumption must use EUR.',
    );
  }
  const existingReversals = await tx
    .select({ amountMinor: economicFlows.amountMinor, payload: flowClassifications.payload })
    .from(economicFlows)
    .innerJoin(
      flowClassifications,
      and(
        eq(flowClassifications.ownerId, economicFlows.ownerId),
        eq(flowClassifications.flowId, economicFlows.id),
        eq(flowClassifications.isCurrent, true),
      ),
    )
    .where(
      and(
        eq(economicFlows.ownerId, ownerId),
        inArray(flowClassifications.kind, ['refund', 'reimbursement']),
      ),
    );
  const alreadyReversed = existingReversals.reduce((total, reversal) => {
    const payload = decodeSourceJson(reversal.payload) as Record<string, unknown>;
    return payload['relatedTransactionId'] === classification.relatedTransactionId
      ? total + reversal.amountMinor
      : total;
  }, 0n);
  if (alreadyReversed + amountMinor > relatedFlow.amountMinor) {
    throw new DataInvariantError(
      'bank_external_flow.reversal_exceeds_consumption',
      'Linked refunds and reimbursements cannot exceed the related consumption.',
    );
  }
}

export async function classifyBankTransactionAsExternalFlow(
  tx: DatabaseTransaction,
  ownerId: string,
  input: BankExternalFlowInput,
): Promise<CommandMutationResult> {
  const now = canonicalDatabaseInstant(input.now);
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_reason',
      'Bank external-flow classification requires a reason of at most 500 characters.',
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
      'bank_external_flow.not_unresolved',
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
      'bank_external_flow.invalid_transaction',
      'Classification requires a current booked external-flow transaction.',
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
    entry.amountMinor === 0n
  ) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_entry',
      'Classification requires one non-zero EUR external-flow entry.',
    );
  }
  if (input.classification.kind === 'consumption' && entry.amountMinor >= 0n) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_consumption',
      'Consumption requires a debit transaction.',
    );
  }
  if (
    (input.classification.kind === 'refund' || input.classification.kind === 'reimbursement') &&
    entry.amountMinor <= 0n
  ) {
    throw new DataInvariantError(
      'bank_external_flow.invalid_reversal',
      'A refund or reimbursement requires a credit transaction.',
    );
  }
  const existingFlow = await tx.query.economicFlows.findFirst({
    where: and(
      eq(economicFlows.ownerId, ownerId),
      eq(economicFlows.transactionId, input.transactionId),
    ),
  });
  if (existingFlow !== undefined) {
    throw new DataConflictError(
      'bank_external_flow.already_classified',
      'The bank transaction already has authoritative economic meaning.',
    );
  }
  if (input.classification.kind === 'refund' || input.classification.kind === 'reimbursement') {
    await requireLinkedConsumption(
      tx,
      ownerId,
      input.classification,
      input.transactionId,
      entry.amountMinor,
    );
  }

  const amountMinor =
    input.classification.kind === 'consumption' ? -entry.amountMinor : entry.amountMinor;
  const common = {
    id: generateUuidV7('bank-external-flow') as never,
    transactionId: input.transactionId as never,
    effectiveAt: canonicalDatabaseInstant(transaction.effectiveAt) as never,
    amount: { amountMinor, currency: EUR },
  };
  const flow = createEconomicFlow(
    input.classification.kind === 'consumption'
      ? {
          ...common,
          kind: input.classification.kind,
          reimbursable: input.classification.reimbursable,
        }
      : input.classification.kind === 'refund' || input.classification.kind === 'reimbursement'
        ? {
            ...common,
            kind: input.classification.kind,
            relatedTransactionId: input.classification.relatedTransactionId as never,
          }
        : { ...common, kind: input.classification.kind },
  );
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
    payload: encodeEconomicFlowClassification(input.classification),
    decidedAt: now,
    isCurrent: true,
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
      'bank_external_flow.not_unresolved',
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
      classification: input.classification,
    }),
  });
}
