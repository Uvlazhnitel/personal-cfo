import {
  DomainValidationError,
  addMoney,
  compareInstants,
  createMoney,
  createReportableAmount,
  parseAccountId,
  parseCompleteness,
  parseDecimalRate,
  parseDomainId,
  parseInstant,
  subtractMoney,
} from '@personal-cfo/domain';
import type { Money, ReportableAmount } from '@personal-cfo/domain';

import {
  PORTFOLIO_CAPABILITIES,
  PORTFOLIO_WARNING_CODES,
  type ConfirmedContributionPrincipal,
  type ContributionEvidence,
  type ContributionMatch,
  type ContributionMatchEvidence,
  type HoldingsReconciliation,
  type MarketMovementReconciliation,
  type NormalizedHolding,
  type PortfolioCapabilities,
  type PortfolioCash,
  type PortfolioConnectionIdentity,
  type PortfolioCursor,
  type PortfolioNetWorthProjection,
  type PortfolioReadiness,
  type PortfolioReadinessEvidence,
  type PortfolioSnapshot,
  type PortfolioWarningCode,
  type ProviderRevisionIdentity,
} from './types.js';

export const PORTFOLIO_CONTRACT_VERSION = 'portfolio-contract-v1';
export const PORTFOLIO_RAW_PAYLOAD_RETENTION_DAYS = 30;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

function invalid(code: string, message: string): never {
  throw new DomainValidationError(`portfolio_contract.${code}`, message);
}

function parseIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTITY_PATTERN.test(value)) {
    return invalid('invalid_identity', `${label} must be a bounded stable identifier.`);
  }
  return value;
}

function parseOptionalLabel(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    return invalid('invalid_label', `${label} must be null or a non-empty bounded string.`);
  }
  return value;
}

function sameMoney(left: Money, right: Money): boolean {
  return left.currency === right.currency && left.amountMinor === right.amountMinor;
}

function sameReportable(left: ReportableAmount, right: ReportableAmount): boolean {
  if (left.status !== right.status || !sameMoney(left.original, right.original)) return false;
  if (left.status === 'missing_fx' || right.status === 'missing_fx') return true;
  return sameMoney(left.reporting, right.reporting) && left.fxRateId === right.fxRateId;
}

function reportingMoney(value: ReportableAmount): Money | null {
  return value.status === 'available' ? value.reporting : null;
}

function sumMoney(values: readonly Money[], currency: Money['currency']): Money {
  return values.reduce((total, value) => addMoney(total, value), createMoney(0n, currency));
}

function addReportableForEconomicTotal(
  left: ReportableAmount,
  right: ReportableAmount,
): Readonly<{ original: Money; reporting: Money | null }> {
  if (left.original.currency !== right.original.currency) {
    return invalid(
      'component_currency_mismatch',
      'Portfolio value and brokerage cash must have the same original currency.',
    );
  }

  const original = addMoney(left.original, right.original);
  const leftReporting = reportingMoney(left);
  const rightReporting = reportingMoney(right);
  if (leftReporting === null || rightReporting === null) return { original, reporting: null };
  return { original, reporting: addMoney(leftReporting, rightReporting) };
}

export function createPortfolioCapabilities(
  input: Readonly<Record<string, unknown>>,
): PortfolioCapabilities {
  const actualKeys = Object.keys(input).sort();
  const expectedKeys = [...PORTFOLIO_CAPABILITIES].sort();
  if (actualKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
    return invalid(
      'invalid_capabilities',
      'Portfolio capabilities must explicitly include every supported capability key.',
    );
  }

  const entries = PORTFOLIO_CAPABILITIES.map((capability) => {
    const supported = input[capability];
    if (typeof supported !== 'boolean') {
      return invalid('invalid_capability', `${capability} capability must be boolean.`);
    }
    return [capability, supported] as const;
  });
  return Object.freeze(Object.fromEntries(entries) as Record<(typeof entries)[number][0], boolean>);
}

export function createPortfolioConnectionIdentity(
  input: PortfolioConnectionIdentity,
): PortfolioConnectionIdentity {
  return Object.freeze({
    provider: parseIdentity(input.provider, 'Provider'),
    connectionId: parseIdentity(input.connectionId, 'Connection'),
  });
}

export function createProviderRevisionIdentity(
  input: ProviderRevisionIdentity,
): ProviderRevisionIdentity {
  const sourceId = parseIdentity(input.sourceId, 'Source');
  if (input.version.kind !== 'provider_revision' && input.version.kind !== 'sha256_fingerprint') {
    return invalid('invalid_revision', 'Provider revision kind is unsupported.');
  }
  if (input.version.kind === 'sha256_fingerprint') {
    if (!SHA256_PATTERN.test(input.version.value)) {
      return invalid('invalid_fingerprint', 'A source fingerprint must be lowercase SHA-256 hex.');
    }
    return Object.freeze({
      sourceId,
      version: Object.freeze({ kind: input.version.kind, value: input.version.value }),
    });
  }
  return Object.freeze({
    sourceId,
    version: Object.freeze({
      kind: input.version.kind,
      value: parseIdentity(input.version.value, 'Provider revision'),
    }),
  });
}

function createPortfolioCash(input: PortfolioCash): PortfolioCash {
  if (
    input.treatment !== 'included_in_total' &&
    input.treatment !== 'excluded_from_total' &&
    input.treatment !== 'unavailable'
  ) {
    return invalid('invalid_cash', 'Brokerage cash treatment is unsupported.');
  }
  if (input.treatment === 'unavailable') {
    if (input.amount !== null) return invalid('invalid_cash', 'Unavailable cash has no amount.');
    return Object.freeze({ treatment: input.treatment, amount: null });
  }
  if (input.treatment === 'excluded_from_total') {
    return Object.freeze({
      treatment: input.treatment,
      amount: createReportableAmount(input.amount),
    });
  }
  return Object.freeze({
    treatment: input.treatment,
    amount: input.amount === null ? null : createReportableAmount(input.amount),
  });
}

function validateEconomicTotal(
  providerValue: ReportableAmount,
  total: ReportableAmount | null,
  cash: PortfolioCash,
): void {
  if (cash.treatment === 'unavailable') {
    if (total !== null) {
      invalid(
        'unknown_cash_has_total',
        'Unknown cash treatment cannot produce a total economic value.',
      );
    }
    return;
  }
  if (total === null)
    invalid('missing_total', 'Known cash treatment requires a total economic value.');
  if (cash.treatment === 'included_in_total') {
    if (!sameReportable(providerValue, total)) {
      invalid(
        'included_cash_total_mismatch',
        'An included-cash total must equal the provider total.',
      );
    }
    return;
  }

  const expected = addReportableForEconomicTotal(providerValue, cash.amount);
  if (!sameMoney(expected.original, total.original)) {
    invalid(
      'excluded_cash_total_mismatch',
      'Total economic value must include excluded brokerage cash.',
    );
  }
  const totalReporting = reportingMoney(total);
  if (
    (expected.reporting === null && totalReporting !== null) ||
    (expected.reporting !== null &&
      (totalReporting === null || !sameMoney(expected.reporting, totalReporting)))
  ) {
    invalid(
      'excluded_cash_reporting_mismatch',
      'Reporting total must exactly include brokerage cash.',
    );
  }
}

function createProjection(
  input: PortfolioNetWorthProjection,
  accountId: PortfolioSnapshot['accountId'],
  providerValue: ReportableAmount,
  total: ReportableAmount | null,
  cash: PortfolioCash,
): PortfolioNetWorthProjection {
  if (input.kind === 'unavailable') {
    if (cash.treatment !== 'unavailable' && total?.status !== 'missing_fx') {
      return invalid(
        'unnecessary_unavailable_projection',
        'Available EUR value needs a projection.',
      );
    }
    const expectedReason =
      cash.treatment === 'unavailable' ? 'cash_treatment_unknown' : 'fx_unavailable';
    if (input.reason !== expectedReason) {
      return invalid(
        'projection_reason_mismatch',
        'Unavailable projection reason is inconsistent.',
      );
    }
    return Object.freeze({ kind: input.kind, reason: input.reason });
  }
  if (total === null || total.status === 'missing_fx') {
    return invalid(
      'invalid_available_projection',
      'A projection requires an available economic total.',
    );
  }
  if (parseAccountId(input.investmentAccountId) !== accountId) {
    return invalid('projection_account_mismatch', 'Projection must target the snapshot account.');
  }
  if (input.kind === 'single_investment_account') {
    const value = createReportableAmount(input.value);
    if (!sameReportable(value, total)) {
      return invalid(
        'projection_total_mismatch',
        'Single-account projection must use the economic total.',
      );
    }
    return Object.freeze({ kind: input.kind, investmentAccountId: accountId, value });
  }
  if (cash.treatment !== 'excluded_from_total') {
    return invalid(
      'invalid_split_projection',
      'Only excluded cash can use a separate cash account.',
    );
  }
  const cashAccountId = parseAccountId(input.cashAccountId);
  if (cashAccountId === accountId) {
    return invalid('cash_account_collision', 'Investment and brokerage cash accounts must differ.');
  }
  const investmentValue = createReportableAmount(input.investmentValue);
  const cashValue = createReportableAmount(input.cashValue);
  if (!sameReportable(investmentValue, providerValue) || !sameReportable(cashValue, cash.amount)) {
    return invalid(
      'split_projection_mismatch',
      'Split projection must use each source component once.',
    );
  }
  return Object.freeze({
    kind: input.kind,
    investmentAccountId: accountId,
    investmentValue,
    cashAccountId,
    cashValue,
  });
}

function createHolding(input: NormalizedHolding): NormalizedHolding {
  const sourceAsOf = parseInstant(input.sourceAsOf);
  return Object.freeze({
    providerHoldingId: parseIdentity(input.providerHoldingId, 'Holding'),
    providerSecurityId: parseIdentity(input.providerSecurityId, 'Security'),
    instrumentName: parseOptionalLabel(input.instrumentName, 'Instrument name'),
    symbol: parseOptionalLabel(input.symbol, 'Symbol'),
    quantity: parseDecimalRate(input.quantity),
    marketValue: input.marketValue === null ? null : createReportableAmount(input.marketValue),
    sourceAsOf,
    revision: createProviderRevisionIdentity(input.revision),
  });
}

export function createPortfolioSnapshot(input: PortfolioSnapshot): PortfolioSnapshot {
  const ownerId = parseDomainId(input.ownerId, 'portfolio-owner');
  const accountId = parseAccountId(input.accountId);
  const sourceAsOf = parseInstant(input.sourceAsOf);
  const receivedAt = parseInstant(input.receivedAt);
  const staleAt = parseInstant(input.staleAt);
  if (compareInstants(sourceAsOf, receivedAt) > 0 || compareInstants(sourceAsOf, staleAt) > 0) {
    return invalid(
      'invalid_timestamps',
      'receivedAt and staleAt cannot be earlier than the provider source timestamp.',
    );
  }

  const providerReportedMarketValue = createReportableAmount(input.providerReportedMarketValue);
  const totalMarketValue =
    input.totalMarketValue === null ? null : createReportableAmount(input.totalMarketValue);
  const cash = createPortfolioCash(input.cash);
  validateEconomicTotal(providerReportedMarketValue, totalMarketValue, cash);
  const netWorthProjection = createProjection(
    input.netWorthProjection,
    accountId,
    providerReportedMarketValue,
    totalMarketValue,
    cash,
  );
  const holdingItems = input.holdings.items.map(createHolding);
  if (input.holdings.completeness === 'unavailable' && holdingItems.length !== 0) {
    return invalid('unavailable_holdings', 'Unavailable holdings cannot contain normalized items.');
  }
  const holdingIds = new Set(holdingItems.map((holding) => holding.providerHoldingId));
  if (holdingIds.size !== holdingItems.length) {
    return invalid('duplicate_holding', 'Holding identities must be unique within a snapshot.');
  }

  return Object.freeze({
    ownerId,
    accountId,
    connection: createPortfolioConnectionIdentity(input.connection),
    providerPortfolioId: parseIdentity(input.providerPortfolioId, 'Portfolio account'),
    sourceAsOf,
    receivedAt,
    staleAt,
    providerReportedMarketValue,
    totalMarketValue,
    cash,
    netWorthProjection,
    contributedCapital:
      input.contributedCapital === null ? null : createReportableAmount(input.contributedCapital),
    holdings: Object.freeze({
      completeness: parseCompleteness(input.holdings.completeness),
      items: Object.freeze(holdingItems),
    }),
    sourceCompleteness: parseCompleteness(input.sourceCompleteness),
    revision: createProviderRevisionIdentity(input.revision),
  });
}

export function reconcileHoldings(
  snapshotInput: PortfolioSnapshot,
  providerRoundingTolerance: Money,
): HoldingsReconciliation {
  const snapshot = createPortfolioSnapshot(snapshotInput);
  const tolerance = createMoney(
    providerRoundingTolerance.amountMinor,
    providerRoundingTolerance.currency,
  );
  if (tolerance.amountMinor < 0n) {
    return invalid('negative_tolerance', 'Provider rounding tolerance cannot be negative.');
  }
  if (snapshot.holdings.completeness !== 'complete' || snapshot.cash.treatment === 'unavailable') {
    return Object.freeze({ status: 'unavailable', difference: null });
  }
  const holdingValues = snapshot.holdings.items.map((holding) =>
    holding.marketValue === null ? null : reportingMoney(holding.marketValue),
  );
  if (holdingValues.some((value) => value === null)) {
    return Object.freeze({ status: 'unavailable', difference: null });
  }
  const target = reportingMoney(snapshot.providerReportedMarketValue);
  if (target === null || target.currency !== tolerance.currency) {
    return Object.freeze({ status: 'unavailable', difference: null });
  }
  const components = holdingValues.filter((value): value is Money => value !== null);
  if (snapshot.cash.treatment === 'included_in_total' && snapshot.cash.amount !== null) {
    const cash = reportingMoney(snapshot.cash.amount);
    if (cash === null) return Object.freeze({ status: 'unavailable', difference: null });
    components.push(cash);
  }
  const componentTotal = sumMoney(components, target.currency);
  const difference = subtractMoney(componentTotal, target);
  const absolute = difference.amountMinor < 0n ? -difference.amountMinor : difference.amountMinor;
  const status =
    absolute === 0n
      ? 'exact'
      : absolute <= tolerance.amountMinor
        ? 'within_provider_rounding'
        : 'material_mismatch';
  return Object.freeze({ status, difference });
}

export function validateHoldingsReconciliation(
  input: HoldingsReconciliation,
): HoldingsReconciliation {
  if (input.status === 'unavailable') {
    if (input.difference !== null) {
      return invalid(
        'invalid_holdings_reconciliation',
        'Unavailable holdings reconciliation cannot carry a difference.',
      );
    }
    return Object.freeze({ status: input.status, difference: null });
  }
  if (!['exact', 'within_provider_rounding', 'material_mismatch'].includes(input.status)) {
    return invalid('invalid_holdings_reconciliation', 'Holdings reconciliation is unsupported.');
  }
  if (input.difference === null) {
    return invalid(
      'invalid_holdings_reconciliation',
      'A comparable holdings reconciliation requires an exact difference.',
    );
  }
  const difference = createMoney(input.difference.amountMinor, input.difference.currency);
  if (input.status === 'exact' && difference.amountMinor !== 0n) {
    return invalid(
      'invalid_holdings_reconciliation',
      'Exact holdings reconciliation requires a zero difference.',
    );
  }
  if (input.status !== 'exact' && difference.amountMinor === 0n) {
    return invalid(
      'invalid_holdings_reconciliation',
      'A non-exact holdings reconciliation requires a non-zero difference.',
    );
  }
  return Object.freeze({ status: input.status, difference });
}

export function createContributionEvidence(input: ContributionEvidence): ContributionEvidence {
  const amount = createMoney(input.amount.amountMinor, input.amount.currency);
  if (amount.amountMinor <= 0n) {
    return invalid('non_positive_contribution', 'Contribution evidence amount must be positive.');
  }
  if (input.direction !== 'contribution' && input.direction !== 'withdrawal') {
    return invalid('invalid_contribution_direction', 'Contribution direction is unsupported.');
  }
  return Object.freeze({
    connection: createPortfolioConnectionIdentity(input.connection),
    providerPortfolioId: parseIdentity(input.providerPortfolioId, 'Portfolio account'),
    providerContributionId:
      input.providerContributionId === null
        ? null
        : parseIdentity(input.providerContributionId, 'Contribution'),
    effectiveAt: parseInstant(input.effectiveAt),
    amount,
    direction: input.direction,
    providerReference:
      input.providerReference === null
        ? null
        : parseIdentity(input.providerReference, 'Provider reference'),
    revision: createProviderRevisionIdentity(input.revision),
  });
}

function createContributionMatchEvidence(
  input: ContributionMatchEvidence,
): ContributionMatchEvidence {
  if (
    typeof input.amountAndCurrencyExact !== 'boolean' ||
    typeof input.portfolioAccountExact !== 'boolean' ||
    (input.providerReferenceExact !== null && typeof input.providerReferenceExact !== 'boolean') ||
    (input.bankReferenceExact !== null && typeof input.bankReferenceExact !== 'boolean')
  ) {
    return invalid('invalid_match_evidence', 'Contribution match flags must be booleans or null.');
  }
  if (
    input.effectiveTimeDistanceSeconds !== null &&
    (!Number.isSafeInteger(input.effectiveTimeDistanceSeconds) ||
      input.effectiveTimeDistanceSeconds < 0)
  ) {
    return invalid('invalid_match_distance', 'Match time distance must be a non-negative integer.');
  }
  return Object.freeze({
    amountAndCurrencyExact: input.amountAndCurrencyExact,
    effectiveTimeDistanceSeconds: input.effectiveTimeDistanceSeconds,
    providerReferenceExact: input.providerReferenceExact,
    bankReferenceExact: input.bankReferenceExact,
    portfolioAccountExact: input.portfolioAccountExact,
    canonicalTransferId:
      input.canonicalTransferId === null
        ? null
        : parseIdentity(input.canonicalTransferId, 'Canonical transfer'),
  });
}

export function validateContributionMatch(input: ContributionMatch): ContributionMatch {
  if (!['unmatched', 'candidate', 'confirmed', 'rejected'].includes(input.state)) {
    return invalid('invalid_match_state', 'Contribution match state is unsupported.');
  }
  const evidence = createContributionMatchEvidence(input.evidence);
  const confirmed = input.state === 'confirmed';
  if (confirmed !== (input.confirmedContributionKey !== null)) {
    return invalid(
      'invalid_match_authority',
      'Only a confirmed match may carry the authoritative contribution key.',
    );
  }
  if (confirmed && !evidence.portfolioAccountExact) {
    return invalid(
      'portfolio_account_mismatch',
      'A confirmed contribution must match the intended portfolio account.',
    );
  }
  if (confirmed && (!evidence.amountAndCurrencyExact || evidence.canonicalTransferId === null)) {
    return invalid(
      'insufficient_match_evidence',
      'Confirmation requires exact money, the correct portfolio account, and a canonical transfer identity.',
    );
  }
  return Object.freeze({
    state: input.state,
    evidence,
    confirmedContributionKey:
      input.confirmedContributionKey === null
        ? null
        : parseIdentity(input.confirmedContributionKey, 'Confirmed contribution'),
  });
}

export function createConfirmedContributionPrincipal(
  evidenceInput: ContributionEvidence,
  matchInput: ContributionMatch,
): ConfirmedContributionPrincipal | null {
  const evidence = createContributionEvidence(evidenceInput);
  const match = validateContributionMatch(matchInput);
  if (match.state !== 'confirmed') return null;
  if (match.confirmedContributionKey === null || match.evidence.canonicalTransferId === null) {
    return invalid('invalid_confirmed_match', 'Confirmed contribution match is incomplete.');
  }
  return Object.freeze({
    authority: 'confirmed_principal',
    contributionKey: match.confirmedContributionKey,
    canonicalTransferId: match.evidence.canonicalTransferId,
    providerPortfolioId: evidence.providerPortfolioId,
    effectiveAt: evidence.effectiveAt,
    amount: evidence.amount,
    direction: evidence.direction,
    matchEvidence: match.evidence,
  });
}

export function validateConfirmedContributionPrincipal(
  input: ConfirmedContributionPrincipal,
): ConfirmedContributionPrincipal {
  if (input.authority !== 'confirmed_principal') {
    return invalid('invalid_principal_authority', 'Contribution principal must be confirmed.');
  }
  const matchEvidence = createContributionMatchEvidence(input.matchEvidence);
  const canonicalTransferId = parseIdentity(input.canonicalTransferId, 'Canonical transfer');
  if (
    !matchEvidence.amountAndCurrencyExact ||
    !matchEvidence.portfolioAccountExact ||
    matchEvidence.canonicalTransferId !== canonicalTransferId
  ) {
    return invalid(
      'invalid_principal_evidence',
      'Confirmed principal must retain exact money, account, and transfer evidence.',
    );
  }
  const amount = createMoney(input.amount.amountMinor, input.amount.currency);
  if (amount.amountMinor <= 0n) {
    return invalid('non_positive_principal', 'Confirmed principal amount must be positive.');
  }
  if (input.direction !== 'contribution' && input.direction !== 'withdrawal') {
    return invalid('invalid_contribution_direction', 'Contribution direction is unsupported.');
  }
  return Object.freeze({
    authority: input.authority,
    contributionKey: parseIdentity(input.contributionKey, 'Confirmed contribution'),
    canonicalTransferId,
    providerPortfolioId: parseIdentity(input.providerPortfolioId, 'Portfolio account'),
    effectiveAt: parseInstant(input.effectiveAt),
    amount,
    direction: input.direction,
    matchEvidence,
  });
}

export function calculateMarketMovement(
  openingValue: Money,
  closingValue: Money,
  flows: readonly ConfirmedContributionPrincipal[],
  fxValuationEffect: Money,
): MarketMovementReconciliation {
  const opening = createMoney(openingValue.amountMinor, openingValue.currency);
  const closing = createMoney(closingValue.amountMinor, closingValue.currency);
  const fxEffect = createMoney(fxValuationEffect.amountMinor, fxValuationEffect.currency);
  const normalizedFlows = flows.map(validateConfirmedContributionPrincipal);
  const contributions = sumMoney(
    normalizedFlows.filter((flow) => flow.direction === 'contribution').map((flow) => flow.amount),
    opening.currency,
  );
  const withdrawals = sumMoney(
    normalizedFlows.filter((flow) => flow.direction === 'withdrawal').map((flow) => flow.amount),
    opening.currency,
  );
  const marketMovement = subtractMoney(
    addMoney(subtractMoney(subtractMoney(closing, opening), contributions), withdrawals),
    fxEffect,
  );
  return Object.freeze({
    openingValue: opening,
    closingValue: closing,
    contributions,
    withdrawals,
    fxValuationEffect: fxEffect,
    marketMovement,
  });
}

function uniqueWarnings(
  warnings: readonly PortfolioWarningCode[],
): readonly PortfolioWarningCode[] {
  const allowed = new Set<string>(PORTFOLIO_WARNING_CODES);
  const unique = [...new Set(warnings)];
  if (unique.some((warning) => !allowed.has(warning))) {
    return invalid('invalid_warning', 'Portfolio warning must be from the bounded warning set.');
  }
  return Object.freeze(unique.sort());
}

export function assessPortfolioReadiness(
  snapshotInput: PortfolioSnapshot | null,
  nowInput: PortfolioSnapshot['receivedAt'],
  evidenceInput: PortfolioReadinessEvidence,
): PortfolioReadiness {
  const now = parseInstant(nowInput);
  const holdingsReconciliation = validateHoldingsReconciliation(
    evidenceInput.holdingsReconciliation,
  );
  if (snapshotInput === null) {
    return Object.freeze({
      completeness: 'unavailable',
      recommendationAllowed: false,
      warnings: Object.freeze(['missing_valuation'] as const),
    });
  }
  const snapshot = createPortfolioSnapshot(snapshotInput);
  const warnings: PortfolioWarningCode[] = [];
  if (snapshot.cash.treatment === 'unavailable') warnings.push('cash_treatment_unknown');
  if (snapshot.totalMarketValue?.status === 'missing_fx') warnings.push('fx_unavailable');
  if (snapshot.totalMarketValue === null && snapshot.cash.treatment !== 'unavailable') {
    warnings.push('missing_valuation');
  }
  if (snapshot.sourceCompleteness !== 'complete') warnings.push('source_incomplete');
  if (compareInstants(now, snapshot.staleAt) > 0) warnings.push('stale_valuation');
  if (snapshot.holdings.completeness !== 'complete') warnings.push('holdings_incomplete');
  if (snapshot.contributedCapital === null) warnings.push('contributed_capital_unavailable');
  if (holdingsReconciliation.status === 'material_mismatch') {
    warnings.push('valuation_components_mismatch');
  }

  const unavailable =
    warnings.some((warning) =>
      ['cash_treatment_unknown', 'fx_unavailable', 'missing_valuation'].includes(warning),
    ) || snapshot.sourceCompleteness === 'unavailable';
  const authoritative =
    !unavailable &&
    !warnings.includes('stale_valuation') &&
    !warnings.includes('valuation_components_mismatch');
  const completeness = unavailable
    ? 'unavailable'
    : warnings.includes('stale_valuation') ||
        warnings.includes('source_incomplete') ||
        warnings.includes('valuation_components_mismatch')
      ? 'partial'
      : 'complete';
  return Object.freeze({
    completeness,
    recommendationAllowed: authoritative && snapshot.sourceCompleteness === 'complete',
    warnings: uniqueWarnings(warnings),
  });
}

export function serializePortfolioCursor(cursor: PortfolioCursor): string {
  if (cursor.kind === 'timestamp_watermark') {
    return JSON.stringify({ kind: cursor.kind, value: parseInstant(cursor.value) });
  }
  if (cursor.kind === 'composite') {
    const entries = Object.entries(cursor.value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (
      entries.length === 0 ||
      entries.some(
        ([key, value]) =>
          !IDENTITY_PATTERN.test(key) || typeof value !== 'string' || value.length > 2048,
      )
    ) {
      return invalid('invalid_cursor', 'Composite cursor must contain bounded string state.');
    }
    return JSON.stringify({ kind: cursor.kind, value: Object.fromEntries(entries) });
  }
  if (typeof cursor.value !== 'string' || cursor.value.length === 0 || cursor.value.length > 4096) {
    return invalid('invalid_cursor', 'Provider cursor must be a bounded non-empty string.');
  }
  return JSON.stringify({ kind: cursor.kind, value: cursor.value });
}

export function parsePortfolioCursor(serialized: string): PortfolioCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return invalid('invalid_cursor', 'Portfolio cursor must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return invalid('invalid_cursor', 'Portfolio cursor must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'kind,value') {
    return invalid('invalid_cursor', 'Portfolio cursor has unexpected fields.');
  }
  const kind = record['kind'];
  const value = record['value'];
  if (kind === 'timestamp_watermark') {
    return Object.freeze({ kind, value: parseInstant(value) });
  }
  if (kind === 'composite') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalid('invalid_cursor', 'Composite cursor value must be an object.');
    }
    const composite = value as Record<string, unknown>;
    const entries = Object.entries(composite);
    if (entries.some(([, item]) => typeof item !== 'string')) {
      return invalid('invalid_cursor', 'Composite cursor values must be strings.');
    }
    const cursor = {
      kind,
      value: Object.fromEntries(entries) as Readonly<Record<string, string>>,
    } as const;
    serializePortfolioCursor(cursor);
    return Object.freeze(cursor);
  }
  if (kind !== 'opaque' && kind !== 'page_token') {
    return invalid('invalid_cursor', 'Portfolio cursor kind is unsupported.');
  }
  if (typeof value !== 'string') {
    return invalid('invalid_cursor', 'Portfolio cursor value must be a string.');
  }
  const cursor = { kind, value } as const;
  serializePortfolioCursor(cursor);
  return Object.freeze(cursor);
}
