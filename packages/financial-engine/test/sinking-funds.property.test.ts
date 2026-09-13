import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createExpectedPrimaryPaySchedule,
  createMeasurementPeriod,
  createMoney,
  createPayCycle,
  createSinkingFund,
  createSinkingFundAllocation,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  Instant,
  LocalDate,
  MeasurementPeriod,
  SinkingFund,
  SinkingFundAllocation,
} from '@personal-cfo/domain';

import {
  calculateCurrentCycleSinkingDue,
  calculateReservationEffect,
  calculateSinkingFundSchedule,
} from '../src/index.js';
import type { SinkingFundScheduleInput } from '../src/index.js';

const PROPERTY_OPTIONS = { seed: 20_260_913, numRuns: 100 } as const;

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-01-30T12:00:00Z');
const COVERAGE = measurement('2025-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
const CYCLE = createPayCycle({
  id: parsePayCycleId(uuid(10)),
  openingSalaryTransactionId: parseTransactionId(uuid(10)),
  startInclusive: parseInstant('2026-01-27T08:00:00Z'),
  startDate: parseLocalDate('2026-01-27'),
  closingSalaryTransactionId: null,
  endExclusive: null,
  expectedNextPayDate: parseLocalDate('2026-02-27'),
  status: 'open',
});
const FUTURE_DATES = [
  parseLocalDate('2026-02-27'),
  parseLocalDate('2026-03-27'),
  parseLocalDate('2026-04-27'),
] as const;

function measurement(start: string, end: string): MeasurementPeriod {
  return createMeasurementPeriod({
    startInclusive: parseInstant(start),
    endExclusive: parseInstant(end),
  });
}

function fund(targetMinor: bigint, dueDate: LocalDate): SinkingFund {
  return createSinkingFund({
    id: parseSinkingFundId(uuid(20)),
    label: 'Property fund',
    target: createMoney(targetMinor, EUR),
    dueDate,
    priority: 1,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: parseInstant('2026-01-01T00:00:00Z'),
  });
}

function allocation(
  seed: number,
  target: SinkingFund,
  amountMinor: bigint,
  effectiveAt: Instant,
): SinkingFundAllocation {
  return createSinkingFundAllocation({
    id: parseSinkingFundAllocationId(uuid(seed)),
    fundId: target.id,
    amount: createMoney(amountMinor, EUR),
    effectiveAt,
    kind: 'allocation',
  });
}

function scheduleInput(
  target: SinkingFund,
  allocations: readonly SinkingFundAllocation[],
  dates: readonly LocalDate[],
): SinkingFundScheduleInput {
  return {
    funds: [target],
    allocations,
    reservationCoverage: COVERAGE,
    payCycles: [CYCLE],
    expectedPrimaryPaySchedule: createExpectedPrimaryPaySchedule({
      dates,
      completeThrough: parseLocalDate('2026-12-31'),
    }),
    effectiveDate: parseLocalDate('2026-01-30'),
    asOf: AS_OF,
    engineVersion: '2c.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'property-test',
  };
}

describe('Sinking Fund properties', () => {
  it('always schedules the exact target without losing minor units', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.integer({ min: 0, max: FUTURE_DATES.length }),
        (targetMinor, futureCount) => {
          const dates = FUTURE_DATES.slice(0, futureCount);
          const dueDate = dates.at(-1) ?? parseLocalDate('2026-01-31');
          const target = fund(targetMinor, dueDate);
          const result = calculateSinkingFundSchedule(scheduleInput(target, [], dates));
          const item = result.value?.funds[0];
          if (item === undefined) throw new Error('Expected schedule item.');
          const scheduled =
            item.currentCycleRequirement!.outstandingAmount.amountMinor +
            item.futureContributions.reduce((sum, part) => sum + part.amount.amountMinor, 0n);

          expect(scheduled).toBe(targetMinor);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('swaps outstanding due for reserved cash without changing protected or owned cash', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (targetMinor, candidateAllocation) => {
          const target = fund(targetMinor, FUTURE_DATES[2]);
          const before = calculateCurrentCycleSinkingDue(scheduleInput(target, [], FUTURE_DATES));
          const due = before.value?.totalOutstanding.amountMinor;
          if (due === undefined) throw new Error('Expected current due.');
          const amount = candidateAllocation > due ? due : candidateAllocation;
          const events =
            amount === 0n
              ? []
              : [allocation(30, target, amount, parseInstant('2026-01-29T00:00:00Z'))];
          const after = calculateCurrentCycleSinkingDue(
            scheduleInput(target, events, FUTURE_DATES),
          );

          expect(after.value?.totalProtected.amountMinor).toBe(
            before.value?.totalProtected.amountMinor,
          );
          expect(
            (after.value?.totalReserved.amountMinor ?? 0n) +
              (after.value?.totalOutstanding.amountMinor ?? 0n),
          ).toBe(due);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('aggregates reservation events exactly across nested periods', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (januaryAmount, februaryAmount, marchAmount) => {
          const target = fund(
            januaryAmount + februaryAmount + marchAmount,
            parseLocalDate('2026-12-31'),
          );
          const events = [
            allocation(30, target, januaryAmount, parseInstant('2026-01-15T00:00:00Z')),
            allocation(31, target, februaryAmount, parseInstant('2026-02-15T00:00:00Z')),
            allocation(32, target, marchAmount, parseInstant('2026-03-15T00:00:00Z')),
          ];
          const firstTwo = measurement('2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
          const march = measurement('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
          const quarter = measurement('2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z');
          const calculate = (period: MeasurementPeriod) =>
            calculateReservationEffect({
              allocations: events,
              reservationCoverage: quarter,
              period,
              economicFlows: [],
              asOf: quarter.endExclusive,
              engineVersion: '2c.0.0',
              settingsVersion: 'settings-1',
              inputWatermark: 'property-test',
            }).value!.change.amountMinor;

          expect(calculate(quarter)).toBe(calculate(firstTwo) + calculate(march));
        },
      ),
      PROPERTY_OPTIONS,
    );
  });
});
