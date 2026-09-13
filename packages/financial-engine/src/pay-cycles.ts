import {
  compareInstants,
  compareLocalDates,
  createCanonicalTransaction,
  createEconomicFlow,
  createExpectedPrimaryPaySchedule,
  createPayCycle,
  createPrimarySalaryTrigger,
  parseInstant,
  parsePayCycleId,
} from '@personal-cfo/domain';
import type {
  CanonicalTransaction,
  EconomicFlow,
  ExpectedPrimaryPaySchedule,
  Instant,
  PayCycle,
  PrimarySalaryTrigger,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';

export type BuildPayCyclesInput = Readonly<{
  transactions: readonly CanonicalTransaction[];
  economicFlows: readonly EconomicFlow[];
  primarySalaryTriggers: readonly PrimarySalaryTrigger[];
  expectedPrimaryPaySchedule: ExpectedPrimaryPaySchedule;
  asOf: Instant;
}>;

export function buildPayCycles(input: BuildPayCyclesInput): readonly PayCycle[] {
  const transactions = input.transactions.map((item) => createCanonicalTransaction(item));
  const flows = input.economicFlows.map((item) => createEconomicFlow(item));
  const triggers = input.primarySalaryTriggers.map((item) => createPrimarySalaryTrigger(item));
  const expectedSchedule = createExpectedPrimaryPaySchedule(input.expectedPrimaryPaySchedule);
  const asOf = parseInstant(input.asOf);
  const transactionsById = new Map(transactions.map((item) => [item.id, item]));
  const flowsByTransaction = new Map(flows.map((item) => [item.transactionId, item]));

  if (new Set(triggers.map((item) => item.transactionId)).size !== triggers.length) {
    throw new FinancialEngineInvariantError(
      'pay_cycle.duplicate_salary_trigger',
      'Primary salary trigger transaction IDs must be unique.',
    );
  }
  if (new Set(flows.map((item) => item.transactionId)).size !== flows.length) {
    throw new FinancialEngineInvariantError(
      'pay_cycle.duplicate_flow_transaction',
      'Pay Cycle construction requires one economic-flow classification per transaction.',
    );
  }

  for (const trigger of triggers) {
    const transaction = transactionsById.get(trigger.transactionId);
    const flow = flowsByTransaction.get(trigger.transactionId);
    if (
      transaction?.bookingStatus !== 'booked' ||
      transaction.kind !== 'external_flow' ||
      transaction.effectiveAt !== flow?.effectiveAt ||
      flow.kind !== 'earned_income' ||
      flow.source !== 'salary' ||
      flow.amount.amountMinor <= 0n
    ) {
      throw new FinancialEngineInvariantError(
        'pay_cycle.invalid_salary_trigger',
        'A Pay Cycle trigger must match a booked positive primary-salary flow.',
      );
    }
  }

  const eligible = triggers
    .filter((trigger) => {
      const transaction = transactionsById.get(trigger.transactionId)!;
      return compareInstants(transaction.effectiveAt, asOf) <= 0;
    })
    .sort((left, right) => {
      const leftInstant = transactionsById.get(left.transactionId)!.effectiveAt;
      const rightInstant = transactionsById.get(right.transactionId)!.effectiveAt;
      const byInstant = compareInstants(leftInstant, rightInstant);
      return byInstant !== 0 ? byInstant : left.transactionId.localeCompare(right.transactionId);
    });

  return Object.freeze(
    eligible.map((trigger, index) => {
      const opening = transactionsById.get(trigger.transactionId)!;
      const nextTrigger = eligible[index + 1];
      const closing =
        nextTrigger === undefined ? undefined : transactionsById.get(nextTrigger.transactionId)!;

      if (closing !== undefined && compareInstants(opening.effectiveAt, closing.effectiveAt) >= 0) {
        throw new FinancialEngineInvariantError(
          'pay_cycle.overlapping_or_empty',
          'Primary salary events must create non-overlapping, non-empty Pay Cycles.',
        );
      }

      const expectedNextPayDate =
        closing === undefined
          ? (expectedSchedule.dates.find(
              (date) => compareLocalDates(date, trigger.effectiveDate) > 0,
            ) ?? null)
          : null;

      return createPayCycle({
        id: parsePayCycleId(opening.id),
        openingSalaryTransactionId: opening.id,
        startInclusive: opening.effectiveAt,
        startDate: trigger.effectiveDate,
        closingSalaryTransactionId: closing?.id ?? null,
        endExclusive: closing?.effectiveAt ?? null,
        expectedNextPayDate,
        status: closing === undefined ? 'open' : 'closed',
      });
    }),
  );
}
