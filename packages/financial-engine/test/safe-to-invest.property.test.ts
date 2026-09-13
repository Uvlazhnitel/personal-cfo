import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createMetricResult,
  createMoney,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type { MetricResult } from '@personal-cfo/domain';

import { calculateSafeToInvest } from '../src/index.js';
import type { LiquidityReserve, SafeToInvest } from '../src/index.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');

function reserve(
  cash: bigint,
  minimum: bigint,
  comfort: bigint,
  variability: bigint,
  ringFenced = 0n,
  due = 0n,
): LiquidityReserve {
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    currentLiquidCash: createMoney(cash, EUR),
    operationalEssential: zero,
    operationalNormal: zero,
    ringFencedCash: createMoney(ringFenced, EUR),
    sinkingFundReservedCash: createMoney(ringFenced, EUR),
    otherRestrictedCash: zero,
    currentCycleSinkingDue: createMoney(due, EUR),
    uncoveredObligations: zero,
    minimumReserveTarget: createMoney(minimum, EUR),
    comfortReserveTarget: createMoney(comfort, EUR),
    variabilityBuffer: createMoney(variability, EUR),
    minimumCash: createMoney(minimum, EUR),
    comfortCash: createMoney(comfort, EUR),
    freeLiquidCash: createMoney(cash - ringFenced, EUR),
    currentExcessAboveComfort: createMoney(cash > comfort ? cash - comfort : 0n, EUR),
    operationalStartInclusive: parseLocalDate('2026-09-14'),
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
}

function metric(value: LiquidityReserve): MetricResult<LiquidityReserve> {
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

function calculate(value: LiquidityReserve, increment: bigint): SafeToInvest {
  const result = calculateSafeToInvest({
    liquidity: metric(value),
    readiness: { kind: 'complete' },
    settings: { recommendationIncrement: createMoney(increment, EUR) },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 's1',
    inputWatermark: 'w',
  });
  if (result.value === null) throw new Error('Expected Safe to Invest value.');
  return result.value;
}

describe('Safe to Invest properties', () => {
  it('keeps tiers ordered and rounds each down by less than one increment', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 2_000_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 1n, max: 100_000n }),
        (minimum, comfortDelta, cash, variability, increment) => {
          const comfort = minimum + comfortDelta;
          const value = calculate(reserve(cash, minimum, comfort, variability), increment);
          expect(value.conservative.amountMinor).toBeGreaterThanOrEqual(0n);
          expect(value.conservative.amountMinor).toBeLessThanOrEqual(value.recommended.amountMinor);
          expect(value.recommended.amountMinor).toBeLessThanOrEqual(value.maximum.amountMinor);
          const pairs = [
            [value.conservative, value.unroundedConservative],
            [value.recommended, value.unroundedRecommended],
            [value.maximum, value.unroundedMaximum],
          ] as const;
          for (const [rounded, unrounded] of pairs) {
            expect(rounded.amountMinor).toBeLessThanOrEqual(unrounded.amountMinor);
            expect(unrounded.amountMinor - rounded.amountMinor).toBeLessThan(increment);
            expect(rounded.amountMinor % increment).toBe(0n);
          }
        },
      ),
      { seed: 2_026_025, numRuns: 150 },
    );
  });

  it('is monotonic in current cash and protected thresholds', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 500_000n }),
        (minimum, comfortDelta, cash, change) => {
          const comfort = minimum + comfortDelta;
          const before = calculate(reserve(cash, minimum, comfort, 10_000n), 1n);
          const moreCash = calculate(reserve(cash + change, minimum, comfort, 10_000n), 1n);
          expect(moreCash.conservative.amountMinor).toBeGreaterThanOrEqual(
            before.conservative.amountMinor,
          );
          expect(moreCash.recommended.amountMinor).toBeGreaterThanOrEqual(
            before.recommended.amountMinor,
          );
          expect(moreCash.maximum.amountMinor).toBeGreaterThanOrEqual(before.maximum.amountMinor);

          const higherComfort = calculate(reserve(cash, minimum, comfort + change, 10_000n), 1n);
          expect(higherComfort.conservative.amountMinor).toBeLessThanOrEqual(
            before.conservative.amountMinor,
          );
          expect(higherComfort.recommended.amountMinor).toBeLessThanOrEqual(
            before.recommended.amountMinor,
          );

          const higherMinimum = calculate(
            reserve(cash, minimum + change, comfort + change, 10_000n),
            1n,
          );
          expect(higherMinimum.maximum.amountMinor).toBeLessThanOrEqual(before.maximum.amountMinor);
        },
      ),
      { seed: 2_026_026, numRuns: 120 },
    );
  });

  it('changes only conservative when variability rises with fixed liquidity thresholds', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 500_000n }),
        fc.bigInt({ min: 0n, max: 200_000n }),
        (variability, increase) => {
          const before = calculate(reserve(1_000_000n, 400_000n, 600_000n, variability), 1n);
          const after = calculate(
            reserve(1_000_000n, 400_000n, 600_000n, variability + increase),
            1n,
          );
          expect(after.conservative.amountMinor).toBeLessThanOrEqual(
            before.conservative.amountMinor,
          );
          expect(after.recommended).toEqual(before.recommended);
          expect(after.maximum).toEqual(before.maximum);
        },
      ),
      { seed: 2_026_027, numRuns: 100 },
    );
  });

  it('never observes a one-for-one due-to-reserve swap twice', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 200_000n }),
        fc.bigInt({ min: 0n, max: 200_000n }),
        (reserved, due) => {
          const moved = due / 2n;
          const protectedTotal = reserved + due;
          const minimum = protectedTotal + 300_000n;
          const comfort = protectedTotal + 500_000n;
          const before = calculate(
            reserve(1_500_000n, minimum, comfort, 20_000n, reserved, due),
            1_000n,
          );
          const after = calculate(
            reserve(1_500_000n, minimum, comfort, 20_000n, reserved + moved, due - moved),
            1_000n,
          );
          expect(after).toEqual(before);
        },
      ),
      { seed: 2_026_028, numRuns: 100 },
    );
  });
});
