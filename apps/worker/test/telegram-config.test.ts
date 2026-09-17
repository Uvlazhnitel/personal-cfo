import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { telegramConfiguration } from '../src/telegram/config.js';

const ownerId = '018f0000-0000-7000-8000-000000000001';
const token = `123456:${'a'.repeat(32)}`;

describe('Telegram worker configuration', () => {
  it('is disabled only when all Telegram variables are absent', () => {
    expect(telegramConfiguration({})).toEqual({ enabled: false });
    expect(() => telegramConfiguration({ TELEGRAM_BOT_TOKEN: token })).toThrow(
      'must be set together',
    );
  });

  it('validates identifiers and derives a stable source key from the bot ID only', () => {
    const configuration = telegramConfiguration({
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_ALLOWED_USER_ID: '123456789',
      TELEGRAM_OWNER_ID: ownerId,
    });
    expect(configuration).toEqual({
      enabled: true,
      token,
      allowedUserId: 123_456_789n,
      ownerId,
      sourceKey: createHash('sha256').update('123456').digest('hex'),
    });
    const rotatedSecret = telegramConfiguration({
      TELEGRAM_BOT_TOKEN: `123456:${'b'.repeat(32)}`,
      TELEGRAM_ALLOWED_USER_ID: '123456789',
      TELEGRAM_OWNER_ID: ownerId,
    });
    if (!configuration.enabled || !rotatedSecret.enabled)
      throw new Error('Expected enabled config.');
    expect(rotatedSecret.sourceKey).toBe(configuration.sourceKey);
  });

  it('rejects malformed or unsafe configuration values', () => {
    expect(() =>
      telegramConfiguration({
        TELEGRAM_BOT_TOKEN: 'secret',
        TELEGRAM_ALLOWED_USER_ID: '123',
        TELEGRAM_OWNER_ID: ownerId,
      }),
    ).toThrow('TELEGRAM_BOT_TOKEN is invalid');
    expect(() =>
      telegramConfiguration({
        TELEGRAM_BOT_TOKEN: token,
        TELEGRAM_ALLOWED_USER_ID: '9007199254740992',
        TELEGRAM_OWNER_ID: ownerId,
      }),
    ).toThrow('safe-integer bounds');
  });
});
