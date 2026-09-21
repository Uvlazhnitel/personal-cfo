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
  createConfirmedContributionPrincipal,
  createContributionEvidence,
  createPortfolioSnapshot,
  reconcileHoldings,
} from './contract.js';
import type {
  ConfirmedContributionPrincipal,
  ContributionEvidence,
  ContributionMatch,
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
  flows: readonly ConfirmedContributionPrincipal[],
): MarketMovementReconciliation {
  return calculateMarketMovement(eur(openingMinor), eur(closingMinor), flows, eur(0n));
}

function match(
  id: string,
  state: ContributionMatch['state'],
  portfolioAccountExact = true,
): ContributionMatch {
  const confirmed = state === 'confirmed';
  return Object.freeze({
    state,
    evidence: Object.freeze({
      amountAndCurrencyExact: true,
      effectiveTimeDistanceSeconds: 30,
      providerReferenceExact: true,
      bankReferenceExact: true,
      portfolioAccountExact,
      canonicalTransferId: confirmed ? `transfer-${id}` : null,
    }),
    confirmedContributionKey: confirmed ? `principal-${id}` : null,
  });
}

function confirmed(
  evidence: ContributionEvidence,
  id: string,
): Readonly<{ match: ContributionMatch; principal: ConfirmedContributionPrincipal }> {
  const confirmedMatch = match(id, 'confirmed');
  const principal = createConfirmedContributionPrincipal(evidence, confirmedMatch);
  if (principal === null) throw new Error('Synthetic confirmed match must produce principal.');
  return Object.freeze({ match: confirmedMatch, principal });
}

const valuationOnly = includedCashSnapshot();
const contribution = flow('contribution-1', 100_000n, 'contribution');
const withdrawal = flow('withdrawal-1', 20_000n, 'withdrawal');
const confirmedContribution = confirmed(contribution, 'contribution-1');
const confirmedWithdrawal = confirmed(withdrawal, 'withdrawal-1');
const unmatchedContributionMatch = match('unmatched-contribution-1', 'unmatched');
const candidateContributionMatch = match('candidate-contribution-1', 'candidate');
const holdingsTotalMismatch = includedCashSnapshot({
  holdings: {
    completeness: 'complete',
    items: holdings(parseInstant('2026-09-15T18:00:00Z'), 970_000n),
  },
});
const holdingsUnavailable = includedCashSnapshot({
  holdings: { completeness: 'unavailable', items: [] },
});
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
    match: confirmedContribution.match,
    principal: confirmedContribution.principal,
    reconciliation: movement(1_000_000n, 1_100_000n, [confirmedContribution.principal]),
  }),
  unmatchedContributionEvidence: Object.freeze({
    evidence: contribution,
    match: unmatchedContributionMatch,
    principal: createConfirmedContributionPrincipal(contribution, unmatchedContributionMatch),
    reconciliation: movement(1_000_000n, 1_100_000n, []),
  }),
  candidateContributionEvidence: Object.freeze({
    evidence: contribution,
    match: candidateContributionMatch,
    principal: createConfirmedContributionPrincipal(contribution, candidateContributionMatch),
    reconciliation: movement(1_000_000n, 1_100_000n, []),
  }),
  crossAccountConfirmedAttempt: Object.freeze({
    evidence: contribution,
    match: match('cross-account-contribution-1', 'confirmed', false),
  }),
  marketOnlyGain: movement(1_000_000n, 1_050_000n, []),
  mixedContributionAndGain: Object.freeze({
    evidence: Object.freeze([contribution, withdrawal]),
    matches: Object.freeze([confirmedContribution.match, confirmedWithdrawal.match]),
    principals: Object.freeze([confirmedContribution.principal, confirmedWithdrawal.principal]),
    reconciliation: movement(1_000_000n, 1_130_000n, [
      confirmedContribution.principal,
      confirmedWithdrawal.principal,
    ]),
  }),
  withdrawal: Object.freeze({
    evidence: withdrawal,
    match: confirmedWithdrawal.match,
    principal: confirmedWithdrawal.principal,
    reconciliation: movement(1_000_000n, 980_000n, [confirmedWithdrawal.principal]),
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
  holdingsTotalMismatch,
  materialHoldingsMismatch: Object.freeze({
    snapshot: holdingsTotalMismatch,
    reconciliation: reconcileHoldings(holdingsTotalMismatch, eur(9_999n)),
  }),
  withinRoundingHoldings: Object.freeze({
    snapshot: holdingsTotalMismatch,
    reconciliation: reconcileHoldings(holdingsTotalMismatch, eur(10_000n)),
  }),
  unavailableHoldingsDetail: Object.freeze({
    snapshot: holdingsUnavailable,
    reconciliation: reconcileHoldings(holdingsUnavailable, eur(1n)),
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
