import type { AccountId } from './domain-id.js';
import { parseAccountId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { compareInstants, parseInstant } from './instant.js';
import type { ReportableAmount } from './reportable-amount.js';
import { createReportableAmount } from './reportable-amount.js';
import { parseStringEnum } from './validation.js';

export const BROKERAGE_CASH_TREATMENTS = ['included_in_market_value', 'separate_account'] as const;

export type BrokerageCashTreatment = (typeof BROKERAGE_CASH_TREATMENTS)[number];

export type PortfolioValuation = Readonly<{
  accountId: AccountId;
  marketValue: ReportableAmount;
  sourceAsOf: Instant;
  staleAt: Instant;
  brokerageCashTreatment: BrokerageCashTreatment;
}>;

export function parseBrokerageCashTreatment(value: unknown): BrokerageCashTreatment {
  return parseStringEnum(value, BROKERAGE_CASH_TREATMENTS, 'BrokerageCashTreatment');
}

export function createPortfolioValuation(valuation: PortfolioValuation): PortfolioValuation {
  const sourceAsOf = parseInstant(valuation.sourceAsOf);
  const staleAt = parseInstant(valuation.staleAt);

  if (compareInstants(sourceAsOf, staleAt) > 0) {
    throw new DomainValidationError(
      'portfolio.invalid_freshness_window',
      'Portfolio valuation staleAt cannot be earlier than sourceAsOf.',
    );
  }

  return Object.freeze({
    accountId: parseAccountId(valuation.accountId),
    marketValue: createReportableAmount(valuation.marketValue),
    sourceAsOf,
    staleAt,
    brokerageCashTreatment: parseBrokerageCashTreatment(valuation.brokerageCashTreatment),
  });
}
