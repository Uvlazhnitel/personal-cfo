import { describe, expect, it } from 'vitest';

import { safeToInvestValue } from '../src/dashboard.js';

const value = { recommended: { amountMinor: '24000', currency: 'EUR' } };

describe('dashboard Safe to Invest projection', () => {
  it('retains only an explicitly provisional partial recommendation', () => {
    expect(
      safeToInvestValue({
        status: 'partial',
        asOf: '2026-10-08T08:00:00.000Z',
        payload: {
          status: 'partial',
          value,
          warnings: [
            {
              code: 'safe_to_invest.provisional',
              context: { reasons: 'non_material_spending_history_incomplete' },
            },
          ],
        },
      }),
    ).toEqual({
      state: 'incomplete',
      value: { amountMinor: 24_000n, currency: 'EUR' },
      asOf: '2026-10-08T08:00:00.000Z',
      reason: 'provisional_estimate',
    });
  });

  it('suppresses blocked and unlabelled partial recommendations', () => {
    for (const warnings of [
      [],
      [{ code: 'safe_to_invest.blocked', context: { reasons: 'incomplete_liquid_balance' } }],
    ]) {
      expect(
        safeToInvestValue({
          status: 'partial',
          asOf: '2026-10-08T08:00:00.000Z',
          payload: { status: 'partial', value, warnings },
        }).value,
      ).toBeNull();
    }
  });
});
