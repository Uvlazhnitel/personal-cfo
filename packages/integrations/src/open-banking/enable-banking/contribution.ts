import type { BankTransactionObservation } from '@personal-cfo/domain';

import {
  createConfirmedContributionPrincipal,
  validateContributionMatch,
} from '../../portfolio/contract.js';
import type {
  ConfirmedContributionPrincipal,
  ContributionEvidence,
  ContributionMatch,
} from '../../portfolio/types.js';

function secondsBetween(left: string, right: string): number {
  return Math.floor(Math.abs(Date.parse(left) - Date.parse(right)) / 1_000);
}

export function confirmEnableBankingPortfolioContribution(
  input: Readonly<{
    bankObservation: BankTransactionObservation;
    portfolioEvidence: ContributionEvidence;
    expectedPortfolioId: string;
    canonicalTransferId: string;
    confirmedContributionKey: string;
    uniqueCandidateCount: number;
  }>,
): Readonly<{
  match: ContributionMatch;
  principal: ConfirmedContributionPrincipal | null;
}> {
  const bank = input.bankObservation;
  const portfolio = input.portfolioEvidence;
  const bankDate = bank.bookingDate ?? bank.valueDate ?? bank.transactionDate;
  const bankDirection = bank.direction === 'debit' ? 'contribution' : 'withdrawal';
  const exactMoney =
    bank.amount.currency === portfolio.amount.currency &&
    (bank.amount.amountMinor < 0n ? -bank.amount.amountMinor : bank.amount.amountMinor) ===
      portfolio.amount.amountMinor;
  const accountExact = portfolio.providerPortfolioId === input.expectedPortfolioId;
  const eligible =
    bank.sourceId !== null &&
    bank.status === 'booked' &&
    bank.canonicalization === 'eligible_booked' &&
    bankDirection === portfolio.direction &&
    exactMoney &&
    accountExact &&
    input.uniqueCandidateCount === 1;
  const match = validateContributionMatch({
    state: eligible ? 'confirmed' : input.uniqueCandidateCount > 0 ? 'candidate' : 'unmatched',
    evidence: {
      amountAndCurrencyExact: exactMoney,
      effectiveTimeDistanceSeconds:
        bankDate === null ? null : secondsBetween(`${bankDate}T12:00:00Z`, portfolio.effectiveAt),
      providerReferenceExact:
        portfolio.providerReference === null || bank.referenceNumber === null
          ? null
          : portfolio.providerReference === bank.referenceNumber,
      bankReferenceExact:
        portfolio.providerReference === null || bank.referenceNumber === null
          ? null
          : portfolio.providerReference === bank.referenceNumber,
      portfolioAccountExact: accountExact,
      canonicalTransferId: eligible ? input.canonicalTransferId : null,
    },
    confirmedContributionKey: eligible ? input.confirmedContributionKey : null,
  });
  return Object.freeze({
    match,
    principal: createConfirmedContributionPrincipal(portfolio, match),
  });
}
