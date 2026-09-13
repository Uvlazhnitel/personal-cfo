import type { AccountId } from './domain-id.js';
import { parseAccountId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { compareInstants, parseInstant } from './instant.js';
import type { ReportableAmount } from './reportable-amount.js';
import { createReportableAmount } from './reportable-amount.js';

export type AccountBalanceSnapshot = Readonly<{
  accountId: AccountId;
  value: ReportableAmount;
  sourceAsOf: Instant;
  staleAt: Instant;
}>;

export function createAccountBalanceSnapshot(
  snapshot: AccountBalanceSnapshot,
): AccountBalanceSnapshot {
  const sourceAsOf = parseInstant(snapshot.sourceAsOf);
  const staleAt = parseInstant(snapshot.staleAt);

  if (compareInstants(sourceAsOf, staleAt) > 0) {
    throw new DomainValidationError(
      'balance.invalid_freshness_window',
      'Account balance staleAt cannot be earlier than sourceAsOf.',
    );
  }

  return Object.freeze({
    accountId: parseAccountId(snapshot.accountId),
    value: createReportableAmount(snapshot.value),
    sourceAsOf,
    staleAt,
  });
}
