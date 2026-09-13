import type { AccountId, TransactionId } from './domain-id.js';
import { parseAccountId, parseTransactionId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';

export type InvestmentContribution = Readonly<{
  transactionId: TransactionId;
  investmentAccountId: AccountId;
  principal: Money;
  effectiveAt: Instant;
}>;

export function createInvestmentContribution(
  contribution: InvestmentContribution,
): InvestmentContribution {
  const principal = createMoney(
    contribution.principal.amountMinor,
    contribution.principal.currency,
  );

  if (principal.amountMinor <= 0n) {
    throw new DomainValidationError(
      'investment_contribution.non_positive',
      'Investment contribution principal must be positive.',
    );
  }

  return Object.freeze({
    transactionId: parseTransactionId(contribution.transactionId),
    investmentAccountId: parseAccountId(contribution.investmentAccountId),
    principal,
    effectiveAt: parseInstant(contribution.effectiveAt),
  });
}
