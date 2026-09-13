import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  EUR,
  createAccountEntry,
  createCanonicalTransaction,
  createEconomicFlow,
  createExpectedPrimaryPaySchedule,
  createMoney,
  createPayCycle,
  createPrimarySalaryTrigger,
  parseAccountId,
  parseEconomicFlowId,
  parseEntryId,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type { EconomicFlow } from '@personal-cfo/domain';

import { FinancialEngineInvariantError, buildPayCycles } from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

function income(
  seed: number,
  instant: string,
  date: string,
  source: 'salary' | 'side_hustle' | 'other' = 'salary',
  amountMinor = 300_000n,
) {
  const id = parseTransactionId(uuid(seed));
  const effectiveAt = parseInstant(instant);
  const transaction = createCanonicalTransaction({
    id,
    effectiveAt,
    bookingStatus: 'booked',
    kind: 'external_flow',
    entries: [
      createAccountEntry({
        id: parseEntryId(uuid(seed + 100)),
        transactionId: id,
        accountId: parseAccountId(uuid(1)),
        amount: createMoney(amountMinor, EUR),
        role: 'external_flow',
      }),
    ],
  });
  const flow: EconomicFlow = createEconomicFlow({
    id: parseEconomicFlowId(uuid(seed + 200)),
    transactionId: id,
    effectiveAt,
    amount: createMoney(amountMinor, EUR),
    kind: 'earned_income',
    source,
  });
  return {
    transaction,
    flow,
    trigger: createPrimarySalaryTrigger({ transactionId: id, effectiveDate: parseLocalDate(date) }),
  };
}

const expectedSchedule = createExpectedPrimaryPaySchedule({
  dates: [parseLocalDate('2026-11-27'), parseLocalDate('2026-12-28')],
  completeThrough: parseLocalDate('2026-12-31'),
});

function build(events: readonly ReturnType<typeof income>[]) {
  return buildPayCycles({
    transactions: events.map((event) => event.transaction),
    economicFlows: events.map((event) => event.flow),
    primarySalaryTriggers: events
      .filter(
        (event) =>
          event.flow.kind === 'earned_income' &&
          event.flow.source === 'salary' &&
          event.flow.amount.amountMinor > 0n,
      )
      .map((event) => event.trigger),
    expectedPrimaryPaySchedule: expectedSchedule,
    asOf: parseInstant('2026-11-30T00:00:00Z'),
  });
}

describe('buildPayCycles', () => {
  it('constructs two closed cycles and one open cycle from actual salary bookings', () => {
    const september = income(10, '2026-09-27T08:00:00Z', '2026-09-27');
    const october = income(20, '2026-10-28T08:00:00Z', '2026-10-28');
    const november = income(30, '2026-11-27T08:00:00Z', '2026-11-27');
    const cycles = build([september, october, november]);

    expect(cycles).toHaveLength(3);
    expect(cycles[0]).toMatchObject({
      startInclusive: september.transaction.effectiveAt,
      endExclusive: october.transaction.effectiveAt,
      status: 'closed',
    });
    expect(cycles[1]?.endExclusive).toBe(november.transaction.effectiveAt);
    expect(cycles[2]).toMatchObject({
      startInclusive: november.transaction.effectiveAt,
      endExclusive: null,
      status: 'open',
      expectedNextPayDate: parseLocalDate('2026-12-28'),
    });
  });

  it('accepts salary-date drift without calendar-month assumptions', () => {
    const cycles = build([
      income(10, '2026-08-28T08:00:00Z', '2026-08-28'),
      income(20, '2026-09-27T08:00:00Z', '2026-09-27'),
      income(30, '2026-10-29T08:00:00Z', '2026-10-29'),
    ]);

    expect(cycles.map((cycle) => cycle.startDate)).toEqual([
      parseLocalDate('2026-08-28'),
      parseLocalDate('2026-09-27'),
      parseLocalDate('2026-10-29'),
    ]);
  });

  it('does not let side hustle or negative salary correction open a cycle', () => {
    const salary = income(10, '2026-09-27T08:00:00Z', '2026-09-27');
    const sideHustle = income(20, '2026-10-10T08:00:00Z', '2026-10-10', 'side_hustle', 20_000n);
    const correction = income(30, '2026-10-15T08:00:00Z', '2026-10-15', 'salary', -5_000n);

    expect(build([salary, sideHustle, correction])).toHaveLength(1);
  });

  it('rejects duplicate and non-primary salary triggers', () => {
    const salary = income(10, '2026-09-27T08:00:00Z', '2026-09-27');
    const sideHustle = income(20, '2026-10-10T08:00:00Z', '2026-10-10', 'side_hustle');
    const common = {
      transactions: [salary.transaction, sideHustle.transaction],
      economicFlows: [salary.flow, sideHustle.flow],
      expectedPrimaryPaySchedule: expectedSchedule,
      asOf: parseInstant('2026-11-30T00:00:00Z'),
    } as const;

    expect(() =>
      buildPayCycles({ ...common, primarySalaryTriggers: [salary.trigger, salary.trigger] }),
    ).toThrowError(FinancialEngineInvariantError);
    expect(() =>
      buildPayCycles({ ...common, primarySalaryTriggers: [sideHustle.trigger] }),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('rejects an invalid manually supplied Pay Cycle boundary', () => {
    expect(() =>
      createPayCycle({
        id: parsePayCycleId(uuid(1)),
        openingSalaryTransactionId: parseTransactionId(uuid(2)),
        startInclusive: parseInstant('2026-10-01T00:00:00Z'),
        startDate: parseLocalDate('2026-10-01'),
        closingSalaryTransactionId: parseTransactionId(uuid(3)),
        endExclusive: parseInstant('2026-09-01T00:00:00Z'),
        expectedNextPayDate: null,
        status: 'closed',
      }),
    ).toThrowError(DomainValidationError);
  });
});
