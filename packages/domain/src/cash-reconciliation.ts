import type { AccountId, CashReconciliationId, TransactionId } from './domain-id.js';
import { parseAccountId, parseCashReconciliationId, parseTransactionId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import type { FlowMateriality } from './economic-flow.js';
import { FLOW_MATERIALITIES } from './economic-flow.js';
import { expectNonEmptyString, parseStringEnum } from './validation.js';

export type CashReconciliation = Readonly<{
  id: CashReconciliationId;
  accountId: AccountId;
  calculatedBalance: Money;
  countedBalance: Money;
  variance: Money;
  reconciledAt: Instant;
  actor: string;
  reason: string | null;
  materiality: FlowMateriality;
  adjustmentTransactionId: TransactionId;
}>;

export function createCashReconciliation(value: CashReconciliation): CashReconciliation {
  const calculatedBalance = createMoney(
    value.calculatedBalance.amountMinor,
    value.calculatedBalance.currency,
  );
  const countedBalance = createMoney(
    value.countedBalance.amountMinor,
    value.countedBalance.currency,
  );
  const variance = createMoney(value.variance.amountMinor, value.variance.currency);

  if (
    calculatedBalance.currency !== countedBalance.currency ||
    calculatedBalance.currency !== variance.currency
  ) {
    throw new DomainValidationError(
      'cash_reconciliation.currency_mismatch',
      'Cash reconciliation amounts must use one currency.',
    );
  }
  if (countedBalance.amountMinor - calculatedBalance.amountMinor !== variance.amountMinor) {
    throw new DomainValidationError(
      'cash_reconciliation.variance_mismatch',
      'Cash reconciliation variance must equal counted minus calculated balance.',
    );
  }
  if (variance.amountMinor === 0n) {
    throw new DomainValidationError(
      'cash_reconciliation.zero_variance',
      'A cash reconciliation adjustment must have a non-zero variance.',
    );
  }

  const reason = value.reason === null ? null : expectNonEmptyString(value.reason, 'reason');
  return Object.freeze({
    id: parseCashReconciliationId(value.id),
    accountId: parseAccountId(value.accountId),
    calculatedBalance,
    countedBalance,
    variance,
    reconciledAt: parseInstant(value.reconciledAt),
    actor: expectNonEmptyString(value.actor, 'actor'),
    reason,
    materiality: parseStringEnum(value.materiality, FLOW_MATERIALITIES, 'FlowMateriality'),
    adjustmentTransactionId: parseTransactionId(value.adjustmentTransactionId),
  });
}
