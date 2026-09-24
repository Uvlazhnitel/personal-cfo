import { createHash } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseInstant } from '@personal-cfo/domain';

import {
  PORTFOLIO_MANAGER_CONTRACT_FIXTURES,
  assertPortfolioManagerIdentity,
  decodePortfolioManagerCapabilities,
  decodePortfolioManagerCapitalFlows,
  decodePortfolioManagerSnapshot,
  normalizePortfolioManagerCapitalFlow,
  normalizePortfolioManagerSnapshot,
  portfolioManagerDecimalToExactMinor,
  portfolioManagerDecimalToMinorHalfEven,
  validatePortfolioManagerCapabilities,
} from '../src/portfolio/portfolio-manager/index.js';
import type {
  PortfolioManagerExactDecimal,
  PortfolioManagerSnapshotContext,
} from '../src/portfolio/portfolio-manager/index.js';
import type {
  ConfirmedContributionPrincipal,
  ContributionEvidence,
} from '../src/portfolio/types.js';

const context: PortfolioManagerSnapshotContext = {
  ownerId: '018f0000-0000-7000-8000-000000000001' as never,
  accountId: '018f0000-0000-7000-8000-000000000002' as never,
  connectionId: 'connection-fixture',
  receivedAt: parseInstant('2026-09-23T12:00:01Z'),
  freshStaleAt: parseInstant('2026-09-23T12:00:01Z'),
};

function flowContext() {
  return {
    connectionId: 'connection-fixture',
    providerInstanceId: 'synthetic-household-portfolio',
    providerPortfolioId: 'synthetic-household-portfolio',
  } as const;
}

function withFingerprint<T extends Record<string, unknown>>(
  flow: T,
): T & {
  revisionFingerprint: string;
} {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        'portfolio-manager-capital-flow-revision-v1',
        flow['eventId'],
        flow['revisionId'],
        flow['status'],
        flow['direction'],
        flow['amount'],
        flow['amountUnavailableReason'],
        flow['currency'],
        flow['accountId'],
        flow['assetId'],
        flow['effectiveAt'],
        flow['changedAt'],
        flow['replacesRevisionId'],
        flow['replacementRevisionIds'],
      ]),
      'utf8',
    )
    .digest('hex');
  return { ...flow, revisionFingerprint: `sha256:${fingerprint}` };
}

describe('Portfolio Manager provider binding', () => {
  it('validates the exact v1 capability contract', () => {
    const decoded = decodePortfolioManagerCapabilities(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities,
    );
    expect(validatePortfolioManagerCapabilities(decoded)).toMatchObject({
      total_market_value: true,
      incremental_cursor: true,
      provider_profit_loss: false,
      fx_information: false,
    });
    expect(() =>
      validatePortfolioManagerCapabilities({
        ...decoded,
        capabilities: { ...decoded.capabilities, revisionsCorrections: false },
      }),
    ).toThrow('revisionsCorrections');
  });

  it('rejects incompatible versions and identity changes', () => {
    const wrongVersion = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities) as Record<
      string,
      unknown
    >;
    wrongVersion['contractVersion'] = 'portfolio-manager-personal-cfo-v2';
    expect(() => decodePortfolioManagerCapabilities(JSON.stringify(wrongVersion))).toThrow(
      'contract version',
    );
    const identity = decodePortfolioManagerCapabilities(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities,
    );
    expect(() =>
      assertPortfolioManagerIdentity(identity, { ...identity, portfolioId: 'different' }),
    ).toThrow('identity changed');
  });

  it('normalizes an EUR total, preserves included cash, and separates listing identity', () => {
    const provider = decodePortfolioManagerSnapshot(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.completeSnapshot,
    );
    const normalized = normalizePortfolioManagerSnapshot(provider, context);
    expect(normalized.status).toBe('normalized');
    if (normalized.status !== 'normalized') throw new Error('Expected normalized snapshot.');
    expect(normalized.snapshot.providerReportedMarketValue?.original.amountMinor).toBe(127_693n);
    expect(normalized.snapshot.knownValuedSubtotal.original.amountMinor).toBe(127_693n);
    expect(normalized.snapshot.cash).toMatchObject({
      treatment: 'included_in_total',
      amount: { original: { amountMinor: 2_512n } },
    });
    expect(normalized.snapshot.holdings.items).toHaveLength(2);
    expect(normalized.snapshot.holdings.items.map((item) => item.providerSecurityId)).toEqual([
      'asset-vgla-london',
      'asset-vgla-other-listing',
    ]);
    expect(normalized.holdings.filter((item) => item.symbol === 'VGLA')).toEqual([
      expect.objectContaining({ assetId: 'asset-vgla-london', priceCurrency: 'EUR' }),
      expect.objectContaining({ assetId: 'asset-vgla-other-listing', priceCurrency: 'USD' }),
    ]);
  });

  it('keeps a partial known subtotal without inventing an authoritative total', () => {
    const provider = decodePortfolioManagerSnapshot(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.partialSnapshot,
    );
    const normalized = normalizePortfolioManagerSnapshot(provider, context);
    expect(normalized.status).toBe('normalized');
    if (normalized.status !== 'normalized') throw new Error('Expected normalized snapshot.');
    expect(normalized.snapshot.providerReportedMarketValue).toBeNull();
    expect(normalized.snapshot.totalMarketValue).toBeNull();
    expect(normalized.snapshot.knownValuedSubtotal.original.amountMinor).toBe(102_568n);
    expect(normalized.snapshot.netWorthProjection).toEqual({
      kind: 'unavailable',
      reason: 'missing_valuation',
    });
    expect(normalized.snapshot.sourceCompleteness).toBe('partial');
    expect(normalized.warnings).toEqual(
      expect.arrayContaining(['missing_valuation', 'holdings_incomplete', 'source_incomplete']),
    );
  });

  it('keeps an empty zero portfolio non-authoritative when component freshness is absent', () => {
    const normalized = normalizePortfolioManagerSnapshot(
      decodePortfolioManagerSnapshot(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.emptySnapshot),
      context,
    );
    expect(normalized.status).toBe('normalized');
    if (normalized.status !== 'normalized') throw new Error('Expected normalized snapshot.');
    expect(normalized.snapshot.totalMarketValue?.original.amountMinor).toBe(0n);
    expect(normalized.snapshot.sourceCompleteness).toBe('partial');
    expect(normalized.snapshot.sourceAsOf).toBe('2026-09-23T12:00:00Z');
  });

  it('quarantines a non-EUR reporting snapshot without fabricating FX', () => {
    expect(
      normalizePortfolioManagerSnapshot(
        decodePortfolioManagerSnapshot(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.nonEurSnapshot),
        context,
      ),
    ).toEqual({
      status: 'quarantined',
      category: 'portfolio_manager_non_eur_reporting_currency',
    });
  });

  it('uses exact bigint half-even valuation rounding and exact-minor contribution parsing', () => {
    const value = (source: string) => source as PortfolioManagerExactDecimal;
    expect(portfolioManagerDecimalToMinorHalfEven(value('1.005'))).toBe(100n);
    expect(portfolioManagerDecimalToMinorHalfEven(value('1.015'))).toBe(102n);
    expect(portfolioManagerDecimalToMinorHalfEven(value('-1.015'))).toBe(-102n);
    expect(portfolioManagerDecimalToExactMinor(value('12.34000'))).toBe(1_234n);
    expect(portfolioManagerDecimalToExactMinor(value('12.34001'))).toBeNull();

    const overflow = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.completeSnapshot) as Record<
      string,
      unknown
    >;
    overflow['valuation'] = {
      ...(overflow['valuation'] as Record<string, unknown>),
      totalValue: '92233720368547758.08',
      knownValuedSubtotal: '92233720368547758.08',
    };
    expect(() =>
      normalizePortfolioManagerSnapshot(
        decodePortfolioManagerSnapshot(JSON.stringify(overflow)),
        context,
      ),
    ).toThrow('BIGINT');
  });

  it('creates provider evidence for active deposits and withdrawals only', () => {
    const page = decodePortfolioManagerCapitalFlows(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows,
    );
    const deposit = normalizePortfolioManagerCapitalFlow(page.items[0]!, flowContext());
    const withdrawal = normalizePortfolioManagerCapitalFlow(page.items[1]!, flowContext());
    expect(deposit).toMatchObject({
      status: 'normalized',
      evidence: {
        providerContributionId: 'event-deposit-1',
        direction: 'contribution',
        amount: { amountMinor: 100_000n, currency: 'EUR' },
      },
    });
    expect(withdrawal).toMatchObject({
      status: 'normalized',
      evidence: { direction: 'withdrawal', amount: { amountMinor: 20_000n } },
    });
    if (deposit.status !== 'normalized' || deposit.evidence === null) {
      throw new Error('Expected contribution evidence.');
    }
    expectTypeOf(deposit.evidence).toEqualTypeOf<ContributionEvidence>();
    expectTypeOf(deposit.evidence).not.toMatchTypeOf<ConfirmedContributionPrincipal>();
  });

  it('preserves replacement and void observations without active evidence', () => {
    const page = decodePortfolioManagerCapitalFlows(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.replacementFlows,
    );
    const normalized = page.items.map((item) =>
      normalizePortfolioManagerCapitalFlow(item, flowContext()),
    );
    expect(normalized.map((item) => item.observation.status)).toEqual([
      'REPLACED',
      'ACTIVE',
      'VOIDED',
    ]);
    expect(normalized[0]).toMatchObject({ status: 'normalized', evidence: null });
    expect(normalized[1]).toMatchObject({
      status: 'normalized',
      evidence: { amount: { amountMinor: 110_000n } },
    });
    expect(normalized[2]).toMatchObject({ status: 'normalized', evidence: null });
    expect(normalized[0]!.observation.revision.sourceId).toBe(
      normalized[2]!.observation.revision.sourceId,
    );
  });

  it('quarantines unavailable, sub-minor, and non-EUR active amounts', () => {
    const base = { ...PORTFOLIO_MANAGER_CONTRACT_FIXTURES.items.deposit } as Record<
      string,
      unknown
    >;
    delete base['revisionFingerprint'];
    const decodeOne = (changes: Record<string, unknown>) => {
      const body = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows) as Record<
        string,
        unknown
      >;
      body['items'] = [withFingerprint({ ...base, ...changes })];
      return decodePortfolioManagerCapitalFlows(JSON.stringify(body)).items[0]!;
    };
    expect(
      normalizePortfolioManagerCapitalFlow(
        decodeOne({
          amount: null,
          amountUnavailableReason: 'MISSING_OR_NON_POSITIVE_ORIGINAL_AMOUNT',
        }),
        flowContext(),
      ),
    ).toMatchObject({ status: 'quarantined', category: 'portfolio_manager_amount_unavailable' });
    expect(
      normalizePortfolioManagerCapitalFlow(decodeOne({ amount: '1000.001' }), flowContext()),
    ).toMatchObject({ status: 'quarantined', category: 'portfolio_manager_subminor_contribution' });
    expect(
      normalizePortfolioManagerCapitalFlow(decodeOne({ currency: 'USD' }), flowContext()),
    ).toMatchObject({ status: 'quarantined', category: 'portfolio_manager_non_eur_contribution' });
  });

  it('rejects tampered fingerprints and malformed cursors deterministically', () => {
    const decoded = decodePortfolioManagerCapitalFlows(
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows,
    );
    expect(() =>
      normalizePortfolioManagerCapitalFlow(
        { ...decoded.items[0]!, revisionFingerprint: `sha256:${'0'.repeat(64)}` },
        flowContext(),
      ),
    ).toThrow('fingerprint');
    const raw = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.firstCapitalFlowPage) as Record<
      string,
      unknown
    >;
    raw['nextCursor'] = 'not a cursor';
    expect(() => decodePortfolioManagerCapitalFlows(JSON.stringify(raw))).toThrow('cursor');

    const zeroAmount = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows) as Record<
      string,
      unknown
    >;
    const zeroItem: Record<string, unknown> = {
      ...(zeroAmount['items'] as Record<string, unknown>[])[0],
      amount: '0.00',
    };
    delete zeroItem['revisionFingerprint'];
    zeroAmount['items'] = [withFingerprint(zeroItem)];
    expect(() => decodePortfolioManagerCapitalFlows(JSON.stringify(zeroAmount))).toThrow(
      'positive magnitude',
    );
  });
});
