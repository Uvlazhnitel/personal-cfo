import type { AccountEntry } from './account-entry.js';
import { createAccountEntry } from './account-entry.js';
import type { TransactionId } from './domain-id.js';
import { parseTransactionId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import type { BookingStatus } from './booking-status.js';
import { parseBookingStatus } from './booking-status.js';
import { parseStringEnum } from './validation.js';

export const CANONICAL_TRANSACTION_KINDS = [
  'external_flow',
  'opening_balance',
  'internal_transfer',
  'investment_contribution',
  'valuation_adjustment',
] as const;

export type CanonicalTransactionKind = (typeof CANONICAL_TRANSACTION_KINDS)[number];

export type CanonicalTransaction = Readonly<{
  id: TransactionId;
  effectiveAt: Instant;
  bookingStatus: BookingStatus;
  kind: CanonicalTransactionKind;
  entries: readonly AccountEntry[];
}>;

export function parseCanonicalTransactionKind(value: unknown): CanonicalTransactionKind {
  return parseStringEnum(value, CANONICAL_TRANSACTION_KINDS, 'CanonicalTransactionKind');
}

function requireEntryRoles(
  transaction: CanonicalTransaction,
  expectedRole: AccountEntry['role'],
): void {
  if (transaction.entries.some((entry) => entry.role !== expectedRole)) {
    throw new DomainValidationError(
      'transaction.invalid_entry_role',
      `${transaction.kind} transactions require ${expectedRole} entries.`,
    );
  }
}

function validateTransfer(transaction: CanonicalTransaction): void {
  if (transaction.bookingStatus !== 'booked') {
    throw new DomainValidationError(
      'transfer.not_booked',
      'A confirmed internal transfer must be booked.',
    );
  }

  const sources = transaction.entries.filter((entry) => entry.role === 'transfer_source');
  const destinations = transaction.entries.filter((entry) => entry.role === 'transfer_destination');

  if (sources.length === 0 || destinations.length === 0) {
    throw new DomainValidationError(
      'transfer.missing_side',
      'A confirmed internal transfer requires source and destination entries.',
    );
  }

  if (sources.length + destinations.length !== transaction.entries.length) {
    throw new DomainValidationError(
      'transfer.invalid_role',
      'Transfer fees and external flows must be represented by separate transactions.',
    );
  }

  const currency = sources[0]?.amount.currency;
  if (
    currency === undefined ||
    transaction.entries.some((entry) => entry.amount.currency !== currency)
  ) {
    throw new DomainValidationError(
      'transfer.currency_mismatch',
      'A Stage 2A internal transfer must use one currency.',
    );
  }

  if (sources.some((entry) => entry.amount.amountMinor >= 0n)) {
    throw new DomainValidationError(
      'transfer.invalid_source_sign',
      'Transfer source entries must decrease their accounts.',
    );
  }

  if (destinations.some((entry) => entry.amount.amountMinor <= 0n)) {
    throw new DomainValidationError(
      'transfer.invalid_destination_sign',
      'Transfer destination entries must increase their accounts.',
    );
  }

  const sourceAccounts = new Set(sources.map((entry) => entry.accountId));
  if (destinations.some((entry) => sourceAccounts.has(entry.accountId))) {
    throw new DomainValidationError(
      'transfer.same_account_on_both_sides',
      'A transfer source account cannot also be a destination account.',
    );
  }

  const total = transaction.entries.reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);
  if (total !== 0n) {
    throw new DomainValidationError(
      'transfer.unbalanced',
      'A confirmed internal transfer must sum to zero.',
    );
  }
}

function validateKindSpecificEntries(transaction: CanonicalTransaction): void {
  switch (transaction.kind) {
    case 'external_flow':
      requireEntryRoles(transaction, 'external_flow');
      break;
    case 'opening_balance':
      if (transaction.bookingStatus !== 'booked' || transaction.entries.length !== 1) {
        throw new DomainValidationError(
          'opening_balance.invalid_shape',
          'An opening balance must be one booked entry.',
        );
      }
      requireEntryRoles(transaction, 'opening_balance');
      break;
    case 'internal_transfer':
    case 'investment_contribution':
      validateTransfer(transaction);
      break;
    case 'valuation_adjustment':
      requireEntryRoles(transaction, 'valuation_adjustment');
      break;
  }
}

export function createCanonicalTransaction(
  transaction: CanonicalTransaction,
): CanonicalTransaction {
  const id = parseTransactionId(transaction.id);
  const entries = Object.freeze(transaction.entries.map((entry) => createAccountEntry(entry)));

  if (entries.length === 0) {
    throw new DomainValidationError(
      'transaction.empty_entries',
      'A canonical transaction must contain at least one account entry.',
    );
  }

  if (entries.some((entry) => entry.transactionId !== id)) {
    throw new DomainValidationError(
      'transaction.entry_id_mismatch',
      'Every entry must reference its containing transaction.',
    );
  }

  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
    throw new DomainValidationError(
      'transaction.duplicate_entry_id',
      'Entry IDs must be unique within a transaction.',
    );
  }

  const result = Object.freeze({
    id,
    effectiveAt: parseInstant(transaction.effectiveAt),
    bookingStatus: parseBookingStatus(transaction.bookingStatus),
    kind: parseCanonicalTransactionKind(transaction.kind),
    entries,
  });

  validateKindSpecificEntries(result);
  return result;
}
