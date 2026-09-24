import { describe, expect, it } from 'vitest';

import { portfolioManagerConfiguration } from '../src/portfolio-manager/config.js';

const valid = {
  PORTFOLIO_MANAGER_BASE_URL: 'http://127.0.0.1:3010/',
  PORTFOLIO_MANAGER_API_TOKEN: 'test-token',
  PORTFOLIO_MANAGER_OWNER_ID: '018f0000-0000-7000-8000-000000000001',
  PORTFOLIO_MANAGER_INVESTMENT_ACCOUNT_ID: '018f0000-0000-7000-8000-000000000002',
  PORTFOLIO_MANAGER_RAW_RECEIPT_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('Portfolio Manager worker configuration', () => {
  it('fails closed when any required value is absent', () => {
    expect(() => portfolioManagerConfiguration({})).toThrow(
      'PORTFOLIO_MANAGER_BASE_URL is required',
    );
    for (const name of Object.keys(valid)) {
      const input = { ...valid } as Record<string, string | undefined>;
      delete input[name];
      expect(() => portfolioManagerConfiguration(input)).toThrow(`${name} is required`);
    }
  });

  it('normalizes loopback URL and derives a token-independent connection identity', () => {
    const first = portfolioManagerConfiguration(valid);
    const rotated = portfolioManagerConfiguration({
      ...valid,
      PORTFOLIO_MANAGER_API_TOKEN: 'rotated-token',
    });
    expect(first.baseUrl).toBe('http://127.0.0.1:3010');
    expect(first.connectionId).toMatch(/^[a-f0-9]{64}$/u);
    expect(rotated.connectionId).toBe(first.connectionId);
  });

  it('rejects insecure remote URLs, URL credentials, whitespace tokens, and bad keys', () => {
    expect(() =>
      portfolioManagerConfiguration({
        ...valid,
        PORTFOLIO_MANAGER_BASE_URL: 'http://portfolio-manager.example',
      }),
    ).toThrow('HTTPS');
    expect(() =>
      portfolioManagerConfiguration({
        ...valid,
        PORTFOLIO_MANAGER_BASE_URL: 'https://user:secret@portfolio-manager.example',
      }),
    ).toThrow('credentials');
    expect(() =>
      portfolioManagerConfiguration({
        ...valid,
        PORTFOLIO_MANAGER_API_TOKEN: 'invalid token',
      }),
    ).toThrow('API_TOKEN is invalid');
    expect(() =>
      portfolioManagerConfiguration({
        ...valid,
        PORTFOLIO_MANAGER_RAW_RECEIPT_KEY: 'invalid',
      }),
    ).toThrow('base64-encoded 32-byte key');
  });
});
