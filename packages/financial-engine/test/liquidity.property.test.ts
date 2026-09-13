import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  EUR,
  createExactFraction,
  createFutureObligation,
  createMetricResult,
  createMoney,
  parseFutureObligationId,
  parseInstant,
  parseLocalDate,
  parseSinkingFundId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { MetricResult, Money } from '@personal-cfo/domain';

import { calculateLiquidityReserve } from '../src/index.js';
import type {
  CurrentCycleSinkingDue,
  LiquidityReserveInput,
  SpendingBaseline,
} from '../src/index.js';

const AS_OF = parseInstant('2026-02-01T00:00:00Z');
const FUND_ID = parseSinkingFundId('01890f3e-7b2c-7001-8abc-000000000001');

function metric<T>(value: T): MetricResult<T> {
  return createMetricResult({
    status: 'complete',
    value,
    asOf: AS_OF,
    engineVersion: '2d.0.0',
    settingsVersion: 's1',
    inputWatermark: 'w',
    explanation: [],
    warnings: [],
  });
}

function baseline(): SpendingBaseline {
  return Object.freeze({
    normalBaseline: createMoney(30_000n, EUR),
    essentialBaseline: createMoney(20_000n, EUR),
    recurringNormal: createMoney(0n, EUR),
    recurringEssential: createMoney(0n, EUR),
    variableNormal: createMoney(30_000n, EUR),
    variableEssential: createMoney(20_000n, EUR),
    variabilityBuffer: createMoney(3_000n, EUR),
    excludedIrregular: createMoney(0n, EUR),
    excludedFundedConsumption: createMoney(0n, EUR),
    excludedReversalExcess: createMoney(0n, EUR),
    eligibleCompleteMonths: 6,
    historicalWindowUsed: [parseYearMonth('2026-01')],
    seasonalAdjustment: null,
    source: 'historical',
  });
}

function sinking(reserved: bigint, due: bigint): CurrentCycleSinkingDue {
  const zero = createMoney(0n, EUR);
  const byFund = Object.freeze([
    {
      fundId: FUND_ID,
      state: 'funding' as const,
      required: createMoney(due, EUR),
      satisfied: zero,
      outstanding: createMoney(due, EUR),
      reserved: createMoney(reserved, EUR),
      fundedConsumption: zero,
      fulfilled: createMoney(reserved, EUR),
      remaining: createMoney(due, EUR),
      excess: zero,
      protected: createMoney(reserved + due, EUR),
    },
  ]);
  return Object.freeze({
    byFund,
    totalRequired: createMoney(due, EUR),
    totalSatisfied: zero,
    totalOutstanding: createMoney(due, EUR),
    totalReserved: createMoney(reserved, EUR),
    totalProtected: createMoney(reserved + due, EUR),
  });
}

function input(
  reserved: bigint,
  due: bigint,
  obligations: readonly ReturnType<typeof createFutureObligation>[] = [],
): LiquidityReserveInput {
  const current: Money = createMoney(2_000_000n, EUR);
  return {
    baseline: metric(baseline()),
    sinkingProtection: metric(sinking(reserved, due)),
    currentLiquidCash: metric(current),
    operationalNeeds: [],
    futureObligations: obligations,
    otherRestrictedCash: [],
    inputCompleteness: {
      operationalNeeds: 'complete',
      obligations: 'complete',
      restrictedCash: 'complete',
    },
    nextReliableIncomeDate: parseLocalDate('2026-03-01'),
    effectiveDate: parseLocalDate('2026-02-01'),
    settings: {
      minimumReserveMonths: createExactFraction(1n, 1n),
      comfortReserveMonths: createExactFraction(3n, 1n),
      unknownIncomeHorizonDays: 31,
      obligationHorizonDays: 90,
    },
    asOf: AS_OF,
    engineVersion: '2d.0.0',
    settingsVersion: 's1',
    inputWatermark: 'w',
  };
}

function requireValue(result: ReturnType<typeof calculateLiquidityReserve>) {
  if (result.value === null) throw new Error('Expected liquidity value.');
  return result.value;
}

describe('liquidity properties', () => {
  it('preserves thresholds when due becomes reserved one-for-one', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        (reserved, due) => {
          const moved = due / 2n;
          const before = requireValue(calculateLiquidityReserve(input(reserved, due)));
          const after = requireValue(
            calculateLiquidityReserve(input(reserved + moved, due - moved)),
          );
          expect(after.minimumCash.amountMinor).toBe(before.minimumCash.amountMinor);
          expect(after.comfortCash.amountMinor).toBe(before.comfortCash.amountMinor);
        },
      ),
      { seed: 2_026_021, numRuns: 100 },
    );
  });

  it('increases both thresholds exactly with ring-fenced cash', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 500_000n }), (increase) => {
        const before = requireValue(calculateLiquidityReserve(input(0n, 0n)));
        const after = requireValue(calculateLiquidityReserve(input(increase, 0n)));
        expect(after.minimumCash.amountMinor - before.minimumCash.amountMinor).toBe(increase);
        expect(after.comfortCash.amountMinor - before.comfortCash.amountMinor).toBe(increase);
      }),
      { seed: 2_026_022, numRuns: 100 },
    );
  });

  it('keeps comfort cash at or above minimum and obligations monotonic', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        (base, increase) => {
          const make = (amount: bigint) =>
            createFutureObligation({
              id: parseFutureObligationId('01890f3e-7b2c-7002-8abc-000000000002'),
              dueDate: parseLocalDate('2026-02-20'),
              amount: { kind: 'exact', amount: createMoney(amount, EUR) },
              priority: 'mandatory',
              committed: true,
              status: 'open',
              coverage: { kind: 'uncovered' },
            });
          const before = requireValue(calculateLiquidityReserve(input(0n, 0n, [make(base)])));
          const after = requireValue(
            calculateLiquidityReserve(input(0n, 0n, [make(base + increase)])),
          );
          expect(after.minimumCash.amountMinor).toBeGreaterThanOrEqual(
            before.minimumCash.amountMinor,
          );
          expect(after.comfortCash.amountMinor).toBeGreaterThanOrEqual(
            after.minimumCash.amountMinor,
          );
        },
      ),
      { seed: 2_026_023, numRuns: 100 },
    );
  });
});
