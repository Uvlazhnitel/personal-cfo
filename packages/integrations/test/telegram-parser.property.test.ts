import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseEurAmount, parseTelegramText } from '../src/index.js';

describe('Telegram parser properties', () => {
  it('parses exact two-decimal EUR strings into minor units', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000 }), (minor) => {
        const whole = Math.floor(minor / 100);
        const fraction = String(minor % 100).padStart(2, '0');
        expect(parseEurAmount(`${whole}.${fraction} EUR`)).toMatchObject({
          status: 'ok',
          amountMinor: BigInt(minor),
        });
      }),
      { seed: 20260916, numRuns: 500 },
    );
  });

  it('never throws for arbitrary bounded text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 512 }), (text) => {
        expect(() =>
          parseTelegramText({
            updateId: 1n,
            chatId: 1n,
            senderId: 1n,
            messageId: 1n,
            sentAt: '2026-09-16T09:00:00.000Z',
            text,
            textHash: 'hash',
            locale: /[А-Яа-яЁё]/u.test(text) ? 'ru' : 'en',
            localeDetected: true,
            chatType: 'private',
            senderIsBot: false,
            forwarded: false,
            replyToMessageId: null,
          }),
        ).not.toThrow();
      }),
      { seed: 20260916, numRuns: 1_000 },
    );
  });
});
