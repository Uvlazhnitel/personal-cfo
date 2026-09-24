import { describe, expect, it, vi } from 'vitest';

import {
  SHARESIGHT_CONTRACT_FIXTURES,
  SharesightApiClient,
  SharesightApiError,
} from '../src/portfolio/index.js';

function json(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function token(value = 'token-1', expiresIn = 1800): Response {
  return json(JSON.stringify({ access_token: value, token_type: 'bearer', expires_in: expiresIn }));
}

describe('Sharesight API client', () => {
  it('authenticates once and reuses a valid token for typed reads', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn((input: string, init: RequestInit) => {
      calls.push(input);
      if (input.endsWith('/oauth2/token')) {
        expect(init.body).toContain('grant_type=client_credentials');
        return Promise.resolve(token());
      }
      expect(new Headers(init.headers).get('authorization')).toBe('Bearer token-1');
      return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.portfolios));
    });
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: fetcher,
    });
    await client.listPortfolios();
    await client.listPortfolios();
    expect(calls.filter((item) => item.endsWith('/oauth2/token'))).toHaveLength(1);
  });

  it('refreshes an expired token and coalesces concurrent token requests', async () => {
    let now = 0;
    let tokens = 0;
    const fetcher = vi.fn((input: string) => {
      if (input.endsWith('/oauth2/token')) return Promise.resolve(token(`token-${++tokens}`, 120));
      return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.portfolios));
    });
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: fetcher,
      clock: { now: () => new Date(now) },
    });
    await Promise.all([client.listPortfolios(), client.listPortfolios()]);
    expect(tokens).toBe(1);
    now = 61_000;
    await client.listPortfolios();
    expect(tokens).toBe(2);
  });

  it('maps invalid credentials without leaking secrets', async () => {
    const client = new SharesightApiClient({
      clientId: 'client-secret-id',
      clientSecret: 'very-secret-value',
      fetchImplementation: () => Promise.resolve(json('{"error":"invalid_client"}', 401)),
    });
    await expect(client.listPortfolios()).rejects.toMatchObject({ category: 'authentication' });
    await expect(client.listPortfolios()).rejects.not.toThrow(
      /very-secret-value|client-secret-id/u,
    );
  });

  it('retries transient server failures with deterministic backoff', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: (input) => {
        if (input.endsWith('/oauth2/token')) return Promise.resolve(token());
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? json('{"error":"temporary"}', 503)
            : json(SHARESIGHT_CONTRACT_FIXTURES.portfolios),
        );
      },
      sleeper: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    await client.listPortfolios();
    expect(reads).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it('honors documented minute-rate and concurrent-report responses', async () => {
    const sleeps: number[] = [];
    let reads = 0;
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: (input) => {
        if (input.endsWith('/oauth2/token')) return Promise.resolve(token());
        reads += 1;
        return Promise.resolve(
          reads === 1
            ? json('{"error":"403"}', 403, {
                'x-minuterate-limit': '360',
                'x-minuterate-remaining': '0',
              })
            : json(SHARESIGHT_CONTRACT_FIXTURES.portfolios),
        );
      },
      sleeper: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
    });
    await client.listPortfolios();
    expect(sleeps).toEqual([60_000]);
  });

  it('refreshes once after a resource 401 and then fails authentication', async () => {
    let tokenCalls = 0;
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: (input) => {
        if (input.endsWith('/oauth2/token')) return Promise.resolve(token(`token-${++tokenCalls}`));
        return Promise.resolve(json('{"error":"expired"}', 401));
      },
    });
    await expect(client.listPortfolios()).rejects.toMatchObject({ category: 'authentication' });
    expect(tokenCalls).toBe(2);
  });

  it('does not retry permanent request errors', async () => {
    let reads = 0;
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: (input) => {
        if (input.endsWith('/oauth2/token')) return Promise.resolve(token());
        reads += 1;
        return Promise.resolve(json('{"error":"precondition"}', 412));
      },
    });
    await expect(client.listPortfolios()).rejects.toMatchObject({ category: 'invalid_request' });
    expect(reads).toBe(1);
  });

  it('persists raw text before rejecting malformed provider JSON', async () => {
    const events: string[] = [];
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: (input) =>
        Promise.resolve(input.endsWith('/oauth2/token') ? token() : json('{"portfolios":[')),
      rawResponseSink: ({ body }) => {
        events.push(`receipt:${body}`);
        return Promise.resolve('receipt-1');
      },
    });
    await expect(client.listPortfolios()).rejects.toMatchObject({ category: 'invalid_response' });
    expect(events).toEqual(['receipt:{"portfolios":[']);
  });

  it('aborts requests at the configured timeout', async () => {
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      timeoutMilliseconds: 5,
      fetchImplementation: (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    });
    await expect(client.listPortfolios()).rejects.toMatchObject({ category: 'timeout' });
  });

  it('validates every approved endpoint and preserves exact numeric lexemes', async () => {
    const fetcher = (input: string): Promise<Response> => {
      if (input.endsWith('/oauth2/token')) return Promise.resolve(token());
      if (input.includes('/valuation.json')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.completeValuation));
      }
      if (input.includes('/cash_accounts/') && input.includes('/cash_account_transactions')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.deposit));
      }
      if (input.endsWith('/cash_accounts.json')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.cashAccounts));
      }
      if (input.includes('/trades.json')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.pendingTrade));
      }
      if (input.includes('/payouts.json')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.payouts));
      }
      if (input.includes('/performance.json')) {
        return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.performance));
      }
      return Promise.resolve(json(SHARESIGHT_CONTRACT_FIXTURES.portfolios));
    };
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: fetcher,
    });
    expect((await client.getValuation('293304', '2026-09-21')).value.value).toBe('10000.10');
    expect((await client.listCashAccounts('293304')).value[0]?.balance).toBe('500.05');
    expect(
      (await client.listCashTransactions('754797206', '2026-09-01', '2026-09-30')).value[0]?.amount,
    ).toBe('1000.10');
    expect((await client.listTrades('293304', '2026-09-01', '2026-09-30')).value).toHaveLength(1);
    expect((await client.listPayouts('293304', '2026-09-01', '2026-09-30')).value).toHaveLength(1);
    expect(
      (await client.getPerformance('293304', '2026-01-01', '2026-09-30')).value.totalGain,
    ).toBe('555.40');
  });

  it('bounds calculation-report concurrency at three', async () => {
    let active = 0;
    let maximum = 0;
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      fetchImplementation: async (input) => {
        if (input.endsWith('/oauth2/token')) return token();
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return json(SHARESIGHT_CONTRACT_FIXTURES.completeValuation);
      },
    });
    await Promise.all([
      client.getValuation('293304', '2026-09-21'),
      client.getValuation('293304', '2026-09-21'),
      client.getValuation('293304', '2026-09-21'),
      client.getValuation('293304', '2026-09-21'),
    ]);
    expect(maximum).toBe(3);
  });

  it('enforces the client-side rolling minute request budget', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const client = new SharesightApiClient({
      clientId: 'client',
      clientSecret: 'secret',
      clock: { now: () => new Date(now) },
      sleeper: (milliseconds) => {
        sleeps.push(milliseconds);
        now += milliseconds;
        return Promise.resolve();
      },
      fetchImplementation: (input) =>
        Promise.resolve(
          input.endsWith('/oauth2/token') ? token() : json(SHARESIGHT_CONTRACT_FIXTURES.portfolios),
        ),
    });
    for (let request = 0; request < 360; request += 1) await client.listPortfolios();
    expect(sleeps).toEqual([60_000]);
  });

  it('rejects unsafe API base URLs', () => {
    expect(
      () =>
        new SharesightApiClient({
          clientId: 'client',
          clientSecret: 'secret',
          baseUrl: 'http://sharesight.example',
        }),
    ).toThrowError(SharesightApiError);
  });

  it('uses native fetch against a loopback fixture server', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url ?? '');
      response.setHeader('content-type', 'application/json');
      response.end(
        request.url === '/oauth2/token'
          ? JSON.stringify({ access_token: 'fixture-token', expires_in: 1800 })
          : SHARESIGHT_CONTRACT_FIXTURES.portfolios,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Fixture server failed.');
      const client = new SharesightApiClient({
        clientId: 'client',
        clientSecret: 'secret',
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      expect((await client.listPortfolios()).value[0]?.id).toBe('293304');
      expect(paths).toEqual(['/oauth2/token', '/api/v2/portfolios.json']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });
});
import { createServer } from 'node:http';
