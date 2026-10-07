import { and, eq } from 'drizzle-orm';
import {
  STANDARD_SPENDING_CATEGORIES,
  createSpendingObservation,
  parseInstant,
} from '@personal-cfo/domain';
import type { SpendingCadence, StandardSpendingCategoryCode } from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant } from './financial-facts.js';
import { decodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import {
  economicFlows,
  flowClassifications,
  spendingObservations,
  transactionVersions,
  users,
} from './schema.js';

export type ExistingFlowSpendingObservationInput =
  | Readonly<{
      economicFlowId: string;
      categoryCode: StandardSpendingCategoryCode;
      cadence: SpendingCadence;
      irregular: boolean;
      reason: string;
    }>
  | Readonly<{
      economicFlowId: string;
      reason: string;
    }>;

function localDateAt(value: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(parseInstant(canonicalDatabaseInstant(value))));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function classificationPayload(value: unknown): Readonly<Record<string, unknown>> {
  const decoded = decodeSourceJson(value);
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new DataInvariantError(
      'spending_observation.invalid_classification',
      'The current flow classification payload is invalid.',
    );
  }
  return decoded as Readonly<Record<string, unknown>>;
}

export async function appendExistingFlowSpendingObservation(
  tx: DatabaseTransaction,
  ownerId: string,
  input: ExistingFlowSpendingObservationInput,
): Promise<CommandMutationResult> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'spending_observation.invalid_reason',
      'Spending observation requires a reason of at most 500 characters.',
    );
  }
  const owner = await tx.query.users.findFirst({ where: eq(users.id, ownerId) });
  if (owner === undefined) {
    throw new DataInvariantError('spending_observation.owner_missing', 'The owner does not exist.');
  }
  const flow = await tx.query.economicFlows.findFirst({
    where: and(eq(economicFlows.ownerId, ownerId), eq(economicFlows.id, input.economicFlowId)),
  });
  if (flow === undefined) {
    throw new DataInvariantError(
      'spending_observation.flow_missing',
      'The owner-scoped economic flow does not exist.',
    );
  }
  const transaction = await tx.query.transactionVersions.findFirst({
    where: and(
      eq(transactionVersions.ownerId, ownerId),
      eq(transactionVersions.transactionId, flow.transactionId),
      eq(transactionVersions.isCurrent, true),
    ),
  });
  if (
    transaction === undefined ||
    transaction.kind !== 'external_flow' ||
    transaction.bookingStatus !== 'booked' ||
    transaction.effectiveAt !== flow.effectiveAt
  ) {
    throw new DataInvariantError(
      'spending_observation.ineligible_transaction',
      'Spending observation requires a current booked canonical external-flow transaction.',
    );
  }
  const classification = await tx.query.flowClassifications.findFirst({
    where: and(
      eq(flowClassifications.ownerId, ownerId),
      eq(flowClassifications.flowId, flow.id),
      eq(flowClassifications.isCurrent, true),
    ),
  });
  if (classification === undefined) {
    throw new DataInvariantError(
      'spending_observation.classification_missing',
      'The economic flow has no current classification.',
    );
  }
  const existing = await tx.query.spendingObservations.findFirst({
    where: and(
      eq(spendingObservations.ownerId, ownerId),
      eq(spendingObservations.economicFlowId, flow.id),
    ),
  });
  if (existing !== undefined) {
    throw new DataConflictError(
      'spending_observation.already_exists',
      'The economic flow already has a SpendingObservation.',
    );
  }

  const economicDate = localDateAt(flow.effectiveAt, owner.timeZone);
  let categoryId: string;
  let necessity: 'essential' | 'discretionary';
  let cadence: SpendingCadence;
  let irregular: boolean;
  let inherited = false;

  if (classification.kind === 'consumption') {
    if (!('categoryCode' in input) || !('cadence' in input) || !('irregular' in input)) {
      throw new DataInvariantError(
        'spending_observation.missing_semantics',
        'Consumption requires categoryCode, cadence, and irregular.',
      );
    }
    const standard = STANDARD_SPENDING_CATEGORIES[input.categoryCode];
    categoryId = standard.id;
    necessity = standard.necessity;
    cadence = input.cadence;
    irregular = input.irregular;
  } else if (classification.kind === 'refund' || classification.kind === 'reimbursement') {
    if ('categoryCode' in input || 'cadence' in input || 'irregular' in input) {
      throw new DataInvariantError(
        'spending_observation.reversal_semantics_forbidden',
        'Linked reversals inherit spending semantics from their related consumption.',
      );
    }
    const payload = classificationPayload(classification.payload);
    const relatedTransactionId = payload['relatedTransactionId'];
    if (typeof relatedTransactionId !== 'string') {
      throw new DataInvariantError(
        'spending_observation.unlinked_reversal',
        'A refund or reimbursement must reference canonical consumption.',
      );
    }
    const originalFlow = await tx.query.economicFlows.findFirst({
      where: and(
        eq(economicFlows.ownerId, ownerId),
        eq(economicFlows.transactionId, relatedTransactionId),
      ),
    });
    if (originalFlow === undefined) {
      throw new DataInvariantError(
        'spending_observation.invalid_reversal_target',
        'The linked owner-scoped consumption does not exist.',
      );
    }
    const originalClassification = await tx.query.flowClassifications.findFirst({
      where: and(
        eq(flowClassifications.ownerId, ownerId),
        eq(flowClassifications.flowId, originalFlow.id),
        eq(flowClassifications.isCurrent, true),
      ),
    });
    const originalObservation = await tx.query.spendingObservations.findFirst({
      where: and(
        eq(spendingObservations.ownerId, ownerId),
        eq(spendingObservations.economicFlowId, originalFlow.id),
      ),
    });
    if (originalClassification?.kind !== 'consumption' || originalObservation === undefined) {
      throw new DataInvariantError(
        'spending_observation.invalid_reversal_target',
        'The linked consumption must have a current SpendingObservation.',
      );
    }
    categoryId = originalObservation.categoryId;
    necessity = originalObservation.necessity as 'essential' | 'discretionary';
    cadence = originalObservation.cadence as SpendingCadence;
    irregular = originalObservation.irregular;
    inherited = true;
  } else {
    throw new DataInvariantError(
      'spending_observation.ineligible_flow',
      'Only consumption, refund, or reimbursement may have a SpendingObservation.',
    );
  }

  const observation = createSpendingObservation({
    economicFlowId: flow.id as never,
    economicDate: economicDate as never,
    categoryId: categoryId as never,
    necessity,
    cadence,
    irregular,
  });
  await tx.insert(spendingObservations).values({ ownerId, ...observation });
  return Object.freeze({
    entityType: 'spending_observation',
    entityId: flow.id,
    earliestAffectedAt: flow.effectiveAt,
    result: Object.freeze({
      economicFlowId: flow.id,
      economicDate,
      inherited,
      reason,
    }),
  });
}
