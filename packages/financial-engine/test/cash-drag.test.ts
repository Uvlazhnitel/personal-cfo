import { describe, expect, it } from 'vitest';

import {
  EUR,
  createCashDragDailyObservation,
  createExactFraction,
  createMetricResult,
  createMoney,
  parseCurrencyCode,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  CashDragDailyObservation,
  InvestabilityReadiness,
  MetricResult,
} from '@personal-cfo/domain';

import { calculateCashDrag, calculateSafeToInvest } from '../src/index.js';
import { addLocalDays } from '../src/local-calendar.js';
import type {
  CashDragInput,
  CashDragSettings,
  LiquidityReserve,
  SafeToInvest,
} from '../src/index.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');

function liquidityValue(cash: bigint, comfort: bigint): LiquidityReserve {
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    currentLiquidCash: createMoney(cash, EUR),
    operationalEssential: zero,
    operationalNormal: zero,
    ringFencedCash: zero,
    sinkingFundReservedCash: zero,
    otherRestrictedCash: zero,
    currentCycleSinkingDue: zero,
    uncoveredObligations: zero,
    minimumReserveTarget: createMoney(comfort / 2n, EUR),
    comfortReserveTarget: createMoney(comfort, EUR),
    variabilityBuffer: createMoney(10_000n, EUR),
    minimumCash: createMoney(comfort / 2n, EUR),
    comfortCash: createMoney(comfort, EUR),
    freeLiquidCash: createMoney(cash, EUR),
    currentExcessAboveComfort: createMoney(cash > comfort ? cash - comfort : 0n, EUR),
    operationalStartInclusive: EFFECTIVE_DATE,
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
}

function liquidityMetric(
  value: LiquidityReserve,
  status: 'complete' | 'partial' = 'complete',
): MetricResult<LiquidityReserve> {
  return createMetricResult({
    status,
    value,
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'liquidity',
    explanation: [],
    warnings: [],
  });
}

function safeMetric(
  liquidity: MetricResult<LiquidityReserve>,
  readiness: InvestabilityReadiness = { kind: 'complete' },
): MetricResult<SafeToInvest> {
  return calculateSafeToInvest({
    liquidity,
    readiness,
    settings: { recommendationIncrement: createMoney(1_000n, EUR) },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'safe',
  });
}

function settings(overrides: Partial<CashDragSettings> = {}): CashDragSettings {
  return {
    windowDays: 60,
    minimumCompleteDays: 54,
    minimumPositiveExcessDays: 45,
    absoluteExcessThreshold: createMoney(25_000n, EUR),
    relativeComfortThreshold: createExactFraction(1n, 10n),
    ...overrides,
  };
}

function observation(
  daysBefore: number,
  excess: bigint,
  options: Readonly<{
    comfort?: bigint;
    completeness?: 'complete' | 'partial' | 'unavailable';
  }> = {},
): CashDragDailyObservation {
  const comfort = options.comfort ?? 180_000n;
  return createCashDragDailyObservation({
    date: addLocalDays(EFFECTIVE_DATE, -daysBefore),
    liquidCash: createMoney(comfort + excess, EUR),
    comfortCash: createMoney(comfort, EUR),
    completeness: options.completeness ?? 'complete',
  });
}

function history(
  completePriorDays: number,
  positivePriorDays: number,
  positiveExcess = 100_000n,
  incompletePriorDays = 0,
): readonly CashDragDailyObservation[] {
  const result: CashDragDailyObservation[] = [];
  for (let day = 1; day <= completePriorDays; day += 1) {
    result.push(observation(day, day <= positivePriorDays ? positiveExcess : 0n));
  }
  for (let day = completePriorDays + 1; day <= completePriorDays + incompletePriorDays; day += 1) {
    result.push(observation(day, 9_000_000n, { completeness: 'partial' }));
  }
  return result;
}

function input(
  dailyObservations: readonly CashDragDailyObservation[],
  currentExcess = 100_000n,
  comfort = 180_000n,
  overrides: Partial<CashDragInput> = {},
): CashDragInput {
  const currentLiquidity = liquidityMetric(liquidityValue(comfort + currentExcess, comfort));
  return {
    dailyObservations,
    currentLiquidity,
    currentSafeToInvest: safeMetric(currentLiquidity),
    effectiveDate: EFFECTIVE_DATE,
    settings: settings(),
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'cash-drag',
    ...overrides,
  };
}

function value(result: ReturnType<typeof calculateCashDrag>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected Cash Drag assessment.');
  return result.value;
}

describe('Cash Drag', () => {
  it('detects persistent excess from 60 complete calendar days', () => {
    const result = calculateCashDrag(input(history(59, 59)));
    const assessment = value(result);

    expect(result.status).toBe('complete');
    expect(assessment.eligible).toBe(true);
    expect(assessment.windowStartInclusive).toBe('2026-07-17');
    expect(assessment.windowEndInclusive).toBe('2026-09-14');
    expect(assessment.completeDays).toBe(60);
    expect(assessment.positiveExcessDays).toBe(60);
    expect(assessment.averageExcess?.amountMinor).toBe(100_000n);
    expect(assessment.actionCap.amountMinor).toBe(100_000n);
    expect(result.explanation.find((item) => item.inputKey === 'completeDays')?.value).toBe('60');
  });

  it('accepts exactly 54 complete days but treats 53 as insufficient evidence', () => {
    const exact = calculateCashDrag(input(history(53, 53, 100_000n, 6)));
    const short = calculateCashDrag(input(history(52, 52, 100_000n, 7)));

    expect(exact.status).toBe('complete');
    expect(value(exact).eligible).toBe(true);
    expect(value(exact).completeDays).toBe(54);
    expect(short.status).toBe('partial');
    expect(value(short).eligible).toBe(false);
    expect(value(short).suppressionReasons).toContain('insufficient_complete_history');
  });

  it('uses an inclusive 44/45 positive-day boundary', () => {
    const fortyFour = value(calculateCashDrag(input(history(59, 43))));
    const fortyFive = value(calculateCashDrag(input(history(59, 44))));

    expect(fortyFour.positiveExcessDays).toBe(44);
    expect(fortyFour.eligible).toBe(false);
    expect(fortyFive.positiveExcessDays).toBe(45);
    expect(fortyFive.eligible).toBe(true);
  });

  it('returns a complete no-drag assessment when sufficient history disproves persistence', () => {
    const result = calculateCashDrag(input(history(59, 29)));

    expect(result.status).toBe('complete');
    expect(value(result).eligible).toBe(false);
    expect(value(result).suppressionReasons).toContain('insufficient_positive_excess_days');
  });

  it('requires average excess to be strictly above the effective threshold', () => {
    const equal = value(calculateCashDrag(input(history(59, 59, 25_000n), 25_000n)));
    const oneCentAbove = value(calculateCashDrag(input(history(59, 59, 25_001n), 25_001n)));

    expect(equal.averageExcess?.amountMinor).toBe(25_000n);
    expect(equal.eligible).toBe(false);
    expect(equal.suppressionReasons).toContain('average_excess_not_above_threshold');
    expect(oneCentAbove.averageExcess?.amountMinor).toBe(25_001n);
    expect(oneCentAbove.eligible).toBe(true);
  });

  it('selects the maximum of absolute and relative current-comfort thresholds', () => {
    const absolute = value(calculateCashDrag(input(history(59, 59), 100_000n, 180_000n)));
    const relative = value(calculateCashDrag(input(history(59, 59), 100_000n, 600_000n)));

    expect(absolute.relativeThreshold.amountMinor).toBe(18_000n);
    expect(absolute.effectiveThreshold.amountMinor).toBe(25_000n);
    expect(relative.relativeThreshold.amountMinor).toBe(60_000n);
    expect(relative.effectiveThreshold.amountMinor).toBe(60_000n);
  });

  it('suppresses historical abundance when current excess or current capacity is zero', () => {
    const assessment = value(calculateCashDrag(input(history(59, 59), 0n)));

    expect(assessment.eligible).toBe(false);
    expect(assessment.suppressionReasons).toContain('no_current_excess');
    expect(assessment.suppressionReasons).toContain('no_current_investable_capacity');
  });

  it('suppresses a positive current excess that rounds below the action increment', () => {
    const assessment = value(calculateCashDrag(input(history(59, 59), 500n)));

    expect(assessment.currentExcess.amountMinor).toBe(500n);
    expect(assessment.actionCap.amountMinor).toBe(0n);
    expect(assessment.suppressionReasons).not.toContain('no_current_excess');
    expect(assessment.suppressionReasons).toContain('no_current_investable_capacity');
    expect(assessment.eligible).toBe(false);
  });

  it('caps action at current rounded Recommended Safe to Invest', () => {
    const assessment = value(calculateCashDrag(input(history(59, 59, 170_000n), 60_000n)));

    expect(assessment.averageExcess!.amountMinor).toBeGreaterThan(assessment.actionCap.amountMinor);
    expect(assessment.actionCap.amountMinor).toBe(60_000n);
  });

  it('never promotes provisional Safe to Invest into an eligible signal', () => {
    const currentLiquidity = liquidityMetric(liquidityValue(280_000n, 180_000n));
    const currentSafeToInvest = safeMetric(currentLiquidity, {
      kind: 'provisional',
      reasons: ['non_material_cash_variance'],
    });
    const result = calculateCashDrag(
      input(history(59, 59), 100_000n, 180_000n, {
        currentLiquidity,
        currentSafeToInvest,
      }),
    );

    expect(result.status).toBe('partial');
    expect(value(result).eligible).toBe(false);
    expect(value(result).suppressionReasons).toContain('current_safe_to_invest_not_complete');
  });

  it('treats provisional current liquidity as incomplete current-day evidence', () => {
    const currentLiquidity = liquidityMetric(liquidityValue(280_000n, 180_000n), 'partial');
    const currentSafeToInvest = safeMetric(currentLiquidity, {
      kind: 'provisional',
      reasons: ['non_material_unresolved_transfer'],
    });
    const result = calculateCashDrag(
      input(history(59, 59), 100_000n, 180_000n, {
        currentLiquidity,
        currentSafeToInvest,
      }),
    );

    expect(result.status).toBe('partial');
    expect(value(result).completeDays).toBe(59);
    expect(value(result).incompleteDays).toBe(1);
    expect(value(result).suppressionReasons).toContain('current_liquidity_not_complete');
  });

  it('keeps average excess undefined when no complete day exists', () => {
    const currentLiquidity = liquidityMetric(liquidityValue(280_000n, 180_000n), 'partial');
    const currentSafeToInvest = safeMetric(currentLiquidity, {
      kind: 'provisional',
      reasons: ['non_material_cash_variance'],
    });
    const result = calculateCashDrag(
      input([], 100_000n, 180_000n, { currentLiquidity, currentSafeToInvest }),
    );

    expect(result.status).toBe('partial');
    expect(value(result).completeDays).toBe(0);
    expect(value(result).averageExcess).toBeNull();
  });

  it('is unavailable when current Safe to Invest is blocked', () => {
    const currentLiquidity = liquidityMetric(liquidityValue(280_000n, 180_000n));
    const currentSafeToInvest = safeMetric(currentLiquidity, {
      kind: 'blocked',
      reasons: ['material_unresolved_transfer'],
    });
    const result = calculateCashDrag(
      input(history(59, 59), 100_000n, 180_000n, {
        currentLiquidity,
        currentSafeToInvest,
      }),
    );

    expect(result).toMatchObject({ status: 'unavailable', value: null });
  });

  it('distinguishes incomplete observations from missing days and ignores their money', () => {
    const result = calculateCashDrag(input(history(20, 20, 100_000n, 10)));
    const assessment = value(result);

    expect(result.status).toBe('partial');
    expect(assessment.completeDays).toBe(21);
    expect(assessment.incompleteDays).toBe(10);
    expect(assessment.missingDays).toBe(29);
    expect(assessment.totalExcess.amountMinor).toBe(2_100_000n);
  });

  it("uses each historical day's comfort cash rather than today's threshold", () => {
    const observations = Array.from({ length: 59 }, (_, index) =>
      observation(index + 1, index < 30 ? 150_000n : 100_000n, {
        comfort: index < 30 ? 450_000n : 500_000n,
      }),
    );
    const assessment = value(calculateCashDrag(input(observations, 100_000n, 180_000n)));

    expect(assessment.totalExcess.amountMinor).toBe(30n * 150_000n + 30n * 100_000n);
    expect(assessment.averageExcess?.amountMinor).toBe(125_000n);
  });

  it('uses half-even monetary averaging at a half-cent boundary', () => {
    const result = calculateCashDrag(
      input([observation(1, 1n)], 0n, 100n, {
        settings: settings({
          windowDays: 2,
          minimumCompleteDays: 2,
          minimumPositiveExcessDays: 1,
          absoluteExcessThreshold: createMoney(0n, EUR),
          relativeComfortThreshold: createExactFraction(0n, 1n),
        }),
      }),
    );

    expect(value(result).averageExcess?.amountMinor).toBe(0n);
  });

  it('is independent of input order and ignores history older than the window', () => {
    const observations = [...history(59, 50), observation(70, 9_000_000n)];
    const forward = calculateCashDrag(input(observations));
    const reversed = calculateCashDrag(input(observations.reverse()));

    expect(reversed.value).toEqual(forward.value);
    expect(reversed.warnings).toEqual(forward.warnings);
  });

  it('preserves exact bigint values above Number.MAX_SAFE_INTEGER', () => {
    const comfort = 9_007_199_254_000_000n;
    const excess = 2_000_000_000_000_000n;
    const assessment = value(calculateCashDrag(input(history(59, 59, excess), excess, comfort)));

    expect(assessment.averageExcess?.amountMinor).toBe(excess);
    expect(assessment.relativeThreshold.amountMinor).toBe(900_719_925_400_000n);
  });

  it('rejects duplicate, future, and current-date historical observations', () => {
    expect(() => calculateCashDrag(input([observation(1, 1n), observation(1, 2n)]))).toThrow(
      'dates must be unique',
    );
    expect(() => calculateCashDrag(input([observation(-1, 1n)]))).toThrow(
      'cannot contain a future observation',
    );
    expect(() => calculateCashDrag(input([observation(0, 1n)]))).toThrow(
      'Current liquidity is authoritative',
    );
  });

  it('rejects invalid detector settings', () => {
    expect(() =>
      calculateCashDrag(
        input(history(59, 59), 100_000n, 180_000n, {
          settings: settings({ minimumPositiveExcessDays: 55, minimumCompleteDays: 54 }),
        }),
      ),
    ).toThrow('settings violate the accepted Stage 2E policy');
  });

  it('rejects non-EUR historical observations at the engine boundary', () => {
    const usd = parseCurrencyCode('USD');
    const daily = createCashDragDailyObservation({
      date: addLocalDays(EFFECTIVE_DATE, -1),
      liquidCash: createMoney(500_000n, usd),
      comfortCash: createMoney(400_000n, usd),
      completeness: 'complete',
    });

    expect(() => calculateCashDrag(input([daily]))).toThrow('daily observations must use EUR');
  });
});
