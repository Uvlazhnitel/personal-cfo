import type { AccountId, Instant } from '@personal-cfo/domain';

import type {
  PortfolioCapabilities,
  PortfolioConnectionIdentity,
  PortfolioCursor,
  PortfolioOwnerId,
  PortfolioSnapshot,
  ContributionEvidence,
  PortfolioWarningCode,
  ProviderProfitLoss,
  ProviderRevisionIdentity,
} from '../types.js';

export const SHARESIGHT_PROVIDER_ID = 'sharesight';
export const SHARESIGHT_BINDING_VERSION = 'sharesight-v2-v2.1-binding-v1';

export type SharesightFieldClassification = 'DIRECT' | 'DERIVED' | 'UNAVAILABLE' | 'AMBIGUOUS';

export type SharesightExactNumber = string & { readonly __sharesightExactNumber: unique symbol };

export type SharesightPortfolio = Readonly<{
  id: string;
  name: string;
  currencyCode: string;
  inceptionDate: string;
  timeZoneName: string;
}>;

export type SharesightHolding = Readonly<{
  id: string;
  instrumentId: string;
  symbol: string | null;
  marketCode: string | null;
  name: string | null;
  value: SharesightExactNumber;
  quantity: SharesightExactNumber;
}>;

export type SharesightValuationCashAccount = Readonly<{
  id: string;
  cashAccountId: string | null;
  name: string;
  value: SharesightExactNumber;
  currencyCode: string;
}>;

export type SharesightValuation = Readonly<{
  reportId: string;
  balanceDate: string;
  portfolioId: string;
  value: SharesightExactNumber;
  holdings: readonly SharesightHolding[];
  cashAccounts: readonly SharesightValuationCashAccount[];
  holdingsCompleteness: 'complete' | 'partial';
}>;

export type SharesightCashAccount = Readonly<{
  id: string;
  portfolioId: string;
  currencyCode: string;
  portfolioCurrencyCode: string;
  date: string;
  balance: SharesightExactNumber;
  balanceInPortfolioCurrency: SharesightExactNumber;
}>;

export type SharesightCashAccountTransaction = Readonly<{
  id: string;
  dateTime: string;
  amount: SharesightExactNumber;
  balance: SharesightExactNumber;
  cashAccountId: string;
  foreignIdentifier: string | null;
  typeName: string;
  linkedPortfolioId: string;
}>;

export type SharesightTrade = Readonly<{
  id: string | null;
  uniqueIdentifier: string | null;
  portfolioId: string;
  holdingId: string;
  transactionType: string;
  transactionDate: string;
  state: 'confirmed' | 'unconfirmed' | 'rejected';
  value: SharesightExactNumber;
  brokerage: SharesightExactNumber;
  brokerageCurrencyCode: string;
}>;

export type SharesightPerformance = Readonly<{
  reportId: string;
  portfolioId: string;
  startDate: string;
  endDate: string;
  value: SharesightExactNumber;
  capitalGain: SharesightExactNumber;
  payoutGain: SharesightExactNumber;
  currencyGain: SharesightExactNumber;
  totalGain: SharesightExactNumber;
}>;

export type SharesightPayout = Readonly<{
  id: string;
  portfolioId: string;
  holdingId: string;
  paidOn: string;
  amount: SharesightExactNumber;
  currencyCode: string;
  state: 'confirmed' | 'unconfirmed' | 'rejected';
}>;

export type SharesightReportHeaders = Readonly<{
  holdingLimitTotal?: string;
  holdingLimitReason?: string;
}>;

export type SharesightSnapshotContext = Readonly<{
  ownerId: PortfolioOwnerId;
  accountId: AccountId;
  connectionId: string;
  receivedAt: Instant;
  staleAt: Instant;
  sourceFreshnessConfirmed: boolean;
}>;

export type SharesightSnapshotNormalization =
  | Readonly<{ status: 'normalized'; snapshot: PortfolioSnapshot }>
  | Readonly<{
      status: 'quarantined';
      category: 'sharesight_non_eur_reporting_currency' | 'sharesight_timezone_unavailable';
    }>;

export type SharesightContributionContext = Readonly<{
  connection: PortfolioConnectionIdentity;
  providerPortfolioId: string;
  cashAccountId: string;
  currencyCode: string;
}>;

export type SharesightContributionNormalization =
  | Readonly<{ status: 'normalized'; evidence: ContributionEvidence }>
  | Readonly<{ status: 'ignored'; category: 'sharesight_non_principal_cash_transaction' }>
  | Readonly<{
      status: 'quarantined';
      category:
        | 'sharesight_non_eur_contribution'
        | 'sharesight_cash_direction_conflict'
        | 'sharesight_portfolio_mismatch';
    }>;

export type SharesightScanPhase = 'cash_transactions' | 'trades' | 'payouts';

export type SharesightScanWindow = Readonly<{
  phase: SharesightScanPhase;
  portfolioId: string;
  resourceId: string;
  from: string;
  to: string;
  cursor: PortfolioCursor;
}>;

export type SharesightProviderBinding = Readonly<{
  provider: typeof SHARESIGHT_PROVIDER_ID;
  version: typeof SHARESIGHT_BINDING_VERSION;
  api: Readonly<{
    stableVersion: 'v2';
    valuationVersion: 'v2.1';
    unstableVersionExcluded: 'v3';
  }>;
  authentication: Readonly<{
    selectedGrant: 'client_credentials';
    authorizationCodeDocumented: true;
    accessTokenLifetimeSeconds: 1800;
    publishedScopes: 'UNAVAILABLE';
  }>;
  limits: Readonly<{
    requestsPerMinute: 360;
    concurrentReportRequests: 3;
  }>;
  capabilities: PortfolioCapabilities;
  fieldClassifications: Readonly<Record<string, SharesightFieldClassification>>;
  endpoints: Readonly<Record<string, string>>;
}>;

export type SharesightClock = Readonly<{ now: () => Date }>;
export type SharesightSleeper = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
export type SharesightFetch = (input: string, init: RequestInit) => Promise<Response>;
export type SharesightTransport = SharesightFetch;

export type SharesightApiErrorCategory =
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'rate_limited'
  | 'timeout'
  | 'transient_provider_failure'
  | 'invalid_request'
  | 'invalid_response';

export type SharesightAccessToken = Readonly<{
  value: string;
  expiresAtMilliseconds: number;
}>;

export type SharesightRawResponse<T> = Readonly<{
  body: string;
  value: T;
  receivedAt: Instant;
  receiptId: string | null;
  holdingLimitTotal: string | null;
  holdingLimitReason: string | null;
}>;

export type SharesightRawResponseSink = (
  response: Readonly<{
    path: string;
    body: string;
    receivedAt: Instant;
  }>,
) => Promise<string>;

export type SharesightTradeEvidence = Readonly<{
  providerPortfolioId: string;
  providerTradeId: string;
  holdingId: string;
  transactionType: string;
  effectiveDate: string;
  state: 'confirmed' | 'unconfirmed' | 'rejected';
  value: string;
  brokerage: string;
  brokerageCurrencyCode: string;
  revision: ProviderRevisionIdentity;
}>;

export type SharesightPayoutEvidence = Readonly<{
  providerPortfolioId: string;
  providerPayoutId: string;
  holdingId: string;
  effectiveDate: string;
  state: 'confirmed' | 'unconfirmed' | 'rejected';
  amount: string;
  currencyCode: string;
  revision: ProviderRevisionIdentity;
}>;

export type SharesightRevisionDisposition = 'new' | 'replay' | 'revision';

export type SharesightSyncCounts = Readonly<{
  new: number;
  replay: number;
  revision: number;
  quarantined: number;
  ignored: number;
}>;

export type SharesightSyncResult = Readonly<{
  status: 'completed';
  snapshot: PortfolioSnapshot | null;
  contributions: readonly ContributionEvidence[];
  trades: readonly SharesightTradeEvidence[];
  payouts: readonly SharesightPayoutEvidence[];
  providerProfitLoss: readonly ProviderProfitLoss[];
  warnings: readonly PortfolioWarningCode[];
  counts: SharesightSyncCounts;
  sourceFreshness: 'unconfirmed';
  confirmedPrincipalsCreated: 0;
}>;
