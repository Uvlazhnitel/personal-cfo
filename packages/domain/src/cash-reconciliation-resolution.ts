import type { CashReconciliationId, TransactionId } from './domain-id.js';
import { parseCashReconciliationId, parseTransactionId } from './domain-id.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import { parseStringEnum } from './validation.js';

export const CASH_RECONCILIATION_RESOLUTION_KINDS = [
  'reclassified_adjustment',
  'reversed_adjustment',
] as const;

export type CashReconciliationResolutionKind =
  (typeof CASH_RECONCILIATION_RESOLUTION_KINDS)[number];

type ResolutionEvidence = Readonly<{
  reconciliationId: CashReconciliationId;
  resolvedAt: Instant;
  resolutionTransactionId: TransactionId;
}>;

/** Immutable, auditable evidence for one accepted reconciliation-resolution mechanism. */
export type CashReconciliationResolution =
  | (ResolutionEvidence & Readonly<{ kind: 'reclassified_adjustment' }>)
  | (ResolutionEvidence & Readonly<{ kind: 'reversed_adjustment' }>);

export function createCashReconciliationResolution(
  value: CashReconciliationResolution,
): CashReconciliationResolution {
  return Object.freeze({
    kind: parseStringEnum(
      value.kind,
      CASH_RECONCILIATION_RESOLUTION_KINDS,
      'CashReconciliationResolutionKind',
    ),
    reconciliationId: parseCashReconciliationId(value.reconciliationId),
    resolvedAt: parseInstant(value.resolvedAt),
    resolutionTransactionId: parseTransactionId(value.resolutionTransactionId),
  });
}
