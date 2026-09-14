import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  DomainValidationError,
  createAccountEntry,
  createCanonicalTransaction,
  createMoney,
  parseAccountId,
  parseCurrencyCode,
  parseEntryId,
  parseInstant,
  parseTransactionId,
} from '../../src/index.js';
import type {
  AccountEntry,
  AccountEntryRole,
  AccountId,
  BookingStatus,
  CanonicalTransaction,
  CanonicalTransactionKind,
  CurrencyCode,
  TransactionId,
} from '../../src/index.js';

import { propertyOptions } from './property-options.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7000-8000-${seed.toString(16).padStart(12, '0')}`;
}

const SOURCE = parseAccountId(uuid(1));
const DESTINATION = parseAccountId(uuid(2));
const TRANSACTION = parseTransactionId(uuid(3));

function entry(
  seed: number,
  transactionId: TransactionId,
  accountId: AccountId,
  amountMinor: bigint,
  role: AccountEntryRole,
  currency: CurrencyCode = EUR,
): AccountEntry {
  return createAccountEntry({
    id: parseEntryId(uuid(seed)),
    transactionId,
    accountId,
    amount: createMoney(amountMinor, currency),
    role,
  });
}

function transaction(
  entries: readonly AccountEntry[],
  overrides: Partial<Pick<CanonicalTransaction, 'id' | 'bookingStatus' | 'kind'>> = {},
): CanonicalTransaction {
  return {
    id: overrides.id ?? TRANSACTION,
    effectiveAt: parseInstant('2026-09-14T08:00:00Z'),
    bookingStatus: overrides.bookingStatus ?? 'booked',
    kind: overrides.kind ?? 'internal_transfer',
    entries,
  };
}

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainValidationError);
    expect((error as DomainValidationError).code).toBe(code);
  }
}

describe('Stage 4 canonical transaction verification', () => {
  it('accepts exact balanced transfers independently of entry order', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), (amountMinor) => {
        const source = entry(10, TRANSACTION, SOURCE, -amountMinor, 'transfer_source');
        const destination = entry(
          11,
          TRANSACTION,
          DESTINATION,
          amountMinor,
          'transfer_destination',
        );
        const forward = createCanonicalTransaction(transaction([source, destination]));
        const reverse = createCanonicalTransaction(transaction([destination, source]));

        for (const result of [forward, reverse]) {
          expect(result.entries.reduce((sum, item) => sum + item.amount.amountMinor, 0n)).toBe(0n);
          expect(
            result.entries.find((item) => item.role === 'transfer_source')?.amount.amountMinor,
          ).toBe(-amountMinor);
          expect(
            result.entries.find((item) => item.role === 'transfer_destination')?.amount.amountMinor,
          ).toBe(amountMinor);
        }
      }),
      propertyOptions(20_260_942, 150),
    );
  });

  it.each<readonly [string, () => CanonicalTransaction, string]>([
    [
      'unbooked transfer',
      () =>
        transaction(
          [
            entry(20, TRANSACTION, SOURCE, -100n, 'transfer_source'),
            entry(21, TRANSACTION, DESTINATION, 100n, 'transfer_destination'),
          ],
          { bookingStatus: 'pending' as BookingStatus },
        ),
      'transfer.not_booked',
    ],
    [
      'missing destination',
      () => transaction([entry(22, TRANSACTION, SOURCE, -100n, 'transfer_source')]),
      'transfer.missing_side',
    ],
    [
      'non-transfer role',
      () =>
        transaction([
          entry(23, TRANSACTION, SOURCE, -100n, 'transfer_source'),
          entry(24, TRANSACTION, DESTINATION, 100n, 'transfer_destination'),
          entry(25, TRANSACTION, DESTINATION, -1n, 'external_flow'),
        ]),
      'transfer.invalid_role',
    ],
    [
      'mixed currency',
      () =>
        transaction([
          entry(26, TRANSACTION, SOURCE, -100n, 'transfer_source'),
          entry(
            27,
            TRANSACTION,
            DESTINATION,
            100n,
            'transfer_destination',
            parseCurrencyCode('USD'),
          ),
        ]),
      'transfer.currency_mismatch',
    ],
    [
      'positive source',
      () =>
        transaction([
          entry(28, TRANSACTION, SOURCE, 100n, 'transfer_source'),
          entry(29, TRANSACTION, DESTINATION, 100n, 'transfer_destination'),
        ]),
      'transfer.invalid_source_sign',
    ],
    [
      'negative destination',
      () =>
        transaction([
          entry(30, TRANSACTION, SOURCE, -100n, 'transfer_source'),
          entry(31, TRANSACTION, DESTINATION, -100n, 'transfer_destination'),
        ]),
      'transfer.invalid_destination_sign',
    ],
    [
      'same source and destination account',
      () =>
        transaction([
          entry(32, TRANSACTION, SOURCE, -100n, 'transfer_source'),
          entry(33, TRANSACTION, SOURCE, 100n, 'transfer_destination'),
        ]),
      'transfer.same_account_on_both_sides',
    ],
    [
      'unbalanced transfer',
      () =>
        transaction([
          entry(34, TRANSACTION, SOURCE, -100n, 'transfer_source'),
          entry(35, TRANSACTION, DESTINATION, 99n, 'transfer_destination'),
        ]),
      'transfer.unbalanced',
    ],
  ])('rejects %s with %s', (_label, build, code) => {
    expectCode(() => createCanonicalTransaction(build()), code);
  });

  it.each<readonly [CanonicalTransactionKind, AccountEntryRole]>([
    ['external_flow', 'transfer_source'],
    ['valuation_adjustment', 'external_flow'],
    ['opening_balance', 'external_flow'],
  ])('rejects %s entries with the wrong role', (kind, role) => {
    expectCode(
      () =>
        createCanonicalTransaction(
          transaction([entry(40, TRANSACTION, SOURCE, 100n, role)], { kind }),
        ),
      'transaction.invalid_entry_role',
    );
  });

  it('rejects empty, mismatched, and duplicate transaction entries', () => {
    expectCode(() => createCanonicalTransaction(transaction([])), 'transaction.empty_entries');

    const otherTransaction = parseTransactionId(uuid(41));
    expectCode(
      () =>
        createCanonicalTransaction(
          transaction([entry(42, otherTransaction, SOURCE, 100n, 'external_flow')], {
            kind: 'external_flow',
          }),
        ),
      'transaction.entry_id_mismatch',
    );

    const duplicate = entry(43, TRANSACTION, SOURCE, 100n, 'external_flow');
    expectCode(
      () =>
        createCanonicalTransaction(transaction([duplicate, duplicate], { kind: 'external_flow' })),
      'transaction.duplicate_entry_id',
    );
  });

  it('rejects an unbooked opening balance before validating its entry role', () => {
    expectCode(
      () =>
        createCanonicalTransaction(
          transaction([entry(44, TRANSACTION, SOURCE, 100n, 'opening_balance')], {
            kind: 'opening_balance',
            bookingStatus: 'pending',
          }),
        ),
      'opening_balance.invalid_shape',
    );
  });

  it('accepts each valid kind-specific entry contract', () => {
    const cases: readonly (readonly [CanonicalTransactionKind, AccountEntryRole])[] = [
      ['external_flow', 'external_flow'],
      ['opening_balance', 'opening_balance'],
      ['valuation_adjustment', 'valuation_adjustment'],
    ];
    for (const [kind, role] of cases) {
      expect(
        createCanonicalTransaction(
          transaction([entry(50, TRANSACTION, SOURCE, 100n, role)], { kind }),
        ).kind,
      ).toBe(kind);
    }
    expect(
      createCanonicalTransaction(
        transaction(
          [
            entry(51, TRANSACTION, SOURCE, -100n, 'transfer_source'),
            entry(52, TRANSACTION, DESTINATION, 100n, 'transfer_destination'),
          ],
          { kind: 'investment_contribution' },
        ),
      ).kind,
    ).toBe('investment_contribution');
  });
});
