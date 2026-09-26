import { generateKeyPairSync, verify } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  EnableBankingApiClient,
  EnableBankingApiError,
  createEnableBankingApplicationJwt,
} from '../src/open-banking/enable-banking/index.js';
import type {
  EnableBankingRawResponseFailureSink,
  EnableBankingSleeper,
} from '../src/open-banking/enable-banking/index.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const applicationId = '018f0000-0000-7000-8000-000000000811';
const accountUid = '018f0000-0000-7000-8000-000000000812';
const sessionId = '018f0000-0000-7000-8000-000000000813';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

function account() {
  return {
    uid: accountUid,
    identification_hash: 'stable-account-hash',
    identification_hashes: ['stable-account-hash'],
    currency: 'EUR',
    usage: 'PRIV',
    cash_account_type: 'CACC',
  };
}

function client(fetchImplementation: typeof fetch, options: Record<string, unknown> = {}) {
  return new EnableBankingApiClient({
    applicationId,
    privateKeyPem,
    fetchImplementation,
    clock: { now: () => new Date('2026-09-25T12:00:00Z') },
    ...options,
  });
}

describe('Enable Banking API client', () => {
  it('creates a five-minute RS256 application JWT with the documented claims', () => {
    const jwt = createEnableBankingApplicationJwt({
      applicationId,
      privateKeyPem,
      now: new Date('2026-09-25T12:00:00Z'),
    });
    const [headerToken, payloadToken, signatureToken] = jwt.split('.');
    const header = JSON.parse(Buffer.from(headerToken!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    const payload = JSON.parse(Buffer.from(payloadToken!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    expect(header).toEqual({ typ: 'JWT', alg: 'RS256', kid: applicationId });
    expect(payload).toEqual({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: 1_790_337_600,
      exp: 1_790_337_900,
    });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${headerToken}.${payloadToken}`),
        publicKey,
        Buffer.from(signatureToken!, 'base64url'),
      ),
    ).toBe(true);
  });

  it('reads every safe endpoint with bearer authentication and exact longest-history query', async () => {
    const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
    const bodies = [
      {
        aspsps: [
          {
            name: 'Swedbank',
            country: 'LV',
            psu_types: ['personal'],
            maximum_consent_validity: 15_552_000,
            auth_methods: [{ hidden_method: false, psu_type: 'personal', approach: 'REDIRECT' }],
          },
        ],
      },
      {
        status: 'AUTHORIZED',
        accounts_data: [{ uid: accountUid, identification_hash: 'stable-account-hash' }],
        aspsp: { name: 'Swedbank', country: 'LV' },
        psu_type: 'personal',
        access: { valid_until: '2027-03-24T12:00:00Z' },
        created: '2026-09-25T12:00:00Z',
        authorized: '2026-09-25T12:01:00Z',
        closed: null,
      },
      { ...account(), name: 'Daily account', account_id: { iban: 'LV00TEST' } },
      { balances: [] },
      { transactions: [], continuation_key: 'opaque-page-2' },
    ];
    const fetchImplementation = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: url instanceof Request ? url.url : url.toString(),
        method: init?.method ?? 'GET',
        authorization: headers.get('authorization'),
      });
      return Promise.resolve(response(bodies.shift()));
    }) as typeof fetch;
    const api = client(fetchImplementation);
    const aspsp = (await api.listAspsps()).value.aspsps[0];
    expect(aspsp?.name).toBe('Swedbank');
    expect(aspsp?.authMethods).toEqual([
      { name: null, hidden: false, psuType: 'personal', approach: 'REDIRECT' },
    ]);
    expect((await api.getSession(sessionId)).value.status).toBe('AUTHORIZED');
    expect((await api.getAccountDetails(accountUid)).value.identificationHash).toBe(
      'stable-account-hash',
    );
    expect((await api.getBalances(accountUid)).value.balances).toEqual([]);
    expect(
      (await api.getTransactions({ accountUid, continuationKey: 'opaque-page-1' })).value
        .continuationKey,
    ).toBe('opaque-page-2');
    expect(calls.every((call) => call.authorization?.startsWith('Bearer ey') === true)).toBe(true);
    expect(calls[4]?.url).toContain('strategy=longest&continuation_key=opaque-page-1');
  });

  it('uses the explicit recurring default strategy without carrying a prior cursor', async () => {
    const urls: string[] = [];
    const fetchImplementation = vi.fn((url: string | URL | Request) => {
      urls.push(url instanceof Request ? url.url : url.toString());
      return Promise.resolve(response({ transactions: [], continuation_key: null }));
    }) as typeof fetch;
    await client(fetchImplementation).getTransactions({
      accountUid,
      continuationKey: null,
      strategy: 'default',
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('strategy=default');
    expect(urls[0]).not.toContain('continuation_key');
  });

  it('does not retry authorization, session exchange, or disconnect requests', async () => {
    const fetchImplementation = vi.fn(() => Promise.resolve(response({}, 500))) as typeof fetch;
    const api = client(fetchImplementation);
    await expect(
      api.startAuthorization({
        state: 'secure-state',
        redirectUrl: 'https://cfo.example/api/v1/open-banking/enable-banking/callback',
        validUntil: '2027-03-24T12:00:00Z',
      }),
    ).rejects.toMatchObject({ category: 'transient_provider_failure' });
    await expect(api.authorizeSession({ code: 'one-time-code' })).rejects.toMatchObject({
      category: 'transient_provider_failure',
    });
    await expect(api.deleteSession(sessionId)).rejects.toMatchObject({
      category: 'transient_provider_failure',
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('decodes authorization, session exchange, and explicit disconnect responses', async () => {
    const bodies = [
      {
        url: 'https://auth.enablebanking.com/synthetic',
        authorization_id: '018f0000-0000-7000-8000-000000000814',
        psu_id_hash: null,
      },
      {
        session_id: sessionId,
        accounts: [account()],
        aspsp: { name: 'Swedbank', country: 'LV' },
        psu_type: 'personal',
        access: { valid_until: '2027-03-24T12:00:00Z' },
      },
      { message: 'Session deleted' },
    ];
    const api = client(vi.fn(() => Promise.resolve(response(bodies.shift()))));
    await expect(
      api.startAuthorization({
        state: 'secure-state',
        redirectUrl: 'https://cfo.example/api/v1/open-banking/enable-banking/callback',
        validUntil: '2027-03-24T12:00:00Z',
      }),
    ).resolves.toMatchObject({ value: { psuIdHash: null } });
    await expect(api.authorizeSession({ code: 'one-time-code' })).resolves.toMatchObject({
      value: { sessionId, psuType: 'personal' },
    });
    await expect(api.deleteSession(sessionId)).resolves.toMatchObject({
      value: { message: 'Session deleted' },
    });
  });

  it('persists a response before decoding and never sends provider secrets to the sink', async () => {
    const order: string[] = [];
    const sink = vi.fn((value: { body: string; path: string }) => {
      order.push(`persist:${value.body.length}`);
      expect(value.path).not.toContain(privateKeyPem);
      return Promise.resolve('receipt-1');
    });
    const api = client(
      vi.fn(() => Promise.resolve(response('{"malformed":true}'))),
      { responseSink: sink },
    );
    await expect(api.listAspsps()).rejects.toMatchObject({ category: 'invalid_response' });
    expect(order).toEqual(['persist:18']);
    expect(sink).toHaveBeenCalledOnce();
  });

  it('retries safe reads after deterministic delays and honors bounded Retry-After', async () => {
    const fetchImplementation = vi
      .fn()
      .mockResolvedValueOnce(response({}, 500))
      .mockResolvedValueOnce(response({}, 429, { 'retry-after': '120' }))
      .mockResolvedValueOnce(response({ balances: [] })) as typeof fetch;
    const sleeper = vi.fn<EnableBankingSleeper>(() => Promise.resolve());
    const responseFailureSink = vi.fn<EnableBankingRawResponseFailureSink>(() => Promise.resolve());
    const responseSink = vi.fn(() => Promise.resolve('receipt-id'));
    await expect(
      client(fetchImplementation, { sleeper, responseSink, responseFailureSink }).getBalances(
        accountUid,
      ),
    ).resolves.toMatchObject({ value: { balances: [] } });
    expect(sleeper.mock.calls.map((call) => call[0])).toEqual([250, 60_000]);
    expect(responseFailureSink.mock.calls.map((call) => call[1])).toEqual([
      'transient_provider_failure',
      'rate_limited',
    ]);
  });

  it.each([
    [400, 'invalid_request'],
    [401, 'authentication'],
    [403, 'authorization'],
    [404, 'not_found'],
    [422, 'invalid_request'],
  ] as const)('maps terminal HTTP %s to %s without retry', async (status, category) => {
    const fetchImplementation = vi.fn(() => Promise.resolve(response({}, status))) as typeof fetch;
    await expect(client(fetchImplementation).getBalances(accountUid)).rejects.toMatchObject({
      category,
      status,
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('times out safe reads three times while keeping key material out of errors', async () => {
    const fetchImplementation = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    ) as typeof fetch;
    let error: unknown;
    try {
      await client(fetchImplementation, {
        timeoutMilliseconds: 2,
        sleeper: () => Promise.resolve(),
      }).getBalances(accountUid);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnableBankingApiError);
    expect(error).toMatchObject({ category: 'timeout' });
    expect(String(error)).not.toContain(privateKeyPem.slice(0, 20));
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it('honors caller cancellation without retrying', async () => {
    const controller = new AbortController();
    const fetchImplementation = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          controller.abort();
        }),
    );
    await expect(
      client(fetchImplementation).getBalances(accountUid, controller.signal),
    ).rejects.toMatchObject({ category: 'transient_provider_failure', retryable: false });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('rejects non-RSA keys and non-loopback HTTP origins', () => {
    const { privateKey: ecKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() =>
      createEnableBankingApplicationJwt({
        applicationId,
        privateKeyPem: ecKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        now: new Date(),
      }),
    ).toThrow('RSA');
    expect(
      () =>
        new EnableBankingApiClient({
          applicationId,
          privateKeyPem,
          baseUrl: 'http://bank.example',
        }),
    ).toThrow('HTTPS');
  });
});
