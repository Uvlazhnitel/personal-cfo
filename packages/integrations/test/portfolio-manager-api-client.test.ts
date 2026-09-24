import { describe, expect, it, vi } from 'vitest';

import {
  PORTFOLIO_MANAGER_CONTRACT_FIXTURES,
  PortfolioManagerApiClient,
  PortfolioManagerApiError,
} from '../src/portfolio/portfolio-manager/index.js';
import type { PortfolioManagerSleeper } from '../src/portfolio/portfolio-manager/index.js';

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe('Portfolio Manager API client', () => {
  it('sends bearer authentication and decodes every read endpoint', async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    const bodies = [
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities,
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.completeSnapshot,
      PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows,
    ];
    const client = new PortfolioManagerApiClient({
      baseUrl: 'https://portfolio-manager.example',
      apiToken: 'secret-token',
      fetchImplementation: (url, init) => {
        const headers = new Headers(init.headers);
        calls.push({ url, authorization: headers.get('authorization') });
        return Promise.resolve(response(bodies.shift()!));
      },
      clock: { now: () => new Date('2026-09-23T12:00:00Z') },
    });
    expect((await client.getCapabilities()).value.provider).toBe('portfolio-manager');
    expect((await client.getSnapshot()).value.reportingCurrency).toBe('EUR');
    expect((await client.getCapitalFlows({ cursor: 'abc_123' })).value.items).toHaveLength(2);
    expect(calls.map((call) => call.authorization)).toEqual([
      'Bearer secret-token',
      'Bearer secret-token',
      'Bearer secret-token',
    ]);
    expect(calls[2]?.url).toContain('limit=500&cursor=abc_123');
  });

  it('persists a successful body before schema decoding', async () => {
    const order: string[] = [];
    const client = new PortfolioManagerApiClient({
      baseUrl: 'http://127.0.0.1:3010',
      apiToken: 'secret-token',
      fetchImplementation: () => Promise.resolve(response('{"malformed":true}')),
      responseSink: ({ body }) => {
        order.push(`persist:${body.length}`);
        return Promise.resolve('receipt-1');
      },
    });
    await expect(client.getSnapshot()).rejects.toMatchObject({ category: 'invalid_response' });
    expect(order).toEqual(['persist:18']);
  });

  it('retries transient failures with bounded deterministic delays', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response('{}', 500))
      .mockResolvedValueOnce(response('{}', 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(response(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities));
    const sleeper = vi.fn<PortfolioManagerSleeper>(() => Promise.resolve());
    const client = new PortfolioManagerApiClient({
      baseUrl: 'https://portfolio-manager.example',
      apiToken: 'secret-token',
      fetchImplementation,
      sleeper,
      clock: { now: () => new Date('2026-09-23T12:00:00Z') },
    });
    await expect(client.getCapabilities()).resolves.toMatchObject({
      value: { provider: 'portfolio-manager' },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(sleeper.mock.calls.map((call) => call[0])).toEqual([250, 2_000]);
  });

  it.each([
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'unsupported_version'],
    [400, 'invalid_request'],
  ] as const)('maps terminal status %s without retry', async (status, category) => {
    const fetchImplementation = vi.fn(() => Promise.resolve(response('{}', status)));
    const client = new PortfolioManagerApiClient({
      baseUrl: 'https://portfolio-manager.example',
      apiToken: 'secret-token',
      fetchImplementation,
    });
    await expect(client.getCapabilities()).rejects.toMatchObject({ category, status });
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
  });

  it('times out and exhausts exactly three attempts without exposing credentials', async () => {
    const fetchImplementation = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    const client = new PortfolioManagerApiClient({
      baseUrl: 'https://portfolio-manager.example',
      apiToken: 'highly-secret-token',
      fetchImplementation,
      timeoutMilliseconds: 2,
      sleeper: () => Promise.resolve(),
    });
    let error: unknown;
    try {
      await client.getCapabilities();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PortfolioManagerApiError);
    expect(error).toMatchObject({ category: 'timeout' });
    expect(String(error)).not.toContain('highly-secret-token');
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('fails closed for invalid configuration and page sizes', async () => {
    expect(
      () =>
        new PortfolioManagerApiClient({
          baseUrl: 'http://portfolio-manager.example',
          apiToken: 'secret-token',
        }),
    ).toThrow('HTTPS');
    expect(
      () =>
        new PortfolioManagerApiClient({
          baseUrl: 'https://user:password@portfolio-manager.example',
          apiToken: 'secret-token',
        }),
    ).toThrow('credentials');
    const client = new PortfolioManagerApiClient({
      baseUrl: 'https://portfolio-manager.example',
      apiToken: 'secret-token',
      fetchImplementation: () => Promise.resolve(response('{}')),
    });
    await expect(client.getCapitalFlows({ cursor: null, limit: 501 })).rejects.toMatchObject({
      category: 'invalid_request',
    });
  });
});
