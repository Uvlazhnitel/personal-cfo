import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountBalanceSnapshot,
  createAccountEntry,
  createCanonicalTransaction,
  createConvertedReportableAmount,
  createInvestmentContribution,
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
} from '@personal-cfo/domain';
import type {
  Account,
  AccountBalanceSnapshot,
  AccountEntry,
  AccountEntryRole,
  AccountId,
  AccountSubtype,
  CanonicalTransaction,
  CanonicalTransactionKind,
  InvestmentContribution,
  PortfolioValuation,
  TransactionId,
} from '@personal-cfo/domain';

import {
  FinancialEngineInvariantError,
  calculateLedgerBalance,
  calculateNetWorth,
  validateLedger,
} from '../src/index.js';
import type { NetWorthInput } from '../src/index.js';

const AS_OF = parseInstant('2026-09-13T12:00:00Z');
const FRESH_UNTIL = parseInstant('2026-09-16T12:00:00Z');
const STALE_AT = parseInstant('2026-09-13T11:00:00Z');
const SOURCE_AS_OF = parseInstant('2026-09-13T10:00:00Z');

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

function accountId(seed: number): AccountId {
  return parseAccountId(uuid(seed));
}

function transactionId(seed: number): TransactionId {
  return parseTransactionId(uuid(seed));
}

function account(
  seed: number,
  subtype: AccountSubtype,
  includeInNetWorth = true,
  brokerageCashFor: AccountId | null = null,
): Account {
  return createAccount({
    id: accountId(seed),
    subtype,
    currency: EUR,
    includeInNetWorth,
    valueSource:
      subtype === 'cash'
        ? 'ledger'
        : subtype === 'investment'
          ? 'portfolio_valuation'
          : 'balance_snapshot',
    brokerageCashFor,
  });
}

function balance(
  target: Account,
  amountMinor: bigint,
  staleAt = FRESH_UNTIL,
): AccountBalanceSnapshot {
  return createAccountBalanceSnapshot({
    accountId: target.id,
    value: createNativeReportableAmount(createMoney(amountMinor, EUR)),
    sourceAsOf: SOURCE_AS_OF,
    staleAt,
  });
}

function valuation(
  target: Account,
  amountMinor: bigint,
  brokerageCashTreatment: PortfolioValuation['brokerageCashTreatment'] = 'included_in_market_value',
  staleAt = FRESH_UNTIL,
): PortfolioValuation {
  return createPortfolioValuation({
    accountId: target.id,
    marketValue: createNativeReportableAmount(createMoney(amountMinor, EUR)),
    sourceAsOf: SOURCE_AS_OF,
    staleAt,
    brokerageCashTreatment,
  });
}

function entry(
  seed: number,
  transaction: TransactionId,
  target: Account,
  amountMinor: bigint,
  role: AccountEntryRole,
): AccountEntry {
  return createAccountEntry({
    id: parseEntryId(uuid(seed)),
    transactionId: transaction,
    accountId: target.id,
    amount: createMoney(amountMinor, EUR),
    role,
  });
}

function transaction(
  seed: number,
  kind: CanonicalTransactionKind,
  entries: readonly AccountEntry[],
): CanonicalTransaction {
  return createCanonicalTransaction({
    id: transactionId(seed),
    effectiveAt: SOURCE_AS_OF,
    bookingStatus: 'booked',
    kind,
    entries,
  });
}

function opening(seed: number, target: Account, amountMinor: bigint): CanonicalTransaction {
  const id = transactionId(seed);
  return transaction(seed, 'opening_balance', [
    entry(seed + 1000, id, target, amountMinor, 'opening_balance'),
  ]);
}

function input(
  accounts: readonly Account[],
  accountBalanceSnapshots: readonly AccountBalanceSnapshot[] = [],
  portfolioValuations: readonly PortfolioValuation[] = [],
  transactions: readonly CanonicalTransaction[] = [],
  investmentContributions: readonly InvestmentContribution[] = [],
): NetWorthInput {
  return {
    accounts,
    transactions,
    investmentContributions,
    accountBalanceSnapshots,
    portfolioValuations,
    asOf: AS_OF,
    engineVersion: '2a.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
  };
}

function requireValue(result: ReturnType<typeof calculateNetWorth>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected Net Worth value.');
  return result.value;
}

describe('calculateNetWorth', () => {
  it('calculates liquid cash and investment market value exactly (FR-020)', () => {
    const bank = account(1, 'bank');
    const cash = account(2, 'cash');
    const investment = account(3, 'investment');
    const result = calculateNetWorth(
      input(
        [bank, cash, investment],
        [balance(bank, 500_000n)],
        [valuation(investment, 400_000n)],
        [opening(10, cash, 20_000n)],
      ),
    );

    expect(result.status).toBe('complete');
    expect(requireValue(result)).toMatchObject({
      liquidCash: { amountMinor: 520_000n, currency: EUR },
      investmentMarketValue: { amountMinor: 400_000n, currency: EUR },
      total: { amountMinor: 920_000n, currency: EUR },
    });
  });

  it('subtracts a liability exactly once', () => {
    const bank = account(1, 'bank');
    const cash = account(2, 'cash');
    const investment = account(3, 'investment');
    const liability = account(4, 'liability');
    const result = calculateNetWorth(
      input(
        [bank, cash, investment, liability],
        [balance(bank, 500_000n), balance(liability, 150_000n)],
        [valuation(investment, 400_000n)],
        [opening(10, cash, 20_000n)],
      ),
    );
    const value = requireValue(result);

    expect(value.liabilities.amountMinor).toBe(150_000n);
    expect(value.total.amountMinor).toBe(770_000n);
  });

  it('keeps a bank-to-cash transfer Net Worth-neutral', () => {
    const bank = account(1, 'bank');
    const cash = account(2, 'cash');
    const before = calculateNetWorth(
      input([bank, cash], [balance(bank, 500_000n)], [], [opening(10, cash, 10_000n)]),
    );
    const transferId = transactionId(20);
    const transfer = transaction(20, 'internal_transfer', [
      entry(21, transferId, bank, -10_000n, 'transfer_source'),
      entry(22, transferId, cash, 10_000n, 'transfer_destination'),
    ]);
    const after = calculateNetWorth(
      input([bank, cash], [balance(bank, 490_000n)], [], [opening(10, cash, 10_000n), transfer]),
    );

    expect(requireValue(before).total.amountMinor).toBe(510_000n);
    expect(requireValue(after).total.amountMinor).toBe(510_000n);
  });

  it('keeps a brokerage contribution neutral and never adds principal to valuation', () => {
    const bank = account(1, 'bank');
    const investment = account(3, 'investment');
    const before = calculateNetWorth(
      input([bank, investment], [balance(bank, 500_000n)], [valuation(investment, 100_000n)]),
    );
    const transferId = transactionId(20);
    const transfer = transaction(20, 'investment_contribution', [
      entry(21, transferId, bank, -20_000n, 'transfer_source'),
      entry(22, transferId, investment, 20_000n, 'transfer_destination'),
    ]);
    const contribution = createInvestmentContribution({
      transactionId: transferId,
      investmentAccountId: investment.id,
      principal: createMoney(20_000n, EUR),
      effectiveAt: SOURCE_AS_OF,
    });
    const after = calculateNetWorth(
      input(
        [bank, investment],
        [balance(bank, 480_000n)],
        [valuation(investment, 120_000n)],
        [transfer],
        [contribution],
      ),
    );

    expect(requireValue(before).total.amountMinor).toBe(600_000n);
    expect(requireValue(after).total.amountMinor).toBe(600_000n);
    expect(requireValue(after).investmentMarketValue.amountMinor).toBe(120_000n);
  });

  it('uses closing market value without inventing contribution from market gain', () => {
    const investment = account(3, 'investment');
    const result = calculateNetWorth(input([investment], [], [valuation(investment, 121_500n)]));

    expect(requireValue(result).investmentMarketValue.amountMinor).toBe(121_500n);
    expect(result.explanation.some((component) => component.inputKey === 'contribution')).toBe(
      false,
    );
  });

  it('uses €1,215 market value after a €200 contribution without counting principal twice', () => {
    const bank = account(1, 'bank');
    const investment = account(3, 'investment');
    const transferId = transactionId(20);
    const transfer = transaction(20, 'investment_contribution', [
      entry(21, transferId, bank, -20_000n, 'transfer_source'),
      entry(22, transferId, investment, 20_000n, 'transfer_destination'),
    ]);
    const contribution = createInvestmentContribution({
      transactionId: transferId,
      investmentAccountId: investment.id,
      principal: createMoney(20_000n, EUR),
      effectiveAt: SOURCE_AS_OF,
    });
    const result = calculateNetWorth(
      input(
        [bank, investment],
        [balance(bank, 480_000n)],
        [valuation(investment, 121_500n)],
        [transfer],
        [contribution],
      ),
    );

    expect(requireValue(result).investmentMarketValue.amountMinor).toBe(121_500n);
    expect(requireValue(result).total.amountMinor).toBe(601_500n);
  });

  it('lets market-only changes alter Net Worth without requiring a contribution', () => {
    const investment = account(3, 'investment');
    const before = calculateNetWorth(input([investment], [], [valuation(investment, 100_000n)]));
    const after = calculateNetWorth(input([investment], [], [valuation(investment, 105_000n)]));

    expect(requireValue(after).total.amountMinor - requireValue(before).total.amountMinor).toBe(
      5_000n,
    );
  });

  it('counts an opening balance in current state and excludes pending/reversed entries', () => {
    const cash = account(2, 'cash');
    const bookedOpening = opening(10, cash, 14_000n);
    const pendingId = transactionId(20);
    const reversedId = transactionId(30);
    const pending = createCanonicalTransaction({
      id: pendingId,
      effectiveAt: SOURCE_AS_OF,
      bookingStatus: 'pending',
      kind: 'external_flow',
      entries: [entry(21, pendingId, cash, 5_000n, 'external_flow')],
    });
    const reversed = createCanonicalTransaction({
      id: reversedId,
      effectiveAt: SOURCE_AS_OF,
      bookingStatus: 'reversed',
      kind: 'external_flow',
      entries: [entry(31, reversedId, cash, 2_000n, 'external_flow')],
    });
    const ledger = validateLedger({
      accounts: [cash],
      transactions: [bookedOpening, pending, reversed],
      investmentContributions: [],
    });

    expect(calculateLedgerBalance({ ledger, accountId: cash.id, asOf: AS_OF }).amountMinor).toBe(
      14_000n,
    );
  });

  it('ignores an explicitly excluded account and does not require its value', () => {
    const bank = account(1, 'bank');
    const excluded = account(5, 'other_asset', false);
    const result = calculateNetWorth(input([bank, excluded], [balance(bank, 50_000n)]));

    expect(result.status).toBe('complete');
    expect(requireValue(result).total.amountMinor).toBe(50_000n);
  });

  it('rejects brokerage cash represented both inside a portfolio and separately', () => {
    const investment = account(3, 'investment');
    const brokerageCash = account(2, 'cash', true, investment.id);

    expect(() =>
      calculateNetWorth(
        input(
          [investment, brokerageCash],
          [],
          [valuation(investment, 100_000n, 'included_in_market_value')],
          [opening(10, brokerageCash, 10_000n)],
        ),
      ),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('supports an explicitly separate brokerage cash account exactly once', () => {
    const investment = account(3, 'investment');
    const brokerageCash = account(2, 'cash', true, investment.id);
    const result = calculateNetWorth(
      input(
        [investment, brokerageCash],
        [],
        [valuation(investment, 100_000n, 'separate_account')],
        [opening(10, brokerageCash, 10_000n)],
      ),
    );

    expect(requireValue(result).total.amountMinor).toBe(110_000n);
  });

  it('returns unavailable rather than treating a missing material balance as zero', () => {
    const bank = account(1, 'bank');
    const result = calculateNetWorth(input([bank]));

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.warnings.map((item) => item.code)).toContain('net_worth.missing_balance');
  });

  it('returns a provisional partial value for a known stale portfolio', () => {
    const investment = account(3, 'investment');
    const result = calculateNetWorth(
      input(
        [investment],
        [],
        [valuation(investment, 100_000n, 'included_in_market_value', STALE_AT)],
      ),
    );

    expect(result.status).toBe('partial');
    expect(requireValue(result).total.amountMinor).toBe(100_000n);
    expect(result.warnings.map((item) => item.code)).toContain('net_worth.stale_portfolio');
  });

  it('returns a provisional partial value for a known stale bank balance', () => {
    const bank = account(1, 'bank');
    const result = calculateNetWorth(input([bank], [balance(bank, 100_000n, STALE_AT)]));

    expect(result.status).toBe('partial');
    expect(requireValue(result).total.amountMinor).toBe(100_000n);
    expect(result.warnings.map((item) => item.code)).toContain('net_worth.stale_balance');
  });

  it('treats a value as fresh through its exact staleAt instant', () => {
    const bank = account(1, 'bank');
    const exact = createAccountBalanceSnapshot({
      accountId: bank.id,
      value: createNativeReportableAmount(createMoney(100n, EUR)),
      sourceAsOf: SOURCE_AS_OF,
      staleAt: AS_OF,
    });

    expect(calculateNetWorth(input([bank], [exact])).status).toBe('complete');
  });

  it('returns unavailable for non-EUR value without versioned FX', () => {
    const usd = parseCurrencyCode('USD');
    const bank = createAccount({
      id: accountId(1),
      subtype: 'bank',
      currency: usd,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    });
    const snapshot = createAccountBalanceSnapshot({
      accountId: bank.id,
      value: createMissingFxReportableAmount(createMoney(100_000n, usd)),
      sourceAsOf: SOURCE_AS_OF,
      staleAt: FRESH_UNTIL,
    });
    const result = calculateNetWorth(input([bank], [snapshot]));

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.warnings.map((item) => item.code)).toContain('net_worth.missing_fx');
  });

  it('aggregates a non-EUR position only through an exact versioned EUR conversion', () => {
    const usd = parseCurrencyCode('USD');
    const bank = createAccount({
      id: accountId(1),
      subtype: 'bank',
      currency: usd,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    });
    const snapshot = createAccountBalanceSnapshot({
      accountId: bank.id,
      value: createConvertedReportableAmount(
        createMoney(100_000n, usd),
        createMoney(91_234n, EUR),
        parseFxRateId(uuid(50)),
      ),
      sourceAsOf: SOURCE_AS_OF,
      staleAt: FRESH_UNTIL,
    });
    const result = calculateNetWorth(input([bank], [snapshot]));

    expect(result.status).toBe('complete');
    expect(requireValue(result).total.amountMinor).toBe(91_234n);
  });

  it('preserves exact values above JavaScript safe integer range', () => {
    const bank = account(1, 'bank');
    const exact = 9_007_199_254_740_993n;
    const result = calculateNetWorth(input([bank], [balance(bank, exact)]));

    expect(requireValue(result).total.amountMinor).toBe(exact);
    expect(result.explanation.at(-1)?.value).toBe(exact.toString());
  });

  it('aggregates exact cancelling positions without order-dependent intermediate overflow', () => {
    const large = account(1, 'bank');
    const positive = account(2, 'bank');
    const negative = account(3, 'bank');
    const maximum = 9_223_372_036_854_775_807n;
    const result = calculateNetWorth(
      input(
        [large, positive, negative],
        [balance(large, maximum), balance(positive, 1n), balance(negative, -1n)],
      ),
    );

    expect(requireValue(result).liquidCash.amountMinor).toBe(maximum);
  });

  it('reconciles signed explanation operands to the exact total', () => {
    const bank = account(1, 'bank');
    const investment = account(3, 'investment');
    const asset = account(5, 'other_asset');
    const liability = account(4, 'liability');
    const result = calculateNetWorth(
      input(
        [bank, investment, asset, liability],
        [balance(bank, 500_000n), balance(asset, 20_000n), balance(liability, 150_000n)],
        [valuation(investment, 400_000n)],
      ),
    );
    const operands = result.explanation
      .slice(0, 4)
      .reduce((sum, component) => sum + BigInt(component.value), 0n);

    expect(operands).toBe(requireValue(result).total.amountMinor);
  });

  it('rejects duplicate IDs, invalid contribution links, and negative magnitudes', () => {
    const bank = account(1, 'bank');
    const investment = account(3, 'investment');
    const liability = account(4, 'liability');
    const transferId = transactionId(20);
    const transfer = transaction(20, 'investment_contribution', [
      entry(21, transferId, bank, -20_000n, 'transfer_source'),
      entry(22, transferId, investment, 20_000n, 'transfer_destination'),
    ]);
    const wrongPrincipal = createInvestmentContribution({
      transactionId: transferId,
      investmentAccountId: investment.id,
      principal: createMoney(19_999n, EUR),
      effectiveAt: SOURCE_AS_OF,
    });

    expect(() =>
      validateLedger({ accounts: [bank, bank], transactions: [], investmentContributions: [] }),
    ).toThrowError(FinancialEngineInvariantError);
    expect(() =>
      validateLedger({
        accounts: [bank, investment],
        transactions: [transfer],
        investmentContributions: [wrongPrincipal],
      }),
    ).toThrowError(FinancialEngineInvariantError);
    expect(() => calculateNetWorth(input([liability], [balance(liability, -1n)]))).toThrowError(
      FinancialEngineInvariantError,
    );
  });

  it('returns unavailable when no account is included', () => {
    const excluded = account(5, 'other_asset', false);
    const result = calculateNetWorth(input([excluded]));

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.warnings[0]?.code).toBe('net_worth.no_included_accounts');
  });
});
