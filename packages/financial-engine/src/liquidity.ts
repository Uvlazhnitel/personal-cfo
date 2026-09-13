import {
  EUR,
  createExactFraction,
  createFutureObligation,
  createMetricResult,
  createMoney,
  createOperationalNeed,
  createRestrictedCash,
  parseCompleteness,
  parseInstant,
  parseLocalDate,
} from '@personal-cfo/domain';
import type {
  Completeness,
  DataWarning,
  ExactFraction,
  ExplanationComponent,
  FutureObligation,
  Instant,
  LocalDate,
  MetricResult,
  Money,
  OperationalNeed,
  RestrictedCash,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import { halfEvenDivide, multiplyFractionHalfEven } from './exact-math.js';
import {
  addLocalDays,
  daysInGregorianMonth,
  localDateOrdinal,
  localDaysBetween,
} from './local-calendar.js';
import type { CurrentCycleSinkingDue } from './sinking-funds.js';
import type { SpendingBaseline } from './spending-baseline.js';

export type LiquiditySettings = Readonly<{
  minimumReserveMonths: ExactFraction;
  comfortReserveMonths: ExactFraction;
  unknownIncomeHorizonDays: number;
  obligationHorizonDays: number;
}>;

export type LiquidityInputCompleteness = Readonly<{
  operationalNeeds: Completeness;
  obligations: Completeness;
  restrictedCash: Completeness;
}>;

export type LiquidityReserve = Readonly<{
  currentLiquidCash: Money;
  operationalEssential: Money;
  operationalNormal: Money;
  ringFencedCash: Money;
  sinkingFundReservedCash: Money;
  otherRestrictedCash: Money;
  currentCycleSinkingDue: Money;
  uncoveredObligations: Money;
  minimumReserveTarget: Money;
  comfortReserveTarget: Money;
  variabilityBuffer: Money;
  minimumCash: Money;
  comfortCash: Money;
  freeLiquidCash: Money;
  currentExcessAboveComfort: Money;
  operationalStartInclusive: LocalDate;
  operationalEndExclusive: LocalDate;
}>;

export type LiquidityReserveInput = Readonly<{
  baseline: MetricResult<SpendingBaseline>;
  sinkingProtection: MetricResult<CurrentCycleSinkingDue>;
  currentLiquidCash: MetricResult<Money>;
  operationalNeeds: readonly OperationalNeed[];
  futureObligations: readonly FutureObligation[];
  otherRestrictedCash: readonly RestrictedCash[];
  inputCompleteness: LiquidityInputCompleteness;
  nextReliableIncomeDate: LocalDate | null;
  effectiveDate: LocalDate;
  settings: LiquiditySettings;
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

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length)
    throw new FinancialEngineInvariantError(code, message);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function prorateMonthly(amountMinor: bigint, start: LocalDate, end: LocalDate): bigint {
  let numerator = 0n;
  let denominator = 1n;
  for (let ordinal = localDateOrdinal(start); ordinal < localDateOrdinal(end); ordinal += 1) {
    const date = addLocalDays(start, ordinal - localDateOrdinal(start));
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(5, 7));
    const days = BigInt(daysInGregorianMonth(year, month));
    const common = (denominator / gcd(denominator, days)) * days;
    numerator = numerator * (common / denominator) + amountMinor * (common / days);
    denominator = common;
  }
  return halfEvenDivide(numerator, denominator);
}

function validateSettings(settings: LiquiditySettings): LiquiditySettings {
  const minimum = createExactFraction(
    settings.minimumReserveMonths.numerator,
    settings.minimumReserveMonths.denominator,
  );
  const comfort = createExactFraction(
    settings.comfortReserveMonths.numerator,
    settings.comfortReserveMonths.denominator,
  );
  if (
    minimum.numerator < 0n ||
    comfort.numerator < 0n ||
    comfort.numerator * minimum.denominator < minimum.numerator * comfort.denominator ||
    !Number.isSafeInteger(settings.unknownIncomeHorizonDays) ||
    settings.unknownIncomeHorizonDays !== 31 ||
    !Number.isSafeInteger(settings.obligationHorizonDays) ||
    settings.obligationHorizonDays <= 0 ||
    settings.obligationHorizonDays > 3_660
  ) {
    throw new FinancialEngineInvariantError(
      'liquidity.invalid_settings',
      'Liquidity settings violate the accepted Stage 2D policy.',
    );
  }
  return Object.freeze({
    ...settings,
    minimumReserveMonths: minimum,
    comfortReserveMonths: comfort,
  });
}

function validateUpstream(input: LiquidityReserveInput, asOf: Instant): void {
  for (const result of [input.baseline, input.sinkingProtection, input.currentLiquidCash]) {
    if (result.asOf !== asOf || result.settingsVersion !== input.settingsVersion) {
      throw new FinancialEngineInvariantError(
        'liquidity.upstream_metadata_mismatch',
        'Liquidity upstream metrics must share as-of and settings version.',
      );
    }
  }
}

function canonicalOperationalNeeds(values: readonly OperationalNeed[]): readonly OperationalNeed[] {
  const result = Object.freeze(values.map((item) => createOperationalNeed(item)));
  requireUnique(
    result.map((item) => item.id),
    'liquidity.duplicate_operational_need',
    'Operational need IDs must be unique.',
  );
  const groups = new Map<string, OperationalNeed[]>();
  for (const item of result) {
    const key = item.scheduledSpendingId ?? item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return Object.freeze(
    [...groups.values()].map((group) => {
      const booked = group.find((item) => item.state === 'booked');
      if (booked !== undefined) return booked;
      const pending = group.filter((item) => item.state === 'pending');
      if (pending.length > 1) {
        throw new FinancialEngineInvariantError(
          'liquidity.duplicate_pending_schedule',
          'A recurring schedule can have only one pending operational debit.',
        );
      }
      const scheduled = group.filter((item) => item.state === 'scheduled');
      if (pending.length === 0 && scheduled.length > 1) {
        throw new FinancialEngineInvariantError(
          'liquidity.duplicate_scheduled_need',
          'A recurring schedule can have only one active scheduled operational debit.',
        );
      }
      return pending[0] ?? scheduled[0]!;
    }),
  );
}

function validateBaseline(value: SpendingBaseline): void {
  const monetary = [
    value.normalBaseline,
    value.essentialBaseline,
    value.recurringNormal,
    value.recurringEssential,
    value.variableNormal,
    value.variableEssential,
    value.variabilityBuffer,
  ];
  if (
    monetary.some((item) => item.currency !== EUR || item.amountMinor < 0n) ||
    value.essentialBaseline.amountMinor > value.normalBaseline.amountMinor ||
    value.recurringEssential.amountMinor > value.recurringNormal.amountMinor ||
    value.variableEssential.amountMinor > value.variableNormal.amountMinor
  ) {
    throw new FinancialEngineInvariantError(
      'liquidity.invalid_baseline',
      'Liquidity requires a non-negative ordered EUR Spending Baseline.',
    );
  }
}

function validateSinkingProtection(value: CurrentCycleSinkingDue): void {
  requireUnique(
    value.byFund.map((item) => item.fundId),
    'liquidity.duplicate_sinking_fund',
    'Trusted Sinking protection fund IDs must be unique.',
  );
  const required = value.byFund.reduce((sum, item) => sum + item.required.amountMinor, 0n);
  const satisfied = value.byFund.reduce((sum, item) => sum + item.satisfied.amountMinor, 0n);
  const reserved = value.byFund.reduce((sum, item) => sum + item.reserved.amountMinor, 0n);
  const outstanding = value.byFund.reduce((sum, item) => sum + item.outstanding.amountMinor, 0n);
  if (
    value.byFund.some(
      (item) =>
        item.required.currency !== EUR ||
        item.satisfied.currency !== EUR ||
        item.reserved.currency !== EUR ||
        item.outstanding.currency !== EUR ||
        item.protected.currency !== EUR ||
        item.required.amountMinor < 0n ||
        item.satisfied.amountMinor < 0n ||
        item.reserved.amountMinor < 0n ||
        item.outstanding.amountMinor < 0n ||
        item.protected.amountMinor !== item.reserved.amountMinor + item.outstanding.amountMinor,
    ) ||
    value.totalRequired.currency !== EUR ||
    value.totalSatisfied.currency !== EUR ||
    value.totalReserved.currency !== EUR ||
    value.totalOutstanding.currency !== EUR ||
    value.totalProtected.currency !== EUR ||
    value.totalRequired.amountMinor !== required ||
    value.totalSatisfied.amountMinor !== satisfied ||
    value.totalReserved.amountMinor !== reserved ||
    value.totalOutstanding.amountMinor !== outstanding ||
    value.totalProtected.amountMinor !== reserved + outstanding
  ) {
    throw new FinancialEngineInvariantError(
      'liquidity.invalid_sinking_protection',
      'Trusted Sinking protection must reconcile by fund and in total.',
    );
  }
}

function obligationAmount(value: FutureObligation): bigint {
  return value.amount.kind === 'exact'
    ? value.amount.amount.amountMinor
    : value.amount.upper.amountMinor;
}

function resultExplanation(value: LiquidityReserve): readonly ExplanationComponent[] {
  const rows: readonly (readonly [string, keyof LiquidityReserve])[] = [
    ['liquidity.current-cash', 'currentLiquidCash'],
    ['liquidity.operational-essential', 'operationalEssential'],
    ['liquidity.operational-normal', 'operationalNormal'],
    ['liquidity.ring-fenced', 'ringFencedCash'],
    ['liquidity.sinking-due', 'currentCycleSinkingDue'],
    ['liquidity.uncovered-obligations', 'uncoveredObligations'],
    ['liquidity.minimum-reserve-target', 'minimumReserveTarget'],
    ['liquidity.comfort-reserve-target', 'comfortReserveTarget'],
    ['liquidity.minimum-cash', 'minimumCash'],
    ['liquidity.comfort-cash', 'comfortCash'],
    ['liquidity.free-liquid-cash', 'freeLiquidCash'],
    ['liquidity.current-excess', 'currentExcessAboveComfort'],
  ];
  return Object.freeze(
    rows.map(([ruleId, key]) => {
      const item = value[key];
      if (typeof item === 'string') throw new Error('Unexpected explanation value.');
      return Object.freeze({ ruleId, inputKey: key, value: item.amountMinor.toString() });
    }),
  );
}

export function calculateLiquidityReserve(
  input: LiquidityReserveInput,
): MetricResult<LiquidityReserve> {
  const asOf = parseInstant(input.asOf);
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const settings = validateSettings(input.settings);
  validateUpstream(input, asOf);
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  const warnings: DataWarning[] = [
    ...input.baseline.warnings,
    ...input.sinkingProtection.warnings,
    ...input.currentLiquidCash.warnings,
  ];
  const completeness = {
    operationalNeeds: parseCompleteness(input.inputCompleteness.operationalNeeds),
    obligations: parseCompleteness(input.inputCompleteness.obligations),
    restrictedCash: parseCompleteness(input.inputCompleteness.restrictedCash),
  };
  if (
    input.baseline.value === null ||
    input.sinkingProtection.value === null ||
    input.currentLiquidCash.value === null ||
    Object.values(completeness).includes('unavailable')
  ) {
    return createMetricResult<LiquidityReserve>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [...warnings, warning('liquidity.missing_required_input')],
    });
  }
  const baseline = input.baseline.value;
  const sinking = input.sinkingProtection.value;
  validateBaseline(baseline);
  validateSinkingProtection(sinking);
  const currentCash = createMoney(
    input.currentLiquidCash.value.amountMinor,
    input.currentLiquidCash.value.currency,
  );
  if (currentCash.currency !== EUR) {
    throw new FinancialEngineInvariantError(
      'liquidity.currency_mismatch',
      'Liquidity values must use EUR.',
    );
  }
  const nextIncome =
    input.nextReliableIncomeDate === null ? null : parseLocalDate(input.nextReliableIncomeDate);
  if (nextIncome !== null && localDaysBetween(effectiveDate, nextIncome) <= 0) {
    throw new FinancialEngineInvariantError(
      'liquidity.invalid_income_date',
      'Next reliable income must be after the effective date.',
    );
  }
  const operationalEnd =
    nextIncome ?? addLocalDays(effectiveDate, settings.unknownIncomeHorizonDays);
  if (nextIncome === null)
    warnings.push(warning('liquidity.unknown_next_income', { horizonDays: '31' }));

  const needs = canonicalOperationalNeeds(input.operationalNeeds);
  const operationalIds = new Set(needs.map((item) => item.id));
  let scheduledNormal = 0n;
  let scheduledEssential = 0n;
  for (const need of needs) {
    if (need.amount.currency !== EUR)
      throw new FinancialEngineInvariantError(
        'liquidity.currency_mismatch',
        'Operational needs must use EUR.',
      );
    if (
      need.state === 'booked' ||
      need.direction === 'credit' ||
      need.dueDate < effectiveDate ||
      need.dueDate >= operationalEnd
    )
      continue;
    scheduledNormal += need.amount.amountMinor;
    if (need.necessity === 'essential') scheduledEssential += need.amount.amountMinor;
  }
  const variableNormal = prorateMonthly(
    baseline.variableNormal.amountMinor,
    effectiveDate,
    operationalEnd,
  );
  const variableEssential = prorateMonthly(
    baseline.variableEssential.amountMinor,
    effectiveDate,
    operationalEnd,
  );
  const operationalNormal = scheduledNormal + variableNormal;
  const operationalEssential = scheduledEssential + variableEssential;
  if (operationalEssential > operationalNormal) {
    throw new FinancialEngineInvariantError(
      'liquidity.operational_order',
      'Operational essential cannot exceed operational normal.',
    );
  }

  const obligations = Object.freeze(
    input.futureObligations.map((item) => createFutureObligation(item)),
  );
  requireUnique(
    obligations.map((item) => item.id),
    'liquidity.duplicate_obligation',
    'Future obligation IDs must be unique.',
  );
  const coveredFundIds = new Set(
    sinking.byFund.filter((item) => item.state !== 'inactive').map((item) => item.fundId),
  );
  const obligationEnd = addLocalDays(effectiveDate, settings.obligationHorizonDays);
  let uncovered = 0n;
  for (const obligation of obligations) {
    const amount = obligationAmount(obligation);
    const currency =
      obligation.amount.kind === 'exact'
        ? obligation.amount.amount.currency
        : obligation.amount.upper.currency;
    if (currency !== EUR)
      throw new FinancialEngineInvariantError(
        'liquidity.currency_mismatch',
        'Future obligations must use EUR.',
      );
    if (
      obligation.status !== 'open' ||
      obligation.dueDate < effectiveDate ||
      obligation.dueDate >= obligationEnd ||
      (obligation.priority === 'optional' && !obligation.committed)
    )
      continue;
    if (obligation.coverage.kind === 'sinking_fund') {
      if (!coveredFundIds.has(obligation.coverage.fundId)) {
        throw new FinancialEngineInvariantError(
          'liquidity.unknown_sinking_coverage',
          'Sinking-covered obligations must reference trusted Stage 2C output.',
        );
      }
      continue;
    }
    if (obligation.coverage.kind === 'operational') {
      if (!operationalIds.has(obligation.coverage.operationalNeedId)) {
        throw new FinancialEngineInvariantError(
          'liquidity.unknown_operational_coverage',
          'Operational-covered obligations must reference an operational need.',
        );
      }
      continue;
    }
    uncovered += amount;
  }

  const restricted = Object.freeze(
    input.otherRestrictedCash.map((item) => createRestrictedCash(item)),
  );
  requireUnique(
    restricted.map((item) => item.id),
    'liquidity.duplicate_restricted_cash',
    'Restricted cash IDs must be unique.',
  );
  const otherRestricted = restricted.reduce((sum, item) => {
    if (item.amount.currency !== EUR)
      throw new FinancialEngineInvariantError(
        'liquidity.currency_mismatch',
        'Restricted cash must use EUR.',
      );
    return sum + item.amount.amountMinor;
  }, 0n);
  const ringFenced = sinking.totalReserved.amountMinor + otherRestricted;
  if (ringFenced > currentCash.amountMinor) {
    throw new FinancialEngineInvariantError(
      'liquidity.restricted_exceeds_cash',
      'Ring-fenced cash cannot exceed owned liquid cash.',
    );
  }
  const minimumReserve = multiplyFractionHalfEven(
    baseline.essentialBaseline.amountMinor,
    settings.minimumReserveMonths.numerator,
    settings.minimumReserveMonths.denominator,
  );
  const comfortReserve =
    multiplyFractionHalfEven(
      baseline.normalBaseline.amountMinor,
      settings.comfortReserveMonths.numerator,
      settings.comfortReserveMonths.denominator,
    ) + baseline.variabilityBuffer.amountMinor;
  if (comfortReserve < minimumReserve) {
    throw new FinancialEngineInvariantError(
      'liquidity.reserve_order',
      'Comfort reserve cannot be below minimum reserve.',
    );
  }
  const protectedBase = ringFenced + sinking.totalOutstanding.amountMinor + uncovered;
  const minimumCash =
    protectedBase + (operationalEssential > minimumReserve ? operationalEssential : minimumReserve);
  const comfortCash =
    protectedBase + (operationalNormal > comfortReserve ? operationalNormal : comfortReserve);
  if (comfortCash < minimumCash) {
    throw new FinancialEngineInvariantError(
      'liquidity.cash_order',
      'Comfort cash cannot be below minimum cash.',
    );
  }
  const value = Object.freeze({
    currentLiquidCash: currentCash,
    operationalEssential: money(operationalEssential),
    operationalNormal: money(operationalNormal),
    ringFencedCash: money(ringFenced),
    sinkingFundReservedCash: sinking.totalReserved,
    otherRestrictedCash: money(otherRestricted),
    currentCycleSinkingDue: sinking.totalOutstanding,
    uncoveredObligations: money(uncovered),
    minimumReserveTarget: money(minimumReserve),
    comfortReserveTarget: money(comfortReserve),
    variabilityBuffer: baseline.variabilityBuffer,
    minimumCash: money(minimumCash),
    comfortCash: money(comfortCash),
    freeLiquidCash: money(currentCash.amountMinor - ringFenced),
    currentExcessAboveComfort: money(
      currentCash.amountMinor > comfortCash ? currentCash.amountMinor - comfortCash : 0n,
    ),
    operationalStartInclusive: effectiveDate,
    operationalEndExclusive: operationalEnd,
  });
  const partial =
    nextIncome === null ||
    input.baseline.status === 'partial' ||
    input.sinkingProtection.status === 'partial' ||
    input.currentLiquidCash.status === 'partial' ||
    Object.values(completeness).includes('partial');
  for (const [key, status] of Object.entries(completeness)) {
    if (status === 'partial') warnings.push(warning(`liquidity.partial_${key}`));
  }
  return createMetricResult({
    ...base,
    status: partial ? 'partial' : 'complete',
    value,
    explanation: resultExplanation(value),
    warnings,
  });
}
