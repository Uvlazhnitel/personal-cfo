import type {
  AccountId,
  BankBalanceObservation,
  BankConnectionIdentity,
  BankProviderAccount,
  BankTransactionObservation,
  Instant,
} from '@personal-cfo/domain';

export const ENABLE_BANKING_PROVIDER_ID = 'enable-banking';
export const ENABLE_BANKING_BINDING_VERSION = 'enable-banking-swedbank-lv-v1';
export const ENABLE_BANKING_NORMALIZATION_VERSION = 'enable-banking-normalization-v1';
export const ENABLE_BANKING_ASPSP = Object.freeze({ name: 'Swedbank', country: 'LV' } as const);

export type EnableBankingFieldClassification = 'DIRECT' | 'DERIVED' | 'UNAVAILABLE' | 'AMBIGUOUS';

export type EnableBankingExactDecimal = string & {
  readonly __enableBankingExactDecimal: unique symbol;
};

export type EnableBankingAmountDto = Readonly<{
  amount: EnableBankingExactDecimal;
  currency: string;
}>;

export type EnableBankingAccountDto = Readonly<{
  uid: string;
  identificationHash: string;
  identificationHashes: readonly string[];
  currency: string;
  usage: string | null;
  cashAccountType: string | null;
}>;

export type EnableBankingAuthorizedSessionDto = Readonly<{
  sessionId: string;
  accounts: readonly EnableBankingAccountDto[];
  aspsp: Readonly<{ name: string; country: string }>;
  psuType: 'personal' | 'business';
  validUntil: Instant;
}>;

export const ENABLE_BANKING_BALANCE_TYPES = [
  'CLAV',
  'CLBD',
  'FWAV',
  'INFO',
  'ITAV',
  'ITBD',
  'OPAV',
  'OPBD',
  'OTHR',
  'PRCD',
  'VALU',
] as const;

export type EnableBankingBalanceType = (typeof ENABLE_BANKING_BALANCE_TYPES)[number];

export type EnableBankingBalanceDto = Readonly<{
  name: string;
  balanceAmount: EnableBankingAmountDto;
  balanceType: EnableBankingBalanceType;
  lastChangeDateTime: Instant | null;
  referenceDate: string | null;
  lastCommittedTransaction: string | null;
}>;

export type EnableBankingBalancesDto = Readonly<{
  balances: readonly EnableBankingBalanceDto[];
}>;

export const ENABLE_BANKING_TRANSACTION_STATUSES = [
  'BOOK',
  'CNCL',
  'HOLD',
  'OTHR',
  'PDNG',
  'RJCT',
  'SCHD',
] as const;

export type EnableBankingTransactionStatus = (typeof ENABLE_BANKING_TRANSACTION_STATUSES)[number];

export type EnableBankingTransactionDto = Readonly<{
  entryReference: string | null;
  merchantCategoryCode: string | null;
  transactionAmount: EnableBankingAmountDto;
  creditorName: string | null;
  creditorAccountHint: string | null;
  debtorName: string | null;
  debtorAccountHint: string | null;
  bankTransactionCode: Readonly<{
    description: string | null;
    code: string | null;
    subCode: string | null;
  }> | null;
  creditDebitIndicator: 'CRDT' | 'DBIT';
  status: EnableBankingTransactionStatus;
  bookingDate: string | null;
  valueDate: string | null;
  transactionDate: string | null;
  referenceNumber: string | null;
  remittanceInformation: readonly string[];
  exchangeRate: Readonly<{
    unitCurrency: string | null;
    exchangeRate: EnableBankingExactDecimal | null;
    rateType: string | null;
    instructedAmount: EnableBankingAmountDto | null;
  }> | null;
  transactionId: string | null;
}>;

export type EnableBankingTransactionsDto = Readonly<{
  transactions: readonly EnableBankingTransactionDto[];
  continuationKey: string | null;
}>;

export type EnableBankingNormalizationContext = Readonly<{
  connection: BankConnectionIdentity;
  accountId: AccountId;
  receivedAt: Instant;
}>;

export type EnableBankingAccountNormalization =
  | Readonly<{ status: 'activated'; account: BankProviderAccount }>
  | Readonly<{
      status: 'blocked';
      account: BankProviderAccount;
      category: 'enable_banking_non_eur_account';
    }>;

export type EnableBankingTransactionNormalization =
  | Readonly<{ status: 'normalized'; observation: BankTransactionObservation }>
  | Readonly<{
      status: 'quarantined';
      observation: BankTransactionObservation | null;
      category:
        | 'enable_banking_missing_stable_transaction_identity'
        | 'enable_banking_non_eur_account'
        | 'enable_banking_transaction_currency_mismatch';
    }>;

export type EnableBankingBalanceNormalization = Readonly<{
  balances: readonly BankBalanceObservation[];
  authoritativeBooked: BankBalanceObservation | null;
}>;

export type EnableBankingProviderBinding = Readonly<{
  provider: typeof ENABLE_BANKING_PROVIDER_ID;
  version: typeof ENABLE_BANKING_BINDING_VERSION;
  aspsp: typeof ENABLE_BANKING_ASPSP;
  authentication: Readonly<{
    kind: 'rs256_application_jwt';
    audience: 'api.enablebanking.com';
    maximumJwtTtlSeconds: 86_400;
  }>;
  endpoints: Readonly<{
    aspsps: '/aspsps';
    startAuthorization: '/auth';
    authorizeSession: '/sessions';
    session: '/sessions/{session_id}';
    balances: '/accounts/{account_id}/balances';
    transactions: '/accounts/{account_id}/transactions';
  }>;
  transactionFetch: Readonly<{
    initialStrategy: 'longest';
    recurringStrategy: 'default';
    continuationScope: 'current_session_only';
  }>;
  paymentInitiation: false;
}>;
