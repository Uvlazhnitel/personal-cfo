import { describe, expect, it, vi } from 'vitest';

import { TelegramApiError, TelegramBotApiClient, normalizeTelegramUpdate } from '../src/index.js';

const token = `123456:${'a'.repeat(32)}`;

describe('Telegram Bot API client', () => {
  it('validates getUpdates and sends only message updates', async () => {
    const fetcher = vi.fn((_url: string, init: RequestInit) => {
      if (typeof init.body !== 'string') throw new Error('Expected a JSON request body.');
      expect(JSON.parse(init.body)).toMatchObject({
        offset: 102,
        timeout: 25,
        allowed_updates: ['message'],
      });
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: [{ update_id: 102 }] }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    const client = new TelegramBotApiClient(token, fetcher);
    await expect(client.getUpdates({ offset: 102n, timeoutSeconds: 25 })).resolves.toEqual([
      { update_id: 102 },
    ]);
  });

  it('accepts an empty update page', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, result: [] })))),
    );
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 25 })).resolves.toEqual([]);
  });

  it('rejects malformed success responses', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, result: 'wrong' })))),
    );
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 25 })).rejects.toMatchObject({
      category: 'invalid_response',
    });
  });

  it('classifies rate limits, server errors, and unsafe client errors', async () => {
    const responses = [
      new Response(JSON.stringify({ ok: false, parameters: { retry_after: 3 } }), { status: 429 }),
      new Response(JSON.stringify({ ok: false }), { status: 503 }),
      new Response(JSON.stringify({ ok: false }), { status: 400 }),
    ];
    const client = new TelegramBotApiClient(
      token,
      vi.fn(() => Promise.resolve(responses.shift()!)),
    );
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 25 })).rejects.toMatchObject({
      category: 'rate_limited',
      retryAfterSeconds: 3,
    });
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 25 })).rejects.toMatchObject({
      category: 'provider_error',
    });
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 25 })).rejects.toMatchObject({
      category: 'invalid_response',
    });
  });

  it('returns the bot message identity', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(() =>
        Promise.resolve(new Response(JSON.stringify({ ok: true, result: { message_id: 44 } }))),
      ),
    );
    await expect(
      client.sendMessage({ chatId: 10n, text: 'ok', replyToMessageId: 20n }),
    ).resolves.toEqual({ messageId: 44n });
  });

  it('wraps network errors without exposing the token URL', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(async () => Promise.reject(new Error(`failed ${token}`))),
    );
    const error = await client
      .getUpdates({ offset: null, timeoutSeconds: 1 })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect(String(error)).not.toContain(token);
  });

  it('treats an indeterminate send failure as network-uncertain', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(() => Promise.reject(new Error('connection reset'))),
    );
    await expect(
      client.sendMessage({ chatId: 10n, text: 'ok', replyToMessageId: null }),
    ).rejects.toMatchObject({ category: 'network_uncertain' });
  });

  it('aborts a stalled HTTP request at the client timeout', async () => {
    const client = new TelegramBotApiClient(
      token,
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      ),
      { timeoutGraceMilliseconds: 5 },
    );
    await expect(client.getUpdates({ offset: null, timeoutSeconds: 0 })).rejects.toMatchObject({
      category: 'network_uncertain',
    });
  });

  it('normalizes only safe message metadata and hashes text', () => {
    const normalized = normalizeTelegramUpdate({
      update_id: 100,
      message: {
        message_id: 7,
        date: 1_789_555_200,
        text: '  €12   lunch  ',
        chat: { id: 9, type: 'private' },
        from: { id: 9, is_bot: false },
      },
    });
    expect(normalized).toMatchObject({
      kind: 'message',
      message: { updateId: 100n, text: '€12 lunch', chatId: 9n },
    });
    if (normalized.kind === 'message') expect(normalized.message.textHash).toHaveLength(64);
  });
});
