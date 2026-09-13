import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  EUR,
  createCalendarMonthCoverage,
  createEconomicFlow,
  createExactFraction,
  createMetricResult,
  createMoney,
  createScheduledSpending,
  createSpendingObservation,
  parseEconomicFlowId,
  parseInstant,
  parseLocalDate,
  parseScheduledSpendingId,
  parseSpendingCategoryId,
  parseTransactionId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { EconomicFlow, SpendingObservation } from '@personal-cfo/domain';

import { calculateSpendingBaseline } from '../src/index.js';
import type {
  FundedConsumptionCoverage,
  SpendingBaselineInput,
  SpendingBaselineSettings,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed.toString(16).padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-07-01T00:00:00Z');

function coverageResult(
  byTransaction: readonly Readonly<{
    transactionId: ReturnType<typeof parseTransactionId>;
    amount: ReturnType<typeof createMoney>;
  }>[] = [],
) {
  return createMetricResult<FundedConsumptionCoverage>({
    status: 'complete',
    value: Object.freeze({
      byTransaction: Object.freeze([...byTransaction]),
      total: createMoney(
        byTransaction.reduce((sum, item) => sum + item.amount.amountMinor, 0n),
        EUR,
      ),
    }),
    asOf: AS_OF,
    engineVersion: '2d.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'reservation-watermark',
    explanation: [],
    warnings: [],
  });
}

function settings(overrides: Partial<SpendingBaselineSettings> = {}): SpendingBaselineSettings {
  return {
    baselineWindowMonths: 6,
    minimumCompleteMonths: 3,
    maximumBaselineLookbackMonths: 36,
    materialityThreshold: createMoney(5_000n, EUR),
    variabilityPercentile: createExactFraction(4n, 5n),
    seasonalityMinimumMonths: 24,
    seasonalityCap: createExactFraction(1n, 5n),
    fallbackNormalBaseline: createMoney(150_000n, EUR),
    fallbackEssentialBaseline: createMoney(100_000n, EUR),
    ...overrides,
  };
}

function consumption(
  seed: number,
  date: string,
  amount: bigint,
  options: Partial<Pick<SpendingObservation, 'necessity' | 'cadence' | 'irregular'>> &
    Readonly<{ reimbursable?: boolean }> = {},
) {
  const transactionId = parseTransactionId(uuid(seed));
  const flow = createEconomicFlow({
    id: parseEconomicFlowId(uuid(seed + 1000)),
    transactionId,
    effectiveAt: parseInstant(`${date}T12:00:00Z`),
    amount: createMoney(amount, EUR),
    kind: 'consumption',
    reimbursable: options.reimbursable ?? false,
  });
  const observation = createSpendingObservation({
    economicFlowId: flow.id,
    economicDate: parseLocalDate(date),
    categoryId: parseSpendingCategoryId(uuid(options.cadence === 'recurring' ? 901 : 900)),
    necessity: options.necessity ?? 'essential',
    cadence: options.cadence ?? 'variable',
    irregular: options.irregular ?? false,
  });
  return { flow, observation };
}

function completeMonths(months: readonly string[]) {
  return months.map((month) =>
    createCalendarMonthCoverage({
      month: parseYearMonth(month),
      reconciled: true,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    }),
  );
}

function input(
  flows: readonly EconomicFlow[],
  observations: readonly SpendingObservation[],
  overrides: Partial<SpendingBaselineInput> = {},
): SpendingBaselineInput {
  return {
    economicFlows: flows,
    observations,
    monthCoverage: completeMonths([
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
    ]),
    scheduledRecurring: [
      createScheduledSpending({
        id: parseScheduledSpendingId(uuid(800)),
        dueDate: parseLocalDate('2026-07-05'),
        amount: createMoney(5_000n, EUR),
        necessity: 'essential',
      }),
    ],
    recurringScheduleComplete: true,
    fundedConsumptionCoverage: coverageResult(),
    targetMonth: parseYearMonth('2026-07'),
    settings: settings(),
    asOf: AS_OF,
    engineVersion: '2d.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
    ...overrides,
  };
}

function value(result: ReturnType<typeof calculateSpendingBaseline>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected baseline.');
  return result.value;
}

describe('spending baseline', () => {
  it('combines next-period recurring with robust normal and essential variable spending', () => {
    const items = [
      '2026-01-10',
      '2026-02-10',
      '2026-03-10',
      '2026-04-10',
      '2026-05-10',
      '2026-06-10',
    ].map((date, index) => consumption(10 + index, date, 10_000n));
    const result = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
      ),
    );
    const baseline = value(result);

    expect(result.status).toBe('complete');
    expect(baseline.variableNormal.amountMinor).toBe(10_000n);
    expect(baseline.variableEssential.amountMinor).toBe(10_000n);
    expect(baseline.recurringNormal.amountMinor).toBe(5_000n);
    expect(baseline.normalBaseline.amountMinor).toBe(15_000n);
  });

  it('does not count historical recurring spending again as variable', () => {
    const variable = ['2026-01-10', '2026-02-10', '2026-03-10'].map((date, index) =>
      consumption(30 + index, date, 10_000n),
    );
    const recurring = ['2026-01-05', '2026-02-05', '2026-03-05'].map((date, index) =>
      consumption(40 + index, date, 4_000n, { cadence: 'recurring' }),
    );
    const all = [...variable, ...recurring];
    const baseline = value(
      calculateSpendingBaseline(
        input(
          all.map((item) => item.flow),
          all.map((item) => item.observation),
          { monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']) },
        ),
      ),
    );
    expect(baseline.variableNormal.amountMinor).toBe(10_000n);
    expect(baseline.normalBaseline.amountMinor).toBe(15_000n);
  });

  it('excludes irregular and funded amounts while retaining an unfunded remainder', () => {
    const normal = ['2026-01-10', '2026-02-10', '2026-03-10'].map((date, index) =>
      consumption(50 + index, date, 10_000n),
    );
    const trip = consumption(60, '2026-03-20', 120_000n, { irregular: true });
    const purchase = consumption(61, '2026-02-20', 12_000n);
    const all = [...normal, trip, purchase];
    const result = calculateSpendingBaseline(
      input(
        all.map((item) => item.flow),
        all.map((item) => item.observation),
        {
          monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']),
          fundedConsumptionCoverage: coverageResult([
            { transactionId: purchase.flow.transactionId, amount: createMoney(10_000n, EUR) },
          ]),
        },
      ),
    );
    const baseline = value(result);
    expect(baseline.excludedIrregular.amountMinor).toBe(120_000n);
    expect(baseline.excludedFundedConsumption.amountMinor).toBe(10_000n);
    expect(baseline.variableNormal.amountMinor).toBe(10_000n);
  });

  it('applies linked refunds once in their booking month and never as income', () => {
    const january = consumption(70, '2026-01-10', 10_000n);
    const february = consumption(71, '2026-02-10', 10_000n);
    const march = consumption(72, '2026-03-10', 10_000n);
    const refunds = [january, february].map((original, index) => {
      const flow = createEconomicFlow({
        id: parseEconomicFlowId(uuid(1200 + index)),
        transactionId: parseTransactionId(uuid(120 + index)),
        effectiveAt: parseInstant(`2026-0${index + 1}-20T12:00:00Z`),
        amount: createMoney(3_000n, EUR),
        kind: 'refund',
        relatedTransactionId: original.flow.transactionId,
      });
      return {
        flow,
        observation: createSpendingObservation({
          ...original.observation,
          economicFlowId: flow.id,
          economicDate: parseLocalDate(`2026-0${index + 1}-20`),
        }),
      };
    });
    const all = [january, february, march, ...refunds];
    const baseline = value(
      calculateSpendingBaseline(
        input(
          all.map((item) => item.flow),
          all.map((item) => item.observation),
          { monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']) },
        ),
      ),
    );
    expect(baseline.variableNormal.amountMinor).toBe(7_000n);
  });

  it('treats linked reimbursements like refunds rather than earned income', () => {
    const originals = ['2026-01-10', '2026-02-10', '2026-03-10'].map((date, index) =>
      consumption(90 + index, date, 10_000n, { reimbursable: true }),
    );
    const reversals = originals.slice(0, 2).map((original, index) => {
      const flow = createEconomicFlow({
        id: parseEconomicFlowId(uuid(1300 + index)),
        transactionId: parseTransactionId(uuid(130 + index)),
        effectiveAt: parseInstant(`2026-0${index + 1}-20T12:00:00Z`),
        amount: createMoney(4_000n, EUR),
        kind: 'reimbursement',
        relatedTransactionId: original.flow.transactionId,
      });
      return {
        flow,
        observation: createSpendingObservation({
          ...original.observation,
          economicFlowId: flow.id,
          economicDate: parseLocalDate(`2026-0${index + 1}-20`),
        }),
      };
    });
    const all = [...originals, ...reversals];
    const baseline = value(
      calculateSpendingBaseline(
        input(
          all.map((item) => item.flow),
          all.map((item) => item.observation),
          { monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']) },
        ),
      ),
    );
    expect(baseline.variableNormal.amountMinor).toBe(6_000n);
  });

  it('keeps cash reconciliation and neutral external flows out of the baseline', () => {
    const items = ['2026-01-10', '2026-02-10', '2026-03-10'].map((date, index) =>
      consumption(110 + index, date, 10_000n),
    );
    const neutral = [
      createEconomicFlow({
        id: parseEconomicFlowId(uuid(1400)),
        transactionId: parseTransactionId(uuid(140)),
        effectiveAt: parseInstant('2026-02-12T12:00:00Z'),
        amount: createMoney(-50_000n, EUR),
        kind: 'cash_reconciliation_adjustment',
      }),
      createEconomicFlow({
        id: parseEconomicFlowId(uuid(1401)),
        transactionId: parseTransactionId(uuid(141)),
        effectiveAt: parseInstant('2026-02-13T12:00:00Z'),
        amount: createMoney(-80_000n, EUR),
        kind: 'other_external_flow',
      }),
    ];
    const baseline = value(
      calculateSpendingBaseline(
        input(
          [...items.map((item) => item.flow), ...neutral],
          items.map((item) => item.observation),
          { monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']) },
        ),
      ),
    );
    expect(baseline.variableNormal.amountMinor).toBe(10_000n);
  });

  it('rejects an unlinked reversal inside a month claimed complete', () => {
    const flow = createEconomicFlow({
      id: parseEconomicFlowId(uuid(1450)),
      transactionId: parseTransactionId(uuid(145)),
      effectiveAt: parseInstant('2026-01-20T12:00:00Z'),
      amount: createMoney(3_000n, EUR),
      kind: 'refund',
      relatedTransactionId: null,
    });
    const observation = createSpendingObservation({
      economicFlowId: flow.id,
      economicDate: parseLocalDate('2026-01-20'),
      categoryId: parseSpendingCategoryId(uuid(900)),
      necessity: 'essential',
      cadence: 'variable',
      irregular: false,
    });
    expect(() =>
      calculateSpendingBaseline(
        input([flow], [observation], {
          monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']),
        }),
      ),
    ).toThrow('An unlinked reversal cannot appear in a complete baseline month.');
  });

  it('winsorizes high category outliers at median plus the materiality floor', () => {
    const amounts = [10_000n, 10_000n, 10_000n, 10_000n, 10_000n, 100_000n];
    const items = amounts.map((amount, index) =>
      consumption(140 + index, `2026-0${index + 1}-10`, amount),
    );
    const result = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
      ),
    );
    expect(value(result).variableNormal.amountMinor).toBe(10_000n);
    expect(result.warnings.some((item) => item.code === 'baseline.high_outliers_winsorized')).toBe(
      true,
    );
    expect(value(result).variabilityBuffer.amountMinor).toBe(5_000n);
  });

  it('uses half-even minor-unit rounding for an even median', () => {
    const amounts = [100n, 101n, 100n, 101n];
    const items = amounts.map((amount, index) =>
      consumption(155 + index, `2026-0${index + 1}-10`, amount),
    );
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03', '2026-04']),
            scheduledRecurring: [],
            settings: settings({ materialityThreshold: createMoney(10_000n, EUR) }),
          },
        ),
      ),
    );
    expect(baseline.variableNormal.amountMinor).toBe(100n);
  });

  it('is deterministic when canonical facts are reordered', () => {
    const items = [12_000n, 9_000n, 15_000n, 10_000n, 11_000n, 13_000n].map((amount, index) =>
      consumption(150 + index, `2026-0${index + 1}-10`, amount),
    );
    const forward = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
      ),
    );
    const reversed = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow).reverse(),
        items.map((item) => item.observation).reverse(),
        {
          monthCoverage: completeMonths([
            '2026-06',
            '2026-05',
            '2026-04',
            '2026-03',
            '2026-02',
            '2026-01',
          ]),
        },
      ),
    );
    expect(reversed.value).toEqual(forward.value);
    expect(reversed.warnings).toEqual(forward.warnings);
  });

  it('returns an explicit partial fallback instead of zero for insufficient history', () => {
    const result = calculateSpendingBaseline(
      input([], [], { monthCoverage: completeMonths(['2026-06']) }),
    );
    const baseline = value(result);
    expect(result.status).toBe('partial');
    expect(baseline.source).toBe('fallback');
    expect(baseline.normalBaseline.amountMinor).toBe(150_000n);
    expect(baseline.variabilityBuffer.amountMinor).toBe(0n);
  });

  it('selects the latest six complete months across an interspersed incomplete month', () => {
    const selected = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-05', '2026-06'];
    const items = selected.map((month, index) => consumption(600 + index, `${month}-10`, 10_000n));
    const incompleteApril = createCalendarMonthCoverage({
      month: parseYearMonth('2026-04'),
      reconciled: false,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    });
    const result = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
        { monthCoverage: [...completeMonths(selected), incompleteApril] },
      ),
    );
    const reordered = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow).reverse(),
        items.map((item) => item.observation).reverse(),
        { monthCoverage: [incompleteApril, ...completeMonths(selected).reverse()] },
      ),
    );

    expect(value(result).historicalWindowUsed).toEqual(selected);
    expect(value(result).source).toBe('historical');
    expect(reordered.value).toEqual(result.value);
    expect(reordered.warnings).toEqual(result.warnings);
    expect(
      result.warnings.filter((item) => item.code === 'baseline.incomplete_months_skipped'),
    ).toEqual([expect.objectContaining({ context: { count: '1', months: '2026-04' } })]);
  });

  it('continues through the 36-month lookback to avoid an unnecessary fallback', () => {
    const selected = ['2025-08', '2025-12', '2026-02', '2026-05', '2026-06'];
    const items = selected.map((month, index) => consumption(620 + index, `${month}-10`, 10_000n));
    const result = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
        { monthCoverage: completeMonths(selected), scheduledRecurring: [] },
      ),
    );

    expect(value(result).source).toBe('historical');
    expect(value(result).historicalWindowUsed).toEqual(selected);
    expect(result.warnings.some((item) => item.code === 'baseline.insufficient_history')).toBe(
      false,
    );
    expect(
      result.warnings.filter((item) => item.code === 'baseline.missing_month_coverage'),
    ).toHaveLength(1);
  });

  it('excludes incomplete months instead of interpreting them as zero', () => {
    const items = ['2026-01-10', '2026-02-10', '2026-03-10', '2026-04-10'].map((date, index) =>
      consumption(160 + index, date, index === 3 ? 100_000n : 10_000n),
    );
    const monthCoverage = completeMonths(['2026-01', '2026-02', '2026-03']);
    const incomplete = createCalendarMonthCoverage({
      month: parseYearMonth('2026-04'),
      reconciled: false,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    });
    const result = calculateSpendingBaseline(
      input(
        items.map((item) => item.flow),
        items.map((item) => item.observation),
        { monthCoverage: [...monthCoverage, incomplete] },
      ),
    );
    expect(value(result).variableNormal.amountMinor).toBe(10_000n);
    expect(result.warnings.some((item) => item.code === 'baseline.incomplete_months_skipped')).toBe(
      true,
    );
  });

  it('preserves exact bigint amounts above the JavaScript safe-integer range', () => {
    const amount = 9_007_199_254_740_993n;
    const items = ['2026-01-10', '2026-02-10', '2026-03-10'].map((date, index) =>
      consumption(170 + index, date, amount),
    );
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            monthCoverage: completeMonths(['2026-01', '2026-02', '2026-03']),
            scheduledRecurring: [],
          },
        ),
      ),
    );
    expect(baseline.normalBaseline.amountMinor).toBe(amount);
  });

  it('uses exact nearest-rank P80 positive deviation', () => {
    const amounts = [10_000n, 11_000n, 12_000n, 13_000n, 14_000n, 15_000n];
    const items = amounts.map((amount, index) =>
      consumption(180 + index, `2026-0${index + 1}-10`, amount),
    );
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          { settings: settings({ materialityThreshold: createMoney(100_000n, EUR) }) },
        ),
      ),
    );
    expect(baseline.variabilityBuffer.amountMinor).toBe(2_500n);
  });

  it('enables exact variable-only seasonality at 24 months and caps it at +20%', () => {
    const months: string[] = [];
    const items: ReturnType<typeof consumption>[] = [];
    let seed = 300;
    for (let year = 2024; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const ym = `${year}-${month.toString().padStart(2, '0')}`;
        months.push(ym);
        items.push(consumption(seed, `${ym}-10`, month === 1 ? 20_000n : 10_000n));
        seed += 1;
      }
    }
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            targetMonth: parseYearMonth('2026-01'),
            asOf: AS_OF,
            monthCoverage: completeMonths(months),
            scheduledRecurring: [
              createScheduledSpending({
                id: parseScheduledSpendingId(uuid(850)),
                dueDate: parseLocalDate('2026-01-05'),
                amount: createMoney(5_000n, EUR),
                necessity: 'essential',
              }),
            ],
          },
        ),
      ),
    );
    expect(baseline.seasonalAdjustment).toEqual({ numerator: 6n, denominator: 5n });
    expect(baseline.variableNormal.amountMinor).toBe(12_000n);
    expect(baseline.normalBaseline.amountMinor).toBe(17_000n);
  });

  it('does not infer seasonality at 23 months', () => {
    const months: string[] = [];
    const items: ReturnType<typeof consumption>[] = [];
    for (let index = 0; index < 23; index += 1) {
      const year = 2024 + Math.floor(index / 12);
      const month = (index % 12) + 1;
      const ym = `${year}-${month.toString().padStart(2, '0')}`;
      months.push(ym);
      items.push(consumption(400 + index, `${ym}-10`, 10_000n));
    }
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            targetMonth: parseYearMonth('2025-12'),
            monthCoverage: completeMonths(months),
            scheduledRecurring: [],
          },
        ),
      ),
    );
    expect(baseline.seasonalAdjustment).toBeNull();
  });

  it('enables seasonality with 24 complete months around an interspersed incomplete month', () => {
    const months: string[] = [];
    const items: ReturnType<typeof consumption>[] = [];
    let seed = 700;
    for (let year = 2023; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const ym = `${year}-${month.toString().padStart(2, '0')}`;
        if (ym < '2023-12' || ym === '2025-06') continue;
        months.push(ym);
        items.push(consumption(seed, `${ym}-10`, 10_000n));
        seed += 1;
      }
    }
    const incompleteJune = createCalendarMonthCoverage({
      month: parseYearMonth('2025-06'),
      reconciled: true,
      materialAmbiguityFree: false,
      fxComplete: true,
      spendingClassificationComplete: true,
    });
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            targetMonth: parseYearMonth('2026-01'),
            monthCoverage: [...completeMonths(months), incompleteJune],
            scheduledRecurring: [],
          },
        ),
      ),
    );

    expect(months).toHaveLength(24);
    expect(baseline.seasonalAdjustment).toEqual({ numerator: 10_000n, denominator: 10_000n });
  });

  it('winsorizes an extreme target-month observation before seasonal comparison', () => {
    const months: string[] = [];
    const items: ReturnType<typeof consumption>[] = [];
    let seed = 750;
    for (let year = 2024; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const ym = `${year}-${month.toString().padStart(2, '0')}`;
        months.push(ym);
        items.push(
          consumption(seed, `${ym}-10`, year === 2025 && month === 1 ? 100_000n : 10_000n),
        );
        seed += 1;
      }
    }
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            targetMonth: parseYearMonth('2026-01'),
            monthCoverage: completeMonths(months),
            scheduledRecurring: [],
            settings: settings({ materialityThreshold: createMoney(1_000n, EUR) }),
          },
        ),
      ),
    );

    expect(baseline.seasonalAdjustment).toEqual({ numerator: 10_500n, denominator: 10_000n });
    expect(baseline.variableNormal.amountMinor).toBe(10_500n);
  });

  it('keeps zero-reference seasonality disabled with an explicit warning', () => {
    const months: string[] = [];
    for (let year = 2024; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        months.push(`${year}-${month.toString().padStart(2, '0')}`);
      }
    }
    const result = calculateSpendingBaseline(
      input([], [], {
        targetMonth: parseYearMonth('2026-01'),
        monthCoverage: completeMonths(months),
        scheduledRecurring: [],
      }),
    );

    expect(value(result).seasonalAdjustment).toBeNull();
    expect(
      result.warnings.some((item) => item.code === 'baseline.seasonality_zero_reference'),
    ).toBe(true);
  });

  it('rejects a lookback shorter than the baseline or seasonality requirement', () => {
    expect(() =>
      calculateSpendingBaseline(
        input([], [], {
          settings: settings({ maximumBaselineLookbackMonths: 23 }),
        }),
      ),
    ).toThrow('Spending baseline settings violate the accepted Stage 2D policy.');
  });

  it('caps a low seasonal factor at -20%', () => {
    const months: string[] = [];
    const items: ReturnType<typeof consumption>[] = [];
    let seed = 500;
    for (let year = 2024; year <= 2025; year += 1) {
      for (let month = 1; month <= 12; month += 1) {
        const ym = `${year}-${month.toString().padStart(2, '0')}`;
        months.push(ym);
        items.push(consumption(seed, `${ym}-10`, month === 1 ? 1_000n : 10_000n));
        seed += 1;
      }
    }
    const baseline = value(
      calculateSpendingBaseline(
        input(
          items.map((item) => item.flow),
          items.map((item) => item.observation),
          {
            targetMonth: parseYearMonth('2026-01'),
            monthCoverage: completeMonths(months),
            scheduledRecurring: [],
          },
        ),
      ),
    );
    expect(baseline.seasonalAdjustment).toEqual({ numerator: 4n, denominator: 5n });
    expect(baseline.variableNormal.amountMinor).toBe(8_000n);
  });

  it('ignores incomplete-month insertion and spending when enough complete history remains', () => {
    const selected = ['2025-12', '2026-01', '2026-02', '2026-03', '2026-05', '2026-06'];
    const stable = selected.map((month, index) =>
      consumption(820 + index, `${month}-10`, 10_000n + BigInt(index) * 1_000n),
    );
    const incompleteApril = createCalendarMonthCoverage({
      month: parseYearMonth('2026-04'),
      reconciled: false,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    });

    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (incompleteAmount) => {
        const ignored = consumption(840, '2026-04-10', incompleteAmount);
        const withoutSpending = calculateSpendingBaseline(
          input(
            stable.map((item) => item.flow),
            stable.map((item) => item.observation),
            { monthCoverage: [...completeMonths(selected), incompleteApril] },
          ),
        );
        const withSpending = calculateSpendingBaseline(
          input(
            [...stable.map((item) => item.flow), ignored.flow],
            [...stable.map((item) => item.observation), ignored.observation],
            { monthCoverage: [...completeMonths(selected), incompleteApril] },
          ),
        );

        expect(withSpending.value).toEqual(withoutSpending.value);
      }),
      { seed: 2_026_024, numRuns: 100 },
    );
  });
});
