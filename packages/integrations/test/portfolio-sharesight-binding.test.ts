import {
  EUR,
  createMoney,
  parseAccountId,
  parseDomainId,
  parseInstant,
} from '@personal-cfo/domain';
import type { DomainValidationError } from '@personal-cfo/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  SHARESIGHT_CONTRACT_FIXTURES,
  SHARESIGHT_PROVIDER_BINDING,
  assessPortfolioReadiness,
  calculateMarketMovement,
  createConfirmedContributionPrincipal,
  createSharesightScanWindows,
  decodeSharesightCashAccountTransactions,
  decodeSharesightCashAccounts,
  decodeSharesightPayouts,
  decodeSharesightPerformance,
  decodeSharesightPortfolios,
  decodeSharesightTrades,
  decodeSharesightValuation,
  normalizeSharesightCashTransaction,
  normalizeSharesightPayout,
  normalizeSharesightTrade,
  normalizeSharesightValuation,
  reconcileHoldings,
  serializePortfolioCursor,
} from '../src/portfolio/index.js';
import type {
  ConfirmedContributionPrincipal,
  ContributionEvidence,
  SharesightSnapshotContext,
} from '../src/portfolio/index.js';

const OWNER_ID = parseDomainId('018f0000-0000-7000-8000-000000000700', 'portfolio-owner');
const ACCOUNT_ID = parseAccountId('018f0000-0000-7000-8000-000000000701');
const RECEIVED_AT = parseInstant('2026-09-22T08:00:00Z');
const STALE_AT = parseInstant('2026-09-24T00:00:00Z');

function context(sourceFreshnessConfirmed = true): SharesightSnapshotContext {
  return {
    ownerId: OWNER_ID,
    accountId: ACCOUNT_ID,
    connectionId: 'sharesight-personal-owner',
    receivedAt: RECEIVED_AT,
    staleAt: STALE_AT,
    sourceFreshnessConfirmed,
  };
}

function normalizedSnapshot(
  fixture = SHARESIGHT_CONTRACT_FIXTURES.completeValuation,
  headers: Readonly<{ holdingLimitTotal?: string; holdingLimitReason?: string }> = {},
  sourceFreshnessConfirmed = true,
) {
  const portfolio = decodeSharesightPortfolios(SHARESIGHT_CONTRACT_FIXTURES.portfolios)[0]!;
  const valuation = decodeSharesightValuation(fixture, headers);
  const normalized = normalizeSharesightValuation(
    portfolio,
    valuation,
    context(sourceFreshnessConfirmed),
  );
  if (normalized.status !== 'normalized') throw new Error('Expected a normalized EUR snapshot.');
  return normalized.snapshot;
}

function contributionContext() {
  return {
    connection: { provider: 'sharesight', connectionId: 'sharesight-personal-owner' },
    providerPortfolioId: '293304',
    cashAccountId: '754797206',
    currencyCode: 'EUR',
  } as const;
}

describe('Sharesight Stage 7 provider binding', () => {
  it('binds the documented stable API without claiming unavailable capabilities', () => {
    expect(SHARESIGHT_PROVIDER_BINDING).toMatchObject({
      provider: 'sharesight',
      api: { stableVersion: 'v2', valuationVersion: 'v2.1', unstableVersionExcluded: 'v3' },
      authentication: {
        selectedGrant: 'client_credentials',
        accessTokenLifetimeSeconds: 1800,
        publishedScopes: 'UNAVAILABLE',
      },
      limits: { requestsPerMinute: 360, concurrentReportRequests: 3 },
    });
    expect(SHARESIGHT_PROVIDER_BINDING.capabilities.incremental_cursor).toBe(false);
    expect(SHARESIGHT_PROVIDER_BINDING.capabilities.contributed_capital_total).toBe(false);
    expect(SHARESIGHT_PROVIDER_BINDING.fieldClassifications['lightyearImportFreshness']).toBe(
      'AMBIGUOUS',
    );
  });

  it('decodes official response shapes and preserves exact numeric lexemes', () => {
    const portfolio = decodeSharesightPortfolios(SHARESIGHT_CONTRACT_FIXTURES.portfolios)[0]!;
    const valuation = decodeSharesightValuation(SHARESIGHT_CONTRACT_FIXTURES.completeValuation);
    const cashAccount = decodeSharesightCashAccounts(SHARESIGHT_CONTRACT_FIXTURES.cashAccounts)[0]!;
    const performance = decodeSharesightPerformance(SHARESIGHT_CONTRACT_FIXTURES.performance);
    const payout = decodeSharesightPayouts(SHARESIGHT_CONTRACT_FIXTURES.payouts)[0]!;

    expect(portfolio).toMatchObject({ id: '293304', currencyCode: 'EUR', timeZoneName: 'Riga' });
    expect(valuation.value).toBe('10000.10');
    expect(valuation.holdings[0]?.quantity).toBe('12.5000');
    expect(cashAccount.balance).toBe('500.05');
    expect(performance.totalGain).toBe('555.40');
    expect(payout).toMatchObject({ id: '2', amount: '42.30', state: 'confirmed' });
  });

  it('decodes the direct-root performance shape observed in the live sandbox', () => {
    const performance = decodeSharesightPerformance(
      SHARESIGHT_CONTRACT_FIXTURES.observedDirectPerformance,
    );

    expect(performance).toMatchObject({
      reportId: 'PerformanceReport_293304',
      portfolioId: '293304',
      startDate: '2026-01-01',
      endDate: '2026-09-21',
      totalGain: '555.40',
    });
  });

  it('normalizes an EUR valuation as an included-cash authoritative total', () => {
    const snapshot = normalizedSnapshot();
    expect(snapshot.providerPortfolioId).toBe('293304');
    expect(snapshot.providerReportedMarketValue!.original.amountMinor).toBe(1_000_010n);
    expect(snapshot.totalMarketValue?.original.amountMinor).toBe(1_000_010n);
    expect(snapshot.cash).toMatchObject({
      treatment: 'included_in_total',
      amount: { original: { amountMinor: 50_005n } },
    });
    expect(snapshot.netWorthProjection.kind).toBe('single_investment_account');
    expect(snapshot.sourceAsOf).toBe('2026-09-20T21:00:00Z');
    expect(reconcileHoldings(snapshot, createMoney(1n, EUR))).toEqual({
      status: 'exact',
      difference: createMoney(0n, EUR),
    });
  });

  it('keeps an authoritative total when provider holding detail is limited', () => {
    const snapshot = normalizedSnapshot(SHARESIGHT_CONTRACT_FIXTURES.limitedHoldingsValuation, {
      holdingLimitTotal: '2',
      holdingLimitReason: 'Plan holding limit',
    });
    const reconciliation = reconcileHoldings(snapshot, createMoney(1n, EUR));
    const readiness = assessPortfolioReadiness(snapshot, RECEIVED_AT, {
      holdingsReconciliation: reconciliation,
    });
    expect(snapshot.totalMarketValue?.original.amountMinor).toBe(1_000_010n);
    expect(snapshot.holdings.completeness).toBe('partial');
    expect(reconciliation).toEqual({ status: 'unavailable', difference: null });
    expect(readiness.recommendationAllowed).toBe(true);
    expect(readiness.warnings).toContain('holdings_incomplete');
  });

  it('suppresses recommendations when manual Lightyear import freshness is unconfirmed', () => {
    const snapshot = normalizedSnapshot(SHARESIGHT_CONTRACT_FIXTURES.completeValuation, {}, false);
    const readiness = assessPortfolioReadiness(snapshot, RECEIVED_AT, {
      holdingsReconciliation: reconcileHoldings(snapshot, createMoney(1n, EUR)),
    });
    expect(snapshot.sourceCompleteness).toBe('partial');
    expect(readiness).toMatchObject({ completeness: 'partial', recommendationAllowed: false });
    expect(readiness.warnings).toContain('source_incomplete');
  });

  it('creates contribution and withdrawal evidence without creating principal', () => {
    const deposit = normalizeSharesightCashTransaction(
      decodeSharesightCashAccountTransactions(SHARESIGHT_CONTRACT_FIXTURES.deposit)[0]!,
      contributionContext(),
    );
    const withdrawal = normalizeSharesightCashTransaction(
      decodeSharesightCashAccountTransactions(SHARESIGHT_CONTRACT_FIXTURES.withdrawal)[0]!,
      contributionContext(),
    );
    expect(deposit.status).toBe('normalized');
    expect(withdrawal.status).toBe('normalized');
    if (deposit.status !== 'normalized' || withdrawal.status !== 'normalized') return;
    expect(deposit.evidence).toMatchObject({
      direction: 'contribution',
      amount: { amountMinor: 100_010n },
      providerContributionId: '754797206:798669676',
    });
    expect(withdrawal.evidence).toMatchObject({
      direction: 'withdrawal',
      amount: { amountMinor: 20_000n },
    });
    expectTypeOf(deposit.evidence).toEqualTypeOf<ContributionEvidence>();
    expectTypeOf(deposit.evidence).not.toMatchTypeOf<ConfirmedContributionPrincipal>();
  });

  it('requires the existing deterministic match before evidence becomes principal', () => {
    const normalized = normalizeSharesightCashTransaction(
      decodeSharesightCashAccountTransactions(SHARESIGHT_CONTRACT_FIXTURES.deposit)[0]!,
      contributionContext(),
    );
    if (normalized.status !== 'normalized') throw new Error('Expected contribution evidence.');
    const principal = createConfirmedContributionPrincipal(normalized.evidence, {
      state: 'confirmed',
      evidence: {
        amountAndCurrencyExact: true,
        effectiveTimeDistanceSeconds: 60,
        providerReferenceExact: true,
        bankReferenceExact: true,
        portfolioAccountExact: true,
        canonicalTransferId: 'canonical-bank-transfer-798669676',
      },
      confirmedContributionKey: 'principal-owner-transfer-investment-contribution',
    });
    expect(principal).not.toBeNull();
    const movement = calculateMarketMovement(
      createMoney(1_000_000n, EUR),
      createMoney(1_100_010n, EUR),
      principal === null ? [] : [principal],
      createMoney(0n, EUR),
    );
    expect(movement.marketMovement.amountMinor).toBe(0n);
  });

  it('deduplicates replays by source and fingerprint while detecting corrections', () => {
    const normalize = (fixture: string) => {
      const result = normalizeSharesightCashTransaction(
        decodeSharesightCashAccountTransactions(fixture)[0]!,
        contributionContext(),
      );
      if (result.status !== 'normalized') throw new Error('Expected normalized evidence.');
      return result.evidence;
    };
    const first = normalize(SHARESIGHT_CONTRACT_FIXTURES.deposit);
    const replay = normalize(SHARESIGHT_CONTRACT_FIXTURES.depositReplay);
    const revision = normalize(SHARESIGHT_CONTRACT_FIXTURES.revisedDeposit);
    expect(replay.revision).toEqual(first.revision);
    expect(revision.revision.sourceId).toBe(first.revision.sourceId);
    expect(revision.revision.version.value).not.toBe(first.revision.version.value);
    expect(revision.amount.amountMinor).toBe(110_010n);
  });

  it('quarantines cross-account and direction-conflicting evidence and ignores other cash types', () => {
    const normalize = (fixture: string) =>
      normalizeSharesightCashTransaction(
        decodeSharesightCashAccountTransactions(fixture)[0]!,
        contributionContext(),
      );
    expect(normalize(SHARESIGHT_CONTRACT_FIXTURES.crossPortfolioDeposit)).toEqual({
      status: 'quarantined',
      category: 'sharesight_portfolio_mismatch',
    });
    expect(normalize(SHARESIGHT_CONTRACT_FIXTURES.directionConflict)).toEqual({
      status: 'quarantined',
      category: 'sharesight_cash_direction_conflict',
    });
    expect(normalize(SHARESIGHT_CONTRACT_FIXTURES.unrelatedCashTransaction)).toEqual({
      status: 'ignored',
      category: 'sharesight_non_principal_cash_transaction',
    });
  });

  it('does not treat an unconfirmed trade as settled contribution evidence', () => {
    const trade = decodeSharesightTrades(SHARESIGHT_CONTRACT_FIXTURES.pendingTrade)[0]!;
    expect(trade).toMatchObject({ id: null, state: 'unconfirmed', transactionType: 'BUY' });
    expect(normalizeSharesightTrade(trade, '293304')).toMatchObject({
      status: 'normalized',
      evidence: {
        providerTradeId: 'pending-trade-1',
        state: 'unconfirmed',
        value: '100',
      },
    });
    expect(SHARESIGHT_PROVIDER_BINDING.fieldClassifications['brokerageSettlementState']).toBe(
      'AMBIGUOUS',
    );
  });

  it('normalizes payouts as revisioned provider evidence rather than principal', () => {
    const payout = normalizeSharesightPayout(
      decodeSharesightPayouts(SHARESIGHT_CONTRACT_FIXTURES.payouts)[0]!,
      '293304',
    );
    expect(payout).toMatchObject({
      status: 'normalized',
      evidence: {
        providerPayoutId: '2',
        state: 'confirmed',
        amount: '42.3',
        currencyCode: 'EUR',
      },
    });
    expect(payout).not.toHaveProperty('authority');
  });

  it('quarantines observed unconfirmed records that lack stable provider identities', () => {
    const trade = decodeSharesightTrades(
      SHARESIGHT_CONTRACT_FIXTURES.observedIdentitylessTrade,
    )[0]!;
    const payout = decodeSharesightPayouts(
      SHARESIGHT_CONTRACT_FIXTURES.observedIdentitylessPayout,
    )[0]!;

    expect(trade.brokerageCurrencyCode).toBeNull();
    expect(normalizeSharesightTrade(trade, '293304')).toEqual({
      status: 'quarantined',
      category: 'sharesight_trade_identity_unavailable',
    });
    expect(payout.id).toBeNull();
    expect(normalizeSharesightPayout(payout, '293304')).toEqual({
      status: 'quarantined',
      category: 'sharesight_payout_identity_unavailable',
    });
  });

  it('uses derived monthly continuation without claiming a provider cursor', () => {
    const windows = createSharesightScanWindows({
      phase: 'cash_transactions',
      portfolioId: '293304',
      resourceId: '754797206',
      from: '2026-01-15',
      to: '2026-03-02',
    });
    expect(windows.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2026-01-15', to: '2026-01-31' },
      { from: '2026-02-01', to: '2026-02-28' },
      { from: '2026-03-01', to: '2026-03-02' },
    ]);
    expect(serializePortfolioCursor(windows[1]!.cursor)).toContain('sharesight-application-window');
    expect(SHARESIGHT_PROVIDER_BINDING.capabilities.incremental_cursor).toBe(false);
  });

  it('blocks a material component mismatch but accepts provider rounding', () => {
    const material = normalizedSnapshot(SHARESIGHT_CONTRACT_FIXTURES.materialMismatchValuation);
    const materialReconciliation = reconcileHoldings(material, createMoney(1n, EUR));
    const materialReadiness = assessPortfolioReadiness(material, RECEIVED_AT, {
      holdingsReconciliation: materialReconciliation,
    });
    expect(materialReconciliation.status).toBe('material_mismatch');
    expect(materialReadiness.recommendationAllowed).toBe(false);
    expect(materialReadiness.warnings).toContain('valuation_components_mismatch');

    const rounded = normalizedSnapshot(SHARESIGHT_CONTRACT_FIXTURES.withinRoundingValuation);
    const roundedReconciliation = reconcileHoldings(rounded, createMoney(1n, EUR));
    expect(roundedReconciliation.status).toBe('within_provider_rounding');
    expect(
      assessPortfolioReadiness(rounded, RECEIVED_AT, {
        holdingsReconciliation: roundedReconciliation,
      }).recommendationAllowed,
    ).toBe(true);
  });

  it('quarantines non-EUR totals until exact FX provenance is selected', () => {
    const portfolio = decodeSharesightPortfolios(SHARESIGHT_CONTRACT_FIXTURES.nonEurPortfolio)[0]!;
    const valuation = decodeSharesightValuation(SHARESIGHT_CONTRACT_FIXTURES.nonEurValuation);
    expect(normalizeSharesightValuation(portfolio, valuation, context())).toEqual({
      status: 'quarantined',
      category: 'sharesight_non_eur_reporting_currency',
    });
  });

  it('rejects malformed runtime payloads instead of trusting TypeScript shapes', () => {
    const exponentPayload = SHARESIGHT_CONTRACT_FIXTURES.completeValuation.replace(
      '"value": 10000.10',
      '"value": 1e4',
    );
    expect(() => decodeSharesightValuation(exponentPayload)).toThrowError(
      expect.objectContaining<Partial<DomainValidationError>>({
        code: 'sharesight_binding.invalid_number',
      }),
    );

    const portfolio = {
      ...decodeSharesightPortfolios(SHARESIGHT_CONTRACT_FIXTURES.portfolios)[0]!,
      timeZoneName: 'Unverified/Provider-Timezone',
    };
    const valuation = decodeSharesightValuation(SHARESIGHT_CONTRACT_FIXTURES.completeValuation);
    expect(normalizeSharesightValuation(portfolio, valuation, context())).toEqual({
      status: 'quarantined',
      category: 'sharesight_timezone_unavailable',
    });
  });
});
