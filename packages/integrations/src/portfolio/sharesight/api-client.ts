import { parseInstant } from '@personal-cfo/domain';

import {
  decodeSharesightCashAccountTransactions,
  decodeSharesightCashAccounts,
  decodeSharesightPayouts,
  decodeSharesightPerformance,
  decodeSharesightPortfolios,
  decodeSharesightTrades,
  decodeSharesightValuation,
} from './binding.js';
import type {
  SharesightAccessToken,
  SharesightCashAccount,
  SharesightCashAccountTransaction,
  SharesightClock,
  SharesightFetch,
  SharesightPayout,
  SharesightPerformance,
  SharesightPortfolio,
  SharesightRawResponse,
  SharesightRawResponseSink,
  SharesightSleeper,
  SharesightTrade,
  SharesightValuation,
} from './types.js';

const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const REQUEST_LIMIT = 360;
const REQUEST_WINDOW_MS = 60_000;
const MAX_REPORT_CONCURRENCY = 3;

export class SharesightApiError extends Error {
  readonly category:
    | 'configuration'
    | 'authentication'
    | 'authorization'
    | 'rate_limited'
    | 'timeout'
    | 'transient_provider_failure'
    | 'invalid_request'
    | 'invalid_response';
  readonly retryable: boolean;
  readonly status: number | null;
  readonly retryAfterMilliseconds: number | null;

  constructor(
    category: SharesightApiError['category'],
    message: string,
    options: Readonly<{
      retryable?: boolean;
      status?: number | null;
      retryAfterMilliseconds?: number | null;
    }> = {},
  ) {
    super(message);
    this.name = 'SharesightApiError';
    this.category = category;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.retryAfterMilliseconds = options.retryAfterMilliseconds ?? null;
  }
}

export type SharesightApiClientOptions = Readonly<{
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetchImplementation?: SharesightFetch;
  clock?: SharesightClock;
  sleeper?: SharesightSleeper;
  timeoutMilliseconds?: number;
  rawResponseSink?: SharesightRawResponseSink;
}>;

type Decoder<T> = (body: string, headers?: Readonly<Record<string, string>>) => T;

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'),
      );
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError'),
        );
      },
      { once: true },
    );
  });
}

function safeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SharesightApiError('configuration', 'Sharesight API base URL is invalid.');
  }
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SharesightApiError(
      'configuration',
      'Sharesight API base URL must use HTTPS or a loopback HTTP origin.',
    );
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new SharesightApiError('configuration', 'Sharesight API base URL must be an origin.');
  }
  return url.origin;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get('retry-after');
  if (value === null || !/^\d+$/u.test(value)) return null;
  return Math.min(Number(value) * 1000, 60_000);
}

function requestError(response: Response, body: string): SharesightApiError {
  const status = response.status;
  const minuteLimited = response.headers.get('x-minuterate-remaining') === '0';
  const concurrentLimited = status === 403 && /too many parallel requests/iu.test(body);
  if (status === 429 || (status === 403 && (minuteLimited || concurrentLimited))) {
    return new SharesightApiError('rate_limited', 'Sharesight request was rate limited.', {
      retryable: true,
      status,
      retryAfterMilliseconds: retryAfter(response) ?? (minuteLimited ? 60_000 : 1_000),
    });
  }
  if (status === 401) {
    return new SharesightApiError('authentication', 'Sharesight authentication failed.', {
      status,
    });
  }
  if (status === 403) {
    return new SharesightApiError('authorization', 'Sharesight access was denied.', { status });
  }
  if (status === 408 || status >= 500) {
    return new SharesightApiError(
      'transient_provider_failure',
      'Sharesight returned a transient provider failure.',
      { retryable: true, status, retryAfterMilliseconds: retryAfter(response) },
    );
  }
  return new SharesightApiError('invalid_request', 'Sharesight rejected the request.', { status });
}

export class SharesightApiClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: SharesightFetch;
  readonly #clock: SharesightClock;
  readonly #sleeper: SharesightSleeper;
  readonly #timeoutMilliseconds: number;
  readonly #rawResponseSink: SharesightRawResponseSink | null;
  #token: SharesightAccessToken | null = null;
  #tokenPromise: Promise<SharesightAccessToken> | null = null;
  #requestTimes: number[] = [];
  #activeReports = 0;
  readonly #reportWaiters: Array<() => void> = [];

  constructor(options: SharesightApiClientOptions) {
    if (options.clientId.trim().length === 0 || options.clientSecret.trim().length === 0) {
      throw new SharesightApiError('configuration', 'Sharesight client credentials are required.');
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#baseUrl = safeBaseUrl(options.baseUrl ?? 'https://api.sharesight.com');
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#clock = options.clock ?? { now: () => new Date() };
    this.#sleeper = options.sleeper ?? defaultSleep;
    this.#timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MS;
    this.#rawResponseSink = options.rawResponseSink ?? null;
    if (!Number.isSafeInteger(this.#timeoutMilliseconds) || this.#timeoutMilliseconds <= 0) {
      throw new SharesightApiError('configuration', 'Sharesight timeout must be positive.');
    }
  }

  async #limited(signal?: AbortSignal): Promise<void> {
    const now = this.#clock.now().getTime();
    this.#requestTimes = this.#requestTimes.filter((time) => now - time < REQUEST_WINDOW_MS);
    if (this.#requestTimes.length >= REQUEST_LIMIT) {
      await this.#sleeper(REQUEST_WINDOW_MS - (now - this.#requestTimes[0]!), signal);
      return this.#limited(signal);
    }
    this.#requestTimes.push(this.#clock.now().getTime());
  }

  async #withReportSlot<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#activeReports >= MAX_REPORT_CONCURRENCY) {
      await new Promise<void>((resolve) => this.#reportWaiters.push(resolve));
    }
    this.#activeReports += 1;
    try {
      return await operation();
    } finally {
      this.#activeReports -= 1;
      this.#reportWaiters.shift()?.();
    }
  }

  async #fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.#timeoutMilliseconds);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      return await this.#fetch(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      if (timeout.aborted) {
        throw new SharesightApiError('timeout', 'Sharesight request timed out.', {
          retryable: true,
        });
      }
      throw new SharesightApiError(
        'transient_provider_failure',
        'Sharesight network request failed.',
        { retryable: true },
      );
    }
  }

  async #obtainToken(signal?: AbortSignal): Promise<SharesightAccessToken> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await this.#limited(signal);
      let response: Response;
      try {
        response = await this.#fetchWithTimeout(
          `${this.#baseUrl}/oauth2/token`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'client_credentials',
              client_id: this.#clientId,
              client_secret: this.#clientSecret,
            }).toString(),
          },
          signal,
        );
      } catch (error) {
        if (!(error instanceof SharesightApiError) || !error.retryable || attempt === 3)
          throw error;
        await this.#sleeper(attempt === 1 ? 250 : 1_000, signal);
        continue;
      }
      const body = await response.text();
      if (!response.ok) {
        const error = requestError(response, body);
        if (error.retryable && attempt < 3) {
          await this.#sleeper(
            error.retryAfterMilliseconds ?? (attempt === 1 ? 250 : 1_000),
            signal,
          );
          continue;
        }
        throw new SharesightApiError('authentication', 'Sharesight authentication failed.', {
          status: response.status,
        });
      }
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new SharesightApiError('invalid_response', 'Sharesight token response was invalid.');
      }
      const token = object(payload);
      if (
        token === null ||
        typeof token['access_token'] !== 'string' ||
        token['access_token'].length === 0 ||
        typeof token['expires_in'] !== 'number' ||
        !Number.isSafeInteger(token['expires_in']) ||
        token['expires_in'] <= 60
      ) {
        throw new SharesightApiError('invalid_response', 'Sharesight token response was invalid.');
      }
      return Object.freeze({
        value: token['access_token'],
        expiresAtMilliseconds: this.#clock.now().getTime() + token['expires_in'] * 1000,
      });
    }
    throw new SharesightApiError('authentication', 'Sharesight authentication failed.');
  }

  async #accessToken(signal?: AbortSignal): Promise<string> {
    const now = this.#clock.now().getTime();
    if (this.#token !== null && now < this.#token.expiresAtMilliseconds - TOKEN_EXPIRY_MARGIN_MS) {
      return this.#token.value;
    }
    this.#tokenPromise ??= this.#obtainToken(signal);
    try {
      this.#token = await this.#tokenPromise;
      return this.#token.value;
    } finally {
      this.#tokenPromise = null;
    }
  }

  async #get<T>(
    path: string,
    decoder: Decoder<T>,
    options: Readonly<{ signal?: AbortSignal; report?: boolean }> = {},
  ): Promise<SharesightRawResponse<T>> {
    const operation = async () => {
      let authenticationReplay = false;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const token = await this.#accessToken(options.signal);
        await this.#limited(options.signal);
        let response: Response;
        try {
          response = await this.#fetchWithTimeout(
            `${this.#baseUrl}${path}`,
            {
              method: 'GET',
              headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
            },
            options.signal,
          );
        } catch (error) {
          if (!(error instanceof SharesightApiError) || !error.retryable || attempt === 3)
            throw error;
          await this.#sleeper(attempt === 1 ? 250 : 1_000, options.signal);
          continue;
        }
        const body = await response.text();
        if (response.status === 401 && !authenticationReplay) {
          authenticationReplay = true;
          this.#token = null;
          attempt -= 1;
          continue;
        }
        if (!response.ok) {
          const error = requestError(response, body);
          if (error.retryable && attempt < 3) {
            await this.#sleeper(
              error.retryAfterMilliseconds ?? (attempt === 1 ? 250 : 1_000),
              options.signal,
            );
            continue;
          }
          throw error;
        }
        const headers = {
          holdingLimitTotal: response.headers.get('x-holdinglimit-total'),
          holdingLimitReason: response.headers.get('x-holdinglimit-reason'),
        };
        const receivedAt = parseInstant(this.#clock.now().toISOString());
        const receiptId =
          this.#rawResponseSink === null
            ? null
            : await this.#rawResponseSink({ path, body, receivedAt });
        let value: T;
        try {
          value = decoder(body, {
            ...(headers.holdingLimitTotal === null
              ? {}
              : { holdingLimitTotal: headers.holdingLimitTotal }),
            ...(headers.holdingLimitReason === null
              ? {}
              : { holdingLimitReason: headers.holdingLimitReason }),
          });
        } catch {
          throw new SharesightApiError(
            'invalid_response',
            'Sharesight response failed schema validation.',
          );
        }
        return Object.freeze({
          body,
          value,
          receivedAt,
          receiptId,
          ...headers,
        });
      }
      throw new SharesightApiError('transient_provider_failure', 'Sharesight retry limit reached.');
    };
    return options.report === true ? this.#withReportSlot(operation) : operation();
  }

  listPortfolios(
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<readonly SharesightPortfolio[]>> {
    return this.#get('/api/v2/portfolios.json', (body) => decodeSharesightPortfolios(body), {
      ...(signal === undefined ? {} : { signal }),
    });
  }

  getValuation(
    portfolioId: string,
    balanceDate: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<SharesightValuation>> {
    return this.#get(
      `/api/v2.1/portfolios/${encodeURIComponent(portfolioId)}/valuation.json?balance_date=${encodeURIComponent(balanceDate)}&grouping=market`,
      (body, headers) => decodeSharesightValuation(body, headers),
      { ...(signal === undefined ? {} : { signal }), report: true },
    );
  }

  listCashAccounts(
    portfolioId: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<readonly SharesightCashAccount[]>> {
    return this.#get(
      `/api/v2/portfolios/${encodeURIComponent(portfolioId)}/cash_accounts.json`,
      (body) => decodeSharesightCashAccounts(body),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  listCashTransactions(
    cashAccountId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<readonly SharesightCashAccountTransaction[]>> {
    return this.#get(
      `/api/v2/cash_accounts/${encodeURIComponent(cashAccountId)}/cash_account_transactions.json?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      (body) => decodeSharesightCashAccountTransactions(body),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  listTrades(
    portfolioId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<readonly SharesightTrade[]>> {
    return this.#get(
      `/api/v2/portfolios/${encodeURIComponent(portfolioId)}/trades.json?start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}`,
      (body) => decodeSharesightTrades(body),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  listPayouts(
    portfolioId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<readonly SharesightPayout[]>> {
    return this.#get(
      `/api/v2/portfolios/${encodeURIComponent(portfolioId)}/payouts.json?start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}&use_date=paid_on`,
      (body) => decodeSharesightPayouts(body),
      { ...(signal === undefined ? {} : { signal }) },
    );
  }

  getPerformance(
    portfolioId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ): Promise<SharesightRawResponse<SharesightPerformance>> {
    return this.#get(
      `/api/v2/portfolios/${encodeURIComponent(portfolioId)}/performance.json?start_date=${encodeURIComponent(from)}&end_date=${encodeURIComponent(to)}&include_sales=true&grouping=market`,
      (body) => decodeSharesightPerformance(body),
      { ...(signal === undefined ? {} : { signal }), report: true },
    );
  }
}
