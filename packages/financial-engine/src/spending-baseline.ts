import {
  EUR,
  createCalendarMonthCoverage,
  createEconomicFlow,
  createExactFraction,
  createMetricResult,
  createMoney,
  createScheduledSpending,
  createSpendingObservation,
  parseInstant,
  parseYearMonth,
  yearMonthOf,
} from '@personal-cfo/domain';
import type {
  CalendarMonthCoverage,
  DataWarning,
  EconomicFlow,
  ExactFraction,
  ExplanationComponent,
  Instant,
  MetricResult,
  Money,
  ScheduledSpending,
  SpendingCategoryId,
  SpendingObservation,
  YearMonth,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import { median, multiplyFractionHalfEven, nearestRank } from './exact-math.js';
import { priorYearMonths } from './local-calendar.js';
import type { FundedConsumptionCoverage } from './sinking-funds.js';

export type SpendingBaselineSettings = Readonly<{
  baselineWindowMonths: number;
  minimumCompleteMonths: number;
  maximumBaselineLookbackMonths: number;
  materialityThreshold: Money;
  variabilityPercentile: ExactFraction;
  seasonalityMinimumMonths: number;
  seasonalityCap: ExactFraction;
  fallbackNormalBaseline: Money | null;
  fallbackEssentialBaseline: Money | null;
}>;

export type SpendingBaseline = Readonly<{
  normalBaseline: Money;
  essentialBaseline: Money;
  recurringNormal: Money;
  recurringEssential: Money;
  variableNormal: Money;
  variableEssential: Money;
  variabilityBuffer: Money;
  excludedIrregular: Money;
  excludedFundedConsumption: Money;
  excludedReversalExcess: Money;
  eligibleCompleteMonths: number;
  historicalWindowUsed: readonly YearMonth[];
  seasonalAdjustment: ExactFraction | null;
  source: 'historical' | 'fallback';
}>;

export type SpendingBaselineInput = Readonly<{
  economicFlows: readonly EconomicFlow[];
  observations: readonly SpendingObservation[];
  monthCoverage: readonly CalendarMonthCoverage[];
  scheduledRecurring: readonly ScheduledSpending[];
  recurringScheduleComplete: boolean;
  fundedConsumptionCoverage: MetricResult<FundedConsumptionCoverage>;
  targetMonth: YearMonth;
  settings: SpendingBaselineSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

type MonthlyData = Readonly<{
  variableByCategory: ReadonlyMap<SpendingCategoryId, bigint>;
  recurringTotal: bigint;
  excludedIrregular: bigint;
  excludedFunded: bigint;
  reversalExcess: bigint;
}>;

type CompleteMonthSelection = Readonly<{
  months: readonly YearMonth[];
  skippedIncompleteMonths: readonly YearMonth[];
  missingCoverageMonths: readonly YearMonth[];
}>;

type WinsorizedOutlier = Readonly<{
  categoryId: SpendingCategoryId;
  month: YearMonth;
}>;

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function unique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length)
    throw new FinancialEngineInvariantError(code, message);
}

function validateSettings(settings: SpendingBaselineSettings): SpendingBaselineSettings {
  const materialityThreshold = createMoney(
    settings.materialityThreshold.amountMinor,
    settings.materialityThreshold.currency,
  );
  const variabilityPercentile = createExactFraction(
    settings.variabilityPercentile.numerator,
    settings.variabilityPercentile.denominator,
  );
  const seasonalityCap = createExactFraction(
    settings.seasonalityCap.numerator,
    settings.seasonalityCap.denominator,
  );
  if (
    !Number.isSafeInteger(settings.baselineWindowMonths) ||
    !Number.isSafeInteger(settings.minimumCompleteMonths) ||
    !Number.isSafeInteger(settings.maximumBaselineLookbackMonths) ||
    settings.minimumCompleteMonths < 3 ||
    settings.baselineWindowMonths < settings.minimumCompleteMonths ||
    settings.maximumBaselineLookbackMonths <= 0 ||
    settings.maximumBaselineLookbackMonths <
      Math.max(settings.baselineWindowMonths, settings.seasonalityMinimumMonths) ||
    !Number.isSafeInteger(settings.seasonalityMinimumMonths) ||
    settings.seasonalityMinimumMonths < 24 ||
    materialityThreshold.currency !== EUR ||
    materialityThreshold.amountMinor < 0n ||
    variabilityPercentile.numerator <= 0n ||
    variabilityPercentile.numerator > variabilityPercentile.denominator ||
    seasonalityCap.numerator < 0n ||
    seasonalityCap.numerator >= seasonalityCap.denominator
  ) {
    throw new FinancialEngineInvariantError(
      'baseline.invalid_settings',
      'Spending baseline settings violate the accepted Stage 2D policy.',
    );
  }
  const fallbackNormal =
    settings.fallbackNormalBaseline === null
      ? null
      : createMoney(
          settings.fallbackNormalBaseline.amountMinor,
          settings.fallbackNormalBaseline.currency,
        );
  const fallbackEssential =
    settings.fallbackEssentialBaseline === null
      ? null
      : createMoney(
          settings.fallbackEssentialBaseline.amountMinor,
          settings.fallbackEssentialBaseline.currency,
        );
  if (
    (fallbackNormal !== null &&
      (fallbackNormal.currency !== EUR || fallbackNormal.amountMinor < 0n)) ||
    (fallbackEssential !== null &&
      (fallbackEssential.currency !== EUR || fallbackEssential.amountMinor < 0n)) ||
    (fallbackNormal !== null &&
      fallbackEssential !== null &&
      fallbackEssential.amountMinor > fallbackNormal.amountMinor)
  ) {
    throw new FinancialEngineInvariantError(
      'baseline.invalid_fallback',
      'Fallback baselines must be non-negative EUR values with essential not above normal.',
    );
  }
  return Object.freeze({
    ...settings,
    materialityThreshold,
    variabilityPercentile,
    seasonalityCap,
    fallbackNormalBaseline: fallbackNormal,
    fallbackEssentialBaseline: fallbackEssential,
  });
}

function isCompleteMonth(item: CalendarMonthCoverage): boolean {
  return (
    item.reconciled &&
    item.materialAmbiguityFree &&
    item.fxComplete &&
    item.spendingClassificationComplete
  );
}

function selectLatestCompleteMonths(
  input: Readonly<{
    targetMonth: YearMonth;
    coverageByMonth: ReadonlyMap<YearMonth, CalendarMonthCoverage>;
    requiredCount: number;
    maximumLookbackMonths: number;
  }>,
): CompleteMonthSelection {
  const candidates = priorYearMonths(input.targetMonth, input.maximumLookbackMonths);
  const selected: YearMonth[] = [];
  const skippedIncompleteMonths: YearMonth[] = [];
  const missingCoverageMonths: YearMonth[] = [];

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (selected.length === input.requiredCount) break;
    const month = candidates[index]!;
    const coverage = input.coverageByMonth.get(month);
    if (coverage === undefined) {
      missingCoverageMonths.push(month);
    } else if (!isCompleteMonth(coverage)) {
      skippedIncompleteMonths.push(month);
    } else {
      selected.push(month);
    }
  }

  return Object.freeze({
    months: Object.freeze(selected.reverse()),
    skippedIncompleteMonths: Object.freeze(skippedIncompleteMonths.sort()),
    missingCoverageMonths: Object.freeze(missingCoverageMonths.sort()),
  });
}

function validateFacts(input: SpendingBaselineInput) {
  const flows = Object.freeze(input.economicFlows.map((item) => createEconomicFlow(item)));
  const observations = Object.freeze(
    input.observations.map((item) => createSpendingObservation(item)),
  );
  const coverage = Object.freeze(
    input.monthCoverage.map((item) => createCalendarMonthCoverage(item)),
  );
  const scheduled = Object.freeze(
    input.scheduledRecurring.map((item) => createScheduledSpending(item)),
  );
  unique(
    flows.map((item) => item.id),
    'baseline.duplicate_flow',
    'Economic flow IDs must be unique.',
  );
  unique(
    flows.map((item) => item.transactionId),
    'baseline.duplicate_flow_transaction',
    'A transaction can have only one economic flow.',
  );
  unique(
    observations.map((item) => item.economicFlowId),
    'baseline.duplicate_observation',
    'A flow can have only one spending observation.',
  );
  unique(
    coverage.map((item) => item.month),
    'baseline.duplicate_month_coverage',
    'Month coverage must be unique.',
  );
  unique(
    scheduled.map((item) => item.id),
    'baseline.duplicate_schedule',
    'Scheduled spending IDs must be unique.',
  );
  const flowById = new Map(flows.map((item) => [item.id, item]));
  const observationByFlow = new Map(observations.map((item) => [item.economicFlowId, item]));
  const flowByTransaction = new Map(flows.map((item) => [item.transactionId, item]));
  const reversalTotals = new Map<string, bigint>();
  for (const flow of flows) {
    if (flow.amount.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'baseline.currency_mismatch',
        'Baseline economic flows must use canonical EUR amounts.',
      );
    }
    if (
      (flow.kind === 'consumption' || flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      flow.amount.amountMinor <= 0n
    ) {
      throw new FinancialEngineInvariantError(
        'baseline.invalid_flow_sign',
        'Consumption, refunds, and reimbursements use positive magnitudes.',
      );
    }
    if (
      (flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      flow.relatedTransactionId !== null
    ) {
      const original = flowByTransaction.get(flow.relatedTransactionId);
      if (
        original?.kind !== 'consumption' ||
        (flow.kind === 'reimbursement' && !original.reimbursable)
      ) {
        throw new FinancialEngineInvariantError(
          'baseline.invalid_reversal_target',
          'A linked reversal must reference compatible canonical consumption.',
        );
      }
      const total = (reversalTotals.get(original.transactionId) ?? 0n) + flow.amount.amountMinor;
      if (total > original.amount.amountMinor) {
        throw new FinancialEngineInvariantError(
          'baseline.reversal_exceeds_consumption',
          'Linked reversals cannot exceed original consumption.',
        );
      }
      reversalTotals.set(original.transactionId, total);
    }
  }
  const categoryNecessity = new Map<SpendingCategoryId, SpendingObservation['necessity']>();
  for (const observation of observations) {
    const flow = flowById.get(observation.economicFlowId);
    if (
      flow === undefined ||
      (flow.kind !== 'consumption' && flow.kind !== 'refund' && flow.kind !== 'reimbursement')
    ) {
      throw new FinancialEngineInvariantError(
        'baseline.invalid_observation_flow',
        'A spending observation must reference consumption, refund, or reimbursement.',
      );
    }
    const prior = categoryNecessity.get(observation.categoryId);
    if (prior !== undefined && prior !== observation.necessity) {
      throw new FinancialEngineInvariantError(
        'baseline.inconsistent_category',
        'A category must have one essentiality in the baseline input.',
      );
    }
    categoryNecessity.set(observation.categoryId, observation.necessity);
    if (flow.kind === 'refund' || flow.kind === 'reimbursement') {
      if (flow.relatedTransactionId === null) continue;
      const original = flowByTransaction.get(flow.relatedTransactionId);
      const originalObservation =
        original === undefined ? undefined : observationByFlow.get(original.id);
      if (
        original?.kind !== 'consumption' ||
        originalObservation === undefined ||
        originalObservation.categoryId !== observation.categoryId ||
        originalObservation.necessity !== observation.necessity ||
        originalObservation.cadence !== observation.cadence ||
        originalObservation.irregular !== observation.irregular
      ) {
        throw new FinancialEngineInvariantError(
          'baseline.invalid_reversal_link',
          'A linked reversal must retain its original spending classification.',
        );
      }
    }
  }
  for (const flow of flows) {
    if (
      (flow.kind === 'consumption' || flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      !observationByFlow.has(flow.id)
    ) {
      throw new FinancialEngineInvariantError(
        'baseline.missing_spending_observation',
        'Every spending or reversal flow in baseline history requires a spending observation.',
      );
    }
    if (
      (flow.kind === 'refund' || flow.kind === 'reimbursement') &&
      flow.relatedTransactionId === null
    ) {
      const observation = observationByFlow.get(flow.id)!;
      const month = coverage.find((item) => item.month === yearMonthOf(observation.economicDate));
      if (month !== undefined && isCompleteMonth(month)) {
        throw new FinancialEngineInvariantError(
          'baseline.unlinked_reversal_in_complete_month',
          'An unlinked reversal cannot appear in a complete baseline month.',
        );
      }
    }
  }
  if (typeof input.recurringScheduleComplete !== 'boolean') {
    throw new FinancialEngineInvariantError(
      'baseline.invalid_recurring_coverage',
      'Recurring schedule completeness must be explicit.',
    );
  }
  return {
    flows,
    observations,
    coverage,
    scheduled,
    flowById,
    observationByFlow,
    flowByTransaction,
  };
}

function fundedAmounts(
  result: MetricResult<FundedConsumptionCoverage>,
): ReadonlyMap<string, bigint> {
  const values = result.value?.byTransaction ?? [];
  unique(
    values.map((item) => item.transactionId),
    'baseline.duplicate_funded_coverage',
    'Funded-consumption transaction coverage must be unique.',
  );
  let total = 0n;
  for (const item of values) {
    if (item.amount.currency !== EUR || item.amount.amountMinor < 0n) {
      throw new FinancialEngineInvariantError(
        'baseline.invalid_funded_coverage',
        'Funded-consumption coverage must use non-negative EUR amounts.',
      );
    }
    total += item.amount.amountMinor;
  }
  if (
    result.value !== null &&
    (result.value.total.currency !== EUR || result.value.total.amountMinor !== total)
  ) {
    throw new FinancialEngineInvariantError(
      'baseline.invalid_funded_coverage_total',
      'Funded-consumption coverage must reconcile to its total.',
    );
  }
  return new Map(values.map((item) => [item.transactionId, item.amount.amountMinor]));
}

function collectMonthlyData(
  months: readonly YearMonth[],
  facts: ReturnType<typeof validateFacts>,
  funded: ReadonlyMap<string, bigint>,
): ReadonlyMap<YearMonth, MonthlyData> {
  const mutable = new Map<
    YearMonth,
    {
      variable: Map<SpendingCategoryId, bigint>;
      recurring: bigint;
      irregular: bigint;
      funded: bigint;
      excess: bigint;
    }
  >();
  for (const month of months)
    mutable.set(month, {
      variable: new Map(),
      recurring: 0n,
      irregular: 0n,
      funded: 0n,
      excess: 0n,
    });
  const appliedReversal = new Map<string, bigint>();

  for (const observation of facts.observations) {
    const month = yearMonthOf(observation.economicDate);
    const bucket = mutable.get(month);
    if (bucket === undefined) continue;
    const flow = facts.flowById.get(observation.economicFlowId)!;
    if (flow.amount.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'baseline.currency_mismatch',
        'Baseline flows must be canonical EUR.',
      );
    }
    if (flow.kind === 'consumption') {
      const covered = funded.get(flow.transactionId) ?? 0n;
      if (covered > flow.amount.amountMinor) {
        throw new FinancialEngineInvariantError(
          'baseline.funding_exceeds_consumption',
          'Funded consumption cannot exceed consumption.',
        );
      }
      bucket.funded += covered;
      const ordinary = flow.amount.amountMinor - covered;
      if (observation.irregular) bucket.irregular += ordinary;
      else if (observation.cadence === 'recurring') bucket.recurring += ordinary;
      else
        bucket.variable.set(
          observation.categoryId,
          (bucket.variable.get(observation.categoryId) ?? 0n) + ordinary,
        );
    }
  }
  const reversals = facts.observations
    .filter((observation) => {
      const flow = facts.flowById.get(observation.economicFlowId)!;
      return flow.kind === 'refund' || flow.kind === 'reimbursement';
    })
    .sort((left, right) => {
      const byDate = left.economicDate.localeCompare(right.economicDate);
      return byDate !== 0 ? byDate : left.economicFlowId.localeCompare(right.economicFlowId);
    });
  for (const observation of reversals) {
    const month = yearMonthOf(observation.economicDate);
    const bucket = mutable.get(month);
    if (bucket === undefined) continue;
    const flow = facts.flowById.get(observation.economicFlowId)!;
    if (flow.kind !== 'refund' && flow.kind !== 'reimbursement') continue;
    if (
      flow.relatedTransactionId === null ||
      observation.irregular ||
      observation.cadence !== 'variable'
    )
      continue;
    const original = facts.flowByTransaction.get(flow.relatedTransactionId)!;
    const ordinaryOriginal =
      original.amount.amountMinor - (funded.get(original.transactionId) ?? 0n);
    const alreadyApplied = appliedReversal.get(original.transactionId) ?? 0n;
    const available = ordinaryOriginal > alreadyApplied ? ordinaryOriginal - alreadyApplied : 0n;
    const applied = flow.amount.amountMinor < available ? flow.amount.amountMinor : available;
    const current = bucket.variable.get(observation.categoryId) ?? 0n;
    const reduction = applied < current ? applied : current;
    bucket.variable.set(observation.categoryId, current - reduction);
    bucket.excess += flow.amount.amountMinor - reduction;
    appliedReversal.set(original.transactionId, alreadyApplied + reduction);
  }
  return new Map(
    [...mutable.entries()].map(([month, value]) => [
      month,
      Object.freeze({
        variableByCategory: value.variable,
        recurringTotal: value.recurring,
        excludedIrregular: value.irregular,
        excludedFunded: value.funded,
        reversalExcess: value.excess,
      }),
    ]),
  );
}

function categoryEstimates(
  months: readonly YearMonth[],
  data: ReadonlyMap<YearMonth, MonthlyData>,
  observations: readonly SpendingObservation[],
  materiality: bigint,
): Readonly<{
  normal: bigint;
  essential: bigint;
  winsorizedMonthlyVariable: ReadonlyMap<YearMonth, bigint>;
  outliers: readonly WinsorizedOutlier[];
}> {
  const categoryNecessity = new Map<SpendingCategoryId, SpendingObservation['necessity']>();
  for (const item of observations) {
    if (item.cadence === 'variable') categoryNecessity.set(item.categoryId, item.necessity);
  }
  let normal = 0n;
  let essential = 0n;
  const outliers: WinsorizedOutlier[] = [];
  const winsorizedMonthlyVariable = new Map(months.map((month) => [month, 0n]));
  for (const [categoryId, necessity] of categoryNecessity) {
    const values = months.map((month) => data.get(month)?.variableByCategory.get(categoryId) ?? 0n);
    const center = median(values);
    const mad = median(values.map((value) => (value >= center ? value - center : center - value)));
    const boundary = center + (3n * mad > materiality ? 3n * mad : materiality);
    const winsorized = values.map((value, index) => {
      if (value > boundary) {
        outliers.push(Object.freeze({ categoryId, month: months[index]! }));
        return boundary;
      }
      return value;
    });
    const estimate = median(winsorized);
    normal += estimate;
    if (necessity === 'essential') essential += estimate;
    months.forEach((month, index) => {
      winsorizedMonthlyVariable.set(
        month,
        winsorizedMonthlyVariable.get(month)! + winsorized[index]!,
      );
    });
  }
  outliers.sort((left, right) => {
    const byMonth = left.month.localeCompare(right.month);
    return byMonth !== 0 ? byMonth : left.categoryId.localeCompare(right.categoryId);
  });
  return Object.freeze({
    normal,
    essential,
    winsorizedMonthlyVariable,
    outliers: Object.freeze(outliers),
  });
}

function seasonalFactor(
  targetMonth: YearMonth,
  months: readonly YearMonth[],
  winsorizedMonthlyVariable: ReadonlyMap<YearMonth, bigint>,
  cap: ExactFraction,
): ExactFraction | null {
  if (months.length === 0) return null;
  const all = months.map((month) => winsorizedMonthlyVariable.get(month) ?? 0n);
  const overall = median(all);
  if (overall === 0n) return null;
  const monthNumber = targetMonth.slice(5, 7);
  const matching = months
    .map((month, index) => ({ month, value: all[index]! }))
    .filter((item) => item.month.slice(5, 7) === monthNumber)
    .map((item) => item.value);
  if (matching.length === 0) return null;
  const sameMonth = median(matching);
  const lowerNumerator = cap.denominator - cap.numerator;
  const upperNumerator = cap.denominator + cap.numerator;
  if (sameMonth * cap.denominator < overall * lowerNumerator) {
    return createExactFraction(lowerNumerator, cap.denominator);
  }
  if (sameMonth * cap.denominator > overall * upperNumerator) {
    return createExactFraction(upperNumerator, cap.denominator);
  }
  return createExactFraction(sameMonth, overall);
}

export function calculateSpendingBaseline(
  input: SpendingBaselineInput,
): MetricResult<SpendingBaseline> {
  const asOf = parseInstant(input.asOf);
  const targetMonth = parseYearMonth(input.targetMonth);
  const settings = validateSettings(input.settings);
  const facts = validateFacts(input);
  const warnings: DataWarning[] = [];
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  if (!input.recurringScheduleComplete) {
    return createMetricResult<SpendingBaseline>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('baseline.missing_recurring_schedule')],
    });
  }
  if (
    input.fundedConsumptionCoverage.asOf !== asOf ||
    input.fundedConsumptionCoverage.settingsVersion !== input.settingsVersion
  ) {
    throw new FinancialEngineInvariantError(
      'baseline.upstream_metadata_mismatch',
      'Funded-consumption coverage must share baseline as-of and settings version.',
    );
  }
  const coverageByMonth = new Map(facts.coverage.map((item) => [item.month, item]));
  const baselineSelection = selectLatestCompleteMonths({
    targetMonth,
    coverageByMonth,
    requiredCount: settings.baselineWindowMonths,
    maximumLookbackMonths: settings.maximumBaselineLookbackMonths,
  });
  const completeMonths = baselineSelection.months;
  if (baselineSelection.skippedIncompleteMonths.length > 0) {
    warnings.push(
      warning('baseline.incomplete_months_skipped', {
        count: baselineSelection.skippedIncompleteMonths.length.toString(),
        months: baselineSelection.skippedIncompleteMonths.join(','),
      }),
    );
  }
  if (baselineSelection.missingCoverageMonths.length > 0) {
    warnings.push(
      warning('baseline.missing_month_coverage', {
        count: baselineSelection.missingCoverageMonths.length.toString(),
        months: baselineSelection.missingCoverageMonths.join(','),
      }),
    );
  }

  const recurring = facts.scheduled.filter((item) => yearMonthOf(item.dueDate) === targetMonth);
  for (const item of recurring) {
    if (item.amount.currency !== EUR)
      throw new FinancialEngineInvariantError(
        'baseline.currency_mismatch',
        'Scheduled spending must use EUR.',
      );
  }
  const recurringNormal = recurring.reduce((sum, item) => sum + item.amount.amountMinor, 0n);
  const recurringEssential = recurring.reduce(
    (sum, item) => sum + (item.necessity === 'essential' ? item.amount.amountMinor : 0n),
    0n,
  );
  const hasHistory = completeMonths.length >= settings.minimumCompleteMonths;
  const coverageUsable = input.fundedConsumptionCoverage.value !== null;

  if (!hasHistory) {
    warnings.push(
      warning('baseline.insufficient_history', {
        completeMonths: completeMonths.length.toString(),
        maximumLookbackMonths: settings.maximumBaselineLookbackMonths.toString(),
      }),
    );
    warnings.push(warning('baseline.insufficient_variability_sample'));
    const fallbackNormal = settings.fallbackNormalBaseline;
    const fallbackEssential = settings.fallbackEssentialBaseline;
    if (
      fallbackNormal === null ||
      fallbackEssential === null ||
      fallbackNormal.amountMinor < recurringNormal ||
      fallbackEssential.amountMinor < recurringEssential
    ) {
      return createMetricResult<SpendingBaseline>({
        ...base,
        status: 'unavailable',
        value: null,
        explanation: [],
        warnings,
      });
    }
    const value = Object.freeze({
      normalBaseline: fallbackNormal,
      essentialBaseline: fallbackEssential,
      recurringNormal: money(recurringNormal),
      recurringEssential: money(recurringEssential),
      variableNormal: money(fallbackNormal.amountMinor - recurringNormal),
      variableEssential: money(fallbackEssential.amountMinor - recurringEssential),
      variabilityBuffer: money(0n),
      excludedIrregular: money(0n),
      excludedFundedConsumption: money(0n),
      excludedReversalExcess: money(0n),
      eligibleCompleteMonths: completeMonths.length,
      historicalWindowUsed: Object.freeze([...completeMonths]),
      seasonalAdjustment: null,
      source: 'fallback' as const,
    });
    return createMetricResult({
      ...base,
      status: 'partial',
      value,
      explanation: baselineExplanation(value),
      warnings,
    });
  }
  if (!coverageUsable) {
    return createMetricResult<SpendingBaseline>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('baseline.missing_funded_consumption_coverage')],
    });
  }
  const funded = fundedAmounts(input.fundedConsumptionCoverage);
  const monthly = collectMonthlyData(completeMonths, facts, funded);
  const estimates = categoryEstimates(
    completeMonths,
    monthly,
    facts.observations,
    settings.materialityThreshold.amountMinor,
  );
  const seasonalSelection = selectLatestCompleteMonths({
    targetMonth,
    coverageByMonth,
    requiredCount: settings.seasonalityMinimumMonths,
    maximumLookbackMonths: settings.maximumBaselineLookbackMonths,
  });
  const seasonalMonths = seasonalSelection.months;
  let factor: ExactFraction | null = null;
  let seasonalOutliers: readonly WinsorizedOutlier[] = [];
  if (seasonalMonths.length === settings.seasonalityMinimumMonths) {
    const seasonalMonthly = collectMonthlyData(seasonalMonths, facts, funded);
    const seasonalEstimates = categoryEstimates(
      seasonalMonths,
      seasonalMonthly,
      facts.observations,
      settings.materialityThreshold.amountMinor,
    );
    seasonalOutliers = seasonalEstimates.outliers;
    factor = seasonalFactor(
      targetMonth,
      seasonalMonths,
      seasonalEstimates.winsorizedMonthlyVariable,
      settings.seasonalityCap,
    );
    if (factor === null) warnings.push(warning('baseline.seasonality_zero_reference'));
  }
  const outlierKeys = new Set(
    [...estimates.outliers, ...seasonalOutliers].map((item) => `${item.month}:${item.categoryId}`),
  );
  if (outlierKeys.size > 0) {
    warnings.push(
      warning('baseline.high_outliers_winsorized', {
        count: outlierKeys.size.toString(),
        observations: [...outlierKeys].sort().join(','),
      }),
    );
  }
  const variableNormal =
    factor === null
      ? estimates.normal
      : multiplyFractionHalfEven(estimates.normal, factor.numerator, factor.denominator);
  const variableEssential =
    factor === null
      ? estimates.essential
      : multiplyFractionHalfEven(estimates.essential, factor.numerator, factor.denominator);
  const monthlyNormal = completeMonths.map(
    (month) => monthly.get(month)!.recurringTotal + estimates.winsorizedMonthlyVariable.get(month)!,
  );
  const center = median(monthlyNormal);
  const positiveDeviations = monthlyNormal
    .filter((value) => value > center)
    .map((value) => value - center);
  const variabilityBuffer = nearestRank(
    positiveDeviations,
    settings.variabilityPercentile.numerator,
    settings.variabilityPercentile.denominator,
  );
  const excludedIrregular = [...monthly.values()].reduce(
    (sum, item) => sum + item.excludedIrregular,
    0n,
  );
  const excludedFunded = [...monthly.values()].reduce((sum, item) => sum + item.excludedFunded, 0n);
  const reversalExcess = [...monthly.values()].reduce((sum, item) => sum + item.reversalExcess, 0n);
  if (reversalExcess > 0n)
    warnings.push(
      warning('baseline.reversal_excess_excluded', { amountMinor: reversalExcess.toString() }),
    );
  const value = Object.freeze({
    normalBaseline: money(recurringNormal + variableNormal),
    essentialBaseline: money(recurringEssential + variableEssential),
    recurringNormal: money(recurringNormal),
    recurringEssential: money(recurringEssential),
    variableNormal: money(variableNormal),
    variableEssential: money(variableEssential),
    variabilityBuffer: money(variabilityBuffer),
    excludedIrregular: money(excludedIrregular),
    excludedFundedConsumption: money(excludedFunded),
    excludedReversalExcess: money(reversalExcess),
    eligibleCompleteMonths: completeMonths.length,
    historicalWindowUsed: Object.freeze([...completeMonths]),
    seasonalAdjustment: factor,
    source: 'historical' as const,
  });
  if (value.essentialBaseline.amountMinor > value.normalBaseline.amountMinor) {
    throw new FinancialEngineInvariantError(
      'baseline.essential_above_normal',
      'Essential baseline cannot exceed normal baseline.',
    );
  }
  const status = input.fundedConsumptionCoverage.status === 'partial' ? 'partial' : 'complete';
  return createMetricResult({
    ...base,
    status,
    value,
    explanation: baselineExplanation(value),
    warnings: [...input.fundedConsumptionCoverage.warnings, ...warnings],
  });
}

function baselineExplanation(value: SpendingBaseline): readonly ExplanationComponent[] {
  return Object.freeze(
    [
      ['baseline.recurring-normal', 'recurringNormal', value.recurringNormal.amountMinor],
      ['baseline.variable-normal', 'variableNormal', value.variableNormal.amountMinor],
      ['baseline.normal', 'normalBaseline', value.normalBaseline.amountMinor],
      ['baseline.recurring-essential', 'recurringEssential', value.recurringEssential.amountMinor],
      ['baseline.variable-essential', 'variableEssential', value.variableEssential.amountMinor],
      ['baseline.essential', 'essentialBaseline', value.essentialBaseline.amountMinor],
      ['baseline.variability-buffer', 'variabilityBuffer', value.variabilityBuffer.amountMinor],
    ].map(([ruleId, inputKey, amount]) =>
      Object.freeze({
        ruleId: ruleId as string,
        inputKey: inputKey as string,
        value: (amount as bigint).toString(),
      }),
    ),
  );
}
