import { describe, expect, it } from 'vitest';

import {
  EUR,
  createExactFraction,
  createFutureObligation,
  createMetricResult,
  createMoney,
  createOperationalNeed,
  createRestrictedCash,
  parseFutureObligationId,
  parseInstant,
  parseLocalDate,
  parseOperationalNeedId,
  parseRestrictedCashId,
  parseScheduledSpendingId,
  parseSinkingFundId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type {
  Completeness,
  FutureObligation,
  MetricResult,
  Money,
  OperationalNeed,
} from '@personal-cfo/domain';

import { calculateLiquidityReserve } from '../src/index.js';
import type {
  CurrentCycleSinkingDue,
  LiquidityReserveInput,
  SpendingBaseline,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed.toString(16).padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-02-01T00:00:00Z');

function metric<T>(value: T, status: 'complete' | 'partial' = 'complete'): MetricResult<T> {
  return createMetricResult({
    status,
    value,
    asOf: AS_OF,
    engineVersion: '2d.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'upstream',
    explanation: [],
    warnings: [],
  });
}

function baseline(overrides: Partial<SpendingBaseline> = {}): SpendingBaseline {
  return Object.freeze({
    normalBaseline: createMoney(15_000n, EUR),
    essentialBaseline: createMoney(10_000n, EUR),
    recurringNormal: createMoney(5_000n, EUR),
    recurringEssential: createMoney(4_000n, EUR),
    variableNormal: createMoney(10_000n, EUR),
    variableEssential: createMoney(6_000n, EUR),
    variabilityBuffer: createMoney(2_000n, EUR),
    excludedIrregular: createMoney(0n, EUR),
    excludedFundedConsumption: createMoney(0n, EUR),
    excludedReversalExcess: createMoney(0n, EUR),
    eligibleCompleteMonths: 6,
    historicalWindowUsed: [parseYearMonth('2025-08')],
    seasonalAdjustment: null,
    source: 'historical',
    ...overrides,
  });
}

function sinking(reserved = 3_000n, due = 2_000n): CurrentCycleSinkingDue {
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    byFund: Object.freeze([
      Object.freeze({
        fundId: parseSinkingFundId(uuid(10)),
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
    ]),
    totalRequired: createMoney(due, EUR),
    totalSatisfied: zero,
    totalOutstanding: createMoney(due, EUR),
    totalReserved: createMoney(reserved, EUR),
    totalProtected: createMoney(reserved + due, EUR),
  });
}

function cash(amount: bigint): MetricResult<Money> {
  return metric(createMoney(amount, EUR));
}

function input(overrides: Partial<LiquidityReserveInput> = {}): LiquidityReserveInput {
  return {
    baseline: metric(baseline()),
    sinkingProtection: metric(sinking()),
    currentLiquidCash: cash(100_000n),
    operationalNeeds: [],
    futureObligations: [],
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
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
    ...overrides,
  };
}

function value(result: ReturnType<typeof calculateLiquidityReserve>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected liquidity reserve.');
  return result.value;
}

function need(
  seed: number,
  amount: bigint,
  overrides: Partial<OperationalNeed> = {},
): OperationalNeed {
  return createOperationalNeed({
    id: parseOperationalNeedId(uuid(seed)),
    dueDate: parseLocalDate('2026-02-10'),
    amount: createMoney(amount, EUR),
    necessity: 'essential',
    direction: 'debit',
    state: 'pending',
    scheduledSpendingId: null,
    ...overrides,
  });
}

function obligation(
  seed: number,
  amount: bigint,
  overrides: Partial<FutureObligation> = {},
): FutureObligation {
  return createFutureObligation({
    id: parseFutureObligationId(uuid(seed)),
    dueDate: parseLocalDate('2026-02-20'),
    amount: { kind: 'exact', amount: createMoney(amount, EUR) },
    priority: 'mandatory',
    committed: true,
    status: 'open',
    coverage: { kind: 'uncovered' },
    ...overrides,
  });
}

describe('liquidity reserve', () => {
  it('calculates exact minimum, comfort, free cash, and current excess', () => {
    const result = calculateLiquidityReserve(
      input({
        operationalNeeds: [need(20, 1_000n)],
        futureObligations: [obligation(30, 5_000n)],
        otherRestrictedCash: [
          createRestrictedCash({
            id: parseRestrictedCashId(uuid(40)),
            amount: createMoney(1_000n, EUR),
          }),
        ],
      }),
    );
    const reserve = value(result);

    expect(result.status).toBe('complete');
    expect(reserve.operationalEssential.amountMinor).toBe(7_000n);
    expect(reserve.operationalNormal.amountMinor).toBe(11_000n);
    expect(reserve.ringFencedCash.amountMinor).toBe(4_000n);
    expect(reserve.minimumCash.amountMinor).toBe(21_000n);
    expect(reserve.comfortCash.amountMinor).toBe(58_000n);
    expect(reserve.freeLiquidCash.amountMinor).toBe(96_000n);
    expect(reserve.currentExcessAboveComfort.amountMinor).toBe(42_000n);
  });

  it('uses operational need instead of adding it to an already larger reserve target', () => {
    const reserve = value(
      calculateLiquidityReserve(input({ operationalNeeds: [need(20, 20_000n)] })),
    );
    expect(reserve.minimumReserveTarget.amountMinor).toBe(10_000n);
    expect(reserve.operationalEssential.amountMinor).toBe(26_000n);
    expect(reserve.minimumCash.amountMinor).toBe(31_000n);
  });

  it('ignores pending credits and booked debits and counts a linked pending schedule once', () => {
    const scheduleId = parseScheduledSpendingId(uuid(50));
    const reserve = value(
      calculateLiquidityReserve(
        input({
          operationalNeeds: [
            need(51, 5_000n, { direction: 'credit' }),
            need(52, 5_000n, { state: 'booked' }),
            need(53, 4_000n, { state: 'scheduled', scheduledSpendingId: scheduleId }),
            need(54, 4_500n, { state: 'pending', scheduledSpendingId: scheduleId }),
          ],
        }),
      ),
    );
    expect(reserve.operationalEssential.amountMinor).toBe(10_500n);
  });

  it('uses obligation upper bounds and excludes optional uncommitted obligations', () => {
    const ranged = obligation(60, 1n, {
      amount: { kind: 'range', lower: createMoney(4_000n, EUR), upper: createMoney(5_500n, EUR) },
    });
    const optional = obligation(61, 9_000n, { priority: 'optional', committed: false });
    const reserve = value(
      calculateLiquidityReserve(input({ futureObligations: [ranged, optional] })),
    );
    expect(reserve.uncoveredObligations.amountMinor).toBe(5_500n);
  });

  it('includes committed optional obligations and floors current excess at zero', () => {
    const optional = obligation(62, 9_000n, { priority: 'optional', committed: true });
    const reserve = value(
      calculateLiquidityReserve(
        input({
          futureObligations: [optional],
          currentLiquidCash: cash(10_000n),
          sinkingProtection: metric(sinking(0n, 0n)),
        }),
      ),
    );
    expect(reserve.uncoveredObligations.amountMinor).toBe(9_000n);
    expect(reserve.currentExcessAboveComfort.amountMinor).toBe(0n);
  });

  it('does not duplicate Sinking-covered or operational-covered obligations', () => {
    const operational = need(70, 2_000n);
    const obligations = [
      obligation(71, 50_000n, {
        coverage: { kind: 'sinking_fund', fundId: parseSinkingFundId(uuid(10)) },
      }),
      obligation(72, 2_000n, {
        coverage: { kind: 'operational', operationalNeedId: operational.id },
      }),
    ];
    const reserve = value(
      calculateLiquidityReserve(
        input({ operationalNeeds: [operational], futureObligations: obligations }),
      ),
    );
    expect(reserve.uncoveredObligations.amountMinor).toBe(0n);
  });

  it('preserves both thresholds when protected due is allocated into reserve', () => {
    const before = value(
      calculateLiquidityReserve(input({ sinkingProtection: metric(sinking(3_000n, 2_000n)) })),
    );
    const after = value(
      calculateLiquidityReserve(input({ sinkingProtection: metric(sinking(4_000n, 1_000n)) })),
    );
    expect(after.minimumCash).toEqual(before.minimumCash);
    expect(after.comfortCash).toEqual(before.comfortCash);
  });

  it('uses a 31-day horizon and partial result when income date is unknown', () => {
    const result = calculateLiquidityReserve(input({ nextReliableIncomeDate: null }));
    const reserve = value(result);
    expect(result.status).toBe('partial');
    expect(reserve.operationalEndExclusive).toBe('2026-03-04');
    expect(result.warnings.some((item) => item.code === 'liquidity.unknown_next_income')).toBe(
      true,
    );
  });

  it('propagates partial and unavailable upstream completeness', () => {
    expect(
      calculateLiquidityReserve(input({ baseline: metric(baseline(), 'partial') })).status,
    ).toBe('partial');
    const unavailable = createMetricResult<SpendingBaseline>({
      status: 'unavailable',
      value: null,
      asOf: AS_OF,
      engineVersion: '2d.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'x',
      explanation: [],
      warnings: [],
    });
    expect(calculateLiquidityReserve(input({ baseline: unavailable })).status).toBe('unavailable');
  });

  it.each<[Completeness, 'complete' | 'partial' | 'unavailable']>([
    ['complete', 'complete'],
    ['partial', 'partial'],
    ['unavailable', 'unavailable'],
  ])('propagates obligation completeness %s', (obligations, expected) => {
    expect(
      calculateLiquidityReserve(
        input({
          inputCompleteness: {
            operationalNeeds: 'complete',
            obligations,
            restrictedCash: 'complete',
          },
        }),
      ).status,
    ).toBe(expected);
  });
});
