import type { StandardSpendingCategoryCode } from '@personal-cfo/domain';

import type {
  CorrectionPatch,
  TelegramLocale,
  TelegramMessage,
  TelegramParseResult,
  TelegramProposalDraft,
} from './types.js';

const MAX_MINOR = 9_223_372_036_854_775_807n;
const ISO_DATE = /\b(\d{4}-\d{2}-\d{2})\b/gu;
const CURRENCY_AMOUNT =
  /(?:€\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:€|eur|евро))(?![\p{L}\p{N}])/giu;
const BARE_AMOUNT = /(?<![\p{L}\p{N}€$+-])(\d+(?:[.,]\d+)?)(?![\p{L}\p{N}])/gu;

type AmountResult =
  | Readonly<{ status: 'ok'; amountMinor: bigint; token: string }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'multiple' }>
  | Readonly<{ status: 'invalid' }>
  | Readonly<{ status: 'unsupported_currency' }>;

const phrase = (locale: TelegramLocale, en: string, ru: string) => (locale === 'ru' ? ru : en);

function moneyMinor(value: string): bigint | null {
  if (!/^\d+(?:[.,]\d{1,2})?$/u.test(value)) return null;
  const [whole = '', fraction = ''] = value.replace(',', '.').split('.');
  const amount = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return amount > 0n && amount <= MAX_MINOR ? amount : null;
}

export function parseEurAmount(text: string, allowBare = false): AmountResult {
  if (/[$£¥₽]|\b(?:usd|gbp|rub|rur|jpy|cny|cad|aud|chf)\b/iu.test(text))
    return Object.freeze({ status: 'unsupported_currency' });
  if (
    /(?:^|[^\p{L}\p{N}])(?:[+-]\s*€?\s*\d|€\s*[+-]\s*\d)|\b(?:nan|infinity|\d+(?:[.,]\d+)?e[+-]?\d+)\b/iu.test(
      text,
    )
  ) {
    return Object.freeze({ status: 'invalid' });
  }
  if (/\d+[.,]\d{3,}/u.test(text)) return Object.freeze({ status: 'invalid' });
  const explicit = [...text.matchAll(CURRENCY_AMOUNT)];
  const matches = explicit.length > 0 ? explicit : allowBare ? [...text.matchAll(BARE_AMOUNT)] : [];
  const dateRanges = [...text.matchAll(ISO_DATE)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const moneyMatches = matches.filter((match) => {
    const token = match[1] ?? match[2] ?? '';
    const start = match.index ?? 0;
    const end = start + match[0].length;
    return !dateRanges.some((range) => start < range.end && end > range.start) && token !== '';
  });
  if (moneyMatches.length === 0) return Object.freeze({ status: 'missing' });
  if (moneyMatches.length !== 1) return Object.freeze({ status: 'multiple' });
  const token = moneyMatches[0]?.[1] ?? moneyMatches[0]?.[2] ?? '';
  const amountMinor = moneyMinor(token);
  return amountMinor === null
    ? Object.freeze({ status: 'invalid' })
    : Object.freeze({ status: 'ok', amountMinor, token: moneyMatches[0]![0] });
}

function rigaDate(instant: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function rigaNoonInstant(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const guess = Date.UTC(year!, month! - 1, day, 12, 0, 0);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(guess));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const represented = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return new Date(guess - (represented - guess)).toISOString();
}

function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().startsWith(value)
  );
}

function parseEconomicDate(text: string, sentAt: string) {
  const explicit = [...text.matchAll(ISO_DATE)].map((match) => match[1]!);
  if (new Set(explicit).size > 1) return { status: 'invalid' as const };
  const reference = rigaDate(sentAt);
  const date =
    explicit[0] ?? (/(?:\byesterday\b|вчера)/iu.test(text) ? addDays(reference, -1) : reference);
  if (!validDate(date)) return { status: 'invalid' as const };
  const explicitDay = explicit.length > 0 || /(?:\byesterday\b|вчера)/iu.test(text);
  return {
    status: 'ok' as const,
    economicDate: date,
    effectiveAt: explicitDay ? rigaNoonInstant(date) : sentAt,
    referenceDate: reference,
  };
}

export function parseSpendingCategory(text: string): StandardSpendingCategoryCode {
  if (/(?:lunch|restaurant|cafe|dinner|обед|ресторан|кафе)/iu.test(text)) return 'restaurants';
  if (/(?:grocer(?:y|ies)|supermarket|food|продукт|магазин)/iu.test(text)) return 'groceries';
  if (/(?:taxi|uber|bolt|такси)/iu.test(text)) return 'taxi';
  if (/(?:sport|gym|fitness|спорт|зал|фитнес)/iu.test(text)) return 'sport';
  if (/(?:travel|trip|поездк|путешеств)/iu.test(text)) return 'travel';
  return 'other';
}

function clarification(
  locale: TelegramLocale,
  field: 'amount' | 'intent' | 'income_source' | 'due_date',
  draft: TelegramProposalDraft,
): TelegramParseResult {
  const questions = {
    amount: phrase(locale, 'How much?', 'Сколько?'),
    intent: phrase(
      locale,
      'Is this an expense, income, or cash count?',
      'Это расход, доход или пересчёт наличных?',
    ),
    income_source: phrase(
      locale,
      'Source: side hustle or other?',
      'Источник: подработка или другое?',
    ),
    due_date: phrase(
      locale,
      'What is the due date? Use YYYY-MM-DD.',
      'Какая дата? Используйте YYYY-MM-DD.',
    ),
  } as const;
  return Object.freeze({
    confidence: 'needs_clarification',
    missingField: field,
    question: questions[field],
    draft,
  });
}

function unsupported(
  locale: TelegramLocale,
  reason: string,
  response?: string,
): TelegramParseResult {
  return Object.freeze({
    confidence: 'unsupported',
    reason,
    response:
      response ??
      phrase(
        locale,
        'I could not understand that. Use /help for examples.',
        'Не удалось понять. Примеры: /help.',
      ),
    locale,
  });
}

function hasDisallowedControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0)!;
    return (
      (code >= 0 && code <= 8) ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 31) ||
      code === 127
    );
  });
}

function correction(text: string, message: TelegramMessage): TelegramParseResult | null {
  if (message.replyToMessageId === null) return null;
  const locale = message.locale;
  if (/^(?:cancel|undo|delete|отмени|отменить|удали)$/iu.test(text)) {
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'correction',
        replyToMessageId: message.replyToMessageId,
        patch: Object.freeze({ field: 'cancel' }),
        locale,
      }),
    });
  }
  const fields: CorrectionPatch[] = [];
  const amount = parseEurAmount(text, /\b(?:actually|amount|сумма|вообще)\b/iu.test(text));
  if (amount.status === 'ok')
    fields.push(Object.freeze({ field: 'amount', amountMinor: amount.amountMinor }));
  const date = parseEconomicDate(text, message.sentAt);
  if (/\b(?:date|дата)\b/iu.test(text) && date.status === 'ok') {
    fields.push(
      Object.freeze({
        field: 'date',
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
      }),
    );
  }
  if (/\b(?:category|категория)\b/iu.test(text)) {
    fields.push(Object.freeze({ field: 'category', category: parseSpendingCategory(text) }));
  }
  if (/(?:\bside[ -]?hustle\b|подработк)/iu.test(text)) {
    fields.push(Object.freeze({ field: 'income_source', source: 'side_hustle' }));
  } else if (/(?:\bother\b|другое)/iu.test(text)) {
    fields.push(Object.freeze({ field: 'income_source', source: 'other' }));
  }
  if (fields.length !== 1) {
    return unsupported(
      locale,
      'invalid_correction',
      phrase(
        locale,
        'Reply with one corrected amount, date, category, or “cancel”.',
        'Ответьте одной новой суммой, датой, категорией или «отмени».',
      ),
    );
  }
  return Object.freeze({
    confidence: 'high',
    proposal: Object.freeze({
      kind: 'correction',
      replyToMessageId: message.replyToMessageId,
      patch: fields[0]!,
      locale,
    }),
  });
}

function futureLabel(text: string, amountToken: string | null, dueDate: string | null): string {
  return text
    .replace(amountToken ?? /$^/u, ' ')
    .replace(dueDate ?? /$^/u, ' ')
    .replace(/\b(?:future expense|trip|by|до|поездка|на)\b/giu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

export function parseTelegramText(message: TelegramMessage): TelegramParseResult {
  const text = message.text;
  const locale = message.locale;
  if ([...text].length === 0 || [...text].length > 512 || hasDisallowedControl(text)) {
    return unsupported(
      locale,
      'invalid_text',
      phrase(
        locale,
        'Please send one short text command.',
        'Отправьте одну короткую текстовую команду.',
      ),
    );
  }
  const correctionResult = correction(text, message);
  if (correctionResult !== null) return correctionResult;
  if (text.startsWith('/')) return unsupported(locale, 'bot_command');
  if (/(?:\b(?:maybe|perhaps)\b|наверное|возможно)/iu.test(text)) {
    return clarification(locale, 'intent', Object.freeze({ kind: 'unknown', locale }));
  }
  const date = parseEconomicDate(text, message.sentAt);
  if (date.status !== 'ok') return unsupported(locale, 'invalid_date');
  const isFuture =
    /(?:\b(?:future expense|trip|insurance)\b|поездк|страховк)/iu.test(text) &&
    /(?:\bby\b|до)/iu.test(text);
  if (isFuture) {
    const amount = parseEurAmount(text, false);
    const dueDates = [...text.matchAll(ISO_DATE)].map((match) => match[1]!);
    const draft = Object.freeze({
      kind: 'future_expense' as const,
      ...(amount.status === 'ok' ? { amountMinor: amount.amountMinor.toString() } : {}),
      ...(dueDates[0] === undefined ? {} : { dueDate: dueDates[0] }),
      ...(futureLabel(text, amount.status === 'ok' ? amount.token : null, dueDates[0] ?? null)
        .length === 0
        ? {}
        : {
            label: futureLabel(
              text,
              amount.status === 'ok' ? amount.token : null,
              dueDates[0] ?? null,
            ),
          }),
      locale,
    });
    if (amount.status === 'missing') return clarification(locale, 'amount', draft);
    if (dueDates.length === 0) return clarification(locale, 'due_date', draft);
    if (amount.status !== 'ok' || dueDates.length !== 1 || !validDate(dueDates[0]!))
      return unsupported(locale, 'invalid_future_expense');
    if (dueDates[0]! <= date.referenceDate)
      return unsupported(
        locale,
        'past_due_date',
        phrase(
          locale,
          'The future-expense date must be in the future.',
          'Дата будущей траты должна быть в будущем.',
        ),
      );
    const label = futureLabel(text, amount.token, dueDates[0]!);
    if (label.length === 0)
      return unsupported(
        locale,
        'missing_label',
        phrase(
          locale,
          'Add a short label for the future expense.',
          'Добавьте короткое название будущей траты.',
        ),
      );
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'future_expense',
        label,
        targetMinor: amount.amountMinor,
        dueDate: dueDates[0]!,
        locale,
      }),
    });
  }
  const countIntent =
    /(?:cash count|i have|cash now|наличных сейчас|пересчитал(?:а)? наличк)/iu.test(text);
  const incomeIntent = /(?:received|income|получил(?:а)?|доход|подработк)/iu.test(text);
  const expenseIntent = /(?:spent|paid|cash|потратил(?:а)?|налич(?:кой|ными)|обед|стрижк)/iu.test(
    text,
  );
  const amount = parseEurAmount(text, true);
  if (amount.status === 'unsupported_currency')
    return unsupported(
      locale,
      'unsupported_currency',
      phrase(locale, 'Telegram V1 supports EUR only.', 'Telegram V1 поддерживает только EUR.'),
    );
  if (amount.status === 'multiple' || amount.status === 'invalid')
    return unsupported(
      locale,
      'invalid_amount',
      phrase(
        locale,
        'Send one positive EUR amount with at most two decimal places.',
        'Укажите одну положительную сумму EUR, не более двух знаков после запятой.',
      ),
    );
  if (/^(?:cash|наличка)\s+\d+(?:[.,]\d{1,2})?$/iu.test(text)) {
    return clarification(
      locale,
      'intent',
      Object.freeze({
        kind: 'unknown',
        ...(amount.status === 'ok' ? { amountMinor: amount.amountMinor.toString() } : {}),
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
        locale,
      }),
    );
  }
  if (countIntent) {
    if (amount.status === 'missing')
      return clarification(locale, 'amount', Object.freeze({ kind: 'unknown', locale }));
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'cash_count',
        countedMinor: amount.amountMinor,
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
        locale,
      }),
    });
  }
  if (incomeIntent) {
    if (/(?:salary|зарплат)/iu.test(text))
      return unsupported(
        locale,
        'salary_not_supported',
        phrase(
          locale,
          'Primary salary is not recorded through Telegram V1.',
          'Основная зарплата не записывается через Telegram V1.',
        ),
      );
    if (amount.status === 'missing')
      return clarification(
        locale,
        'amount',
        Object.freeze({
          kind: 'cash_income',
          economicDate: date.economicDate,
          effectiveAt: date.effectiveAt,
          locale,
        }),
      );
    const source = /(?:side[ -]?hustle|подработк)/iu.test(text)
      ? 'side_hustle'
      : /(?:\bother\b|другое)/iu.test(text)
        ? 'other'
        : null;
    if (source === null)
      return clarification(
        locale,
        'income_source',
        Object.freeze({
          kind: 'cash_income',
          amountMinor: amount.amountMinor.toString(),
          economicDate: date.economicDate,
          effectiveAt: date.effectiveAt,
          locale,
        }),
      );
    if (date.economicDate > date.referenceDate) return unsupported(locale, 'future_cash_activity');
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'cash_income',
        amountMinor: amount.amountMinor,
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
        source,
        locale,
      }),
    });
  }
  if (expenseIntent && amount.status === 'ok') {
    if (date.economicDate > date.referenceDate) return unsupported(locale, 'future_cash_activity');
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'cash_expense',
        amountMinor: amount.amountMinor,
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
        category: parseSpendingCategory(text),
        locale,
      }),
    });
  }
  if (amount.status === 'ok')
    return clarification(
      locale,
      'intent',
      Object.freeze({
        kind: 'unknown',
        amountMinor: amount.amountMinor.toString(),
        economicDate: date.economicDate,
        effectiveAt: date.effectiveAt,
        locale,
      }),
    );
  return unsupported(locale, 'unsupported_input');
}

export function mergeClarification(
  draft: TelegramProposalDraft,
  answer: TelegramMessage,
): TelegramParseResult {
  if (draft.kind === 'cash_income') {
    const parsedAmount = parseEurAmount(answer.text, true);
    const amountMinor =
      draft.amountMinor === undefined
        ? parsedAmount.status === 'ok'
          ? parsedAmount.amountMinor
          : null
        : BigInt(draft.amountMinor);
    if (amountMinor === null) return clarification(answer.locale, 'amount', draft);
    const source = /(?:\bside[ -]?hustle\b|подработк)/iu.test(answer.text)
      ? 'side_hustle'
      : /(?:\bother\b|другое)/iu.test(answer.text)
        ? 'other'
        : null;
    if (source === null) {
      return clarification(
        answer.locale,
        'income_source',
        Object.freeze({ ...draft, amountMinor: amountMinor.toString() }),
      );
    }
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'cash_income',
        amountMinor,
        economicDate: draft.economicDate!,
        effectiveAt: draft.effectiveAt!,
        source,
        locale: answer.locale,
      }),
    });
  }
  if (draft.kind === 'future_expense') {
    const parsedAmount = parseEurAmount(answer.text, true);
    const amountMinor =
      draft.amountMinor === undefined
        ? parsedAmount.status === 'ok'
          ? parsedAmount.amountMinor
          : null
        : BigInt(draft.amountMinor);
    if (amountMinor === null) return clarification(answer.locale, 'amount', draft);
    const replyDates = [...answer.text.matchAll(ISO_DATE)].map((match) => match[1]!);
    const dueDate = draft.dueDate ?? (replyDates.length === 1 ? replyDates[0] : undefined);
    if (dueDate === undefined) {
      return clarification(
        answer.locale,
        'due_date',
        Object.freeze({ ...draft, amountMinor: amountMinor.toString() }),
      );
    }
    if (!validDate(dueDate) || dueDate <= rigaDate(answer.sentAt)) {
      return unsupported(answer.locale, 'invalid_future_expense');
    }
    if (draft.label === undefined || draft.label.length === 0) {
      return unsupported(answer.locale, 'missing_label');
    }
    return Object.freeze({
      confidence: 'high',
      proposal: Object.freeze({
        kind: 'future_expense',
        label: draft.label,
        targetMinor: amountMinor,
        dueDate,
        locale: answer.locale,
      }),
    });
  }
  if (draft.kind === 'unknown') {
    const parsedAmount = parseEurAmount(answer.text, true);
    const amountMinor =
      draft.amountMinor === undefined
        ? parsedAmount.status === 'ok'
          ? parsedAmount.amountMinor
          : null
        : BigInt(draft.amountMinor);
    if (amountMinor === null) return clarification(answer.locale, 'amount', draft);
    const economicDate = draft.economicDate ?? rigaDate(answer.sentAt);
    const effectiveAt = draft.effectiveAt ?? answer.sentAt;
    if (/(?:cash count|count|пересч|остаток)/iu.test(answer.text)) {
      return Object.freeze({
        confidence: 'high',
        proposal: Object.freeze({
          kind: 'cash_count',
          countedMinor: amountMinor,
          economicDate,
          effectiveAt,
          locale: answer.locale,
        }),
      });
    }
    if (/(?:income|received|доход|получил|подработк)/iu.test(answer.text)) {
      const source = /(?:\bside[ -]?hustle\b|подработк)/iu.test(answer.text)
        ? 'side_hustle'
        : /(?:\bother\b|другое)/iu.test(answer.text)
          ? 'other'
          : null;
      if (source === null) {
        return clarification(
          answer.locale,
          'income_source',
          Object.freeze({
            kind: 'cash_income',
            amountMinor: amountMinor.toString(),
            economicDate,
            effectiveAt,
            locale: answer.locale,
          }),
        );
      }
      return Object.freeze({
        confidence: 'high',
        proposal: Object.freeze({
          kind: 'cash_income',
          amountMinor,
          economicDate,
          effectiveAt,
          source,
          locale: answer.locale,
        }),
      });
    }
    if (/(?:expense|spent|paid|расход|потратил)/iu.test(answer.text)) {
      return Object.freeze({
        confidence: 'high',
        proposal: Object.freeze({
          kind: 'cash_expense',
          amountMinor,
          economicDate,
          effectiveAt,
          category: parseSpendingCategory(answer.text),
          locale: answer.locale,
        }),
      });
    }
    return clarification(
      answer.locale,
      'intent',
      Object.freeze({ ...draft, amountMinor: amountMinor.toString(), economicDate, effectiveAt }),
    );
  }
  return parseTelegramText(answer);
}
