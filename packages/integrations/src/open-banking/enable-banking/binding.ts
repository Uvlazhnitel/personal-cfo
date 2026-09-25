import { createHash } from 'node:crypto';

import {
  DomainValidationError,
  EUR,
  addMoney,
  compareInstants,
  createMoney,
  parseCurrencyCode,
  parseInstant,
  parseLocalDate,
  subtractMoney,
  type BankBalanceKind,
  type BankBalanceObservation,
  type BankBalanceReconciliation,
  type BankConsentState,
  type BankPendingBookedMatch,
  type BankProviderAccount,
  type BankTransactionObservation,
  type CurrencyCode,
  type Instant,
  type LocalDate,
  type Money,
} from '@personal-cfo/domain';

import {
  ENABLE_BANKING_ASPSP,
  ENABLE_BANKING_BALANCE_TYPES,
  ENABLE_BANKING_BINDING_VERSION,
  ENABLE_BANKING_PROVIDER_ID,
  ENABLE_BANKING_TRANSACTION_STATUSES,
  ENABLE_BANKING_SESSION_STATUSES,
  type EnableBankingAccountDto,
  type EnableBankingAccountDetailsDto,
  type EnableBankingAccountNormalization,
  type EnableBankingAmountDto,
  type EnableBankingAuthorizedSessionDto,
  type EnableBankingBalanceDto,
  type EnableBankingBalanceNormalization,
  type EnableBankingBalanceType,
  type EnableBankingBalancesDto,
  type EnableBankingAspspsDto,
  type EnableBankingAspspDto,
  type EnableBankingExactDecimal,
  type EnableBankingFieldClassification,
  type EnableBankingNormalizationContext,
  type EnableBankingProviderBinding,
  type EnableBankingTransactionDto,
  type EnableBankingTransactionNormalization,
  type EnableBankingTransactionStatus,
  type EnableBankingTransactionsDto,
  type EnableBankingSessionDto,
  type EnableBankingSessionStatus,
  type EnableBankingStartAuthorizationDto,
} from './types.js';

type UnknownRecord = Record<string, unknown>;

const EXACT_DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function invalid(code: string, message: string): never {
  throw new DomainValidationError(`enable_banking.${code}`, message);
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

function string(value: unknown, label: string, maximum = 4096): string {
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

function optionalString(value: unknown, label: string, maximum = 4096): string | null {
  return value === undefined || value === null ? null : string(value, label, maximum);
}

function uuid(value: unknown, label: string): string {
  const parsed = string(value, label, 36);
  if (!UUID_PATTERN.test(parsed)) return invalid('invalid_identifier', `${label} must be a UUID.`);
  return parsed.toLowerCase();
}

function stableHash(value: unknown, label: string): string {
  const parsed = string(value, label, 4096);
  if (/\s/u.test(parsed)) {
    return invalid('invalid_identifier', `${label} cannot contain whitespace.`);
  }
  return parsed;
}

function currency(value: unknown, label: string): CurrencyCode {
  try {
    return parseCurrencyCode(value);
  } catch {
    return invalid('invalid_currency', `${label} must be an uppercase ISO-4217 code.`);
  }
}

function exactDecimal(value: unknown, label: string): EnableBankingExactDecimal {
  if (typeof value !== 'string' || value.length > 128 || !EXACT_DECIMAL_PATTERN.test(value)) {
    return invalid('invalid_decimal', `${label} must be an exact non-exponent decimal string.`);
  }
  return value as EnableBankingExactDecimal;
}

function utcInstant(value: unknown, label: string): Instant {
  if (typeof value !== 'string') return invalid('invalid_instant', `${label} must be a timestamp.`);
  const normalized = value.endsWith('+00:00') ? `${value.slice(0, -6)}Z` : value;
  try {
    return parseInstant(normalized);
  } catch {
    return invalid('invalid_instant', `${label} must be an explicit UTC timestamp.`);
  }
}

function optionalInstant(value: unknown, label: string): Instant | null {
  return value === undefined || value === null ? null : utcInstant(value, label);
}

function localDate(value: unknown, label: string): LocalDate | null {
  if (value === undefined || value === null) return null;
  try {
    return parseLocalDate(value);
  } catch {
    return invalid('invalid_date', `${label} must be an ISO local date.`);
  }
}

function parseJson(rawJson: string): unknown {
  try {
    return JSON.parse(rawJson) as unknown;
  } catch {
    return invalid('invalid_json', 'Enable Banking payload must be valid JSON.');
  }
}

function amount(value: unknown, label: string): EnableBankingAmountDto {
  const item = record(value, label);
  return Object.freeze({
    amount: exactDecimal(item['amount'], `${label} amount`),
    currency: currency(item['currency'], `${label} currency`),
  });
}

function partyName(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return optionalString(record(value, label)['name'], `${label} name`, 512);
}

function accountHint(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  const item = record(value, label);
  return optionalString(item['iban'] ?? item['identification'], `${label} identity`, 256);
}

function parseAccount(value: unknown): EnableBankingAccountDto {
  const item = record(value, 'Session account');
  const identificationHash = stableHash(item['identification_hash'], 'Account identification hash');
  const hashesValue = item['identification_hashes'];
  const identificationHashes =
    hashesValue === undefined
      ? [identificationHash]
      : array(hashesValue, 'Account identification hashes').map((hash) =>
          stableHash(hash, 'Account identification hash'),
        );
  if (!identificationHashes.includes(identificationHash)) {
    return invalid(
      'account_identity_mismatch',
      'Primary account identification hash must be present in identification_hashes.',
    );
  }
  return Object.freeze({
    uid: uuid(item['uid'], 'Account UID'),
    identificationHash,
    identificationHashes: Object.freeze(identificationHashes),
    currency: currency(item['currency'], 'Account currency'),
    usage: optionalString(item['usage'], 'Account usage', 32),
    cashAccountType: optionalString(item['cash_account_type'], 'Cash account type', 32),
  });
}

function psuType(value: unknown, label: string): 'personal' | 'business' {
  if (value !== 'personal' && value !== 'business') {
    return invalid('invalid_psu_type', `${label} is unsupported.`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return invalid('invalid_integer', `${label} must be a positive integer.`);
  }
  return value;
}

function authenticationApproach(value: unknown): 'REDIRECT' | 'DECOUPLED' | 'EMBEDDED' {
  if (value !== 'REDIRECT' && value !== 'DECOUPLED' && value !== 'EMBEDDED') {
    return invalid('invalid_authentication_approach', 'ASPSP authentication approach is invalid.');
  }
  return value;
}

function parseAspsp(value: unknown): EnableBankingAspspDto {
  const item = record(value, 'ASPSP');
  const methods = array(item['auth_methods'] ?? [], 'ASPSP authentication methods').map(
    (method): EnableBankingAspspDto['authMethods'][number] => {
      const parsed = record(method, 'ASPSP authentication method');
      return Object.freeze({
        name: string(parsed['name'], 'Authentication method name', 128),
        psuType: psuType(parsed['psu_type'], 'Authentication method PSU type'),
        approach: authenticationApproach(parsed['approach']),
      });
    },
  );
  const psuTypes = array(item['psu_types'], 'ASPSP PSU types').map((value) =>
    psuType(value, 'ASPSP PSU type'),
  );
  return Object.freeze({
    name: string(item['name'], 'ASPSP name', 128),
    country: string(item['country'], 'ASPSP country', 2),
    psuTypes: Object.freeze(psuTypes),
    maximumConsentValiditySeconds: positiveInteger(
      item['maximum_consent_validity'],
      'Maximum consent validity',
    ),
    authMethods: Object.freeze(methods),
  });
}

export function decodeEnableBankingAspsps(rawJson: string): EnableBankingAspspsDto {
  const root = record(parseJson(rawJson), 'ASPSP response');
  return Object.freeze({
    aspsps: Object.freeze(array(root['aspsps'], 'ASPSPs').map(parseAspsp)),
  });
}

export function decodeEnableBankingStartAuthorization(
  rawJson: string,
): EnableBankingStartAuthorizationDto {
  const root = record(parseJson(rawJson), 'Authorization response');
  const url = string(root['url'], 'Authorization URL', 4096);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return invalid('invalid_authorization_url', 'Authorization URL is invalid.');
  }
  if (
    parsed.protocol !== 'https:' ||
    (parsed.hostname !== 'enablebanking.com' && !parsed.hostname.endsWith('.enablebanking.com'))
  ) {
    return invalid(
      'invalid_authorization_url',
      'Authorization URL must use an Enable Banking HTTPS origin.',
    );
  }
  return Object.freeze({
    url: parsed.toString(),
    authorizationId: uuid(root['authorization_id'], 'Authorization ID'),
    psuIdHash: optionalString(root['psu_id_hash'], 'PSU ID hash', 512),
  });
}

export function decodeEnableBankingAuthorizedSession(
  rawJson: string,
): EnableBankingAuthorizedSessionDto {
  const root = record(parseJson(rawJson), 'Authorized session');
  const aspsp = record(root['aspsp'], 'ASPSP');
  const access = record(root['access'], 'Session access');
  const parsedPsuType = psuType(root['psu_type'], 'Session PSU type');
  return Object.freeze({
    sessionId: uuid(root['session_id'], 'Session ID'),
    accounts: Object.freeze(array(root['accounts'], 'Session accounts').map(parseAccount)),
    aspsp: Object.freeze({
      name: string(aspsp['name'], 'ASPSP name', 128),
      country: string(aspsp['country'], 'ASPSP country', 2),
    }),
    psuType: parsedPsuType,
    validUntil: utcInstant(access['valid_until'], 'Consent expiry'),
  });
}

function sessionStatus(value: unknown): EnableBankingSessionStatus {
  if (!ENABLE_BANKING_SESSION_STATUSES.includes(value as EnableBankingSessionStatus)) {
    return invalid('invalid_session_status', 'Session status is unsupported.');
  }
  return value as EnableBankingSessionStatus;
}

export function decodeEnableBankingSession(rawJson: string): EnableBankingSessionDto {
  const root = record(parseJson(rawJson), 'Session response');
  const access = record(root['access'], 'Session access');
  const aspsp = record(root['aspsp'], 'Session ASPSP');
  return Object.freeze({
    status: sessionStatus(root['status']),
    accountAliases: Object.freeze(
      array(root['accounts_data'], 'Session account aliases').map((value) => {
        const alias = record(value, 'Session account alias');
        return Object.freeze({
          uid: uuid(alias['uid'], 'Session account UID'),
          identificationHash: stableHash(
            alias['identification_hash'],
            'Session account identification hash',
          ),
        });
      }),
    ),
    aspsp: Object.freeze({
      name: string(aspsp['name'], 'ASPSP name', 128),
      country: string(aspsp['country'], 'ASPSP country', 2),
    }),
    psuType: psuType(root['psu_type'], 'Session PSU type'),
    validUntil: utcInstant(access['valid_until'], 'Session expiry'),
    createdAt: utcInstant(root['created'], 'Session creation time'),
    authorizedAt: optionalInstant(root['authorized'], 'Session authorization time'),
    closedAt: optionalInstant(root['closed'], 'Session close time'),
  });
}

export function decodeEnableBankingAccountDetails(rawJson: string): EnableBankingAccountDetailsDto {
  const root = record(parseJson(rawJson), 'Account details');
  const account = parseAccount(root);
  const accountId = root['account_id'];
  let hint: string | null = null;
  if (accountId !== undefined && accountId !== null) {
    const identifier = record(accountId, 'Account identifier');
    hint = optionalString(
      identifier['iban'] ?? identifier['identification'],
      'Account identifier',
      256,
    );
  }
  return Object.freeze({
    ...account,
    displayName: optionalString(root['name'] ?? root['details'], 'Account display name', 512),
    accountHint: hint,
  });
}

export function assertEnableBankingSessionBinding(
  session: EnableBankingAuthorizedSessionDto,
): EnableBankingAuthorizedSessionDto {
  if (
    session.aspsp.name !== ENABLE_BANKING_ASPSP.name ||
    session.aspsp.country !== ENABLE_BANKING_ASPSP.country
  ) {
    return invalid('aspsp_mismatch', 'Session must belong to Swedbank Latvia.');
  }
  if (session.psuType !== 'personal') {
    return invalid('psu_type_mismatch', 'Session must belong to a personal PSU.');
  }
  const accountUids = new Set(session.accounts.map((account) => account.uid));
  const accountHashes = new Set(session.accounts.map((account) => account.identificationHash));
  if (
    accountUids.size !== session.accounts.length ||
    accountHashes.size !== session.accounts.length
  ) {
    return invalid('duplicate_account_identity', 'Session account identities must be unique.');
  }
  return session;
}

function balanceType(value: unknown): EnableBankingBalanceType {
  if (!ENABLE_BANKING_BALANCE_TYPES.includes(value as EnableBankingBalanceType)) {
    return invalid('invalid_balance_type', 'Balance type is unsupported.');
  }
  return value as EnableBankingBalanceType;
}

function parseBalance(value: unknown): EnableBankingBalanceDto {
  const item = record(value, 'Balance');
  return Object.freeze({
    name: string(item['name'], 'Balance name', 256),
    balanceAmount: amount(item['balance_amount'], 'Balance amount'),
    balanceType: balanceType(item['balance_type']),
    lastChangeDateTime: optionalInstant(item['last_change_date_time'], 'Balance change time'),
    referenceDate: localDate(item['reference_date'], 'Balance reference date')?.toString() ?? null,
    lastCommittedTransaction: optionalString(
      item['last_committed_transaction'],
      'Last committed transaction',
      512,
    ),
  });
}

export function decodeEnableBankingBalances(rawJson: string): EnableBankingBalancesDto {
  const root = record(parseJson(rawJson), 'Balances response');
  return Object.freeze({
    balances: Object.freeze(array(root['balances'], 'Balances').map(parseBalance)),
  });
}

function transactionStatus(value: unknown): EnableBankingTransactionStatus {
  if (!ENABLE_BANKING_TRANSACTION_STATUSES.includes(value as EnableBankingTransactionStatus)) {
    return invalid('invalid_transaction_status', 'Transaction status is unsupported.');
  }
  return value as EnableBankingTransactionStatus;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]);
  return Object.freeze(array(value, label).map((item) => string(item, label, 2048)));
}

function parseBankTransactionCode(
  value: unknown,
): EnableBankingTransactionDto['bankTransactionCode'] {
  if (value === undefined || value === null) return null;
  const item = record(value, 'Bank transaction code');
  return Object.freeze({
    description: optionalString(item['description'], 'Transaction code description', 512),
    code: optionalString(item['code'], 'Transaction code', 128),
    subCode: optionalString(item['sub_code'], 'Transaction sub-code', 128),
  });
}

function parseExchangeRate(value: unknown): EnableBankingTransactionDto['exchangeRate'] {
  if (value === undefined || value === null) return null;
  const item = record(value, 'Exchange rate');
  return Object.freeze({
    unitCurrency:
      item['unit_currency'] === undefined || item['unit_currency'] === null
        ? null
        : currency(item['unit_currency'], 'Exchange-rate unit currency'),
    exchangeRate:
      item['exchange_rate'] === undefined || item['exchange_rate'] === null
        ? null
        : exactDecimal(item['exchange_rate'], 'Exchange rate'),
    rateType: optionalString(item['rate_type'], 'Exchange-rate type', 32),
    instructedAmount:
      item['instructed_amount'] === undefined || item['instructed_amount'] === null
        ? null
        : amount(item['instructed_amount'], 'Instructed amount'),
  });
}

function parseTransaction(value: unknown): EnableBankingTransactionDto {
  const item = record(value, 'Transaction');
  const indicator = item['credit_debit_indicator'];
  if (indicator !== 'CRDT' && indicator !== 'DBIT') {
    return invalid('invalid_direction', 'Transaction credit/debit indicator is unsupported.');
  }
  return Object.freeze({
    entryReference: optionalString(item['entry_reference'], 'Entry reference', 512),
    merchantCategoryCode: optionalString(item['merchant_category_code'], 'Merchant category', 16),
    transactionAmount: amount(item['transaction_amount'], 'Transaction amount'),
    creditorName: partyName(item['creditor'], 'Creditor'),
    creditorAccountHint: accountHint(item['creditor_account'], 'Creditor account'),
    debtorName: partyName(item['debtor'], 'Debtor'),
    debtorAccountHint: accountHint(item['debtor_account'], 'Debtor account'),
    bankTransactionCode: parseBankTransactionCode(item['bank_transaction_code']),
    creditDebitIndicator: indicator,
    status: transactionStatus(item['status']),
    bookingDate: localDate(item['booking_date'], 'Booking date')?.toString() ?? null,
    valueDate: localDate(item['value_date'], 'Value date')?.toString() ?? null,
    transactionDate: localDate(item['transaction_date'], 'Transaction date')?.toString() ?? null,
    referenceNumber: optionalString(item['reference_number'], 'Reference number', 512),
    remittanceInformation: stringArray(item['remittance_information'], 'Remittance information'),
    exchangeRate: parseExchangeRate(item['exchange_rate']),
    transactionId: optionalString(item['transaction_id'], 'Provider transaction ID', 512),
  });
}

export function decodeEnableBankingTransactions(rawJson: string): EnableBankingTransactionsDto {
  const root = record(parseJson(rawJson), 'Transactions response');
  const continuation = root['continuation_key'];
  if (
    continuation !== undefined &&
    continuation !== null &&
    (typeof continuation !== 'string' ||
      continuation.length === 0 ||
      continuation.length > 4096 ||
      [...continuation].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 32 || codePoint === 127;
      }))
  ) {
    return invalid('invalid_continuation', 'Continuation key is malformed.');
  }
  return Object.freeze({
    transactions: Object.freeze(array(root['transactions'], 'Transactions').map(parseTransaction)),
    continuationKey: continuation === undefined || continuation === null ? null : continuation,
  });
}

export function enableBankingDecimalToExactMinor(value: EnableBankingExactDecimal): bigint {
  if (!EXACT_DECIMAL_PATTERN.test(value)) {
    return invalid('invalid_decimal', 'Amount must be an exact non-exponent decimal string.');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '0', fraction = ''] = unsigned.split('.');
  if (fraction.slice(2).replace(/0/gu, '') !== '') {
    return invalid('subminor_amount', 'EUR amount cannot contain non-zero sub-cent precision.');
  }
  const minor = BigInt(whole) * 100n + BigInt((fraction.slice(0, 2) + '00').slice(0, 2));
  return createMoney(negative ? -minor : minor, EUR).amountMinor;
}

function moneyFromAmount(value: EnableBankingAmountDto, signedDirection?: 'CRDT' | 'DBIT'): Money {
  const parsedCurrency = parseCurrencyCode(value.currency);
  if (parsedCurrency !== EUR) {
    return invalid(
      'unsupported_money_currency',
      'Stage 8 can construct authoritative money only for EUR account movements.',
    );
  }
  const unsignedMinor = enableBankingDecimalToExactMinor(value.amount);
  if (signedDirection !== undefined && unsignedMinor <= 0n) {
    return invalid(
      'invalid_transaction_amount',
      'Transaction amount must be positive and non-zero.',
    );
  }
  return createMoney(signedDirection === 'DBIT' ? -unsignedMinor : unsignedMinor, EUR);
}

export function normalizeEnableBankingAccount(
  providerAccount: EnableBankingAccountDto,
  context: EnableBankingNormalizationContext,
): EnableBankingAccountNormalization {
  const account: BankProviderAccount = Object.freeze({
    authority: 'provider_account_observation',
    connection: context.connection,
    accountId: context.accountId,
    providerAccountUid: providerAccount.uid,
    stableAccountIdentity: providerAccount.identificationHash,
    currency: parseCurrencyCode(providerAccount.currency),
  });
  return account.currency === EUR
    ? Object.freeze({ status: 'activated', account })
    : Object.freeze({ status: 'blocked', account, category: 'enable_banking_non_eur_account' });
}

const BALANCE_KIND: Readonly<Record<EnableBankingBalanceType, BankBalanceKind>> = Object.freeze({
  CLAV: 'closing_available',
  CLBD: 'closing_booked',
  FWAV: 'forward_available',
  INFO: 'information',
  ITAV: 'interim_available',
  ITBD: 'interim_booked',
  OPAV: 'opening_available',
  OPBD: 'opening_booked',
  OTHR: 'other',
  PRCD: 'previously_closed_booked',
  VALU: 'value_date',
});

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function balanceSortKey(balance: BankBalanceObservation): string {
  return balance.lastChangedAt ?? `${balance.referenceDate ?? '0000-00-00'}T00:00:00Z`;
}

export function normalizeEnableBankingBalances(
  providerBalances: EnableBankingBalancesDto,
  account: BankProviderAccount,
): EnableBankingBalanceNormalization {
  if (account.currency !== EUR) {
    return invalid('non_eur_account', 'Only EUR account balances can be normalized in Stage 8.');
  }
  const balances = providerBalances.balances.map((item): BankBalanceObservation => {
    const amountValue = moneyFromAmount(item.balanceAmount);
    if (amountValue.currency !== account.currency) {
      return invalid(
        'balance_currency_mismatch',
        'Balance currency must match the account currency.',
      );
    }
    const sourceId = `${account.stableAccountIdentity}:${item.balanceType}`;
    return Object.freeze({
      authority: 'provider_balance_observation',
      account,
      kind: BALANCE_KIND[item.balanceType],
      amount: amountValue,
      lastChangedAt: item.lastChangeDateTime,
      referenceDate: item.referenceDate === null ? null : parseLocalDate(item.referenceDate),
      lastCommittedSourceId: item.lastCommittedTransaction,
      revision: Object.freeze({
        sourceId,
        fingerprint: sha256([
          'enable-banking-balance-v1',
          sourceId,
          item.balanceAmount.amount,
          item.balanceAmount.currency,
          item.lastChangeDateTime,
          item.referenceDate,
          item.lastCommittedTransaction,
        ]),
      }),
    });
  });
  const authoritativeBooked =
    [...balances]
      .filter((item) => item.kind === 'interim_booked' || item.kind === 'closing_booked')
      .sort((left, right) => {
        const keyComparison = balanceSortKey(right).localeCompare(balanceSortKey(left));
        if (keyComparison !== 0) return keyComparison;
        return left.kind === right.kind ? 0 : left.kind === 'interim_booked' ? -1 : 1;
      })[0] ?? null;
  return Object.freeze({ balances: Object.freeze(balances), authoritativeBooked });
}

const STATUS_MAP: Readonly<
  Record<EnableBankingTransactionStatus, BankTransactionObservation['status']>
> = Object.freeze({
  BOOK: 'booked',
  CNCL: 'cancelled',
  HOLD: 'hold',
  OTHR: 'other',
  PDNG: 'pending',
  RJCT: 'rejected',
  SCHD: 'scheduled',
});

function transactionFingerprint(
  providerTransaction: EnableBankingTransactionDto,
  account: BankProviderAccount,
): string {
  return sha256([
    'enable-banking-transaction-v1',
    account.stableAccountIdentity,
    providerTransaction.entryReference,
    providerTransaction.status,
    providerTransaction.creditDebitIndicator,
    providerTransaction.transactionAmount.amount,
    providerTransaction.transactionAmount.currency,
    providerTransaction.bookingDate,
    providerTransaction.valueDate,
    providerTransaction.transactionDate,
    providerTransaction.creditorName,
    providerTransaction.creditorAccountHint,
    providerTransaction.debtorName,
    providerTransaction.debtorAccountHint,
    providerTransaction.bankTransactionCode,
    providerTransaction.referenceNumber,
    providerTransaction.remittanceInformation,
    providerTransaction.merchantCategoryCode,
    providerTransaction.exchangeRate,
  ]);
}

export function normalizeEnableBankingTransaction(
  providerTransaction: EnableBankingTransactionDto,
  account: BankProviderAccount,
): EnableBankingTransactionNormalization {
  if (account.currency !== EUR) {
    return Object.freeze({
      status: 'quarantined',
      observation: null,
      category: 'enable_banking_non_eur_account',
    });
  }
  if (providerTransaction.transactionAmount.currency !== account.currency) {
    return Object.freeze({
      status: 'quarantined',
      observation: null,
      category: 'enable_banking_transaction_currency_mismatch',
    });
  }
  const status = STATUS_MAP[providerTransaction.status];
  const sourceId =
    providerTransaction.entryReference === null
      ? null
      : `${account.stableAccountIdentity}:${providerTransaction.entryReference}`;
  const direction = providerTransaction.creditDebitIndicator === 'CRDT' ? 'credit' : 'debit';
  const counterpartyName =
    direction === 'debit' ? providerTransaction.creditorName : providerTransaction.debtorName;
  const counterpartyAccountHint =
    direction === 'debit'
      ? providerTransaction.creditorAccountHint
      : providerTransaction.debtorAccountHint;
  const instructed = providerTransaction.exchangeRate?.instructedAmount ?? null;
  const observation: BankTransactionObservation = Object.freeze({
    authority: 'provider_transaction_observation',
    account,
    sourceId,
    providerTransactionId: providerTransaction.transactionId,
    status,
    direction,
    amount: moneyFromAmount(
      providerTransaction.transactionAmount,
      providerTransaction.creditDebitIndicator,
    ),
    bookingDate:
      providerTransaction.bookingDate === null
        ? null
        : parseLocalDate(providerTransaction.bookingDate),
    valueDate:
      providerTransaction.valueDate === null ? null : parseLocalDate(providerTransaction.valueDate),
    transactionDate:
      providerTransaction.transactionDate === null
        ? null
        : parseLocalDate(providerTransaction.transactionDate),
    counterpartyName,
    counterpartyAccountHint,
    remittance: providerTransaction.remittanceInformation,
    referenceNumber: providerTransaction.referenceNumber,
    merchantCategoryCode: providerTransaction.merchantCategoryCode,
    bankTransactionCode: providerTransaction.bankTransactionCode,
    originalAmount:
      instructed === null
        ? null
        : Object.freeze({
            exactAmount: instructed.amount,
            currency: parseCurrencyCode(instructed.currency),
            exactExchangeRate: providerTransaction.exchangeRate?.exchangeRate ?? null,
            unitCurrency:
              providerTransaction.exchangeRate?.unitCurrency === null ||
              providerTransaction.exchangeRate?.unitCurrency === undefined
                ? null
                : parseCurrencyCode(providerTransaction.exchangeRate.unitCurrency),
            rateType: providerTransaction.exchangeRate?.rateType ?? null,
          }),
    canonicalization:
      sourceId === null
        ? 'quarantined_unstable_identity'
        : status === 'booked'
          ? 'eligible_booked'
          : status === 'pending' || status === 'hold'
            ? 'pending_projection_only'
            : 'terminal_observation_only',
    revision: Object.freeze({
      sourceId,
      fingerprint: transactionFingerprint(providerTransaction, account),
    }),
  });
  return sourceId === null
    ? Object.freeze({
        status: 'quarantined',
        observation,
        category: 'enable_banking_missing_stable_transaction_identity',
      })
    : Object.freeze({ status: 'normalized', observation });
}

function dateForMatch(observation: BankTransactionObservation): LocalDate | null {
  return observation.bookingDate ?? observation.valueDate ?? observation.transactionDate;
}

function daysBetween(left: LocalDate, right: LocalDate): number {
  const leftMs = Date.parse(`${left}T00:00:00Z`);
  const rightMs = Date.parse(`${right}T00:00:00Z`);
  return Math.abs(leftMs - rightMs) / 86_400_000;
}

function normalizedText(value: string | null): string | null {
  return value?.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en') ?? null;
}

export function matchEnableBankingPendingToBooked(
  pending: BankTransactionObservation,
  booked: BankTransactionObservation,
): BankPendingBookedMatch {
  if (
    pending.account.stableAccountIdentity !== booked.account.stableAccountIdentity ||
    pending.account.connection.connectionId !== booked.account.connection.connectionId
  ) {
    return Object.freeze({ state: 'unmatched', reason: 'incompatible_account' });
  }
  if (
    (pending.status !== 'pending' && pending.status !== 'hold') ||
    booked.status !== 'booked' ||
    pending.direction !== booked.direction ||
    pending.amount.currency !== booked.amount.currency ||
    pending.amount.amountMinor !== booked.amount.amountMinor
  ) {
    return Object.freeze({ state: 'unmatched', reason: 'incompatible_economics' });
  }
  if (pending.sourceId !== null && pending.sourceId === booked.sourceId) {
    return Object.freeze({ state: 'confirmed_revision', reason: 'same_stable_source' });
  }
  const pendingDate = dateForMatch(pending);
  const bookedDate = dateForMatch(booked);
  const sameCode =
    pending.bankTransactionCode?.code === null ||
    pending.bankTransactionCode?.code === undefined ||
    booked.bankTransactionCode?.code === null ||
    booked.bankTransactionCode?.code === undefined ||
    pending.bankTransactionCode.code === booked.bankTransactionCode.code;
  const sameCounterparty =
    normalizedText(pending.counterpartyName) === null ||
    normalizedText(booked.counterpartyName) === null ||
    normalizedText(pending.counterpartyName) === normalizedText(booked.counterpartyName);
  const sameReference =
    normalizedText(pending.referenceNumber) === null ||
    normalizedText(booked.referenceNumber) === null ||
    normalizedText(pending.referenceNumber) === normalizedText(booked.referenceNumber);
  if (
    pendingDate === null ||
    bookedDate === null ||
    daysBetween(pendingDate, bookedDate) > 7 ||
    !sameCode ||
    !sameCounterparty ||
    !sameReference
  ) {
    return Object.freeze({ state: 'unmatched', reason: 'missing_or_ambiguous_identity' });
  }
  return Object.freeze({ state: 'candidate', reason: 'bounded_exact_candidate' });
}

export function reconcileEnableBankingBalance(
  input: Readonly<{
    providerBalance: BankBalanceObservation | null;
    canonicalBalance: Money | null;
    materialityThreshold: Money;
    historyComplete: boolean;
    unresolvedPending: boolean;
    providerStale: boolean;
  }>,
): BankBalanceReconciliation {
  if (input.providerBalance === null || input.canonicalBalance === null) {
    return Object.freeze({
      status: 'unavailable',
      providerBalance: input.providerBalance?.amount ?? null,
      canonicalBalance: input.canonicalBalance,
      difference: null,
      recommendationAllowed: false,
    });
  }
  const difference = subtractMoney(input.providerBalance.amount, input.canonicalBalance);
  addMoney(difference, input.materialityThreshold);
  const common = {
    providerBalance: input.providerBalance.amount,
    canonicalBalance: input.canonicalBalance,
    difference,
  } as const;
  if (input.providerStale) {
    return Object.freeze({ ...common, status: 'provider_stale', recommendationAllowed: false });
  }
  if (!input.historyComplete) {
    return Object.freeze({ ...common, status: 'incomplete_history', recommendationAllowed: false });
  }
  if (input.unresolvedPending) {
    return Object.freeze({ ...common, status: 'unresolved_pending', recommendationAllowed: false });
  }
  if (input.materialityThreshold.amountMinor < 0n) {
    return invalid('invalid_materiality', 'Materiality threshold cannot be negative.');
  }
  const absoluteDifference =
    difference.amountMinor < 0n ? -difference.amountMinor : difference.amountMinor;
  if (absoluteDifference > input.materialityThreshold.amountMinor) {
    return Object.freeze({ ...common, status: 'material_mismatch', recommendationAllowed: false });
  }
  return Object.freeze({ ...common, status: 'reconciled', recommendationAllowed: true });
}

export type EnableBankingConsentEvent =
  | 'authorization_started'
  | 'authorization_succeeded'
  | 'authorization_cancelled'
  | 'session_expired'
  | 'provider_error'
  | 'session_revoked';

export function transitionEnableBankingConsent(
  current: BankConsentState,
  event: EnableBankingConsentEvent,
): BankConsentState {
  if (event === 'authorization_started') return 'connecting';
  if (event === 'authorization_succeeded') return 'active';
  if (event === 'session_expired') return 'reauth_required';
  if (event === 'session_revoked') return 'revoked';
  if (event === 'authorization_cancelled') return 'disconnected';
  if (current === 'revoked') return 'revoked';
  return 'error';
}

export const ENABLE_BANKING_FIELD_CLASSIFICATION = Object.freeze({
  accountIdentity: 'DIRECT',
  accountCurrency: 'DIRECT',
  currentBalance: 'DIRECT',
  availableBalance: 'DIRECT',
  bookedTransactions: 'DIRECT',
  pendingTransactions: 'DIRECT',
  stableTransactionIds: 'AMBIGUOUS',
  pendingBookedRelationship: 'UNAVAILABLE',
  transactionStatus: 'DIRECT',
  bookingDate: 'DIRECT',
  valueDate: 'DIRECT',
  transactionDate: 'DIRECT',
  amount: 'DIRECT',
  currency: 'DIRECT',
  counterparty: 'DIRECT',
  remittance: 'DIRECT',
  bankTransactionCode: 'DIRECT',
  rawPayload: 'DIRECT',
  corrections: 'DERIVED',
  reversals: 'AMBIGUOUS',
  deletions: 'UNAVAILABLE',
  incrementalCursor: 'UNAVAILABLE',
  pagination: 'DIRECT',
  historicalRange: 'AMBIGUOUS',
  accountList: 'DIRECT',
  consentIdentity: 'DIRECT',
  consentExpiration: 'DIRECT',
  consentRenewal: 'DERIVED',
  reconnection: 'DERIVED',
  rateLimits: 'UNAVAILABLE',
  retries: 'DERIVED',
  webhooks: 'DIRECT',
  polling: 'DIRECT',
  sandbox: 'DIRECT',
  restrictedProductionAccess: 'DIRECT',
  disconnectRevocation: 'DIRECT',
  dataDeletion: 'DERIVED',
  providerRetention: 'AMBIGUOUS',
} as const satisfies Readonly<Record<string, EnableBankingFieldClassification>>);

export const ENABLE_BANKING_BINDING: EnableBankingProviderBinding = Object.freeze({
  provider: ENABLE_BANKING_PROVIDER_ID,
  version: ENABLE_BANKING_BINDING_VERSION,
  aspsp: ENABLE_BANKING_ASPSP,
  authentication: Object.freeze({
    kind: 'rs256_application_jwt',
    audience: 'api.enablebanking.com',
    maximumJwtTtlSeconds: 86_400,
  }),
  endpoints: Object.freeze({
    aspsps: '/aspsps',
    startAuthorization: '/auth',
    authorizeSession: '/sessions',
    session: '/sessions/{session_id}',
    accountDetails: '/accounts/{account_id}/details',
    balances: '/accounts/{account_id}/balances',
    transactions: '/accounts/{account_id}/transactions',
  }),
  transactionFetch: Object.freeze({
    initialStrategy: 'longest',
    recurringStrategy: 'default',
    continuationScope: 'current_session_only',
  }),
  paymentInitiation: false,
});

export function isSha256Fingerprint(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function isNewerBalance(
  candidate: BankBalanceObservation,
  current: BankBalanceObservation,
): boolean {
  if (candidate.lastChangedAt !== null && current.lastChangedAt !== null) {
    return compareInstants(candidate.lastChangedAt, current.lastChangedAt) > 0;
  }
  return balanceSortKey(candidate) > balanceSortKey(current);
}
