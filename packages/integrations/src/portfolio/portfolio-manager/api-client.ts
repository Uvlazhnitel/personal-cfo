import { parseInstant } from '@personal-cfo/domain';

import {
  decodePortfolioManagerCapabilities,
  decodePortfolioManagerCapitalFlows,
  decodePortfolioManagerSnapshot,
} from './binding.js';
import type {
  PortfolioManagerApiErrorCategory,
  PortfolioManagerCapabilities,
  PortfolioManagerCapitalFlowPage,
  PortfolioManagerClock,
  PortfolioManagerFetch,
  PortfolioManagerRawResponse,
  PortfolioManagerRawResponseSink,
  PortfolioManagerSleeper,
  PortfolioManagerSnapshot,
} from './types.js';

const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_RETRY_AFTER_MILLISECONDS = 60_000;
const RETRY_DELAYS = [250, 1_000] as const;

export class PortfolioManagerApiError extends Error {
  readonly category: PortfolioManagerApiErrorCategory;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMilliseconds: number | null;

  constructor(
    category: PortfolioManagerApiErrorCategory,
    message: string,
    options: Readonly<{
      status?: number | null;
      retryable?: boolean;
      retryAfterMilliseconds?: number | null;
    }> = {},
  ) {
    super(message);
    this.name = 'PortfolioManagerApiError';
    this.category = category;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds ?? null;
  }
}

function defaultSleeper(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Portfolio Manager request aborted.'),
      );
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Portfolio Manager request aborted.'),
        );
      },
      { once: true },
    );
  });
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PortfolioManagerApiError('configuration', 'Portfolio Manager base URL is invalid.');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new PortfolioManagerApiError(
      'configuration',
      'Portfolio Manager base URL must use HTTPS except on loopback.',
    );
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new PortfolioManagerApiError(
      'configuration',
      'Portfolio Manager base URL cannot include credentials, query, or fragment.',
    );
  }
  return url.toString().replace(/\/$/u, '');
}

function retryAfterMilliseconds(header: string | null, nowMilliseconds: number): number | null {
  if (header === null) return null;
  if (/^\d+$/u.test(header)) {
    return Math.min(Number(header) * 1_000, MAX_RETRY_AFTER_MILLISECONDS);
  }
  const date = Date.parse(header);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, date - nowMilliseconds), MAX_RETRY_AFTER_MILLISECONDS);
}

function responseError(response: Response, nowMilliseconds: number): PortfolioManagerApiError {
  const status = response.status;
  if (status === 400) {
    return new PortfolioManagerApiError(
      'invalid_request',
      'Portfolio Manager rejected the request.',
      {
        status,
      },
    );
  }
  if (status === 401) {
    return new PortfolioManagerApiError(
      'authentication',
      'Portfolio Manager authentication failed.',
      { status },
    );
  }
  if (status === 403) {
    return new PortfolioManagerApiError('authorization', 'Portfolio Manager access is forbidden.', {
      status,
    });
  }
  if (status === 404) {
    return new PortfolioManagerApiError(
      'unsupported_version',
      'Portfolio Manager Personal CFO API version is unavailable.',
      { status },
    );
  }
  if (status === 408 || status === 429 || status >= 500) {
    return new PortfolioManagerApiError(
      status === 429 ? 'rate_limited' : 'transient_provider_failure',
      status === 429
        ? 'Portfolio Manager rate limited the request.'
        : 'Portfolio Manager is temporarily unavailable.',
      {
        status,
        retryable: true,
        retryAfterMilliseconds: retryAfterMilliseconds(
          response.headers.get('retry-after'),
          nowMilliseconds,
        ),
      },
    );
  }
  return new PortfolioManagerApiError(
    'invalid_response',
    'Portfolio Manager returned an unexpected status.',
    { status },
  );
}

export class PortfolioManagerApiClient {
  readonly #baseUrl: string;
  readonly #apiToken: string;
  readonly #fetch: PortfolioManagerFetch;
  readonly #clock: PortfolioManagerClock;
  readonly #sleeper: PortfolioManagerSleeper;
  readonly #timeoutMilliseconds: number;
  readonly #responseSink: PortfolioManagerRawResponseSink | null;

  constructor(
    input: Readonly<{
      baseUrl: string;
      apiToken: string;
      fetchImplementation?: PortfolioManagerFetch;
      clock?: PortfolioManagerClock;
      sleeper?: PortfolioManagerSleeper;
      timeoutMilliseconds?: number;
      responseSink?: PortfolioManagerRawResponseSink;
    }>,
  ) {
    this.#baseUrl = normalizeBaseUrl(input.baseUrl);
    if (input.apiToken.trim().length === 0 || /\s/u.test(input.apiToken)) {
      throw new PortfolioManagerApiError(
        'configuration',
        'Portfolio Manager API token is invalid.',
      );
    }
    this.#apiToken = input.apiToken;
    this.#fetch = input.fetchImplementation ?? fetch;
    this.#clock = input.clock ?? { now: () => new Date() };
    this.#sleeper = input.sleeper ?? defaultSleeper;
    this.#timeoutMilliseconds = input.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds <= 0) {
      throw new PortfolioManagerApiError(
        'configuration',
        'Portfolio Manager timeout must be a positive integer.',
      );
    }
    this.#responseSink = input.responseSink ?? null;
  }

  async getCapabilities(
    signal?: AbortSignal,
  ): Promise<PortfolioManagerRawResponse<PortfolioManagerCapabilities>> {
    return this.#get(
      'capabilities',
      '/api/integrations/personal-cfo/v1/capabilities',
      null,
      decodePortfolioManagerCapabilities,
      signal,
    );
  }

  async getSnapshot(
    signal?: AbortSignal,
  ): Promise<PortfolioManagerRawResponse<PortfolioManagerSnapshot>> {
    return this.#get(
      'snapshot',
      '/api/integrations/personal-cfo/v1/snapshot',
      null,
      decodePortfolioManagerSnapshot,
      signal,
    );
  }

  async getCapitalFlows(
    input: Readonly<{ cursor: string | null; limit?: number; signal?: AbortSignal }>,
  ): Promise<PortfolioManagerRawResponse<PortfolioManagerCapitalFlowPage>> {
    const limit = input.limit ?? 500;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new PortfolioManagerApiError(
        'invalid_request',
        'Portfolio Manager capital-flow limit must be between 1 and 500.',
      );
    }
    const query = new URLSearchParams({ limit: String(limit) });
    if (input.cursor !== null) query.set('cursor', input.cursor);
    const path = `/api/integrations/personal-cfo/v1/capital-flows?${query.toString()}`;
    return this.#get(
      'capital_flows',
      path,
      input.cursor,
      decodePortfolioManagerCapitalFlows,
      input.signal,
    );
  }

  async #get<T>(
    endpoint: 'capabilities' | 'snapshot' | 'capital_flows',
    path: string,
    requestCursor: string | null,
    decode: (body: string) => T,
    signal?: AbortSignal,
  ): Promise<PortfolioManagerRawResponse<T>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.#fetchWithTimeout(
          `${this.#baseUrl}${path}`,
          {
            method: 'GET',
            headers: {
              accept: 'application/json',
              authorization: `Bearer ${this.#apiToken}`,
            },
          },
          signal,
        );
        const body = await response.text();
        if (!response.ok) throw responseError(response, this.#clock.now().getTime());
        const receivedAt = parseInstant(this.#clock.now().toISOString());
        const receiptId =
          this.#responseSink === null
            ? null
            : await this.#responseSink({ endpoint, path, requestCursor, body, receivedAt });
        let value: T;
        try {
          value = decode(body);
        } catch (error) {
          if (error instanceof PortfolioManagerApiError) throw error;
          throw new PortfolioManagerApiError(
            'invalid_response',
            'Portfolio Manager response failed schema validation.',
          );
        }
        return Object.freeze({ body, value, receivedAt, receiptId });
      } catch (error) {
        const mapped =
          error instanceof PortfolioManagerApiError
            ? error
            : new PortfolioManagerApiError(
                'transient_provider_failure',
                'Portfolio Manager network request failed.',
                { retryable: true },
              );
        if (!mapped.retryable || attempt === 2) throw mapped;
        await this.#sleeper(
          mapped.retryAfterMilliseconds ?? RETRY_DELAYS[attempt] ?? 1_000,
          signal,
        );
      }
    }
    throw new PortfolioManagerApiError(
      'transient_provider_failure',
      'Portfolio Manager request attempts were exhausted.',
    );
  }

  async #fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.#fetch(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.aborted) {
        throw new PortfolioManagerApiError('timeout', 'Portfolio Manager request timed out.', {
          retryable: true,
        });
      }
      throw new PortfolioManagerApiError(
        'transient_provider_failure',
        'Portfolio Manager network request failed.',
        { retryable: true },
      );
    }
  }
}
