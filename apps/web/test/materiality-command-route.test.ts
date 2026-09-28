import { describe, expect, it } from 'vitest';

import {
  parseMaterialitySettingsInput,
  reviveMoney,
  serializeCommandResponse,
} from '../src/app/api/v1/commands/[command]/route.js';

describe('materiality settings command request', () => {
  it('accepts an exact non-negative EUR minor-unit amount and explicit reason', () => {
    const request = reviveMoney({
      amountMinor: '10000',
      currency: 'EUR',
      reason: 'Owner approved the production materiality threshold.',
    });
    expect(parseMaterialitySettingsInput(request, '2026-09-28T12:00:00Z', '2026-09-28')).toEqual({
      amountMinor: 10_000n,
      currency: 'EUR',
      effectiveAt: '2026-09-28T12:00:00Z',
      effectiveDate: '2026-09-28',
      reason: 'Owner approved the production materiality threshold.',
    });
  });

  it.each([
    [{ amountMinor: -1n, currency: 'EUR', reason: 'negative' }, 'settings.invalid_materiality'],
    [
      { amountMinor: 10_000n, currency: 'USD', reason: 'wrong currency' },
      'settings.invalid_materiality',
    ],
    [{ amountMinor: 10_000n, currency: 'EUR', reason: '' }, 'http.invalid_request'],
    [
      { amountMinor: 10_000n, currency: 'EUR', reason: 'extra', ownerId: 'forbidden' },
      'http.unsupported_fields',
    ],
  ])('rejects an invalid or over-scoped request', (request, code) => {
    expect(() =>
      parseMaterialitySettingsInput(request, '2026-09-28T12:00:00Z', '2026-09-28'),
    ).toThrow(expect.objectContaining({ code }));
  });

  it('serializes the command input version as a JSON-safe decimal string', () => {
    const response = serializeCommandResponse({
      commandId: '018f0000-0000-7000-8000-000000000001',
      replayed: false,
      mutated: true,
      inputVersion: 9_007_199_254_740_993n,
      result: Object.freeze({ accepted: true }),
    });
    expect(response).toMatchObject({ inputVersion: '9007199254740993' });
    expect(() => JSON.stringify(response)).not.toThrow();
  });
});
