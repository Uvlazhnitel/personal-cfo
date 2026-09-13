import {
  EUR,
  createInvestabilityReadiness,
  createMetricResult,
  createMoney,
  parseInstant,
} from '@personal-cfo/domain';
import type {
  DataWarning,
  ExplanationComponent,
  Instant,
  InvestabilityReadiness,
  MetricResult,
  Money,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import type { LiquidityReserve } from './liquidity.js';

export type SafeToInvestSettings = Readonly<{
  recommendationIncrement: Money;
}>;

export type SafeToInvest = Readonly<{
  conservative: Money;
  recommended: Money;
  maximum: Money;
  unroundedConservative: Money;
  unroundedRecommended: Money;
  unroundedMaximum: Money;
  conservativeRoundingLoss: Money;
  recommendedRoundingLoss: Money;
  maximumRoundingLoss: Money;
  recommendationIncrement: Money;
  liquidCash: Money;
  minimumCash: Money;
  comfortCash: Money;
  variabilityBuffer: Money;
}>;

export type SafeToInvestInput = Readonly<{
  liquidity: MetricResult<LiquidityReserve>;
  readiness: InvestabilityReadiness;
  settings: SafeToInvestSettings;
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

function validateSettings(settings: SafeToInvestSettings): SafeToInvestSettings {
  const recommendationIncrement = createMoney(
    settings.recommendationIncrement.amountMinor,
    settings.recommendationIncrement.currency,
  );
  if (recommendationIncrement.currency !== EUR || recommendationIncrement.amountMinor <= 0n) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.invalid_settings',
      'The recommendation increment must be positive EUR money.',
    );
  }
  return Object.freeze({ recommendationIncrement });
}

function validateLiquidity(value: LiquidityReserve): void {
  const amounts = [
    value.currentLiquidCash,
    value.minimumCash,
    value.comfortCash,
    value.variabilityBuffer,
    value.currentExcessAboveComfort,
  ];
  if (amounts.some((item) => item.currency !== EUR || item.amountMinor < 0n)) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.invalid_liquidity',
      'Safe to Invest requires non-negative EUR liquidity values.',
    );
  }
  if (value.minimumCash.amountMinor > value.comfortCash.amountMinor) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.invalid_liquidity_order',
      'Minimum cash cannot exceed comfort cash.',
    );
  }
  const currentExcess =
    value.currentLiquidCash.amountMinor > value.comfortCash.amountMinor
      ? value.currentLiquidCash.amountMinor - value.comfortCash.amountMinor
      : 0n;
  if (value.currentExcessAboveComfort.amountMinor !== currentExcess) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.current_excess_mismatch',
      'Current excess must reconcile to current liquid cash and comfort cash.',
    );
  }
}

function floorAtZero(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

function roundDown(value: bigint, increment: bigint): bigint {
  return value - (value % increment);
}

function explanation(value: SafeToInvest): readonly ExplanationComponent[] {
  const rows: readonly (readonly [string, keyof SafeToInvest])[] = [
    ['safe-to-invest.liquid-cash', 'liquidCash'],
    ['safe-to-invest.minimum-cash', 'minimumCash'],
    ['safe-to-invest.comfort-cash', 'comfortCash'],
    ['safe-to-invest.additional-variability-buffer', 'variabilityBuffer'],
    ['safe-to-invest.increment', 'recommendationIncrement'],
    ['safe-to-invest.unrounded-conservative', 'unroundedConservative'],
    ['safe-to-invest.rounded-conservative', 'conservative'],
    ['safe-to-invest.conservative-rounding-loss', 'conservativeRoundingLoss'],
    ['safe-to-invest.unrounded-recommended', 'unroundedRecommended'],
    ['safe-to-invest.rounded-recommended', 'recommended'],
    ['safe-to-invest.recommended-rounding-loss', 'recommendedRoundingLoss'],
    ['safe-to-invest.unrounded-maximum', 'unroundedMaximum'],
    ['safe-to-invest.rounded-maximum', 'maximum'],
    ['safe-to-invest.maximum-rounding-loss', 'maximumRoundingLoss'],
  ];
  return Object.freeze(
    rows.map(([ruleId, key]) =>
      Object.freeze({ ruleId, inputKey: key, value: value[key].amountMinor.toString() }),
    ),
  );
}

export function calculateSafeToInvest(input: SafeToInvestInput): MetricResult<SafeToInvest> {
  const asOf = parseInstant(input.asOf);
  const settings = validateSettings(input.settings);
  const readiness = createInvestabilityReadiness(input.readiness);
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  if (input.liquidity.asOf !== asOf || input.liquidity.settingsVersion !== input.settingsVersion) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.upstream_metadata_mismatch',
      'Liquidity must share the Safe to Invest as-of and settings version.',
    );
  }
  const warnings: DataWarning[] = [...input.liquidity.warnings];
  if (readiness.kind === 'blocked') {
    warnings.push(warning('safe_to_invest.blocked', { reasons: readiness.reasons.join(',') }));
    return createMetricResult<SafeToInvest>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings,
    });
  }
  if (input.liquidity.value === null) {
    warnings.push(warning('safe_to_invest.missing_liquidity'));
    return createMetricResult<SafeToInvest>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings,
    });
  }
  validateLiquidity(input.liquidity.value);
  if (input.liquidity.status === 'partial' && readiness.kind === 'complete') {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.unclassified_partial_liquidity',
      'Partial liquidity requires explicit provisional or blocked readiness.',
    );
  }

  const liquidity = input.liquidity.value;
  const unroundedRecommended = floorAtZero(
    liquidity.currentLiquidCash.amountMinor - liquidity.comfortCash.amountMinor,
  );
  const unroundedConservative = floorAtZero(
    unroundedRecommended - liquidity.variabilityBuffer.amountMinor,
  );
  const unroundedMaximum = floorAtZero(
    liquidity.currentLiquidCash.amountMinor - liquidity.minimumCash.amountMinor,
  );
  if (unroundedConservative > unroundedRecommended || unroundedRecommended > unroundedMaximum) {
    throw new FinancialEngineInvariantError(
      'safe_to_invest.tier_order',
      'Safe to Invest tiers must be ordered conservative, recommended, maximum.',
    );
  }
  const increment = settings.recommendationIncrement.amountMinor;
  const conservative = roundDown(unroundedConservative, increment);
  const recommended = roundDown(unroundedRecommended, increment);
  const maximum = roundDown(unroundedMaximum, increment);
  const value = Object.freeze({
    conservative: money(conservative),
    recommended: money(recommended),
    maximum: money(maximum),
    unroundedConservative: money(unroundedConservative),
    unroundedRecommended: money(unroundedRecommended),
    unroundedMaximum: money(unroundedMaximum),
    conservativeRoundingLoss: money(unroundedConservative - conservative),
    recommendedRoundingLoss: money(unroundedRecommended - recommended),
    maximumRoundingLoss: money(unroundedMaximum - maximum),
    recommendationIncrement: settings.recommendationIncrement,
    liquidCash: money(liquidity.currentLiquidCash.amountMinor),
    minimumCash: money(liquidity.minimumCash.amountMinor),
    comfortCash: money(liquidity.comfortCash.amountMinor),
    variabilityBuffer: money(liquidity.variabilityBuffer.amountMinor),
  });
  if (readiness.kind === 'provisional') {
    warnings.push(warning('safe_to_invest.provisional', { reasons: readiness.reasons.join(',') }));
  }
  return createMetricResult({
    ...base,
    status: readiness.kind === 'provisional' ? 'partial' : 'complete',
    value,
    explanation: explanation(value),
    warnings,
  });
}
