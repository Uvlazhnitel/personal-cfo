import { describe, expect, it } from 'vitest';

import {
  EUR,
  compareInstants,
  createAccount,
  createAccountBalanceSnapshot,
  createAccountEntry,
  createCanonicalTransaction,
  createConvertedReportableAmount,
  createMissingFxReportableAmount,
  createMoney,
  createNativeReportableAmount,
  createPortfolioValuation,
  parseAccountId,
  parseCurrencyCode,
  parseEntryId,
  parseFxRateId,
  parseInstant,
  parseTransactionId,
} from '../src/index.js';

const accountId = parseAccountId('01890f3e-7b2c-7001-8abc-000000000001');
const otherAccountId = parseAccountId('01890f3e-7b2c-7002-8abc-000000000002');
const transactionId = parseTransactionId('01890f3e-7b2c-7003-8abc-000000000003');

describe('canonical financial facts', () => {
  it('validates account subtype/value-source combinations and brokerage links', () => {
    const account = createAccount({
      id: accountId,
      subtype: 'cash',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'ledger',
      brokerageCashFor: otherAccountId,
    });

    expect(account.brokerageCashFor).toBe(otherAccountId);
    expect(Object.isFrozen(account)).toBe(true);
    expect(() => createAccount({ ...account, valueSource: 'balance_snapshot' })).toThrowError();
    expect(() =>
      createAccount({ ...account, subtype: 'bank', valueSource: 'balance_snapshot' }),
    ).toThrowError();
  });

  it('distinguishes native, converted, and missing-FX values exactly', () => {
    const usd = parseCurrencyCode('USD');
    const native = createNativeReportableAmount(createMoney(12_345n, EUR));
    const converted = createConvertedReportableAmount(
      createMoney(10_000n, usd),
      createMoney(9_123n, EUR),
      parseFxRateId('01890f3e-7b2c-7004-8abc-000000000004'),
    );
    const missing = createMissingFxReportableAmount(createMoney(10_000n, usd));

    expect(native.reporting.amountMinor).toBe(12_345n);
    expect(converted.reporting.amountMinor).toBe(9_123n);
    expect(missing.reporting).toBeNull();
    expect(() => createNativeReportableAmount(createMoney(1n, usd))).toThrowError();
    expect(() => createMissingFxReportableAmount(createMoney(1n, EUR))).toThrowError();
    expect(() =>
      createConvertedReportableAmount(
        createMoney(1n, usd),
        createMoney(-1n, EUR),
        parseFxRateId('01890f3e-7b2c-7004-8abc-000000000004'),
      ),
    ).toThrowError();
  });

  it('normalizes freshness facts and compares fractional instants exactly', () => {
    const sourceAsOf = parseInstant('2026-09-13T10:00:00Z');
    const staleAt = parseInstant('2026-09-16T10:00:00Z');
    const snapshot = createAccountBalanceSnapshot({
      accountId,
      value: createNativeReportableAmount(createMoney(100n, EUR)),
      sourceAsOf,
      staleAt,
    });
    const valuation = createPortfolioValuation({
      accountId,
      marketValue: createNativeReportableAmount(createMoney(100n, EUR)),
      sourceAsOf,
      staleAt,
      brokerageCashTreatment: 'included_in_market_value',
    });

    expect(Object.isFrozen(snapshot.value)).toBe(true);
    expect(Object.isFrozen(valuation.marketValue)).toBe(true);
    expect(
      compareInstants(parseInstant('2026-09-13T10:00:00Z'), parseInstant('2026-09-13T10:00:00.1Z')),
    ).toBe(-1);
    expect(() =>
      createAccountBalanceSnapshot({ ...snapshot, staleAt: parseInstant('2026-09-12T10:00:00Z') }),
    ).toThrowError();
  });

  it('accepts a balanced booked transfer and preserves explicit meaning', () => {
    const transaction = createCanonicalTransaction({
      id: transactionId,
      effectiveAt: parseInstant('2026-09-13T10:00:00Z'),
      bookingStatus: 'booked',
      kind: 'internal_transfer',
      entries: [
        createAccountEntry({
          id: parseEntryId('01890f3e-7b2c-7005-8abc-000000000005'),
          transactionId,
          accountId,
          amount: createMoney(-10_000n, EUR),
          role: 'transfer_source',
        }),
        createAccountEntry({
          id: parseEntryId('01890f3e-7b2c-7006-8abc-000000000006'),
          transactionId,
          accountId: otherAccountId,
          amount: createMoney(10_000n, EUR),
          role: 'transfer_destination',
        }),
      ],
    });

    expect(transaction.kind).toBe('internal_transfer');
    expect(Object.isFrozen(transaction.entries)).toBe(true);
    expect(() =>
      createCanonicalTransaction({
        ...transaction,
        entries: [
          transaction.entries[0]!,
          { ...transaction.entries[1]!, amount: createMoney(9_999n, EUR) },
        ],
      }),
    ).toThrowError();
  });

  it('requires opening balances to be explicit single booked entries', () => {
    const entry = createAccountEntry({
      id: parseEntryId('01890f3e-7b2c-7007-8abc-000000000007'),
      transactionId,
      accountId,
      amount: createMoney(14_000n, EUR),
      role: 'opening_balance',
    });

    expect(
      createCanonicalTransaction({
        id: transactionId,
        effectiveAt: parseInstant('2026-09-13T10:00:00Z'),
        bookingStatus: 'booked',
        kind: 'opening_balance',
        entries: [entry],
      }).kind,
    ).toBe('opening_balance');
    expect(() =>
      createCanonicalTransaction({
        id: transactionId,
        effectiveAt: parseInstant('2026-09-13T10:00:00Z'),
        bookingStatus: 'pending',
        kind: 'opening_balance',
        entries: [entry],
      }),
    ).toThrowError();
  });
});
