import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import {
  createCashReconciliationResolution,
  createCashReconciliation,
  createCanonicalTransaction,
  createEconomicFlow,
  createSinkingFundAllocation,
} from '@personal-cfo/domain';
import type {
  CashReconciliationResolution,
  CashReconciliation,
  CanonicalTransaction,
  EconomicFlow,
  SinkingFundAllocation,
} from '@personal-cfo/domain';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { decodeSourceJson, encodeSourceJson, normalizeSnapshotJson } from './json-codec.js';
import { enqueueRecalculation } from './jobs.js';
import type { RecalculationCause } from './jobs.js';
import {
  canonicalDatabaseInstant,
  classificationFromEconomicFlow,
  encodeEconomicFlowClassification,
} from './financial-facts.js';
import type { EconomicFlowClassification } from './financial-facts.js';
import { lockOwnerFinancialState } from './owner-lock.js';
import {
  auditEvents,
  accountEntries,
  cashReconciliations,
  cashReconciliationResolutions,
  commandRecords,
  economicFlows,
  financialTransactions,
  flowAmbiguities,
  flowClassifications,
  ownerInputVersions,
  recalculationRecords,
  sinkingEvents,
  transactionVersions,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export type CommandMutationResult = Readonly<{
  mutated?: boolean;
  entityType: string;
  entityId: string;
  earliestAffectedAt: string | null;
  result: Readonly<Record<string, unknown>>;
}>;

export type FinancialCommandInput = Readonly<{
  ownerId: string;
  kind: RecalculationCause;
  idempotencyKey: string;
  request: unknown;
  asOf: string;
  effectiveDate: string;
  now: string;
}>;

function requestHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeSnapshotJson(value)))
    .digest('hex');
}

export async function executeFinancialCommand(
  db: Database,
  boss: PgBoss,
  input: FinancialCommandInput,
  mutate: (tx: DatabaseTransaction, commandId: string) => Promise<CommandMutationResult>,
): Promise<
  Readonly<{
    commandId: string;
    replayed: boolean;
    mutated: boolean;
    inputVersion: bigint;
    result: Readonly<Record<string, unknown>>;
  }>
> {
  if (!/^[A-Za-z0-9._:-]{8,128}$/u.test(input.idempotencyKey))
    throw new DataInvariantError(
      'command.invalid_idempotency_key',
      'Idempotency-Key must contain 8-128 safe characters.',
    );
  const hash = requestHash(input.request);
  return db.transaction(async (tx) => {
    await lockOwnerFinancialState(tx, input.ownerId);
    const commandId = generateUuidV7('command');
    const inserted = await tx
      .insert(commandRecords)
      .values({
        id: commandId,
        ownerId: input.ownerId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        status: 'processing',
        result: null,
        createdAt: input.now,
        completedAt: null,
      })
      .onConflictDoNothing()
      .returning({ id: commandRecords.id });
    if (inserted.length === 0) {
      const existing = await tx.query.commandRecords.findFirst({
        where: and(
          eq(commandRecords.ownerId, input.ownerId),
          eq(commandRecords.kind, input.kind),
          eq(commandRecords.idempotencyKey, input.idempotencyKey),
        ),
      });
      if (existing === undefined)
        throw new DataInvariantError(
          'command.missing_after_conflict',
          'Conflicting command record was not visible.',
        );
      if (existing.requestHash !== hash)
        throw new DataConflictError(
          'command.payload_conflict',
          'The Idempotency-Key was already used with a different request.',
        );
      if (existing.status !== 'completed' || existing.result === null)
        throw new DataConflictError('command.in_progress', 'The command is not complete.');
      const storedResult = decodeSourceJson(existing.result) as Readonly<Record<string, unknown>>;
      const storedVersion = storedResult['inputVersion'];
      if (typeof storedVersion !== 'string' || !/^[1-9][0-9]*$/u.test(storedVersion))
        throw new DataInvariantError(
          'command.invalid_stored_result',
          'Completed command result does not contain its input version.',
        );
      return Object.freeze({
        commandId: existing.id,
        replayed: true,
        mutated: storedResult['mutated'] !== false,
        inputVersion: BigInt(storedVersion),
        result: storedResult,
      });
    }
    try {
      const mutation = await mutate(tx, commandId);
      if (mutation.mutated === false) {
        const current = await tx.query.ownerInputVersions.findFirst({
          where: eq(ownerInputVersions.ownerId, input.ownerId),
        });
        if (current === undefined)
          throw new DataInvariantError(
            'command.missing_owner_version',
            'Owner input version is missing.',
          );
        const result = Object.freeze({
          ...mutation.result,
          mutated: false,
          inputVersion: current.version.toString(),
        });
        await tx
          .update(commandRecords)
          .set({ status: 'completed', result: encodeSourceJson(result), completedAt: input.now })
          .where(eq(commandRecords.id, commandId));
        return Object.freeze({
          commandId,
          replayed: false,
          mutated: false,
          inputVersion: current.version,
          result,
        });
      }
      const versions = await tx
        .update(ownerInputVersions)
        .set({ version: sql`${ownerInputVersions.version} + 1`, updatedAt: input.now })
        .where(eq(ownerInputVersions.ownerId, input.ownerId))
        .returning({ version: ownerInputVersions.version });
      const version = versions[0]?.version;
      if (version === undefined)
        throw new DataInvariantError(
          'command.missing_owner_version',
          'Owner input version is missing.',
        );
      const requestId = generateUuidV7('recalculation');
      const jobId = await enqueueRecalculation(boss, tx, {
        requestId,
        ownerId: input.ownerId,
        inputVersion: version.toString(),
        cause: input.kind,
        asOf: input.asOf,
        effectiveDate: input.effectiveDate,
        earliestAffectedAt: mutation.earliestAffectedAt,
      });
      await tx.insert(recalculationRecords).values({
        id: requestId,
        ownerId: input.ownerId,
        inputVersion: version,
        cause: input.kind,
        earliestAffectedAt: mutation.earliestAffectedAt,
        status: 'queued',
        jobId,
        createdAt: input.now,
        completedAt: null,
        failureCategory: null,
        failureMessage: null,
      });
      await tx.insert(auditEvents).values({
        id: generateUuidV7('audit-event'),
        ownerId: input.ownerId,
        commandId,
        eventKind: input.kind,
        entityType: mutation.entityType,
        entityId: mutation.entityId,
        metadata: normalizeSnapshotJson({
          inputVersion: version,
          jobId,
          earliestAffectedAt: mutation.earliestAffectedAt,
        }),
        occurredAt: input.now,
      });
      const result = Object.freeze({
        ...mutation.result,
        mutated: true,
        inputVersion: version.toString(),
        recalculationJobId: jobId,
      });
      await tx
        .update(commandRecords)
        .set({ status: 'completed', result: encodeSourceJson(result), completedAt: input.now })
        .where(eq(commandRecords.id, commandId));
      return Object.freeze({
        commandId,
        replayed: false,
        mutated: true,
        inputVersion: version,
        result,
      });
    } catch (error) {
      await tx
        .update(commandRecords)
        .set({
          status: 'failed',
          result: normalizeSnapshotJson({ category: 'command_failed' }),
          completedAt: input.now,
        })
        .where(eq(commandRecords.id, commandId));
      throw error;
    }
  });
}

export async function appendClassificationCorrection(
  tx: DatabaseTransaction,
  ownerId: string,
  flowId: string,
  classification: EconomicFlowClassification,
  now: string,
  reason: string,
): Promise<CommandMutationResult> {
  const base = await tx.query.economicFlows.findFirst({
    where: and(eq(economicFlows.ownerId, ownerId), eq(economicFlows.id, flowId)),
  });
  if (base === undefined)
    throw new DataInvariantError(
      'classification.flow_not_found',
      'The economic flow does not exist.',
    );
  const common = {
    id: base.id as never,
    transactionId: base.transactionId as never,
    effectiveAt: canonicalDatabaseInstant(base.effectiveAt) as never,
    amount: { amountMinor: base.amountMinor, currency: base.currency as never },
  };
  const validated = createEconomicFlow(
    classification.kind === 'earned_income'
      ? { ...common, kind: classification.kind, source: classification.earnedIncomeSource }
      : classification.kind === 'consumption'
        ? { ...common, kind: classification.kind, reimbursable: classification.reimbursable }
        : classification.kind === 'refund' || classification.kind === 'reimbursement'
          ? {
              ...common,
              kind: classification.kind,
              relatedTransactionId: classification.relatedTransactionId as never,
            }
          : { ...common, kind: classification.kind },
  );
  const current = await tx.query.flowClassifications.findFirst({
    where: and(
      eq(flowClassifications.ownerId, ownerId),
      eq(flowClassifications.flowId, base.id),
      eq(flowClassifications.isCurrent, true),
    ),
  });
  if (current === undefined)
    throw new DataInvariantError(
      'classification.flow_not_found',
      'The economic flow does not exist.',
    );
  await tx
    .update(flowClassifications)
    .set({ isCurrent: false })
    .where(
      and(
        eq(flowClassifications.ownerId, ownerId),
        eq(flowClassifications.flowId, base.id),
        eq(flowClassifications.isCurrent, true),
      ),
    );
  await tx.insert(flowClassifications).values({
    ownerId,
    flowId: base.id,
    revision: current.revision + 1,
    kind: validated.kind,
    source: 'user',
    reason,
    payload: encodeEconomicFlowClassification(classification),
    decidedAt: now,
    isCurrent: true,
  });
  return Object.freeze({
    entityType: 'economic_flow',
    entityId: base.id,
    earliestAffectedAt: canonicalDatabaseInstant(base.effectiveAt),
    result: Object.freeze({ flowId: base.id, revision: current.revision + 1 }),
  });
}

export async function resolveTransferCandidate(
  tx: DatabaseTransaction,
  ownerId: string,
  candidateId: string,
  resolution: 'confirmed_transfer' | 'rejected_transfer',
  now: string,
  reason: string,
  replacementTransaction?: CanonicalTransaction,
): Promise<CommandMutationResult> {
  const candidate = await tx.query.flowAmbiguities.findFirst({
    where: and(
      eq(flowAmbiguities.ownerId, ownerId),
      eq(flowAmbiguities.id, candidateId),
      eq(flowAmbiguities.status, 'unresolved'),
    ),
  });
  if (candidate === undefined)
    throw new DataInvariantError(
      'transfer.candidate_not_unresolved',
      'The transfer candidate is missing or already resolved.',
    );
  if (resolution === 'confirmed_transfer') {
    if (replacementTransaction === undefined)
      throw new DataInvariantError(
        'transfer.missing_replacement',
        'Confirmed transfers require a canonical replacement transaction.',
      );
    const replacement = createCanonicalTransaction(replacementTransaction);
    if (replacement.id !== candidate.transactionId || replacement.kind !== 'internal_transfer')
      throw new DataInvariantError(
        'transfer.invalid_replacement',
        'Replacement must confirm the candidate transaction as an internal transfer.',
      );
    const current = await tx.query.transactionVersions.findFirst({
      where: and(
        eq(transactionVersions.ownerId, ownerId),
        eq(transactionVersions.transactionId, replacement.id),
        eq(transactionVersions.isCurrent, true),
      ),
    });
    if (current === undefined)
      throw new DataInvariantError(
        'transfer.transaction_not_found',
        'Candidate transaction is missing.',
      );
    await tx
      .update(transactionVersions)
      .set({ isCurrent: false, supersededAt: now })
      .where(
        and(
          eq(transactionVersions.ownerId, ownerId),
          eq(transactionVersions.transactionId, replacement.id),
          eq(transactionVersions.isCurrent, true),
        ),
      );
    const revision = current.revision + 1;
    await tx.insert(transactionVersions).values({
      ownerId,
      transactionId: replacement.id,
      revision,
      kind: replacement.kind,
      bookingStatus: replacement.bookingStatus,
      effectiveAt: replacement.effectiveAt,
      payload: encodeSourceJson(replacement),
      isCurrent: true,
      supersededAt: null,
    });
    await tx.insert(accountEntries).values(
      replacement.entries.map((entry) => ({
        ownerId,
        transactionId: replacement.id,
        transactionRevision: revision,
        entryId: entry.id,
        accountId: entry.accountId,
        amountMinor: entry.amount.amountMinor,
        currency: entry.amount.currency,
        role: entry.role,
      })),
    );
  }
  const updated = await tx
    .update(flowAmbiguities)
    .set({ status: resolution, resolvedAt: now, resolver: 'user', reason })
    .where(
      and(
        eq(flowAmbiguities.ownerId, ownerId),
        eq(flowAmbiguities.id, candidateId),
        eq(flowAmbiguities.status, 'unresolved'),
      ),
    )
    .returning({ id: flowAmbiguities.id });
  if (updated.length !== 1)
    throw new DataInvariantError(
      'transfer.candidate_not_unresolved',
      'The transfer candidate is missing or already resolved.',
    );
  return Object.freeze({
    entityType: 'transfer_candidate',
    entityId: candidateId,
    earliestAffectedAt:
      replacementTransaction === undefined
        ? canonicalDatabaseInstant(candidate.effectiveAt)
        : [
            canonicalDatabaseInstant(candidate.effectiveAt),
            replacementTransaction.effectiveAt,
          ].sort()[0]!,
    result: Object.freeze({ candidateId, resolution }),
  });
}

export async function appendCashReconciliation(
  tx: DatabaseTransaction,
  ownerId: string,
  transaction: CanonicalTransaction,
  flow: EconomicFlow,
  reconciliation: CashReconciliation,
): Promise<CommandMutationResult> {
  const canonicalTransaction = createCanonicalTransaction(transaction);
  const canonicalFlow = createEconomicFlow(flow);
  const canonicalReconciliation = createCashReconciliation(reconciliation);
  if (
    canonicalTransaction.id !== canonicalReconciliation.adjustmentTransactionId ||
    canonicalFlow.transactionId !== canonicalTransaction.id ||
    canonicalFlow.kind !== 'cash_reconciliation_adjustment' ||
    canonicalTransaction.kind !== 'valuation_adjustment' ||
    canonicalTransaction.bookingStatus !== 'booked' ||
    canonicalTransaction.effectiveAt !== canonicalReconciliation.reconciledAt ||
    canonicalFlow.effectiveAt !== canonicalReconciliation.reconciledAt ||
    canonicalTransaction.entries.length !== 1 ||
    canonicalTransaction.entries[0]?.accountId !== canonicalReconciliation.accountId ||
    canonicalTransaction.entries[0].amount.currency !== canonicalReconciliation.variance.currency ||
    canonicalTransaction.entries[0].amount.amountMinor !==
      canonicalReconciliation.variance.amountMinor ||
    canonicalFlow.amount.currency !== canonicalReconciliation.variance.currency ||
    canonicalFlow.amount.amountMinor !== canonicalReconciliation.variance.amountMinor
  ) {
    throw new DataInvariantError(
      'reconciliation.invalid_bundle',
      'Reconciliation, adjustment transaction, and flow must reference one canonical adjustment.',
    );
  }
  await tx
    .insert(financialTransactions)
    .values({ id: canonicalTransaction.id, ownerId, createdAt: canonicalTransaction.effectiveAt });
  await tx.insert(transactionVersions).values({
    ownerId,
    transactionId: canonicalTransaction.id,
    revision: 1,
    kind: canonicalTransaction.kind,
    bookingStatus: canonicalTransaction.bookingStatus,
    effectiveAt: canonicalTransaction.effectiveAt,
    payload: encodeSourceJson(canonicalTransaction),
    isCurrent: true,
    supersededAt: null,
  });
  await tx.insert(accountEntries).values(
    canonicalTransaction.entries.map((entry) => ({
      ownerId,
      transactionId: canonicalTransaction.id,
      transactionRevision: 1,
      entryId: entry.id,
      accountId: entry.accountId,
      amountMinor: entry.amount.amountMinor,
      currency: entry.amount.currency,
      role: entry.role,
    })),
  );
  await tx.insert(economicFlows).values({
    id: canonicalFlow.id,
    ownerId,
    transactionId: canonicalFlow.transactionId,
    effectiveAt: canonicalFlow.effectiveAt,
    amountMinor: canonicalFlow.amount.amountMinor,
    currency: canonicalFlow.amount.currency,
  });
  await tx.insert(flowClassifications).values({
    ownerId,
    flowId: canonicalFlow.id,
    revision: 1,
    kind: canonicalFlow.kind,
    source: 'user',
    reason: canonicalReconciliation.reason,
    payload: encodeEconomicFlowClassification(classificationFromEconomicFlow(canonicalFlow)),
    decidedAt: canonicalReconciliation.reconciledAt,
    isCurrent: true,
  });
  await tx.insert(cashReconciliations).values({
    id: canonicalReconciliation.id,
    ownerId,
    accountId: canonicalReconciliation.accountId,
    adjustmentTransactionId: canonicalReconciliation.adjustmentTransactionId,
    calculatedMinor: canonicalReconciliation.calculatedBalance.amountMinor,
    countedMinor: canonicalReconciliation.countedBalance.amountMinor,
    varianceMinor: canonicalReconciliation.variance.amountMinor,
    currency: canonicalReconciliation.variance.currency,
    materiality: canonicalReconciliation.materiality,
    reconciledAt: canonicalReconciliation.reconciledAt,
    payload: encodeSourceJson(canonicalReconciliation),
  });
  return Object.freeze({
    entityType: 'cash_reconciliation',
    entityId: canonicalReconciliation.id,
    earliestAffectedAt: canonicalReconciliation.reconciledAt,
    result: Object.freeze({
      reconciliationId: canonicalReconciliation.id,
      adjustmentTransactionId: canonicalTransaction.id,
    }),
  });
}

export async function appendManualSinkingAllocation(
  tx: DatabaseTransaction,
  ownerId: string,
  allocation: SinkingFundAllocation,
  commandId: string,
): Promise<CommandMutationResult> {
  const value = createSinkingFundAllocation(allocation);
  if (value.kind !== 'allocation')
    throw new DataInvariantError(
      'sinking.manual_kind',
      'Manual Sinking commands create allocation events only.',
    );
  await tx.insert(sinkingEvents).values({
    id: value.id,
    ownerId,
    fundId: value.fundId,
    kind: value.kind,
    amountMinor: value.amount.amountMinor,
    currency: value.amount.currency,
    effectiveAt: value.effectiveAt,
    relatedTransactionId: null,
    commandId,
    payload: encodeSourceJson(value),
  });
  return Object.freeze({
    entityType: 'sinking_allocation',
    entityId: value.id,
    earliestAffectedAt: value.effectiveAt,
    result: Object.freeze({ allocationId: value.id, fundId: value.fundId }),
  });
}

export async function appendReconciliationResolution(
  tx: DatabaseTransaction,
  ownerId: string,
  resolution: CashReconciliationResolution,
): Promise<CommandMutationResult> {
  const value = createCashReconciliationResolution(resolution);
  const reconciliationRow = await tx.query.cashReconciliations.findFirst({
    where: and(
      eq(cashReconciliations.ownerId, ownerId),
      eq(cashReconciliations.id, value.reconciliationId),
    ),
  });
  if (reconciliationRow === undefined)
    throw new DataInvariantError(
      'reconciliation.resolution_missing_original',
      'Resolution must reference an owner-scoped reconciliation.',
    );
  const reconciliation = createCashReconciliation(
    decodeSourceJson(reconciliationRow.payload) as CashReconciliation,
  );
  if (value.resolvedAt < reconciliation.reconciledAt)
    throw new DataInvariantError(
      'reconciliation.resolution_before_original',
      'Resolution cannot precede reconciliation.',
    );
  if (value.kind === 'reclassified_adjustment') {
    if (value.resolutionTransactionId !== reconciliation.adjustmentTransactionId)
      throw new DataInvariantError(
        'reconciliation.invalid_reclassification',
        'Reclassification must reference its own adjustment transaction.',
      );
  } else {
    const version = await tx.query.transactionVersions.findFirst({
      where: and(
        eq(transactionVersions.ownerId, ownerId),
        eq(transactionVersions.transactionId, value.resolutionTransactionId),
        eq(transactionVersions.isCurrent, true),
      ),
    });
    if (version === undefined)
      throw new DataInvariantError(
        'reconciliation.missing_reversal',
        'Reversal transaction does not exist.',
      );
    const transaction = createCanonicalTransaction(
      decodeSourceJson(version.payload) as CanonicalTransaction,
    );
    if (
      transaction.id === reconciliation.adjustmentTransactionId ||
      transaction.kind !== 'valuation_adjustment' ||
      transaction.bookingStatus !== 'booked' ||
      transaction.effectiveAt < reconciliation.reconciledAt ||
      transaction.effectiveAt > value.resolvedAt
    ) {
      throw new DataInvariantError(
        'reconciliation.invalid_reversal',
        'Reversal must be a distinct booked valuation adjustment inside the resolution interval.',
      );
    }
    const relevantEntries = transaction.entries.filter(
      (entry) => entry.accountId === reconciliation.accountId,
    );
    if (
      relevantEntries.length === 0 ||
      relevantEntries.some((entry) => entry.amount.currency !== reconciliation.variance.currency) ||
      relevantEntries.reduce((sum, entry) => sum + entry.amount.amountMinor, 0n) !==
        -reconciliation.variance.amountMinor
    ) {
      throw new DataInvariantError(
        'reconciliation.invalid_reversal_effect',
        'Reversal entries on the reconciled account must exactly negate the variance.',
      );
    }
  }
  await tx.insert(cashReconciliationResolutions).values({
    reconciliationId: value.reconciliationId,
    ownerId,
    kind: value.kind,
    resolutionTransactionId: value.resolutionTransactionId,
    resolvedAt: value.resolvedAt,
    payload: encodeSourceJson(value),
  });
  return Object.freeze({
    entityType: 'cash_reconciliation_resolution',
    entityId: value.reconciliationId,
    earliestAffectedAt: value.resolvedAt,
    result: Object.freeze({ reconciliationId: value.reconciliationId, kind: value.kind }),
  });
}
