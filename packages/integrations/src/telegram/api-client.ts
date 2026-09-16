export type TelegramUpdateDto = Readonly<Record<string, unknown>>;

export type TelegramGetUpdatesRequest = Readonly<{
  offset: bigint | null;
  timeoutSeconds: number;
  signal?: AbortSignal;
}>;

export type TelegramSendMessageRequest = Readonly<{
  chatId: bigint;
  text: string;
  replyToMessageId: bigint | null;
  signal?: AbortSignal;
}>;

export interface TelegramApi {
  getUpdates(request: TelegramGetUpdatesRequest): Promise<readonly TelegramUpdateDto[]>;
  sendMessage(request: TelegramSendMessageRequest): Promise<Readonly<{ messageId: bigint }>>;
}

export class TelegramApiError extends Error {
  readonly category: 'network_uncertain' | 'rate_limited' | 'provider_error' | 'invalid_response';
  readonly retryAfterSeconds: number | null;

  constructor(
    category: TelegramApiError['category'],
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'TelegramApiError';
    this.category = category;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export type TelegramApiClientOptions = Readonly<{
  timeoutGraceMilliseconds?: number;
  sendTimeoutMilliseconds?: number;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function integer(value: unknown, label: string): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new TelegramApiError('invalid_response', `${label} was not a safe integer.`);
  }
  return BigInt(value);
}

export class TelegramBotApiClient implements TelegramApi {
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #timeoutGraceMilliseconds: number;
  readonly #sendTimeoutMilliseconds: number;

  constructor(
    token: string,
    fetchImplementation: FetchLike = fetch,
    options: TelegramApiClientOptions = {},
  ) {
    if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(token)) throw new Error('Invalid Telegram bot token.');
    this.#baseUrl = `https://api.telegram.org/bot${token}`;
    this.#fetch = fetchImplementation;
    this.#timeoutGraceMilliseconds = options.timeoutGraceMilliseconds ?? 10_000;
    this.#sendTimeoutMilliseconds = options.sendTimeoutMilliseconds ?? 10_000;
  }

  async #call(method: 'getUpdates' | 'sendMessage', body: unknown, signal?: AbortSignal) {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new TelegramApiError('network_uncertain', `Telegram ${method} network failure.`);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TelegramApiError('invalid_response', `Telegram ${method} returned invalid JSON.`);
    }
    const envelope = record(payload);
    if (envelope === null || typeof envelope['ok'] !== 'boolean') {
      throw new TelegramApiError(
        'invalid_response',
        `Telegram ${method} returned an invalid envelope.`,
      );
    }
    if (!envelope['ok']) {
      const parameters = record(envelope['parameters']);
      const retryAfter = parameters?.['retry_after'];
      throw new TelegramApiError(
        retryAfter !== undefined
          ? 'rate_limited'
          : response.status >= 500
            ? 'provider_error'
            : 'invalid_response',
        `Telegram ${method} was rejected.`,
        typeof retryAfter === 'number' && Number.isSafeInteger(retryAfter) ? retryAfter : null,
      );
    }
    return envelope['result'];
  }

  async getUpdates(request: TelegramGetUpdatesRequest): Promise<readonly TelegramUpdateDto[]> {
    const timeout = AbortSignal.timeout(
      request.timeoutSeconds * 1000 + this.#timeoutGraceMilliseconds,
    );
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const result = await this.#call(
      'getUpdates',
      {
        ...(request.offset === null ? {} : { offset: Number(request.offset) }),
        timeout: request.timeoutSeconds,
        allowed_updates: ['message'],
      },
      signal,
    );
    if (!Array.isArray(result) || result.some((item) => record(item) === null)) {
      throw new TelegramApiError('invalid_response', 'Telegram getUpdates result was invalid.');
    }
    return Object.freeze(result as TelegramUpdateDto[]);
  }

  async sendMessage(request: TelegramSendMessageRequest): Promise<Readonly<{ messageId: bigint }>> {
    const timeout = AbortSignal.timeout(this.#sendTimeoutMilliseconds);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout]);
    const result = record(
      await this.#call(
        'sendMessage',
        {
          chat_id: request.chatId.toString(),
          text: request.text,
          ...(request.replyToMessageId === null
            ? {}
            : {
                reply_parameters: {
                  message_id: Number(request.replyToMessageId),
                  allow_sending_without_reply: true,
                },
              }),
        },
        signal,
      ),
    );
    if (result === null) {
      throw new TelegramApiError('invalid_response', 'Telegram sendMessage result was invalid.');
    }
    return Object.freeze({ messageId: integer(result['message_id'], 'message_id') });
  }
}
