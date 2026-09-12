import type { AccountId, EntryId, TransactionId } from './domain-id.js';
import {
  parseAccountId,
  parseEntryId,
  parseTransactionId,
  serializeDomainId,
} from './domain-id.js';
import type { Money, MoneyDto } from './money.js';
import { createMoney, parseMoneyDto, serializeMoney } from './money.js';
import { expectExactKeys, expectRecord, parseStringEnum } from './validation.js';

export const ACCOUNT_ENTRY_ROLES = [
  'external_flow',
  'transfer_source',
  'transfer_destination',
  'valuation_adjustment',
  'opening_balance',
] as const;

export type AccountEntryRole = (typeof ACCOUNT_ENTRY_ROLES)[number];

/** Positive money increases the tracked account balance; negative money decreases it. */
export type AccountEntry = Readonly<{
  id: EntryId;
  transactionId: TransactionId;
  accountId: AccountId;
  amount: Money;
  role: AccountEntryRole;
}>;

export type AccountEntryDto = Readonly<{
  id: string;
  transactionId: string;
  accountId: string;
  amount: MoneyDto;
  role: string;
}>;

export function parseAccountEntryRole(value: unknown): AccountEntryRole {
  return parseStringEnum(value, ACCOUNT_ENTRY_ROLES, 'AccountEntryRole');
}

export function createAccountEntry(entry: AccountEntry): AccountEntry {
  return Object.freeze({
    id: parseEntryId(entry.id),
    transactionId: parseTransactionId(entry.transactionId),
    accountId: parseAccountId(entry.accountId),
    amount: createMoney(entry.amount.amountMinor, entry.amount.currency),
    role: parseAccountEntryRole(entry.role),
  });
}

export function parseAccountEntryDto(value: unknown): AccountEntry {
  const dto = expectRecord(value, 'AccountEntryDto');
  expectExactKeys(dto, ['id', 'transactionId', 'accountId', 'amount', 'role'], 'AccountEntryDto');

  return createAccountEntry({
    id: parseEntryId(dto['id']),
    transactionId: parseTransactionId(dto['transactionId']),
    accountId: parseAccountId(dto['accountId']),
    amount: parseMoneyDto(dto['amount']),
    role: parseAccountEntryRole(dto['role']),
  });
}

export function serializeAccountEntry(entry: AccountEntry): AccountEntryDto {
  return Object.freeze({
    id: serializeDomainId(entry.id),
    transactionId: serializeDomainId(entry.transactionId),
    accountId: serializeDomainId(entry.accountId),
    amount: serializeMoney(entry.amount),
    role: entry.role,
  });
}
