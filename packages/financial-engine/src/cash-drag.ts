import {
  EUR,
  createCashDragDailyObservation,
  createExactFraction,
  createMetricResult,
  createMoney,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  CashDragDailyObservation,
  DataWarning,
  ExactFraction,
  ExplanationComponent,
  Instant,
  LocalDate,
  MetricResult,
  Money,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import { halfEvenDivide, multiplyFractionHalfEven } from './exact-math.js';
import type { LiquidityReserve } from './liquidity.js';
import { addLocalDays } from './local-calendar.js';
import type { SafeToInvest } from './safe-to-invest.js';

export type CashDragSettings = Readonly<{
  windowDays: number;
  minimumCompleteDays: number;
  minimumPositiveExcessDays: number;
  absoluteExcessThreshold: Money;
  relativeComfortThreshold: ExactFraction;
}>;

export const CASH_DRAG_SUPPRESSION_REASONS = [
  'current_liquidity_not_complete',
  'current_safe_to_invest_not_complete',
  'insufficient_complete_history',
  'insufficient_positive_excess_days',
  'no_current_excess',
  'no_current_investable_capacity',
  'average_excess_not_above_threshold',
] as const;
export type CashDragSuppressionReason = (typeof CASH_DRAG_SUPPRESSION_REASONS)[number];

export type CashDragAssessment = Readonly<{
  eligible: boolean;
  windowStartInclusive: LocalDate;
  windowEndInclusive: LocalDate;
  completeDays: number;
  incompleteDays: number;
  missingDays: number;
  positiveExcessDays: number;
  totalExcess: Money;
  currentExcess: Money;
  averageExcess: Money | null;
  absoluteThreshold: Money;
  relativeThreshold: Money;
  effectiveThreshold: Money;
  actionCap: Money;
  suppressionReasons: readonly CashDragSuppressionReason[];
}>;

export type CashDragInput = Readonly<{
  dailyObservations: readonly CashDragDailyObservation[];
  currentLiquidity: MetricResult<LiquidityReserve>;
  currentSafeToInvest: MetricResult<SafeToInvest>;
  effectiveDate: LocalDate;
  settings: CashDragSettings;
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function validateSettings(settings: CashDragSettings): CashDragSettings {
  const absoluteExcessThreshold = createMoney(
    settings.absoluteExcessThreshold.amountMinor,
    settings.absoluteExcessThreshold.currency,
  );
  const relativeComfortThreshold = createExactFraction(
    settings.relativeComfortThreshold.numerator,
    settings.relativeComfortThreshold.denominator,
  );
  if (
    !Number.isSafeInteger(settings.windowDays) ||
    settings.windowDays <= 0 ||
    !Number.isSafeInteger(settings.minimumCompleteDays) ||
    settings.minimumCompleteDays <= 0 ||
    settings.minimumCompleteDays > settings.windowDays ||
    !Number.isSafeInteger(settings.minimumPositiveExcessDays) ||
    settings.minimumPositiveExcessDays <= 0 ||
    settings.minimumPositiveExcessDays > settings.minimumCompleteDays ||
    absoluteExcessThreshold.currency !== EUR ||
    absoluteExcessThreshold.amountMinor < 0n ||
    relativeComfortThreshold.numerator < 0n
  ) {
    throw new FinancialEngineInvariantError(
      'cash_drag.invalid_settings',
      'Cash Drag settings violate the accepted Stage 2E policy.',
    );
  }
  return Object.freeze({
    ...settings,
    absoluteExcessThreshold,
    relativeComfortThreshold,
  });
}

function validateCurrentValues(liquidity: LiquidityReserve, safe: SafeToInvest): void {
  const liquidityAmounts = [
    liquidity.currentLiquidCash,
    liquidity.minimumCash,
    liquidity.comfortCash,
    liquidity.variabilityBuffer,
    liquidity.currentExcessAboveComfort,
  ];
  const safeAmounts = [
    safe.conservative,
    safe.recommended,
    safe.maximum,
    safe.unroundedConservative,
    safe.unroundedRecommended,
    safe.unroundedMaximum,
    safe.conservativeRoundingLoss,
    safe.recommendedRoundingLoss,
    safe.maximumRoundingLoss,
    safe.recommendationIncrement,
    safe.liquidCash,
    safe.minimumCash,
    safe.comfortCash,
    safe.variabilityBuffer,
  ];
  if (
    [...liquidityAmounts, ...safeAmounts].some(
      (item) => item.currency !== EUR || item.amountMinor < 0n,
    )
  ) {
    throw new FinancialEngineInvariantError(
      'cash_drag.invalid_current_values',
      'Cash Drag requires non-negative EUR current values.',
    );
  }
  const currentExcess =
    liquidity.currentLiquidCash.amountMinor > liquidity.comfortCash.amountMinor
      ? liquidity.currentLiquidCash.amountMinor - liquidity.comfortCash.amountMinor
      : 0n;
  const expectedRecommended = currentExcess;
  const expectedConservative =
    expectedRecommended > liquidity.variabilityBuffer.amountMinor
      ? expectedRecommended - liquidity.variabilityBuffer.amountMinor
      : 0n;
  const expectedMaximum =
    liquidity.currentLiquidCash.amountMinor > liquidity.minimumCash.amountMinor
      ? liquidity.currentLiquidCash.amountMinor - liquidity.minimumCash.amountMinor
      : 0n;
  if (
    liquidity.minimumCash.amountMinor > liquidity.comfortCash.amountMinor ||
    liquidity.currentExcessAboveComfort.amountMinor !== currentExcess ||
    safe.liquidCash.amountMinor !== liquidity.currentLiquidCash.amountMinor ||
    safe.minimumCash.amountMinor !== liquidity.minimumCash.amountMinor ||
    safe.comfortCash.amountMinor !== liquidity.comfortCash.amountMinor ||
    safe.variabilityBuffer.amountMinor !== liquidity.variabilityBuffer.amountMinor ||
    safe.unroundedConservative.amountMinor !== expectedConservative ||
    safe.unroundedRecommended.amountMinor !== expectedRecommended ||
    safe.unroundedMaximum.amountMinor !== expectedMaximum ||
    safe.conservative.amountMinor > safe.recommended.amountMinor ||
    safe.recommended.amountMinor > safe.maximum.amountMinor ||
    safe.unroundedConservative.amountMinor > safe.unroundedRecommended.amountMinor ||
    safe.unroundedRecommended.amountMinor > safe.unroundedMaximum.amountMinor ||
    safe.recommendationIncrement.amountMinor <= 0n
  ) {
    throw new FinancialEngineInvariantError(
      'cash_drag.current_input_mismatch',
      'Current Safe to Invest must reconcile to current liquidity.',
    );
  }
  const increment = safe.recommendationIncrement.amountMinor;
  const pairs = [
    [safe.conservative, safe.unroundedConservative, safe.conservativeRoundingLoss],
    [safe.recommended, safe.unroundedRecommended, safe.recommendedRoundingLoss],
    [safe.maximum, safe.unroundedMaximum, safe.maximumRoundingLoss],
  ] as const;
  if (
    pairs.some(
      ([rounded, unrounded, loss]) =>
        rounded.amountMinor > unrounded.amountMinor ||
        rounded.amountMinor % increment !== 0n ||
        unrounded.amountMinor - rounded.amountMinor !== loss.amountMinor ||
        loss.amountMinor >= increment,
    )
  ) {
    throw new FinancialEngineInvariantError(
      'cash_drag.invalid_safe_to_invest_rounding',
      'Safe to Invest rounding must reconcile before Cash Drag evaluation.',
    );
  }
}

function mergedWarnings(...groups: readonly (readonly DataWarning[])[]): readonly DataWarning[] {
  const seen = new Set<string>();
  const result: DataWarning[] = [];
  for (const item of groups.flat()) {
    const context = Object.fromEntries(
      Object.entries(item.context).sort(([left], [right]) => left.localeCompare(right)),
    );
    const key = `${item.code}:${JSON.stringify(context)}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  return result;
}

function explanation(value: CashDragAssessment): readonly ExplanationComponent[] {
  const result: ExplanationComponent[] = [
    {
      ruleId: 'cash-drag.window-start',
      inputKey: 'windowStartInclusive',
      value: value.windowStartInclusive,
    },
    {
      ruleId: 'cash-drag.window-end',
      inputKey: 'windowEndInclusive',
      value: value.windowEndInclusive,
    },
    {
      ruleId: 'cash-drag.complete-days',
      inputKey: 'completeDays',
      value: value.completeDays.toString(),
    },
    {
      ruleId: 'cash-drag.incomplete-days',
      inputKey: 'incompleteDays',
      value: value.incompleteDays.toString(),
    },
    {
      ruleId: 'cash-drag.missing-days',
      inputKey: 'missingDays',
      value: value.missingDays.toString(),
    },
    {
      ruleId: 'cash-drag.positive-days',
      inputKey: 'positiveExcessDays',
      value: value.positiveExcessDays.toString(),
    },
    {
      ruleId: 'cash-drag.total-excess',
      inputKey: 'totalExcess',
      value: value.totalExcess.amountMinor.toString(),
    },
    {
      ruleId: 'cash-drag.current-excess',
      inputKey: 'currentExcess',
      value: value.currentExcess.amountMinor.toString(),
    },
    {
      ruleId: 'cash-drag.absolute-threshold',
      inputKey: 'absoluteThreshold',
      value: value.absoluteThreshold.amountMinor.toString(),
    },
    {
      ruleId: 'cash-drag.relative-threshold',
      inputKey: 'relativeThreshold',
      value: value.relativeThreshold.amountMinor.toString(),
    },
    {
      ruleId: 'cash-drag.effective-threshold',
      inputKey: 'effectiveThreshold',
      value: value.effectiveThreshold.amountMinor.toString(),
    },
    {
      ruleId: 'cash-drag.action-cap',
      inputKey: 'actionCap',
      value: value.actionCap.amountMinor.toString(),
    },
    { ruleId: 'cash-drag.eligible', inputKey: 'eligible', value: value.eligible.toString() },
  ];
  if (value.averageExcess !== null) {
    result.push({
      ruleId: 'cash-drag.average-excess',
      inputKey: 'averageExcess',
      value: value.averageExcess.amountMinor.toString(),
    });
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

export function calculateCashDrag(input: CashDragInput): MetricResult<CashDragAssessment> {
  const asOf = parseInstant(input.asOf);
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const settings = validateSettings(input.settings);
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  for (const current of [input.currentLiquidity, input.currentSafeToInvest]) {
    if (current.asOf !== asOf || current.settingsVersion !== input.settingsVersion) {
      throw new FinancialEngineInvariantError(
        'cash_drag.upstream_metadata_mismatch',
        'Current metrics must share the Cash Drag as-of and settings version.',
      );
    }
  }
  const currentWarnings = mergedWarnings(
    input.currentLiquidity.warnings,
    input.currentSafeToInvest.warnings,
  );
  const observations = Object.freeze(
    input.dailyObservations.map((item) => createCashDragDailyObservation(item)),
  );
  if (new Set(observations.map((item) => item.date)).size !== observations.length) {
    throw new FinancialEngineInvariantError(
      'cash_drag.duplicate_daily_observation',
      'Cash Drag daily observation dates must be unique.',
    );
  }
  for (const item of observations) {
    if (item.liquidCash.currency !== EUR || item.comfortCash.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'cash_drag.currency_mismatch',
        'Cash Drag daily observations must use EUR.',
      );
    }
    if (item.date > effectiveDate) {
      throw new FinancialEngineInvariantError(
        'cash_drag.future_observation',
        'Cash Drag history cannot contain a future observation.',
      );
    }
    if (item.date === effectiveDate) {
      throw new FinancialEngineInvariantError(
        'cash_drag.duplicate_current_date',
        'Current liquidity is authoritative for the Cash Drag evaluation date.',
      );
    }
  }
  if (input.currentLiquidity.value === null || input.currentSafeToInvest.value === null) {
    return createMetricResult<CashDragAssessment>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [...currentWarnings, warning('cash_drag.missing_current_input')],
    });
  }
  const liquidity = input.currentLiquidity.value;
  const safe = input.currentSafeToInvest.value;
  validateCurrentValues(liquidity, safe);
  if (
    input.currentSafeToInvest.status === 'complete' &&
    input.currentLiquidity.status !== 'complete'
  ) {
    throw new FinancialEngineInvariantError(
      'cash_drag.inconsistent_current_completeness',
      'Complete Safe to Invest requires complete current liquidity.',
    );
  }
  if (liquidity.operationalStartInclusive !== effectiveDate) {
    throw new FinancialEngineInvariantError(
      'cash_drag.effective_date_mismatch',
      'Cash Drag effective date must match current liquidity.',
    );
  }

  const windowStart = addLocalDays(effectiveDate, -(settings.windowDays - 1));
  const inWindow = observations
    .filter((item) => item.date >= windowStart)
    .sort((left, right) => left.date.localeCompare(right.date));
  let completeDays = 0;
  let incompleteDays = 0;
  let positiveExcessDays = 0;
  let totalExcess = 0n;
  for (const item of inWindow) {
    if (item.completeness !== 'complete') {
      incompleteDays += 1;
      continue;
    }
    completeDays += 1;
    const excess =
      item.liquidCash.amountMinor > item.comfortCash.amountMinor
        ? item.liquidCash.amountMinor - item.comfortCash.amountMinor
        : 0n;
    totalExcess += excess;
    if (excess > 0n) positiveExcessDays += 1;
  }
  const currentExcess = liquidity.currentExcessAboveComfort.amountMinor;
  if (input.currentLiquidity.status === 'complete') {
    completeDays += 1;
    totalExcess += currentExcess;
    if (currentExcess > 0n) positiveExcessDays += 1;
  } else {
    incompleteDays += 1;
  }
  const missingDays = settings.windowDays - completeDays - incompleteDays;
  const averageExcess =
    completeDays === 0 ? null : halfEvenDivide(totalExcess, BigInt(completeDays));
  const relativeThreshold = multiplyFractionHalfEven(
    liquidity.comfortCash.amountMinor,
    settings.relativeComfortThreshold.numerator,
    settings.relativeComfortThreshold.denominator,
  );
  const effectiveThreshold =
    settings.absoluteExcessThreshold.amountMinor > relativeThreshold
      ? settings.absoluteExcessThreshold.amountMinor
      : relativeThreshold;
  const suppressionReasons: CashDragSuppressionReason[] = [];
  if (input.currentLiquidity.status !== 'complete')
    suppressionReasons.push('current_liquidity_not_complete');
  if (input.currentSafeToInvest.status !== 'complete')
    suppressionReasons.push('current_safe_to_invest_not_complete');
  if (completeDays < settings.minimumCompleteDays)
    suppressionReasons.push('insufficient_complete_history');
  if (positiveExcessDays < settings.minimumPositiveExcessDays)
    suppressionReasons.push('insufficient_positive_excess_days');
  if (currentExcess === 0n) suppressionReasons.push('no_current_excess');
  if (safe.recommended.amountMinor === 0n)
    suppressionReasons.push('no_current_investable_capacity');
  if (averageExcess !== null && averageExcess <= effectiveThreshold)
    suppressionReasons.push('average_excess_not_above_threshold');
  const value = Object.freeze({
    eligible: suppressionReasons.length === 0,
    windowStartInclusive: windowStart,
    windowEndInclusive: effectiveDate,
    completeDays,
    incompleteDays,
    missingDays,
    positiveExcessDays,
    totalExcess: money(totalExcess),
    currentExcess: money(currentExcess),
    averageExcess: averageExcess === null ? null : money(averageExcess),
    absoluteThreshold: settings.absoluteExcessThreshold,
    relativeThreshold: money(relativeThreshold),
    effectiveThreshold: money(effectiveThreshold),
    actionCap: money(safe.recommended.amountMinor),
    suppressionReasons: Object.freeze(suppressionReasons),
  });
  const partial =
    input.currentLiquidity.status !== 'complete' ||
    input.currentSafeToInvest.status !== 'complete' ||
    completeDays < settings.minimumCompleteDays;
  const warnings: DataWarning[] = [...currentWarnings];
  if (completeDays < settings.minimumCompleteDays) {
    warnings.push(
      warning('cash_drag.insufficient_history', {
        completeDays: completeDays.toString(),
        requiredDays: settings.minimumCompleteDays.toString(),
      }),
    );
  }
  if (
    input.currentLiquidity.status !== 'complete' ||
    input.currentSafeToInvest.status !== 'complete'
  ) {
    warnings.push(warning('cash_drag.current_inputs_partial'));
  }
  return createMetricResult({
    ...base,
    status: partial ? 'partial' : 'complete',
    value,
    explanation: explanation(value),
    warnings,
  });
}
