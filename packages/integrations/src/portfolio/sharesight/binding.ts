import { createHash } from 'node:crypto';

import {
  DomainValidationError,
  EUR,
  createMoney,
  createNativeReportableAmount,
  parseDecimalRate,
  parseInstant,
} from '@personal-cfo/domain';

import {
  createContributionEvidence,
  createPortfolioCapabilities,
  createPortfolioSnapshot,
  createProviderRevisionIdentity,
} from '../contract.js';
import type { PortfolioCapabilities, ProviderRevisionIdentity } from '../types.js';
import {
  SHARESIGHT_BINDING_VERSION,
  SHARESIGHT_PROVIDER_ID,
  type SharesightCashAccount,
  type SharesightCashAccountTransaction,
  type SharesightContributionContext,
  type SharesightContributionNormalization,
  type SharesightExactNumber,
  type SharesightHolding,
  type SharesightPayout,
  type SharesightPerformance,
  type SharesightPortfolio,
  type SharesightProviderBinding,
  type SharesightReportHeaders,
  type SharesightScanPhase,
  type SharesightScanWindow,
  type SharesightSnapshotContext,
  type SharesightSnapshotNormalization,
  type SharesightTrade,
  type SharesightTradeEvidence,
  type SharesightValuation,
  type SharesightValuationCashAccount,
  type SharesightPayoutEvidence,
  type SharesightPayoutNormalization,
  type SharesightTradeNormalization,
} from './types.js';
import type { ProviderProfitLoss } from '../types.js';

const EXACT_NUMBER_KEY = '__sharesight_exact_number__';
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

type UnknownRecord = Record<string, unknown>;

const SHARESIGHT_TIME_ZONES = Object.freeze({
  Riga: 'Europe/Riga',
  'Europe/Riga': 'Europe/Riga',
  Tallinn: 'Europe/Tallinn',
  'Europe/Tallinn': 'Europe/Tallinn',
  UTC: 'UTC',
  Wellington: 'Pacific/Auckland',
  'Pacific/Auckland': 'Pacific/Auckland',
} as const);

function invalid(code: string, message: string): never {
  throw new DomainValidationError(`sharesight_binding.${code}`, message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid('invalid_payload', `${label} must be an object.`);
  }
  return value as UnknownRecord;
}

function array(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) return invalid('invalid_payload', `${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > 512) {
    return invalid('invalid_payload', `${label} must be a bounded string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : string(value, label);
}

function numericSource(value: unknown, label: string): SharesightExactNumber {
  const token = record(value, label);
  const source = token[EXACT_NUMBER_KEY];
  if (
    Object.keys(token).length !== 1 ||
    typeof source !== 'string' ||
    !DECIMAL_PATTERN.test(source)
  ) {
    return invalid('invalid_number', `${label} must be an exact non-exponent JSON number.`);
  }
  return source as SharesightExactNumber;
}

function providerId(value: unknown, label: string): string {
  const source = numericSource(value, label);
  if (!UNSIGNED_INTEGER_PATTERN.test(source)) {
    return invalid('invalid_provider_id', `${label} must be a non-negative decimal identifier.`);
  }
  return source;
}

function providerIdOrString(value: unknown, label: string): string {
  if (typeof value === 'string') return string(value, label);
  return providerId(value, label);
}

function nullableProviderId(value: unknown, label: string): string | null {
  return value === null ? null : providerId(value, label);
}

function parseExactJson(rawJson: string): unknown {
  try {
    const parseWithSource = JSON.parse as unknown as (
      text: string,
      reviver: (key: string, value: unknown, context: Readonly<{ source?: string }>) => unknown,
    ) => unknown;
    return parseWithSource(
      rawJson,
      (_key: string, value: unknown, context: Readonly<{ source?: string }>) => {
        if (typeof value !== 'number') return value;
        if (context.source === undefined || !DECIMAL_PATTERN.test(context.source)) {
          return invalid('invalid_number', 'Provider numbers must use ordinary decimal notation.');
        }
        return Object.freeze({ [EXACT_NUMBER_KEY]: context.source });
      },
    );
  } catch (error) {
    if (error instanceof DomainValidationError) throw error;
    return invalid('invalid_json', 'Sharesight payload must be valid JSON.');
  }
}

function parseDate(value: unknown, label: string): string {
  const parsed = string(value, label);
  const match = DATE_PATTERN.exec(parsed);
  if (match === null) return invalid('invalid_date', `${label} must use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return invalid('invalid_date', `${label} must be a real calendar date.`);
  }
  return parsed;
}

function parseState(value: unknown, label: string): 'confirmed' | 'unconfirmed' | 'rejected' {
  if (value !== 'confirmed' && value !== 'unconfirmed' && value !== 'rejected') {
    return invalid('invalid_state', `${label} has an unsupported state.`);
  }
  return value;
}

function portfolioIdFromLink(value: unknown): string {
  const link = string(value, 'Portfolio link');
  const match = /\/portfolios\/(\d+)(?:\.json)?(?:[/?#]|$)/u.exec(link);
  if (match?.[1] === undefined) {
    return invalid('invalid_portfolio_link', 'Portfolio link must contain a portfolio ID.');
  }
  return match[1];
}

function decimalToMinor(value: SharesightExactNumber, label: string): bigint {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '', fraction = ''] = unsigned.split('.');
  if (fraction.length > 2) {
    return invalid('invalid_money_precision', `${label} must have at most two fractional digits.`);
  }
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return negative ? -amount : amount;
}

function canonicalDecimal(value: SharesightExactNumber): string {
  if (!value.includes('.')) return value;
  const normalized = value.replace(/0+$/u, '').replace(/\.$/u, '');
  return normalized === '-0' ? '0' : normalized;
}

function fingerprint(sourceId: string, fields: readonly string[]): ProviderRevisionIdentity {
  const hash = createHash('sha256');
  hash.update(`${SHARESIGHT_BINDING_VERSION}\u0000${sourceId}`);
  for (const field of fields) hash.update(`\u0000${field.length}:${field}`);
  return createProviderRevisionIdentity({
    sourceId,
    version: { kind: 'sha256_fingerprint', value: hash.digest('hex') },
  });
}

function parsePortfolio(value: unknown): SharesightPortfolio {
  const item = record(value, 'Portfolio');
  return Object.freeze({
    id: providerId(item['id'], 'Portfolio ID'),
    name: string(item['name'], 'Portfolio name'),
    currencyCode: string(item['currency_code'], 'Portfolio currency'),
    inceptionDate: string(item['inception_date'], 'Portfolio inception date'),
    timeZoneName: string(item['tz_name'], 'Portfolio timezone'),
  });
}

function parseHolding(value: unknown): SharesightHolding {
  const item = record(value, 'Holding');
  return Object.freeze({
    id: providerId(item['id'], 'Holding ID'),
    instrumentId: providerId(item['instrument_id'], 'Instrument ID'),
    symbol: item['symbol'] === null ? null : string(item['symbol'], 'Holding symbol'),
    marketCode:
      item['market_code'] === null || item['market_code'] === undefined
        ? null
        : string(item['market_code'], 'Holding market'),
    name: item['name'] === null ? null : string(item['name'], 'Holding name'),
    value: numericSource(item['value'], 'Holding value'),
    quantity: numericSource(item['quantity'], 'Holding quantity'),
  });
}

function parseValuationCashAccount(
  value: unknown,
  reportId: string,
  index: number,
): SharesightValuationCashAccount {
  const item = record(value, 'Valuation cash account');
  const cashAccountId = nullableProviderId(
    item['cash_account_id'] ?? null,
    'Valuation cash account ID',
  );
  return Object.freeze({
    id:
      item['id'] === undefined
        ? `${reportId}:cash-component:${index}`
        : providerIdOrString(item['id'], 'Valuation component ID'),
    cashAccountId,
    name: string(item['name'], 'Valuation cash account name'),
    value: numericSource(item['value'], 'Valuation cash value'),
    currencyCode: string(item['currency_code'], 'Valuation cash currency'),
  });
}

function holdingCompleteness(
  holdings: readonly SharesightHolding[],
  headers: SharesightReportHeaders,
): 'complete' | 'partial' {
  if (headers.holdingLimitReason !== undefined && headers.holdingLimitReason.length > 0) {
    return 'partial';
  }
  if (headers.holdingLimitTotal === undefined) return 'complete';
  if (!UNSIGNED_INTEGER_PATTERN.test(headers.holdingLimitTotal)) {
    return invalid('invalid_holding_limit', 'Holding limit total must be a decimal integer.');
  }
  return BigInt(headers.holdingLimitTotal) > BigInt(holdings.length) ? 'partial' : 'complete';
}

export function decodeSharesightPortfolios(rawJson: string): readonly SharesightPortfolio[] {
  const root = record(parseExactJson(rawJson), 'Portfolio response');
  return Object.freeze(array(root['portfolios'], 'Portfolios').map(parsePortfolio));
}

export function decodeSharesightValuation(
  rawJson: string,
  headers: SharesightReportHeaders = {},
): SharesightValuation {
  const root = record(parseExactJson(rawJson), 'Valuation response');
  const report = record(root['portfolio_valuation'], 'Portfolio valuation');
  const reportId = string(report['id'], 'Valuation report ID');
  const holdings = Object.freeze(
    array(root['portfolio_valuation_holdings'], 'Valuation holdings').map(parseHolding),
  );
  const cashAccounts = Object.freeze(
    array(root['portfolio_valuation_cash_accounts'], 'Valuation cash accounts').map((item, index) =>
      parseValuationCashAccount(item, reportId, index),
    ),
  );
  return Object.freeze({
    reportId,
    balanceDate: parseDate(report['balance_date'], 'Valuation balance date'),
    portfolioId: providerId(report['portfolio_id'], 'Valuation portfolio ID'),
    value: numericSource(report['value'], 'Valuation total'),
    holdings,
    cashAccounts,
    holdingsCompleteness: holdingCompleteness(holdings, headers),
  });
}

function parseCashAccount(value: unknown): SharesightCashAccount {
  const item = record(value, 'Cash account');
  return Object.freeze({
    id: providerId(item['id'], 'Cash account ID'),
    portfolioId: providerId(item['portfolio_id'], 'Cash account portfolio ID'),
    currencyCode: string(item['currency'], 'Cash account currency'),
    portfolioCurrencyCode: string(item['portfolio_currency'], 'Cash account portfolio currency'),
    date: parseDate(item['date'], 'Cash account date'),
    balance: numericSource(item['balance'], 'Cash account balance'),
    balanceInPortfolioCurrency: numericSource(
      item['balance_in_portfolio_currency'],
      'Cash account portfolio balance',
    ),
  });
}

export function decodeSharesightCashAccounts(rawJson: string): readonly SharesightCashAccount[] {
  const root = record(parseExactJson(rawJson), 'Cash accounts response');
  return Object.freeze(array(root['cash_accounts'], 'Cash accounts').map(parseCashAccount));
}

function parseCashAccountTransaction(value: unknown): SharesightCashAccountTransaction {
  const item = record(value, 'Cash account transaction');
  const type = record(item['cash_account_transaction_type'], 'Cash account transaction type');
  const links = record(item['links'], 'Cash account transaction links');
  return Object.freeze({
    id: providerId(item['id'], 'Cash account transaction ID'),
    dateTime: parseInstant(string(item['date_time'], 'Cash transaction time')),
    amount: numericSource(item['amount'], 'Cash transaction amount'),
    balance: numericSource(item['balance'], 'Cash transaction balance'),
    cashAccountId: providerId(item['cash_account_id'], 'Cash account transaction account ID'),
    foreignIdentifier: nullableString(
      item['foreign_identifier'] ?? null,
      'Cash transaction foreign identifier',
    ),
    typeName: string(type['name'], 'Cash transaction type'),
    linkedPortfolioId: portfolioIdFromLink(links['portfolio']),
  });
}

export function decodeSharesightCashAccountTransactions(
  rawJson: string,
): readonly SharesightCashAccountTransaction[] {
  const root = record(parseExactJson(rawJson), 'Cash transactions response');
  return Object.freeze(
    array(root['cash_account_transactions'], 'Cash account transactions').map(
      parseCashAccountTransaction,
    ),
  );
}

function parseTrade(value: unknown): SharesightTrade {
  const item = record(value, 'Trade');
  return Object.freeze({
    id: nullableProviderId(item['id'], 'Trade ID'),
    uniqueIdentifier: nullableString(item['unique_identifier'] ?? null, 'Trade unique identifier'),
    portfolioId: providerId(item['portfolio_id'], 'Trade portfolio ID'),
    holdingId: providerId(item['holding_id'], 'Trade holding ID'),
    transactionType: string(item['transaction_type'], 'Trade type'),
    transactionDate: parseDate(item['transaction_date'], 'Trade date'),
    state: parseState(item['state'], 'Trade'),
    value: numericSource(item['value'], 'Trade value'),
    brokerage: numericSource(item['brokerage'], 'Trade brokerage'),
    brokerageCurrencyCode:
      item['brokerage_currency_code'] === null
        ? null
        : string(item['brokerage_currency_code'], 'Trade brokerage currency'),
  });
}

export function decodeSharesightTrades(rawJson: string): readonly SharesightTrade[] {
  const root = record(parseExactJson(rawJson), 'Trades response');
  return Object.freeze(array(root['trades'], 'Trades').map(parseTrade));
}

export function decodeSharesightPerformance(rawJson: string): SharesightPerformance {
  const root = record(parseExactJson(rawJson), 'Performance response');
  const report =
    root['portfolio_performance'] === undefined
      ? root
      : record(root['portfolio_performance'], 'Portfolio performance');
  return Object.freeze({
    reportId: string(report['id'], 'Performance report ID'),
    portfolioId: providerId(report['portfolio_id'], 'Performance portfolio ID'),
    startDate: parseDate(report['start_date'], 'Performance start date'),
    endDate: parseDate(report['end_date'], 'Performance end date'),
    value: numericSource(report['value'], 'Performance value'),
    capitalGain: numericSource(report['capital_gain'], 'Performance capital gain'),
    payoutGain: numericSource(report['payout_gain'], 'Performance payout gain'),
    currencyGain: numericSource(report['currency_gain'], 'Performance currency gain'),
    totalGain: numericSource(report['total_gain'], 'Performance total gain'),
  });
}

function parsePayout(value: unknown): SharesightPayout {
  const item = record(value, 'Payout');
  return Object.freeze({
    id: nullableProviderId(item['id'], 'Payout ID'),
    portfolioId: providerId(item['portfolio_id'], 'Payout portfolio ID'),
    holdingId: providerId(item['holding_id'], 'Payout holding ID'),
    paidOn: parseDate(item['paid_on'], 'Payout date'),
    amount: numericSource(item['amount'], 'Payout amount'),
    currencyCode: string(item['currency'], 'Payout currency'),
    state: parseState(item['state'], 'Payout'),
  });
}

export function decodeSharesightPayouts(rawJson: string): readonly SharesightPayout[] {
  const root = record(parseExactJson(rawJson), 'Payouts response');
  return Object.freeze(array(root['payouts'], 'Payouts').map(parsePayout));
}

function localDateStartInstant(date: string, providerTimeZone: string): string | null {
  const timeZone = SHARESIGHT_TIME_ZONES[providerTimeZone as keyof typeof SHARESIGHT_TIME_ZONES];
  if (timeZone === undefined) return null;
  const match = DATE_PATTERN.exec(date);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const targetUtc = Date.UTC(year, month - 1, day);
  let candidate = targetUtc;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = formatter.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes): number => {
      const value = parts.find((entry) => entry.type === type)?.value;
      if (value === undefined) return invalid('invalid_timezone', 'Timezone conversion failed.');
      return Number(value);
    };
    const represented = Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
      part('second'),
    );
    candidate += targetUtc - represented;
  }
  return new Date(candidate).toISOString();
}

function cashTotal(accounts: readonly SharesightValuationCashAccount[]): bigint {
  return accounts.reduce(
    (total, account) => total + decimalToMinor(account.value, 'Valuation cash value'),
    0n,
  );
}

export function normalizeSharesightValuation(
  portfolio: SharesightPortfolio,
  valuation: SharesightValuation,
  context: SharesightSnapshotContext,
): SharesightSnapshotNormalization {
  if (valuation.portfolioId !== portfolio.id) {
    return invalid('portfolio_mismatch', 'Valuation belongs to a different portfolio.');
  }
  if (portfolio.currencyCode !== 'EUR') {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_non_eur_reporting_currency',
    });
  }
  if (valuation.cashAccounts.some((account) => account.currencyCode !== 'EUR')) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_non_eur_reporting_currency',
    });
  }
  const sourceAsOfValue = localDateStartInstant(valuation.balanceDate, portfolio.timeZoneName);
  if (sourceAsOfValue === null) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_timezone_unavailable',
    });
  }
  const sourceAsOf = parseInstant(sourceAsOfValue);
  const connection = Object.freeze({
    provider: SHARESIGHT_PROVIDER_ID,
    connectionId: context.connectionId,
  });
  const totalMoney = createMoney(decimalToMinor(valuation.value, 'Valuation total'), EUR);
  const total = createNativeReportableAmount(totalMoney);
  const cashAmount =
    valuation.cashAccounts.length === 0
      ? null
      : createNativeReportableAmount(createMoney(cashTotal(valuation.cashAccounts), EUR));
  const valuationSourceId = `portfolio:${portfolio.id}:valuation:${valuation.balanceDate}`;
  const revisionFields = [
    valuation.reportId,
    valuation.value,
    ...valuation.holdings.flatMap((holding) => [
      holding.id,
      holding.instrumentId,
      holding.quantity,
      holding.value,
    ]),
    ...valuation.cashAccounts.flatMap((account) => [
      account.id,
      account.cashAccountId ?? '',
      account.value,
      account.currencyCode,
    ]),
  ];
  const snapshot = createPortfolioSnapshot({
    ownerId: context.ownerId,
    accountId: context.accountId,
    connection,
    providerPortfolioId: portfolio.id,
    sourceAsOf,
    receivedAt: context.receivedAt,
    staleAt: context.staleAt,
    providerReportedMarketValue: total,
    totalMarketValue: total,
    cash: { treatment: 'included_in_total', amount: cashAmount },
    netWorthProjection: {
      kind: 'single_investment_account',
      investmentAccountId: context.accountId,
      value: total,
    },
    contributedCapital: null,
    holdings: {
      completeness: valuation.holdingsCompleteness,
      items: valuation.holdings.map((holding) => {
        const holdingSourceId = `portfolio:${portfolio.id}:holding:${holding.id}`;
        return Object.freeze({
          providerHoldingId: holding.id,
          providerSecurityId: holding.instrumentId,
          instrumentName: holding.name,
          symbol: holding.symbol,
          quantity: parseDecimalRate(canonicalDecimal(holding.quantity)),
          marketValue: createNativeReportableAmount(
            createMoney(decimalToMinor(holding.value, 'Holding value'), EUR),
          ),
          sourceAsOf,
          revision: fingerprint(holdingSourceId, [
            holding.instrumentId,
            holding.quantity,
            holding.value,
          ]),
        });
      }),
    },
    sourceCompleteness: context.sourceFreshnessConfirmed ? 'complete' : 'partial',
    revision: fingerprint(valuationSourceId, revisionFields),
  });
  return Object.freeze({ status: 'normalized', snapshot });
}

export function normalizeSharesightCashTransaction(
  transaction: SharesightCashAccountTransaction,
  context: SharesightContributionContext,
): SharesightContributionNormalization {
  if (
    transaction.cashAccountId !== context.cashAccountId ||
    transaction.linkedPortfolioId !== context.providerPortfolioId
  ) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_portfolio_mismatch',
    });
  }
  if (context.currencyCode !== 'EUR') {
    return Object.freeze({ status: 'quarantined', category: 'sharesight_non_eur_contribution' });
  }
  if (transaction.typeName !== 'DEPOSIT' && transaction.typeName !== 'WITHDRAWAL') {
    return Object.freeze({
      status: 'ignored',
      category: 'sharesight_non_principal_cash_transaction',
    });
  }
  const signedMinor = decimalToMinor(transaction.amount, 'Cash transaction amount');
  const direction = transaction.typeName === 'DEPOSIT' ? 'contribution' : 'withdrawal';
  const signConsistent = direction === 'contribution' ? signedMinor > 0n : signedMinor < 0n;
  if (!signConsistent) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_cash_direction_conflict',
    });
  }
  const providerContributionId = `${transaction.cashAccountId}:${transaction.id}`;
  const sourceId = `portfolio:${context.providerPortfolioId}:cash:${providerContributionId}`;
  const reference =
    transaction.foreignIdentifier !== null &&
    SAFE_REFERENCE_PATTERN.test(transaction.foreignIdentifier)
      ? transaction.foreignIdentifier
      : null;
  const evidence = createContributionEvidence({
    connection: context.connection,
    providerPortfolioId: context.providerPortfolioId,
    providerContributionId,
    effectiveAt: parseInstant(transaction.dateTime),
    amount: createMoney(signedMinor < 0n ? -signedMinor : signedMinor, EUR),
    direction,
    providerReference: reference,
    revision: fingerprint(sourceId, [
      transaction.dateTime,
      transaction.amount,
      transaction.balance,
      transaction.typeName,
      transaction.foreignIdentifier ?? '',
    ]),
  });
  return Object.freeze({ status: 'normalized', evidence });
}

export function normalizeSharesightTrade(
  trade: SharesightTrade,
  providerPortfolioId: string,
): SharesightTradeNormalization {
  if (trade.portfolioId !== providerPortfolioId) {
    return invalid('portfolio_mismatch', 'Trade belongs to a different portfolio.');
  }
  const providerTradeId = trade.id ?? trade.uniqueIdentifier;
  if (providerTradeId === null) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_trade_identity_unavailable',
    });
  }
  const sourceId = `portfolio:${providerPortfolioId}:trade:${providerTradeId}`;
  const evidence: SharesightTradeEvidence = Object.freeze({
    providerPortfolioId,
    providerTradeId,
    holdingId: trade.holdingId,
    transactionType: trade.transactionType,
    effectiveDate: trade.transactionDate,
    state: trade.state,
    value: canonicalDecimal(trade.value),
    brokerage: canonicalDecimal(trade.brokerage),
    brokerageCurrencyCode: trade.brokerageCurrencyCode,
    revision: fingerprint(sourceId, [
      trade.holdingId,
      trade.transactionType,
      trade.transactionDate,
      trade.state,
      trade.value,
      trade.brokerage,
      trade.brokerageCurrencyCode ?? '',
    ]),
  });
  return Object.freeze({ status: 'normalized', evidence });
}

export function normalizeSharesightPayout(
  payout: SharesightPayout,
  providerPortfolioId: string,
): SharesightPayoutNormalization {
  if (payout.portfolioId !== providerPortfolioId) {
    return invalid('portfolio_mismatch', 'Payout belongs to a different portfolio.');
  }
  if (payout.id === null) {
    return Object.freeze({
      status: 'quarantined',
      category: 'sharesight_payout_identity_unavailable',
    });
  }
  const sourceId = `portfolio:${providerPortfolioId}:payout:${payout.id}`;
  const evidence: SharesightPayoutEvidence = Object.freeze({
    providerPortfolioId,
    providerPayoutId: payout.id,
    holdingId: payout.holdingId,
    effectiveDate: payout.paidOn,
    state: payout.state,
    amount: canonicalDecimal(payout.amount),
    currencyCode: payout.currencyCode,
    revision: fingerprint(sourceId, [
      payout.holdingId,
      payout.paidOn,
      payout.state,
      payout.amount,
      payout.currencyCode,
    ]),
  });
  return Object.freeze({ status: 'normalized', evidence });
}

export function normalizeSharesightPerformance(
  performance: SharesightPerformance,
  providerPortfolioId: string,
  currencyCode: string,
  periodStart: string,
  periodEnd: string,
): ProviderProfitLoss | null {
  if (performance.portfolioId !== providerPortfolioId) {
    return invalid('portfolio_mismatch', 'Performance report belongs to a different portfolio.');
  }
  if (currencyCode !== 'EUR') return null;
  return Object.freeze({
    amount: createNativeReportableAmount(
      createMoney(decimalToMinor(performance.totalGain, 'Performance total gain'), EUR),
    ),
    semantics: 'period',
    periodStart: parseInstant(periodStart),
    periodEnd: parseInstant(periodEnd),
    fxBasis: 'provider_native',
    authority: 'reconciliation_only',
  });
}

function monthEnd(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createSharesightScanWindows(
  input: Readonly<{
    phase: SharesightScanPhase;
    portfolioId: string;
    resourceId: string;
    from: string;
    to: string;
  }>,
): readonly SharesightScanWindow[] {
  const from = parseDate(input.from, 'Scan start');
  const to = parseDate(input.to, 'Scan end');
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(`${to}T00:00:00.000Z`);
  if (start.getTime() > end.getTime()) {
    return invalid('invalid_scan_window', 'Scan start cannot follow scan end.');
  }
  const windows: SharesightScanWindow[] = [];
  let cursor = start;
  while (cursor.getTime() <= end.getTime()) {
    const naturalEnd = monthEnd(cursor.getUTCFullYear(), cursor.getUTCMonth());
    const windowEnd = naturalEnd.getTime() < end.getTime() ? naturalEnd : end;
    const windowFrom = formatDate(cursor);
    const windowTo = formatDate(windowEnd);
    windows.push(
      Object.freeze({
        phase: input.phase,
        portfolioId: input.portfolioId,
        resourceId: input.resourceId,
        from: windowFrom,
        to: windowTo,
        cursor: Object.freeze({
          kind: 'composite' as const,
          value: Object.freeze({
            source: 'sharesight-application-window',
            phase: input.phase,
            portfolioId: input.portfolioId,
            resourceId: input.resourceId,
            from: windowFrom,
            to: windowTo,
          }),
        }),
      }),
    );
    cursor = new Date(Date.UTC(windowEnd.getUTCFullYear(), windowEnd.getUTCMonth() + 1, 1));
  }
  return Object.freeze(windows);
}

const SHARESIGHT_CAPABILITIES: PortfolioCapabilities = createPortfolioCapabilities({
  total_market_value: true,
  brokerage_cash: true,
  holdings: true,
  holding_market_values: true,
  contributed_capital_total: false,
  contribution_history: true,
  provider_profit_loss: true,
  currency: true,
  fx_information: false,
  valuation_source_timestamp: false,
  incremental_cursor: false,
  historical_valuations: true,
  distributions: true,
  fees: true,
});

export const SHARESIGHT_PROVIDER_BINDING: SharesightProviderBinding = Object.freeze({
  provider: SHARESIGHT_PROVIDER_ID,
  version: SHARESIGHT_BINDING_VERSION,
  api: Object.freeze({
    stableVersion: 'v2',
    valuationVersion: 'v2.1',
    unstableVersionExcluded: 'v3',
  }),
  authentication: Object.freeze({
    selectedGrant: 'client_credentials',
    authorizationCodeDocumented: true,
    accessTokenLifetimeSeconds: 1800,
    publishedScopes: 'UNAVAILABLE',
  }),
  limits: Object.freeze({ requestsPerMinute: 360, concurrentReportRequests: 3 }),
  capabilities: SHARESIGHT_CAPABILITIES,
  fieldClassifications: Object.freeze({
    portfolioAccountId: 'DIRECT',
    authoritativePortfolioTotal: 'DIRECT',
    brokerageCash: 'DIRECT',
    holdings: 'DIRECT',
    holdingMarketValues: 'DIRECT',
    contributionEvidence: 'DIRECT',
    confirmedContributionPrincipal: 'UNAVAILABLE',
    sourceAsOf: 'DERIVED',
    revision: 'DERIVED',
    scanContinuation: 'DERIVED',
    contributedCapitalTotal: 'UNAVAILABLE',
    providerRevision: 'UNAVAILABLE',
    providerCursor: 'UNAVAILABLE',
    webhook: 'UNAVAILABLE',
    exactValuationTimestamp: 'UNAVAILABLE',
    oauthScopes: 'UNAVAILABLE',
    lightyearImportFreshness: 'AMBIGUOUS',
    deletionTombstones: 'AMBIGUOUS',
    feeTreatment: 'AMBIGUOUS',
    distributionDestination: 'AMBIGUOUS',
    fxProvenance: 'AMBIGUOUS',
    brokerageSettlementState: 'AMBIGUOUS',
  }),
  endpoints: Object.freeze({
    portfolios: 'GET /api/v2/portfolios.json',
    valuation: 'GET /api/v2.1/portfolios/:id/valuation.json',
    cashAccounts: 'GET /api/v2/portfolios/:id/cash_accounts.json',
    cashTransactions: 'GET /api/v2/cash_accounts/:id/cash_account_transactions.json',
    trades: 'GET /api/v2/portfolios/:id/trades.json',
    performance: 'GET /api/v2/portfolios/:id/performance.json',
    payouts: 'GET /api/v2/portfolios/:id/payouts.json',
  }),
});
