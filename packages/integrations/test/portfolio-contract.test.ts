import {
  EUR,
  createMissingFxReportableAmount,
  createMoney,
  parseCurrencyCode,
  parseDecimalRate,
  parseInstant,
} from '@personal-cfo/domain';
import type { DomainValidationError } from '@personal-cfo/domain';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  PORTFOLIO_CAPABILITIES,
  PORTFOLIO_CONTRACT_FIXTURES,
  assessPortfolioReadiness,
  calculateMarketMovement,
  createConfirmedContributionPrincipal,
  createContributionEvidence,
  createPortfolioCapabilities,
  createPortfolioSnapshot,
  createProviderRevisionIdentity,
  parsePortfolioCursor,
  reconcileHoldings,
  serializePortfolioCursor,
  validateConfirmedContributionPrincipal,
  validateContributionMatch,
} from '../src/portfolio/index.js';
import type {
  ConfirmedContributionPrincipal,
  ContributionEvidence,
  PortfolioCapabilities,
  PortfolioCursor,
} from '../src/portfolio/index.js';

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
    expect(fixtures.mixedContributionAndGain.reconciliation).toMatchObject({
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
    expect(PORTFOLIO_CONTRACT_FIXTURES.contributionOnly.principal).toMatchObject({
      authority: 'confirmed_principal',
      contributionKey: 'principal-contribution-1',
      canonicalTransferId: 'transfer-contribution-1',
      amount: { amountMinor: 100_000n },
    });
    expectContractError(
      () =>
        validateContributionMatch({
          state: 'candidate',
          evidence: matchEvidence,
          confirmedContributionKey: 'not-authoritative-yet',
        }),
      'invalid_match_authority',
    );
    expectContractError(
      () =>
        validateContributionMatch({
          state: 'confirmed',
          evidence: { ...matchEvidence, amountAndCurrencyExact: false },
          confirmedContributionKey: 'connection-1:contribution-1',
        }),
      'insufficient_match_evidence',
    );
    expectContractError(
      () =>
        validateContributionMatch({
          state: 'candidate',
          evidence: {
            ...matchEvidence,
            amountAndCurrencyExact: 'yes' as unknown as boolean,
            canonicalTransferId: null,
          },
          confirmedContributionKey: null,
        }),
      'invalid_match_evidence',
    );
    expectContractError(
      () =>
        validateConfirmedContributionPrincipal({
          ...PORTFOLIO_CONTRACT_FIXTURES.contributionOnly.principal,
          amount: createMoney(0n, EUR),
        }),
      'non_positive_principal',
    );
  });

  it('keeps raw provider evidence outside authoritative market reconciliation', () => {
    expectTypeOf<ContributionEvidence>().not.toMatchTypeOf<ConfirmedContributionPrincipal>();
    expectTypeOf(calculateMarketMovement)
      .parameter(2)
      .toEqualTypeOf<readonly ConfirmedContributionPrincipal[]>();

    const unmatched = PORTFOLIO_CONTRACT_FIXTURES.unmatchedContributionEvidence;
    expect(unmatched.principal).toBeNull();
    expect(unmatched.reconciliation).toMatchObject({
      contributions: { amountMinor: 0n },
      marketMovement: { amountMinor: 100_000n },
    });

    const candidate = PORTFOLIO_CONTRACT_FIXTURES.candidateContributionEvidence;
    expect(candidate.principal).toBeNull();
    expect(candidate.reconciliation).toMatchObject({
      contributions: { amountMinor: 0n },
      marketMovement: { amountMinor: 100_000n },
    });
  });

  it('rejects a confirmed contribution matched to the wrong portfolio account', () => {
    const attempt = PORTFOLIO_CONTRACT_FIXTURES.crossAccountConfirmedAttempt;
    expectContractError(
      () => createConfirmedContributionPrincipal(attempt.evidence, attempt.match),
      'portfolio_account_mismatch',
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
    const exactHoldings = reconcileHoldings(
      PORTFOLIO_CONTRACT_FIXTURES.valuationOnly,
      createMoney(1n, EUR),
    );
    expect(
      assessPortfolioReadiness(PORTFOLIO_CONTRACT_FIXTURES.valuationOnly, now, {
        holdingsReconciliation: exactHoldings,
      }),
    ).toMatchObject({ completeness: 'complete', recommendationAllowed: true });
    const stale = assessPortfolioReadiness(PORTFOLIO_CONTRACT_FIXTURES.staleValuation, now, {
      holdingsReconciliation: reconcileHoldings(
        PORTFOLIO_CONTRACT_FIXTURES.staleValuation,
        createMoney(1n, EUR),
      ),
    });
    expect(stale).toMatchObject({
      completeness: 'partial',
      recommendationAllowed: false,
    });
    expect(stale.warnings).toContain('stale_valuation');
    expect(
      assessPortfolioReadiness(null, now, {
        holdingsReconciliation: { status: 'unavailable', difference: null },
      }),
    ).toEqual({
      completeness: 'unavailable',
      recommendationAllowed: false,
      warnings: ['missing_valuation'],
    });
    const unknownCash = assessPortfolioReadiness(
      PORTFOLIO_CONTRACT_FIXTURES.cashTreatmentUnknown,
      now,
      { holdingsReconciliation: { status: 'unavailable', difference: null } },
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
    const unavailableFx = assessPortfolioReadiness(fxUnavailable, now, {
      holdingsReconciliation: { status: 'unavailable', difference: null },
    });
    expect(unavailableFx).toMatchObject({
      completeness: 'unavailable',
      recommendationAllowed: false,
    });
    expect(unavailableFx.warnings).toContain('fx_unavailable');
  });

  it('gates recommendations only for a material holdings mismatch', () => {
    const now = parseInstant('2026-09-17T18:00:00Z');
    const material = PORTFOLIO_CONTRACT_FIXTURES.materialHoldingsMismatch;
    const materialReadiness = assessPortfolioReadiness(material.snapshot, now, {
      holdingsReconciliation: material.reconciliation,
    });
    expect(materialReadiness).toMatchObject({
      completeness: 'partial',
      recommendationAllowed: false,
    });
    expect(materialReadiness.warnings).toContain('valuation_components_mismatch');

    const withinRounding = PORTFOLIO_CONTRACT_FIXTURES.withinRoundingHoldings;
    const withinReadiness = assessPortfolioReadiness(withinRounding.snapshot, now, {
      holdingsReconciliation: withinRounding.reconciliation,
    });
    expect(withinReadiness).toMatchObject({
      completeness: 'complete',
      recommendationAllowed: true,
    });
    expect(withinReadiness.warnings).not.toContain('valuation_components_mismatch');

    const unavailable = PORTFOLIO_CONTRACT_FIXTURES.unavailableHoldingsDetail;
    const unavailableReadiness = assessPortfolioReadiness(unavailable.snapshot, now, {
      holdingsReconciliation: unavailable.reconciliation,
    });
    expect(unavailableReadiness).toMatchObject({
      completeness: 'complete',
      recommendationAllowed: true,
    });
    expect(unavailableReadiness.warnings).toContain('holdings_incomplete');
    expect(unavailableReadiness.warnings).not.toContain('valuation_components_mismatch');
    expectContractError(
      () =>
        assessPortfolioReadiness(material.snapshot, now, {
          holdingsReconciliation: { status: 'material_mismatch', difference: null },
        }),
      'invalid_holdings_reconciliation',
    );
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
