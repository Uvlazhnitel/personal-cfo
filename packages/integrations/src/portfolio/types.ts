import type {
  AccountId,
  Completeness,
  DecimalRate,
  DomainId,
  Instant,
  Money,
  ReportableAmount,
} from '@personal-cfo/domain';

export const PORTFOLIO_CAPABILITIES = [
  'total_market_value',
  'brokerage_cash',
  'holdings',
  'holding_market_values',
  'contributed_capital_total',
  'contribution_history',
  'provider_profit_loss',
  'currency',
  'fx_information',
  'valuation_source_timestamp',
  'incremental_cursor',
  'historical_valuations',
  'distributions',
  'fees',
] as const;

export type PortfolioCapability = (typeof PORTFOLIO_CAPABILITIES)[number];
export type PortfolioCapabilities = Readonly<Record<PortfolioCapability, boolean>>;
export type PortfolioOwnerId = DomainId<'portfolio-owner'>;

export const PORTFOLIO_WARNING_CODES = [
  'cash_treatment_unknown',
  'contributed_capital_unavailable',
  'holdings_incomplete',
  'provider_pl_semantics_unverified',
  'stale_valuation',
  'missing_valuation',
  'valuation_components_mismatch',
  'fx_unavailable',
  'source_incomplete',
] as const;

export type PortfolioWarningCode = (typeof PORTFOLIO_WARNING_CODES)[number];

export type PortfolioConnectionIdentity = Readonly<{
  provider: string;
  connectionId: string;
}>;

export type ProviderRevisionIdentity = Readonly<{
  sourceId: string;
  version:
    | Readonly<{ kind: 'provider_revision'; value: string }>
    | Readonly<{ kind: 'sha256_fingerprint'; value: string }>;
}>;

export type PortfolioCursor =
  | Readonly<{ kind: 'opaque'; value: string }>
  | Readonly<{ kind: 'page_token'; value: string }>
  | Readonly<{ kind: 'timestamp_watermark'; value: Instant }>
  | Readonly<{ kind: 'composite'; value: Readonly<Record<string, string>> }>;

export type PortfolioCash =
  | Readonly<{
      treatment: 'included_in_total';
      amount: ReportableAmount | null;
    }>
  | Readonly<{
      treatment: 'excluded_from_total';
      amount: ReportableAmount;
    }>
  | Readonly<{
      treatment: 'unavailable';
      amount: null;
    }>;

export type PortfolioNetWorthProjection =
  | Readonly<{
      kind: 'single_investment_account';
      investmentAccountId: AccountId;
      value: ReportableAmount;
    }>
  | Readonly<{
      kind: 'investment_plus_separate_cash';
      investmentAccountId: AccountId;
      investmentValue: ReportableAmount;
      cashAccountId: AccountId;
      cashValue: ReportableAmount;
    }>
  | Readonly<{
      kind: 'unavailable';
      reason: 'cash_treatment_unknown' | 'fx_unavailable';
    }>;

export type NormalizedHolding = Readonly<{
  providerHoldingId: string;
  providerSecurityId: string;
  instrumentName: string | null;
  symbol: string | null;
  quantity: DecimalRate;
  marketValue: ReportableAmount | null;
  sourceAsOf: Instant;
  revision: ProviderRevisionIdentity;
}>;

export type PortfolioSnapshot = Readonly<{
  ownerId: PortfolioOwnerId;
  accountId: AccountId;
  connection: PortfolioConnectionIdentity;
  providerPortfolioId: string;
  sourceAsOf: Instant;
  receivedAt: Instant;
  staleAt: Instant;
  providerReportedMarketValue: ReportableAmount;
  totalMarketValue: ReportableAmount | null;
  cash: PortfolioCash;
  netWorthProjection: PortfolioNetWorthProjection;
  contributedCapital: ReportableAmount | null;
  holdings: Readonly<{
    completeness: Completeness;
    items: readonly NormalizedHolding[];
  }>;
  sourceCompleteness: Completeness;
  revision: ProviderRevisionIdentity;
}>;

export type ContributionDirection = 'contribution' | 'withdrawal';

export type ContributionEvidence = Readonly<{
  connection: PortfolioConnectionIdentity;
  providerPortfolioId: string;
  providerContributionId: string | null;
  effectiveAt: Instant;
  amount: Money;
  direction: ContributionDirection;
  providerReference: string | null;
  revision: ProviderRevisionIdentity;
}>;

export type ContributionMatchEvidence = Readonly<{
  amountAndCurrencyExact: boolean;
  effectiveTimeDistanceSeconds: number | null;
  providerReferenceExact: boolean | null;
  bankReferenceExact: boolean | null;
  portfolioAccountExact: boolean;
  canonicalTransferId: string | null;
}>;

export type ContributionMatch = Readonly<{
  state: 'unmatched' | 'candidate' | 'confirmed' | 'rejected';
  evidence: ContributionMatchEvidence;
  confirmedContributionKey: string | null;
}>;

export type ProviderProfitLoss = Readonly<{
  amount: ReportableAmount;
  semantics: 'unknown' | 'all_time' | 'unrealized' | 'realized_and_unrealized' | 'period';
  periodStart: Instant | null;
  periodEnd: Instant | null;
  fxBasis: 'unknown' | 'provider_native' | 'reporting_currency';
  authority: 'reconciliation_only';
}>;

export type PortfolioDistribution = Readonly<{
  kind: 'dividend' | 'interest' | 'cash_distribution';
  treatment: 'portfolio_internal_return' | 'external_distribution' | 'unknown';
  amount: Money;
  effectiveAt: Instant;
}>;

export type PortfolioFee = Readonly<{
  treatment: 'reflected_in_valuation' | 'external_account_fee' | 'unknown';
  amount: Money;
  effectiveAt: Instant;
}>;

export type HoldingsReconciliation = Readonly<{
  status: 'exact' | 'within_provider_rounding' | 'material_mismatch' | 'unavailable';
  difference: Money | null;
}>;

export type PortfolioReadiness = Readonly<{
  completeness: Completeness;
  recommendationAllowed: boolean;
  warnings: readonly PortfolioWarningCode[];
}>;

export type MarketMovementReconciliation = Readonly<{
  openingValue: Money;
  closingValue: Money;
  contributions: Money;
  withdrawals: Money;
  fxValuationEffect: Money;
  marketMovement: Money;
}>;

export type PortfolioRawReceipt = Readonly<{
  provider: string;
  capability: PortfolioCapability;
  requestCursor: PortfolioCursor | null;
  requestWindow: Readonly<{ from: Instant | null; to: Instant | null }>;
  receivedAt: Instant;
  payloadSha256: string;
  sourceIds: readonly string[];
  revisionIds: readonly string[];
  normalizationVersion: string;
  processingStatus: 'received' | 'normalized' | 'quarantined' | 'failed';
  rawPayloadExpiresAt: Instant;
}>;

export type PortfolioPage = Readonly<{
  receipt: PortfolioRawReceipt;
  snapshot: PortfolioSnapshot | null;
  contributions: readonly ContributionEvidence[];
  providerProfitLoss: readonly ProviderProfitLoss[];
  distributions: readonly PortfolioDistribution[];
  fees: readonly PortfolioFee[];
  warnings: readonly PortfolioWarningCode[];
  nextCursor: PortfolioCursor | null;
}>;

export type PortfolioFetchRequest = Readonly<{
  connection: PortfolioConnectionIdentity;
  cursor: PortfolioCursor | null;
  signal: AbortSignal;
}>;

export interface PortfolioProvider {
  discoverCapabilities(signal: AbortSignal): Promise<PortfolioCapabilities>;
  getConnectionIdentity(signal: AbortSignal): Promise<PortfolioConnectionIdentity>;
  fetchPortfolioPage(request: PortfolioFetchRequest): Promise<PortfolioPage>;
}

export const PORTFOLIO_CONNECTION_STATES = [
  'disconnected',
  'connecting',
  'active',
  'degraded',
  'reauth_required',
  'disabled',
] as const;

export type PortfolioConnectionState = (typeof PORTFOLIO_CONNECTION_STATES)[number];
