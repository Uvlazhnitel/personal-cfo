import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createCashDragDailyObservation,
  createExactFraction,
  createMetricResult,
  createMoney,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type { CashDragDailyObservation, MetricResult } from '@personal-cfo/domain';

import { calculateCashDrag, calculateSafeToInvest } from '../src/index.js';
import { addLocalDays } from '../src/local-calendar.js';
import type { CashDragAssessment, LiquidityReserve, SafeToInvest } from '../src/index.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');

function metric<T>(value: T): MetricResult<T> {
  return createMetricResult({
    status: 'complete',
    value,
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 's1',
    inputWatermark: 'w',
    explanation: [],
    warnings: [],
  });
}

function currentMetrics(): readonly [MetricResult<LiquidityReserve>, MetricResult<SafeToInvest>] {
  const zero = createMoney(0n, EUR);
  const liquidity: LiquidityReserve = Object.freeze({
    currentLiquidCash: createMoney(600_000n, EUR),
    operationalEssential: zero,
    operationalNormal: zero,
    ringFencedCash: zero,
    sinkingFundReservedCash: zero,
    otherRestrictedCash: zero,
    currentCycleSinkingDue: zero,
    uncoveredObligations: zero,
    minimumReserveTarget: createMoney(250_000n, EUR),
    comfortReserveTarget: createMoney(500_000n, EUR),
    variabilityBuffer: createMoney(20_000n, EUR),
    minimumCash: createMoney(250_000n, EUR),
    comfortCash: createMoney(500_000n, EUR),
    freeLiquidCash: createMoney(600_000n, EUR),
    currentExcessAboveComfort: createMoney(100_000n, EUR),
    operationalStartInclusive: EFFECTIVE_DATE,
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
  const liquidityResult = metric(liquidity);
  const safe = calculateSafeToInvest({
    liquidity: liquidityResult,
    readiness: { kind: 'complete' },
    settings: { recommendationIncrement: createMoney(1_000n, EUR) },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 's1',
    inputWatermark: 'safe',
  });
  return [liquidityResult, safe];
}

function day(
  daysBefore: number,
  excess: bigint,
  completeness: 'complete' | 'partial' = 'complete',
): CashDragDailyObservation {
  return createCashDragDailyObservation({
    date: addLocalDays(EFFECTIVE_DATE, -daysBefore),
    liquidCash: createMoney(500_000n + excess, EUR),
    comfortCash: createMoney(500_000n, EUR),
    completeness,
  });
}

function calculate(observations: readonly CashDragDailyObservation[]): CashDragAssessment {
  const [currentLiquidity, currentSafeToInvest] = currentMetrics();
  const result = calculateCashDrag({
    dailyObservations: observations,
    currentLiquidity,
    currentSafeToInvest,
    effectiveDate: EFFECTIVE_DATE,
    settings: {
      windowDays: 60,
      minimumCompleteDays: 54,
      minimumPositiveExcessDays: 45,
      absoluteExcessThreshold: createMoney(25_000n, EUR),
      relativeComfortThreshold: createExactFraction(1n, 10n),
    },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 's1',
    inputWatermark: 'drag',
  });
  if (result.value === null) throw new Error('Expected Cash Drag assessment.');
  return result.value;
}

describe('Cash Drag properties', () => {
  it('is order-independent and never exceeds current Recommended Safe to Invest', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...Array(59).keys()], { minLength: 59, maxLength: 59 }),
        (order) => {
          const observations = order.map((index) => day(index + 1, 100_000n));
          const assessment = calculate(observations);
          expect(assessment).toEqual(calculate([...observations].reverse()));
          expect(assessment.actionCap.amountMinor).toBe(100_000n);
        },
      ),
      { seed: 2_026_029, numRuns: 50 },
    );
  });

  it('cannot lower average excess when one complete day increases', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        (base, increase) => {
          const constant = Array.from({ length: 58 }, (_, index) => day(index + 2, 100_000n));
          const before = calculate([day(1, base), ...constant]);
          const after = calculate([day(1, base + increase), ...constant]);
          expect(after.averageExcess!.amountMinor).toBeGreaterThanOrEqual(
            before.averageExcess!.amountMinor,
          );
        },
      ),
      { seed: 2_026_030, numRuns: 100 },
    );
  });

  it('ignores incomplete-day money and distinguishes it from a complete zero day', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000n }), (ignoredAmount) => {
        const complete = Array.from({ length: 53 }, (_, index) => day(index + 1, 100_000n));
        const base = calculate(complete);
        const missingReplacement = calculate([...complete, day(54, ignoredAmount, 'partial')]);
        const completeZero = calculate([...complete, day(54, 0n)]);

        expect(missingReplacement.averageExcess).toEqual(base.averageExcess);
        expect(missingReplacement.completeDays).toBe(base.completeDays);
        expect(completeZero.completeDays).toBe(base.completeDays + 1);
        expect(completeZero.averageExcess!.amountMinor).toBeLessThan(
          base.averageExcess!.amountMinor,
        );
      }),
      { seed: 2_026_031, numRuns: 100 },
    );
  });
});
