import type {
  PayCycleId,
  RecurringInvestmentOccurrenceId,
  RecurringInvestmentPlanId,
  TransactionId,
} from './domain-id.js';
import {
  parsePayCycleId,
  parseRecurringInvestmentOccurrenceId,
  parseRecurringInvestmentPlanId,
  parseTransactionId,
} from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { LocalDate } from './local-date.js';
import { compareLocalDates, parseLocalDate } from './local-date.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import type { Completeness } from './completeness.js';
import { parseCompleteness } from './completeness.js';
import { parseStringEnum } from './validation.js';

export const INVESTMENT_CONTRIBUTION_ATTRIBUTION_KINDS = ['recurring_plan', 'ad_hoc'] as const;
export type InvestmentContributionAttributionKind =
  (typeof INVESTMENT_CONTRIBUTION_ATTRIBUTION_KINDS)[number];

export type InvestmentContributionAttribution =
  | Readonly<{
      transactionId: TransactionId;
      kind: 'recurring_plan';
      planId: RecurringInvestmentPlanId;
    }>
  | Readonly<{
      transactionId: TransactionId;
      kind: 'ad_hoc';
    }>;

export function createInvestmentContributionAttribution(
  value: InvestmentContributionAttribution,
): InvestmentContributionAttribution {
  parseStringEnum(
    value.kind,
    INVESTMENT_CONTRIBUTION_ATTRIBUTION_KINDS,
    'InvestmentContributionAttributionKind',
  );
  const transactionId = parseTransactionId(value.transactionId);
  return value.kind === 'recurring_plan'
    ? Object.freeze({
        transactionId,
        kind: value.kind,
        planId: parseRecurringInvestmentPlanId(value.planId),
      })
    : Object.freeze({ transactionId, kind: value.kind });
}

export const CYCLE_CAPACITY_ISSUES = [
  'unreconciled_source',
  'minimum_liquidity_breach',
  'material_unresolved_transaction',
  'material_cash_variance',
  'incomplete_balances',
  'incomplete_reservations',
  'missing_cycle_readiness',
  'incomplete_pre_closing_safe_to_invest',
] as const;
export type CycleCapacityIssue = (typeof CYCLE_CAPACITY_ISSUES)[number];

export type CycleInvestmentCapacityReadiness =
  | Readonly<{
      cycleId: PayCycleId;
      kind: 'complete';
      reasons: readonly CycleCapacityIssue[];
    }>
  | Readonly<{
      cycleId: PayCycleId;
      kind: 'incomplete';
      reasons: readonly CycleCapacityIssue[];
    }>;

export function createCycleInvestmentCapacityReadiness(
  value: CycleInvestmentCapacityReadiness,
): CycleInvestmentCapacityReadiness {
  const cycleId = parsePayCycleId(value.cycleId);
  if (value.kind === 'complete') {
    if (value.reasons.length !== 0) {
      throw new DomainValidationError(
        'investment_step.complete_cycle_with_reasons',
        'A complete capacity observation cannot contain incomplete reasons.',
      );
    }
    return Object.freeze({ cycleId, kind: value.kind, reasons: Object.freeze([]) });
  }
  if (value.kind !== 'incomplete') {
    throw new DomainValidationError(
      'investment_step.invalid_cycle_readiness',
      'Cycle capacity readiness must be complete or incomplete.',
    );
  }
  const reasons = value.reasons.map((reason) =>
    parseStringEnum(reason, CYCLE_CAPACITY_ISSUES, 'CycleCapacityIssue'),
  );
  if (reasons.length === 0 || new Set(reasons).size !== reasons.length) {
    throw new DomainValidationError(
      'investment_step.invalid_cycle_reasons',
      'Incomplete capacity readiness requires unique reasons.',
    );
  }
  const ordered = CYCLE_CAPACITY_ISSUES.filter((reason) => reasons.includes(reason));
  return Object.freeze({ cycleId, kind: value.kind, reasons: Object.freeze(ordered) });
}

export type RecurringInvestmentOccurrence = Readonly<{
  id: RecurringInvestmentOccurrenceId;
  planId: RecurringInvestmentPlanId;
  date: LocalDate;
}>;

export function createRecurringInvestmentOccurrence(
  value: RecurringInvestmentOccurrence,
): RecurringInvestmentOccurrence {
  return Object.freeze({
    id: parseRecurringInvestmentOccurrenceId(value.id),
    planId: parseRecurringInvestmentPlanId(value.planId),
    date: parseLocalDate(value.date),
  });
}

export type RecurringInvestmentSchedule = Readonly<{
  planId: RecurringInvestmentPlanId;
  occurrences: readonly RecurringInvestmentOccurrence[];
  completeThrough: LocalDate;
}>;

export function createRecurringInvestmentSchedule(
  value: RecurringInvestmentSchedule,
): RecurringInvestmentSchedule {
  const planId = parseRecurringInvestmentPlanId(value.planId);
  const completeThrough = parseLocalDate(value.completeThrough);
  const occurrences = value.occurrences.map((item) => createRecurringInvestmentOccurrence(item));
  if (new Set(occurrences.map((item) => item.id)).size !== occurrences.length) {
    throw new DomainValidationError(
      'investment_step.duplicate_occurrence',
      'Recurring investment occurrence IDs must be unique.',
    );
  }
  if (
    occurrences.some(
      (item) => item.planId !== planId || compareLocalDates(item.date, completeThrough) > 0,
    )
  ) {
    throw new DomainValidationError(
      'investment_step.invalid_occurrence_schedule',
      'Recurring occurrences must match the plan and stay within schedule coverage.',
    );
  }
  return Object.freeze({ planId, occurrences: Object.freeze(occurrences), completeThrough });
}

export type ForwardLiquidityProjectionCoverage = Readonly<{
  expectedPrimarySalary: Completeness;
  normalSpending: Completeness;
  committedObligations: Completeness;
  sinkingProtection: Completeness;
}>;

export function createForwardLiquidityProjectionCoverage(
  value: ForwardLiquidityProjectionCoverage,
): ForwardLiquidityProjectionCoverage {
  return Object.freeze({
    expectedPrimarySalary: parseCompleteness(value.expectedPrimarySalary),
    normalSpending: parseCompleteness(value.normalSpending),
    committedObligations: parseCompleteness(value.committedObligations),
    sinkingProtection: parseCompleteness(value.sinkingProtection),
  });
}

export type ForwardLiquidityProjectionDay = Readonly<{
  date: LocalDate;
  expectedPrimarySalaryInflow: Money;
  normalSpendingOutflow: Money;
  committedObligationOutflow: Money;
  sinkingFundedSpendingOutflow: Money;
  sinkingProtectedCash: Money;
  baseLiquidCashBeforeContribution: Money;
  minimumCash: Money;
  comfortCash: Money;
  completeness: Completeness;
}>;

export function createForwardLiquidityProjectionDay(
  value: ForwardLiquidityProjectionDay,
): ForwardLiquidityProjectionDay {
  const result = {
    date: parseLocalDate(value.date),
    expectedPrimarySalaryInflow: createMoney(
      value.expectedPrimarySalaryInflow.amountMinor,
      value.expectedPrimarySalaryInflow.currency,
    ),
    normalSpendingOutflow: createMoney(
      value.normalSpendingOutflow.amountMinor,
      value.normalSpendingOutflow.currency,
    ),
    committedObligationOutflow: createMoney(
      value.committedObligationOutflow.amountMinor,
      value.committedObligationOutflow.currency,
    ),
    sinkingFundedSpendingOutflow: createMoney(
      value.sinkingFundedSpendingOutflow.amountMinor,
      value.sinkingFundedSpendingOutflow.currency,
    ),
    sinkingProtectedCash: createMoney(
      value.sinkingProtectedCash.amountMinor,
      value.sinkingProtectedCash.currency,
    ),
    baseLiquidCashBeforeContribution: createMoney(
      value.baseLiquidCashBeforeContribution.amountMinor,
      value.baseLiquidCashBeforeContribution.currency,
    ),
    minimumCash: createMoney(value.minimumCash.amountMinor, value.minimumCash.currency),
    comfortCash: createMoney(value.comfortCash.amountMinor, value.comfortCash.currency),
    completeness: parseCompleteness(value.completeness),
  };
  const currencies = [
    result.expectedPrimarySalaryInflow,
    result.normalSpendingOutflow,
    result.committedObligationOutflow,
    result.sinkingFundedSpendingOutflow,
    result.sinkingProtectedCash,
    result.baseLiquidCashBeforeContribution,
    result.minimumCash,
    result.comfortCash,
  ].map((item) => item.currency);
  const nonNegative = [
    result.expectedPrimarySalaryInflow,
    result.normalSpendingOutflow,
    result.committedObligationOutflow,
    result.sinkingFundedSpendingOutflow,
    result.sinkingProtectedCash,
    result.minimumCash,
    result.comfortCash,
  ];
  if (
    new Set(currencies).size !== 1 ||
    nonNegative.some((item) => item.amountMinor < 0n) ||
    result.minimumCash.amountMinor > result.comfortCash.amountMinor
  ) {
    throw new DomainValidationError(
      'investment_step.invalid_projection_day',
      'Forward projection amounts must share currency, use non-negative components, and preserve cash-threshold ordering.',
    );
  }
  return Object.freeze(result);
}
