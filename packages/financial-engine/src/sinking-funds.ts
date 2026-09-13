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
  allocationBeforeCycle: Money;
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
  allocated: Money;
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
  required: Money;
  satisfied: Money;
  outstanding: Money;
  reserved: Money;
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

type ReservationHistoryInput = Readonly<{
  funds: readonly SinkingFund[];
  allocations: readonly SinkingFundAllocation[];
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
    allocations: readonly SinkingFundAllocation[];
    reservationCoverage: MeasurementPeriod;
    period: MeasurementPeriod;
    economicFlows: readonly EconomicFlow[];
  }>;

type CanonicalHistory = Readonly<{
  funds: readonly SinkingFund[];
  allocations: readonly SinkingFundAllocation[];
  coverage: MeasurementPeriod;
  asOf: Instant;
}>;

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

function canonicalHistory(input: ReservationHistoryInput): CanonicalHistory {
  const funds = Object.freeze(input.funds.map((fund) => createSinkingFund(fund)));
  const allocations = Object.freeze(
    input.allocations.map((allocation) => createSinkingFundAllocation(allocation)),
  );
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
    if (fund === undefined || compareInstants(allocation.effectiveAt, fund.createdAt) < 0) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.invalid_allocation_fund',
        'Every allocation must reference an existing fund at or after its creation.',
      );
    }
    if (allocation.amount.currency !== fund.target.currency) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.allocation_currency_mismatch',
        'Sinking Fund allocations must use the fund currency.',
      );
    }
  }

  return Object.freeze({ funds, allocations, coverage, asOf });
}

function hasCompleteHistory(history: CanonicalHistory): boolean {
  const earliestCreation = history.funds
    .filter((fund) => compareInstants(fund.createdAt, history.asOf) <= 0)
    .map((fund) => fund.createdAt)
    .sort(compareInstants)[0];
  return (
    (earliestCreation === undefined ||
      compareInstants(history.coverage.startInclusive, earliestCreation) <= 0) &&
    compareInstants(history.asOf, history.coverage.endExclusive) < 0
  );
}

function allocationBalanceAt(
  fundId: SinkingFundId,
  allocations: readonly SinkingFundAllocation[],
  asOf: Instant,
  inclusive: boolean,
): bigint {
  return allocations.reduce((balance, allocation) => {
    const comparison = compareInstants(allocation.effectiveAt, asOf);
    return allocation.fundId === fundId && (comparison < 0 || (inclusive && comparison === 0))
      ? balance + sinkingFundAllocationDelta(allocation)
      : balance;
  }, 0n);
}

function validateBalances(history: CanonicalHistory): ReadonlyMap<SinkingFundId, bigint> {
  const balances = new Map<SinkingFundId, bigint>();
  const events = [...history.allocations].sort((left, right) => {
    const byInstant = compareInstants(left.effectiveAt, right.effectiveAt);
    return byInstant !== 0 ? byInstant : left.id.localeCompare(right.id);
  });

  for (const event of events) {
    if (compareInstants(event.effectiveAt, history.asOf) > 0) continue;
    const balance = (balances.get(event.fundId) ?? 0n) + sinkingFundAllocationDelta(event);
    if (balance < 0n) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.negative_reserved_balance',
        'Reservation events cannot create a negative Sinking Fund balance.',
      );
    }
    balances.set(event.fundId, balance);
  }

  for (const fund of history.funds) {
    if (
      compareInstants(fund.createdAt, history.asOf) <= 0 &&
      fund.status !== 'active' &&
      (balances.get(fund.id) ?? 0n) !== 0n
    ) {
      throw new FinancialEngineInvariantError(
        'sinking_fund.inactive_with_reserve',
        'Completed or cancelled funds must explicitly release or spend their reserved balance.',
      );
    }
  }
  return balances;
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
  history: CanonicalHistory,
  cycle: PayCycle,
  expectedSchedule: ExpectedPrimaryPaySchedule,
  effectiveDate: LocalDate,
): SinkingFundScheduleItem {
  const allocatedMinor = allocationBalanceAt(fund.id, history.allocations, history.asOf, true);
  const excessMinor =
    allocatedMinor > fund.target.amountMinor ? allocatedMinor - fund.target.amountMinor : 0n;
  const remainingMinor =
    allocatedMinor < fund.target.amountMinor ? fund.target.amountMinor - allocatedMinor : 0n;

  if (!fund.committed || fund.status !== 'active') {
    return Object.freeze({
      fundId: fund.id,
      state: 'inactive',
      target: fund.target,
      allocated: money(allocatedMinor),
      excess: money(excessMinor),
      remaining: money(remainingMinor),
      currentCycleRequirement: null,
      futureContributions: Object.freeze([]),
    });
  }

  const requirementEffectiveAt =
    compareInstants(fund.createdAt, cycle.startInclusive) > 0
      ? fund.createdAt
      : cycle.startInclusive;
  const allocationBeforeMinor = allocationBalanceAt(
    fund.id,
    history.allocations,
    requirementEffectiveAt,
    false,
  );
  const futureDates = expectedSchedule.dates.filter(
    (date) =>
      compareLocalDates(date, effectiveDate) > 0 && compareLocalDates(date, fund.dueDate) <= 0,
  );
  const remainingAtRequirement =
    allocationBeforeMinor < fund.target.amountMinor
      ? fund.target.amountMinor - allocationBeforeMinor
      : 0n;
  const opportunityCount = BigInt(1 + futureDates.length);
  const requiredMinor =
    remainingAtRequirement === 0n
      ? 0n
      : (remainingAtRequirement + opportunityCount - 1n) / opportunityCount;
  const netCreditedMinor = allocatedMinor - allocationBeforeMinor;
  const satisfiedMinor =
    netCreditedMinor <= 0n
      ? 0n
      : netCreditedMinor > requiredMinor
        ? requiredMinor
        : netCreditedMinor;
  const calculatedOutstanding = requiredMinor - netCreditedMinor;
  const outstandingMinor =
    calculatedOutstanding <= 0n
      ? 0n
      : calculatedOutstanding > remainingMinor
        ? remainingMinor
        : calculatedOutstanding;
  const futureRemainingMinor = remainingMinor - outstandingMinor;
  const futureContributions = divideExactly(futureRemainingMinor, futureDates);
  const state =
    excessMinor > 0n
      ? 'overfunded'
      : remainingMinor === 0n
        ? 'fully_funded'
        : compareLocalDates(fund.dueDate, effectiveDate) < 0
          ? 'overdue'
          : 'funding';

  return Object.freeze({
    fundId: fund.id,
    state,
    target: fund.target,
    allocated: money(allocatedMinor),
    excess: money(excessMinor),
    remaining: money(remainingMinor),
    currentCycleRequirement: Object.freeze({
      fundId: fund.id,
      payCycleId: cycle.id,
      effectiveAt: requirementEffectiveAt,
      allocationBeforeCycle: money(allocationBeforeMinor),
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
  const history = canonicalHistory(input);
  const effectiveDate = parseLocalDate(input.effectiveDate);
  const expectedSchedule = createExpectedPrimaryPaySchedule(input.expectedPrimaryPaySchedule);
  const activeFunds = history.funds.filter(
    (fund) => compareInstants(fund.createdAt, history.asOf) <= 0,
  );
  const base = metadata(input, history.asOf);

  if (!hasCompleteHistory(history)) {
    return createMetricResult<SinkingFundSchedule>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_allocation_history')],
    });
  }
  const balances = validateBalances(history);

  const committed = activeFunds.filter((fund) => fund.committed && fund.status === 'active');
  const needingFunding = committed.filter(
    (fund) => (balances.get(fund.id) ?? 0n) < fund.target.amountMinor,
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
        const allocatedMinor = allocationBalanceAt(
          fund.id,
          history.allocations,
          history.asOf,
          true,
        );
        const excessMinor =
          allocatedMinor > fund.target.amountMinor ? allocatedMinor - fund.target.amountMinor : 0n;
        const remainingMinor =
          allocatedMinor < fund.target.amountMinor ? fund.target.amountMinor - allocatedMinor : 0n;
        const state =
          fund.status !== 'active' || !fund.committed
            ? ('inactive' as const)
            : excessMinor > 0n
              ? ('overfunded' as const)
              : ('fully_funded' as const);
        return Object.freeze({
          fundId: fund.id,
          state,
          target: fund.target,
          allocated: money(allocatedMinor),
          excess: money(excessMinor),
          remaining: money(remainingMinor),
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
        required,
        satisfied,
        outstanding,
        reserved: item.allocated,
        excess: item.excess,
        protected: money(item.allocated.amountMinor + outstanding.amountMinor),
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
  const history = canonicalHistory(input);
  const base = metadata(input, history.asOf);
  const liquidCash = createMoney(input.liquidCash.amountMinor, input.liquidCash.currency);
  if (liquidCash.currency !== EUR) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.liquid_currency_mismatch',
      'Stage 2C liquid cash must use EUR.',
    );
  }
  if (!hasCompleteHistory(history)) {
    return createMetricResult<ReservedCash>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_allocation_history')],
    });
  }
  const balances = validateBalances(history);
  const byFund = Object.freeze(
    history.funds
      .filter((fund) => compareInstants(fund.createdAt, history.asOf) <= 0)
      .map((fund) => {
        const reservedMinor = balances.get(fund.id) ?? 0n;
        return Object.freeze({
          fundId: fund.id,
          reserved: money(reservedMinor),
          excess: money(
            reservedMinor > fund.target.amountMinor ? reservedMinor - fund.target.amountMinor : 0n,
          ),
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

function validateFundedConsumptionLinks(
  allocations: readonly SinkingFundAllocation[],
  economicFlows: readonly EconomicFlow[],
): void {
  const flows = economicFlows.map((flow) => createEconomicFlow(flow));
  const byTransaction = new Map(flows.map((flow) => [flow.transactionId, flow]));
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
        'Funded consumption must match booked canonical consumption at the same instant.',
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

export function calculateReservationEffect(
  input: ReservationEffectInput,
): MetricResult<ReservationEffect> {
  const allocations = Object.freeze(
    input.allocations.map((allocation) => createSinkingFundAllocation(allocation)),
  );
  const period = createMeasurementPeriod(input.period);
  const coverage = createMeasurementPeriod(input.reservationCoverage);
  const asOf = parseInstant(input.asOf);
  const base = metadata(input, asOf);
  requireUnique(
    allocations.map((allocation) => allocation.id),
    'sinking_fund.duplicate_allocation_id',
    'Sinking Fund allocation IDs must be unique.',
  );
  if (allocations.some((allocation) => allocation.amount.currency !== EUR)) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.reporting_currency_mismatch',
      'Stage 2C reservation effects must use EUR.',
    );
  }
  validateFundedConsumptionLinks(allocations, input.economicFlows);

  if (compareInstants(period.endExclusive, asOf) > 0) {
    throw new FinancialEngineInvariantError(
      'sinking_fund.period_after_as_of',
      'A reservation measurement period cannot extend beyond as-of.',
    );
  }
  const complete =
    compareInstants(coverage.startInclusive, period.startInclusive) <= 0 &&
    compareInstants(coverage.endExclusive, period.endExclusive) >= 0;
  if (!complete) {
    return createMetricResult<ReservationEffect>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [warning('sinking_fund.missing_reservation_coverage')],
    });
  }

  const changeMinor = allocations.reduce(
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
