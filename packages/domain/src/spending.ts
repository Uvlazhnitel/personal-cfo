import type {
  EconomicFlowId,
  FutureObligationId,
  OperationalNeedId,
  RestrictedCashId,
  ScheduledSpendingId,
  SinkingFundId,
  SpendingCategoryId,
} from './domain-id.js';
import {
  parseEconomicFlowId,
  parseFutureObligationId,
  parseOperationalNeedId,
  parseRestrictedCashId,
  parseScheduledSpendingId,
  parseSinkingFundId,
  parseSpendingCategoryId,
} from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { LocalDate } from './local-date.js';
import { parseLocalDate } from './local-date.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import { parseStringEnum } from './validation.js';
import type { YearMonth } from './year-month.js';
import { parseYearMonth } from './year-month.js';

export const SPENDING_NECESSITIES = ['essential', 'discretionary'] as const;
export type SpendingNecessity = (typeof SPENDING_NECESSITIES)[number];
export const SPENDING_CADENCES = ['recurring', 'variable'] as const;
export type SpendingCadence = (typeof SPENDING_CADENCES)[number];

export type SpendingObservation = Readonly<{
  economicFlowId: EconomicFlowId;
  economicDate: LocalDate;
  categoryId: SpendingCategoryId;
  necessity: SpendingNecessity;
  cadence: SpendingCadence;
  irregular: boolean;
}>;

export function createSpendingObservation(value: SpendingObservation): SpendingObservation {
  if (typeof value.irregular !== 'boolean') {
    throw new DomainValidationError(
      'spending.invalid_irregular',
      'Spending irregular must be a boolean.',
    );
  }
  return Object.freeze({
    economicFlowId: parseEconomicFlowId(value.economicFlowId),
    economicDate: parseLocalDate(value.economicDate),
    categoryId: parseSpendingCategoryId(value.categoryId),
    necessity: parseStringEnum(value.necessity, SPENDING_NECESSITIES, 'SpendingNecessity'),
    cadence: parseStringEnum(value.cadence, SPENDING_CADENCES, 'SpendingCadence'),
    irregular: value.irregular,
  });
}

export type CalendarMonthCoverage = Readonly<{
  month: YearMonth;
  reconciled: boolean;
  materialAmbiguityFree: boolean;
  fxComplete: boolean;
  spendingClassificationComplete: boolean;
}>;

export function createCalendarMonthCoverage(value: CalendarMonthCoverage): CalendarMonthCoverage {
  if (
    typeof value.reconciled !== 'boolean' ||
    typeof value.materialAmbiguityFree !== 'boolean' ||
    typeof value.fxComplete !== 'boolean' ||
    typeof value.spendingClassificationComplete !== 'boolean'
  ) {
    throw new DomainValidationError(
      'spending.invalid_month_coverage',
      'Calendar month coverage flags must be booleans.',
    );
  }
  return Object.freeze({ ...value, month: parseYearMonth(value.month) });
}

export type ScheduledSpending = Readonly<{
  id: ScheduledSpendingId;
  dueDate: LocalDate;
  amount: Money;
  necessity: SpendingNecessity;
}>;

export function createScheduledSpending(value: ScheduledSpending): ScheduledSpending {
  const amount = createMoney(value.amount.amountMinor, value.amount.currency);
  if (amount.amountMinor <= 0n) {
    throw new DomainValidationError(
      'spending.invalid_scheduled_amount',
      'Scheduled spending uses a positive amount.',
    );
  }
  return Object.freeze({
    id: parseScheduledSpendingId(value.id),
    dueDate: parseLocalDate(value.dueDate),
    amount,
    necessity: parseStringEnum(value.necessity, SPENDING_NECESSITIES, 'SpendingNecessity'),
  });
}

export const OPERATIONAL_NEED_STATES = ['scheduled', 'pending', 'booked'] as const;
export type OperationalNeedState = (typeof OPERATIONAL_NEED_STATES)[number];
export const OPERATIONAL_NEED_DIRECTIONS = ['debit', 'credit'] as const;
export type OperationalNeedDirection = (typeof OPERATIONAL_NEED_DIRECTIONS)[number];

export type OperationalNeed = Readonly<{
  id: OperationalNeedId;
  dueDate: LocalDate;
  amount: Money;
  necessity: SpendingNecessity;
  direction: OperationalNeedDirection;
  state: OperationalNeedState;
  scheduledSpendingId: ScheduledSpendingId | null;
}>;

export function createOperationalNeed(value: OperationalNeed): OperationalNeed {
  const amount = createMoney(value.amount.amountMinor, value.amount.currency);
  if (amount.amountMinor <= 0n) {
    throw new DomainValidationError(
      'liquidity.invalid_operational_amount',
      'Operational needs use positive magnitudes.',
    );
  }
  return Object.freeze({
    id: parseOperationalNeedId(value.id),
    dueDate: parseLocalDate(value.dueDate),
    amount,
    necessity: parseStringEnum(value.necessity, SPENDING_NECESSITIES, 'SpendingNecessity'),
    direction: parseStringEnum(
      value.direction,
      OPERATIONAL_NEED_DIRECTIONS,
      'OperationalNeedDirection',
    ),
    state: parseStringEnum(value.state, OPERATIONAL_NEED_STATES, 'OperationalNeedState'),
    scheduledSpendingId:
      value.scheduledSpendingId === null
        ? null
        : parseScheduledSpendingId(value.scheduledSpendingId),
  });
}

export type ObligationAmount =
  | Readonly<{ kind: 'exact'; amount: Money }>
  | Readonly<{ kind: 'range'; lower: Money; upper: Money }>;
export type ObligationCoverage =
  | Readonly<{ kind: 'uncovered' }>
  | Readonly<{ kind: 'sinking_fund'; fundId: SinkingFundId }>
  | Readonly<{ kind: 'operational'; operationalNeedId: OperationalNeedId }>;

export const OBLIGATION_PRIORITIES = ['mandatory', 'optional'] as const;
export type ObligationPriority = (typeof OBLIGATION_PRIORITIES)[number];
export const OBLIGATION_STATUSES = ['open', 'satisfied', 'cancelled'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export type FutureObligation = Readonly<{
  id: FutureObligationId;
  dueDate: LocalDate;
  amount: ObligationAmount;
  priority: ObligationPriority;
  committed: boolean;
  status: ObligationStatus;
  coverage: ObligationCoverage;
}>;

function createObligationAmount(value: ObligationAmount): ObligationAmount {
  if (value.kind === 'exact') {
    const amount = createMoney(value.amount.amountMinor, value.amount.currency);
    if (amount.amountMinor <= 0n) {
      throw new DomainValidationError(
        'obligation.invalid_amount',
        'An obligation amount must be positive.',
      );
    }
    return Object.freeze({ kind: value.kind, amount });
  }
  const lower = createMoney(value.lower.amountMinor, value.lower.currency);
  const upper = createMoney(value.upper.amountMinor, value.upper.currency);
  if (
    lower.currency !== upper.currency ||
    lower.amountMinor <= 0n ||
    lower.amountMinor > upper.amountMinor
  ) {
    throw new DomainValidationError(
      'obligation.invalid_range',
      'An obligation range must be positive, same-currency, and ordered.',
    );
  }
  return Object.freeze({ kind: value.kind, lower, upper });
}

function createObligationCoverage(value: ObligationCoverage): ObligationCoverage {
  if (value.kind === 'uncovered') return Object.freeze({ kind: value.kind });
  if (value.kind === 'sinking_fund') {
    return Object.freeze({ kind: value.kind, fundId: parseSinkingFundId(value.fundId) });
  }
  return Object.freeze({
    kind: value.kind,
    operationalNeedId: parseOperationalNeedId(value.operationalNeedId),
  });
}

export function createFutureObligation(value: FutureObligation): FutureObligation {
  if (typeof value.committed !== 'boolean') {
    throw new DomainValidationError(
      'obligation.invalid_commitment',
      'Obligation committed must be a boolean.',
    );
  }
  return Object.freeze({
    id: parseFutureObligationId(value.id),
    dueDate: parseLocalDate(value.dueDate),
    amount: createObligationAmount(value.amount),
    priority: parseStringEnum(value.priority, OBLIGATION_PRIORITIES, 'ObligationPriority'),
    committed: value.committed,
    status: parseStringEnum(value.status, OBLIGATION_STATUSES, 'ObligationStatus'),
    coverage: createObligationCoverage(value.coverage),
  });
}

export type RestrictedCash = Readonly<{ id: RestrictedCashId; amount: Money }>;

export function createRestrictedCash(value: RestrictedCash): RestrictedCash {
  const amount = createMoney(value.amount.amountMinor, value.amount.currency);
  if (amount.amountMinor < 0n) {
    throw new DomainValidationError(
      'liquidity.negative_restricted_cash',
      'Restricted cash cannot be negative.',
    );
  }
  return Object.freeze({ id: parseRestrictedCashId(value.id), amount });
}
