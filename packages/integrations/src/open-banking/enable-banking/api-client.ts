import { createPrivateKey, sign } from 'node:crypto';

import { parseInstant } from '@personal-cfo/domain';

import {
  decodeEnableBankingAccountDetails,
  decodeEnableBankingAspsps,
  decodeEnableBankingAuthorizedSession,
  decodeEnableBankingBalances,
  decodeEnableBankingSession,
  decodeEnableBankingStartAuthorization,
  decodeEnableBankingTransactions,
} from './binding.js';
import type {
  EnableBankingAccountDetailsDto,
  EnableBankingApiErrorCategory,
  EnableBankingApiResponse,
  EnableBankingAspspsDto,
  EnableBankingAuthorizedSessionDto,
  EnableBankingBalancesDto,
  EnableBankingClock,
  EnableBankingFetch,
  EnableBankingRawEndpoint,
  EnableBankingRawResponseFailureSink,
  EnableBankingRawResponseSink,
  EnableBankingSessionDto,
  EnableBankingSleeper,
  EnableBankingStartAuthorizationDto,
  EnableBankingTransactionFetchStrategy,
  EnableBankingTransactionsDto,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.enablebanking.com';
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const JWT_TTL_SECONDS = 300;
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;
const RETRY_DELAYS = [250, 1_000] as const;

export class EnableBankingApiError extends Error {
  readonly category: EnableBankingApiErrorCategory;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMilliseconds: number | null;
  readonly receiptId: string | null;

  constructor(
    category: EnableBankingApiErrorCategory,
    message: string,
    options: Readonly<{
      status?: number | null;
      retryable?: boolean;
      retryAfterMilliseconds?: number | null;
      receiptId?: string | null;
    }> = {},
  ) {
    super(message);
    this.name = 'EnableBankingApiError';
    this.category = category;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds ?? null;
    this.receiptId = options.receiptId ?? null;
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function createEnableBankingApplicationJwt(
  input: Readonly<{
    applicationId: string;
    privateKeyPem: string;
    now: Date;
  }>,
): string {
  if (
    input.applicationId.length === 0 ||
    input.applicationId.length > 256 ||
    input.applicationId.trim() !== input.applicationId ||
    /\s/u.test(input.applicationId)
  ) {
    throw new EnableBankingApiError('configuration', 'Enable Banking application ID is invalid.');
  }
  if (!Number.isFinite(input.now.getTime())) {
    throw new EnableBankingApiError('configuration', 'Enable Banking JWT clock is invalid.');
  }
  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(input.privateKeyPem);
  } catch {
    throw new EnableBankingApiError('configuration', 'Enable Banking private key is invalid.');
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'rsa') {
    throw new EnableBankingApiError(
      'configuration',
      'Enable Banking private key must be an RSA private key.',
    );
  }
  const issuedAt = Math.floor(input.now.getTime() / 1_000);
  const header = encodeBase64Url(
    JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: input.applicationId }),
  );
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: issuedAt,
      exp: issuedAt + JWT_TTL_SECONDS,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput, 'ascii'), key);
  return `${signingInput}.${encodeBase64Url(signature)}`;
}

function defaultSleeper(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
      },
      { once: true },
    );
  });
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new EnableBankingApiError('configuration', 'Enable Banking base URL is invalid.');
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw new EnableBankingApiError(
      'configuration',
      'Enable Banking base URL must use HTTPS except on loopback.',
    );
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new EnableBankingApiError(
      'configuration',
      'Enable Banking base URL cannot include credentials, query, or fragment.',
    );
  }
  return parsed.toString().replace(/\/$/u, '');
}

function retryAfterMilliseconds(header: string | null, nowMilliseconds: number): number | null {
  if (header === null) return null;
  if (/^\d+$/u.test(header)) {
    return Math.min(Number(header) * 1_000, MAX_RETRY_AFTER_MILLISECONDS);
  }
  const parsed = Date.parse(header);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(0, parsed - nowMilliseconds), MAX_RETRY_AFTER_MILLISECONDS);
}

function responseError(
  response: Response,
  nowMilliseconds: number,
  receiptId: string | null,
): EnableBankingApiError {
  const status = response.status;
  if (status === 400 || status === 422) {
    return new EnableBankingApiError('invalid_request', 'Enable Banking rejected the request.', {
      status,
      receiptId,
    });
  }
  if (status === 401) {
    return new EnableBankingApiError('authentication', 'Enable Banking authentication failed.', {
      status,
      receiptId,
    });
  }
  if (status === 403) {
    return new EnableBankingApiError('authorization', 'Enable Banking access is forbidden.', {
      status,
      receiptId,
    });
  }
  if (status === 404) {
    return new EnableBankingApiError('not_found', 'Enable Banking resource was not found.', {
      status,
      receiptId,
    });
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new EnableBankingApiError(
      status === 429 ? 'rate_limited' : 'transient_provider_failure',
      status === 429
        ? 'Enable Banking rate limited the request.'
        : 'Enable Banking is temporarily unavailable.',
      {
        status,
        retryable: true,
        retryAfterMilliseconds: retryAfterMilliseconds(
          response.headers.get('retry-after'),
          nowMilliseconds,
        ),
        receiptId,
      },
    );
  }
  return new EnableBankingApiError(
    'invalid_response',
    'Enable Banking returned an unexpected status.',
    { status, receiptId },
  );
}

type RequestDescriptor<T> = Readonly<{
  endpoint: EnableBankingRawEndpoint;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  requestCursor: string | null;
  body?: unknown;
  decode: (body: string) => T;
  safeToRetry: boolean;
  signal?: AbortSignal;
}>;

export class EnableBankingApiClient {
  readonly #baseUrl: string;
  readonly #applicationId: string;
  readonly #privateKeyPem: string;
  readonly #fetch: EnableBankingFetch;
  readonly #clock: EnableBankingClock;
  readonly #sleeper: EnableBankingSleeper;
  readonly #timeoutMilliseconds: number;
  readonly #responseSink: EnableBankingRawResponseSink | null;
  readonly #responseFailureSink: EnableBankingRawResponseFailureSink | null;

  constructor(
    input: Readonly<{
      applicationId: string;
      privateKeyPem: string;
      baseUrl?: string;
      fetchImplementation?: EnableBankingFetch;
      clock?: EnableBankingClock;
      sleeper?: EnableBankingSleeper;
      timeoutMilliseconds?: number;
      responseSink?: EnableBankingRawResponseSink;
      responseFailureSink?: EnableBankingRawResponseFailureSink;
    }>,
  ) {
    this.#baseUrl = normalizeBaseUrl(input.baseUrl ?? DEFAULT_BASE_URL);
    this.#applicationId = input.applicationId;
    this.#privateKeyPem = input.privateKeyPem;
    this.#clock = input.clock ?? { now: () => new Date() };
    createEnableBankingApplicationJwt({
      applicationId: this.#applicationId,
      privateKeyPem: this.#privateKeyPem,
      now: this.#clock.now(),
    });
    this.#fetch = input.fetchImplementation ?? fetch;
    this.#sleeper = input.sleeper ?? defaultSleeper;
    this.#timeoutMilliseconds = input.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds <= 0) {
      throw new EnableBankingApiError(
        'configuration',
        'Enable Banking timeout must be a positive integer.',
      );
    }
    this.#responseSink = input.responseSink ?? null;
    this.#responseFailureSink = input.responseFailureSink ?? null;
  }

  async listAspsps(
    signal?: AbortSignal,
  ): Promise<EnableBankingApiResponse<EnableBankingAspspsDto>> {
    const query = new URLSearchParams({ country: 'LV', psu_type: 'personal', service: 'AIS' });
    return this.#request({
      endpoint: 'aspsps',
      method: 'GET',
      path: `/aspsps?${query.toString()}`,
      requestCursor: null,
      decode: decodeEnableBankingAspsps,
      safeToRetry: true,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async startAuthorization(
    input: Readonly<{
      state: string;
      redirectUrl: string;
      validUntil: string;
      signal?: AbortSignal;
    }>,
  ): Promise<EnableBankingApiResponse<EnableBankingStartAuthorizationDto>> {
    return this.#request({
      endpoint: 'authorization',
      method: 'POST',
      path: '/auth',
      requestCursor: null,
      body: {
        access: { balances: true, transactions: true, valid_until: input.validUntil },
        aspsp: { name: 'Swedbank', country: 'LV' },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: 'personal',
      },
      decode: decodeEnableBankingStartAuthorization,
      safeToRetry: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async authorizeSession(
    input: Readonly<{ code: string; signal?: AbortSignal }>,
  ): Promise<EnableBankingApiResponse<EnableBankingAuthorizedSessionDto>> {
    if (input.code.length === 0 || input.code.length > 4096) {
      throw new EnableBankingApiError('invalid_request', 'Authorization code is invalid.');
    }
    return this.#request({
      endpoint: 'session_exchange',
      method: 'POST',
      path: '/sessions',
      requestCursor: null,
      body: { code: input.code },
      decode: decodeEnableBankingAuthorizedSession,
      safeToRetry: false,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<EnableBankingApiResponse<EnableBankingSessionDto>> {
    return this.#request({
      endpoint: 'session',
      method: 'GET',
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      requestCursor: null,
      decode: decodeEnableBankingSession,
      safeToRetry: true,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async getAccountDetails(
    accountUid: string,
    signal?: AbortSignal,
  ): Promise<EnableBankingApiResponse<EnableBankingAccountDetailsDto>> {
    return this.#request({
      endpoint: 'account_details',
      method: 'GET',
      path: `/accounts/${encodeURIComponent(accountUid)}/details`,
      requestCursor: null,
      decode: decodeEnableBankingAccountDetails,
      safeToRetry: true,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async getBalances(
    accountUid: string,
    signal?: AbortSignal,
  ): Promise<EnableBankingApiResponse<EnableBankingBalancesDto>> {
    return this.#request({
      endpoint: 'balances',
      method: 'GET',
      path: `/accounts/${encodeURIComponent(accountUid)}/balances`,
      requestCursor: null,
      decode: decodeEnableBankingBalances,
      safeToRetry: true,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async getTransactions(
    input: Readonly<{
      accountUid: string;
      continuationKey: string | null;
      strategy?: EnableBankingTransactionFetchStrategy;
      signal?: AbortSignal;
    }>,
  ): Promise<EnableBankingApiResponse<EnableBankingTransactionsDto>> {
    const strategy = input.strategy ?? 'longest';
    const query = new URLSearchParams({ strategy });
    if (input.continuationKey !== null) query.set('continuation_key', input.continuationKey);
    return this.#request({
      endpoint: 'transactions',
      method: 'GET',
      path: `/accounts/${encodeURIComponent(input.accountUid)}/transactions?${query.toString()}`,
      requestCursor: input.continuationKey,
      decode: decodeEnableBankingTransactions,
      safeToRetry: true,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async deleteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<EnableBankingApiResponse<Readonly<{ message: string }>>> {
    return this.#request({
      endpoint: 'disconnect',
      method: 'DELETE',
      path: `/sessions/${encodeURIComponent(sessionId)}`,
      requestCursor: null,
      decode: (body) => {
        let value: unknown;
        try {
          value = JSON.parse(body) as unknown;
        } catch {
          throw new EnableBankingApiError(
            'invalid_response',
            'Enable Banking disconnect response is malformed.',
          );
        }
        if (
          typeof value !== 'object' ||
          value === null ||
          Array.isArray(value) ||
          typeof (value as Record<string, unknown>)['message'] !== 'string'
        ) {
          throw new EnableBankingApiError(
            'invalid_response',
            'Enable Banking disconnect response is malformed.',
          );
        }
        return Object.freeze({ message: (value as Record<string, string>)['message']! });
      },
      safeToRetry: false,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  async #request<T>(descriptor: RequestDescriptor<T>): Promise<EnableBankingApiResponse<T>> {
    const attempts = descriptor.safeToRetry ? 3 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const jwt = createEnableBankingApplicationJwt({
          applicationId: this.#applicationId,
          privateKeyPem: this.#privateKeyPem,
          now: this.#clock.now(),
        });
        const headers: Record<string, string> = {
          accept: 'application/json',
          authorization: `Bearer ${jwt}`,
        };
        let body: string | undefined;
        if (descriptor.body !== undefined) {
          headers['content-type'] = 'application/json';
          body = JSON.stringify(descriptor.body);
        }
        const response = await this.#fetchWithTimeout(
          `${this.#baseUrl}${descriptor.path}`,
          {
            method: descriptor.method,
            headers,
            ...(body === undefined ? {} : { body }),
          },
          descriptor.signal,
          descriptor.safeToRetry,
        );
        const responseBody = await response.text();
        const receivedAt = parseInstant(this.#clock.now().toISOString());
        const receiptId =
          this.#responseSink === null
            ? null
            : await this.#responseSink({
                endpoint: descriptor.endpoint,
                method: descriptor.method,
                path: descriptor.path,
                requestCursor: descriptor.requestCursor,
                status: response.status,
                body: responseBody,
                receivedAt,
              });
        if (!response.ok) {
          const error = responseError(response, this.#clock.now().getTime(), receiptId);
          if (receiptId !== null && this.#responseFailureSink !== null) {
            await this.#responseFailureSink(receiptId, error.category, receivedAt);
          }
          throw error;
        }
        let value: T;
        try {
          value = descriptor.decode(responseBody);
        } catch (caught) {
          const decodingError =
            caught instanceof EnableBankingApiError
              ? caught
              : new EnableBankingApiError(
                  'invalid_response',
                  'Enable Banking response failed schema validation.',
                  { receiptId },
                );
          if (receiptId !== null && this.#responseFailureSink !== null) {
            await this.#responseFailureSink(receiptId, decodingError.category, receivedAt);
          }
          throw decodingError;
        }
        return Object.freeze({
          value,
          body: responseBody,
          status: response.status,
          receivedAt,
          receiptId,
        });
      } catch (error) {
        const mapped =
          error instanceof EnableBankingApiError
            ? error
            : new EnableBankingApiError(
                descriptor.safeToRetry ? 'transient_provider_failure' : 'indeterminate_mutation',
                descriptor.safeToRetry
                  ? 'Enable Banking network request failed.'
                  : 'Enable Banking mutation outcome is indeterminate.',
                { retryable: descriptor.safeToRetry },
              );
        if (!mapped.retryable || attempt === attempts - 1) throw mapped;
        await this.#sleeper(
          mapped.retryAfterMilliseconds ?? RETRY_DELAYS[attempt] ?? 1_000,
          descriptor.signal,
        );
      }
    }
    throw new EnableBankingApiError(
      'transient_provider_failure',
      'Enable Banking request attempts were exhausted.',
    );
  }

  async #fetchWithTimeout(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    safeToRetry: boolean,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.#fetch(url, { ...init, signal: combined });
    } catch {
      if (signal?.aborted === true) {
        throw new EnableBankingApiError(
          'transient_provider_failure',
          'Enable Banking request was aborted.',
        );
      }
      if (timeout.aborted) {
        throw new EnableBankingApiError('timeout', 'Enable Banking request timed out.', {
          retryable: safeToRetry,
        });
      }
      throw new EnableBankingApiError(
        safeToRetry ? 'transient_provider_failure' : 'indeterminate_mutation',
        safeToRetry
          ? 'Enable Banking network request failed.'
          : 'Enable Banking mutation outcome is indeterminate.',
        { retryable: safeToRetry },
      );
    }
  }
}
