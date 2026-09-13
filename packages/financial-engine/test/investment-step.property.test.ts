import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createInvestmentContribution,
  createMetricResult,
  createMoney,
  createPayCycle,
  parseAccountId,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseRecurringInvestmentOccurrenceId,
  parseRecurringInvestmentPlanId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type { MetricResult, PayCycle } from '@personal-cfo/domain';

import {
  DEFAULT_INVESTMENT_STEP_SETTINGS,
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
const BOUNDARIES = [
  '2026-01-01T08:00:00Z',
  '2026-02-01T08:00:00Z',
  '2026-03-01T08:00:00Z',
  '2026-04-01T08:00:00Z',
  '2026-05-01T08:00:00Z',
] as const;

function metric<T>(value: T, asOf = AS_OF): MetricResult<T> {
  return createMetricResult({
    status: 'complete',
    value,
    asOf,
    engineVersion: '2f.0.0',
    settingsVersion: 's1',
    inputWatermark: 'property',
    explanation: [],
    warnings: [],
  });
}

function payCycles(): readonly PayCycle[] {
  return Object.freeze(
    Array.from({ length: 4 }, (_, index) =>
      createPayCycle({
        id: parsePayCycleId(uuid(index + 1)),
        openingSalaryTransactionId: parseTransactionId(uuid(index + 1)),
        startInclusive: parseInstant(BOUNDARIES[index]!),
        startDate: parseLocalDate(BOUNDARIES[index]!.slice(0, 10)),
        closingSalaryTransactionId: parseTransactionId(uuid(index + 2)),
        endExclusive: parseInstant(BOUNDARIES[index + 1]!),
        expectedNextPayDate: null,
        status: 'closed',
      }),
    ),
  );
}

function safeValue(recommended: bigint): SafeToInvest {
  const value = createMoney(recommended, EUR);
  const zero = createMoney(0n, EUR);
  return Object.freeze({
    conservative: value,
    recommended: value,
    maximum: value,
    unroundedConservative: value,
    unroundedRecommended: value,
    unroundedMaximum: value,
    conservativeRoundingLoss: zero,
    recommendedRoundingLoss: zero,
    maximumRoundingLoss: zero,
    recommendationIncrement: createMoney(1n, EUR),
    liquidCash: value,
    minimumCash: zero,
    comfortCash: zero,
    variabilityBuffer: zero,
  });
}

function historical(
  capacities: readonly bigint[],
  order: readonly number[] = [0, 1, 2, 3],
): MetricResult<HistoricalInvestmentCapacity> {
  const cycles = payCycles();
  return calculateHistoricalInvestmentCapacity({
    payCycles: order.map((index) => cycles[index]!),
    investmentContributions: [],
    contributionAttributions: [],
    recurringPlanId: PLAN_ID,
    cycleReadiness: order.map((index) => ({
      cycleId: cycles[index]!.id,
      kind: 'complete',
      reasons: [],
    })),
    preClosingSafeToInvest: order.map((index) => ({
      cycleId: cycles[index]!.id,
      safeToInvest: metric(
        safeValue(capacities[index]!),
        parseInstant(`${cycles[index]!.endExclusive!.slice(0, 10)}T00:00:00Z`),
      ),
    })),
    settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
    asOf: AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 's1',
    inputWatermark: 'history',
  });
}

function liquidity(cash: bigint, minimum = 10_000n, comfort = 20_000n): LiquidityReserve {
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

function projection(
  cash: bigint,
  occurrenceDays: readonly number[],
  order: readonly number[] = Array.from({ length: 60 }, (_, index) => index),
): ForwardLiquidityStressScenario {
  const chronological = Array.from({ length: 60 }, (_, index) => ({
    date: addLocalDays(EFFECTIVE_DATE, index + 1),
    expectedPrimarySalaryInflow: createMoney(0n, EUR),
    normalSpendingOutflow: createMoney(0n, EUR),
    committedObligationOutflow: createMoney(0n, EUR),
    sinkingFundedSpendingOutflow: createMoney(0n, EUR),
    sinkingProtectedCash: createMoney(0n, EUR),
    baseLiquidCashBeforeContribution: createMoney(cash, EUR),
    minimumCash: createMoney(10_000n, EUR),
    comfortCash: createMoney(20_000n, EUR),
    completeness: 'complete' as const,
  }));
  return {
    effectiveDate: EFFECTIVE_DATE,
    projectionDays: order.map((index) => chronological[index]!),
    projectionCoverage: {
      expectedPrimarySalary: 'complete',
      normalSpending: 'complete',
      committedObligations: 'complete',
      sinkingProtection: 'complete',
    },
    contributionSchedule: {
      planId: PLAN_ID,
      occurrences: occurrenceDays.map((offset, index) => ({
        id: parseRecurringInvestmentOccurrenceId(uuid(800 + index)),
        planId: PLAN_ID,
        date: addLocalDays(EFFECTIVE_DATE, offset),
      })),
      completeThrough: addLocalDays(EFFECTIVE_DATE, 60),
    },
  };
}

function currentMetrics(
  cash: bigint,
): readonly [MetricResult<LiquidityReserve>, MetricResult<SafeToInvest>] {
  const reserve = metric(liquidity(cash));
  return [
    reserve,
    calculateSafeToInvest({
      liquidity: reserve,
      readiness: { kind: 'complete' },
      settings: { recommendationIncrement: createMoney(1_000n, EUR) },
      asOf: AS_OF,
      engineVersion: '2f.0.0',
      settingsVersion: 's1',
      inputWatermark: 'safe',
    }),
  ];
}

function cashDrag(): MetricResult<CashDragAssessment> {
  const zero = createMoney(0n, EUR);
  return metric({
    eligible: true,
    windowStartInclusive: parseLocalDate('2026-07-17'),
    windowEndInclusive: EFFECTIVE_DATE,
    completeDays: 60,
    incompleteDays: 0,
    missingDays: 0,
    positiveExcessDays: 60,
    totalExcess: zero,
    currentExcess: zero,
    averageExcess: zero,
    absoluteThreshold: zero,
    relativeThreshold: zero,
    effectiveThreshold: zero,
    actionCap: zero,
    suppressionReasons: [],
  });
}

function decision(
  capacities: readonly bigint[],
  current: bigint,
  cash: bigint,
): ReturnType<typeof evaluateInvestmentContributionStep> {
  const [currentLiquidity, currentSafeToInvest] = currentMetrics(cash);
  const input: InvestmentContributionDecisionInput = {
    recurringPlanId: PLAN_ID,
    historicalCapacity: historical(capacities),
    currentLiquidity,
    currentSafeToInvest,
    cashDrag: cashDrag(),
    stressScenario: projection(cash, [10, 40]),
    currentContribution: createMoney(current, EUR),
    lastIssuedStepUpCycleIds: null,
    settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
    asOf: AS_OF,
    engineVersion: '2f.0.0',
    settingsVersion: 's1',
    inputWatermark: 'decision',
  };
  return evaluateInvestmentContributionStep(input);
}

describe('Investment Step properties', () => {
  it('keeps four-cycle sustainable capacity invariant under input ordering', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.bigInt({ min: 0n, max: 1_000_000n }),
          fc.bigInt({ min: 0n, max: 1_000_000n }),
          fc.bigInt({ min: 0n, max: 1_000_000n }),
          fc.bigInt({ min: 0n, max: 1_000_000n }),
        ),
        fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }),
        (capacities, order) => {
          expect(historical(capacities, order).value?.sustainableCapacity).toEqual(
            historical(capacities).value?.sustainableCapacity,
          );
        },
      ),
      { seed: 2_026_030, numRuns: 100 },
    );
  });

  it('makes stress monotonic in candidate amount and projected ending cash', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 30_000n }),
        fc.bigInt({ min: 0n, max: 30_000n }),
        (first, increment) => {
          const [currentLiquidity] = currentMetrics(100_000n);
          const calculate = (candidate: bigint) =>
            stressRecurringContribution({
              currentLiquidity,
              scenario: projection(100_000n, [10, 40]),
              candidate: createMoney(candidate, EUR),
              settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
              asOf: AS_OF,
              engineVersion: '2f.0.0',
              settingsVersion: 's1',
              inputWatermark: 'stress',
            }).value!;
          const lower = calculate(first);
          const higher = calculate(first + increment);
          expect(higher.endingLiquidCash!.amountMinor).toBeLessThanOrEqual(
            lower.endingLiquidCash!.amountMinor,
          );
          if (!lower.passes) expect(higher.passes).toBe(false);
        },
      ),
      { seed: 2_026_031, numRuns: 100 },
    );
  });

  it('bounds every Step-Up by one step and floored sustainable capacity', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 5_000n, max: 40_000n }),
        fc.bigInt({ min: 0n, max: 20_000n }),
        (sustainable, current) => {
          const result = decision(
            [sustainable, sustainable, sustainable, sustainable],
            current,
            1_000_000n,
          );
          if (result.value?.kind !== 'step_up') return;
          const proposed = result.value.proposedContribution.amountMinor;
          expect(proposed).toBeLessThanOrEqual(current + 5_000n);
          expect(proposed).toBeLessThanOrEqual((sustainable / 5_000n) * 5_000n);
          expect(proposed).toBeGreaterThan(current);
        },
      ),
      { seed: 2_026_032, numRuns: 100 },
    );
  });

  it('selects a strictly lower Step-Down and no greater tested candidate can pass', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 10_000n, max: 40_000n }), (current) => {
        const result = decision([100_000n, 100_000n, 100_000n, 100_000n], current, 20_000n);
        if (result.value?.kind !== 'step_down') return;
        const selected = result.value.proposedContribution.amountMinor;
        expect(selected).toBeLessThan(current);
        if (selected + 5_000n < current) {
          const [currentLiquidity] = currentMetrics(20_000n);
          const greater = stressRecurringContribution({
            currentLiquidity,
            scenario: projection(20_000n, [10, 40]),
            candidate: createMoney(selected + 5_000n, EUR),
            settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
            asOf: AS_OF,
            engineVersion: '2f.0.0',
            settingsVersion: 's1',
            inputWatermark: 'stress',
          });
          expect(greater.value?.passes).toBe(false);
        }
      }),
      { seed: 2_026_033, numRuns: 80 },
    );
  });

  it('is independent of contribution and projection input order', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray([...Array(60).keys()], { minLength: 60, maxLength: 60 }),
        (dayOrder) => {
          const cycles = payCycles();
          const contributionA = createInvestmentContribution({
            transactionId: parseTransactionId(uuid(500)),
            investmentAccountId: parseAccountId(uuid(700)),
            principal: createMoney(1_000n, EUR),
            effectiveAt: parseInstant('2026-01-10T00:00:00Z'),
          });
          const contributionB = createInvestmentContribution({
            transactionId: parseTransactionId(uuid(501)),
            investmentAccountId: parseAccountId(uuid(700)),
            principal: createMoney(2_000n, EUR),
            effectiveAt: parseInstant('2026-01-20T00:00:00Z'),
          });
          const base = {
            payCycles: cycles,
            recurringPlanId: PLAN_ID,
            cycleReadiness: cycles.map((cycle) => ({
              cycleId: cycle.id,
              kind: 'complete' as const,
              reasons: [],
            })),
            preClosingSafeToInvest: cycles.map((cycle) => ({
              cycleId: cycle.id,
              safeToInvest: metric(
                safeValue(10_000n),
                parseInstant(`${cycle.endExclusive!.slice(0, 10)}T00:00:00Z`),
              ),
            })),
            settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
            asOf: AS_OF,
            engineVersion: '2f.0.0',
            settingsVersion: 's1',
            inputWatermark: 'order',
          } as const;
          const forward = calculateHistoricalInvestmentCapacity({
            ...base,
            investmentContributions: [contributionA, contributionB],
            contributionAttributions: [
              {
                transactionId: contributionA.transactionId,
                kind: 'recurring_plan',
                planId: PLAN_ID,
              },
              { transactionId: contributionB.transactionId, kind: 'ad_hoc' },
            ],
          });
          const reverse = calculateHistoricalInvestmentCapacity({
            ...base,
            investmentContributions: [contributionB, contributionA],
            contributionAttributions: [
              { transactionId: contributionB.transactionId, kind: 'ad_hoc' },
              {
                transactionId: contributionA.transactionId,
                kind: 'recurring_plan',
                planId: PLAN_ID,
              },
            ],
          });
          expect(reverse.value).toEqual(forward.value);

          const [currentLiquidity] = currentMetrics(100_000n);
          const calculate = (scenario: ForwardLiquidityStressScenario) =>
            stressRecurringContribution({
              currentLiquidity,
              scenario,
              candidate: createMoney(5_000n, EUR),
              settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
              asOf: AS_OF,
              engineVersion: '2f.0.0',
              settingsVersion: 's1',
              inputWatermark: 'order',
            }).value;
          expect(calculate(projection(100_000n, [40, 10], dayOrder))).toEqual(
            calculate(projection(100_000n, [10, 40])),
          );
        },
      ),
      { seed: 2_026_034, numRuns: 30 },
    );
  });
});
