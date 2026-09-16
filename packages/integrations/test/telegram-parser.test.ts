import { describe, expect, it } from 'vitest';

import type { TelegramMessage } from '../src/index.js';
import {
  mergeClarification,
  parseEurAmount,
  parseTelegramText,
  rigaNoonInstant,
} from '../src/index.js';

function message(text: string, sentAt = '2026-09-16T09:00:00.000Z'): TelegramMessage {
  return {
    updateId: 1n,
    chatId: 10n,
    senderId: 10n,
    messageId: 20n,
    sentAt,
    text,
    textHash: 'hash',
    locale: /[А-Яа-яЁё]/u.test(text) ? 'ru' : 'en',
    localeDetected: /[A-Za-zА-Яа-яЁё]/u.test(text),
    chatType: 'private',
    senderIsBot: false,
    forwarded: false,
    replyToMessageId: null,
  };
}

describe('Telegram deterministic parser', () => {
  it.each([
    ['€12 lunch paid in cash', 'cash_expense', 1_200n],
    ['12 EUR cash lunch', 'cash_expense', 1_200n],
    ['12,50 евро наличкой обед', 'cash_expense', 1_250n],
    ['today €27 cash haircut', 'cash_expense', 2_700n],
    ['yesterday €18 cash groceries', 'cash_expense', 1_800n],
    ['received €120 cash from side hustle', 'cash_income', 12_000n],
    ['120 EUR cash side hustle income', 'cash_income', 12_000n],
    ['получил 120 евро наличными за подработку', 'cash_income', 12_000n],
    ['cash count €125', 'cash_count', 12_500n],
    ['наличных сейчас 125 евро', 'cash_count', 12_500n],
    ['future expense Japan €1500 by 2027-05-01', 'future_expense', 150_000n],
    ['поездка Япония 1500 евро до 2027-05-01', 'future_expense', 150_000n],
  ])('parses %s', (text, kind, amount) => {
    const result = parseTelegramText(message(text));
    expect(result.confidence).toBe('high');
    if (result.confidence !== 'high') return;
    expect(result.proposal.kind).toBe(kind);
    const value =
      result.proposal.kind === 'cash_count'
        ? result.proposal.countedMinor
        : result.proposal.kind === 'future_expense'
          ? result.proposal.targetMinor
          : result.proposal.kind === 'correction'
            ? null
            : result.proposal.amountMinor;
    expect(value).toBe(amount);
  });

  it.each(['lunch', '12', 'received cash', '€20 maybe lunch', 'cash 100', 'Japan May'])(
    'does not execute ambiguous input %s',
    (text) => {
      expect(parseTelegramText(message(text)).confidence).not.toBe('high');
    },
  );

  it.each([
    '-12 EUR cash lunch',
    '1e9 EUR cash lunch',
    '12.345 EUR cash lunch',
    '$20 cash lunch',
    '€12 and €14 cash lunch',
    '92233720368547758.08 EUR cash lunch',
    'NaN EUR cash lunch',
    '\u0000€12 cash lunch',
  ])('rejects malformed input %s', (text) => {
    expect(parseTelegramText(message(text)).confidence).not.toBe('high');
  });

  it('rejects future cash activity and non-future fund due dates', () => {
    expect(parseTelegramText(message('€12 cash lunch 2026-09-17'))).toMatchObject({
      confidence: 'unsupported',
      reason: 'future_cash_activity',
    });
    expect(parseTelegramText(message('trip Japan €1500 by 2026-09-16'))).toMatchObject({
      confidence: 'unsupported',
      reason: 'past_due_date',
    });
  });

  it('parses money without floating point', () => {
    expect(parseEurAmount('€12.50')).toMatchObject({ status: 'ok', amountMinor: 1_250n });
    expect(parseEurAmount('12,50 евро')).toMatchObject({ status: 'ok', amountMinor: 1_250n });
  });

  it('rejects signed and non-EUR amounts', () => {
    expect(parseEurAmount('€-12')).toEqual({ status: 'invalid' });
    expect(parseEurAmount('+12 EUR')).toEqual({ status: 'invalid' });
    expect(parseEurAmount('12 CHF')).toEqual({ status: 'unsupported_currency' });
    expect(parseEurAmount('£12')).toEqual({ status: 'unsupported_currency' });
  });

  it('uses deterministic Europe/Riga noon across DST', () => {
    expect(rigaNoonInstant('2026-01-15')).toBe('2026-01-15T10:00:00.000Z');
    expect(rigaNoonInstant('2026-07-15')).toBe('2026-07-15T09:00:00.000Z');
  });

  it('uses the message instant for same-day activity and Riga noon for past dates', () => {
    const sentAt = '2026-03-29T21:30:00.000Z';
    const today = parseTelegramText(message('today €10 cash groceries', sentAt));
    expect(today).toMatchObject({
      confidence: 'high',
      proposal: { economicDate: '2026-03-30', effectiveAt: sentAt },
    });
    const yesterday = parseTelegramText(message('yesterday €10 cash groceries', sentAt));
    expect(yesterday).toMatchObject({
      confidence: 'high',
      proposal: { economicDate: '2026-03-29', effectiveAt: '2026-03-29T09:00:00.000Z' },
    });
  });

  it('parses a reply correction only with one field', () => {
    const input = { ...message('actually €15'), replyToMessageId: 99n };
    const result = parseTelegramText(input);
    expect(result).toMatchObject({
      confidence: 'high',
      proposal: { kind: 'correction', patch: { field: 'amount', amountMinor: 1_500n } },
    });
  });

  it.each([
    ['date 2026-09-15', { field: 'date', economicDate: '2026-09-15' }],
    ['category groceries', { field: 'category', category: 'groceries' }],
    ['side hustle', { field: 'income_source', source: 'side_hustle' }],
    ['другое', { field: 'income_source', source: 'other' }],
    ['cancel', { field: 'cancel' }],
  ])('parses the single correction field in %s', (text, patch) => {
    const result = parseTelegramText({ ...message(text), replyToMessageId: 99n });
    expect(result).toMatchObject({
      confidence: 'high',
      proposal: { kind: 'correction', patch },
    });
  });

  it('rejects a reply that attempts to change multiple fields', () => {
    expect(
      parseTelegramText({
        ...message('actually €15 category groceries'),
        replyToMessageId: 99n,
      }),
    ).toMatchObject({ confidence: 'unsupported', reason: 'invalid_correction' });
  });

  it('merges amount, source, intent, and future-date clarifications', () => {
    const missingIncomeAmount = parseTelegramText(message('received cash'));
    expect(missingIncomeAmount.confidence).toBe('needs_clarification');
    if (missingIncomeAmount.confidence !== 'needs_clarification') return;
    const withAmount = mergeClarification(missingIncomeAmount.draft, message('75'));
    expect(withAmount).toMatchObject({
      confidence: 'needs_clarification',
      missingField: 'income_source',
      draft: { amountMinor: '7500' },
    });
    if (withAmount.confidence !== 'needs_clarification') return;
    expect(mergeClarification(withAmount.draft, message('side hustle'))).toMatchObject({
      confidence: 'high',
      proposal: { kind: 'cash_income', amountMinor: 7_500n, source: 'side_hustle' },
    });

    const unknown = parseTelegramText(message('12.50'));
    expect(unknown.confidence).toBe('needs_clarification');
    if (unknown.confidence !== 'needs_clarification') return;
    expect(mergeClarification(unknown.draft, message('expense groceries'))).toMatchObject({
      confidence: 'high',
      proposal: { kind: 'cash_expense', amountMinor: 1_250n, category: 'groceries' },
    });

    const future = parseTelegramText(message('future expense Japan €1500 by'));
    expect(future.confidence).toBe('needs_clarification');
    if (future.confidence !== 'needs_clarification') return;
    expect(mergeClarification(future.draft, message('2027-05-01'))).toMatchObject({
      confidence: 'high',
      proposal: { kind: 'future_expense', label: 'Japan', dueDate: '2027-05-01' },
    });
  });
});
