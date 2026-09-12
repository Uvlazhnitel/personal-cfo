import type { AccountId, TransactionId } from '../src/index.js';

declare const transactionId: TransactionId;
declare function requiresAccountId(id: AccountId): void;

// @ts-expect-error TransactionId must not be assignable to AccountId.
requiresAccountId(transactionId);
