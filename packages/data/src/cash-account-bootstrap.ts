import { and, eq } from 'drizzle-orm';
import {
  EUR,
  MAX_MONEY_MINOR,
  createAccount,
  createCanonicalTransaction,
  createMoney,
} from '@personal-cfo/domain';

import type { CommandMutationResult } from './commands.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import { canonicalDatabaseInstant } from './financial-facts.js';
import { encodeSourceJson } from './json-codec.js';
import type { DatabaseTransaction } from './owner-lock.js';
import { accountEntries, accounts, financialTransactions, transactionVersions } from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type CashAccountBootstrapInput = Readonly<{
  openingBalanceMinor: bigint;
  effectiveAt: string;
  reason: string;
  asOf: string;
}>;

export async function bootstrapCashAccount(
  tx: DatabaseTransaction,
  ownerId: string,
  input: CashAccountBootstrapInput,
): Promise<CommandMutationResult> {
  if (
    typeof input.openingBalanceMinor !== 'bigint' ||
    input.openingBalanceMinor < 0n ||
    input.openingBalanceMinor > MAX_MONEY_MINOR
  ) {
    throw new DataInvariantError(
      'cash_account.invalid_opening_balance',
      'Cash Account opening balance must be a non-negative EUR amount in minor units.',
    );
  }
  const effectiveAt = canonicalDatabaseInstant(input.effectiveAt);
  const asOf = canonicalDatabaseInstant(input.asOf);
  const effectiveAtMilliseconds = Date.parse(effectiveAt);
  const asOfMilliseconds = Date.parse(asOf);
  if (Number.isNaN(effectiveAtMilliseconds) || Number.isNaN(asOfMilliseconds)) {
    throw new DataInvariantError(
      'cash_account.invalid_effective_at',
      'Cash Account opening balance requires a valid UTC effective instant.',
    );
  }
  if (effectiveAtMilliseconds > asOfMilliseconds) {
    throw new DataInvariantError(
      'cash_account.future_effective_at',
      'Cash Account opening balance cannot be effective in the future.',
    );
  }
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new DataInvariantError(
      'cash_account.invalid_reason',
      'Cash Account bootstrap requires a reason of at most 500 characters.',
    );
  }

  const existingCashAccount = await tx.query.accounts.findFirst({
    where: and(eq(accounts.ownerId, ownerId), eq(accounts.kind, 'cash')),
  });
  if (existingCashAccount !== undefined) {
    throw new DataConflictError(
      'cash_account.already_initialized',
      'The owner already has a Cash Account.',
    );
  }

  const accountId = generateUuidV7('account');
  const transactionId = generateUuidV7('transaction');
  const entryId = generateUuidV7('entry');
  const account = createAccount({
    id: accountId,
    subtype: 'cash',
    currency: EUR,
    includeInNetWorth: true,
    valueSource: 'ledger',
    brokerageCashFor: null,
  });
  const transaction = createCanonicalTransaction({
    id: transactionId,
    effectiveAt: effectiveAt as never,
    bookingStatus: 'booked',
    kind: 'opening_balance',
    entries: Object.freeze([
      {
        id: entryId,
        transactionId,
        accountId,
        amount: createMoney(input.openingBalanceMinor, EUR),
        role: 'opening_balance',
      },
    ]),
  });
  const entry = transaction.entries[0]!;

  await tx.insert(accounts).values({
    id: account.id,
    ownerId,
    kind: account.subtype,
    valueSource: account.valueSource,
    currency: account.currency,
    payload: encodeSourceJson(account),
  });
  await tx.insert(financialTransactions).values({
    id: transaction.id,
    ownerId,
    createdAt: asOf,
  });
  await tx.insert(transactionVersions).values({
    ownerId,
    transactionId: transaction.id,
    revision: 1,
    kind: transaction.kind,
    bookingStatus: transaction.bookingStatus,
    effectiveAt: transaction.effectiveAt,
    payload: encodeSourceJson(transaction),
    isCurrent: true,
    supersededAt: null,
  });
  await tx.insert(accountEntries).values({
    ownerId,
    transactionId: transaction.id,
    transactionRevision: 1,
    entryId: entry.id,
    accountId: entry.accountId,
    amountMinor: entry.amount.amountMinor,
    currency: entry.amount.currency,
    role: entry.role,
  });

  return Object.freeze({
    entityType: 'cash_account',
    entityId: account.id,
    earliestAffectedAt: effectiveAt,
    result: Object.freeze({
      accountId: account.id,
      openingBalanceTransactionId: transaction.id,
      openingBalanceMinor: input.openingBalanceMinor.toString(),
      currency: EUR,
      effectiveAt,
      reason,
    }),
  });
}
