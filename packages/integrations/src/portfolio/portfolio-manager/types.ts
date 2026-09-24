import type { AccountId, Instant } from '@personal-cfo/domain';

import type {
  ContributionEvidence,
  HoldingsReconciliation,
  PortfolioCapabilities,
  PortfolioOwnerId,
  PortfolioReadiness,
  PortfolioSnapshot,
  PortfolioWarningCode,
  ProviderRevisionIdentity,
} from '../types.js';

export const PORTFOLIO_MANAGER_PROVIDER_ID = 'portfolio-manager';
export const PORTFOLIO_MANAGER_CONTRACT_VERSION = 'portfolio-manager-personal-cfo-v1';
export const PORTFOLIO_MANAGER_BINDING_VERSION = 'portfolio-manager-personal-cfo-v1-binding-v1';
export const PORTFOLIO_MANAGER_NORMALIZATION_VERSION = 'portfolio-manager-normalization-v1';

export type PortfolioManagerExactDecimal = string & {
  readonly __portfolioManagerExactDecimal: unique symbol;
};

export type PortfolioManagerIdentity = Readonly<{
  contractVersion: typeof PORTFOLIO_MANAGER_CONTRACT_VERSION;
  provider: typeof PORTFOLIO_MANAGER_PROVIDER_ID;
  providerInstanceId: string;
  portfolioId: string;
}>;

export type PortfolioManagerCapabilityDto = Readonly<{
  totalMarketValue: boolean;
  holdings: boolean;
  holdingMarketValues: boolean;
  cashIncludedInValuation: boolean;
  contributionWithdrawalHistory: boolean;
  reportingCurrency: boolean;
  sourceFreshnessTimestamps: boolean;
  deterministicIncrementalCapitalFlowCursor: boolean;
  revisionsCorrections: boolean;
  pnl: boolean;
  historicalValuations: boolean;
  distributions: boolean;
  fees: boolean;
  fxInformation: boolean;
}>;

export type PortfolioManagerCapabilities = PortfolioManagerIdentity &
  Readonly<{ capabilities: PortfolioManagerCapabilityDto }>;

export type PortfolioManagerHolding = Readonly<{
  providerHoldingId: string;
  accountId: string;
  assetId: string;
  symbol: string;
  name: string;
  assetClass: string;
  assetType: string;
  quantity: PortfolioManagerExactDecimal;
  currentMarketValue: PortfolioManagerExactDecimal | null;
  price: PortfolioManagerExactDecimal | null;
  priceCurrency: string | null;
  priceSource: string | null;
  priceTimestamp: Instant | null;
  isPriceStale: boolean;
}>;

export type PortfolioManagerSnapshot = PortfolioManagerIdentity &
  Readonly<{
    generatedAt: Instant;
    reportingCurrency: string;
    valuation: Readonly<{
      status: 'complete' | 'partial' | 'unavailable';
      totalValue: PortfolioManagerExactDecimal | null;
      knownValuedSubtotal: PortfolioManagerExactDecimal;
      missingPriceSymbols: readonly string[];
      hasStalePrices: boolean;
      sourceAsOf: Instant | null;
      sourceAsOfSemantics: 'oldest_component_quote';
    }>;
    cash: Readonly<{
      treatment: 'included_in_total';
      amount: PortfolioManagerExactDecimal | null;
      currency: string;
    }>;
    holdings: Readonly<{
      completeness: 'complete' | 'partial' | 'unavailable';
      items: readonly PortfolioManagerHolding[];
    }>;
  }>;

export type PortfolioManagerCapitalFlowStatus = 'ACTIVE' | 'REPLACED' | 'VOIDED';

export type PortfolioManagerCapitalFlow = Readonly<{
  eventId: string;
  revisionId: string;
  sourceTransactionId: string;
  status: PortfolioManagerCapitalFlowStatus;
  direction: 'contribution' | 'withdrawal';
  accountId: string;
  assetId: string;
  amount: PortfolioManagerExactDecimal | null;
  amountUnavailableReason: 'MISSING_OR_NON_POSITIVE_ORIGINAL_AMOUNT' | null;
  currency: string;
  effectiveAt: Instant;
  changedAt: Instant;
  replacesRevisionId: string | null;
  replacementRevisionIds: readonly string[];
  revisionFingerprint: string;
}>;

export type PortfolioManagerCapitalFlowPage = PortfolioManagerIdentity &
  Readonly<{
    items: readonly PortfolioManagerCapitalFlow[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;

export type PortfolioManagerHoldingEvidence = Readonly<{
  providerHoldingId: string;
  accountId: string;
  assetId: string;
  symbol: string;
  name: string;
  assetClass: string;
  assetType: string;
  quantity: PortfolioManagerExactDecimal;
  currentMarketValue: PortfolioManagerExactDecimal | null;
  price: PortfolioManagerExactDecimal | null;
  priceCurrency: string | null;
  priceSource: string | null;
  priceTimestamp: Instant | null;
  isPriceStale: boolean;
  revision: ProviderRevisionIdentity;
}>;

export type PortfolioManagerSnapshotContext = Readonly<{
  ownerId: PortfolioOwnerId;
  accountId: AccountId;
  connectionId: string;
  receivedAt: Instant;
  freshStaleAt: Instant;
}>;

export type PortfolioManagerSnapshotNormalization =
  | Readonly<{
      status: 'normalized';
      snapshot: PortfolioSnapshot;
      holdings: readonly PortfolioManagerHoldingEvidence[];
      warnings: readonly PortfolioWarningCode[];
    }>
  | Readonly<{
      status: 'quarantined';
      category: 'portfolio_manager_non_eur_reporting_currency';
    }>;

export type PortfolioManagerCapitalFlowObservation = Readonly<{
  providerPortfolioId: string;
  providerInstanceId: string;
  eventId: string;
  revisionId: string;
  sourceTransactionId: string;
  status: PortfolioManagerCapitalFlowStatus;
  direction: 'contribution' | 'withdrawal';
  accountId: string;
  assetId: string;
  exactAmount: PortfolioManagerExactDecimal | null;
  amountUnavailableReason: 'MISSING_OR_NON_POSITIVE_ORIGINAL_AMOUNT' | null;
  currency: string;
  effectiveAt: Instant;
  changedAt: Instant;
  replacesRevisionId: string | null;
  replacementRevisionIds: readonly string[];
  revision: ProviderRevisionIdentity;
}>;

export type PortfolioManagerCapitalFlowNormalization =
  | Readonly<{
      status: 'normalized';
      observation: PortfolioManagerCapitalFlowObservation;
      evidence: ContributionEvidence | null;
    }>
  | Readonly<{
      status: 'quarantined';
      observation: PortfolioManagerCapitalFlowObservation;
      category:
        | 'portfolio_manager_amount_unavailable'
        | 'portfolio_manager_non_eur_contribution'
        | 'portfolio_manager_subminor_contribution';
    }>;

export type PortfolioManagerProviderBinding = Readonly<{
  provider: typeof PORTFOLIO_MANAGER_PROVIDER_ID;
  version: typeof PORTFOLIO_MANAGER_BINDING_VERSION;
  contractVersion: typeof PORTFOLIO_MANAGER_CONTRACT_VERSION;
  endpoints: Readonly<{
    capabilities: string;
    snapshot: string;
    capitalFlows: string;
  }>;
  authentication: Readonly<{ kind: 'bearer' }>;
  capitalFlowPageSize: 500;
  capabilities: PortfolioCapabilities;
}>;

export type PortfolioManagerClock = Readonly<{ now: () => Date }>;
export type PortfolioManagerSleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type PortfolioManagerFetch = (input: string, init: RequestInit) => Promise<Response>;
export type PortfolioManagerTransport = PortfolioManagerFetch;

export type PortfolioManagerApiErrorCategory =
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'unsupported_version'
  | 'rate_limited'
  | 'timeout'
  | 'transient_provider_failure'
  | 'invalid_request'
  | 'invalid_response';

export type PortfolioManagerRawResponse<T> = Readonly<{
  body: string;
  value: T;
  receivedAt: Instant;
  receiptId: string | null;
}>;

export type PortfolioManagerRawResponseSink = (
  response: Readonly<{
    endpoint: 'capabilities' | 'snapshot' | 'capital_flows';
    path: string;
    requestCursor: string | null;
    body: string;
    receivedAt: Instant;
  }>,
) => Promise<string>;

export type PortfolioManagerRevisionDisposition = 'new' | 'replay' | 'revision';

export type PortfolioManagerSyncCounts = Readonly<{
  new: number;
  replay: number;
  revision: number;
  quarantined: number;
  ignored: number;
}>;

export type PortfolioManagerSyncResult = Readonly<{
  snapshot: PortfolioSnapshot | null;
  providerSnapshot: PortfolioManagerSnapshot | null;
  holdings: readonly PortfolioManagerHoldingEvidence[];
  capitalFlows: readonly PortfolioManagerCapitalFlowObservation[];
  contributions: readonly ContributionEvidence[];
  counts: PortfolioManagerSyncCounts;
  checkpoint: string | null;
  sourceCompleteness: 'complete' | 'partial' | 'unavailable';
  holdingsReconciliation: HoldingsReconciliation;
  readiness: PortfolioReadiness;
  warnings: readonly PortfolioWarningCode[];
  confirmedPrincipalsCreated: 0;
}>;
