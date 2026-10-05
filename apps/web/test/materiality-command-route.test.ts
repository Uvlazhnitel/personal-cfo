import { describe, expect, it } from 'vitest';

import {
  parseCashAccountBootstrapInput,
  parseEvaluationProfileBootstrapInput,
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

describe('evaluation profile bootstrap request', () => {
  it('accepts only an explicit reason', () => {
    expect(
      parseEvaluationProfileBootstrapInput({
        reason: 'Owner approved a conservative production engine profile.',
      }),
    ).toEqual({ reason: 'Owner approved a conservative production engine profile.' });
  });

  it.each([
    [{ reason: '' }, 'http.invalid_request'],
    [{ reason: 'approved', ownerId: 'forbidden' }, 'http.unsupported_fields'],
    [{ reason: 'approved', current: {} }, 'http.unsupported_fields'],
  ])('rejects missing or caller-controlled profile state', (request, code) => {
    expect(() => parseEvaluationProfileBootstrapInput(request)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});

describe('cash account bootstrap request', () => {
  it('accepts only an explicit balance, instant, and reason', () => {
    const request = reviveMoney({
      openingBalanceMinor: '12500',
      effectiveAt: '2026-07-01T00:00:00Z',
      reason: 'Owner confirmed the cash cutover balance.',
    });
    expect(parseCashAccountBootstrapInput(request)).toEqual({
      openingBalanceMinor: 12_500n,
      effectiveAt: '2026-07-01T00:00:00Z',
      reason: 'Owner confirmed the cash cutover balance.',
    });
  });

  it.each([
    [
      { openingBalanceMinor: -1n, effectiveAt: '2026-07-01T00:00:00Z', reason: 'invalid' },
      'cash_account.invalid_opening_balance',
    ],
    [
      { openingBalanceMinor: 0n, effectiveAt: '2026-07-01T00:00:00Z', reason: '' },
      'http.invalid_request',
    ],
    [
      {
        openingBalanceMinor: 0n,
        effectiveAt: '2026-07-01T00:00:00Z',
        reason: 'approved',
        ownerId: 'forbidden',
      },
      'http.unsupported_fields',
    ],
    [
      {
        openingBalanceMinor: 0n,
        effectiveAt: '2026-07-01T00:00:00Z',
        reason: 'approved',
        currency: 'EUR',
      },
      'http.unsupported_fields',
    ],
  ])('rejects invalid or caller-controlled state', (request, code) => {
    expect(() => parseCashAccountBootstrapInput(request)).toThrow(
      expect.objectContaining({ code }),
    );
  });
});
