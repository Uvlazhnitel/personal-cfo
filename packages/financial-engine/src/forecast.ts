import {
  EUR,
  createForecastCapitalFlow,
  createForecastPlannedExpense,
  createForecastScenarioAssumption,
  createMetricResult,
  createMoney,
  parseDecimalRate,
  parseInstant,
  parseYearMonth,
} from '@personal-cfo/domain';
import type {
  DataWarning,
  DecimalRate,
  ExplanationComponent,
  ForecastCapitalFlow,
  ForecastPlannedExpense,
  ForecastPlannedExpenseId,
  ForecastScenarioAssumption,
  Instant,
  MetricResult,
  Money,
  YearMonth,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import {
  FORECAST_DECIMAL_PRECISION,
  annualToMonthlyFactor,
  compareDecimalRates,
  multiplyDecimalHalfEven,
  realValueHalfEven,
  validateAnnualRate,
} from './forecast-decimal.js';
import { addYearMonths } from './local-calendar.js';

export type ForecastSettings = Readonly<{
  horizonMonths: readonly number[];
  scenarios: readonly ForecastScenarioAssumption[];
  annualInflationRate: DecimalRate | null;
}>;

export const DEFAULT_FORECAST_SETTINGS: ForecastSettings = Object.freeze({
  horizonMonths: Object.freeze([12, 36, 60, 120]),
  scenarios: Object.freeze([
    createForecastScenarioAssumption({
      annualReturnRate: parseDecimalRate('0'),
      kind: 'contributions_only',
      defaultModeled: false,
    }),
    createForecastScenarioAssumption({
      annualReturnRate: parseDecimalRate('0.03'),
      kind: 'modeled',
      defaultModeled: false,
    }),
    createForecastScenarioAssumption({
      annualReturnRate: parseDecimalRate('0.05'),
      kind: 'modeled',
      defaultModeled: true,
    }),
    createForecastScenarioAssumption({
      annualReturnRate: parseDecimalRate('0.07'),
      kind: 'modeled',
      defaultModeled: false,
    }),
  ]),
  annualInflationRate: parseDecimalRate('0.02'),
});

export type ForecastMonthValue = Readonly<{
  month: YearMonth;
  monthNumber: number;
  openingCash: Money;
  openingInvestment: Money;
  modeledReturn: Money;
  cashChange: Money;
  investmentChange: Money;
  plannedExpenses: Money;
  closingCash: Money;
  closingInvestment: Money;
  closingTotalCapital: Money;
  cumulativeCashChange: Money;
  cumulativeInvestmentChange: Money;
  cumulativePlannedExpenses: Money;
  cumulativeModeledReturn: Money;
  realClosingTotalCapital: Money | null;
}>;

export type ForecastBoundaryResult = Readonly<{
  month: YearMonth;
  monthNumber: number;
  status: 'complete' | 'partial' | 'unavailable';
  value: ForecastMonthValue | null;
  warnings: readonly DataWarning[];
}>;

export type ForecastHorizonResult = Readonly<{
  months: number;
  status: 'complete' | 'partial' | 'unavailable';
  value: ForecastMonthValue | null;
  warnings: readonly DataWarning[];
}>;

export type ForecastScenarioResult = Readonly<{
  assumption: ForecastScenarioAssumption;
  monthlyReturnFactor: string;
  monthlyInflationFactor: string | null;
  decimalPrecision: number;
  startingCash: Money;
  startingInvestment: Money;
  monthlyPath: readonly ForecastBoundaryResult[];
  horizons: readonly ForecastHorizonResult[];
}>;

export type FinancialForecast = Readonly<{
  forecastStartMonth: YearMonth;
  includedOptionalExpenseIds: readonly ForecastPlannedExpenseId[];
  scenarios: readonly ForecastScenarioResult[];
}>;

export type FinancialForecastInput = Readonly<{
  startingCash: MetricResult<Money>;
  startingInvestment: MetricResult<Money>;
  forecastStartMonth: YearMonth;
  capitalFlows: readonly ForecastCapitalFlow[];
  plannedExpenses: readonly ForecastPlannedExpense[];
  includedOptionalExpenseIds: readonly ForecastPlannedExpenseId[];
  settings: ForecastSettings;
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

function validateSettings(settings: ForecastSettings): ForecastSettings {
  const horizons = [...settings.horizonMonths];
  if (
    horizons.length !== 4 ||
    horizons.some((item) => !Number.isSafeInteger(item) || item <= 0) ||
    horizons.join(',') !== '12,36,60,120'
  ) {
    throw new FinancialEngineInvariantError(
      'forecast.invalid_horizons',
      'V1 forecast horizons must be 12, 36, 60, and 120 months.',
    );
  }
  const scenarios = settings.scenarios
    .map((item) => createForecastScenarioAssumption(item))
    .sort((left, right) => compareDecimalRates(left.annualReturnRate, right.annualReturnRate));
  requireUnique(
    scenarios.map((item) => item.annualReturnRate),
    'forecast.duplicate_rate',
    'Forecast annual return rates must be unique.',
  );
  for (const scenario of scenarios) validateAnnualRate(scenario.annualReturnRate);
  const required = ['0', '0.03', '0.05', '0.07'];
  if (
    required.some((rate) => !scenarios.some((item) => item.annualReturnRate === rate)) ||
    scenarios.filter((item) => item.defaultModeled).length !== 1 ||
    scenarios.find((item) => item.defaultModeled)?.annualReturnRate !== '0.05'
  ) {
    throw new FinancialEngineInvariantError(
      'forecast.invalid_v1_scenarios',
      'V1 forecast settings require independent 0%, 3%, 5%, and 7% scenarios with 5% default.',
    );
  }
  const inflation =
    settings.annualInflationRate === null ? null : parseDecimalRate(settings.annualInflationRate);
  if (inflation !== null) validateAnnualRate(inflation);
  return Object.freeze({
    horizonMonths: Object.freeze(horizons),
    scenarios: Object.freeze(scenarios),
    annualInflationRate: inflation,
  });
}

function canonicalInputs(input: FinancialForecastInput) {
  const flows = input.capitalFlows.map((item) => createForecastCapitalFlow(item));
  const expenses = input.plannedExpenses.map((item) => createForecastPlannedExpense(item));
  requireUnique(
    flows.map((item) => item.id),
    'forecast.duplicate_capital_flow',
    'Forecast capital-flow IDs must be unique.',
  );
  requireUnique(
    expenses.map((item) => item.id),
    'forecast.duplicate_expense',
    'Forecast expense IDs must be unique.',
  );
  requireUnique(
    input.includedOptionalExpenseIds,
    'forecast.duplicate_optional_expense',
    'Included optional expense IDs must be unique.',
  );
  const expenseIds = new Set(expenses.map((item) => item.id));
  if (input.includedOptionalExpenseIds.some((id) => !expenseIds.has(id))) {
    throw new FinancialEngineInvariantError(
      'forecast.unknown_optional_expense',
      'Included optional expense IDs must reference supplied expenses.',
    );
  }
  const monetary = flows.flatMap((item) => [item.cashChange, item.investmentChange]);
  for (const expense of expenses) {
    if (expense.amount.kind === 'exact') monetary.push(expense.amount.amount);
    if (expense.amount.kind === 'range') monetary.push(expense.amount.lower, expense.amount.upper);
    if (expense.amount.kind === 'unknown' && expense.amount.currency !== EUR) {
      throw new FinancialEngineInvariantError(
        'forecast.currency_mismatch',
        'Forecast values must use EUR.',
      );
    }
  }
  if (monetary.some((item) => item.currency !== EUR)) {
    throw new FinancialEngineInvariantError(
      'forecast.currency_mismatch',
      'Forecast values must use EUR.',
    );
  }
  return Object.freeze({
    flows: Object.freeze(
      flows.sort((a, b) => a.month.localeCompare(b.month) || a.id.localeCompare(b.id)),
    ),
    expenses: Object.freeze(
      expenses.sort((a, b) => a.dueMonth.localeCompare(b.dueMonth) || a.id.localeCompare(b.id)),
    ),
    includedOptional: new Set(input.includedOptionalExpenseIds),
  });
}

function expenseAmount(
  expense: ForecastPlannedExpense,
  includedOptional: ReadonlySet<ForecastPlannedExpenseId>,
): bigint | null | undefined {
  const included =
    expense.priority === 'mandatory' || expense.committed || includedOptional.has(expense.id);
  if (!included) return undefined;
  if (expense.amount.kind === 'unknown') return null;
  return expense.amount.kind === 'exact'
    ? expense.amount.amount.amountMinor
    : expense.amount.upper.amountMinor;
}

function scenarioPath(
  assumption: ForecastScenarioAssumption,
  startMonth: YearMonth,
  startingCash: bigint,
  startingInvestment: bigint,
  startStatus: 'complete' | 'partial',
  inputs: ReturnType<typeof canonicalInputs>,
  settings: ForecastSettings,
): ForecastScenarioResult {
  const monthlyReturnFactor = annualToMonthlyFactor(assumption.annualReturnRate);
  const monthlyInflationFactor =
    settings.annualInflationRate === null
      ? null
      : annualToMonthlyFactor(settings.annualInflationRate);
  let cash = startingCash;
  let investment = startingInvestment;
  let cumulativeCash = 0n;
  let cumulativeInvestment = 0n;
  let cumulativeExpenses = 0n;
  let cumulativeReturn = 0n;
  let unavailable = false;
  const monthlyPath: ForecastBoundaryResult[] = [];
  const maximumHorizon = settings.horizonMonths.at(-1)!;
  for (let monthNumber = 1; monthNumber <= maximumHorizon; monthNumber += 1) {
    const month = addYearMonths(startMonth, monthNumber - 1);
    if (unavailable) {
      monthlyPath.push(
        Object.freeze({
          month,
          monthNumber,
          status: 'unavailable',
          value: null,
          warnings: Object.freeze([warning('forecast.prior_unknown_expense')]),
        }),
      );
      continue;
    }
    const flows = inputs.flows.filter((item) => item.month === month);
    const expenses = inputs.expenses.filter((item) => item.dueMonth === month);
    const unknown = expenses.find((item) => expenseAmount(item, inputs.includedOptional) === null);
    if (unknown !== undefined) {
      unavailable = true;
      monthlyPath.push(
        Object.freeze({
          month,
          monthNumber,
          status: 'unavailable',
          value: null,
          warnings: Object.freeze([
            warning('forecast.unknown_required_expense', { expenseId: unknown.id }),
          ]),
        }),
      );
      continue;
    }
    const cashChange = flows.reduce((sum, item) => sum + item.cashChange.amountMinor, 0n);
    const investmentChange = flows.reduce(
      (sum, item) => sum + item.investmentChange.amountMinor,
      0n,
    );
    const plannedExpenses = expenses.reduce(
      (sum, item) => sum + (expenseAmount(item, inputs.includedOptional) ?? 0n),
      0n,
    );
    const openingCash = cash;
    const openingInvestment = investment;
    const modeledReturn = multiplyDecimalHalfEven(openingInvestment, monthlyReturnFactor);
    investment = openingInvestment + modeledReturn + investmentChange;
    if (investment < 0n) {
      throw new FinancialEngineInvariantError(
        'forecast.negative_investment',
        'A forecast withdrawal cannot create a negative investment market value.',
      );
    }
    cash = openingCash + cashChange - plannedExpenses;
    cumulativeCash += cashChange;
    cumulativeInvestment += investmentChange;
    cumulativeExpenses += plannedExpenses;
    cumulativeReturn += modeledReturn;
    const total = cash + investment;
    const value: ForecastMonthValue = Object.freeze({
      month,
      monthNumber,
      openingCash: money(openingCash),
      openingInvestment: money(openingInvestment),
      modeledReturn: money(modeledReturn),
      cashChange: money(cashChange),
      investmentChange: money(investmentChange),
      plannedExpenses: money(plannedExpenses),
      closingCash: money(cash),
      closingInvestment: money(investment),
      closingTotalCapital: money(total),
      cumulativeCashChange: money(cumulativeCash),
      cumulativeInvestmentChange: money(cumulativeInvestment),
      cumulativePlannedExpenses: money(cumulativeExpenses),
      cumulativeModeledReturn: money(cumulativeReturn),
      realClosingTotalCapital:
        monthlyInflationFactor === null
          ? null
          : money(realValueHalfEven(total, monthlyInflationFactor, monthNumber)),
    });
    monthlyPath.push(
      Object.freeze({
        month,
        monthNumber,
        status: startStatus,
        value,
        warnings:
          startStatus === 'partial'
            ? Object.freeze([warning('forecast.partial_starting_value')])
            : Object.freeze([]),
      }),
    );
  }
  const horizons = settings.horizonMonths.map((months): ForecastHorizonResult => {
    const boundary = monthlyPath[months - 1]!;
    return Object.freeze({
      months,
      status: boundary.status,
      value: boundary.value,
      warnings: boundary.warnings,
    });
  });
  return Object.freeze({
    assumption,
    monthlyReturnFactor,
    monthlyInflationFactor,
    decimalPrecision: FORECAST_DECIMAL_PRECISION,
    startingCash: money(startingCash),
    startingInvestment: money(startingInvestment),
    monthlyPath: Object.freeze(monthlyPath),
    horizons: Object.freeze(horizons),
  });
}

function explanation(value: FinancialForecast): readonly ExplanationComponent[] {
  const result: ExplanationComponent[] = [];
  for (const scenario of value.scenarios) {
    const prefix = `forecast.${scenario.assumption.annualReturnRate}`;
    result.push(
      {
        ruleId: 'forecast.annual-rate',
        inputKey: `${prefix}.annualReturnRate`,
        value: scenario.assumption.annualReturnRate,
      },
      {
        ruleId: 'forecast.monthly-factor',
        inputKey: `${prefix}.monthlyReturnFactor`,
        value: scenario.monthlyReturnFactor,
      },
    );
    for (const horizon of scenario.horizons) {
      if (horizon.value === null) continue;
      result.push({
        ruleId: 'forecast.horizon-total',
        inputKey: `${prefix}.${horizon.months}m.endingTotal`,
        value: horizon.value.closingTotalCapital.amountMinor.toString(),
      });
    }
  }
  return Object.freeze(result.map((item) => Object.freeze(item)));
}

export function calculateFinancialForecast(
  input: FinancialForecastInput,
): MetricResult<FinancialForecast> {
  const asOf = parseInstant(input.asOf);
  const startMonth = parseYearMonth(input.forecastStartMonth);
  const settings = validateSettings(input.settings);
  for (const start of [input.startingCash, input.startingInvestment]) {
    if (
      start.asOf !== asOf ||
      start.settingsVersion !== input.settingsVersion ||
      start.engineVersion !== input.engineVersion ||
      start.inputWatermark !== input.inputWatermark
    ) {
      throw new FinancialEngineInvariantError(
        'forecast.starting_metadata_mismatch',
        'Forecast starting metrics must share the run envelope.',
      );
    }
  }
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;
  if (input.startingCash.value === null || input.startingInvestment.value === null) {
    return createMetricResult<FinancialForecast>({
      ...base,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: Object.freeze([
        ...input.startingCash.warnings,
        ...input.startingInvestment.warnings,
        warning('forecast.missing_starting_value'),
      ]),
    });
  }
  const startingCash = createMoney(
    input.startingCash.value.amountMinor,
    input.startingCash.value.currency,
  );
  const startingInvestment = createMoney(
    input.startingInvestment.value.amountMinor,
    input.startingInvestment.value.currency,
  );
  if (
    startingCash.currency !== EUR ||
    startingInvestment.currency !== EUR ||
    startingInvestment.amountMinor < 0n
  ) {
    throw new FinancialEngineInvariantError(
      'forecast.invalid_starting_value',
      'Forecast starting values must use EUR and investment value must be non-negative.',
    );
  }
  const canonical = canonicalInputs(input);
  const startStatus =
    input.startingCash.status === 'complete' && input.startingInvestment.status === 'complete'
      ? 'complete'
      : 'partial';
  const scenarios = settings.scenarios.map((assumption) =>
    scenarioPath(
      assumption,
      startMonth,
      startingCash.amountMinor,
      startingInvestment.amountMinor,
      startStatus,
      canonical,
      settings,
    ),
  );
  const value = Object.freeze({
    forecastStartMonth: startMonth,
    includedOptionalExpenseIds: Object.freeze([...input.includedOptionalExpenseIds].sort()),
    scenarios: Object.freeze(scenarios),
  });
  const hasUnavailable = scenarios.some((scenario) =>
    scenario.horizons.some((horizon) => horizon.status === 'unavailable'),
  );
  const status = startStatus === 'partial' || hasUnavailable ? 'partial' : 'complete';
  return createMetricResult({
    ...base,
    status,
    value,
    explanation: explanation(value),
    warnings: Object.freeze([
      ...input.startingCash.warnings,
      ...input.startingInvestment.warnings,
      ...(hasUnavailable ? [warning('forecast.horizon_unavailable')] : []),
    ]),
  });
}
