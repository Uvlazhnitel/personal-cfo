import { createHash } from 'node:crypto';

import { PORTFOLIO_MANAGER_CONTRACT_VERSION, PORTFOLIO_MANAGER_PROVIDER_ID } from './types.js';

const identity = Object.freeze({
  contractVersion: PORTFOLIO_MANAGER_CONTRACT_VERSION,
  provider: PORTFOLIO_MANAGER_PROVIDER_ID,
  providerInstanceId: 'synthetic-household-portfolio',
  portfolioId: 'synthetic-household-portfolio',
});

const capabilities = Object.freeze({
  totalMarketValue: true,
  holdings: true,
  holdingMarketValues: true,
  cashIncludedInValuation: true,
  contributionWithdrawalHistory: true,
  reportingCurrency: true,
  sourceFreshnessTimestamps: true,
  deterministicIncrementalCapitalFlowCursor: true,
  revisionsCorrections: true,
  pnl: false,
  historicalValuations: false,
  distributions: false,
  fees: false,
  fxInformation: false,
});

function flowFingerprint(flow: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash('sha256')
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
    .digest('hex')}`;
}

function flow(input: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const canonical = Object.freeze({
    eventId: 'event-deposit-1',
    revisionId: 'revision-deposit-1',
    sourceTransactionId: 'revision-deposit-1',
    status: 'ACTIVE',
    direction: 'contribution',
    accountId: 'brokerage-account-1',
    assetId: 'asset-eur',
    amount: '1000',
    amountUnavailableReason: null,
    currency: 'EUR',
    effectiveAt: '2026-09-01T08:00:00.000Z',
    changedAt: '2026-09-01T08:00:01.000Z',
    replacesRevisionId: null,
    replacementRevisionIds: Object.freeze([]),
    ...input,
  });
  return Object.freeze({ ...canonical, revisionFingerprint: flowFingerprint(canonical) });
}

const eurCashHolding = Object.freeze({
  providerHoldingId: 'brokerage-account-1:asset-eur',
  accountId: 'brokerage-account-1',
  assetId: 'asset-eur',
  symbol: 'EUR',
  name: 'Euro',
  assetClass: 'CASH',
  assetType: 'FIAT',
  quantity: '25.125',
  currentMarketValue: '25.125',
  price: '1',
  priceCurrency: 'EUR',
  priceSource: 'BASE_CURRENCY',
  priceTimestamp: null,
  isPriceStale: false,
});

const vglaLondon = Object.freeze({
  providerHoldingId: 'brokerage-account-1:asset-vgla-london',
  accountId: 'brokerage-account-1',
  assetId: 'asset-vgla-london',
  symbol: 'VGLA',
  name: 'Vanguard Global Aggregate Bond UCITS ETF',
  assetClass: 'BOND',
  assetType: 'ETF',
  quantity: '10.123456789',
  currentMarketValue: '1000.5555',
  price: '98.834567891234',
  priceCurrency: 'EUR',
  priceSource: 'MANUAL',
  priceTimestamp: '2026-09-23T10:00:00.000Z',
  isPriceStale: false,
});

const vglaOtherListing = Object.freeze({
  ...vglaLondon,
  providerHoldingId: 'brokerage-account-1:asset-vgla-other-listing',
  assetId: 'asset-vgla-other-listing',
  quantity: '2.5',
  currentMarketValue: '250.25',
  price: '100.1',
  priceCurrency: 'USD',
  priceSource: 'YAHOO',
});

function snapshot(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...identity,
    generatedAt: '2026-09-23T12:00:00.000Z',
    reportingCurrency: 'EUR',
    valuation: {
      status: 'complete',
      totalValue: '1276.9305',
      knownValuedSubtotal: '1276.9305',
      missingPriceSymbols: [],
      hasStalePrices: false,
      sourceAsOf: '2026-09-23T10:00:00.000Z',
      sourceAsOfSemantics: 'oldest_component_quote',
    },
    cash: { treatment: 'included_in_total', amount: '25.125', currency: 'EUR' },
    holdings: {
      completeness: 'complete',
      items: [eurCashHolding, vglaLondon, vglaOtherListing],
    },
    ...overrides,
  };
}

const deposit = flow({});
const withdrawal = flow({
  eventId: 'event-withdrawal-1',
  revisionId: 'revision-withdrawal-1',
  sourceTransactionId: 'revision-withdrawal-1',
  direction: 'withdrawal',
  amount: '200',
  effectiveAt: '2026-09-02T08:00:00.000Z',
  changedAt: '2026-09-02T08:00:01.000Z',
});
const replaced = flow({
  status: 'REPLACED',
  replacementRevisionIds: ['revision-deposit-2'],
  changedAt: '2026-09-03T08:00:00.000Z',
});
const replacement = flow({
  revisionId: 'revision-deposit-2',
  sourceTransactionId: 'revision-deposit-2',
  amount: '1100',
  replacesRevisionId: 'revision-deposit-1',
  changedAt: '2026-09-03T08:00:01.000Z',
});
const voided = flow({
  revisionId: 'revision-deposit-3',
  sourceTransactionId: 'revision-deposit-3',
  status: 'VOIDED',
  amount: '1100',
  replacesRevisionId: 'revision-deposit-2',
  changedAt: '2026-09-04T08:00:00.000Z',
});

export const PORTFOLIO_MANAGER_CONTRACT_FIXTURES = Object.freeze({
  capabilities: JSON.stringify({ ...identity, capabilities }),
  completeSnapshot: JSON.stringify(snapshot()),
  partialSnapshot: JSON.stringify(
    snapshot({
      valuation: {
        status: 'partial',
        totalValue: null,
        knownValuedSubtotal: '1025.6805',
        missingPriceSymbols: ['VGLA'],
        hasStalePrices: true,
        sourceAsOf: '2026-09-23T10:00:00.000Z',
        sourceAsOfSemantics: 'oldest_component_quote',
      },
      cash: { treatment: 'included_in_total', amount: '25.125', currency: 'EUR' },
      holdings: {
        completeness: 'partial',
        items: [
          eurCashHolding,
          vglaLondon,
          { ...vglaOtherListing, currentMarketValue: null, price: null, priceTimestamp: null },
        ],
      },
    }),
  ),
  emptySnapshot: JSON.stringify(
    snapshot({
      valuation: {
        status: 'complete',
        totalValue: '0',
        knownValuedSubtotal: '0',
        missingPriceSymbols: [],
        hasStalePrices: false,
        sourceAsOf: null,
        sourceAsOfSemantics: 'oldest_component_quote',
      },
      cash: { treatment: 'included_in_total', amount: '0', currency: 'EUR' },
      holdings: { completeness: 'complete', items: [] },
    }),
  ),
  nonEurSnapshot: JSON.stringify(
    snapshot({
      reportingCurrency: 'USD',
      cash: { treatment: 'included_in_total', amount: '25.125', currency: 'USD' },
    }),
  ),
  capitalFlows: JSON.stringify({
    ...identity,
    items: [deposit, withdrawal],
    hasMore: false,
    nextCursor: 'eyJ2IjoxLCJjaGFuZ2VkQXQiOiIyMDI2LTA5LTAyVDA4OjAwOjAxLjAwMFoifQ',
  }),
  replacementFlows: JSON.stringify({
    ...identity,
    items: [replaced, replacement, voided],
    hasMore: false,
    nextCursor: 'eyJ2IjoxLCJyZXZpc2lvbklkIjoicmV2aXNpb24tZGVwb3NpdC0zIn0',
  }),
  firstCapitalFlowPage: JSON.stringify({
    ...identity,
    items: [deposit],
    hasMore: true,
    nextCursor: 'eyJ2IjoxLCJyZXZpc2lvbklkIjoicmV2aXNpb24tZGVwb3NpdC0xIn0',
  }),
  emptyCapitalFlowPage: JSON.stringify({
    ...identity,
    items: [],
    hasMore: false,
    nextCursor: null,
  }),
  items: Object.freeze({
    deposit,
    withdrawal,
    replaced,
    replacement,
    voided,
    eurCashHolding,
    vglaLondon,
    vglaOtherListing,
  }),
});
