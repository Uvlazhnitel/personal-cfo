import { describe, expect, it } from 'vitest';

import {
  EUR,
  createCycleInvestmentCapacityReadiness,
  createInvestmentContribution,
  createMetricResult,
  createMoney,
  createPayCycle,
  parseAccountId,
  parseCurrencyCode,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseRecurringInvestmentOccurrenceId,
  parseRecurringInvestmentPlanId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  Completeness,
  CycleCapacityIssue,
  ForwardLiquidityProjectionCoverage,
  ForwardLiquidityProjectionDay,
  InvestmentContribution,
  InvestmentContributionAttribution,
  MetricResult,
  PayCycle,
} from '@personal-cfo/domain';

import {
  DEFAULT_INVESTMENT_STEP_SETTINGS,
  FinancialEngineInvariantError,
  calculateHistoricalInvestmentCapacity,
  calculateSafeToInvest,
  evaluateInvestmentContributionStep,
  stressRecurringContribution,
} from '../src/index.js';
import { addLocalDays } from '../src/local-calendar.js';
import type {
  CashDragAssessment,
  ForwardLiquidityStressScenario,
  HistoricalInvestmentCapacity,
  HistoricalInvestmentCapacityInput,
  InvestmentContributionDecisionInput,
  LiquidityReserve,
  SafeToInvest,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');
const PLAN_ID = parseRecurringInvestmentPlanId(uuid(900));
const SETTINGS = DEFAULT_INVESTMENT_STEP_SETTINGS;
const BOUNDARIES = [
  '2026-01-01T08:00:00Z',
  '2026-02-01T08:00:00Z',
  '2026-03-01T08:00:00Z',
  '2026-04-01T08:00:00Z',
  '2026-05-01T08:00:00Z',
  '2026-06-01T08:00:00Z',
] as const;

function metric<T>(
  value: T,
  options: Readonly<{
    status?: 'complete' | 'partial';
    asOf?: ReturnType<typeof parseInstant>;
    warnings?: MetricResult<T>['warnings'];
  }> = {},
): MetricResult<T> {
  return createMetricResult({
    status: options.status ?? 'complete',
    value,
    asOf: options.asOf ?? AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'fixture',
    explanation: [],
    warnings: options.warnings ?? [],
  });
}

function cycles(count: number, boundaries: readonly string[] = BOUNDARIES): readonly PayCycle[] {
  return Object.freeze(
    Array.from({ length: count }, (_, index) =>
      createPayCycle({
        id: parsePayCycleId(uuid(index + 1)),
        openingSalaryTransactionId: parseTransactionId(uuid(index + 1)),
        startInclusive: parseInstant(boundaries[index]!),
        startDate: parseLocalDate(boundaries[index]!.slice(0, 10)),
        closingSalaryTransactionId: parseTransactionId(uuid(index + 2)),
        endExclusive: parseInstant(boundaries[index + 1]!),
        expectedNextPayDate: null,
        status: 'closed',
      }),
    ),
  );
}

function safeValue(recommended: bigint): SafeToInvest {
  const zero = createMoney(0n, EUR);
  const amount = createMoney(recommended, EUR);
  return Object.freeze({
    conservative: amount,
    recommended: amount,
    maximum: amount,
    unroundedConservative: amount,
    unroundedRecommended: amount,
    unroundedMaximum: amount,
    conservativeRoundingLoss: zero,
    recommendedRoundingLoss: zero,
    maximumRoundingLoss: zero,
    recommendationIncrement: createMoney(1n, EUR),
    liquidCash: amount,
    minimumCash: zero,
    comfortCash: zero,
    variabilityBuffer: zero,
  });
}

type ContributionFact = Readonly<{
  cycleIndex: number;
  amount: bigint;
  kind: 'recurring_plan' | 'ad_hoc';
  atBoundary?: boolean;
}>;

function history(
  capacities: readonly bigint[],
  options: Readonly<{
    incompleteCycle?: number;
    incompleteReason?: CycleCapacityIssue;
    contributions?: readonly ContributionFact[];
    boundaries?: readonly string[];
    appendOpenCycle?: boolean;
  }> = {},
): MetricResult<HistoricalInvestmentCapacity> {
  const closedCycles = cycles(capacities.length, options.boundaries ?? BOUNDARIES);
  const openCycle = options.appendOpenCycle
    ? createPayCycle({
        id: parsePayCycleId(uuid(capacities.length + 1)),
        openingSalaryTransactionId: parseTransactionId(uuid(capacities.length + 1)),
        startInclusive: closedCycles.at(-1)!.endExclusive!,
        startDate: parseLocalDate(closedCycles.at(-1)!.endExclusive!.slice(0, 10)),
        closingSalaryTransactionId: null,
        endExclusive: null,
        expectedNextPayDate: parseLocalDate('2026-06-01'),
        status: 'open',
      })
    : null;
  const payCycles = openCycle === null ? closedCycles : Object.freeze([...closedCycles, openCycle]);
  const contributionFacts = options.contributions ?? [];
  const contributions: InvestmentContribution[] = [];
  const attributions: InvestmentContributionAttribution[] = [];
  const contributionByCycle = new Map<number, bigint>();
  for (const [index, fact] of contributionFacts.entries()) {
    const cycle = closedCycles[fact.cycleIndex]!;
    const transactionId = parseTransactionId(uuid(300 + index));
    const effectiveAt = fact.atBoundary
      ? cycle.endExclusive!
      : parseInstant(`${cycle.startInclusive.slice(0, 10)}T12:00:00Z`);
    contributions.push(
      createInvestmentContribution({
        transactionId,
        investmentAccountId: parseAccountId(uuid(700)),
        principal: createMoney(fact.amount, EUR),
        effectiveAt,
      }),
    );
    attributions.push(
      fact.kind === 'recurring_plan'
        ? { transactionId, kind: fact.kind, planId: PLAN_ID }
        : { transactionId, kind: fact.kind },
    );
    if (fact.kind === 'recurring_plan' && !fact.atBoundary) {
      contributionByCycle.set(
        fact.cycleIndex,
        (contributionByCycle.get(fact.cycleIndex) ?? 0n) + fact.amount,
      );
    }
  }
  const input: HistoricalInvestmentCapacityInput = {
    payCycles,
    investmentContributions: contributions,
    contributionAttributions: attributions,
    recurringPlanId: PLAN_ID,
    cycleReadiness: closedCycles.map((cycle, index) =>
      createCycleInvestmentCapacityReadiness(
        index === options.incompleteCycle
          ? {
              cycleId: cycle.id,
              kind: 'incomplete',
              reasons: [options.incompleteReason ?? 'material_cash_variance'],
            }
          : { cycleId: cycle.id, kind: 'complete', reasons: [] },
      ),
    ),
    preClosingSafeToInvest: closedCycles.map((cycle, index) => ({
      cycleId: cycle.id,
      safeToInvest: metric(safeValue(capacities[index]! - (contributionByCycle.get(index) ?? 0n)), {
        asOf: parseInstant(`${cycle.endExclusive!.slice(0, 10)}T00:00:00Z`),
      }),
    })),
    settings: SETTINGS,
    asOf: AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'history',
  };
  return calculateHistoricalInvestmentCapacity(input);
}

function liquidityValue(cash: bigint, minimum = 10_000n, comfort = 20_000n): LiquidityReserve {
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
    variabilityBuffer: zero,
    minimumCash: createMoney(minimum, EUR),
    comfortCash: createMoney(comfort, EUR),
    freeLiquidCash: createMoney(cash, EUR),
    currentExcessAboveComfort: createMoney(cash > comfort ? cash - comfort : 0n, EUR),
    operationalStartInclusive: EFFECTIVE_DATE,
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
}

function currentMetrics(
  cash: bigint,
  minimum = 10_000n,
  comfort = 20_000n,
  status: 'complete' | 'partial' = 'complete',
): readonly [MetricResult<LiquidityReserve>, MetricResult<SafeToInvest>] {
  const liquidity = metric(liquidityValue(cash, minimum, comfort), { status });
  const safe = calculateSafeToInvest({
    liquidity,
    readiness:
      status === 'complete'
        ? { kind: 'complete' }
        : { kind: 'provisional', reasons: ['non_material_cash_variance'] },
    settings: { recommendationIncrement: createMoney(1_000n, EUR) },
    asOf: AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'current-safe',
  });
  return [liquidity, safe];
}

type DayChange = Readonly<{
  salary?: bigint;
  spending?: bigint;
  obligation?: bigint;
  sinkingSpend?: bigint;
  sinkingProtected?: bigint;
  minimum?: bigint;
  comfort?: bigint;
  completeness?: Completeness;
}>;

function scenario(
  initialCash: bigint,
  options: Readonly<{
    occurrenceDays?: readonly number[];
    changes?: Readonly<Record<number, DayChange>>;
    coverage?: Partial<ForwardLiquidityProjectionCoverage>;
    completeThrough?: ReturnType<typeof parseLocalDate>;
    omitDays?: readonly number[];
    defaultMinimum?: bigint;
    defaultComfort?: bigint;
  }> = {},
): ForwardLiquidityStressScenario {
  let running = initialCash;
  const omitted = new Set(options.omitDays ?? []);
  const projectionDays: ForwardLiquidityProjectionDay[] = [];
  for (let offset = 1; offset <= 60; offset += 1) {
    const change = options.changes?.[offset] ?? {};
    const salary = change.salary ?? 0n;
    const spending = change.spending ?? 0n;
    const obligation = change.obligation ?? 0n;
    const sinkingSpend = change.sinkingSpend ?? 0n;
    running += salary - spending - obligation - sinkingSpend;
    if (omitted.has(offset)) continue;
    projectionDays.push({
      date: addLocalDays(EFFECTIVE_DATE, offset),
      expectedPrimarySalaryInflow: createMoney(salary, EUR),
      normalSpendingOutflow: createMoney(spending, EUR),
      committedObligationOutflow: createMoney(obligation, EUR),
      sinkingFundedSpendingOutflow: createMoney(sinkingSpend, EUR),
      sinkingProtectedCash: createMoney(change.sinkingProtected ?? 0n, EUR),
      baseLiquidCashBeforeContribution: createMoney(running, EUR),
      minimumCash: createMoney(change.minimum ?? options.defaultMinimum ?? 10_000n, EUR),
      comfortCash: createMoney(change.comfort ?? options.defaultComfort ?? 20_000n, EUR),
      completeness: change.completeness ?? 'complete',
    });
  }
  return {
    effectiveDate: EFFECTIVE_DATE,
    projectionDays,
    projectionCoverage: {
      expectedPrimarySalary: 'complete',
      normalSpending: 'complete',
      committedObligations: 'complete',
      sinkingProtection: 'complete',
      ...options.coverage,
    },
    contributionSchedule: {
      planId: PLAN_ID,
      occurrences: (options.occurrenceDays ?? [10, 40]).map((offset, index) => ({
        id: parseRecurringInvestmentOccurrenceId(uuid(800 + index)),
        planId: PLAN_ID,
        date: addLocalDays(EFFECTIVE_DATE, offset),
      })),
      completeThrough: options.completeThrough ?? addLocalDays(EFFECTIVE_DATE, 60),
    },
  };
}

function cashDragMetric(
  eligible: boolean,
  status: 'complete' | 'partial' = 'complete',
): MetricResult<CashDragAssessment> {
  const zero = createMoney(0n, EUR);
  return metric(
    Object.freeze({
      eligible,
      windowStartInclusive: parseLocalDate('2026-07-17'),
      windowEndInclusive: EFFECTIVE_DATE,
      completeDays: 60,
      incompleteDays: 0,
      missingDays: 0,
      positiveExcessDays: eligible ? 60 : 0,
      totalExcess: zero,
      currentExcess: zero,
      averageExcess: zero,
      absoluteThreshold: zero,
      relativeThreshold: zero,
      effectiveThreshold: zero,
      actionCap: zero,
      suppressionReasons: Object.freeze([]),
    }),
    { status },
  );
}

function decisionInput(
  historicalCapacity: MetricResult<HistoricalInvestmentCapacity>,
  currentContribution: bigint,
  stressScenario = scenario(100_000n),
  options: Readonly<{
    cash?: bigint;
    minimum?: bigint;
    comfort?: bigint;
    cashDrag?: MetricResult<CashDragAssessment>;
    currentStatus?: 'complete' | 'partial';
    issuedWindow?: readonly PayCycle['id'][] | null;
  }> = {},
): InvestmentContributionDecisionInput {
  const [currentLiquidity, currentSafeToInvest] = currentMetrics(
    options.cash ?? 100_000n,
    options.minimum,
    options.comfort,
    options.currentStatus,
  );
  return {
    recurringPlanId: PLAN_ID,
    historicalCapacity,
    currentLiquidity,
    currentSafeToInvest,
    cashDrag: options.cashDrag ?? cashDragMetric(true),
    stressScenario,
    currentContribution: createMoney(currentContribution, EUR),
    lastIssuedStepUpCycleIds: options.issuedWindow ?? null,
    settings: SETTINGS,
    asOf: AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'decision',
  };
}

function decisionValue(result: ReturnType<typeof evaluateInvestmentContributionStep>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected an investment contribution decision.');
  return result.value;
}

describe('historical Pay-Cycle investment capacity', () => {
  it('uses the exact four-sample median and half-even central midpoint', () => {
    const result = history([15_000n, 25_000n, 20_000n, 30_000n]);
    expect(result.status).toBe('complete');
    expect(result.value?.sustainableCapacity?.amountMinor).toBe(22_500n);
    expect(
      history([2_000n, 20_000n, 20_000n, 22_000n]).value?.sustainableCapacity?.amountMinor,
    ).toBe(20_000n);

    expect(history([0n, 100n, 101n, 200n]).value?.sustainableCapacity?.amountMinor).toBe(100n);
    expect(history([0n, 101n, 102n, 200n]).value?.sustainableCapacity?.amountMinor).toBe(102n);
  });

  it('adds recurring contributions and excludes ad-hoc investments', () => {
    const result = history([24_000n, 20_000n, 20_000n, 20_000n], {
      contributions: [
        { cycleIndex: 0, amount: 10_000n, kind: 'recurring_plan' },
        { cycleIndex: 0, amount: 50_000n, kind: 'ad_hoc' },
      ],
    });
    const first = result.value?.observations[0];
    expect(first?.recurringContributionTotal.amountMinor).toBe(10_000n);
    expect(first?.preClosingRecommendedSafeToInvest?.amountMinor).toBe(14_000n);
    expect(first?.cycleCapacity?.amountMinor).toBe(24_000n);
    expect(first?.excludedAdHocContributionTotal.amountMinor).toBe(50_000n);
  });

  it('assigns a contribution at the closing salary boundary to the next cycle', () => {
    const result = history([10_000n, 20_000n, 30_000n, 40_000n], {
      contributions: [{ cycleIndex: 0, amount: 5_000n, kind: 'recurring_plan', atBoundary: true }],
    });
    expect(result.value?.observations[0]?.recurringContributionTotal.amountMinor).toBe(0n);
    expect(result.value?.observations[1]?.recurringContributionTotal.amountMinor).toBe(5_000n);
  });

  it('is invariant to equivalent salary-date placement', () => {
    const firstAnchored = history([18_000n, 22_000n, 24_000n, 26_000n]);
    const lateBoundaries = [
      '2026-01-28T08:00:00Z',
      '2026-02-28T08:00:00Z',
      '2026-03-28T08:00:00Z',
      '2026-04-28T08:00:00Z',
      '2026-05-28T08:00:00Z',
    ];
    const lateAnchored = history([18_000n, 22_000n, 24_000n, 26_000n], {
      boundaries: lateBoundaries,
    });
    expect(lateAnchored.value?.sustainableCapacity).toEqual(
      firstAnchored.value?.sustainableCapacity,
    );
  });

  it('returns partial for three cycles and never backfills over an unreliable latest cycle', () => {
    const short = history([10_000n, 20_000n, 30_000n]);
    expect(short.status).toBe('partial');
    expect(short.value?.sustainableCapacity).toBeNull();

    const recentIncomplete = history([10_000n, 20_000n, 30_000n, 40_000n, 50_000n], {
      incompleteCycle: 4,
      incompleteReason: 'material_unresolved_transaction',
    });
    expect(recentIncomplete.value?.reassessmentCycleIds).toEqual(
      cycles(5)
        .slice(-4)
        .map((cycle) => cycle.id),
    );
    expect(recentIncomplete.status).toBe('partial');
    expect(recentIncomplete.value?.sustainableCapacity).toBeNull();
  });

  it('ignores the current open Pay Cycle as a historical capacity observation', () => {
    const result = history([18_000n, 22_000n, 24_000n, 26_000n], { appendOpenCycle: true });
    expect(result.status).toBe('complete');
    expect(result.value?.observations).toHaveLength(4);
    expect(result.value?.reassessmentCycleIds).toEqual(cycles(4).map((cycle) => cycle.id));
  });

  it('rejects incomplete attribution and pre-closing snapshots outside their cycle', () => {
    const payCycles = cycles(4);
    const contribution = createInvestmentContribution({
      transactionId: parseTransactionId(uuid(500)),
      investmentAccountId: parseAccountId(uuid(700)),
      principal: createMoney(1_000n, EUR),
      effectiveAt: parseInstant('2026-01-15T00:00:00Z'),
    });
    const common = {
      payCycles,
      investmentContributions: [contribution],
      recurringPlanId: PLAN_ID,
      cycleReadiness: payCycles.map((cycle) => ({
        cycleId: cycle.id,
        kind: 'complete' as const,
        reasons: [],
      })),
      preClosingSafeToInvest: payCycles.map((cycle) => ({
        cycleId: cycle.id,
        safeToInvest: metric(safeValue(1_000n), { asOf: cycle.startInclusive }),
      })),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'invalid',
    } as const;
    expect(() =>
      calculateHistoricalInvestmentCapacity({ ...common, contributionAttributions: [] }),
    ).toThrowError(FinancialEngineInvariantError);
    expect(() =>
      calculateHistoricalInvestmentCapacity({
        ...common,
        contributionAttributions: [{ transactionId: contribution.transactionId, kind: 'ad_hoc' }],
        preClosingSafeToInvest: [
          ...common.preClosingSafeToInvest.slice(0, 3),
          {
            cycleId: payCycles[3]!.id,
            safeToInvest: metric(safeValue(1_000n), { asOf: payCycles[3]!.endExclusive! }),
          },
        ],
      }),
    ).toThrowError(FinancialEngineInvariantError);

    const partialSnapshot = calculateHistoricalInvestmentCapacity({
      ...common,
      contributionAttributions: [{ transactionId: contribution.transactionId, kind: 'ad_hoc' }],
      preClosingSafeToInvest: [
        ...common.preClosingSafeToInvest.slice(0, 3),
        {
          cycleId: payCycles[3]!.id,
          safeToInvest: metric(safeValue(1_000n), {
            status: 'partial',
            asOf: payCycles[3]!.startInclusive,
          }),
        },
      ],
    });
    expect(partialSnapshot.status).toBe('partial');
    expect(partialSnapshot.value?.sustainableCapacity).toBeNull();
    expect(partialSnapshot.value?.observations[3]?.issues).toContain(
      'incomplete_pre_closing_safe_to_invest',
    );

    expect(() =>
      calculateHistoricalInvestmentCapacity({
        ...common,
        investmentContributions: [contribution, contribution],
        contributionAttributions: [{ transactionId: contribution.transactionId, kind: 'ad_hoc' }],
      }),
    ).toThrowError(FinancialEngineInvariantError);

    const nonEurContribution = createInvestmentContribution({
      ...contribution,
      transactionId: parseTransactionId(uuid(501)),
      principal: createMoney(1_000n, parseCurrencyCode('USD')),
    });
    expect(() =>
      calculateHistoricalInvestmentCapacity({
        ...common,
        investmentContributions: [nonEurContribution],
        contributionAttributions: [
          { transactionId: nonEurContribution.transactionId, kind: 'ad_hoc' },
        ],
      }),
    ).toThrowError(FinancialEngineInvariantError);
  });
});

describe('60-day recurring-contribution stress', () => {
  it('uses the next 60 daily boundaries and applies salary only on its supplied date', () => {
    const [currentLiquidity] = currentMetrics(50_000n, 10_000n, 20_000n);
    const projection = scenario(50_000n, {
      occurrenceDays: [10, 40],
      changes: { 20: { salary: 30_000n } },
    });
    const result = stressRecurringContribution({
      currentLiquidity,
      scenario: projection,
      candidate: createMoney(5_000n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(result.status).toBe('complete');
    expect(result.value).toMatchObject({
      horizonStartInclusive: addLocalDays(EFFECTIVE_DATE, 1),
      horizonEndInclusive: addLocalDays(EFFECTIVE_DATE, 60),
      contributionOccurrences: 2,
      endingLiquidCash: { amountMinor: 70_000n },
      passes: true,
    });
    expect(projection.projectionDays[18]?.baseLiquidCashBeforeContribution.amountMinor).toBe(
      50_000n,
    );
    expect(projection.projectionDays[19]?.baseLiquidCashBeforeContribution.amountMinor).toBe(
      80_000n,
    );
  });

  it('separates protected Sinking cash from one actual funded-spending outflow', () => {
    const [currentLiquidity] = currentMetrics(100_000n, 20_000n, 40_000n);
    const projection = scenario(100_000n, {
      occurrenceDays: [],
      changes: {
        10: { sinkingProtected: 30_000n, minimum: 50_000n, comfort: 70_000n },
        20: { sinkingSpend: 30_000n, sinkingProtected: 0n },
      },
    });
    const result = stressRecurringContribution({
      currentLiquidity,
      scenario: projection,
      candidate: createMoney(0n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(result.value?.endingLiquidCash?.amountMinor).toBe(70_000n);
    expect(projection.projectionDays[9]?.baseLiquidCashBeforeContribution.amountMinor).toBe(
      100_000n,
    );
  });

  it('lets projected Sinking protection fail a candidate without reducing base cash', () => {
    const [currentLiquidity] = currentMetrics(100_000n, 10_000n, 20_000n);
    const unprotected = stressRecurringContribution({
      currentLiquidity,
      scenario: scenario(100_000n, { occurrenceDays: [10] }),
      candidate: createMoney(20_000n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    const protectedResult = stressRecurringContribution({
      currentLiquidity,
      scenario: scenario(100_000n, {
        occurrenceDays: [10],
        changes: {
          30: { sinkingProtected: 30_000n, minimum: 85_000n, comfort: 85_000n },
        },
      }),
      candidate: createMoney(20_000n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(unprotected.value?.passes).toBe(true);
    expect(protectedResult.value?.passes).toBe(false);
    expect(protectedResult.value?.firstMinimumBreachDate).toBe(addLocalDays(EFFECTIVE_DATE, 30));
    expect(protectedResult.value?.endingLiquidCash?.amountMinor).toBe(
      unprotected.value?.endingLiquidCash?.amountMinor,
    );
  });

  it('applies normal spending and the supplied committed-obligation upper bound once', () => {
    const [currentLiquidity] = currentMetrics(100_000n, 10_000n, 20_000n);
    const result = stressRecurringContribution({
      currentLiquidity,
      scenario: scenario(100_000n, {
        occurrenceDays: [],
        changes: {
          10: { spending: 10_000n },
          20: { obligation: 55_000n },
        },
      }),
      candidate: createMoney(0n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(result.value?.endingLiquidCash?.amountMinor).toBe(35_000n);
  });

  it('reports a minimum breach separately from ending Comfort failure', () => {
    const [currentLiquidity] = currentMetrics(20_000n, 0n, 0n);
    const minimumFailure = stressRecurringContribution({
      currentLiquidity,
      scenario: scenario(20_000n, {
        occurrenceDays: [20],
        changes: Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [
            index + 37,
            { minimum: 15_000n, comfort: 15_000n },
          ]),
        ),
      }),
      candidate: createMoney(10_000n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(minimumFailure.value?.firstMinimumBreachDate).toBe(addLocalDays(EFFECTIVE_DATE, 37));

    const comfortFailure = stressRecurringContribution({
      currentLiquidity,
      scenario: scenario(20_000n, {
        occurrenceDays: [20],
        changes: { 60: { minimum: 5_000n, comfort: 15_000n } },
      }),
      candidate: createMoney(10_000n, EUR),
      settings: SETTINGS,
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'stress',
    });
    expect(comfortFailure.value?.minimumBreached).toBe(false);
    expect(comfortFailure.value?.endingComfortHeadroom?.amountMinor).toBe(-5_000n);
    expect(comfortFailure.value?.passes).toBe(false);
  });

  it('marks incomplete projection or contribution coverage partial and rejects cash mismatch', () => {
    const [currentLiquidity] = currentMetrics(100_000n);
    const calculate = (projection: ForwardLiquidityStressScenario) =>
      stressRecurringContribution({
        currentLiquidity,
        scenario: projection,
        candidate: createMoney(5_000n, EUR),
        settings: SETTINGS,
        asOf: AS_OF,
        engineVersion: '2f.0.0',
        settingsVersion: 'settings-1',
        inputWatermark: 'stress',
      });
    expect(calculate(scenario(100_000n, { omitDays: [30] })).status).toBe('partial');
    expect(
      calculate(
        scenario(100_000n, {
          completeThrough: addLocalDays(EFFECTIVE_DATE, 59),
          occurrenceDays: [],
        }),
      ).status,
    ).toBe('partial');
    const invalid = scenario(100_000n);
    const changed = [...invalid.projectionDays];
    changed[10] = {
      ...changed[10]!,
      baseLiquidCashBeforeContribution: createMoney(99_999n, EUR),
    };
    expect(() => calculate({ ...invalid, projectionDays: changed })).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() =>
      calculate({
        ...invalid,
        contributionSchedule: {
          ...invalid.contributionSchedule,
          occurrences: [
            {
              id: parseRecurringInvestmentOccurrenceId(uuid(899)),
              planId: PLAN_ID,
              date: EFFECTIVE_DATE,
            },
          ],
        },
      }),
    ).toThrow('already reflects contribution occurrences');
  });
});

describe('Investment Step-Up and Step-Down decision', () => {
  it('proposes only one safe upward step from complete median and Cash Drag evidence', () => {
    const result = evaluateInvestmentContributionStep(
      decisionInput(history([18_000n, 22_000n, 24_000n, 26_000n]), 5_000n),
    );
    const value = decisionValue(result);
    expect(result.status).toBe('complete');
    expect(value.kind).toBe('step_up');
    if (value.kind === 'step_up') {
      expect(value.proposedContribution.amountMinor).toBe(10_000n);
      expect(value.sustainableCapacity?.amountMinor).toBe(23_000n);
      expect(value.proposedStress.passes).toBe(true);
    }
  });

  it('uses the literal candidate formula for non-step-aligned current contribution', () => {
    const value = decisionValue(
      evaluateInvestmentContributionStep(
        decisionInput(history([12_500n, 12_500n, 12_500n, 12_500n]), 7_500n),
      ),
    );
    expect(value.kind).toBe('step_up');
    if (value.kind === 'step_up') expect(value.proposedContribution.amountMinor).toBe(10_000n);
  });

  it('holds when capacity is within one step or persistence evidence is absent/incomplete', () => {
    const within = evaluateInvestmentContributionStep(
      decisionInput(history([14_000n, 14_000n, 14_000n, 14_000n]), 10_000n),
    );
    expect(decisionValue(within)).toMatchObject({
      kind: 'hold',
      reasons: ['capacity_below_next_step'],
    });

    const noEvidence = evaluateInvestmentContributionStep(
      decisionInput(history([30_000n, 30_000n, 30_000n, 30_000n]), 5_000n, scenario(100_000n), {
        cashDrag: cashDragMetric(false),
      }),
    );
    expect(decisionValue(noEvidence)).toMatchObject({
      kind: 'hold',
      reasons: ['no_persistence_evidence'],
    });

    const partialEvidence = evaluateInvestmentContributionStep(
      decisionInput(history([30_000n, 30_000n, 30_000n, 30_000n]), 5_000n, scenario(100_000n), {
        cashDrag: cashDragMetric(true, 'partial'),
      }),
    );
    expect(partialEvidence.status).toBe('partial');
    expect(decisionValue(partialEvidence).kind).toBe('hold');
  });

  it('does not authorize Step-Up from provisional current Safe to Invest', () => {
    const base = decisionInput(history([30_000n, 30_000n, 30_000n, 30_000n]), 5_000n);
    const provisionalSafe = calculateSafeToInvest({
      liquidity: base.currentLiquidity,
      readiness: { kind: 'provisional', reasons: ['non_material_unresolved_transfer'] },
      settings: { recommendationIncrement: createMoney(1_000n, EUR) },
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'safe',
    });
    const result = evaluateInvestmentContributionStep({
      ...base,
      currentSafeToInvest: provisionalSafe,
    });
    expect(result.status).toBe('partial');
    expect(decisionValue(result)).toMatchObject({
      kind: 'hold',
      reasons: ['current_inputs_incomplete'],
    });
  });

  it('returns a partial hold for insufficient or unreliable recent history', () => {
    const short = evaluateInvestmentContributionStep(
      decisionInput(history([10_000n, 20_000n, 30_000n]), 5_000n),
    );
    expect(short.status).toBe('partial');
    expect(decisionValue(short)).toMatchObject({
      kind: 'hold',
      reasons: ['insufficient_cycle_history'],
    });

    const unreliable = evaluateInvestmentContributionStep(
      decisionInput(
        history([10_000n, 20_000n, 30_000n, 40_000n, 50_000n], { incompleteCycle: 4 }),
        5_000n,
      ),
    );
    expect(unreliable.status).toBe('partial');
    expect(decisionValue(unreliable).reasons).toContain('historical_capacity_uncertain');
  });

  it('holds current when the one-step candidate first breaches minimum cash', () => {
    const minimumByDay = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        index + 37,
        { minimum: 15_000n, comfort: 15_000n },
      ]),
    );
    const result = evaluateInvestmentContributionStep(
      decisionInput(
        history([30_000n, 30_000n, 30_000n, 30_000n]),
        5_000n,
        scenario(20_000n, { occurrenceDays: [20], changes: minimumByDay }),
        { cash: 20_000n, minimum: 0n, comfort: 0n },
      ),
    );
    const value = decisionValue(result);
    expect(value.kind).toBe('hold');
    if (value.kind === 'hold') {
      expect(value.rejectedStepUpStress?.firstMinimumBreachDate).toBe(
        addLocalDays(EFFECTIVE_DATE, 37),
      );
    }
  });

  it('steps down to the greatest decrement that passes complete stress', () => {
    const result = evaluateInvestmentContributionStep(
      decisionInput(
        history([30_000n, 30_000n, 30_000n, 30_000n]),
        15_000n,
        scenario(25_000n, {
          occurrenceDays: [10, 40],
          defaultMinimum: 10_000n,
          defaultComfort: 10_000n,
        }),
        { cash: 25_000n, minimum: 10_000n, comfort: 10_000n },
      ),
    );
    const value = decisionValue(result);
    expect(value.kind).toBe('step_down');
    if (value.kind === 'step_down') {
      expect(value.proposedContribution.amountMinor).toBe(5_000n);
      expect(value.proposedStress?.passes).toBe(true);
      expect(value.residualLiquidityBreach).toBe(false);
    }
  });

  it('steps down below sustainable capacity even when current stress passes', () => {
    const result = evaluateInvestmentContributionStep(
      decisionInput(history([12_000n, 12_000n, 12_000n, 12_000n]), 20_000n),
    );
    const value = decisionValue(result);
    expect(value.kind).toBe('step_down');
    if (value.kind === 'step_down') expect(value.proposedContribution.amountMinor).toBe(10_000n);
  });

  it('preserves a non-step-aligned decrement sequence', () => {
    const value = decisionValue(
      evaluateInvestmentContributionStep(
        decisionInput(history([10_000n, 10_000n, 10_000n, 10_000n]), 12_500n),
      ),
    );
    expect(value.kind).toBe('step_down');
    if (value.kind === 'step_down') expect(value.proposedContribution.amountMinor).toBe(7_500n);
  });

  it('selects zero and reports whether zero still breaches liquidity', () => {
    const zeroPasses = decisionValue(
      evaluateInvestmentContributionStep(
        decisionInput(
          history([30_000n, 30_000n, 30_000n, 30_000n]),
          10_000n,
          scenario(14_000n, {
            occurrenceDays: [10],
            defaultMinimum: 10_000n,
            defaultComfort: 10_000n,
          }),
          { cash: 14_000n, minimum: 10_000n, comfort: 10_000n },
        ),
      ),
    );
    expect(zeroPasses.kind).toBe('step_down');
    if (zeroPasses.kind === 'step_down') {
      expect(zeroPasses.proposedContribution.amountMinor).toBe(0n);
      expect(zeroPasses.residualLiquidityBreach).toBe(false);
    }

    const zeroFails = decisionValue(
      evaluateInvestmentContributionStep(
        decisionInput(
          history([30_000n, 30_000n, 30_000n, 30_000n]),
          10_000n,
          scenario(5_000n, {
            occurrenceDays: [10],
            changes: Object.fromEntries(
              Array.from({ length: 60 }, (_, index) => [
                index + 1,
                { minimum: 10_000n, comfort: 10_000n },
              ]),
            ),
          }),
          { cash: 5_000n, minimum: 10_000n, comfort: 10_000n },
        ),
      ),
    );
    expect(zeroFails.kind).toBe('step_down');
    if (zeroFails.kind === 'step_down') {
      expect(zeroFails.proposedContribution.amountMinor).toBe(0n);
      expect(zeroFails.residualLiquidityBreach).toBe(true);
    }

    const alreadyZero = evaluateInvestmentContributionStep(
      decisionInput(
        history([30_000n, 30_000n, 30_000n, 30_000n]),
        0n,
        scenario(5_000n, {
          occurrenceDays: [],
          changes: Object.fromEntries(
            Array.from({ length: 60 }, (_, index) => [
              index + 1,
              { minimum: 10_000n, comfort: 10_000n },
            ]),
          ),
        }),
        { cash: 5_000n, minimum: 10_000n, comfort: 10_000n },
      ),
    );
    expect(alreadyZero.status).toBe('complete');
    expect(decisionValue(alreadyZero)).toMatchObject({
      kind: 'hold',
      reasons: ['zero_contribution_still_breaches'],
    });
  });

  it('suppresses a repeated upward window but never suppresses a safety Step-Down', () => {
    const historical = history([30_000n, 30_000n, 30_000n, 30_000n]);
    const window = historical.value!.reassessmentCycleIds;
    const held = evaluateInvestmentContributionStep(
      decisionInput(historical, 5_000n, scenario(100_000n), { issuedWindow: window }),
    );
    expect(decisionValue(held)).toMatchObject({
      kind: 'hold',
      reasons: ['step_up_already_issued_for_window'],
    });

    const reduced = evaluateInvestmentContributionStep(
      decisionInput(historical, 15_000n, scenario(25_000n), {
        cash: 25_000n,
        minimum: 10_000n,
        comfort: 10_000n,
        issuedWindow: window,
      }),
    );
    expect(decisionValue(reduced).kind).toBe('step_down');
  });

  it('allows complete forward safety to reduce despite blocked invest-more readiness', () => {
    const base = decisionInput(
      history([30_000n, 30_000n, 30_000n, 30_000n]),
      15_000n,
      scenario(25_000n, {
        occurrenceDays: [10, 40],
        defaultMinimum: 10_000n,
        defaultComfort: 10_000n,
      }),
      { cash: 25_000n, minimum: 10_000n, comfort: 10_000n },
    );
    const blockedSafe = calculateSafeToInvest({
      liquidity: base.currentLiquidity,
      readiness: { kind: 'blocked', reasons: ['material_cash_variance'] },
      settings: { recommendationIncrement: createMoney(1_000n, EUR) },
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'blocked',
    });
    const result = evaluateInvestmentContributionStep({
      ...base,
      currentSafeToInvest: blockedSafe,
    });
    expect(result.status).toBe('complete');
    expect(decisionValue(result).kind).toBe('step_down');
  });

  it('returns a partial capacity-bounded Step-Down when forward stress is incomplete', () => {
    const result = evaluateInvestmentContributionStep(
      decisionInput(
        history([12_000n, 12_000n, 12_000n, 12_000n]),
        20_000n,
        scenario(100_000n, { omitDays: [30] }),
      ),
    );
    const value = decisionValue(result);
    expect(result.status).toBe('partial');
    expect(value.kind).toBe('step_down');
    if (value.kind === 'step_down') {
      expect(value.proposedContribution.amountMinor).toBe(10_000n);
      expect(value.residualLiquidityBreach).toBeNull();
    }
  });

  it('keeps exact bigint arithmetic above Number.MAX_SAFE_INTEGER', () => {
    const large = 9_007_199_254_740_992n;
    const result = history([large, large + 2n, large + 4n, large + 6n]);
    expect(result.value?.sustainableCapacity?.amountMinor).toBe(large + 3n);
  });

  it('rejects non-V1 settings and recurring-plan mismatches', () => {
    const base = decisionInput(history([30_000n, 30_000n, 30_000n, 30_000n]), 5_000n);
    expect(() =>
      evaluateInvestmentContributionStep({
        ...base,
        settings: { ...SETTINGS, stressHorizonDays: 61 },
      }),
    ).toThrow('requires four cycles, a 60-day horizon');
    expect(() =>
      evaluateInvestmentContributionStep({
        ...base,
        recurringPlanId: parseRecurringInvestmentPlanId(uuid(901)),
      }),
    ).toThrow('must use one recurring plan');
  });
});
