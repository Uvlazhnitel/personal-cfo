import type { CashReconciliationId, TransactionId } from './domain-id.js';
import { parseCashReconciliationId, parseTransactionId } from './domain-id.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';

/** Immutable evidence that an unexplained reconciliation variance was resolved. */
export type CashReconciliationResolution = Readonly<{
  reconciliationId: CashReconciliationId;
  resolvedAt: Instant;
  resolutionTransactionId: TransactionId;
}>;

export function createCashReconciliationResolution(
  value: CashReconciliationResolution,
): CashReconciliationResolution {
  return Object.freeze({
    reconciliationId: parseCashReconciliationId(value.reconciliationId),
    resolvedAt: parseInstant(value.resolvedAt),
    resolutionTransactionId: parseTransactionId(value.resolutionTransactionId),
  });
}
