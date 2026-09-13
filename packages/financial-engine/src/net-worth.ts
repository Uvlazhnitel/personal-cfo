import {
  EUR,
  compareInstants,
  createAccountBalanceSnapshot,
  createMetricResult,
  createMoney,
  createPortfolioValuation,
  parseInstant,
} from '@personal-cfo/domain';
import type {
  Account,
  AccountBalanceSnapshot,
  DataWarning,
  Instant,
  MetricResult,
  Money,
  PortfolioValuation,
  ReportableAmount,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';
import type { LedgerInput, ValidatedLedger } from './ledger.js';
import { calculateLedgerBalance, validateLedger } from './ledger.js';

export type NetWorthBreakdown = Readonly<{
  liquidCash: Money;
  investmentMarketValue: Money;
  otherAssets: Money;
  liabilities: Money;
  total: Money;
}>;

export type NetWorthInput = LedgerInput &
  Readonly<{
    accountBalanceSnapshots: readonly AccountBalanceSnapshot[];
    portfolioValuations: readonly PortfolioValuation[];
    asOf: Instant;
    engineVersion: string;
    settingsVersion: string;
    inputWatermark: string;
  }>;

type PositionResult = Readonly<{
  amount: Money | null;
  warning: DataWarning | null;
}>;

function warning(
  code: string,
  account: Account,
  context: Readonly<Record<string, string>> = {},
): DataWarning {
  return Object.freeze({
    code,
    context: Object.freeze({ accountId: account.id, subtype: account.subtype, ...context }),
  });
}

function latestByAccount<T extends { readonly accountId: string; readonly sourceAsOf: Instant }>(
  values: readonly T[],
  accountId: string,
  asOf: Instant,
  duplicateCode: string,
): T | undefined {
  const matching = values.filter((value) => value.accountId === accountId);
  if (new Set(matching.map((value) => value.sourceAsOf)).size !== matching.length) {
    throw new FinancialEngineInvariantError(
      duplicateCode,
      'An account cannot have two authoritative values at one instant.',
    );
  }

  const eligible = matching
    .filter((value) => compareInstants(value.sourceAsOf, asOf) <= 0)
    .sort((left, right) => compareInstants(left.sourceAsOf, right.sourceAsOf));

  return eligible.at(-1);
}

function reportingMoney(value: ReportableAmount, account: Account): PositionResult {
  if (value.original.currency !== account.currency) {
    throw new FinancialEngineInvariantError(
      'net_worth.account_currency_mismatch',
      'A valuation original amount must use its account currency.',
    );
  }

  if (value.status === 'missing_fx') {
    return {
      amount: null,
      warning: warning('net_worth.missing_fx', account, {
        originalCurrency: value.original.currency,
      }),
    };
  }

  if (value.reporting.currency !== EUR) {
    throw new FinancialEngineInvariantError(
      'net_worth.reporting_currency_mismatch',
      'Net Worth values must be reported in EUR.',
    );
  }

  return { amount: value.reporting, warning: null };
}

function snapshotPosition(
  account: Account,
  snapshots: readonly AccountBalanceSnapshot[],
  asOf: Instant,
): PositionResult {
  const snapshot = latestByAccount(
    snapshots,
    account.id,
    asOf,
    'net_worth.duplicate_balance_snapshot',
  );

  if (snapshot === undefined) {
    return { amount: null, warning: warning('net_worth.missing_balance', account) };
  }

  const result = reportingMoney(snapshot.value, account);
  if (result.amount !== null && compareInstants(asOf, snapshot.staleAt) > 0) {
    return {
      amount: result.amount,
      warning: warning('net_worth.stale_balance', account, {
        sourceAsOf: snapshot.sourceAsOf,
        staleAt: snapshot.staleAt,
      }),
    };
  }
  return result;
}

function portfolioPosition(
  account: Account,
  valuations: readonly PortfolioValuation[],
  asOf: Instant,
): PositionResult {
  const valuation = latestByAccount(
    valuations,
    account.id,
    asOf,
    'net_worth.duplicate_portfolio_valuation',
  );

  if (valuation === undefined) {
    return { amount: null, warning: warning('net_worth.missing_portfolio', account) };
  }

  const result = reportingMoney(valuation.marketValue, account);
  if (result.amount !== null && compareInstants(asOf, valuation.staleAt) > 0) {
    return {
      amount: result.amount,
      warning: warning('net_worth.stale_portfolio', account, {
        sourceAsOf: valuation.sourceAsOf,
        staleAt: valuation.staleAt,
      }),
    };
  }
  return result;
}

function validatePositionFacts(
  ledger: ValidatedLedger,
  snapshots: readonly AccountBalanceSnapshot[],
  valuations: readonly PortfolioValuation[],
): void {
  const accountsById = new Map(ledger.accounts.map((account) => [account.id, account]));
  const balanceKeys = new Set<string>();
  const portfolioKeys = new Set<string>();

  for (const snapshot of snapshots) {
    const key = `${snapshot.accountId}:${snapshot.sourceAsOf}`;
    if (balanceKeys.has(key)) {
      throw new FinancialEngineInvariantError(
        'net_worth.duplicate_balance_snapshot',
        'An account cannot have two authoritative balances at one instant.',
      );
    }
    balanceKeys.add(key);

    const account = accountsById.get(snapshot.accountId);
    if (account === undefined || account.valueSource !== 'balance_snapshot') {
      throw new FinancialEngineInvariantError(
        'net_worth.invalid_balance_source',
        'A balance snapshot must reference an account configured for balance snapshots.',
      );
    }
    if (snapshot.value.original.currency !== account.currency) {
      throw new FinancialEngineInvariantError(
        'net_worth.account_currency_mismatch',
        'A balance original amount must use its account currency.',
      );
    }
  }

  for (const valuation of valuations) {
    const key = `${valuation.accountId}:${valuation.sourceAsOf}`;
    if (portfolioKeys.has(key)) {
      throw new FinancialEngineInvariantError(
        'net_worth.duplicate_portfolio_valuation',
        'An investment account cannot have two portfolio values at one instant.',
      );
    }
    portfolioKeys.add(key);

    const account = accountsById.get(valuation.accountId);
    if (account === undefined || account.valueSource !== 'portfolio_valuation') {
      throw new FinancialEngineInvariantError(
        'net_worth.invalid_portfolio_source',
        'A portfolio valuation must reference an investment account.',
      );
    }
    if (valuation.marketValue.original.currency !== account.currency) {
      throw new FinancialEngineInvariantError(
        'net_worth.account_currency_mismatch',
        'A portfolio original amount must use its account currency.',
      );
    }
  }
}

function validateBrokerageCashTreatment(
  ledger: ValidatedLedger,
  valuations: readonly PortfolioValuation[],
  asOf: Instant,
): void {
  for (const investment of ledger.accounts.filter(
    (account) => account.subtype === 'investment' && account.includeInNetWorth,
  )) {
    const valuation = latestByAccount(
      valuations,
      investment.id,
      asOf,
      'net_worth.duplicate_portfolio_valuation',
    );
    if (valuation === undefined) continue;

    const linkedCash = ledger.accounts.filter(
      (account) => account.brokerageCashFor === investment.id && account.includeInNetWorth,
    );

    if (valuation.brokerageCashTreatment === 'included_in_market_value' && linkedCash.length > 0) {
      throw new FinancialEngineInvariantError(
        'net_worth.brokerage_cash_double_count',
        'Brokerage cash cannot be included in both portfolio value and a separate account.',
      );
    }

    if (valuation.brokerageCashTreatment === 'separate_account' && linkedCash.length !== 1) {
      throw new FinancialEngineInvariantError(
        'net_worth.invalid_separate_brokerage_cash',
        'A separate brokerage cash treatment requires exactly one included linked cash account.',
      );
    }
  }
}

function freezeBreakdown(
  liquidCashMinor: bigint,
  investmentMarketValueMinor: bigint,
  otherAssetsMinor: bigint,
  liabilitiesMinor: bigint,
): NetWorthBreakdown {
  const liquidCash = createMoney(liquidCashMinor, EUR);
  const investmentMarketValue = createMoney(investmentMarketValueMinor, EUR);
  const otherAssets = createMoney(otherAssetsMinor, EUR);
  const liabilities = createMoney(liabilitiesMinor, EUR);
  return Object.freeze({
    liquidCash,
    investmentMarketValue,
    otherAssets,
    liabilities,
    total: createMoney(
      liquidCashMinor + investmentMarketValueMinor + otherAssetsMinor - liabilitiesMinor,
      EUR,
    ),
  });
}

export function calculateNetWorth(input: NetWorthInput): MetricResult<NetWorthBreakdown> {
  const asOf = parseInstant(input.asOf);
  const ledger = validateLedger(input);
  const balanceSnapshots = Object.freeze(
    input.accountBalanceSnapshots.map((snapshot) => createAccountBalanceSnapshot(snapshot)),
  );
  const portfolioValuations = Object.freeze(
    input.portfolioValuations.map((valuation) => createPortfolioValuation(valuation)),
  );

  validatePositionFacts(ledger, balanceSnapshots, portfolioValuations);
  validateBrokerageCashTreatment(ledger, portfolioValuations, asOf);

  const includedAccounts = ledger.accounts.filter((account) => account.includeInNetWorth);
  const warnings: DataWarning[] = [];
  let liquidCashMinor = 0n;
  let investmentMarketValueMinor = 0n;
  let otherAssetsMinor = 0n;
  let liabilitiesMinor = 0n;
  let missingValue = false;

  if (includedAccounts.length === 0) {
    warnings.push(
      Object.freeze({
        code: 'net_worth.no_included_accounts',
        context: Object.freeze({ metric: 'net_worth' }),
      }),
    );
    missingValue = true;
  }

  for (const account of includedAccounts) {
    const result =
      account.valueSource === 'ledger'
        ? { amount: calculateLedgerBalance({ ledger, accountId: account.id, asOf }), warning: null }
        : account.valueSource === 'balance_snapshot'
          ? snapshotPosition(account, balanceSnapshots, asOf)
          : portfolioPosition(account, portfolioValuations, asOf);

    if (result.warning !== null) warnings.push(result.warning);
    if (result.amount === null) {
      missingValue = true;
      continue;
    }

    if (
      (account.subtype === 'investment' ||
        account.subtype === 'other_asset' ||
        account.subtype === 'liability') &&
      result.amount.amountMinor < 0n
    ) {
      throw new FinancialEngineInvariantError(
        'net_worth.negative_magnitude',
        'Investment, other-asset, and liability values must be non-negative magnitudes.',
      );
    }

    switch (account.subtype) {
      case 'bank':
      case 'cash':
        liquidCashMinor += result.amount.amountMinor;
        break;
      case 'investment':
        investmentMarketValueMinor += result.amount.amountMinor;
        break;
      case 'other_asset':
        otherAssetsMinor += result.amount.amountMinor;
        break;
      case 'liability':
        liabilitiesMinor += result.amount.amountMinor;
        break;
    }
  }

  warnings.sort((left, right) => {
    const byCode = left.code.localeCompare(right.code);
    return byCode !== 0
      ? byCode
      : (left.context['accountId'] ?? '').localeCompare(right.context['accountId'] ?? '');
  });

  const metadata = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
    warnings,
  } as const;

  if (missingValue) {
    return createMetricResult<NetWorthBreakdown>({
      ...metadata,
      status: 'unavailable',
      value: null,
      explanation: [],
    });
  }

  const value = freezeBreakdown(
    liquidCashMinor,
    investmentMarketValueMinor,
    otherAssetsMinor,
    liabilitiesMinor,
  );
  const explanation = [
    {
      ruleId: 'net-worth.component',
      inputKey: 'liquidCash',
      value: liquidCashMinor.toString(),
    },
    {
      ruleId: 'net-worth.component',
      inputKey: 'investmentMarketValue',
      value: investmentMarketValueMinor.toString(),
    },
    {
      ruleId: 'net-worth.component',
      inputKey: 'otherAssets',
      value: otherAssetsMinor.toString(),
    },
    {
      ruleId: 'net-worth.component',
      inputKey: 'liabilities',
      value: (-liabilitiesMinor).toString(),
    },
    { ruleId: 'net-worth.total', inputKey: 'total', value: value.total.amountMinor.toString() },
  ];

  return createMetricResult<NetWorthBreakdown>({
    ...metadata,
    status: warnings.length === 0 ? 'complete' : 'partial',
    value,
    explanation,
  });
}
