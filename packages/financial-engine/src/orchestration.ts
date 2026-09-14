import {
  createCashDragDailyObservation,
  createCashReconciliationResolution,
  createFlowAmbiguity,
  createInvestabilityReadiness,
  createMetricResult,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  yearMonthOf,
} from '@personal-cfo/domain';
import type {
  AccountBalanceSnapshot,
  CalendarMonthCoverage,
  CanonicalTransaction,
  CashReconciliation,
  CashReconciliationResolution,
  CycleCapacityIssue,
  CycleInvestmentCapacityReadiness,
  Completeness,
  DataWarning,
  EconomicFlow,
  ExpectedPrimaryPaySchedule,
  FlowAmbiguity,
  ForecastCapitalFlow,
  ForecastPlannedExpense,
  ForecastPlannedExpenseId,
  FutureObligation,
  Instant,
  InvestmentContributionAttribution,
  InvestabilityReadiness,
  LocalDate,
  MeasurementPeriod,
  MetricResult,
  Money,
  OperationalNeed,
  PayCycle,
  PayCycleId,
  PortfolioValuation,
  PrimarySalaryTrigger,
  RecurringInvestmentPlanId,
  RestrictedCash,
  ScheduledSpending,
  SinkingFund,
  SinkingFundAllocation,
  SpendingObservation,
} from '@personal-cfo/domain';

import type {
  CapitalConversionRateValue,
  RollingCapitalConversionResult,
} from './capital-conversion.js';
import {
  calculateCapitalConversionRate,
  calculateRollingCapitalConversionRates,
} from './capital-conversion.js';
import type { CashDragAssessment, CashDragSettings } from './cash-drag.js';
import { calculateCashDrag } from './cash-drag.js';
import { FinancialEngineInvariantError } from './errors.js';
import type { FinancialForecast, ForecastSettings } from './forecast.js';
import { calculateFinancialForecast } from './forecast.js';
import type { ForwardProjectionSource } from './forward-projection.js';
import { assembleForwardLiquidityProjection } from './forward-projection.js';
import type {
  HistoricalInvestmentCapacity,
  InvestmentContributionDecision,
  InvestmentStepSettings,
} from './investment-step.js';
import {
  calculateHistoricalInvestmentCapacity,
  evaluateInvestmentContributionStep,
} from './investment-step.js';
import type { LedgerInput } from './ledger.js';
import type {
  LiquidityInputCompleteness,
  LiquidityReserve,
  LiquiditySettings,
} from './liquidity.js';
import { calculateLiquidityReserve } from './liquidity.js';
import { addLocalDays, addYearMonths, localDateOrdinal } from './local-calendar.js';
import type { NetWorthBreakdown } from './net-worth.js';
import { calculateNetWorth } from './net-worth.js';
import { buildPayCycles } from './pay-cycles.js';
import type { CurrentPositions } from './positions.js';
import { calculateCurrentPositions } from './positions.js';
import type { SafeToInvest, SafeToInvestSettings } from './safe-to-invest.js';
import { calculateSafeToInvest } from './safe-to-invest.js';
import type { CurrentCycleSinkingDue } from './sinking-funds.js';
import {
  calculateCurrentCycleSinkingDue,
  calculateFundedConsumptionCoverage,
} from './sinking-funds.js';
import type { SpendingBaseline, SpendingBaselineSettings } from './spending-baseline.js';
import { calculateSpendingBaseline } from './spending-baseline.js';

export type FinancialEngineRun = Readonly<{
  asOf: Instant;
  effectiveDate: LocalDate;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

export type FinancialEngineSettings = Readonly<{
  effectiveFrom: LocalDate;
  version: string;
  spendingBaseline: SpendingBaselineSettings;
  liquidity: LiquiditySettings;
  safeToInvest: SafeToInvestSettings;
  cashDrag: CashDragSettings;
  investmentStep: InvestmentStepSettings;
  forecast: ForecastSettings;
}>;

export type CheckpointQuality = Readonly<{
  liquidityInputs: LiquidityInputCompleteness;
  liquidBalance: Completeness;
  spendingClassification: Completeness;
  reservationHistory: Completeness;
}>;

export type FinancialVariableFacts = Readonly<{
  economicFlows: readonly EconomicFlow[];
  ambiguities: readonly FlowAmbiguity[];
  cashReconciliations: readonly CashReconciliation[];
  sinkingFunds: readonly SinkingFund[];
  sinkingFundAllocations: readonly SinkingFundAllocation[];
  spendingObservations: readonly SpendingObservation[];
}>;

export type FinancialCheckpointFacts = Readonly<{
  variables: FinancialVariableFacts;
  monthCoverage: readonly CalendarMonthCoverage[];
  scheduledRecurring: readonly ScheduledSpending[];
  recurringScheduleComplete: boolean;
  operationalNeeds: readonly OperationalNeed[];
  futureObligations: readonly FutureObligation[];
  otherRestrictedCash: readonly RestrictedCash[];
  nextReliableIncomeDate: LocalDate | null;
  expectedPrimaryPaySchedule: ExpectedPrimaryPaySchedule;
  historyCoverage: MeasurementPeriod;
  reservationCoverage: MeasurementPeriod;
  quality: CheckpointQuality;
}>;

export type HistoricalFinancialCheckpoint = Readonly<
  | ({ kind: 'cash_drag_day'; date: LocalDate } & FinancialCheckpointFacts)
  | ({ kind: 'pre_closing'; payCycleId: PayCycleId } & FinancialCheckpointFacts)
>;

export type FinancialEngineCanonicalFacts = LedgerInput &
  FinancialVariableFacts &
  Readonly<{
    accountBalanceSnapshots: readonly AccountBalanceSnapshot[];
    portfolioValuations: readonly PortfolioValuation[];
    primarySalaryTriggers: readonly PrimarySalaryTrigger[];
    contributionAttributions: readonly InvestmentContributionAttribution[];
    cashReconciliationResolutions: readonly CashReconciliationResolution[];
  }>;

export type FinancialForecastPlan = Readonly<{
  capitalFlows: readonly ForecastCapitalFlow[];
  plannedExpenses: readonly ForecastPlannedExpense[];
  includedOptionalExpenseIds: readonly ForecastPlannedExpenseId[];
}>;

export type FinancialEngineInput = Readonly<{
  run: FinancialEngineRun;
  settingsHistory: readonly FinancialEngineSettings[];
  canonical: FinancialEngineCanonicalFacts;
  current: Omit<FinancialCheckpointFacts, 'variables'>;
  historicalCheckpoints: readonly HistoricalFinancialCheckpoint[];
  ccrPeriod: MeasurementPeriod;
  rollingCcrPeriods: readonly MeasurementPeriod[];
  forwardProjection: ForwardProjectionSource;
  recurringPlanId: RecurringInvestmentPlanId;
  currentRecurringContribution: Money;
  lastIssuedStepUpCycleIds: readonly PayCycleId[] | null;
  forecastPlan: FinancialForecastPlan;
}>;

export type FinancialEngineResult = Readonly<{
  run: FinancialEngineRun;
  payCycles: readonly PayCycle[];
  positions: CurrentPositions;
  netWorth: MetricResult<NetWorthBreakdown>;
  ccr: MetricResult<CapitalConversionRateValue>;
  rollingCcr: readonly RollingCapitalConversionResult[];
  currentCycleSinkingDue: MetricResult<CurrentCycleSinkingDue>;
  spendingBaseline: MetricResult<SpendingBaseline>;
  liquidityReserve: MetricResult<LiquidityReserve>;
  investabilityReadiness: InvestabilityReadiness;
  safeToInvest: MetricResult<SafeToInvest>;
  cashDrag: MetricResult<CashDragAssessment>;
  historicalInvestmentCapacity: MetricResult<HistoricalInvestmentCapacity>;
  investmentContributionDecision: MetricResult<InvestmentContributionDecision>;
  forecast: MetricResult<FinancialForecast>;
  activeAmbiguities: readonly FlowAmbiguity[];
  warnings: readonly DataWarning[];
}>;

type Metadata = Readonly<{
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

type CalculatedCheckpoint = Readonly<{
  positions: CurrentPositions;
  sinking: MetricResult<CurrentCycleSinkingDue>;
  baseline: MetricResult<SpendingBaseline>;
  liquidity: MetricResult<LiquidityReserve>;
  readiness: InvestabilityReadiness;
  safeToInvest: MetricResult<SafeToInvest>;
}>;

const RIGA_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Riga',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const UTC_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});
const EPOCH_ORDINAL = localDateOrdinal(parseLocalDate('1970-01-01'));
const DAY_MILLISECONDS = 86_400_000;

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length)
    throw new FinancialEngineInvariantError(code, message);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => structurallyEqual(item, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const keys = Object.keys(leftRecord).sort();
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(rightRecord, key) &&
        structurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function validateCheckpointCanonicalFacts(input: FinancialEngineInput): void {
  const validateSubset = <T>(
    values: readonly T[],
    canonical: readonly T[],
    identity: (value: T) => string,
  ) => {
    const byId = new Map(canonical.map((item) => [identity(item), item]));
    return values.every((item) => {
      const expected = byId.get(identity(item));
      return expected !== undefined && structurallyEqual(item, expected);
    });
  };
  for (const checkpoint of input.historicalCheckpoints) {
    const variables = checkpoint.variables;
    if (
      !validateSubset(variables.economicFlows, input.canonical.economicFlows, (item) => item.id) ||
      !validateSubset(
        variables.cashReconciliations,
        input.canonical.cashReconciliations,
        (item) => item.id,
      ) ||
      !validateSubset(variables.sinkingFunds, input.canonical.sinkingFunds, (item) => item.id) ||
      !validateSubset(
        variables.sinkingFundAllocations,
        input.canonical.sinkingFundAllocations,
        (item) => item.id,
      ) ||
      !validateSubset(
        variables.spendingObservations,
        input.canonical.spendingObservations,
        (item) => item.economicFlowId,
      )
    ) {
      throw new FinancialEngineInvariantError(
        'orchestration.checkpoint_canonical_mismatch',
        'Historical checkpoint facts must be exact subsets of the canonical run facts.',
      );
    }
  }
}

function localPartsMilliseconds(
  parts: readonly [number, number, number, number?, number?, number?],
): number {
  const date = parseLocalDate(
    `${parts[0].toString().padStart(4, '0')}-${parts[1].toString().padStart(2, '0')}-${parts[2].toString().padStart(2, '0')}`,
  );
  return (
    (localDateOrdinal(date) - EPOCH_ORDINAL) * DAY_MILLISECONDS +
    (parts[3] ?? 0) * 3_600_000 +
    (parts[4] ?? 0) * 60_000 +
    (parts[5] ?? 0) * 1_000
  );
}

function rigaParts(
  milliseconds: number,
): readonly [number, number, number, number, number, number] {
  const parts = Object.fromEntries(
    RIGA_FORMATTER.formatToParts(milliseconds)
      .filter((item) => item.type !== 'literal')
      .map((item) => [item.type, Number(item.value)]),
  );
  return [
    parts['year']!,
    parts['month']!,
    parts['day']!,
    parts['hour']!,
    parts['minute']!,
    parts['second']!,
  ] as const;
}

function rigaStartMilliseconds(date: LocalDate): number {
  const desired: readonly [number, number, number, number, number, number] = [
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)),
    Number(date.slice(8, 10)),
    0,
    0,
    0,
  ];
  const desiredUtc = localPartsMilliseconds(desired);
  let guess = desiredUtc;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = localPartsMilliseconds(rigaParts(guess));
    guess += desiredUtc - observed;
  }
  return guess;
}

function rigaDayClose(date: LocalDate): Instant {
  const next = addLocalDays(date, 1);
  const parts = Object.fromEntries(
    UTC_FORMATTER.formatToParts(rigaStartMilliseconds(next) - 1)
      .filter((item) => item.type !== 'literal')
      .map((item) => [item.type, item.value]),
  );
  return parseInstant(
    `${parts['year']!}-${parts['month']!}-${parts['day']!}T${parts['hour']!}:${parts['minute']!}:${parts['second']!}.999999Z`,
  );
}

function rigaDateOf(instant: Instant): LocalDate {
  const date = parseLocalDate(instant.slice(0, 10));
  const fractionalMilliseconds = Number(instant.slice(20, -1).padEnd(3, '0').slice(0, 3));
  const milliseconds =
    (localDateOrdinal(date) - EPOCH_ORDINAL) * DAY_MILLISECONDS +
    Number(instant.slice(11, 13)) * 3_600_000 +
    Number(instant.slice(14, 16)) * 60_000 +
    Number(instant.slice(17, 19)) * 1_000 +
    fractionalMilliseconds;
  const parts = rigaParts(milliseconds);
  return parseLocalDate(
    `${parts[0].toString().padStart(4, '0')}-${parts[1].toString().padStart(2, '0')}-${parts[2].toString().padStart(2, '0')}`,
  );
}

function canonicalSettings(
  values: readonly FinancialEngineSettings[],
): readonly FinancialEngineSettings[] {
  requireUnique(
    values.map((item) => item.version),
    'orchestration.duplicate_settings_version',
    'Settings versions must be unique.',
  );
  requireUnique(
    values.map((item) => item.effectiveFrom),
    'orchestration.duplicate_settings_date',
    'Settings effective dates must be unique.',
  );
  return Object.freeze(
    values
      .map((item) => Object.freeze({ ...item, effectiveFrom: parseLocalDate(item.effectiveFrom) }))
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
  );
}

function settingsAt(
  history: readonly FinancialEngineSettings[],
  date: LocalDate,
): FinancialEngineSettings | null {
  return history.filter((item) => item.effectiveFrom <= date).at(-1) ?? null;
}

function metadata(
  run: FinancialEngineRun,
  settingsVersion = run.settingsVersion,
  suffix = '',
): Metadata {
  return {
    asOf: run.asOf,
    engineVersion: run.engineVersion,
    settingsVersion,
    inputWatermark: suffix === '' ? run.inputWatermark : `${run.inputWatermark}:${suffix}`,
  };
}

function validateBookedFlows(
  transactions: readonly CanonicalTransaction[],
  flows: readonly EconomicFlow[],
): void {
  const byId = new Map(transactions.map((item) => [item.id, item]));
  requireUnique(
    flows.map((item) => item.id),
    'orchestration.duplicate_flow',
    'Economic-flow IDs must be unique.',
  );
  requireUnique(
    flows.map((item) => item.transactionId),
    'orchestration.duplicate_flow_transaction',
    'Economic flows must classify unique transactions.',
  );
  for (const flow of flows) {
    const transaction = byId.get(flow.transactionId);
    const expectedKind =
      flow.kind === 'cash_reconciliation_adjustment' ? 'valuation_adjustment' : 'external_flow';
    if (
      transaction === undefined ||
      transaction.bookingStatus !== 'booked' ||
      transaction.kind !== expectedKind ||
      transaction.effectiveAt !== flow.effectiveAt
    ) {
      throw new FinancialEngineInvariantError(
        'orchestration.unbooked_economic_flow',
        'Authoritative economic flows must match booked canonical transactions.',
      );
    }
  }
}

function validateCashReconciliationResolutions(
  canonical: FinancialEngineCanonicalFacts,
): readonly CashReconciliationResolution[] {
  const resolutions = canonical.cashReconciliationResolutions.map((item) =>
    createCashReconciliationResolution(item),
  );
  requireUnique(
    resolutions.map((item) => item.reconciliationId),
    'orchestration.duplicate_reconciliation_resolution',
    'A cash reconciliation can have only one active resolution fact.',
  );
  const reconciliations = new Map(canonical.cashReconciliations.map((item) => [item.id, item]));
  const transactions = new Map(canonical.transactions.map((item) => [item.id, item]));
  for (const resolution of resolutions) {
    const reconciliation = reconciliations.get(resolution.reconciliationId);
    const transaction = transactions.get(resolution.resolutionTransactionId);
    if (
      reconciliation === undefined ||
      resolution.resolvedAt < reconciliation.reconciledAt ||
      transaction === undefined ||
      transaction.bookingStatus !== 'booked' ||
      transaction.effectiveAt > resolution.resolvedAt
    ) {
      throw new FinancialEngineInvariantError(
        'orchestration.invalid_reconciliation_resolution',
        'A resolution must follow its reconciliation and reference an existing booked transaction.',
      );
    }
  }
  return Object.freeze(resolutions);
}

function filteredLedger(canonical: FinancialEngineCanonicalFacts, asOf: Instant): LedgerInput {
  const transactions = canonical.transactions.filter((item) => item.effectiveAt <= asOf);
  const ids = new Set(transactions.map((item) => item.id));
  return {
    accounts: canonical.accounts,
    transactions,
    investmentContributions: canonical.investmentContributions.filter((item) =>
      ids.has(item.transactionId),
    ),
  };
}

function activeVariablesAt(
  variables: FinancialVariableFacts,
  asOf: Instant,
  resolutions: readonly CashReconciliationResolution[],
): FinancialVariableFacts {
  const economicFlows = variables.economicFlows.filter((item) => item.effectiveAt <= asOf);
  const economicFlowIds = new Set(economicFlows.map((item) => item.id));
  return Object.freeze({
    economicFlows: Object.freeze(economicFlows),
    ambiguities: Object.freeze(variables.ambiguities.filter((item) => item.effectiveAt <= asOf)),
    cashReconciliations: Object.freeze(
      variables.cashReconciliations.filter(
        (item) =>
          item.reconciledAt <= asOf &&
          !resolutions.some(
            (resolution) =>
              resolution.reconciliationId === item.id && resolution.resolvedAt <= asOf,
          ),
      ),
    ),
    sinkingFunds: Object.freeze(variables.sinkingFunds.filter((item) => item.createdAt <= asOf)),
    sinkingFundAllocations: Object.freeze(
      variables.sinkingFundAllocations.filter((item) => item.effectiveAt <= asOf),
    ),
    spendingObservations: Object.freeze(
      variables.spendingObservations.filter((item) => economicFlowIds.has(item.economicFlowId)),
    ),
  });
}

export function deriveInvestabilityReadiness(
  input: Readonly<{
    positions: CurrentPositions;
    baseline: MetricResult<SpendingBaseline>;
    sinkingProtection: MetricResult<CurrentCycleSinkingDue>;
    liquidity: MetricResult<LiquidityReserve>;
    quality: CheckpointQuality;
    nextReliableIncomeDate: LocalDate | null;
    ambiguities: readonly FlowAmbiguity[];
    cashReconciliations: readonly CashReconciliation[];
  }>,
): InvestabilityReadiness {
  const blockers: string[] = [];
  const provisional: string[] = [];
  if (
    input.positions.liquidCash.status !== 'complete' ||
    input.quality.liquidBalance !== 'complete'
  )
    blockers.push('incomplete_liquid_balance');
  if (input.baseline.status !== 'complete') blockers.push('incomplete_spending_baseline');
  if (input.quality.liquidityInputs.obligations !== 'complete')
    blockers.push('incomplete_obligations');
  if (
    input.sinkingProtection.status !== 'complete' ||
    input.quality.reservationHistory !== 'complete' ||
    input.quality.liquidityInputs.restrictedCash !== 'complete'
  )
    blockers.push('incomplete_sinking_protection');
  if (input.nextReliableIncomeDate === null) blockers.push('unknown_next_reliable_income');
  if (
    input.liquidity.status !== 'complete' ||
    input.quality.liquidityInputs.operationalNeeds !== 'complete' ||
    input.quality.spendingClassification !== 'complete'
  )
    blockers.push('other_material_incompleteness');
  for (const ambiguity of input.ambiguities.map((item) => createFlowAmbiguity(item))) {
    if (ambiguity.kind === 'unresolved_transfer') {
      (ambiguity.materiality === 'material' ? blockers : provisional).push(
        ambiguity.materiality === 'material'
          ? 'material_unresolved_transfer'
          : 'non_material_unresolved_transfer',
      );
    } else {
      blockers.push('other_material_incompleteness');
    }
  }
  for (const reconciliation of input.cashReconciliations) {
    (reconciliation.materiality === 'material' ? blockers : provisional).push(
      reconciliation.materiality === 'material'
        ? 'material_cash_variance'
        : 'non_material_cash_variance',
    );
  }
  if (blockers.length > 0) {
    return createInvestabilityReadiness({
      kind: 'blocked',
      reasons: [...new Set(blockers)] as Extract<
        InvestabilityReadiness,
        { kind: 'blocked' }
      >['reasons'],
    });
  }
  if (provisional.length > 0) {
    return createInvestabilityReadiness({
      kind: 'provisional',
      reasons: [...new Set(provisional)] as Extract<
        InvestabilityReadiness,
        { kind: 'provisional' }
      >['reasons'],
    });
  }
  return createInvestabilityReadiness({ kind: 'complete' });
}

function calculateCheckpoint(
  input: FinancialEngineInput,
  facts: FinancialCheckpointFacts,
  asOf: Instant,
  effectiveDate: LocalDate,
  settings: FinancialEngineSettings,
  watermark: string,
  positionsOverride?: CurrentPositions,
): CalculatedCheckpoint {
  const run = { ...input.run, asOf, effectiveDate };
  const meta = metadata(run, settings.version, watermark);
  const variables = activeVariablesAt(
    facts.variables,
    asOf,
    input.canonical.cashReconciliationResolutions,
  );
  const ledger = filteredLedger(input.canonical, asOf);
  validateBookedFlows(ledger.transactions, variables.economicFlows);
  const positions =
    positionsOverride ??
    calculateCurrentPositions({
      ...ledger,
      accountBalanceSnapshots: input.canonical.accountBalanceSnapshots,
      portfolioValuations: input.canonical.portfolioValuations,
      ...meta,
    });
  const transactionIds = new Set(ledger.transactions.map((item) => item.id));
  const payCycles = buildPayCycles({
    transactions: ledger.transactions,
    economicFlows: variables.economicFlows,
    primarySalaryTriggers: input.canonical.primarySalaryTriggers.filter((item) =>
      transactionIds.has(item.transactionId),
    ),
    expectedPrimaryPaySchedule: facts.expectedPrimaryPaySchedule,
    asOf,
  });
  const sinking = calculateCurrentCycleSinkingDue({
    funds: variables.sinkingFunds,
    allocations: variables.sinkingFundAllocations,
    economicFlows: variables.economicFlows,
    reservationCoverage: facts.reservationCoverage,
    payCycles,
    expectedPrimaryPaySchedule: facts.expectedPrimaryPaySchedule,
    effectiveDate,
    ...meta,
  });
  const funded = calculateFundedConsumptionCoverage({
    funds: variables.sinkingFunds,
    allocations: variables.sinkingFundAllocations,
    economicFlows: variables.economicFlows,
    reservationCoverage: facts.reservationCoverage,
    asOf,
    engineVersion: meta.engineVersion,
    settingsVersion: meta.settingsVersion,
    inputWatermark: meta.inputWatermark,
  });
  const baseline = calculateSpendingBaseline({
    economicFlows: variables.economicFlows,
    observations: variables.spendingObservations,
    monthCoverage: facts.monthCoverage,
    scheduledRecurring: facts.scheduledRecurring,
    recurringScheduleComplete: facts.recurringScheduleComplete,
    fundedConsumptionCoverage: funded,
    targetMonth: yearMonthOf(effectiveDate),
    settings: settings.spendingBaseline,
    ...meta,
  });
  const liquidity = calculateLiquidityReserve({
    baseline,
    sinkingProtection: sinking,
    currentLiquidCash: positions.liquidCash,
    operationalNeeds: facts.operationalNeeds,
    futureObligations: facts.futureObligations,
    otherRestrictedCash: facts.otherRestrictedCash,
    inputCompleteness: facts.quality.liquidityInputs,
    nextReliableIncomeDate: facts.nextReliableIncomeDate,
    effectiveDate,
    settings: settings.liquidity,
    ...meta,
  });
  const readiness = deriveInvestabilityReadiness({
    positions,
    baseline,
    sinkingProtection: sinking,
    liquidity,
    quality: facts.quality,
    nextReliableIncomeDate: facts.nextReliableIncomeDate,
    ambiguities: variables.ambiguities,
    cashReconciliations: variables.cashReconciliations,
  });
  const safeToInvest = calculateSafeToInvest({
    liquidity,
    readiness,
    settings: settings.safeToInvest,
    ...meta,
  });
  return Object.freeze({ positions, sinking, baseline, liquidity, readiness, safeToInvest });
}

function checkpointWarnings(
  checkpoints: readonly HistoricalFinancialCheckpoint[],
  requiredDates: readonly LocalDate[],
  requiredCycles: readonly PayCycleId[],
): readonly DataWarning[] {
  const warnings: DataWarning[] = [];
  for (const date of requiredDates) {
    if (!checkpoints.some((item) => item.kind === 'cash_drag_day' && item.date === date)) {
      warnings.push(warning('orchestration.missing_cash_drag_checkpoint', { date }));
    }
  }
  for (const cycleId of requiredCycles) {
    if (!checkpoints.some((item) => item.kind === 'pre_closing' && item.payCycleId === cycleId)) {
      warnings.push(warning('orchestration.missing_pre_closing_checkpoint', { cycleId }));
    }
  }
  return Object.freeze(
    warnings.sort(
      (a, b) =>
        a.code.localeCompare(b.code) ||
        JSON.stringify(a.context).localeCompare(JSON.stringify(b.context)),
    ),
  );
}

export function evaluateFinancialState(input: FinancialEngineInput): FinancialEngineResult {
  const run: FinancialEngineRun = Object.freeze({
    asOf: parseInstant(input.run.asOf),
    effectiveDate: parseLocalDate(input.run.effectiveDate),
    engineVersion: input.run.engineVersion,
    settingsVersion: input.run.settingsVersion,
    inputWatermark: input.run.inputWatermark,
  });
  if (rigaDateOf(run.asOf) !== run.effectiveDate) {
    throw new FinancialEngineInvariantError(
      'orchestration.run_date_mismatch',
      'Run as-of must fall on the supplied Europe/Riga effective date.',
    );
  }
  const settingsHistory = canonicalSettings(input.settingsHistory);
  const currentSettings = settingsAt(settingsHistory, run.effectiveDate);
  if (currentSettings === null || currentSettings.version !== run.settingsVersion) {
    throw new FinancialEngineInvariantError(
      'orchestration.current_settings_mismatch',
      'The run settings version must be effective on the run date.',
    );
  }
  validateBookedFlows(input.canonical.transactions, input.canonical.economicFlows);
  validateCheckpointCanonicalFacts(input);
  const reconciliationResolutions = validateCashReconciliationResolutions(input.canonical);
  const currentVariables = activeVariablesAt(
    {
      economicFlows: input.canonical.economicFlows,
      ambiguities: input.canonical.ambiguities,
      cashReconciliations: input.canonical.cashReconciliations,
      sinkingFunds: input.canonical.sinkingFunds,
      sinkingFundAllocations: input.canonical.sinkingFundAllocations,
      spendingObservations: input.canonical.spendingObservations,
    },
    run.asOf,
    reconciliationResolutions,
  );
  const meta = metadata(run);
  const positions = calculateCurrentPositions({
    accounts: input.canonical.accounts,
    transactions: input.canonical.transactions,
    investmentContributions: input.canonical.investmentContributions,
    accountBalanceSnapshots: input.canonical.accountBalanceSnapshots,
    portfolioValuations: input.canonical.portfolioValuations,
    ...meta,
  });
  const netWorth = calculateNetWorth({
    accounts: input.canonical.accounts,
    transactions: input.canonical.transactions,
    investmentContributions: input.canonical.investmentContributions,
    accountBalanceSnapshots: input.canonical.accountBalanceSnapshots,
    portfolioValuations: input.canonical.portfolioValuations,
    ...meta,
  });
  const payCycles = buildPayCycles({
    transactions: input.canonical.transactions,
    economicFlows: currentVariables.economicFlows,
    primarySalaryTriggers: input.canonical.primarySalaryTriggers,
    expectedPrimaryPaySchedule: input.current.expectedPrimaryPaySchedule,
    asOf: run.asOf,
  });
  const currentFacts: FinancialCheckpointFacts = {
    ...input.current,
    variables: currentVariables,
  };
  const current = calculateCheckpoint(
    input,
    currentFacts,
    run.asOf,
    run.effectiveDate,
    currentSettings,
    '',
    positions,
  );
  const ccrInput = {
    accounts: input.canonical.accounts,
    transactions: input.canonical.transactions,
    investmentContributions: input.canonical.investmentContributions,
    economicFlows: currentVariables.economicFlows,
    cashReconciliations: currentVariables.cashReconciliations,
    ambiguities: currentVariables.ambiguities,
    historyCoverage: input.current.historyCoverage,
    sinkingFunds: currentVariables.sinkingFunds,
    sinkingFundAllocations: currentVariables.sinkingFundAllocations,
    reservationCoverage: input.current.reservationCoverage,
    ...meta,
  };
  const ccr = calculateCapitalConversionRate({ ...ccrInput, period: input.ccrPeriod });
  const rollingCcr = calculateRollingCapitalConversionRates({
    ...ccrInput,
    periods: input.rollingCcrPeriods,
  });

  const dailyDates = Array.from({ length: currentSettings.cashDrag.windowDays - 1 }, (_, index) =>
    addLocalDays(run.effectiveDate, index - (currentSettings.cashDrag.windowDays - 1)),
  );
  requireUnique(
    input.historicalCheckpoints.map((item) =>
      item.kind === 'cash_drag_day' ? `day:${item.date}` : `cycle:${item.payCycleId}`,
    ),
    'orchestration.duplicate_checkpoint',
    'Historical checkpoint identities must be unique.',
  );
  const dailyObservations = [];
  for (const date of dailyDates) {
    const checkpoint = input.historicalCheckpoints.find(
      (item) => item.kind === 'cash_drag_day' && item.date === date,
    );
    if (checkpoint === undefined) continue;
    const checkpointSettings = settingsAt(settingsHistory, date);
    if (checkpointSettings === null) continue;
    const asOf = rigaDayClose(date);
    const calculated = calculateCheckpoint(
      input,
      checkpoint,
      asOf,
      date,
      checkpointSettings,
      `cash-drag:${date}`,
    );
    if (calculated.liquidity.value === null) continue;
    dailyObservations.push(
      createCashDragDailyObservation({
        date,
        liquidCash: calculated.liquidity.value.currentLiquidCash,
        comfortCash: calculated.liquidity.value.comfortCash,
        completeness: calculated.liquidity.status,
      }),
    );
  }
  const cashDrag = calculateCashDrag({
    dailyObservations,
    currentLiquidity: current.liquidity,
    currentSafeToInvest: current.safeToInvest,
    effectiveDate: run.effectiveDate,
    settings: currentSettings.cashDrag,
    ...meta,
  });

  const closedCycles = payCycles
    .filter((item) => item.status === 'closed')
    .slice(-currentSettings.investmentStep.historicalCycleCount);
  const snapshots = [];
  const readiness: CycleInvestmentCapacityReadiness[] = [];
  for (const cycle of closedCycles) {
    const checkpoint = input.historicalCheckpoints.find(
      (item) => item.kind === 'pre_closing' && item.payCycleId === cycle.id,
    );
    if (
      checkpoint === undefined ||
      cycle.endExclusive === null ||
      cycle.closingSalaryTransactionId === null
    )
      continue;
    const closingTrigger = input.canonical.primarySalaryTriggers.find(
      (item) => item.transactionId === cycle.closingSalaryTransactionId,
    );
    if (closingTrigger === undefined) continue;
    const date = addLocalDays(closingTrigger.effectiveDate, -1);
    const asOf = rigaDayClose(date);
    const checkpointSettings = settingsAt(settingsHistory, date);
    if (checkpointSettings === null) continue;
    const calculated = calculateCheckpoint(
      input,
      checkpoint,
      asOf,
      date,
      checkpointSettings,
      `pre-closing:${cycle.id}`,
    );
    const intervening = input.canonical.transactions.some(
      (item) =>
        item.bookingStatus === 'booked' &&
        item.effectiveAt > asOf &&
        item.effectiveAt < cycle.endExclusive!,
    );
    snapshots.push({ cycleId: cycle.id, safeToInvest: calculated.safeToInvest });
    const reasons: CycleCapacityIssue[] = [];
    if (calculated.positions.liquidCash.status !== 'complete') reasons.push('incomplete_balances');
    if (calculated.sinking.status !== 'complete') reasons.push('incomplete_reservations');
    if (calculated.readiness.kind !== 'complete' || intervening)
      reasons.push('missing_cycle_readiness');
    if (
      calculated.liquidity.value !== null &&
      calculated.liquidity.value.currentLiquidCash.amountMinor <
        calculated.liquidity.value.minimumCash.amountMinor
    )
      reasons.push('minimum_liquidity_breach');
    readiness.push(
      reasons.length === 0
        ? { cycleId: cycle.id, kind: 'complete' as const, reasons: [] }
        : { cycleId: cycle.id, kind: 'incomplete' as const, reasons: [...new Set(reasons)] },
    );
  }
  const historicalCapacity = calculateHistoricalInvestmentCapacity({
    payCycles,
    investmentContributions: input.canonical.investmentContributions,
    contributionAttributions: input.canonical.contributionAttributions,
    recurringPlanId: input.recurringPlanId,
    cycleReadiness: readiness,
    preClosingSafeToInvest: snapshots,
    settings: currentSettings.investmentStep,
    ...meta,
  });
  const assembledProjection = assembleForwardLiquidityProjection({
    currentLiquidity: current.liquidity,
    source: input.forwardProjection,
    effectiveDate: run.effectiveDate,
    settings: currentSettings.investmentStep,
    ...meta,
  });
  const investmentDecision =
    assembledProjection.value === null
      ? createMetricResult<InvestmentContributionDecision>({
          ...meta,
          status: 'unavailable',
          value: null,
          explanation: [],
          warnings: assembledProjection.warnings,
        })
      : evaluateInvestmentContributionStep({
          recurringPlanId: input.recurringPlanId,
          historicalCapacity,
          currentLiquidity: current.liquidity,
          currentSafeToInvest: current.safeToInvest,
          cashDrag,
          stressScenario: assembledProjection.value,
          currentContribution: input.currentRecurringContribution,
          lastIssuedStepUpCycleIds: input.lastIssuedStepUpCycleIds,
          settings: currentSettings.investmentStep,
          ...meta,
        });
  const forecast = calculateFinancialForecast({
    startingCash: positions.liquidCash,
    startingInvestment: positions.investmentMarketValue,
    forecastStartMonth: addYearMonths(yearMonthOf(run.effectiveDate), 1),
    capitalFlows: input.forecastPlan.capitalFlows,
    plannedExpenses: input.forecastPlan.plannedExpenses,
    includedOptionalExpenseIds: input.forecastPlan.includedOptionalExpenseIds,
    settings: currentSettings.forecast,
    ...meta,
  });
  const warnings = checkpointWarnings(
    input.historicalCheckpoints,
    dailyDates,
    closedCycles.map((item) => parsePayCycleId(item.id)),
  );
  return Object.freeze({
    run,
    payCycles,
    positions,
    netWorth,
    ccr,
    rollingCcr,
    currentCycleSinkingDue: current.sinking,
    spendingBaseline: current.baseline,
    liquidityReserve: current.liquidity,
    investabilityReadiness: current.readiness,
    safeToInvest: current.safeToInvest,
    cashDrag,
    historicalInvestmentCapacity: historicalCapacity,
    investmentContributionDecision: investmentDecision,
    forecast,
    activeAmbiguities: Object.freeze(
      [...currentVariables.ambiguities].sort((a, b) =>
        a.transactionId.localeCompare(b.transactionId),
      ),
    ),
    warnings,
  });
}
