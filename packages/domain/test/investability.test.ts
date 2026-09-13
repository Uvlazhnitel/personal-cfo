import { describe, expect, it } from 'vitest';

import {
  EUR,
  createCashDragDailyObservation,
  createInvestabilityReadiness,
  createMoney,
  parseCurrencyCode,
  parseLocalDate,
} from '../src/index.js';
import type { InvestabilityReadiness } from '../src/index.js';

describe('investability readiness', () => {
  it('creates immutable complete and canonically ordered reason states', () => {
    const complete = createInvestabilityReadiness({ kind: 'complete' });
    const provisional = createInvestabilityReadiness({
      kind: 'provisional',
      reasons: ['non_material_cash_variance', 'non_material_unresolved_transfer'],
    });

    expect(complete).toEqual({ kind: 'complete' });
    expect(provisional).toEqual({
      kind: 'provisional',
      reasons: ['non_material_unresolved_transfer', 'non_material_cash_variance'],
    });
    expect(Object.isFrozen(provisional)).toBe(true);
    if (provisional.kind !== 'provisional') throw new Error('Expected provisional readiness.');
    expect(Object.isFrozen(provisional.reasons)).toBe(true);
  });

  it('rejects missing, duplicate, and invalid readiness reasons', () => {
    expect(() => createInvestabilityReadiness({ kind: 'blocked', reasons: [] })).toThrow(
      'requires at least one reason',
    );
    expect(() =>
      createInvestabilityReadiness({
        kind: 'provisional',
        reasons: ['non_material_cash_variance', 'non_material_cash_variance'],
      }),
    ).toThrow('must be unique');
    expect(() =>
      createInvestabilityReadiness({
        kind: 'blocked',
        reasons: ['not-a-reason'],
      } as unknown as InvestabilityReadiness),
    ).toThrow('BlockingInvestabilityReason must be one of');
  });
});

describe('CashDragDailyObservation', () => {
  it('validates and freezes a provider-neutral daily observation', () => {
    const observation = createCashDragDailyObservation({
      date: parseLocalDate('2026-09-13'),
      liquidCash: createMoney(700_000n, EUR),
      comfortCash: createMoney(500_000n, EUR),
      completeness: 'complete',
    });

    expect(observation).toEqual({
      date: '2026-09-13',
      liquidCash: { amountMinor: 700_000n, currency: 'EUR' },
      comfortCash: { amountMinor: 500_000n, currency: 'EUR' },
      completeness: 'complete',
    });
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it('rejects negative, mixed-currency, and invalid-completeness observations', () => {
    const draft = {
      date: parseLocalDate('2026-09-13'),
      liquidCash: createMoney(700_000n, EUR),
      comfortCash: createMoney(500_000n, EUR),
      completeness: 'complete' as const,
    };
    expect(() =>
      createCashDragDailyObservation({ ...draft, liquidCash: createMoney(-1n, EUR) }),
    ).toThrow('must be non-negative');
    expect(() =>
      createCashDragDailyObservation({
        ...draft,
        comfortCash: createMoney(500_000n, parseCurrencyCode('USD')),
      }),
    ).toThrow('use one currency');
    expect(() =>
      createCashDragDailyObservation({
        ...draft,
        completeness: 'unknown',
      } as unknown as Parameters<typeof createCashDragDailyObservation>[0]),
    ).toThrow('Completeness must be one of');
  });
});
