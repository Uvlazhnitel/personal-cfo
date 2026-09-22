import { describe, expect, it } from 'vitest';

import { sharesightConfiguration } from '../src/sharesight/config.js';

const ownerId = '018f0000-0000-7000-8000-000000000001';
const accountId = '018f0000-0000-7000-8000-000000000002';
const receiptKey = Buffer.alloc(32, 7).toString('base64');

describe('Sharesight worker configuration', () => {
  it('requires every server-side secret and binding value only when the CLI is invoked', () => {
    expect(() => sharesightConfiguration({})).toThrow('SHARESIGHT_CLIENT_ID is required');
    expect(() =>
      sharesightConfiguration({
        SHARESIGHT_CLIENT_ID: 'client',
        SHARESIGHT_CLIENT_SECRET: 'secret',
        SHARESIGHT_PORTFOLIO_ID: '293304',
        SHARESIGHT_OWNER_ID: ownerId,
        SHARESIGHT_INVESTMENT_ACCOUNT_ID: accountId,
      }),
    ).toThrow('SHARESIGHT_RAW_RECEIPT_KEY is required');
  });

  it('derives a stable non-secret connection identity', () => {
    const input = {
      SHARESIGHT_CLIENT_ID: 'client',
      SHARESIGHT_CLIENT_SECRET: 'secret',
      SHARESIGHT_PORTFOLIO_ID: '293304',
      SHARESIGHT_OWNER_ID: ownerId,
      SHARESIGHT_INVESTMENT_ACCOUNT_ID: accountId,
      SHARESIGHT_RAW_RECEIPT_KEY: receiptKey,
    };
    const first = sharesightConfiguration(input);
    const rotated = sharesightConfiguration({ ...input, SHARESIGHT_CLIENT_SECRET: 'rotated' });
    expect(first.connectionId).toBe(rotated.connectionId);
    expect(first.apiBaseUrl).toBe('https://api.sharesight.com');
    expect(first.receiptKey).toHaveLength(32);
  });

  it('rejects invalid identities and receipt keys', () => {
    const base = {
      SHARESIGHT_CLIENT_ID: 'client',
      SHARESIGHT_CLIENT_SECRET: 'secret',
      SHARESIGHT_OWNER_ID: ownerId,
      SHARESIGHT_INVESTMENT_ACCOUNT_ID: accountId,
    };
    expect(() =>
      sharesightConfiguration({
        ...base,
        SHARESIGHT_PORTFOLIO_ID: 'not-an-id',
        SHARESIGHT_RAW_RECEIPT_KEY: receiptKey,
      }),
    ).toThrow('SHARESIGHT_PORTFOLIO_ID');
    expect(() =>
      sharesightConfiguration({
        ...base,
        SHARESIGHT_PORTFOLIO_ID: '293304',
        SHARESIGHT_RAW_RECEIPT_KEY: Buffer.alloc(31).toString('base64'),
      }),
    ).toThrow('base64-encoded 32-byte key');
  });
});
