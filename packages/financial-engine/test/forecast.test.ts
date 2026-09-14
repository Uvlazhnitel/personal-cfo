import { describe, expect, it } from 'vitest';

import {
  EUR,
  createMetricResult,
  createMoney,
  parseDecimalRate,
  parseForecastCapitalFlowId,
  parseForecastPlannedExpenseId,
  parseInstant,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { MetricResult, Money } from '@personal-cfo/domain';

import {
  DEFAULT_FORECAST_SETTINGS,
  FinancialEngineInvariantError,
  calculateFinancialForecast,
} from '../src/index.js';
import type { FinancialForecastInput } from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-09-14T08:00:00Z');

function metric(value: bigint, status: 'complete' | 'partial' = 'complete'): MetricResult<Money> {
  return createMetricResult({
    status,
    value: createMoney(value, EUR),
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'forecast-fixture',
    explanation: [],
    warnings: status === 'partial' ? [{ code: 'fixture.stale', context: {} }] : [],
  });
}

function input(overrides: Partial<FinancialForecastInput> = {}): FinancialForecastInput {
  return {
    startingCash: metric(1_000_000n),
    startingInvestment: metric(2_000_000n),
    forecastStartMonth: parseYearMonth('2026-10'),
    capitalFlows: [],
    plannedExpenses: [],
    includedOptionalExpenseIds: [],
    settings: DEFAULT_FORECAST_SETTINGS,
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'forecast-fixture',
    ...overrides,
  };
}

function scenario(result: ReturnType<typeof calculateFinancialForecast>, rate: string) {
  const value = result.value?.scenarios.find((item) => item.assumption.annualReturnRate === rate);
  if (value === undefined) throw new Error(`Missing ${rate} scenario.`);
  return value;
}

describe('financial forecast', () => {
  it('reconciles the 12-month contributions-only golden example exactly', () => {
    const flows = Array.from({ length: 12 }, (_, index) => ({
      id: parseForecastCapitalFlowId(uuid(index + 1)),
      month: parseYearMonth(
        `${2026 + Math.floor((9 + index) / 12)}-${(((9 + index) % 12) + 1)
          .toString()
          .padStart(2, '0')}`,
      ),
      cashChange: createMoney(0n, EUR),
      investmentChange: createMoney(10_000n, EUR),
    }));
    const result = calculateFinancialForecast(input({ capitalFlows: flows }));
    const zero = scenario(result, '0').horizons[0]!.value!;
    expect(result.status).toBe('complete');
    expect(zero.closingCash.amountMinor).toBe(1_000_000n);
    expect(zero.closingInvestment.amountMinor).toBe(2_120_000n);
    expect(zero.cumulativeModeledReturn.amountMinor).toBe(0n);
    expect(zero.cumulativeInvestmentChange.amountMinor).toBe(120_000n);
    expect(zero.closingTotalCapital.amountMinor).toBe(3_120_000n);
  });

  it('applies return before the end-month contribution', () => {
    const base = calculateFinancialForecast(
      input({
        startingCash: metric(0n),
        startingInvestment: metric(1_000_000n),
        capitalFlows: [
          {
            id: parseForecastCapitalFlowId(uuid(20)),
            month: parseYearMonth('2026-10'),
            cashChange: createMoney(0n, EUR),
            investmentChange: createMoney(100_000n, EUR),
          },
        ],
      }),
    );
    const first = scenario(base, '0.05').monthlyPath[0]!.value!;
    expect(first.closingInvestment.amountMinor).toBe(
      first.openingInvestment.amountMinor +
        first.modeledReturn.amountMinor +
        first.investmentChange.amountMinor,
    );
    const withoutContribution = calculateFinancialForecast(
      input({ startingCash: metric(0n), startingInvestment: metric(1_000_000n) }),
    );
    expect(first.modeledReturn).toEqual(
      scenario(withoutContribution, '0.05').monthlyPath[0]!.value!.modeledReturn,
    );
  });

  it('uses the upper range once and never auto-liquidates investments', () => {
    const expenseId = parseForecastPlannedExpenseId(uuid(30));
    const result = calculateFinancialForecast(
      input({
        startingCash: metric(50_000n),
        startingInvestment: metric(1_000_000n),
        plannedExpenses: [
          {
            id: expenseId,
            dueMonth: parseYearMonth('2027-01'),
            amount: {
              kind: 'range',
              lower: createMoney(70_000n, EUR),
              upper: createMoney(90_000n, EUR),
            },
            priority: 'mandatory',
            committed: true,
          },
        ],
      }),
    );
    const path = scenario(result, '0').monthlyPath;
    expect(path[3]!.value?.plannedExpenses.amountMinor).toBe(90_000n);
    expect(path[3]!.value?.closingCash.amountMinor).toBe(-40_000n);
    expect(path[3]!.value?.closingInvestment.amountMinor).toBe(1_000_000n);
    expect(path[4]!.value?.plannedExpenses.amountMinor).toBe(0n);
  });

  it('reports exact 12/36/60/120 boundaries and independent ordered rate scenarios', () => {
    const result = calculateFinancialForecast(input());
    for (const item of result.value!.scenarios) {
      expect(item.horizons.map((horizon) => horizon.months)).toEqual([12, 36, 60, 120]);
      expect(item.horizons.map((horizon) => horizon.value?.monthNumber)).toEqual([12, 36, 60, 120]);
    }
    const endings = ['0', '0.03', '0.05', '0.07'].map(
      (rate) => scenario(result, rate).horizons[3]!.value!.closingInvestment.amountMinor,
    );
    expect(endings[3]).toBeGreaterThanOrEqual(endings[2]!);
    expect(endings[2]).toBeGreaterThanOrEqual(endings[1]!);
    expect(endings[1]).toBeGreaterThanOrEqual(endings[0]!);
  });

  it('keeps real values exact at zero inflation and below nominal at positive inflation', () => {
    const positive = calculateFinancialForecast(input());
    const positiveEnd = scenario(positive, '0.05').horizons[3]!.value!;
    expect(positiveEnd.realClosingTotalCapital!.amountMinor).toBeLessThanOrEqual(
      positiveEnd.closingTotalCapital.amountMinor,
    );
    const zeroInflation = calculateFinancialForecast(
      input({
        settings: {
          ...DEFAULT_FORECAST_SETTINGS,
          annualInflationRate: parseDecimalRate('0'),
        },
      }),
    );
    const zeroEnd = scenario(zeroInflation, '0.05').horizons[3]!.value!;
    expect(zeroEnd.realClosingTotalCapital).toEqual(zeroEnd.closingTotalCapital);
  });

  it('limits an unknown required expense to its due and later horizons', () => {
    const result = calculateFinancialForecast(
      input({
        plannedExpenses: [
          {
            id: parseForecastPlannedExpenseId(uuid(40)),
            dueMonth: parseYearMonth('2030-10'),
            amount: { kind: 'unknown', currency: EUR },
            priority: 'mandatory',
            committed: true,
          },
        ],
      }),
    );
    expect(result.status).toBe('partial');
    expect(scenario(result, '0').horizons.map((item) => item.status)).toEqual([
      'complete',
      'complete',
      'unavailable',
      'unavailable',
    ]);
  });

  it('propagates stale starts, rejects impossible withdrawals, and supports large bigint', () => {
    expect(
      calculateFinancialForecast(input({ startingInvestment: metric(2_000_000n, 'partial') }))
        .status,
    ).toBe('partial');
    expect(() =>
      calculateFinancialForecast(
        input({
          startingInvestment: metric(10_000n),
          capitalFlows: [
            {
              id: parseForecastCapitalFlowId(uuid(50)),
              month: parseYearMonth('2026-10'),
              cashChange: createMoney(0n, EUR),
              investmentChange: createMoney(-20_000n, EUR),
            },
          ],
        }),
      ),
    ).toThrowError(FinancialEngineInvariantError);
    const large = 9_007_199_254_740_993n;
    const result = calculateFinancialForecast(
      input({ startingCash: metric(large), startingInvestment: metric(large) }),
    );
    expect(scenario(result, '0').horizons[0]!.value?.closingTotalCapital.amountMinor).toBe(
      large * 2n,
    );
  });

  it('is deterministic and invariant to unordered flow/expense input', () => {
    const flowA = {
      id: parseForecastCapitalFlowId(uuid(60)),
      month: parseYearMonth('2026-10'),
      cashChange: createMoney(1_000n, EUR),
      investmentChange: createMoney(2_000n, EUR),
    };
    const flowB = {
      ...flowA,
      id: parseForecastCapitalFlowId(uuid(61)),
      month: parseYearMonth('2026-11'),
    };
    const first = calculateFinancialForecast(input({ capitalFlows: [flowA, flowB] }));
    const second = calculateFinancialForecast(input({ capitalFlows: [flowB, flowA] }));
    expect(second).toEqual(first);
    expect(calculateFinancialForecast(input({ capitalFlows: [flowA, flowB] }))).toEqual(first);
  });
});
