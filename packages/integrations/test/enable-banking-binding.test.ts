import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  EUR,
  createMoney,
  parseInstant,
  type AccountEntry,
  type BankProviderAccount,
} from '@personal-cfo/domain';

import {
  ENABLE_BANKING_BINDING,
  ENABLE_BANKING_CONTRACT_FIXTURES,
  ENABLE_BANKING_FIELD_CLASSIFICATION,
  assertEnableBankingSessionBinding,
  decodeEnableBankingAuthorizedSession,
  decodeEnableBankingBalances,
  decodeEnableBankingTransactions,
  enableBankingDecimalToExactMinor,
  isNewerBalance,
  isSha256Fingerprint,
  matchEnableBankingPendingToBooked,
  normalizeEnableBankingAccount,
  normalizeEnableBankingBalances,
  normalizeEnableBankingTransaction,
  reconcileEnableBankingBalance,
  transitionEnableBankingConsent,
  type EnableBankingExactDecimal,
} from '../src/open-banking/enable-banking/index.js';
import type { ConfirmedContributionPrincipal } from '../src/portfolio/types.js';

const context = {
  connection: {
    provider: 'enable-banking',
    connectionId: 'connection-fixture',
    generation: 'generation-1',
  },
  accountId: '018f0000-0000-7000-8000-000000000802' as never,
  receivedAt: parseInstant('2026-09-24T08:01:00Z'),
} as const;

function fixtureAccount(): BankProviderAccount {
  const session = decodeEnableBankingAuthorizedSession(ENABLE_BANKING_CONTRACT_FIXTURES.session);
  const normalized = normalizeEnableBankingAccount(session.accounts[0]!, context);
  if (normalized.status !== 'activated') throw new Error('Expected activated EUR account.');
  return normalized.account;
}

function decodeOne(value: Record<string, unknown>) {
  return decodeEnableBankingTransactions(
    JSON.stringify({ transactions: [value], continuation_key: null }),
  ).transactions[0]!;
}

describe('Enable Banking Swedbank Latvia contract binding', () => {
  it('binds only personal Swedbank Latvia AIS and excludes payment initiation', () => {
    expect(ENABLE_BANKING_BINDING).toMatchObject({
      provider: 'enable-banking',
      version: 'enable-banking-swedbank-lv-v1',
      aspsp: { name: 'Swedbank', country: 'LV' },
      authentication: { kind: 'rs256_application_jwt', maximumJwtTtlSeconds: 86_400 },
      transactionFetch: {
        initialStrategy: 'longest',
        recurringStrategy: 'default',
        continuationScope: 'current_session_only',
      },
      paymentInitiation: false,
    });
    expect(ENABLE_BANKING_FIELD_CLASSIFICATION.stableTransactionIds).toBe('AMBIGUOUS');
    expect(ENABLE_BANKING_FIELD_CLASSIFICATION.deletions).toBe('UNAVAILABLE');
    expect(ENABLE_BANKING_FIELD_CLASSIFICATION.restrictedProductionAccess).toBe('DIRECT');
  });

  it('decodes the authorized session and activates exactly an EUR account observation', () => {
    const session = decodeEnableBankingAuthorizedSession(ENABLE_BANKING_CONTRACT_FIXTURES.session);
    expect(session).toMatchObject({
      aspsp: { name: 'Swedbank', country: 'LV' },
      psuType: 'personal',
      validUntil: '2027-03-23T12:00:00Z',
    });
    expect(session.accounts).toHaveLength(1);
    expect(assertEnableBankingSessionBinding(session)).toBe(session);
    const normalized = normalizeEnableBankingAccount(session.accounts[0]!, context);
    expect(normalized).toMatchObject({
      status: 'activated',
      account: {
        authority: 'provider_account_observation',
        stableAccountIdentity: 'synthetic-account-hash.lv.v1',
        currency: 'EUR',
      },
    });
  });

  it('rejects another ASPSP, business consent, and duplicate account identities', () => {
    const session = decodeEnableBankingAuthorizedSession(ENABLE_BANKING_CONTRACT_FIXTURES.session);
    expect(() =>
      assertEnableBankingSessionBinding({
        ...session,
        aspsp: { name: 'Another Bank', country: 'LV' },
      }),
    ).toThrow('Swedbank Latvia');
    expect(() => assertEnableBankingSessionBinding({ ...session, psuType: 'business' })).toThrow(
      'personal PSU',
    );
    expect(() =>
      assertEnableBankingSessionBinding({
        ...session,
        accounts: [session.accounts[0]!, session.accounts[0]!],
      }),
    ).toThrow('unique');
  });

  it('blocks non-EUR activation and rejects inconsistent account hashes', () => {
    const session = decodeEnableBankingAuthorizedSession(ENABLE_BANKING_CONTRACT_FIXTURES.session);
    expect(
      normalizeEnableBankingAccount({ ...session.accounts[0]!, currency: 'USD' }, context),
    ).toMatchObject({ status: 'blocked', category: 'enable_banking_non_eur_account' });
    const malformed = JSON.parse(ENABLE_BANKING_CONTRACT_FIXTURES.session) as Record<
      string,
      unknown
    >;
    const accounts = malformed['accounts'] as Array<Record<string, unknown>>;
    accounts[0]!['identification_hashes'] = ['different-hash'];
    expect(() => decodeEnableBankingAuthorizedSession(JSON.stringify(malformed))).toThrow(
      'identification hash',
    );
  });

  it('selects the newest booked balance and keeps available cash non-authoritative', () => {
    const normalized = normalizeEnableBankingBalances(
      decodeEnableBankingBalances(ENABLE_BANKING_CONTRACT_FIXTURES.balances),
      fixtureAccount(),
    );
    expect(normalized.balances).toHaveLength(3);
    expect(normalized.authoritativeBooked).toMatchObject({
      kind: 'interim_booked',
      amount: { amountMinor: 122_222n, currency: 'EUR' },
    });
    const closing = normalized.balances.find((balance) => balance.kind === 'closing_booked')!;
    expect(isNewerBalance(normalized.authoritativeBooked!, closing)).toBe(true);
    expect(normalized.balances.find((balance) => balance.kind === 'interim_available')?.kind).toBe(
      'interim_available',
    );
  });

  it('preserves page continuation even when a provider page is empty', () => {
    const page = decodeEnableBankingTransactions(
      ENABLE_BANKING_CONTRACT_FIXTURES.emptyContinuationPage,
    );
    expect(page.transactions).toEqual([]);
    expect(page.continuationKey).toBe('synthetic-page-3');
    expect(
      decodeEnableBankingTransactions(ENABLE_BANKING_CONTRACT_FIXTURES.finalPage).continuationKey,
    ).toBeNull();
  });

  it('normalizes booked debits as evidence without constructing ledger authority', () => {
    const page = decodeEnableBankingTransactions(ENABLE_BANKING_CONTRACT_FIXTURES.firstPage);
    const normalized = normalizeEnableBankingTransaction(page.transactions[0]!, fixtureAccount());
    expect(normalized).toMatchObject({
      status: 'normalized',
      observation: {
        authority: 'provider_transaction_observation',
        status: 'booked',
        direction: 'debit',
        amount: { amountMinor: -1234n, currency: 'EUR' },
        canonicalization: 'eligible_booked',
      },
    });
    if (normalized.status !== 'normalized') throw new Error('Expected normalized transaction.');
    expect(isSha256Fingerprint(normalized.observation.revision.fingerprint)).toBe(true);
    expectTypeOf(normalized.observation).not.toMatchTypeOf<AccountEntry>();
    expectTypeOf(normalized.observation).not.toMatchTypeOf<ConfirmedContributionPrincipal>();
  });

  it('retains original-currency metadata while EUR account movement remains authoritative money', () => {
    const page = decodeEnableBankingTransactions(ENABLE_BANKING_CONTRACT_FIXTURES.firstPage);
    const normalized = normalizeEnableBankingTransaction(page.transactions[6]!, fixtureAccount());
    expect(normalized).toMatchObject({
      status: 'normalized',
      observation: {
        amount: { amountMinor: -1000n, currency: 'EUR' },
        originalAmount: {
          exactAmount: '10.99',
          currency: 'USD',
          exactExchangeRate: '0.91000000',
          unitCurrency: 'EUR',
        },
      },
    });
  });

  it('uses exact bigint minor conversion and rejects exponent, sub-cent, and overflow amounts', () => {
    const exact = (value: string) => value as EnableBankingExactDecimal;
    expect(enableBankingDecimalToExactMinor(exact('12.3400'))).toBe(1234n);
    expect(enableBankingDecimalToExactMinor(exact('-12.34'))).toBe(-1234n);
    expect(() => enableBankingDecimalToExactMinor(exact('12.345'))).toThrow('sub-cent');
    expect(() => enableBankingDecimalToExactMinor(exact('1e2'))).toThrow('non-exponent');

    const exponent = { ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard } as Record<
      string,
      unknown
    >;
    exponent['transaction_amount'] = { amount: '1e2', currency: 'EUR' };
    expect(() => decodeOne(exponent)).toThrow('non-exponent');

    const overflow = { ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard } as Record<
      string,
      unknown
    >;
    overflow['transaction_amount'] = { amount: '92233720368547758.08', currency: 'EUR' };
    expect(() => normalizeEnableBankingTransaction(decodeOne(overflow), fixtureAccount())).toThrow(
      'BIGINT',
    );
  });

  it('quarantines missing stable identity and transaction/account currency conflicts', () => {
    const missing = { ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard } as Record<
      string,
      unknown
    >;
    delete missing['entry_reference'];
    expect(normalizeEnableBankingTransaction(decodeOne(missing), fixtureAccount())).toMatchObject({
      status: 'quarantined',
      category: 'enable_banking_missing_stable_transaction_identity',
      observation: { canonicalization: 'quarantined_unstable_identity' },
    });

    const mismatch = { ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard } as Record<
      string,
      unknown
    >;
    mismatch['transaction_amount'] = { amount: '12.34', currency: 'USD' };
    expect(normalizeEnableBankingTransaction(decodeOne(mismatch), fixtureAccount())).toMatchObject({
      status: 'quarantined',
      category: 'enable_banking_transaction_currency_mismatch',
      observation: null,
    });
  });

  it('confirms same-source pending to booked only as a revision', () => {
    const account = fixtureAccount();
    const pendingResult = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.pendingCard }),
      account,
    );
    const bookedResult = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard }),
      account,
    );
    if (pendingResult.status !== 'normalized' || bookedResult.status !== 'normalized') {
      throw new Error('Expected normalized observations.');
    }
    expect(pendingResult.observation.canonicalization).toBe('pending_projection_only');
    expect(
      matchEnableBankingPendingToBooked(pendingResult.observation, bookedResult.observation),
    ).toEqual({ state: 'confirmed_revision', reason: 'same_stable_source' });
  });

  it('classifies exact source/fingerprint replay and same-source cancellation revision', () => {
    const account = fixtureAccount();
    const original = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard }),
      account,
    );
    const replay = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard }),
      account,
    );
    const cancelled = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard, status: 'CNCL' }),
      account,
    );
    if (
      original.status !== 'normalized' ||
      replay.status !== 'normalized' ||
      cancelled.status !== 'normalized'
    ) {
      throw new Error('Expected normalized observations.');
    }
    expect(replay.observation.sourceId).toBe(original.observation.sourceId);
    expect(replay.observation.revision.fingerprint).toBe(original.observation.revision.fingerprint);
    expect(cancelled.observation.sourceId).toBe(original.observation.sourceId);
    expect(cancelled.observation.revision.fingerprint).not.toBe(
      original.observation.revision.fingerprint,
    );
    expect(cancelled.observation.canonicalization).toBe('terminal_observation_only');
  });

  it('keeps changed-ID pending to booked as a bounded candidate, never authority', () => {
    const account = fixtureAccount();
    const pending = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.pendingCard }),
      account,
    );
    const booked = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.changedIdBookedCard }),
      account,
    );
    if (pending.status !== 'normalized' || booked.status !== 'normalized') {
      throw new Error('Expected normalized observations.');
    }
    expect(matchEnableBankingPendingToBooked(pending.observation, booked.observation)).toEqual({
      state: 'candidate',
      reason: 'bounded_exact_candidate',
    });
    const altered = {
      ...booked.observation,
      amount: createMoney(-1235n, EUR),
    };
    expect(matchEnableBankingPendingToBooked(pending.observation, altered)).toEqual({
      state: 'unmatched',
      reason: 'incompatible_economics',
    });
  });

  it('rejects pending/booked matching across account identities', () => {
    const account = fixtureAccount();
    const pending = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.pendingCard }),
      account,
    );
    const booked = normalizeEnableBankingTransaction(
      decodeOne({ ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard }),
      { ...account, stableAccountIdentity: 'different-account-hash' },
    );
    if (pending.status !== 'normalized' || booked.status !== 'normalized') {
      throw new Error('Expected normalized observations.');
    }
    expect(matchEnableBankingPendingToBooked(pending.observation, booked.observation)).toEqual({
      state: 'unmatched',
      reason: 'incompatible_account',
    });
  });

  it('preserves ATM, brokerage, salary, and refund as unclassified provider observations', () => {
    const page = decodeEnableBankingTransactions(ENABLE_BANKING_CONTRACT_FIXTURES.firstPage);
    const observations = [2, 3, 4, 5].map((index) =>
      normalizeEnableBankingTransaction(page.transactions[index]!, fixtureAccount()),
    );
    expect(observations.every((item) => item.status === 'normalized')).toBe(true);
    expect(observations.map((item) => item.observation?.direction)).toEqual([
      'credit',
      'debit',
      'debit',
      'credit',
    ]);
    expect(
      observations.every(
        (item) => item.observation?.authority === 'provider_transaction_observation',
      ),
    ).toBe(true);
  });

  it('gates reconciliation on freshness, coverage, pending ambiguity, and materiality', () => {
    const balances = normalizeEnableBankingBalances(
      decodeEnableBankingBalances(ENABLE_BANKING_CONTRACT_FIXTURES.balances),
      fixtureAccount(),
    );
    const base = {
      providerBalance: balances.authoritativeBooked,
      canonicalBalance: createMoney(122_222n, EUR),
      materialityThreshold: createMoney(100n, EUR),
      historyComplete: true,
      unresolvedPending: false,
      providerStale: false,
    } as const;
    expect(reconcileEnableBankingBalance(base)).toMatchObject({
      status: 'reconciled',
      recommendationAllowed: true,
    });
    expect(reconcileEnableBankingBalance({ ...base, providerStale: true }).status).toBe(
      'provider_stale',
    );
    expect(reconcileEnableBankingBalance({ ...base, historyComplete: false }).status).toBe(
      'incomplete_history',
    );
    expect(reconcileEnableBankingBalance({ ...base, unresolvedPending: true }).status).toBe(
      'unresolved_pending',
    );
    expect(
      reconcileEnableBankingBalance({
        ...base,
        canonicalBalance: createMoney(122_000n, EUR),
      }),
    ).toMatchObject({ status: 'material_mismatch', recommendationAllowed: false });
    expect(reconcileEnableBankingBalance({ ...base, providerBalance: null })).toMatchObject({
      status: 'unavailable',
      difference: null,
    });
  });

  it('models reauthorization and revocation without token refresh assumptions', () => {
    expect(transitionEnableBankingConsent('disconnected', 'authorization_started')).toBe(
      'connecting',
    );
    expect(transitionEnableBankingConsent('connecting', 'authorization_succeeded')).toBe('active');
    expect(transitionEnableBankingConsent('active', 'session_expired')).toBe('reauth_required');
    expect(transitionEnableBankingConsent('active', 'session_revoked')).toBe('revoked');
    expect(transitionEnableBankingConsent('connecting', 'authorization_cancelled')).toBe(
      'disconnected',
    );
    expect(transitionEnableBankingConsent('revoked', 'provider_error')).toBe('revoked');
  });

  it('rejects malformed timestamps, statuses, cursors, and response shapes', () => {
    const malformedSession = JSON.parse(ENABLE_BANKING_CONTRACT_FIXTURES.session) as Record<
      string,
      unknown
    >;
    (malformedSession['access'] as Record<string, unknown>)['valid_until'] =
      '2027-03-23T12:00:00+02:00';
    expect(() => decodeEnableBankingAuthorizedSession(JSON.stringify(malformedSession))).toThrow(
      'explicit UTC',
    );

    const badStatus = { ...ENABLE_BANKING_CONTRACT_FIXTURES.items.bookedCard, status: 'DONE' };
    expect(() => decodeOne(badStatus)).toThrow('status');
    expect(() =>
      decodeEnableBankingTransactions(
        JSON.stringify({ transactions: [], continuation_key: '\u0000unsafe' }),
      ),
    ).toThrow('Continuation');
    expect(() => decodeEnableBankingBalances('{"balances":{}}')).toThrow('array');
  });
});
