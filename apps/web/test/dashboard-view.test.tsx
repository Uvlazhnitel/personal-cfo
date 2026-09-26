import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { DashboardMetric, DashboardMoney, DashboardOverview } from '@personal-cfo/data';

import { DashboardView, formatMoney, formatRatio } from '../src/app/dashboard-view.js';
import manifest from '../src/app/manifest.js';

const money = (amountMinor: bigint): DashboardMoney =>
  Object.freeze({ amountMinor, currency: 'EUR' });

const metric = <T,>(
  value: T,
  state: DashboardMetric<T>['state'] = 'available',
): DashboardMetric<T> =>
  Object.freeze({ state, value, asOf: '2026-09-26T12:00:00.000Z', reason: null });

function overview(overrides: Partial<DashboardOverview> = {}): DashboardOverview {
  return Object.freeze({
    locale: 'en',
    timeZone: 'Europe/Riga',
    synthetic: true,
    metrics: Object.freeze({
      netWorth: metric(money(1_234_567n)),
      monthlyNetWorthChange: metric(money(12_300n)),
      capitalConversionRate: metric(Object.freeze({ numerator: 1n, denominator: 3n })),
      safeToInvest: metric(money(24_000n)),
      availableCash: metric(money(670_000n)),
      comfortReserve: metric(money(450_000n)),
      investmentPortfolio: metric(money(500_000n)),
      reservedSinkingFunds: metric(money(90_000n)),
    }),
    sources: Object.freeze({
      bank: Object.freeze({
        state: 'incomplete',
        label: 'Connected',
        lastSuccessfulAt: '2026-09-26T11:00:00.000Z',
        detail: 'Validation only.',
      }),
      portfolio: Object.freeze({
        state: 'unavailable',
        label: 'Not connected',
        lastSuccessfulAt: null,
        detail: 'No provider.',
      }),
      lastSuccessfulUpdate: '2026-09-26T11:00:00.000Z',
    }),
    ...overrides,
  });
}

describe('mobile dashboard presentation', () => {
  it('formats exact bigint money and ratios without financial floating point', () => {
    expect(formatMoney(money(1_234_567n), 'en')).toBe('€12,345.67');
    expect(formatMoney(money(-505n), 'en')).toBe('−€5.05');
    expect(formatRatio({ numerator: 1n, denominator: 3n })).toBe('33.3%');
  });

  it('renders persisted values and unmistakable synthetic labeling', () => {
    const html = renderToStaticMarkup(createElement(DashboardView, { overview: overview() }));
    expect(html).toContain('Demo data');
    expect(html).toContain('not real financial data');
    expect(html).toContain('€12,345.67');
    expect(html).toContain('33.3%');
    expect(html).toContain('+€123 this month');
  });

  it('renders unavailable Safe to Invest without substituting zero', () => {
    const original = overview();
    const html = renderToStaticMarkup(
      createElement(DashboardView, {
        overview: {
          ...original,
          metrics: {
            ...original.metrics,
            safeToInvest: {
              state: 'incomplete',
              value: null,
              asOf: '2026-09-26T12:00:00.000Z',
              reason: 'recommendation_blocked',
            },
          },
        },
      }),
    );
    expect(html).toContain('Safe to Invest');
    expect(html).toContain('Incomplete or unreconciled source data');
    expect(html).not.toContain('€0');
  });

  it('publishes a standalone manifest without offline infrastructure', () => {
    expect(manifest()).toMatchObject({
      name: 'Personal CFO',
      start_url: '/',
      display: 'standalone',
    });
  });
});
