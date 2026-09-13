import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountBalanceSnapshot,
  createAccountEntry,
  createCanonicalTransaction,
  createMoney,
  createNativeReportableAmount,
  parseAccountId,
  parseEntryId,
  parseInstant,
  parseTransactionId,
} from '@personal-cfo/domain';
import type { Account, AccountSubtype, CanonicalTransaction } from '@personal-cfo/domain';

import { calculateNetWorth } from '../src/index.js';
import type { NetWorthInput } from '../src/index.js';

const AS_OF = parseInstant('2026-09-13T12:00:00Z');
const SOURCE_AS_OF = parseInstant('2026-09-13T10:00:00Z');
const STALE_AT = parseInstant('2026-09-16T12:00:00Z');
const PROPERTY_OPTIONS = { seed: 20_260_913, numRuns: 200 } as const;
const safeAmount = fc.bigInt({ min: 0n, max: 1_000_000_000_000n });
const positiveTransfer = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

function account(seed: number, subtype: AccountSubtype, included = true): Account {
  return createAccount({
    id: parseAccountId(uuid(seed)),
    subtype,
    currency: EUR,
    includeInNetWorth: included,
    valueSource: subtype === 'cash' ? 'ledger' : 'balance_snapshot',
    brokerageCashFor: null,
  });
}

function snapshot(target: Account, amountMinor: bigint): AccountBalanceSnapshot {
  return createAccountBalanceSnapshot({
    accountId: target.id,
    value: createNativeReportableAmount(createMoney(amountMinor, EUR)),
    sourceAsOf: SOURCE_AS_OF,
    staleAt: STALE_AT,
  });
}

type AccountBalanceSnapshot = ReturnType<typeof createAccountBalanceSnapshot>;

function calculate(
  accounts: readonly Account[],
  snapshots: readonly AccountBalanceSnapshot[],
  transactions: readonly CanonicalTransaction[] = [],
) {
  const input: NetWorthInput = {
    accounts,
    transactions,
    investmentContributions: [],
    accountBalanceSnapshots: snapshots,
    portfolioValuations: [],
    asOf: AS_OF,
    engineVersion: '2a.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'property-watermark',
  };
  const result = calculateNetWorth(input);
  if (result.value === null) throw new Error('Property fixture unexpectedly unavailable.');
  return result.value;
}

function cashLedger(
  bank: Account,
  cash: Account,
  openingAmount: bigint,
  transferAmount: bigint | null,
): readonly CanonicalTransaction[] {
  const openingId = parseTransactionId(uuid(10));
  const opening = createCanonicalTransaction({
    id: openingId,
    effectiveAt: SOURCE_AS_OF,
    bookingStatus: 'booked',
    kind: 'opening_balance',
    entries: [
      createAccountEntry({
        id: parseEntryId(uuid(11)),
        transactionId: openingId,
        accountId: cash.id,
        amount: createMoney(openingAmount, EUR),
        role: 'opening_balance',
      }),
    ],
  });

  if (transferAmount === null) return [opening];
  const transferId = parseTransactionId(uuid(20));
  return [
    opening,
    createCanonicalTransaction({
      id: transferId,
      effectiveAt: SOURCE_AS_OF,
      bookingStatus: 'booked',
      kind: 'internal_transfer',
      entries: [
        createAccountEntry({
          id: parseEntryId(uuid(21)),
          transactionId: transferId,
          accountId: bank.id,
          amount: createMoney(-transferAmount, EUR),
          role: 'transfer_source',
        }),
        createAccountEntry({
          id: parseEntryId(uuid(22)),
          transactionId: transferId,
          accountId: cash.id,
          amount: createMoney(transferAmount, EUR),
          role: 'transfer_destination',
        }),
      ],
    }),
  ];
}

describe('Net Worth properties', () => {
  it('preserves total across equivalent bank-to-cash balance movement', () => {
    fc.assert(
      fc.property(safeAmount, safeAmount, positiveTransfer, (bankValue, cashValue, transfer) => {
        const bank = account(1, 'bank');
        const cash = account(2, 'cash');
        const before = calculate(
          [bank, cash],
          [snapshot(bank, bankValue + transfer)],
          cashLedger(bank, cash, cashValue, null),
        );
        const after = calculate(
          [bank, cash],
          [snapshot(bank, bankValue)],
          cashLedger(bank, cash, cashValue, transfer),
        );

        expect(after.total.amountMinor).toBe(before.total.amountMinor);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('changes Net Worth by the exact asset and liability deltas', () => {
    fc.assert(
      fc.property(safeAmount, safeAmount, (base, delta) => {
        const asset = account(1, 'bank');
        const liability = account(2, 'liability');
        const assetBefore = calculate([asset], [snapshot(asset, base)]);
        const assetAfter = calculate([asset], [snapshot(asset, base + delta)]);
        const liabilityBefore = calculate([liability], [snapshot(liability, base)]);
        const liabilityAfter = calculate([liability], [snapshot(liability, base + delta)]);

        expect(assetAfter.total.amountMinor - assetBefore.total.amountMinor).toBe(delta);
        expect(liabilityAfter.total.amountMinor - liabilityBefore.total.amountMinor).toBe(-delta);
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('ignores any change to an excluded account', () => {
    fc.assert(
      fc.property(safeAmount, safeAmount, (includedValue, excludedValue) => {
        const included = account(1, 'bank');
        const excluded = account(2, 'other_asset', false);
        const withoutExcludedSnapshot = calculate(
          [included, excluded],
          [snapshot(included, includedValue)],
        );
        const withExcludedSnapshot = calculate(
          [included, excluded],
          [snapshot(included, includedValue), snapshot(excluded, excludedValue)],
        );

        expect(withExcludedSnapshot.total.amountMinor).toBe(
          withoutExcludedSnapshot.total.amountMinor,
        );
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('always reconciles component operands to total in minor units', () => {
    fc.assert(
      fc.property(safeAmount, safeAmount, safeAmount, (liquid, assetValue, liabilityValue) => {
        const bank = account(1, 'bank');
        const asset = account(2, 'other_asset');
        const liability = account(3, 'liability');
        const value = calculate(
          [bank, asset, liability],
          [
            snapshot(bank, liquid),
            snapshot(asset, assetValue),
            snapshot(liability, liabilityValue),
          ],
        );

        expect(
          value.liquidCash.amountMinor +
            value.investmentMarketValue.amountMinor +
            value.otherAssets.amountMinor -
            value.liabilities.amountMinor,
        ).toBe(value.total.amountMinor);
      }),
      PROPERTY_OPTIONS,
    );
  });
});
