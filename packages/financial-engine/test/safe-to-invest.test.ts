import { describe, expect, it } from 'vitest';

import {
  EUR,
  createExactFraction,
  createMetricResult,
  createMoney,
  createOperationalNeed,
  parseInstant,
  parseLocalDate,
  parseOperationalNeedId,
  parseSinkingFundId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { MetricResult, Money } from '@personal-cfo/domain';

import { calculateLiquidityReserve, calculateSafeToInvest } from '../src/index.js';
import type {
  CurrentCycleSinkingDue,
  LiquidityReserve,
  LiquidityReserveInput,
  SafeToInvestInput,
  SpendingBaseline,
} from '../src/index.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');

function metric<T>(value: T, status: 'complete' | 'partial' = 'complete'): MetricResult<T> {
  return createMetricResult({
    status,
    value,
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'upstream',
    explanation: [],
    warnings: [],
  });
}

function liquidity(
  cash: bigint,
  minimum: bigint,
  comfort: bigint,
  variability: bigint,
): LiquidityReserve {
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
    minimumReserveTarget: createMoney(minimum, EUR),
    comfortReserveTarget: createMoney(comfort, EUR),
    variabilityBuffer: createMoney(variability, EUR),
    minimumCash: createMoney(minimum, EUR),
    comfortCash: createMoney(comfort, EUR),
    freeLiquidCash: createMoney(cash, EUR),
    currentExcessAboveComfort: createMoney(cash > comfort ? cash - comfort : 0n, EUR),
    operationalStartInclusive: EFFECTIVE_DATE,
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
}

function input(
  reserve: MetricResult<LiquidityReserve>,
  overrides: Partial<SafeToInvestInput> = {},
): SafeToInvestInput {
  return {
    liquidity: reserve,
    readiness: { kind: 'complete' },
    settings: { recommendationIncrement: createMoney(1_000n, EUR) },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'safe-watermark',
    ...overrides,
  };
}

function resultValue(result: ReturnType<typeof calculateSafeToInvest>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected Safe to Invest value.');
  return result.value;
}

function baseline(): SpendingBaseline {
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    normalBaseline: createMoney(15_000n, EUR),
    essentialBaseline: createMoney(10_000n, EUR),
    recurringNormal: zero,
    recurringEssential: zero,
    variableNormal: createMoney(15_000n, EUR),
    variableEssential: createMoney(10_000n, EUR),
    variabilityBuffer: createMoney(2_000n, EUR),
    excludedIrregular: zero,
    excludedFundedConsumption: zero,
    excludedReversalExcess: zero,
    eligibleCompleteMonths: 6,
    historicalWindowUsed: [parseYearMonth('2026-08')],
    seasonalAdjustment: null,
    source: 'historical',
  });
}

function sinking(reserved: bigint, due: bigint): CurrentCycleSinkingDue {
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    byFund: [
      Object.freeze({
        fundId: parseSinkingFundId('01890f3e-7b2c-7001-8abc-000000000001'),
        state: 'funding',
        required: createMoney(due, EUR),
        satisfied: zero,
        outstanding: createMoney(due, EUR),
        reserved: createMoney(reserved, EUR),
        fundedConsumption: zero,
        fulfilled: createMoney(reserved, EUR),
        remaining: createMoney(due, EUR),
        excess: zero,
        protected: createMoney(reserved + due, EUR),
      }),
    ],
    totalRequired: createMoney(due, EUR),
    totalSatisfied: zero,
    totalOutstanding: createMoney(due, EUR),
    totalReserved: createMoney(reserved, EUR),
    totalProtected: createMoney(reserved + due, EUR),
  });
}

function stage2dLiquidity(
  reserved: bigint,
  due: bigint,
  operationalNeeds: LiquidityReserveInput['operationalNeeds'] = [],
) {
  const cash: Money = createMoney(100_000n, EUR);
  return calculateLiquidityReserve({
    baseline: metric(baseline()),
    sinkingProtection: metric(sinking(reserved, due)),
    currentLiquidCash: metric(cash),
    operationalNeeds,
    futureObligations: [],
    otherRestrictedCash: [],
    inputCompleteness: {
      operationalNeeds: 'complete',
      obligations: 'complete',
      restrictedCash: 'complete',
    },
    nextReliableIncomeDate: parseLocalDate('2026-10-01'),
    effectiveDate: EFFECTIVE_DATE,
    settings: {
      minimumReserveMonths: createExactFraction(1n, 1n),
      comfortReserveMonths: createExactFraction(3n, 1n),
      unknownIncomeHorizonDays: 31,
      obligationHorizonDays: 90,
    },
    asOf: AS_OF,
    engineVersion: '2e.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'liquidity-watermark',
  });
}

describe('Safe to Invest', () => {
  it('matches the authoritative €7,200 worked example without subtracting components twice', () => {
    const result = calculateSafeToInvest(
      input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n))),
    );
    const value = resultValue(result);

    expect(result.status).toBe('complete');
    expect(value.unroundedConservative.amountMinor).toBe(170_000n);
    expect(value.unroundedRecommended.amountMinor).toBe(190_000n);
    expect(value.unroundedMaximum.amountMinor).toBe(250_000n);
    expect(value.conservative.amountMinor).toBe(170_000n);
    expect(value.recommended.amountMinor).toBe(190_000n);
    expect(value.maximum.amountMinor).toBe(250_000n);
    expect(result.explanation.find((item) => item.inputKey === 'unroundedRecommended')?.value).toBe(
      '190000',
    );
  });

  it('calculates first and then rounds every tier downward independently', () => {
    const value = resultValue(
      calculateSafeToInvest(input(metric(liquidity(724_387n, 450_000n, 500_000n, 20_000n)))),
    );

    expect(value.unroundedConservative.amountMinor).toBe(204_387n);
    expect(value.unroundedRecommended.amountMinor).toBe(224_387n);
    expect(value.unroundedMaximum.amountMinor).toBe(274_387n);
    expect(value.conservative.amountMinor).toBe(204_000n);
    expect(value.recommended.amountMinor).toBe(224_000n);
    expect(value.maximum.amountMinor).toBe(274_000n);
    expect(value.recommendedRoundingLoss.amountMinor).toBe(387n);
  });

  it('preserves the extra-buffer difference before flooring', () => {
    const above = resultValue(
      calculateSafeToInvest(input(metric(liquidity(600_000n, 450_000n, 500_000n, 20_000n)))),
    );
    const below = resultValue(
      calculateSafeToInvest(input(metric(liquidity(510_000n, 450_000n, 500_000n, 20_000n)))),
    );

    expect(above.unroundedRecommended.amountMinor - above.unroundedConservative.amountMinor).toBe(
      20_000n,
    );
    expect(below.unroundedRecommended.amountMinor).toBe(10_000n);
    expect(below.unroundedConservative.amountMinor).toBe(0n);
  });

  it('returns a complete zero rather than unavailable when no surplus exists', () => {
    const result = calculateSafeToInvest(
      input(metric(liquidity(400_000n, 450_000n, 500_000n, 20_000n))),
    );
    const value = resultValue(result);

    expect(result.status).toBe('complete');
    expect(
      [value.conservative, value.recommended, value.maximum].map((item) => item.amountMinor),
    ).toEqual([0n, 0n, 0n]);
  });

  it('exposes only explicitly approved ambiguity as a partial numeric result', () => {
    const reserve = metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n), 'partial');
    const result = calculateSafeToInvest(
      input(reserve, {
        readiness: {
          kind: 'provisional',
          reasons: ['non_material_unresolved_transfer'],
        },
      }),
    );

    expect(result.status).toBe('partial');
    expect(result.value?.recommended.amountMinor).toBe(190_000n);
    expect(result.warnings.some((item) => item.code === 'safe_to_invest.provisional')).toBe(true);
  });

  it('blocks material ambiguity and unavailable liquidity without returning zero', () => {
    const reserve = metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n));
    const blocked = calculateSafeToInvest(
      input(reserve, {
        readiness: { kind: 'blocked', reasons: ['material_cash_variance'] },
      }),
    );
    const unavailable = createMetricResult<LiquidityReserve>({
      status: 'unavailable',
      value: null,
      asOf: AS_OF,
      engineVersion: '2e.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'upstream',
      explanation: [],
      warnings: [],
    });

    expect(blocked).toMatchObject({ status: 'unavailable', value: null });
    expect(calculateSafeToInvest(input(unavailable))).toMatchObject({
      status: 'unavailable',
      value: null,
    });
  });

  it.each([
    'material_unresolved_transfer',
    'material_cash_variance',
    'incomplete_liquid_balance',
    'incomplete_spending_baseline',
    'incomplete_obligations',
    'incomplete_sinking_protection',
    'unknown_next_reliable_income',
    'other_material_incompleteness',
  ] as const)('blocks investability reason %s', (reason) => {
    const result = calculateSafeToInvest(
      input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n)), {
        readiness: { kind: 'blocked', reasons: [reason] },
      }),
    );
    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
  });

  it('rejects partial liquidity that was not explicitly classified', () => {
    expect(() =>
      calculateSafeToInvest(
        input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n), 'partial')),
      ),
    ).toThrow('Partial liquidity requires explicit provisional or blocked readiness.');
  });

  it('reflects a cash reconciliation only through the changed current cash', () => {
    const before = resultValue(
      calculateSafeToInvest(input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n)))),
    );
    const after = resultValue(
      calculateSafeToInvest(input(metric(liquidity(718_500n, 470_000n, 530_000n, 20_000n)))),
    );

    expect(before.unroundedRecommended.amountMinor - after.unroundedRecommended.amountMinor).toBe(
      1_500n,
    );
  });

  it('keeps all tiers unchanged when current Sinking due becomes reserved one-for-one', () => {
    const before = calculateSafeToInvest(input(stage2dLiquidity(3_000n, 2_000n)));
    const after = calculateSafeToInvest(input(stage2dLiquidity(4_000n, 1_000n)));

    expect(after.value).toEqual(before.value);
  });

  it('does not let a pending credit increase investable cash', () => {
    const credit = createOperationalNeed({
      id: parseOperationalNeedId('01890f3e-7b2c-7002-8abc-000000000002'),
      dueDate: parseLocalDate('2026-09-20'),
      amount: createMoney(50_000n, EUR),
      necessity: 'essential',
      direction: 'credit',
      state: 'pending',
      scheduledSpendingId: null,
    });
    const withoutCredit = calculateSafeToInvest(input(stage2dLiquidity(3_000n, 2_000n)));
    const withCredit = calculateSafeToInvest(input(stage2dLiquidity(3_000n, 2_000n, [credit])));

    expect(withCredit.value).toEqual(withoutCredit.value);
  });

  it('rejects invalid increments and impossible liquidity ordering', () => {
    expect(() =>
      calculateSafeToInvest(
        input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n)), {
          settings: { recommendationIncrement: createMoney(0n, EUR) },
        }),
      ),
    ).toThrow('recommendation increment must be positive');
    expect(() =>
      calculateSafeToInvest(input(metric(liquidity(720_000n, 540_000n, 530_000n, 20_000n)))),
    ).toThrow('Minimum cash cannot exceed comfort cash');
  });

  it('rejects invalid liquidity values, excess reconciliation, and upstream metadata', () => {
    expect(() => calculateSafeToInvest(input(metric(liquidity(-1n, 0n, 0n, 0n))))).toThrow(
      'non-negative EUR liquidity',
    );

    const invalidExcess = {
      ...liquidity(720_000n, 470_000n, 530_000n, 20_000n),
      currentExcessAboveComfort: createMoney(0n, EUR),
    };
    expect(() => calculateSafeToInvest(input(metric(invalidExcess)))).toThrow(
      'Current excess must reconcile',
    );

    expect(() =>
      calculateSafeToInvest(
        input(metric(liquidity(720_000n, 470_000n, 530_000n, 20_000n)), {
          settingsVersion: 'settings-2',
        }),
      ),
    ).toThrow('must share the Safe to Invest as-of and settings version');
  });

  it('rejects a runtime-mutable upstream value that violates tier ordering after validation', () => {
    const stable = liquidity(600_000n, 450_000n, 500_000n, 20_000n);
    const adversarial = { ...stable };
    let minimumReads = 0;
    Object.defineProperty(adversarial, 'minimumCash', {
      enumerable: true,
      get() {
        minimumReads += 1;
        return createMoney(minimumReads < 3 ? 450_000n : 550_000n, EUR);
      },
    });

    expect(() => calculateSafeToInvest(input(metric(adversarial)))).toThrow(
      'tiers must be ordered',
    );
  });
});
