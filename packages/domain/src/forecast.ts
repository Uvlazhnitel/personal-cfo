import type { DecimalRate } from './decimal-rate.js';
import { parseDecimalRate } from './decimal-rate.js';
import { parseCurrencyCode } from './currency.js';
import type { ForecastCapitalFlowId, ForecastPlannedExpenseId } from './domain-id.js';
import { parseForecastCapitalFlowId, parseForecastPlannedExpenseId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import type { YearMonth } from './year-month.js';
import { parseYearMonth } from './year-month.js';
import { parseStringEnum } from './validation.js';

export type ForecastCapitalFlow = Readonly<{
  id: ForecastCapitalFlowId;
  month: YearMonth;
  cashChange: Money;
  investmentChange: Money;
}>;

export function createForecastCapitalFlow(value: ForecastCapitalFlow): ForecastCapitalFlow {
  const cashChange = createMoney(value.cashChange.amountMinor, value.cashChange.currency);
  const investmentChange = createMoney(
    value.investmentChange.amountMinor,
    value.investmentChange.currency,
  );
  if (cashChange.currency !== investmentChange.currency) {
    throw new DomainValidationError(
      'forecast.capital_flow_currency',
      'Forecast cash and investment changes must use one currency.',
    );
  }
  return Object.freeze({
    id: parseForecastCapitalFlowId(value.id),
    month: parseYearMonth(value.month),
    cashChange,
    investmentChange,
  });
}

export type ForecastExpenseAmount =
  | Readonly<{ kind: 'exact'; amount: Money }>
  | Readonly<{ kind: 'range'; lower: Money; upper: Money }>
  | Readonly<{ kind: 'unknown'; currency: Money['currency'] }>;

export type ForecastPlannedExpense = Readonly<{
  id: ForecastPlannedExpenseId;
  dueMonth: YearMonth;
  amount: ForecastExpenseAmount;
  priority: 'mandatory' | 'optional';
  committed: boolean;
}>;

export function createForecastPlannedExpense(
  value: ForecastPlannedExpense,
): ForecastPlannedExpense {
  const priority = parseStringEnum(
    value.priority,
    ['mandatory', 'optional'] as const,
    'ForecastExpensePriority',
  );
  if (typeof value.committed !== 'boolean') {
    throw new DomainValidationError(
      'forecast.invalid_expense_commitment',
      'Forecast expense commitment must be boolean.',
    );
  }
  let amount: ForecastExpenseAmount;
  if (value.amount.kind === 'exact') {
    amount = Object.freeze({
      kind: value.amount.kind,
      amount: createMoney(value.amount.amount.amountMinor, value.amount.amount.currency),
    });
  } else if (value.amount.kind === 'range') {
    const lower = createMoney(value.amount.lower.amountMinor, value.amount.lower.currency);
    const upper = createMoney(value.amount.upper.amountMinor, value.amount.upper.currency);
    if (
      lower.currency !== upper.currency ||
      lower.amountMinor < 0n ||
      upper.amountMinor < lower.amountMinor
    ) {
      throw new DomainValidationError(
        'forecast.invalid_expense_range',
        'Forecast expense ranges must be non-negative, ordered, and use one currency.',
      );
    }
    amount = Object.freeze({ kind: value.amount.kind, lower, upper });
  } else if (value.amount.kind === 'unknown') {
    amount = Object.freeze({
      kind: value.amount.kind,
      currency: parseCurrencyCode(value.amount.currency),
    });
  } else {
    throw new DomainValidationError(
      'forecast.invalid_expense_amount',
      'Forecast expense amount kind is invalid.',
    );
  }
  if (amount.kind === 'exact' && amount.amount.amountMinor < 0n) {
    throw new DomainValidationError(
      'forecast.negative_expense',
      'Forecast expenses must be non-negative.',
    );
  }
  return Object.freeze({
    id: parseForecastPlannedExpenseId(value.id),
    dueMonth: parseYearMonth(value.dueMonth),
    amount,
    priority,
    committed: value.committed,
  });
}

export type ForecastScenarioAssumption = Readonly<{
  annualReturnRate: DecimalRate;
  kind: 'contributions_only' | 'modeled';
  defaultModeled: boolean;
}>;

export function createForecastScenarioAssumption(
  value: ForecastScenarioAssumption,
): ForecastScenarioAssumption {
  const annualReturnRate = parseDecimalRate(value.annualReturnRate);
  const kind = parseStringEnum(
    value.kind,
    ['contributions_only', 'modeled'] as const,
    'ForecastScenarioKind',
  );
  if (typeof value.defaultModeled !== 'boolean') {
    throw new DomainValidationError(
      'forecast.invalid_default_flag',
      'Forecast default-modeled flag must be boolean.',
    );
  }
  if ((kind === 'contributions_only') !== (annualReturnRate === '0')) {
    throw new DomainValidationError(
      'forecast.scenario_rate_mismatch',
      'Only the zero-rate scenario may be contributions-only.',
    );
  }
  return Object.freeze({ annualReturnRate, kind, defaultModeled: value.defaultModeled });
}
