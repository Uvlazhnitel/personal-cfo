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
  PORTFOLIO_MANAGER_BINDING_VERSION,
  PORTFOLIO_MANAGER_CONTRACT_VERSION,
  PORTFOLIO_MANAGER_PROVIDER_ID,
  type PortfolioManagerCapabilities,
  type PortfolioManagerCapitalFlow,
  type PortfolioManagerCapitalFlowNormalization,
  type PortfolioManagerCapitalFlowObservation,
  type PortfolioManagerCapitalFlowPage,
  type PortfolioManagerCapabilityDto,
  type PortfolioManagerExactDecimal,
  type PortfolioManagerHolding,
  type PortfolioManagerHoldingEvidence,
  type PortfolioManagerIdentity,
  type PortfolioManagerProviderBinding,
  type PortfolioManagerSnapshot,
  type PortfolioManagerSnapshotContext,
  type PortfolioManagerSnapshotNormalization,
} from './types.js';

const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const SHA256_FINGERPRINT_PATTERN = /^sha256:([a-f0-9]{64})$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,2048}$/u;
const CAPITAL_FLOW_FINGERPRINT_VERSION = 'portfolio-manager-capital-flow-revision-v1';

type UnknownRecord = Record<string, unknown>;

function invalid(code: string, message: string): never {
  throw new DomainValidationError(`portfolio_manager_binding.${code}`, message);
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

function string(value: unknown, label: string, maximum = 512): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value
  ) {
    return invalid('invalid_string', `${label} must be a bounded non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string, maximum = 512): string | null {
  return value === null ? null : string(value, label, maximum);
}

function identity(value: unknown, label: string): string {
  const parsed = string(value, label, 256);
  if (!IDENTITY_PATTERN.test(parsed)) {
    return invalid('invalid_identity', `${label} must be a stable provider identifier.`);
  }
  return parsed;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') return invalid('invalid_boolean', `${label} must be boolean.`);
  return value;
}

function instant(value: unknown, label: string) {
  if (typeof value !== 'string') return invalid('invalid_instant', `${label} must be UTC time.`);
  try {
    return parseInstant(value);
  } catch {
    return invalid('invalid_instant', `${label} must be a valid UTC instant.`);
  }
}

function nullableInstant(value: unknown, label: string) {
  return value === null ? null : instant(value, label);
}

function currency(value: unknown, label: string): string {
  const parsed = string(value, label, 3);
  if (!CURRENCY_PATTERN.test(parsed)) {
    return invalid('invalid_currency', `${label} must be an uppercase ISO currency code.`);
  }
  return parsed;
}

function exactDecimal(value: unknown, label: string): PortfolioManagerExactDecimal {
  if (typeof value !== 'string' || value.length > 512 || !DECIMAL_PATTERN.test(value)) {
    return invalid('invalid_decimal', `${label} must be an exact non-exponent decimal string.`);
  }
  return value as PortfolioManagerExactDecimal;
}

function nullableExactDecimal(value: unknown, label: string): PortfolioManagerExactDecimal | null {
  return value === null ? null : exactDecimal(value, label);
}

function nonNegativeDecimal(value: unknown, label: string): PortfolioManagerExactDecimal {
  const parsed = exactDecimal(value, label);
  if (parsed.startsWith('-')) return invalid('negative_value', `${label} cannot be negative.`);
  return parsed;
}

function nullableNonNegativeDecimal(
  value: unknown,
  label: string,
): PortfolioManagerExactDecimal | null {
  return value === null ? null : nonNegativeDecimal(value, label);
}

function parseJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson) as unknown;
  } catch {
    return invalid('invalid_json', 'Portfolio Manager payload must be valid JSON.');
  }
}

function parseIdentity(value: UnknownRecord): PortfolioManagerIdentity {
  if (value['contractVersion'] !== PORTFOLIO_MANAGER_CONTRACT_VERSION) {
    return invalid(
      'unsupported_contract_version',
      'Portfolio Manager contract version is unsupported.',
    );
  }
  if (value['provider'] !== PORTFOLIO_MANAGER_PROVIDER_ID) {
    return invalid('provider_mismatch', 'Portfolio Manager provider identity is invalid.');
  }
  const providerInstanceId = identity(value['providerInstanceId'], 'Provider instance ID');
  const portfolioId = identity(value['portfolioId'], 'Portfolio ID');
  if (providerInstanceId !== portfolioId) {
    return invalid(
      'portfolio_identity_mismatch',
      'Portfolio Manager v1 instance and portfolio IDs must match.',
    );
  }
  return Object.freeze({
    contractVersion: PORTFOLIO_MANAGER_CONTRACT_VERSION,
    provider: PORTFOLIO_MANAGER_PROVIDER_ID,
    providerInstanceId,
    portfolioId,
  });
}

const CAPABILITY_KEYS = Object.freeze([
  'totalMarketValue',
  'holdings',
  'holdingMarketValues',
  'cashIncludedInValuation',
  'contributionWithdrawalHistory',
  'reportingCurrency',
  'sourceFreshnessTimestamps',
  'deterministicIncrementalCapitalFlowCursor',
  'revisionsCorrections',
  'pnl',
  'historicalValuations',
  'distributions',
  'fees',
  'fxInformation',
] as const);

function parseCapabilities(value: unknown): PortfolioManagerCapabilityDto {
  const item = record(value, 'Capabilities');
  return Object.freeze(
    Object.fromEntries(
      CAPABILITY_KEYS.map((key) => [key, boolean(item[key], `Capability ${key}`)]),
    ) as unknown as PortfolioManagerCapabilityDto,
  );
}

export function decodePortfolioManagerCapabilities(rawJson: string): PortfolioManagerCapabilities {
  const root = record(parseJson(rawJson), 'Capabilities response');
  return Object.freeze({
    ...parseIdentity(root),
    capabilities: parseCapabilities(root['capabilities']),
  });
}

function parseHolding(value: unknown): PortfolioManagerHolding {
  const item = record(value, 'Holding');
  return Object.freeze({
    providerHoldingId: identity(item['providerHoldingId'], 'Holding ID'),
    accountId: identity(item['accountId'], 'Holding account ID'),
    assetId: identity(item['assetId'], 'Holding asset ID'),
    symbol: string(item['symbol'], 'Holding symbol', 128),
    name: string(item['name'], 'Holding name', 256),
    assetClass: string(item['assetClass'], 'Holding asset class', 64),
    assetType: string(item['assetType'], 'Holding asset type', 64),
    quantity: exactDecimal(item['quantity'], 'Holding quantity'),
    currentMarketValue: nullableNonNegativeDecimal(
      item['currentMarketValue'],
      'Holding market value',
    ),
    price: nullableNonNegativeDecimal(item['price'], 'Holding price'),
    priceCurrency:
      item['priceCurrency'] === null ? null : currency(item['priceCurrency'], 'Price currency'),
    priceSource: nullableString(item['priceSource'], 'Price source', 128),
    priceTimestamp: nullableInstant(item['priceTimestamp'], 'Price timestamp'),
    isPriceStale: boolean(item['isPriceStale'], 'Holding stale flag'),
  });
}

function parseCompleteness(value: unknown, label: string): 'complete' | 'partial' | 'unavailable' {
  if (value !== 'complete' && value !== 'partial' && value !== 'unavailable') {
    return invalid('invalid_completeness', `${label} completeness is unsupported.`);
  }
  return value;
}

export function decodePortfolioManagerSnapshot(rawJson: string): PortfolioManagerSnapshot {
  const root = record(parseJson(rawJson), 'Snapshot response');
  const valuation = record(root['valuation'], 'Valuation');
  const cash = record(root['cash'], 'Cash');
  const holdings = record(root['holdings'], 'Holdings');
  const status = parseCompleteness(valuation['status'], 'Valuation');
  const totalValue = nullableNonNegativeDecimal(valuation['totalValue'], 'Valuation total');
  if ((status === 'complete') !== (totalValue !== null)) {
    return invalid(
      'valuation_total_mismatch',
      'Only a complete valuation may carry an authoritative total.',
    );
  }
  if (valuation['sourceAsOfSemantics'] !== 'oldest_component_quote') {
    return invalid('invalid_freshness_semantics', 'Valuation freshness semantics are unsupported.');
  }
  if (cash['treatment'] !== 'included_in_total') {
    return invalid('invalid_cash_treatment', 'Portfolio Manager cash must be included in total.');
  }
  const parsedHoldings = Object.freeze(array(holdings['items'], 'Holding items').map(parseHolding));
  const holdingIds = new Set(parsedHoldings.map((item) => item.providerHoldingId));
  if (holdingIds.size !== parsedHoldings.length) {
    return invalid('duplicate_holding', 'Snapshot holding identities must be unique.');
  }
  const missingPriceSymbols = Object.freeze(
    array(valuation['missingPriceSymbols'], 'Missing price symbols').map((item) =>
      string(item, 'Missing price symbol', 128),
    ),
  );
  return Object.freeze({
    ...parseIdentity(root),
    generatedAt: instant(root['generatedAt'], 'Snapshot generated time'),
    reportingCurrency: currency(root['reportingCurrency'], 'Reporting currency'),
    valuation: Object.freeze({
      status,
      totalValue,
      knownValuedSubtotal: nonNegativeDecimal(
        valuation['knownValuedSubtotal'],
        'Known valued subtotal',
      ),
      missingPriceSymbols,
      hasStalePrices: boolean(valuation['hasStalePrices'], 'Valuation stale flag'),
      sourceAsOf: nullableInstant(valuation['sourceAsOf'], 'Valuation source time'),
      sourceAsOfSemantics: 'oldest_component_quote',
    }),
    cash: Object.freeze({
      treatment: 'included_in_total',
      amount: nullableNonNegativeDecimal(cash['amount'], 'Cash amount'),
      currency: currency(cash['currency'], 'Cash currency'),
    }),
    holdings: Object.freeze({
      completeness: parseCompleteness(holdings['completeness'], 'Holdings'),
      items: parsedHoldings,
    }),
  });
}

function parseCapitalFlowStatus(value: unknown): 'ACTIVE' | 'REPLACED' | 'VOIDED' {
  if (value !== 'ACTIVE' && value !== 'REPLACED' && value !== 'VOIDED') {
    return invalid('invalid_capital_flow_status', 'Capital-flow status is unsupported.');
  }
  return value;
}

function parseDirection(value: unknown): 'contribution' | 'withdrawal' {
  if (value !== 'contribution' && value !== 'withdrawal') {
    return invalid('invalid_capital_flow_direction', 'Capital-flow direction is unsupported.');
  }
  return value;
}

function parseUnavailableReason(value: unknown): 'MISSING_OR_NON_POSITIVE_ORIGINAL_AMOUNT' | null {
  if (value === null) return null;
  if (value !== 'MISSING_OR_NON_POSITIVE_ORIGINAL_AMOUNT') {
    return invalid('invalid_amount_reason', 'Capital-flow amount reason is unsupported.');
  }
  return value;
}

function parseFingerprint(value: unknown): string {
  const parsed = string(value, 'Revision fingerprint', 71);
  if (!SHA256_FINGERPRINT_PATTERN.test(parsed)) {
    return invalid('invalid_fingerprint', 'Revision fingerprint must be lowercase SHA-256.');
  }
  return parsed;
}

function parseCapitalFlow(value: unknown): PortfolioManagerCapitalFlow {
  const item = record(value, 'Capital flow');
  const amount = nullableExactDecimal(item['amount'], 'Capital-flow amount');
  const amountUnavailableReason = parseUnavailableReason(item['amountUnavailableReason']);
  if ((amount === null) !== (amountUnavailableReason !== null)) {
    return invalid(
      'amount_availability_mismatch',
      'Capital-flow amount availability is inconsistent.',
    );
  }
  if (amount !== null && (amount.startsWith('-') || !/[1-9]/u.test(amount))) {
    return invalid('non_positive_amount', 'Capital-flow amount must be a positive magnitude.');
  }
  const replacementRevisionIds = Object.freeze(
    array(item['replacementRevisionIds'], 'Replacement revision IDs').map((entry) =>
      identity(entry, 'Replacement revision ID'),
    ),
  );
  if (new Set(replacementRevisionIds).size !== replacementRevisionIds.length) {
    return invalid('duplicate_replacement', 'Replacement revision IDs must be unique.');
  }
  const sorted = [...replacementRevisionIds].sort();
  if (sorted.some((entry, index) => entry !== replacementRevisionIds[index])) {
    return invalid('unsorted_replacements', 'Replacement revision IDs must be sorted.');
  }
  return Object.freeze({
    eventId: identity(item['eventId'], 'Capital-flow event ID'),
    revisionId: identity(item['revisionId'], 'Capital-flow revision ID'),
    sourceTransactionId: identity(item['sourceTransactionId'], 'Source transaction ID'),
    status: parseCapitalFlowStatus(item['status']),
    direction: parseDirection(item['direction']),
    accountId: identity(item['accountId'], 'Capital-flow account ID'),
    assetId: identity(item['assetId'], 'Capital-flow asset ID'),
    amount,
    amountUnavailableReason,
    currency: currency(item['currency'], 'Capital-flow currency'),
    effectiveAt: instant(item['effectiveAt'], 'Capital-flow effective time'),
    changedAt: instant(item['changedAt'], 'Capital-flow changed time'),
    replacesRevisionId:
      item['replacesRevisionId'] === null
        ? null
        : identity(item['replacesRevisionId'], 'Replaced revision ID'),
    replacementRevisionIds,
    revisionFingerprint: parseFingerprint(item['revisionFingerprint']),
  });
}

function cursor(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !CURSOR_PATTERN.test(value)) {
    return invalid('invalid_cursor', `${label} must be a bounded opaque base64url cursor.`);
  }
  return value;
}

export function decodePortfolioManagerCapitalFlows(
  rawJson: string,
): PortfolioManagerCapitalFlowPage {
  const root = record(parseJson(rawJson), 'Capital-flow response');
  const items = Object.freeze(array(root['items'], 'Capital flows').map(parseCapitalFlow));
  const revisionIds = new Set(items.map((item) => item.revisionId));
  if (revisionIds.size !== items.length) {
    return invalid('duplicate_revision', 'A capital-flow page cannot repeat a revision ID.');
  }
  const hasMore = boolean(root['hasMore'], 'Capital-flow hasMore');
  const nextCursor = cursor(root['nextCursor'], 'Capital-flow next cursor');
  if (hasMore && nextCursor === null) {
    return invalid('missing_continuation', 'A continued capital-flow page requires a cursor.');
  }
  return Object.freeze({ ...parseIdentity(root), items, hasMore, nextCursor });
}

export function assertPortfolioManagerIdentity(
  expected: PortfolioManagerIdentity,
  actual: PortfolioManagerIdentity,
): void {
  if (
    expected.contractVersion !== actual.contractVersion ||
    expected.provider !== actual.provider ||
    expected.providerInstanceId !== actual.providerInstanceId ||
    expected.portfolioId !== actual.portfolioId
  ) {
    invalid('identity_changed', 'Portfolio Manager identity changed during synchronization.');
  }
}

export const PORTFOLIO_MANAGER_CAPABILITIES: PortfolioCapabilities = createPortfolioCapabilities({
  total_market_value: true,
  brokerage_cash: true,
  holdings: true,
  holding_market_values: true,
  contributed_capital_total: false,
  contribution_history: true,
  provider_profit_loss: false,
  currency: true,
  fx_information: false,
  valuation_source_timestamp: true,
  incremental_cursor: true,
  historical_valuations: false,
  distributions: false,
  fees: false,
});

export function validatePortfolioManagerCapabilities(
  response: PortfolioManagerCapabilities,
): PortfolioCapabilities {
  const expected: PortfolioManagerCapabilityDto = {
    totalMarketValue: true,
    holdings: true,
    holdingMarketValues: true,
    cashIncludedInValuation: true,
    contributionWithdrawalHistory: true,
    reportingCurrency: true,
    sourceFreshnessTimestamps: true,
    deterministicIncrementalCapitalFlowCursor: true,
    revisionsCorrections: true,
    pnl: false,
    historicalValuations: false,
    distributions: false,
    fees: false,
    fxInformation: false,
  };
  for (const key of CAPABILITY_KEYS) {
    if (response.capabilities[key] !== expected[key]) {
      invalid('incompatible_capabilities', `Portfolio Manager capability ${key} is incompatible.`);
    }
  }
  return PORTFOLIO_MANAGER_CAPABILITIES;
}

export const PORTFOLIO_MANAGER_BINDING: PortfolioManagerProviderBinding = Object.freeze({
  provider: PORTFOLIO_MANAGER_PROVIDER_ID,
  version: PORTFOLIO_MANAGER_BINDING_VERSION,
  contractVersion: PORTFOLIO_MANAGER_CONTRACT_VERSION,
  endpoints: Object.freeze({
    capabilities: '/api/integrations/personal-cfo/v1/capabilities',
    snapshot: '/api/integrations/personal-cfo/v1/snapshot',
    capitalFlows: '/api/integrations/personal-cfo/v1/capital-flows',
  }),
  authentication: Object.freeze({ kind: 'bearer' }),
  capitalFlowPageSize: 500,
  capabilities: PORTFOLIO_MANAGER_CAPABILITIES,
});

function decimalParts(value: PortfolioManagerExactDecimal): Readonly<{
  negative: boolean;
  whole: string;
  fraction: string;
}> {
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  return { negative, whole, fraction };
}

export function portfolioManagerDecimalToMinorHalfEven(
  value: PortfolioManagerExactDecimal,
  scale = 2,
): bigint {
  const { negative, whole, fraction } = decimalParts(value);
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const discarded = fraction.slice(scale);
  let magnitude = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept || '0');
  if (discarded.length > 0) {
    const first = discarded[0]!;
    const remainingNonZero = /[1-9]/u.test(discarded.slice(1));
    const roundUp = first > '5' || (first === '5' && (remainingNonZero || magnitude % 2n !== 0n));
    if (roundUp) magnitude += 1n;
  }
  return negative ? -magnitude : magnitude;
}

export function portfolioManagerDecimalToExactMinor(
  value: PortfolioManagerExactDecimal,
  scale = 2,
): bigint | null {
  const { negative, whole, fraction } = decimalParts(value);
  const discarded = fraction.slice(scale);
  if (/[1-9]/u.test(discarded)) return null;
  const kept = fraction.slice(0, scale).padEnd(scale, '0');
  const magnitude = BigInt(whole) * 10n ** BigInt(scale) + BigInt(kept || '0');
  return negative ? -magnitude : magnitude;
}

function sha256(fields: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex');
}

function revision(sourceId: string, fields: readonly unknown[]): ProviderRevisionIdentity {
  return createProviderRevisionIdentity({
    sourceId,
    version: { kind: 'sha256_fingerprint', value: sha256(fields) },
  });
}

function reportable(value: PortfolioManagerExactDecimal) {
  return createNativeReportableAmount(
    createMoney(portfolioManagerDecimalToMinorHalfEven(value), EUR),
  );
}

function holdingEvidence(holding: PortfolioManagerHolding): PortfolioManagerHoldingEvidence {
  return Object.freeze({
    ...holding,
    revision: revision(`holding:${holding.providerHoldingId}`, [
      PORTFOLIO_MANAGER_BINDING_VERSION,
      holding.providerHoldingId,
      holding.accountId,
      holding.assetId,
      holding.symbol,
      holding.name,
      holding.assetClass,
      holding.assetType,
      holding.quantity,
      holding.currentMarketValue,
      holding.price,
      holding.priceCurrency,
      holding.priceSource,
      holding.priceTimestamp,
      holding.isPriceStale,
    ]),
  });
}

export function normalizePortfolioManagerSnapshot(
  providerSnapshot: PortfolioManagerSnapshot,
  context: PortfolioManagerSnapshotContext,
): PortfolioManagerSnapshotNormalization {
  if (providerSnapshot.reportingCurrency !== 'EUR' || providerSnapshot.cash.currency !== 'EUR') {
    return Object.freeze({
      status: 'quarantined',
      category: 'portfolio_manager_non_eur_reporting_currency',
    });
  }
  const fallbackSourceTime = providerSnapshot.valuation.sourceAsOf === null;
  const sourceAsOf = providerSnapshot.valuation.sourceAsOf ?? providerSnapshot.generatedAt;
  const staleAt = providerSnapshot.valuation.hasStalePrices ? sourceAsOf : context.freshStaleAt;
  const evidence = Object.freeze(providerSnapshot.holdings.items.map(holdingEvidence));
  const normalizedHoldings = evidence
    .filter((holding) => holding.assetClass !== 'CASH')
    .map((holding) =>
      Object.freeze({
        providerHoldingId: holding.providerHoldingId,
        providerSecurityId: holding.assetId,
        instrumentName: holding.name,
        symbol: holding.symbol,
        quantity: parseDecimalRate(holding.quantity),
        marketValue:
          holding.currentMarketValue === null ? null : reportable(holding.currentMarketValue),
        sourceAsOf: holding.priceTimestamp,
        revision: holding.revision,
      }),
    );
  const providerTotal =
    providerSnapshot.valuation.totalValue === null
      ? null
      : reportable(providerSnapshot.valuation.totalValue);
  const sourceCompleteness =
    providerSnapshot.valuation.status === 'unavailable'
      ? 'unavailable'
      : providerSnapshot.valuation.status !== 'complete' || fallbackSourceTime
        ? 'partial'
        : 'complete';
  const warnings = [
    ...(sourceCompleteness === 'complete' ? [] : (['source_incomplete'] as const)),
    ...(providerSnapshot.holdings.completeness === 'complete'
      ? []
      : (['holdings_incomplete'] as const)),
    ...(providerTotal === null ? (['missing_valuation'] as const) : []),
  ];
  const snapshot = createPortfolioSnapshot({
    ownerId: context.ownerId,
    accountId: context.accountId,
    connection: {
      provider: PORTFOLIO_MANAGER_PROVIDER_ID,
      connectionId: context.connectionId,
    },
    providerPortfolioId: providerSnapshot.portfolioId,
    sourceAsOf,
    receivedAt: context.receivedAt,
    staleAt,
    providerReportedMarketValue: providerTotal,
    knownValuedSubtotal: reportable(providerSnapshot.valuation.knownValuedSubtotal),
    totalMarketValue: providerTotal,
    cash: {
      treatment: 'included_in_total',
      amount:
        providerSnapshot.cash.amount === null ? null : reportable(providerSnapshot.cash.amount),
    },
    netWorthProjection:
      providerTotal === null
        ? { kind: 'unavailable', reason: 'missing_valuation' }
        : {
            kind: 'single_investment_account',
            investmentAccountId: context.accountId,
            value: providerTotal,
          },
    contributedCapital: null,
    holdings: {
      completeness: providerSnapshot.holdings.completeness,
      items: normalizedHoldings,
    },
    sourceCompleteness,
    revision: revision(`snapshot:${providerSnapshot.portfolioId}`, [
      PORTFOLIO_MANAGER_BINDING_VERSION,
      providerSnapshot,
    ]),
  });
  return Object.freeze({
    status: 'normalized',
    snapshot,
    holdings: evidence,
    warnings: Object.freeze(warnings),
  });
}

function expectedCapitalFlowFingerprint(flow: PortfolioManagerCapitalFlow): string {
  const providerTimestamp = (value: string): string => new Date(value).toISOString();
  return `sha256:${sha256([
    CAPITAL_FLOW_FINGERPRINT_VERSION,
    flow.eventId,
    flow.revisionId,
    flow.status,
    flow.direction,
    flow.amount,
    flow.amountUnavailableReason,
    flow.currency,
    flow.accountId,
    flow.assetId,
    providerTimestamp(flow.effectiveAt),
    providerTimestamp(flow.changedAt),
    flow.replacesRevisionId,
    flow.replacementRevisionIds,
  ])}`;
}

export function normalizePortfolioManagerCapitalFlow(
  flow: PortfolioManagerCapitalFlow,
  context: Readonly<{
    connectionId: string;
    providerInstanceId: string;
    providerPortfolioId: string;
  }>,
): PortfolioManagerCapitalFlowNormalization {
  const expectedFingerprint = expectedCapitalFlowFingerprint(flow);
  if (flow.revisionFingerprint !== expectedFingerprint) {
    return invalid('fingerprint_mismatch', 'Capital-flow revision fingerprint is invalid.');
  }
  const providerRevision = createProviderRevisionIdentity({
    sourceId: `capital-flow:${flow.eventId}`,
    version: {
      kind: 'sha256_fingerprint',
      value: expectedFingerprint.slice('sha256:'.length),
    },
  });
  const observation: PortfolioManagerCapitalFlowObservation = Object.freeze({
    providerPortfolioId: context.providerPortfolioId,
    providerInstanceId: context.providerInstanceId,
    eventId: flow.eventId,
    revisionId: flow.revisionId,
    sourceTransactionId: flow.sourceTransactionId,
    status: flow.status,
    direction: flow.direction,
    accountId: flow.accountId,
    assetId: flow.assetId,
    exactAmount: flow.amount,
    amountUnavailableReason: flow.amountUnavailableReason,
    currency: flow.currency,
    effectiveAt: flow.effectiveAt,
    changedAt: flow.changedAt,
    replacesRevisionId: flow.replacesRevisionId,
    replacementRevisionIds: flow.replacementRevisionIds,
    revision: providerRevision,
  });
  if (flow.status !== 'ACTIVE') {
    return Object.freeze({ status: 'normalized', observation, evidence: null });
  }
  if (flow.amount === null) {
    return Object.freeze({
      status: 'quarantined',
      observation,
      category: 'portfolio_manager_amount_unavailable',
    });
  }
  if (flow.currency !== 'EUR') {
    return Object.freeze({
      status: 'quarantined',
      observation,
      category: 'portfolio_manager_non_eur_contribution',
    });
  }
  const amountMinor = portfolioManagerDecimalToExactMinor(flow.amount);
  if (amountMinor === null) {
    return Object.freeze({
      status: 'quarantined',
      observation,
      category: 'portfolio_manager_subminor_contribution',
    });
  }
  const evidence = createContributionEvidence({
    connection: {
      provider: PORTFOLIO_MANAGER_PROVIDER_ID,
      connectionId: context.connectionId,
    },
    providerPortfolioId: context.providerPortfolioId,
    providerContributionId: flow.eventId,
    effectiveAt: flow.effectiveAt,
    amount: createMoney(amountMinor, EUR),
    direction: flow.direction,
    providerReference: flow.revisionId,
    revision: providerRevision,
  });
  return Object.freeze({ status: 'normalized', observation, evidence });
}
