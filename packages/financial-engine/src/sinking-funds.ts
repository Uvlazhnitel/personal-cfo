import {
  EUR,
  compareInstants,
  compareLocalDates,
  createEconomicFlow,
  createExpectedPrimaryPaySchedule,
  createMeasurementPeriod,
  createMetricResult,
  createMoney,
  createPayCycle,
  createSinkingFund,
  createSinkingFundAllocation,
  parseInstant,
  parseLocalDate,
  periodContains,
  sinkingFundAllocationDelta,
  sinkingFundFulfillmentDelta,
  sinkingFundFundedConsumptionDelta,
} from '@personal-cfo/domain';
import type {
  DataWarning,
  EconomicFlow,
  ExpectedPrimaryPaySchedule,
  Instant,
  LocalDate,
  MeasurementPeriod,
  MetricResult,
  Money,
  PayCycle,
  SinkingFund,
  SinkingFundAllocation,
  SinkingFundId,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';

type MetricMetadata = Readonly<{
  asOf: Instant;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
}>;

export type SinkingFundRequirement = Readonly<{
  fundId: SinkingFundId;
  payCycleId: PayCycle['id'];
  effectiveAt: Instant;
  reservedBeforeRequirement: Money;
  fundedConsumptionBeforeRequirement: Money;
  fulfilledBeforeRequirement: Money;
  remainingFundingOpportunities: number;
  requiredAmount: Money;
  satisfiedAmount: Money;
  outstandingAmount: Money;
}>;

export type ScheduledSinkingFundContribution = Readonly<{
  fundingDate: LocalDate;
  amount: Money;
}>;

export type SinkingFundScheduleItem = Readonly<{
  fundId: SinkingFundId;
  state: 'inactive' | 'funding' | 'fully_funded' | 'overfunded' | 'overdue';
  target: Money;
  reserved: Money;
  fundedConsumption: Money;
  fulfilled: Money;
  excess: Money;
  remaining: Money;
  currentCycleRequirement: SinkingFundRequirement | null;
  futureContributions: readonly ScheduledSinkingFundContribution[];
}>;

export type SinkingFundSchedule = Readonly<{
  funds: readonly SinkingFundScheduleItem[];
  totalOutstandingCurrentCycle: Money;
}>;

export type CurrentCycleSinkingDueByFund = Readonly<{
  fundId: SinkingFundId;
  state: SinkingFundScheduleItem['state'];
  required: Money;
  satisfied: Money;
  outstanding: Money;
  reserved: Money;
  fundedConsumption: Money;
  fulfilled: Money;
  remaining: Money;
  excess: Money;
  protected: Money;
}>;

export type CurrentCycleSinkingDue = Readonly<{
  byFund: readonly CurrentCycleSinkingDueByFund[];
  totalRequired: Money;
  totalSatisfied: Money;
  totalOutstanding: Money;
  totalReserved: Money;
  totalProtected: Money;
}>;

export type ReservedCashByFund = Readonly<{
  fundId: SinkingFundId;
  reserved: Money;
  fundedConsumption: Money;
  fulfilled: Money;
  remaining: Money;
  excess: Money;
}>;

export type ReservedCash = Readonly<{
  byFund: readonly ReservedCashByFund[];
  totalReserved: Money;
  freeLiquidCash: Money;
  totalOwnedLiquidCash: Money;
}>;

export type ReservationEffect = Readonly<{
  change: Money;
}>;

export type FundedConsumptionCoverage = Readonly<{
  byTransaction: readonly Readonly<{
    transactionId: EconomicFlow['transactionId'];
    amount: Money;
  }>[];
  total: Money;
}>;

type ReservationHistoryInput = Readonly<{
  funds: readonly SinkingFund[];
  allocations: readonly SinkingFundAllocation[];
  economicFlows: readonly EconomicFlow[];
  reservationCoverage: MeasurementPeriod;
  asOf: Instant;
}>;

export type SinkingFundScheduleInput = ReservationHistoryInput &
  MetricMetadata &
  Readonly<{
    payCycles: readonly PayCycle[];
    expectedPrimaryPaySchedule: ExpectedPrimaryPaySchedule;
    effectiveDate: LocalDate;
  }>;

export type ReservedCashInput = ReservationHistoryInput &
  MetricMetadata &
  Readonly<{ liquidCash: Money }>;

export type ReservationEffectInput = MetricMetadata &
  Readonly<{
    funds: readonly SinkingFund[];
    allocations: readonly SinkingFundAllocation[];
    reservationCoverage: MeasurementPeriod;
    period: MeasurementPeriod;
    economicFlows: readonly EconomicFlow[];
  }>;

export type FundedConsumptionCoverageInput = ReservationHistoryInput & MetricMetadata;

type ReservationProgressMinor = Readonly<{
  reserved: bigint;
  fundedConsumption: bigint;
  fulfilled: bigint;
  remaining: bigint;
  excess: bigint;
}>;

type ValidatedReservationHistory = Readonly<{
  funds: readonly SinkingFund[];
  allocations: readonly SinkingFundAllocation[];
  economicFlows: readonly EconomicFlow[];
  coverage: MeasurementPeriod;
  asOf: Instant;
}>;

type ReservationHistoryValidation =
  | Readonly<{ status: 'complete'; history: ValidatedReservationHistory }>
  | Readonly<{ status: 'unavailable'; asOf: Instant }>;

function warning(code: string, context: Readonly<Record<string, string>> = {}): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ ...context }) });
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function metadata(input: MetricMetadata, asOf: Instant) {
  return {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
}

function requireUnique(values: readonly string[], code: string, message: string): void {
  if (new Set(values).size !== values.length) {
    throw new FinancialEngineInvariantError(code, message);
  }
}

function validateFundedConsumptionLinks(
  allocations: readonly SinkingFundAllocation[],
  economicFlows: readonly EconomicFlow[],
): void {
  requireUnique(
    economicFlows.map((flow) => flow.id),
    'sinking_fund.duplicate_economic_flow_id',
    'Economic flow IDs must be unique in reservation history.',
  );
  requireUnique(
    economicFlows.map((flow) => flow.transactionId),
    'sinking_fund.duplicate_economic_flow_transaction',
    'A transaction can have only one economic flow in reservation history.',
  );
  const byTransaction = new Map(economicFlows.map((flow) => [flow.transactionId, flow]));
  const covered = new Map<string, bigint>();

  for (const allocation of allocations) {
    if (allocation.kind !== 'funded_consumption') continue;
    const flow = byTransaction.get(allocation.relatedTransactionId);
    if (
      flow?.kind !== 'consumption' ||
      flow.effectiveAt !== allocation.effectiveAt ||
      flow.amount.currency !== allocation.amount.currency
    ) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.invalid_funded_consumption',
        'Funded consumption must match canonical consumption at the same instant.',
      );
    }
    const total = (covered.get(flow.transactionId) ?? 0n) + allocation.amount.amountMinor;
    if (total > flow.amount.amountMinor) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.coverage_exceeds_consumption',
        'Sinking Fund coverage cannot exceed linked consumption.',
      );
    }
    covered.set(flow.transactionId, total);
  }
}

function historyHasCompleteCoverage(
  funds: readonly SinkingFund[],
  coverage: MeasurementPeriod,
  asOf: Instant,
): boolean {
  const earliestCreation = funds
    .filter((fund) => compareInstants(fund.createdAt, asOf) <= 0)
    .map((fund) => fund.createdAt)
    .sort(compareInstants)[0];
  return (
    (earliestCreation === undefined ||
      compareInstants(coverage.startInclusive, earliestCreation) <= 0) &&
    compareInstants(asOf, coverage.endExclusive) < 0
  );
}

function validateReservationHistory(input: ReservationHistoryInput): ReservationHistoryValidation {
  const funds = Object.freeze(input.funds.map((fund) => createSinkingFund(fund)));
  const allocations = Object.freeze(
    input.allocations.map((allocation) => createSinkingFundAllocation(allocation)),
  );
  const economicFlows = Object.freeze(input.economicFlows.map((flow) => createEconomicFlow(flow)));
  const coverage = createMeasurementPeriod(input.reservationCoverage);
  const asOf = parseInstant(input.asOf);
  const fundsById = new Map(funds.map((fund) => [fund.id, fund]));

  requireUnique(
    funds.map((fund) => fund.id),
    'sinking_fund.duplicate_fund_id',
    'Sinking Fund IDs must be unique.',
  );
  requireUnique(
    allocations.map((allocation) => allocation.id),
    'sinking_fund.duplicate_allocation_id',
    'Sinking Fund allocation IDs must be unique.',
  );

  for (const fund of funds) {
    if (fund.target.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.reporting_currency_mismatch',
        'Stage 2C Sinking Funds must use EUR.',
      );
    }
  }
  for (const allocation of allocations) {
    const fund = fundsById.get(allocation.fundId);
    if (fund === undefined) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.unknown_allocation_fund',
        'Every reservation event must reference an existing Sinking Fund.',
      );
    }
    if (compareInstants(allocation.effectiveAt, fund.createdAt) < 0) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.event_before_fund_creation',
        'A reservation event cannot precede its Sinking Fund creation.',
      );
    }
    if (allocation.amount.currency !== fund.target.currency) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.allocation_currency_mismatch',
        'Sinking Fund allocations must use the fund currency.',
      );
    }
  }
  validateFundedConsumptionLinks(allocations, economicFlows);

  const balances = new Map<SinkingFundId, bigint>();
  if (!historyHasCompleteCoverage(funds, coverage, asOf)) {
    return Object.freeze({ status: 'unavailable', asOf });
  }

  const events = [...allocations].sort((left, right) => {
    const byInstant = compareInstants(left.effectiveAt, right.effectiveAt);
    return byInstant !== 0 ? byInstant : left.id.localeCompare(right.id);
  });

  for (const event of events) {
    if (compareInstants(event.effectiveAt, asOf) > 0) continue;
    const balance = (balances.get(event.fundId) ?? 0n) + sinkingFundAllocationDelta(event);
    if (balance < 0n) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.negative_reserved_balance',
        'Reservation events cannot create a negative Sinking Fund balance.',
      );
    }
    balances.set(event.fundId, balance);
  }

  for (const fund of funds) {
    if (
      compareInstants(fund.createdAt, asOf) <= 0 &&
      fund.status !== 'active' &&
      (balances.get(fund.id) ?? 0n) !== 0n
    ) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.inactive_with_reserve',
        'Completed or cancelled funds must explicitly release or spend their reserved balance.',
      );
    }
  }

  return Object.freeze({
    status: 'complete',
    history: Object.freeze({ funds, allocations, economicFlows, coverage, asOf }),
  });
}

function reservationProgressAt(
  history: ValidatedReservationHistory,
  fund: SinkingFund,
  instant: Instant,
  inclusive: boolean,
): ReservationProgressMinor {
  let reserved = 0n;
  let fundedConsumption = 0n;
  let fulfilled = 0n;

  for (const event of history.allocations) {
    const comparison = compareInstants(event.effectiveAt, instant);
    if (event.fundId !== fund.id || comparison > 0 || (!inclusive && comparison === 0)) continue;
    reserved += sinkingFundAllocationDelta(event);
    fundedConsumption += sinkingFundFundedConsumptionDelta(event);
    fulfilled += sinkingFundFulfillmentDelta(event);
  }

  const remaining = fulfilled < fund.target.amountMinor ? fund.target.amountMinor - fulfilled : 0n;
  const excess = fulfilled > fund.target.amountMinor ? fulfilled - fund.target.amountMinor : 0n;
  return Object.freeze({ reserved, fundedConsumption, fulfilled, remaining, excess });
}

function currentPayCycle(payCycles: readonly PayCycle[], asOf: Instant): PayCycle | undefined {
  const cycles = payCycles.map((cycle) => createPayCycle(cycle));
  requireUnique(
    cycles.map((cycle) => cycle.id),
    'pay_cycle.duplicate_cycle_id',
    'Pay Cycle IDs must be unique.',
  );
  const ordered = [...cycles].sort((left, right) =>
    compareInstants(left.startInclusive, right.startInclusive),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1]!;
    const current = ordered[index]!;
    if (
      previous.endExclusive === null ||
      previous.endExclusive !== current.startInclusive ||
      previous.closingSalaryTransactionId !== current.openingSalaryTransactionId
    ) {
      throw new FinancialEngineInvariantError(
        'pay_cycle.inconsistent_sequence',
        'Each closed Pay Cycle must end at the next cycle opening salary.',
      );
    }
  }
  return ordered.find(
    (cycle) =>
      compareInstants(cycle.startInclusive, asOf) <= 0 &&
      (cycle.endExclusive === null || compareInstants(asOf, cycle.endExclusive) < 0),
  );
}

function divideExactly(
  totalMinor: bigint,
  dates: readonly LocalDate[],
): readonly ScheduledSinkingFundContribution[] {
  if (dates.length === 0 || totalMinor === 0n) return Object.freeze([]);
  const count = BigInt(dates.length);
  const quotient = totalMinor / count;
  const remainder = totalMinor % count;
  return Object.freeze(
    dates
      .map((fundingDate, index) =>
        Object.freeze({
          fundingDate,
          amount: money(quotient + (BigInt(index) < remainder ? 1n : 0n)),
        }),
      )
      .filter((part) => part.amount.amountMinor > 0n),
  );
}

function scheduleItem(
  fund: SinkingFund,
  history: ValidatedReservationHistory,
  cycle: PayCycle,
  expectedSchedule: ExpectedPrimaryPaySchedule,
  effectiveDate: LocalDate,
): SinkingFundScheduleItem {
  const current = reservationProgressAt(history, fund, history.asOf, true);

  if (!fund.committed || fund.status !== 'active') {
    return Object.freeze({
      fundId: fund.id,
      state: 'inactive',
      target: fund.target,
      reserved: money(current.reserved),
      fundedConsumption: money(current.fundedConsumption),
      fulfilled: money(current.fulfilled),
      excess: money(current.excess),
      remaining: money(current.remaining),
      currentCycleRequirement: null,
      futureContributions: Object.freeze([]),
    });
  }

  const requirementEffectiveAt =
    compareInstants(fund.createdAt, cycle.startInclusive) > 0
      ? fund.createdAt
      : cycle.startInclusive;
  const beforeRequirement = reservationProgressAt(history, fund, requirementEffectiveAt, false);
  const futureDates = expectedSchedule.dates.filter(
    (date) =>
      compareLocalDates(date, effectiveDate) > 0 && compareLocalDates(date, fund.dueDate) <= 0,
  );
  const opportunityCount = BigInt(1 + futureDates.length);
  const requiredMinor =
    beforeRequirement.remaining === 0n
      ? 0n
      : (beforeRequirement.remaining + opportunityCount - 1n) / opportunityCount;
  const netFulfillmentProgress = current.fulfilled - beforeRequirement.fulfilled;
  const satisfiedMinor =
    netFulfillmentProgress <= 0n
      ? 0n
      : netFulfillmentProgress > requiredMinor
        ? requiredMinor
        : netFulfillmentProgress;
  const calculatedOutstanding = requiredMinor - netFulfillmentProgress;
  const outstandingMinor =
    calculatedOutstanding <= 0n
      ? 0n
      : calculatedOutstanding > current.remaining
        ? current.remaining
        : calculatedOutstanding;
  const futureRemainingMinor = current.remaining - outstandingMinor;
  const futureContributions = divideExactly(futureRemainingMinor, futureDates);
  const state =
    current.excess > 0n
      ? 'overfunded'
      : current.remaining === 0n
        ? 'fully_funded'
        : compareLocalDates(fund.dueDate, effectiveDate) < 0
          ? 'overdue'
          : 'funding';

  return Object.freeze({
    fundId: fund.id,
    state,
    target: fund.target,
    reserved: money(current.reserved),
    fundedConsumption: money(current.fundedConsumption),
    fulfilled: money(current.fulfilled),
    excess: money(current.excess),
    remaining: money(current.remaining),
    currentCycleRequirement: Object.freeze({
      fundId: fund.id,
      payCycleId: cycle.id,
      effectiveAt: requirementEffectiveAt,
      reservedBeforeRequirement: money(beforeRequirement.reserved),
      fundedConsumptionBeforeRequirement: money(beforeRequirement.fundedConsumption),
      fulfilledBeforeRequirement: money(beforeRequirement.fulfilled),
      remainingFundingOpportunities: futureDates.length,
      requiredAmount: money(requiredMinor),
      satisfiedAmount: money(satisfiedMinor),
      outstandingAmount: money(outstandingMinor),
    }),
    futureContributions,
  });
}

export function calculateSinkingFundSchedule(
  input: SinkingFundScheduleInput,
): MetricResult<SinkingFundSchedule> {
  const validation = validateReservationHistory(input);
  const asOf = validation.status === 'complete' ? validation.history.asOf : validation.asOf;
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const expectedSchedule = createExpectedPrimaryPaySchedule(input.expectedPrimaryPaySchedule);
  const base = metadata(input, asOf);

  if (validation.status === 'unavailable') {
    return createMetricResult<SinkingFundSchedule>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_allocation_history')],
    });
  }

  const history = validation.history;
  const activeFunds = history.funds.filter(
    (fund) => compareInstants(fund.createdAt, history.asOf) <= 0,
  );

  const committed = activeFunds.filter((fund) => fund.committed && fund.status === 'active');
  const needingFunding = committed.filter(
    (fund) => reservationProgressAt(history, fund, history.asOf, true).remaining > 0n,
  );
  if (
    needingFunding.some(
      (fund) => compareLocalDates(expectedSchedule.completeThrough, fund.dueDate) < 0,
    )
  ) {
    return createMetricResult<SinkingFundSchedule>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_expected_pay_schedule')],
    });
  }

  const cycle = currentPayCycle(input.payCycles, history.asOf);
  if (cycle === undefined && needingFunding.length > 0) {
    return createMetricResult<SinkingFundSchedule>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_primary_pay_cycle')],
    });
  }
  if (cycle !== undefined && compareLocalDates(effectiveDate, cycle.startDate) < 0) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.effective_date_before_cycle',
      'The supplied Europe/Riga effective date cannot precede the active Pay Cycle start date.',
    );
  }

  const items = Object.freeze(
    activeFunds
      .sort((left, right) => {
        const byDueDate = compareLocalDates(left.dueDate, right.dueDate);
        if (byDueDate !== 0) return byDueDate;
        if (left.priority !== right.priority) return left.priority - right.priority;
        return left.id.localeCompare(right.id);
      })
      .map((fund) => {
        if (cycle !== undefined) {
          return scheduleItem(fund, history, cycle, expectedSchedule, effectiveDate);
        }
        const current = reservationProgressAt(history, fund, history.asOf, true);
        const state =
          fund.status !== 'active' || !fund.committed
            ? ('inactive' as const)
            : current.excess > 0n
              ? ('overfunded' as const)
              : ('fully_funded' as const);
        return Object.freeze({
          fundId: fund.id,
          state,
          target: fund.target,
          reserved: money(current.reserved),
          fundedConsumption: money(current.fundedConsumption),
          fulfilled: money(current.fulfilled),
          excess: money(current.excess),
          remaining: money(current.remaining),
          currentCycleRequirement: null,
          futureContributions: Object.freeze([]),
        });
      }),
  );
  const totalOutstanding = items.reduce(
    (sum, item) => sum + (item.currentCycleRequirement?.outstandingAmount.amountMinor ?? 0n),
    0n,
  );
  const value = Object.freeze({
    funds: items,
    totalOutstandingCurrentCycle: money(totalOutstanding),
  });

  return createMetricResult({
    ...base,
    status: 'complete',
    value,
    explanation: [
      {
        ruleId: 'sinking-fund.current-cycle-outstanding',
        inputKey: 'totalOutstandingCurrentCycle',
        value: totalOutstanding.toString(),
      },
    ],
    warnings: [],
  });
}

export function calculateCurrentCycleSinkingDue(
  input: SinkingFundScheduleInput,
): MetricResult<CurrentCycleSinkingDue> {
  const schedule = calculateSinkingFundSchedule(input);
  if (schedule.value === null) {
    return createMetricResult<CurrentCycleSinkingDue>({
      status: 'unavailable',
      value: null,
      asOf: schedule.asOf,
      engineVersion: schedule.engineVersion,
      settingsVersion: schedule.settingsVersion,
      inputWatermark: schedule.inputWatermark,
      explanation: schedule.explanation,
      warnings: schedule.warnings,
    });
  }

  const byFund = Object.freeze(
    schedule.value.funds.map((item) => {
      const required = item.currentCycleRequirement?.requiredAmount ?? money(0n);
      const satisfied = item.currentCycleRequirement?.satisfiedAmount ?? money(0n);
      const outstanding = item.currentCycleRequirement?.outstandingAmount ?? money(0n);
      return Object.freeze({
        fundId: item.fundId,
        state: item.state,
        required,
        satisfied,
        outstanding,
        reserved: item.reserved,
        fundedConsumption: item.fundedConsumption,
        fulfilled: item.fulfilled,
        remaining: item.remaining,
        excess: item.excess,
        protected: money(item.reserved.amountMinor + outstanding.amountMinor),
      });
    }),
  );
  const total = (key: 'required' | 'satisfied' | 'outstanding' | 'reserved' | 'protected') =>
    money(byFund.reduce((sum, item) => sum + item[key].amountMinor, 0n));
  const value = Object.freeze({
    byFund,
    totalRequired: total('required'),
    totalSatisfied: total('satisfied'),
    totalOutstanding: total('outstanding'),
    totalReserved: total('reserved'),
    totalProtected: total('protected'),
  });

  return createMetricResult({
    status: 'complete',
    value,
    asOf: schedule.asOf,
    engineVersion: schedule.engineVersion,
    settingsVersion: schedule.settingsVersion,
    inputWatermark: schedule.inputWatermark,
    explanation: [
      {
        ruleId: 'sinking-fund.protected-cash',
        inputKey: 'totalProtected',
        value: value.totalProtected.amountMinor.toString(),
      },
    ],
    warnings: schedule.warnings,
  });
}

export function calculateReservedCash(input: ReservedCashInput): MetricResult<ReservedCash> {
  const validation = validateReservationHistory(input);
  const asOf = validation.status === 'complete' ? validation.history.asOf : validation.asOf;
  const base = metadata(input, asOf);
  const liquidCash = createMoney(input.liquidCash.amountMinor, input.liquidCash.currency);
  if (liquidCash.currency !== EUR) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.liquid_currency_mismatch',
      'Stage 2C liquid cash must use EUR.',
    );
  }
  if (validation.status === 'unavailable') {
    return createMetricResult<ReservedCash>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_allocation_history')],
    });
  }
  const history = validation.history;
  const byFund = Object.freeze(
    history.funds
      .filter((fund) => compareInstants(fund.createdAt, history.asOf) <= 0)
      .map((fund) => {
        const current = reservationProgressAt(history, fund, history.asOf, true);
        return Object.freeze({
          fundId: fund.id,
          reserved: money(current.reserved),
          fundedConsumption: money(current.fundedConsumption),
          fulfilled: money(current.fulfilled),
          remaining: money(current.remaining),
          excess: money(current.excess),
        });
      }),
  );
  const totalReservedMinor = byFund.reduce((sum, item) => sum + item.reserved.amountMinor, 0n);
  if (totalReservedMinor > liquidCash.amountMinor) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.allocations_exceed_liquid_cash',
      'Reserved Sinking Fund cash cannot exceed owned liquid cash.',
    );
  }
  const value = Object.freeze({
    byFund,
    totalReserved: money(totalReservedMinor),
    freeLiquidCash: money(liquidCash.amountMinor - totalReservedMinor),
    totalOwnedLiquidCash: liquidCash,
  });

  return createMetricResult({
    ...base,
    status: 'complete',
    value,
    explanation: [
      {
        ruleId: 'sinking-fund.reserved-cash',
        inputKey: 'totalReserved',
        value: totalReservedMinor.toString(),
      },
    ],
    warnings: [],
  });
}

export function calculateReservationEffect(
  input: ReservationEffectInput,
): MetricResult<ReservationEffect> {
  const validation = validateReservationHistory(input);
  const period = createMeasurementPeriod(input.period);
  const asOf = validation.status === 'complete' ? validation.history.asOf : validation.asOf;
  const base = metadata(input, asOf);

  if (compareInstants(period.endExclusive, asOf) > 0) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.period_after_as_of',
      'A reservation measurement period cannot extend beyond as-of.',
    );
  }
  if (
    validation.status === 'unavailable' ||
    compareInstants(validation.history.coverage.startInclusive, period.startInclusive) > 0 ||
    compareInstants(validation.history.coverage.endExclusive, period.endExclusive) < 0
  ) {
    return createMetricResult<ReservationEffect>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_reservation_coverage')],
    });
  }

  const changeMinor = validation.history.allocations.reduce(
    (sum, allocation) =>
      periodContains(period, allocation.effectiveAt)
        ? sum + sinkingFundAllocationDelta(allocation)
        : sum,
    0n,
  );
  const value = Object.freeze({ change: money(changeMinor) });
  return createMetricResult({
    ...base,
    status: 'complete',
    value,
    explanation: [
      {
        ruleId: 'sinking-fund.reservation-change',
        inputKey: 'change',
        value: changeMinor.toString(),
      },
    ],
    warnings: [],
  });
}

export function calculateFundedConsumptionCoverage(
  input: FundedConsumptionCoverageInput,
): MetricResult<FundedConsumptionCoverage> {
  const validation = validateReservationHistory(input);
  const asOf = validation.status === 'complete' ? validation.history.asOf : validation.asOf;
  const base = metadata(input, asOf);
  if (validation.status === 'unavailable') {
    return createMetricResult<FundedConsumptionCoverage>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_allocation_history')],
    });
  }

  const totals = new Map<EconomicFlow['transactionId'], bigint>();
  for (const event of validation.history.allocations) {
    if (event.kind !== 'funded_consumption' || compareInstants(event.effectiveAt, asOf) > 0)
      continue;
    totals.set(
      event.relatedTransactionId,
      (totals.get(event.relatedTransactionId) ?? 0n) + event.amount.amountMinor,
    );
  }
  const byTransaction = Object.freeze(
    [...totals.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([transactionId, amountMinor]) =>
        Object.freeze({ transactionId, amount: money(amountMinor) }),
      ),
  );
  const total = money(byTransaction.reduce((sum, item) => sum + item.amount.amountMinor, 0n));
  return createMetricResult({
    ...base,
    status: 'complete',
    value: Object.freeze({ byTransaction, total }),
    explanation: [
      {
        ruleId: 'sinking-fund.funded-consumption-coverage',
        inputKey: 'total',
        value: total.amountMinor.toString(),
      },
    ],
    warnings: [],
  });
}
