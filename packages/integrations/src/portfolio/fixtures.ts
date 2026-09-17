import {
  EUR,
  createMoney,
  createNativeReportableAmount,
  parseAccountId,
  parseDecimalRate,
  parseDomainId,
  parseInstant,
} from '@personal-cfo/domain';

import {
  calculateMarketMovement,
  createContributionEvidence,
  createPortfolioSnapshot,
} from './contract.js';
import type {
  ContributionEvidence,
  MarketMovementReconciliation,
  PortfolioCursor,
  PortfolioSnapshot,
  ProviderProfitLoss,
  ProviderRevisionIdentity,
} from './types.js';

const INVESTMENT_ACCOUNT_ID = parseAccountId('018f0000-0000-7000-8000-000000000701');
const CASH_ACCOUNT_ID = parseAccountId('018f0000-0000-7000-8000-000000000702');
const OWNER_ID = parseDomainId('018f0000-0000-7000-8000-000000000700', 'portfolio-owner');
const CONNECTION = Object.freeze({ provider: 'synthetic', connectionId: 'connection-1' });
const PORTFOLIO_ID = 'portfolio-1';

function revision(sourceId: string, suffix: string): ProviderRevisionIdentity {
  return Object.freeze({
    sourceId,
    version: Object.freeze({ kind: 'provider_revision', value: suffix }),
  });
}

function eur(amountMinor: bigint) {
  return createMoney(amountMinor, EUR);
}

function reportable(amountMinor: bigint) {
  return createNativeReportableAmount(eur(amountMinor));
}

function holdings(sourceAsOf: PortfolioSnapshot['sourceAsOf'], totalMinor = 980_000n) {
  return Object.freeze([
    Object.freeze({
      providerHoldingId: 'holding-1',
      providerSecurityId: 'security-1',
      instrumentName: 'Synthetic broad-market fund',
      symbol: 'SYN',
      quantity: parseDecimalRate('9.8'),
      marketValue: reportable(totalMinor),
      sourceAsOf,
      revision: revision('holding-1', 'r1'),
    }),
  ]);
}

function includedCashSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const sourceAsOf = parseInstant('2026-09-15T18:00:00Z');
  const total = reportable(1_000_000n);
  return createPortfolioSnapshot({
    ownerId: OWNER_ID,
    accountId: INVESTMENT_ACCOUNT_ID,
    connection: CONNECTION,
    providerPortfolioId: PORTFOLIO_ID,
    sourceAsOf,
    receivedAt: parseInstant('2026-09-15T18:00:05Z'),
    staleAt: parseInstant('2026-09-18T18:00:00Z'),
    providerReportedMarketValue: total,
    totalMarketValue: total,
    cash: { treatment: 'included_in_total', amount: reportable(20_000n) },
    netWorthProjection: {
      kind: 'single_investment_account',
      investmentAccountId: INVESTMENT_ACCOUNT_ID,
      value: total,
    },
    contributedCapital: reportable(850_000n),
    holdings: { completeness: 'complete', items: holdings(sourceAsOf) },
    sourceCompleteness: 'complete',
    revision: revision('valuation-1', 'r1'),
    ...overrides,
  });
}

function excludedCashSnapshot(split: boolean): PortfolioSnapshot {
  const sourceAsOf = parseInstant('2026-09-15T18:00:00Z');
  const securities = reportable(980_000n);
  const cash = reportable(20_000n);
  const total = reportable(1_000_000n);
  return createPortfolioSnapshot({
    ownerId: OWNER_ID,
    accountId: INVESTMENT_ACCOUNT_ID,
    connection: CONNECTION,
    providerPortfolioId: PORTFOLIO_ID,
    sourceAsOf,
    receivedAt: parseInstant('2026-09-15T18:00:05Z'),
    staleAt: parseInstant('2026-09-18T18:00:00Z'),
    providerReportedMarketValue: securities,
    totalMarketValue: total,
    cash: { treatment: 'excluded_from_total', amount: cash },
    netWorthProjection: split
      ? {
          kind: 'investment_plus_separate_cash',
          investmentAccountId: INVESTMENT_ACCOUNT_ID,
          investmentValue: securities,
          cashAccountId: CASH_ACCOUNT_ID,
          cashValue: cash,
        }
      : {
          kind: 'single_investment_account',
          investmentAccountId: INVESTMENT_ACCOUNT_ID,
          value: total,
        },
    contributedCapital: reportable(850_000n),
    holdings: { completeness: 'complete', items: holdings(sourceAsOf) },
    sourceCompleteness: 'complete',
    revision: revision('valuation-1', 'r1'),
  });
}

function unknownCashSnapshot(): PortfolioSnapshot {
  const sourceAsOf = parseInstant('2026-09-15T18:00:00Z');
  const reported = reportable(980_000n);
  return createPortfolioSnapshot({
    ownerId: OWNER_ID,
    accountId: INVESTMENT_ACCOUNT_ID,
    connection: CONNECTION,
    providerPortfolioId: PORTFOLIO_ID,
    sourceAsOf,
    receivedAt: parseInstant('2026-09-15T18:00:05Z'),
    staleAt: parseInstant('2026-09-18T18:00:00Z'),
    providerReportedMarketValue: reported,
    totalMarketValue: null,
    cash: { treatment: 'unavailable', amount: null },
    netWorthProjection: { kind: 'unavailable', reason: 'cash_treatment_unknown' },
    contributedCapital: null,
    holdings: { completeness: 'partial', items: holdings(sourceAsOf) },
    sourceCompleteness: 'partial',
    revision: revision('valuation-1', 'r1'),
  });
}

function flow(
  id: string,
  amountMinor: bigint,
  direction: ContributionEvidence['direction'],
  effectiveAt = parseInstant('2026-09-10T10:00:00Z'),
): ContributionEvidence {
  return createContributionEvidence({
    connection: CONNECTION,
    providerPortfolioId: PORTFOLIO_ID,
    providerContributionId: id,
    effectiveAt,
    amount: eur(amountMinor),
    direction,
    providerReference: `reference-${id}`,
    revision: revision(id, 'r1'),
  });
}

function movement(
  openingMinor: bigint,
  closingMinor: bigint,
  flows: readonly ContributionEvidence[],
): MarketMovementReconciliation {
  return calculateMarketMovement(eur(openingMinor), eur(closingMinor), flows, eur(0n));
}

const valuationOnly = includedCashSnapshot();
const contribution = flow('contribution-1', 100_000n, 'contribution');
const withdrawal = flow('withdrawal-1', 20_000n, 'withdrawal');
const duplicateCursor: PortfolioCursor = Object.freeze({ kind: 'page_token', value: 'page-2' });
const providerPlDisagreement: ProviderProfitLoss = Object.freeze({
  amount: reportable(60_000n),
  semantics: 'unknown',
  periodStart: null,
  periodEnd: null,
  fxBasis: 'unknown',
  authority: 'reconciliation_only',
});

export const PORTFOLIO_CONTRACT_FIXTURES = Object.freeze({
  valuationOnly,
  contributionOnly: Object.freeze({
    evidence: contribution,
    reconciliation: movement(1_000_000n, 1_100_000n, [contribution]),
  }),
  marketOnlyGain: movement(1_000_000n, 1_050_000n, []),
  mixedContributionAndGain: movement(1_000_000n, 1_130_000n, [contribution, withdrawal]),
  withdrawal: Object.freeze({
    evidence: withdrawal,
    reconciliation: movement(1_000_000n, 980_000n, [withdrawal]),
  }),
  brokerageCashIncluded: valuationOnly,
  brokerageCashExcludedAggregated: excludedCashSnapshot(false),
  brokerageCashExcludedSeparate: excludedCashSnapshot(true),
  cashTreatmentUnknown: unknownCashSnapshot(),
  staleValuation: includedCashSnapshot({ staleAt: parseInstant('2026-09-16T18:00:00Z') }),
  missingValuation: null,
  duplicateProviderPage: Object.freeze({ first: duplicateCursor, replay: duplicateCursor }),
  revisedProviderFact: Object.freeze({
    original: valuationOnly,
    revised: includedCashSnapshot({ revision: revision('valuation-1', 'r2') }),
  }),
  cursorReplay: Object.freeze({ cursor: duplicateCursor, replay: duplicateCursor }),
  holdingsTotalMismatch: includedCashSnapshot({
    holdings: {
      completeness: 'complete',
      items: holdings(parseInstant('2026-09-15T18:00:00Z'), 970_000n),
    },
  }),
  providerPlDisagreement: Object.freeze({
    derivedMarketMovement: eur(50_000n),
    providerProfitLoss: providerPlDisagreement,
  }),
  stage3ContributionPattern: Object.freeze({
    monthlyRecurring: flow(
      'stage3-monthly-2025-03',
      5_000n,
      'contribution',
      parseInstant('2025-03-20T10:00:00Z'),
    ),
    adHoc: flow(
      'stage3-ad-hoc-2025-03',
      100_000n,
      'contribution',
      parseInstant('2025-03-15T10:00:00Z'),
    ),
  }),
});
