import {
  EUR,
  compareInstants,
  createCycleInvestmentCapacityReadiness,
  createForwardLiquidityProjectionCoverage,
  createForwardLiquidityProjectionDay,
  createInvestmentContribution,
  createInvestmentContributionAttribution,
  createMetricResult,
  createMoney,
  createPayCycle,
  createRecurringInvestmentSchedule,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseRecurringInvestmentPlanId,
} from '@personal-cfo/domain';
import type {
  CycleCapacityIssue,
  CycleInvestmentCapacityReadiness,
  DataWarning,
  ExplanationComponent,
  ForwardLiquidityProjectionCoverage,
  ForwardLiquidityProjectionDay,
  Instant,
  InvestmentContribution,
  InvestmentContributionAttribution,
  LocalDate,
  MetricResult,
  Money,
  PayCycle,
  PayCycleId,
  RecurringInvestmentPlanId,
  RecurringInvestmentSchedule,
  TransactionId,
} from '@personal-cfo/domain';

import type { CashDragAssessment } from './cash-drag.js';
import { FinancialEngineInvariantError } from './errors.js';
import { median } from './exact-math.js';
import type { LiquidityReserve } from './liquidity.js';
import { addLocalDays } from './local-calendar.js';
import type { SafeToInvest } from './safe-to-invest.js';

export type InvestmentStepSettings = Readonly<{
  historicalCycleCount: number;
  contributionStep: Money;
  stressHorizonDays: number;
}>;

export const DEFAULT_INVESTMENT_STEP_SETTINGS: InvestmentStepSettings = Object.freeze({
  historicalCycleCount: 4,
  contributionStep: createMoney(5_000n, EUR),
  stressHorizonDays: 60,
});

export type PreClosingSafeToInvestSnapshot = Readonly<{
  cycleId: PayCycleId;
  safeToInvest: MetricResult<SafeToInvest>;
}>;

export type CycleInvestmentCapacityObservation = Readonly<{
  cycleId: PayCycleId;
  startInclusive: Instant;
  endExclusive: Instant;
  closingSalaryTransactionId: TransactionId;
  recurringContributionTotal: Money;
  excludedAdHocContributionTotal: Money;
  preClosingRecommendedSafeToInvest: Money | null;
  cycleCapacity: Money | null;
  completeness: 'complete' | 'partial';
  issues: readonly CycleCapacityIssue[];
}>;

export type HistoricalInvestmentCapacity = Readonly<{
  recurringPlanId: RecurringInvestmentPlanId;
  observations: readonly CycleInvestmentCapacityObservation[];
  reassessmentCycleIds: readonly PayCycleId[];
  sustainableCapacity: Money | null;
  requiredCycleCount: number;
}>;

export type HistoricalInvestmentCapacityInput = Readonly<{
  payCycles: readonly PayCycle[];
  investmentContributions: readonly InvestmentContribution[];
  contributionAttributions: readonly InvestmentContributionAttribution[];
  recurringPlanId: RecurringInvestmentPlanId;
  cycleReadiness: readonly CycleInvestmentCapacityReadiness[];
  preClosingSafeToInvest: readonly PreClosingSafeToInvestSnapshot[];
  settings: InvestmentStepSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

export type ForwardLiquidityStressScenario = Readonly<{
  effectiveDate: LocalDate;
  projectionDays: readonly ForwardLiquidityProjectionDay[];
  projectionCoverage: ForwardLiquidityProjectionCoverage;
  contributionSchedule: RecurringInvestmentSchedule;
}>;

export type ContributionStressResult = Readonly<{
  candidate: Money;
  horizonStartInclusive: LocalDate;
  horizonEndInclusive: LocalDate;
  completeHorizon: boolean;
  evaluatedDays: number;
  incompleteDates: readonly LocalDate[];
  contributionOccurrences: number;
  passes: boolean;
  minimumBreached: boolean;
  firstMinimumBreachDate: LocalDate | null;
  endingLiquidCash: Money | null;
  endingMinimumCash: Money | null;
  endingComfortCash: Money | null;
  minimumHeadroomAtWorstPoint: Money | null;
  endingComfortHeadroom: Money | null;
}>;

export type ContributionStressInput = Readonly<{
  currentLiquidity: MetricResult<LiquidityReserve>;
  scenario: ForwardLiquidityStressScenario;
  candidate: Money;
  settings: InvestmentStepSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

export const INVESTMENT_STEP_DECISION_REASONS = [
  'insufficient_cycle_history',
  'historical_capacity_uncertain',
  'capacity_below_next_step',
  'no_persistence_evidence',
  'persistence_evidence_incomplete',
  'current_inputs_incomplete',
  'forward_stress_incomplete',
  'step_up_already_issued_for_window',
  'step_up_stress_failed',
  'step_up_stress_passed',
  'current_contribution_stress_failed',
  'current_above_sustainable_capacity',
  'step_down_stress_passed',
  'zero_contribution_still_breaches',
] as const;
export type InvestmentStepDecisionReason = (typeof INVESTMENT_STEP_DECISION_REASONS)[number];

type InvestmentContributionDecisionBase = Readonly<{
  currentContribution: Money;
  sustainableCapacity: Money | null;
  reassessmentCycleIds: readonly PayCycleId[];
  historicalObservations: readonly CycleInvestmentCapacityObservation[];
  currentStress: ContributionStressResult | null;
  reasons: readonly InvestmentStepDecisionReason[];
}>;

export type InvestmentContributionDecision =
  | (InvestmentContributionDecisionBase &
      Readonly<{
        kind: 'step_up';
        proposedContribution: Money;
        proposedStress: ContributionStressResult;
      }>)
  | (InvestmentContributionDecisionBase &
      Readonly<{
        kind: 'hold';
        rejectedStepUpStress: ContributionStressResult | null;
      }>)
  | (InvestmentContributionDecisionBase &
      Readonly<{
        kind: 'step_down';
        proposedContribution: Money;
        proposedStress: ContributionStressResult | null;
        residualLiquidityBreach: boolean | null;
      }>);

export type InvestmentContributionDecisionInput = Readonly<{
  recurringPlanId: RecurringInvestmentPlanId;
  historicalCapacity: MetricResult<HistoricalInvestmentCapacity>;
  currentLiquidity: MetricResult<LiquidityReserve>;
  currentSafeToInvest: MetricResult<SafeToInvest>;
  cashDrag: MetricResult<CashDragAssessment>;
  stressScenario: ForwardLiquidityStressScenario;
  currentContribution: Money;
  lastIssuedStepUpCycleIds: readonly PayCycleId[] | null;
  settings: InvestmentStepSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function validateSettings(settings: InvestmentStepSettings): InvestmentStepSettings {
  const contributionStep = createMoney(
    settings.contributionStep.amountMinor,
    settings.contributionStep.currency,
  );
  if (
    settings.historicalCycleCount !== 4 ||
    settings.stressHorizonDays !== 60 ||
    contributionStep.currency !== EUR ||
    contributionStep.amountMinor <= 0n
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_settings',
      'Stage 2F requires four cycles, a 60-day horizon, and a positive EUR contribution step.',
    );
  }
  return Object.freeze({ ...settings, contributionStep });
}

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) {
    throw new FinancialEngineInvariantError(code, message);
  }
}

function canonicalPayCycles(values: readonly PayCycle[]): readonly PayCycle[] {
  const cycles = values.map((item) => createPayCycle(item));
  requireUnique(
    cycles.map((item) => item.id),
    'investment_step.duplicate_pay_cycle',
    'Pay Cycle IDs must be unique.',
  );
  const sorted = [...cycles].sort((left, right) =>
    compareInstants(left.startInclusive, right.startInclusive),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    const prior = sorted[index - 1]!;
    const current = sorted[index]!;
    if (
      prior.status !== 'closed' ||
      prior.endExclusive !== current.startInclusive ||
      prior.closingSalaryTransactionId !== current.openingSalaryTransactionId
    ) {
      throw new FinancialEngineInvariantError(
        'investment_step.incoherent_pay_cycles',
        'Supplied Pay Cycles must form a coherent chain of actual salary boundaries.',
      );
    }
  }
  return Object.freeze(sorted);
}

function historicalExplanation(
  value: HistoricalInvestmentCapacity,
): readonly ExplanationComponent[] {
  const result: ExplanationComponent[] = value.observations.flatMap((item) => {
    const prefix = `historicalCapacity.${item.cycleId}`;
    const rows: ExplanationComponent[] = [
      {
        ruleId: 'investment-step.cycle-recurring-contributions',
        inputKey: `${prefix}.recurringContributionTotal`,
        value: item.recurringContributionTotal.amountMinor.toString(),
      },
      {
        ruleId: 'investment-step.cycle-ad-hoc-excluded',
        inputKey: `${prefix}.excludedAdHocContributionTotal`,
        value: item.excludedAdHocContributionTotal.amountMinor.toString(),
      },
    ];
    if (item.preClosingRecommendedSafeToInvest !== null) {
      rows.push({
        ruleId: 'investment-step.pre-closing-recommended-sti',
        inputKey: `${prefix}.preClosingRecommendedSafeToInvest`,
        value: item.preClosingRecommendedSafeToInvest.amountMinor.toString(),
      });
    }
    if (item.cycleCapacity !== null) {
      rows.push({
        ruleId: 'investment-step.cycle-capacity',
        inputKey: `${prefix}.cycleCapacity`,
        value: item.cycleCapacity.amountMinor.toString(),
      });
    }
    return rows;
  });
  if (value.sustainableCapacity !== null) {
    result.push({
      ruleId: 'investment-step.four-cycle-median',
      inputKey: 'sustainableCapacity',
      value: value.sustainableCapacity.amountMinor.toString(),
    });
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

function validateHistoricalSafeToInvest(value: SafeToInvest): void {
  const amounts = [
    value.conservative,
    value.recommended,
    value.maximum,
    value.unroundedConservative,
    value.unroundedRecommended,
    value.unroundedMaximum,
    value.conservativeRoundingLoss,
    value.recommendedRoundingLoss,
    value.maximumRoundingLoss,
    value.recommendationIncrement,
  ];
  const pairs = [
    [value.conservative, value.unroundedConservative, value.conservativeRoundingLoss],
    [value.recommended, value.unroundedRecommended, value.recommendedRoundingLoss],
    [value.maximum, value.unroundedMaximum, value.maximumRoundingLoss],
  ] as const;
  const increment = value.recommendationIncrement.amountMinor;
  if (
    amounts.some((amount) => amount.currency !== EUR || amount.amountMinor < 0n) ||
    increment <= 0n ||
    value.conservative.amountMinor > value.recommended.amountMinor ||
    value.recommended.amountMinor > value.maximum.amountMinor ||
    value.unroundedConservative.amountMinor > value.unroundedRecommended.amountMinor ||
    value.unroundedRecommended.amountMinor > value.unroundedMaximum.amountMinor ||
    pairs.some(
      ([rounded, unrounded, loss]) =>
        rounded.amountMinor > unrounded.amountMinor ||
        rounded.amountMinor % increment !== 0n ||
        unrounded.amountMinor - rounded.amountMinor !== loss.amountMinor ||
        loss.amountMinor >= increment,
    )
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_pre_closing_value',
      'A historical Safe-to-Invest snapshot must preserve exact Stage 2E tier and rounding invariants.',
    );
  }
}

export function calculateHistoricalInvestmentCapacity(
  input: HistoricalInvestmentCapacityInput,
): MetricResult<HistoricalInvestmentCapacity> {
  const asOf = parseInstant(input.asOf);
  const settings = validateSettings(input.settings);
  const recurringPlanId = parseRecurringInvestmentPlanId(input.recurringPlanId);
  const cycles = canonicalPayCycles(input.payCycles);
  const contributions = input.investmentContributions.map((item) =>
    createInvestmentContribution(item),
  );
  requireUnique(
    contributions.map((item) => item.transactionId),
    'investment_step.duplicate_contribution',
    'Investment contribution transaction IDs must be unique.',
  );
  const attributions = input.contributionAttributions.map((item) =>
    createInvestmentContributionAttribution(item),
  );
  requireUnique(
    attributions.map((item) => item.transactionId),
    'investment_step.duplicate_contribution_attribution',
    'Each investment contribution must have one attribution.',
  );
  const contributionsById = new Map(contributions.map((item) => [item.transactionId, item]));
  if (
    attributions.some((item) => !contributionsById.has(item.transactionId)) ||
    contributions.some(
      (item) =>
        !attributions.some((attribution) => attribution.transactionId === item.transactionId),
    )
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.incomplete_contribution_attribution',
      'Every supplied contribution must have exactly one matching attribution.',
    );
  }
  if (contributions.some((item) => item.principal.currency !== EUR)) {
    throw new FinancialEngineInvariantError(
      'investment_step.contribution_currency',
      'Historical investment contributions must use EUR reporting values.',
    );
  }

  const readiness = input.cycleReadiness.map((item) =>
    createCycleInvestmentCapacityReadiness(item),
  );
  requireUnique(
    readiness.map((item) => item.cycleId),
    'investment_step.duplicate_cycle_readiness',
    'Cycle readiness IDs must be unique.',
  );
  const readinessByCycle = new Map(readiness.map((item) => [item.cycleId, item]));
  requireUnique(
    input.preClosingSafeToInvest.map((item) => item.cycleId),
    'investment_step.duplicate_pre_closing_snapshot',
    'Each Pay Cycle can have one pre-closing Safe-to-Invest snapshot.',
  );
  const cyclesById = new Map(cycles.map((item) => [item.id, item]));
  if (readiness.some((item) => !cyclesById.has(item.cycleId))) {
    throw new FinancialEngineInvariantError(
      'investment_step.unknown_cycle_readiness',
      'Cycle readiness must reference a supplied Pay Cycle.',
    );
  }
  const snapshots = input.preClosingSafeToInvest.map((item) => {
    const cycleId = parsePayCycleId(item.cycleId);
    const cycle = cyclesById.get(cycleId);
    if (cycle === undefined || cycle.status !== 'closed' || cycle.endExclusive === null) {
      throw new FinancialEngineInvariantError(
        'investment_step.invalid_pre_closing_cycle',
        'A pre-closing snapshot must reference a supplied closed Pay Cycle.',
      );
    }
    if (
      compareInstants(item.safeToInvest.asOf, cycle.startInclusive) < 0 ||
      compareInstants(item.safeToInvest.asOf, cycle.endExclusive) >= 0
    ) {
      throw new FinancialEngineInvariantError(
        'investment_step.invalid_pre_closing_time',
        'A pre-closing snapshot must be inside its Pay Cycle and before closing salary.',
      );
    }
    if (item.safeToInvest.value !== null) validateHistoricalSafeToInvest(item.safeToInvest.value);
    return Object.freeze({ cycleId, safeToInvest: item.safeToInvest });
  });
  const snapshotsByCycle = new Map(snapshots.map((item) => [item.cycleId, item.safeToInvest]));
  const closed = cycles.filter(
    (cycle): cycle is PayCycle & { status: 'closed'; endExclusive: Instant } =>
      cycle.status === 'closed' && cycle.endExclusive !== null,
  );
  const selected = closed.slice(-settings.historicalCycleCount);
  const observations = selected.map((cycle): CycleInvestmentCapacityObservation => {
    const recurring: bigint[] = [];
    const adHoc: bigint[] = [];
    for (const attribution of attributions) {
      const contribution = contributionsById.get(attribution.transactionId)!;
      if (
        compareInstants(contribution.effectiveAt, cycle.startInclusive) < 0 ||
        compareInstants(contribution.effectiveAt, cycle.endExclusive) >= 0
      ) {
        continue;
      }
      if (attribution.kind === 'recurring_plan' && attribution.planId === recurringPlanId) {
        recurring.push(contribution.principal.amountMinor);
      } else {
        adHoc.push(contribution.principal.amountMinor);
      }
    }
    const recurringTotal = recurring.reduce((sum, amount) => sum + amount, 0n);
    const adHocTotal = adHoc.reduce((sum, amount) => sum + amount, 0n);
    const quality = readinessByCycle.get(cycle.id);
    const snapshot = snapshotsByCycle.get(cycle.id);
    const issues: CycleCapacityIssue[] = [];
    if (quality === undefined) issues.push('missing_cycle_readiness');
    else if (quality.kind === 'incomplete') issues.push(...quality.reasons);
    if (snapshot?.status !== 'complete' || snapshot.value === null) {
      issues.push('incomplete_pre_closing_safe_to_invest');
    }
    const uniqueIssues = Object.freeze([...new Set(issues)]);
    const recommended = snapshot?.status === 'complete' ? snapshot.value.recommended : null;
    const capacity = recommended === null ? null : money(recurringTotal + recommended.amountMinor);
    return Object.freeze({
      cycleId: cycle.id,
      startInclusive: cycle.startInclusive,
      endExclusive: cycle.endExclusive,
      closingSalaryTransactionId: cycle.closingSalaryTransactionId!,
      recurringContributionTotal: money(recurringTotal),
      excludedAdHocContributionTotal: money(adHocTotal),
      preClosingRecommendedSafeToInvest:
        recommended === null ? null : money(recommended.amountMinor),
      cycleCapacity: capacity,
      completeness: uniqueIssues.length === 0 ? 'complete' : 'partial',
      issues: uniqueIssues,
    });
  });
  const enough = selected.length === settings.historicalCycleCount;
  const reliable = enough && observations.every((item) => item.completeness === 'complete');
  const sustainable = reliable
    ? money(median(observations.map((item) => item.cycleCapacity!.amountMinor)))
    : null;
  const value = Object.freeze({
    recurringPlanId,
    observations: Object.freeze(observations),
    reassessmentCycleIds: Object.freeze(selected.map((item) => item.id)),
    sustainableCapacity: sustainable,
    requiredCycleCount: settings.historicalCycleCount,
  });
  const warnings: DataWarning[] = [];
  if (!enough) {
    warnings.push(
      warning('investment_step.insufficient_cycle_history', {
        observed: selected.length.toString(),
        required: settings.historicalCycleCount.toString(),
      }),
    );
  } else if (!reliable) {
    warnings.push(warning('investment_step.historical_capacity_uncertain'));
  }
  return createMetricResult({
    status: reliable ? 'complete' : 'partial',
    value,
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
    explanation: historicalExplanation(value),
    warnings,
  });
}

function stressExplanation(value: ContributionStressResult): readonly ExplanationComponent[] {
  const rows: ExplanationComponent[] = [
    {
      ruleId: 'investment-step.stress-candidate',
      inputKey: 'candidate',
      value: value.candidate.amountMinor.toString(),
    },
    {
      ruleId: 'investment-step.stress-occurrences',
      inputKey: 'contributionOccurrences',
      value: value.contributionOccurrences.toString(),
    },
    {
      ruleId: 'investment-step.stress-pass',
      inputKey: 'passes',
      value: value.passes.toString(),
    },
  ];
  for (const [inputKey, amount] of [
    ['minimumHeadroomAtWorstPoint', value.minimumHeadroomAtWorstPoint],
    ['endingLiquidCash', value.endingLiquidCash],
    ['endingMinimumCash', value.endingMinimumCash],
    ['endingComfortCash', value.endingComfortCash],
    ['endingComfortHeadroom', value.endingComfortHeadroom],
  ] as const) {
    if (amount !== null) {
      rows.push({
        ruleId: `investment-step.${inputKey}`,
        inputKey,
        value: amount.amountMinor.toString(),
      });
    }
  }
  return Object.freeze(rows.map((item) => Object.freeze(item)));
}

function metricBase(input: {
  readonly asOf: Instant;
  readonly engineVersion: string;
  readonly settingsVersion: string;
  readonly inputWatermark: string;
}) {
  return {
    asOf: parseInstant(input.asOf),
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
}

export function stressRecurringContribution(
  input: ContributionStressInput,
): MetricResult<ContributionStressResult> {
  const base = metricBase(input);
  const settings = validateSettings(input.settings);
  const effectiveDate = parseLocalDate(input.scenario.effectiveDate);
  const candidate = createMoney(input.candidate.amountMinor, input.candidate.currency);
  if (candidate.currency !== EUR || candidate.amountMinor < 0n) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_candidate',
      'A recurring contribution candidate must be non-negative EUR money.',
    );
  }
  if (
    input.currentLiquidity.asOf !== base.asOf ||
    input.currentLiquidity.settingsVersion !== input.settingsVersion
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.stress_metadata_mismatch',
      'Current liquidity must share the stress-test as-of and settings version.',
    );
  }
  if (input.currentLiquidity.value === null) {
    return createMetricResult<ContributionStressResult>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [
        ...input.currentLiquidity.warnings,
        warning('investment_step.missing_current_liquidity'),
      ],
    });
  }
  const current = input.currentLiquidity.value;
  if (
    current.currentLiquidCash.currency !== EUR ||
    current.currentLiquidCash.amountMinor < 0n ||
    current.operationalStartInclusive !== effectiveDate
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_stress_liquidity',
      'Stress testing requires non-negative current EUR cash at the effective date.',
    );
  }
  const coverage = createForwardLiquidityProjectionCoverage(input.scenario.projectionCoverage);
  const schedule = createRecurringInvestmentSchedule(input.scenario.contributionSchedule);
  const days = input.scenario.projectionDays.map((item) =>
    createForwardLiquidityProjectionDay(item),
  );
  requireUnique(
    days.map((item) => item.date),
    'investment_step.duplicate_projection_date',
    'Forward projection dates must be unique.',
  );
  if (
    days.some((day) =>
      [
        day.expectedPrimarySalaryInflow,
        day.normalSpendingOutflow,
        day.committedObligationOutflow,
        day.sinkingFundedSpendingOutflow,
        day.sinkingProtectedCash,
        day.baseLiquidCashBeforeContribution,
        day.minimumCash,
        day.comfortCash,
      ].some((amount) => amount.currency !== EUR),
    )
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.stress_currency',
      'All forward stress values must use EUR.',
    );
  }
  const horizonStart = addLocalDays(effectiveDate, 1);
  const horizonEnd = addLocalDays(effectiveDate, settings.stressHorizonDays);
  if (days.some((day) => day.date < horizonStart || day.date > horizonEnd)) {
    throw new FinancialEngineInvariantError(
      'investment_step.projection_outside_horizon',
      'Forward projection days must be inside the configured stress horizon.',
    );
  }
  if (schedule.occurrences.some((item) => item.date <= effectiveDate)) {
    throw new FinancialEngineInvariantError(
      'investment_step.current_or_past_occurrence',
      'Current cash already reflects contribution occurrences on or before the effective date.',
    );
  }
  const daysByDate = new Map(days.map((item) => [item.date, item]));
  const inHorizonOccurrences = schedule.occurrences
    .filter((item) => item.date <= horizonEnd)
    .sort((left, right) => {
      const byDate = left.date.localeCompare(right.date);
      return byDate !== 0 ? byDate : left.id.localeCompare(right.id);
    });
  const incompleteDates: LocalDate[] = [];
  let expectedBase = current.currentLiquidCash.amountMinor;
  let pathContiguous = true;
  let cumulativeOccurrences = 0;
  let minimumBreached = false;
  let firstMinimumBreachDate: LocalDate | null = null;
  let worstHeadroom: bigint | null = null;
  let endingLiquid: bigint | null = null;
  let endingMinimum: bigint | null = null;
  let endingComfort: bigint | null = null;
  let evaluatedDays = 0;
  for (let offset = 1; offset <= settings.stressHorizonDays; offset += 1) {
    const date = addLocalDays(effectiveDate, offset);
    const day = daysByDate.get(date);
    if (day === undefined) {
      incompleteDates.push(date);
      pathContiguous = false;
      continue;
    }
    const nextBase =
      expectedBase +
      day.expectedPrimarySalaryInflow.amountMinor -
      day.normalSpendingOutflow.amountMinor -
      day.committedObligationOutflow.amountMinor -
      day.sinkingFundedSpendingOutflow.amountMinor;
    if (pathContiguous && day.baseLiquidCashBeforeContribution.amountMinor !== nextBase) {
      throw new FinancialEngineInvariantError(
        'investment_step.projection_cash_mismatch',
        'Each complete forward day must reconcile from prior cash and named cash-flow components.',
      );
    }
    expectedBase = day.baseLiquidCashBeforeContribution.amountMinor;
    if (day.completeness !== 'complete') incompleteDates.push(date);
    cumulativeOccurrences += inHorizonOccurrences.filter((item) => item.date === date).length;
    const stressed = money(
      day.baseLiquidCashBeforeContribution.amountMinor -
        candidate.amountMinor * BigInt(cumulativeOccurrences),
    ).amountMinor;
    const headroom = stressed - day.minimumCash.amountMinor;
    if (worstHeadroom === null || headroom < worstHeadroom) worstHeadroom = headroom;
    if (headroom < 0n) {
      minimumBreached = true;
      firstMinimumBreachDate ??= date;
    }
    evaluatedDays += 1;
    if (date === horizonEnd) {
      endingLiquid = stressed;
      endingMinimum = day.minimumCash.amountMinor;
      endingComfort = day.comfortCash.amountMinor;
    }
  }
  const coverageComplete = Object.values(coverage).every((status) => status === 'complete');
  const completeHorizon =
    input.currentLiquidity.status === 'complete' &&
    coverageComplete &&
    schedule.completeThrough >= horizonEnd &&
    incompleteDates.length === 0 &&
    evaluatedDays === settings.stressHorizonDays;
  const endingComfortHeadroom =
    endingLiquid === null || endingComfort === null ? null : endingLiquid - endingComfort;
  const passes =
    completeHorizon &&
    !minimumBreached &&
    endingComfortHeadroom !== null &&
    endingComfortHeadroom >= 0n;
  const value = Object.freeze({
    candidate,
    horizonStartInclusive: horizonStart,
    horizonEndInclusive: horizonEnd,
    completeHorizon,
    evaluatedDays,
    incompleteDates: Object.freeze([...new Set(incompleteDates)].sort()),
    contributionOccurrences: inHorizonOccurrences.length,
    passes,
    minimumBreached,
    firstMinimumBreachDate,
    endingLiquidCash: endingLiquid === null ? null : money(endingLiquid),
    endingMinimumCash: endingMinimum === null ? null : money(endingMinimum),
    endingComfortCash: endingComfort === null ? null : money(endingComfort),
    minimumHeadroomAtWorstPoint: worstHeadroom === null ? null : money(worstHeadroom),
    endingComfortHeadroom: endingComfortHeadroom === null ? null : money(endingComfortHeadroom),
  });
  const warnings: DataWarning[] = [...input.currentLiquidity.warnings];
  if (!completeHorizon) {
    warnings.push(
      warning('investment_step.incomplete_forward_stress', {
        incompleteDays: value.incompleteDates.length.toString(),
      }),
    );
  }
  return createMetricResult({
    ...base,
    status: completeHorizon ? 'complete' : 'partial',
    value,
    explanation: stressExplanation(value),
    warnings,
  });
}

function validateHistoricalMetric(value: HistoricalInvestmentCapacity): void {
  parseRecurringInvestmentPlanId(value.recurringPlanId);
  requireUnique(
    value.reassessmentCycleIds,
    'investment_step.duplicate_reassessment_cycle',
    'Reassessment Pay Cycle IDs must be unique.',
  );
  const cycleIdsMatch =
    value.reassessmentCycleIds.length === value.observations.length &&
    value.reassessmentCycleIds.every(
      (cycleId, index) => cycleId === value.observations[index]?.cycleId,
    );
  const observationsReconcile = value.observations.every((item) => {
    const completeShape =
      item.completeness === 'complete' ? item.issues.length === 0 : item.issues.length > 0;
    const optionalAmounts = [item.preClosingRecommendedSafeToInvest, item.cycleCapacity].filter(
      (amount): amount is Money => amount !== null,
    );
    const capacityReconciles =
      item.preClosingRecommendedSafeToInvest === null
        ? item.cycleCapacity === null
        : item.cycleCapacity?.amountMinor ===
          item.recurringContributionTotal.amountMinor +
            item.preClosingRecommendedSafeToInvest.amountMinor;
    return (
      completeShape &&
      capacityReconciles &&
      optionalAmounts.every((amount) => amount.currency === EUR && amount.amountMinor >= 0n)
    );
  });
  const expectedSustainable =
    value.observations.length === 4 &&
    value.observations.every(
      (item) => item.completeness === 'complete' && item.cycleCapacity !== null,
    )
      ? median(value.observations.map((item) => item.cycleCapacity!.amountMinor))
      : null;
  if (
    value.requiredCycleCount !== 4 ||
    !cycleIdsMatch ||
    !observationsReconcile ||
    value.observations.some(
      (item) =>
        item.recurringContributionTotal.currency !== EUR ||
        item.excludedAdHocContributionTotal.currency !== EUR ||
        item.recurringContributionTotal.amountMinor < 0n ||
        item.excludedAdHocContributionTotal.amountMinor < 0n,
    ) ||
    (value.sustainableCapacity !== null &&
      (value.sustainableCapacity.currency !== EUR ||
        value.sustainableCapacity.amountMinor < 0n ||
        value.observations.length !== 4 ||
        value.observations.some(
          (item) => item.completeness !== 'complete' || item.cycleCapacity === null,
        ))) ||
    (value.sustainableCapacity?.amountMinor ?? null) !== expectedSustainable
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_historical_metric',
      'Historical capacity must preserve Stage 2F observation and sustainable-capacity invariants.',
    );
  }
}

function orderedReasons(
  reasons: readonly InvestmentStepDecisionReason[],
): readonly InvestmentStepDecisionReason[] {
  const unique = new Set(reasons);
  return Object.freeze(INVESTMENT_STEP_DECISION_REASONS.filter((reason) => unique.has(reason)));
}

function decisionExplanation(
  value: InvestmentContributionDecision,
): readonly ExplanationComponent[] {
  const result: ExplanationComponent[] = [
    {
      ruleId: 'investment-step.current-contribution',
      inputKey: 'currentContribution',
      value: value.currentContribution.amountMinor.toString(),
    },
    { ruleId: 'investment-step.decision', inputKey: 'kind', value: value.kind },
  ];
  if (value.sustainableCapacity !== null) {
    result.push({
      ruleId: 'investment-step.sustainable-capacity',
      inputKey: 'sustainableCapacity',
      value: value.sustainableCapacity.amountMinor.toString(),
    });
  }
  if (value.kind !== 'hold') {
    result.push({
      ruleId: 'investment-step.proposed-contribution',
      inputKey: 'proposedContribution',
      value: value.proposedContribution.amountMinor.toString(),
    });
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

function sameCycleWindow(
  left: readonly PayCycleId[] | null,
  right: readonly PayCycleId[],
): boolean {
  return (
    left !== null &&
    left.length === right.length &&
    left.every((cycleId, index) => cycleId === right[index])
  );
}

function createDecisionResult(
  input: InvestmentContributionDecisionInput,
  status: 'complete' | 'partial',
  value: InvestmentContributionDecision,
  inheritedWarnings: readonly DataWarning[],
): MetricResult<InvestmentContributionDecision> {
  return createMetricResult({
    status,
    value: Object.freeze(value),
    asOf: input.asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
    explanation: decisionExplanation(value),
    warnings: [
      ...inheritedWarnings,
      ...value.reasons.map((reason) => warning(`investment_step.${reason}`)),
    ],
  });
}

function stressFor(
  input: InvestmentContributionDecisionInput,
  candidateMinor: bigint,
): MetricResult<ContributionStressResult> {
  return stressRecurringContribution({
    currentLiquidity: input.currentLiquidity,
    scenario: input.stressScenario,
    candidate: money(candidateMinor),
    settings: input.settings,
    asOf: input.asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  });
}

function ceilDividePositive(numerator: bigint, denominator: bigint): bigint {
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

function candidateAfterDecrements(current: bigint, step: bigint, decrements: bigint): bigint {
  const result = current - step * decrements;
  return result > 0n ? result : 0n;
}

function capacityDecrement(current: bigint, sustainable: bigint | null, step: bigint): bigint {
  if (sustainable === null || sustainable >= current) return 1n;
  const decrement = ceilDividePositive(current - sustainable, step);
  return decrement > 0n ? decrement : 1n;
}

function findStepDownCandidate(
  input: InvestmentContributionDecisionInput,
  current: bigint,
  sustainable: bigint | null,
  currentFailed: boolean,
): Readonly<{
  candidate: bigint;
  stress: MetricResult<ContributionStressResult>;
  residual: boolean;
}> {
  const step = input.settings.contributionStep.amountMinor;
  let low = capacityDecrement(current, sustainable, step);
  if (!currentFailed && sustainable === null) low = 1n;
  const high = ceilDividePositive(current, step);
  if (low > high) low = high;
  let left = low;
  let right = high;
  while (left < right) {
    const middle = (left + right) / 2n;
    const stress = stressFor(input, candidateAfterDecrements(current, step, middle));
    if (stress.status === 'complete' && stress.value?.passes === true) right = middle;
    else left = middle + 1n;
  }
  const candidate = candidateAfterDecrements(current, step, left);
  const stress = stressFor(input, candidate);
  if (stress.status === 'complete' && stress.value?.passes === true) {
    return Object.freeze({ candidate, stress, residual: false });
  }
  const zeroStress = candidate === 0n ? stress : stressFor(input, 0n);
  return Object.freeze({ candidate: 0n, stress: zeroStress, residual: true });
}

export function evaluateInvestmentContributionStep(
  input: InvestmentContributionDecisionInput,
): MetricResult<InvestmentContributionDecision> {
  const base = metricBase(input);
  const settings = validateSettings(input.settings);
  const current = createMoney(
    input.currentContribution.amountMinor,
    input.currentContribution.currency,
  );
  if (current.currency !== EUR || current.amountMinor < 0n) {
    throw new FinancialEngineInvariantError(
      'investment_step.invalid_current_contribution',
      'Current recurring contribution must be non-negative EUR money.',
    );
  }
  const recurringPlanId = parseRecurringInvestmentPlanId(input.recurringPlanId);
  const schedule = createRecurringInvestmentSchedule(input.stressScenario.contributionSchedule);
  if (
    schedule.planId !== recurringPlanId ||
    (input.historicalCapacity.value !== null &&
      input.historicalCapacity.value.recurringPlanId !== recurringPlanId)
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.plan_mismatch',
      'Historical attribution, current contribution, and forward schedule must use one recurring plan.',
    );
  }
  for (const metric of [
    input.historicalCapacity,
    input.currentLiquidity,
    input.currentSafeToInvest,
    input.cashDrag,
  ]) {
    if (metric.asOf !== base.asOf || metric.settingsVersion !== input.settingsVersion) {
      throw new FinancialEngineInvariantError(
        'investment_step.upstream_metadata_mismatch',
        'Stage 2F upstream metrics must share as-of and settings version.',
      );
    }
  }
  if (input.historicalCapacity.value !== null) {
    validateHistoricalMetric(input.historicalCapacity.value);
    if (
      input.historicalCapacity.status !== 'complete' &&
      input.historicalCapacity.value.sustainableCapacity !== null
    ) {
      throw new FinancialEngineInvariantError(
        'investment_step.provisional_sustainable_capacity',
        'Incomplete historical capacity cannot expose a sustainable capacity value.',
      );
    }
  }
  if (
    input.currentSafeToInvest.status === 'complete' &&
    input.currentLiquidity.status !== 'complete'
  ) {
    throw new FinancialEngineInvariantError(
      'investment_step.inconsistent_current_completeness',
      'Complete current Safe to Invest requires complete current liquidity.',
    );
  }
  const issuedWindow =
    input.lastIssuedStepUpCycleIds === null
      ? null
      : Object.freeze(input.lastIssuedStepUpCycleIds.map((item) => parsePayCycleId(item)));
  if (issuedWindow !== null) {
    requireUnique(
      issuedWindow,
      'investment_step.duplicate_issued_window_cycle',
      'An issued Step-Up window cannot contain duplicate Pay Cycle IDs.',
    );
  }
  const history = input.historicalCapacity.value;
  const observations = history?.observations ?? Object.freeze([]);
  const cycleIds = history?.reassessmentCycleIds ?? Object.freeze([]);
  const sustainable =
    input.historicalCapacity.status === 'complete' ? (history?.sustainableCapacity ?? null) : null;
  const inheritedWarnings = [
    ...input.historicalCapacity.warnings,
    ...input.currentLiquidity.warnings,
    ...input.currentSafeToInvest.warnings,
    ...input.cashDrag.warnings,
  ];
  const currentStressMetric = stressFor(input, current.amountMinor);
  const currentStress = currentStressMetric.value;
  const common = {
    currentContribution: current,
    sustainableCapacity: sustainable,
    reassessmentCycleIds: Object.freeze([...cycleIds]),
    historicalObservations: Object.freeze([...observations]),
    currentStress,
  } as const;
  const currentStressComplete = currentStressMetric.status === 'complete' && currentStress !== null;
  const currentFailed = currentStressComplete && !currentStress.passes;
  const aboveCapacity = sustainable !== null && current.amountMinor > sustainable.amountMinor;

  if ((currentFailed || aboveCapacity) && current.amountMinor > 0n) {
    const reasons: InvestmentStepDecisionReason[] = [];
    if (currentFailed) reasons.push('current_contribution_stress_failed');
    if (aboveCapacity) reasons.push('current_above_sustainable_capacity');
    if (currentStressComplete) {
      const selected = findStepDownCandidate(
        input,
        current.amountMinor,
        sustainable?.amountMinor ?? null,
        currentFailed,
      );
      reasons.push(
        selected.residual ? 'zero_contribution_still_breaches' : 'step_down_stress_passed',
      );
      const value: InvestmentContributionDecision = Object.freeze({
        ...common,
        kind: 'step_down',
        proposedContribution: money(selected.candidate),
        proposedStress: selected.stress.value,
        residualLiquidityBreach: selected.residual,
        reasons: orderedReasons(reasons),
      });
      return createDecisionResult(input, 'complete', value, inheritedWarnings);
    }
    if (aboveCapacity) {
      const decrement = capacityDecrement(
        current.amountMinor,
        sustainable.amountMinor,
        settings.contributionStep.amountMinor,
      );
      const candidate = candidateAfterDecrements(
        current.amountMinor,
        settings.contributionStep.amountMinor,
        decrement,
      );
      reasons.push('forward_stress_incomplete');
      const proposedStress = stressFor(input, candidate);
      const value: InvestmentContributionDecision = Object.freeze({
        ...common,
        kind: 'step_down',
        proposedContribution: money(candidate),
        proposedStress: proposedStress.value,
        residualLiquidityBreach: null,
        reasons: orderedReasons(reasons),
      });
      return createDecisionResult(input, 'partial', value, inheritedWarnings);
    }
  }

  if (currentStressComplete && currentFailed && current.amountMinor === 0n) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons(['zero_contribution_still_breaches']),
    });
    return createDecisionResult(input, 'complete', value, inheritedWarnings);
  }
  if (!currentStressComplete || currentStress?.passes !== true) {
    return createMetricResult<InvestmentContributionDecision>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [...inheritedWarnings, warning('investment_step.forward_stress_incomplete')],
    });
  }
  if (sustainable === null) {
    const reason: InvestmentStepDecisionReason =
      history === null || history.observations.length < settings.historicalCycleCount
        ? 'insufficient_cycle_history'
        : 'historical_capacity_uncertain';
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons([reason]),
    });
    return createDecisionResult(input, 'partial', value, inheritedWarnings);
  }
  const nextStep = money(current.amountMinor + settings.contributionStep.amountMinor);
  if (sustainable.amountMinor < nextStep.amountMinor) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons(['capacity_below_next_step']),
    });
    return createDecisionResult(input, 'complete', value, inheritedWarnings);
  }
  if (sameCycleWindow(issuedWindow, cycleIds)) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons(['step_up_already_issued_for_window']),
    });
    return createDecisionResult(input, 'complete', value, inheritedWarnings);
  }
  const currentInputsComplete =
    input.currentLiquidity.status === 'complete' && input.currentSafeToInvest.status === 'complete';
  const persistenceComplete = input.cashDrag.status === 'complete';
  const persistenceEligible = persistenceComplete && input.cashDrag.value?.eligible === true;
  if (!currentInputsComplete || !persistenceComplete) {
    const reasons: InvestmentStepDecisionReason[] = [];
    if (!currentInputsComplete) reasons.push('current_inputs_incomplete');
    if (!persistenceComplete) reasons.push('persistence_evidence_incomplete');
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons(reasons),
    });
    return createDecisionResult(input, 'partial', value, inheritedWarnings);
  }
  if (!persistenceEligible) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: null,
      reasons: orderedReasons(['no_persistence_evidence']),
    });
    return createDecisionResult(input, 'complete', value, inheritedWarnings);
  }
  const flooredCapacity =
    (sustainable.amountMinor / settings.contributionStep.amountMinor) *
    settings.contributionStep.amountMinor;
  const initialCandidate =
    nextStep.amountMinor < flooredCapacity ? nextStep.amountMinor : flooredCapacity;
  const candidateStressMetric = stressFor(input, initialCandidate);
  const candidateStress = candidateStressMetric.value;
  if (candidateStressMetric.status !== 'complete' || candidateStress === null) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: candidateStress,
      reasons: orderedReasons(['forward_stress_incomplete']),
    });
    return createDecisionResult(input, 'partial', value, inheritedWarnings);
  }
  if (!candidateStress.passes) {
    const value: InvestmentContributionDecision = Object.freeze({
      ...common,
      kind: 'hold',
      rejectedStepUpStress: candidateStress,
      reasons: orderedReasons(['step_up_stress_failed']),
    });
    return createDecisionResult(input, 'complete', value, inheritedWarnings);
  }
  const value: InvestmentContributionDecision = Object.freeze({
    ...common,
    kind: 'step_up',
    proposedContribution: money(initialCandidate),
    proposedStress: candidateStress,
    reasons: orderedReasons(['step_up_stress_passed']),
  });
  return createDecisionResult(input, 'complete', value, inheritedWarnings);
}
