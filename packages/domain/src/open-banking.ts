import type { CurrencyCode } from './currency.js';
import type { AccountId } from './domain-id.js';
import type { Instant } from './instant.js';
import type { LocalDate } from './local-date.js';
import type { Money } from './money.js';

export const BANK_CONSENT_STATES = [
  'disconnected',
  'connecting',
  'active',
  'reauth_required',
  'error',
  'revoked',
] as const;

export type BankConsentState = (typeof BANK_CONSENT_STATES)[number];

export const BANK_TRANSACTION_STATUSES = [
  'booked',
  'cancelled',
  'hold',
  'other',
  'pending',
  'rejected',
  'scheduled',
] as const;

export type BankTransactionStatus = (typeof BANK_TRANSACTION_STATUSES)[number];
export type BankTransactionDirection = 'credit' | 'debit';

export type BankConnectionIdentity = Readonly<{
  provider: string;
  connectionId: string;
  generation: string;
}>;

export type BankProviderAccount = Readonly<{
  authority: 'provider_account_observation';
  connection: BankConnectionIdentity;
  accountId: AccountId;
  providerAccountUid: string;
  stableAccountIdentity: string;
  currency: CurrencyCode;
}>;

export type BankObservationRevision = Readonly<{
  sourceId: string | null;
  fingerprint: string;
}>;

export type BankBalanceKind =
  | 'closing_available'
  | 'closing_booked'
  | 'forward_available'
  | 'information'
  | 'interim_available'
  | 'interim_booked'
  | 'opening_available'
  | 'opening_booked'
  | 'other'
  | 'previously_closed_booked'
  | 'value_date';

export type BankBalanceObservation = Readonly<{
  authority: 'provider_balance_observation';
  account: BankProviderAccount;
  kind: BankBalanceKind;
  amount: Money;
  lastChangedAt: Instant | null;
  referenceDate: LocalDate | null;
  lastCommittedSourceId: string | null;
  revision: BankObservationRevision;
}>;

export type BankOriginalAmountMetadata = Readonly<{
  exactAmount: string;
  currency: CurrencyCode;
  exactExchangeRate: string | null;
  unitCurrency: CurrencyCode | null;
  rateType: string | null;
}>;

export type BankTransactionObservation = Readonly<{
  authority: 'provider_transaction_observation';
  account: BankProviderAccount;
  sourceId: string | null;
  providerTransactionId: string | null;
  status: BankTransactionStatus;
  direction: BankTransactionDirection;
  amount: Money;
  bookingDate: LocalDate | null;
  valueDate: LocalDate | null;
  transactionDate: LocalDate | null;
  counterpartyName: string | null;
  counterpartyAccountHint: string | null;
  remittance: readonly string[];
  referenceNumber: string | null;
  merchantCategoryCode: string | null;
  bankTransactionCode: Readonly<{
    code: string | null;
    subCode: string | null;
    description: string | null;
  }> | null;
  originalAmount: BankOriginalAmountMetadata | null;
  canonicalization:
    | 'eligible_booked'
    | 'pending_projection_only'
    | 'terminal_observation_only'
    | 'quarantined_unstable_identity';
  revision: BankObservationRevision;
}>;

export type BankHistoryCoverage = Readonly<{
  status: 'complete' | 'partial' | 'unavailable';
  bookedFrom: LocalDate | null;
  through: LocalDate | null;
  completedAt: Instant | null;
}>;

export type BankSyncCheckpoint = Readonly<{
  kind: 'session_continuation';
  sessionId: string;
  accountUid: string;
  value: string;
}>;

export type BankPendingBookedMatch = Readonly<{
  state: 'confirmed_revision' | 'candidate' | 'unmatched';
  reason:
    | 'same_stable_source'
    | 'bounded_exact_candidate'
    | 'incompatible_account'
    | 'incompatible_economics'
    | 'missing_or_ambiguous_identity';
}>;

export type BankBalanceReconciliation = Readonly<{
  status:
    | 'reconciled'
    | 'provider_stale'
    | 'incomplete_history'
    | 'unresolved_pending'
    | 'material_mismatch'
    | 'unavailable';
  providerBalance: Money | null;
  canonicalBalance: Money | null;
  difference: Money | null;
  recommendationAllowed: boolean;
}>;
