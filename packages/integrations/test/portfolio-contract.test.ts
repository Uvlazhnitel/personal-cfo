import {
  EUR,
  createMissingFxReportableAmount,
  createMoney,
  parseCurrencyCode,
  parseDecimalRate,
  parseInstant,
} from '@personal-cfo/domain';
import type { DomainValidationError } from '@personal-cfo/domain';
import { describe, expect, it } from 'vitest';

import {
  PORTFOLIO_CAPABILITIES,
  PORTFOLIO_CONTRACT_FIXTURES,
  assessPortfolioReadiness,
  calculateMarketMovement,
  createContributionEvidence,
  createPortfolioCapabilities,
  createPortfolioSnapshot,
  createProviderRevisionIdentity,
  parsePortfolioCursor,
  reconcileHoldings,
  serializePortfolioCursor,
  validateContributionMatch,
} from '../src/portfolio/index.js';
import type { PortfolioCapabilities, PortfolioCursor } from '../src/portfolio/index.js';

function allCapabilities(value: boolean): PortfolioCapabilities {
  return createPortfolioCapabilities(
    Object.fromEntries(PORTFOLIO_CAPABILITIES.map((capability) => [capability, value])),
  );
}

function expectContractError(run: () => unknown, code: string): void {
  expect(run).toThrowError(
    expect.objectContaining<Partial<DomainValidationError>>({
      code: `portfolio_contract.${code}`,
    }),
  );
}

describe('portfolio provider-neutral contract', () => {
  it('requires every capability to be declared instead of inferred from missing fields', () => {
    const capabilities = allCapabilities(false);
    expect(capabilities.holdings).toBe(false);
    expect(capabilities.total_market_value).toBe(false);
    expectContractError(
      () => createPortfolioCapabilities({ ...capabilities, holdings: undefined }),
      'invalid_capability',
    );
    const missing = Object.fromEntries(
      Object.entries(capabilities).filter(([capability]) => capability !== 'holdings'),
    );
    expectContractError(() => createPortfolioCapabilities(missing), 'invalid_capabilities');
    expectContractError(
      () => createPortfolioCapabilities({ ...capabilities, invented: false }),
      'invalid_capabilities',
    );
  });

  it('normalizes included, excluded, split, and unknown brokerage-cash semantics', () => {
    const included = PORTFOLIO_CONTRACT_FIXTURES.brokerageCashIncluded;
    const aggregated = PORTFOLIO_CONTRACT_FIXTURES.brokerageCashExcludedAggregated;
    const split = PORTFOLIO_CONTRACT_FIXTURES.brokerageCashExcludedSeparate;
    const unknown = PORTFOLIO_CONTRACT_FIXTURES.cashTreatmentUnknown;

    expect(included.totalMarketValue?.original.amountMinor).toBe(1_000_000n);
    expect(included.netWorthProjection.kind).toBe('single_investment_account');
    expect(aggregated.totalMarketValue?.original.amountMinor).toBe(1_000_000n);
    expect(aggregated.netWorthProjection.kind).toBe('single_investment_account');
    expect(split.netWorthProjection.kind).toBe('investment_plus_separate_cash');
    expect(unknown.totalMarketValue).toBeNull();
    expect(unknown.netWorthProjection).toEqual({
      kind: 'unavailable',
      reason: 'cash_treatment_unknown',
    });
  });

  it('rejects representations that would count brokerage cash twice or omit it', () => {
    const excluded = PORTFOLIO_CONTRACT_FIXTURES.brokerageCashExcludedAggregated;
    const providerValue = excluded.providerReportedMarketValue;
    expectContractError(
      () =>
        createPortfolioSnapshot({
          ...excluded,
          totalMarketValue: providerValue,
          netWorthProjection: {
            kind: 'single_investment_account',
            investmentAccountId: excluded.accountId,
            value: providerValue,
          },
        }),
      'excluded_cash_total_mismatch',
    );

    const included = PORTFOLIO_CONTRACT_FIXTURES.brokerageCashIncluded;
    expectContractError(
      () =>
        createPortfolioSnapshot({
          ...included,
          netWorthProjection: {
            kind: 'investment_plus_separate_cash',
            investmentAccountId: included.accountId,
            investmentValue: included.providerReportedMarketValue,
            cashAccountId:
              PORTFOLIO_CONTRACT_FIXTURES.brokerageCashExcludedSeparate.netWorthProjection.kind ===
              'investment_plus_separate_cash'
                ? PORTFOLIO_CONTRACT_FIXTURES.brokerageCashExcludedSeparate.netWorthProjection
                    .cashAccountId
                : included.accountId,
            cashValue: included.cash.amount!,
          },
        }),
      'invalid_split_projection',
    );
  });

  it('reconciles holdings diagnostically without replacing the provider total', () => {
    expect(
      reconcileHoldings(PORTFOLIO_CONTRACT_FIXTURES.brokerageCashIncluded, createMoney(1n, EUR)),
    ).toEqual({ status: 'exact', difference: createMoney(0n, EUR) });
    expect(
      reconcileHoldings(PORTFOLIO_CONTRACT_FIXTURES.holdingsTotalMismatch, createMoney(9_999n, EUR))
        .status,
    ).toBe('material_mismatch');
    expect(
      reconcileHoldings(
        PORTFOLIO_CONTRACT_FIXTURES.holdingsTotalMismatch,
        createMoney(10_000n, EUR),
      ).status,
    ).toBe('within_provider_rounding');
    expect(
      reconcileHoldings(PORTFOLIO_CONTRACT_FIXTURES.cashTreatmentUnknown, createMoney(1n, EUR)),
    ).toEqual({ status: 'unavailable', difference: null });
  });

  it('keeps contribution, withdrawal, and residual market movement distinct', () => {
    const fixtures = PORTFOLIO_CONTRACT_FIXTURES;
    expect(fixtures.contributionOnly.reconciliation.marketMovement.amountMinor).toBe(0n);
    expect(fixtures.marketOnlyGain.marketMovement.amountMinor).toBe(50_000n);
    expect(fixtures.marketOnlyGain.contributions.amountMinor).toBe(0n);
    expect(fixtures.mixedContributionAndGain).toMatchObject({
      contributions: { amountMinor: 100_000n },
      withdrawals: { amountMinor: 20_000n },
      marketMovement: { amountMinor: 50_000n },
    });
    expect(fixtures.withdrawal.reconciliation.marketMovement.amountMinor).toBe(0n);
    expect(fixtures.stage3ContributionPattern.monthlyRecurring.amount.amountMinor).toBe(5_000n);
    expect(fixtures.stage3ContributionPattern.adHoc.amount.amountMinor).toBe(100_000n);
  });

  it('requires positive typed contribution evidence and confirmed deterministic matching', () => {
    const evidence = PORTFOLIO_CONTRACT_FIXTURES.contributionOnly.evidence;
    expect(evidence.direction).toBe('contribution');
    expect(PORTFOLIO_CONTRACT_FIXTURES.withdrawal.evidence.direction).toBe('withdrawal');
    expectContractError(
      () => createContributionEvidence({ ...evidence, amount: createMoney(0n, EUR) }),
      'non_positive_contribution',
    );

    const matchEvidence = {
      amountAndCurrencyExact: true,
      effectiveTimeDistanceSeconds: 30,
      providerReferenceExact: true,
      bankReferenceExact: true,
      portfolioAccountExact: true,
      canonicalTransferId: 'transfer-1',
    } as const;
    expect(
      validateContributionMatch({
        state: 'confirmed',
        evidence: matchEvidence,
        confirmedContributionKey: 'connection-1:contribution-1',
      }).state,
    ).toBe('confirmed');
    expectContractError(
      () =>
        validateContributionMatch({
          state: 'candidate',
          evidence: matchEvidence,
          confirmedContributionKey: 'not-authoritative-yet',
        }),
      'invalid_match_authority',
    );
  });

  it('round-trips every opaque cursor shape and canonicalizes composite fields', () => {
    const cursors: readonly PortfolioCursor[] = [
      { kind: 'opaque', value: 'opaque-state' },
      { kind: 'page_token', value: 'page-42' },
      { kind: 'timestamp_watermark', value: parseInstant('2026-09-15T18:00:00Z') },
      { kind: 'composite', value: { page: '2', watermark: 'abc' } },
    ];
    for (const cursor of cursors) {
      expect(parsePortfolioCursor(serializePortfolioCursor(cursor))).toEqual(cursor);
    }
    expect(serializePortfolioCursor({ kind: 'composite', value: { z: 'last', a: 'first' } })).toBe(
      '{"kind":"composite","value":{"a":"first","z":"last"}}',
    );
    expectContractError(
      () => parsePortfolioCursor('{"kind":"numeric","value":1}'),
      'invalid_cursor',
    );
  });

  it('uses stable source identity plus revision or deterministic SHA-256 fingerprint', () => {
    const revision = createProviderRevisionIdentity({
      sourceId: 'valuation-1',
      version: { kind: 'provider_revision', value: 'r2' },
    });
    const fingerprint = createProviderRevisionIdentity({
      sourceId: 'valuation-without-revision',
      version: { kind: 'sha256_fingerprint', value: 'a'.repeat(64) },
    });
    expect(revision.version.value).toBe('r2');
    expect(fingerprint.version.kind).toBe('sha256_fingerprint');
    expectContractError(
      () =>
        createProviderRevisionIdentity({
          sourceId: 'valuation-1',
          version: { kind: 'sha256_fingerprint', value: 'not-a-hash' },
        }),
      'invalid_fingerprint',
    );
  });

  it('makes stale, missing, ambiguous cash, and missing FX suppress recommendations', () => {
    const now = parseInstant('2026-09-17T18:00:00Z');
    expect(assessPortfolioReadiness(PORTFOLIO_CONTRACT_FIXTURES.valuationOnly, now)).toMatchObject({
      completeness: 'complete',
      recommendationAllowed: true,
    });
    const stale = assessPortfolioReadiness(PORTFOLIO_CONTRACT_FIXTURES.staleValuation, now);
    expect(stale).toMatchObject({
      completeness: 'partial',
      recommendationAllowed: false,
    });
    expect(stale.warnings).toContain('stale_valuation');
    expect(assessPortfolioReadiness(null, now)).toEqual({
      completeness: 'unavailable',
      recommendationAllowed: false,
      warnings: ['missing_valuation'],
    });
    const unknownCash = assessPortfolioReadiness(
      PORTFOLIO_CONTRACT_FIXTURES.cashTreatmentUnknown,
      now,
    );
    expect(unknownCash).toMatchObject({
      completeness: 'unavailable',
      recommendationAllowed: false,
    });
    expect(unknownCash.warnings).toContain('cash_treatment_unknown');

    const base = PORTFOLIO_CONTRACT_FIXTURES.valuationOnly;
    const missingFx = createMissingFxReportableAmount(
      createMoney(1_000_000n, parseCurrencyCode('GBP')),
    );
    const fxUnavailable = createPortfolioSnapshot({
      ...base,
      providerReportedMarketValue: missingFx,
      totalMarketValue: missingFx,
      cash: { treatment: 'included_in_total', amount: null },
      netWorthProjection: { kind: 'unavailable', reason: 'fx_unavailable' },
    });
    const unavailableFx = assessPortfolioReadiness(fxUnavailable, now);
    expect(unavailableFx).toMatchObject({
      completeness: 'unavailable',
      recommendationAllowed: false,
    });
    expect(unavailableFx.warnings).toContain('fx_unavailable');
  });

  it('does not use empty holdings to mean unsupported and zero holdings simultaneously', () => {
    const base = PORTFOLIO_CONTRACT_FIXTURES.valuationOnly;
    expectContractError(
      () =>
        createPortfolioSnapshot({
          ...base,
          holdings: {
            completeness: 'unavailable',
            items: [
              {
                ...base.holdings.items[0]!,
                quantity: parseDecimalRate('1'),
              },
            ],
          },
        }),
      'unavailable_holdings',
    );
    const noHoldingsCapability = allCapabilities(false);
    expect(noHoldingsCapability.holdings).toBe(false);
    const genuineZeroHoldings = createPortfolioSnapshot({
      ...base,
      holdings: { completeness: 'complete', items: [] },
    });
    expect(genuineZeroHoldings.holdings).toEqual({ completeness: 'complete', items: [] });
  });

  it('keeps provider P/L reconciliation-only when it disagrees with derived movement', () => {
    const fixture = PORTFOLIO_CONTRACT_FIXTURES.providerPlDisagreement;
    expect(fixture.derivedMarketMovement.amountMinor).toBe(50_000n);
    expect(fixture.providerProfitLoss.amount.original.amountMinor).toBe(60_000n);
    expect(fixture.providerProfitLoss.authority).toBe('reconciliation_only');
    expect(fixture.providerProfitLoss.semantics).toBe('unknown');
  });

  it('replays identical facts and pages stably without changing exact money', () => {
    const fact = PORTFOLIO_CONTRACT_FIXTURES.valuationOnly;
    expect(createPortfolioSnapshot(fact)).toEqual(createPortfolioSnapshot(fact));
    expect(PORTFOLIO_CONTRACT_FIXTURES.duplicateProviderPage.first).toEqual(
      PORTFOLIO_CONTRACT_FIXTURES.duplicateProviderPage.replay,
    );
    const large = createMoney(9_000_000_000_000_001n, EUR);
    const result = calculateMarketMovement(large, large, [], createMoney(0n, EUR));
    expect(result.marketMovement.amountMinor).toBe(0n);
  });
});
