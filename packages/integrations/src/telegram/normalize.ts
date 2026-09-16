import { createHash } from 'node:crypto';

import type { TelegramMessage } from './types.js';

export type NormalizedTelegramUpdate =
  | Readonly<{ kind: 'message'; message: TelegramMessage }>
  | Readonly<{
      kind: 'ignored';
      updateId: bigint;
      reason: string;
      chatId: bigint | null;
      senderId: bigint | null;
      messageId: bigint | null;
    }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeInteger(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
}

function ignored(
  updateId: bigint,
  reason: string,
  message: Record<string, unknown> | null = null,
): NormalizedTelegramUpdate {
  const chat = record(message?.['chat']);
  const sender = record(message?.['from']);
  return Object.freeze({
    kind: 'ignored',
    updateId,
    reason,
    chatId: safeInteger(chat?.['id']),
    senderId: safeInteger(sender?.['id']),
    messageId: safeInteger(message?.['message_id']),
  });
}

export function normalizeTelegramUpdate(value: unknown): NormalizedTelegramUpdate {
  const update = record(value);
  const updateId = safeInteger(update?.['update_id']);
  if (update === null || updateId === null) {
    throw new Error('Telegram update has no valid update_id.');
  }
  if (update['edited_message'] !== undefined) {
    return ignored(updateId, 'edited_message', record(update['edited_message']));
  }
  const message = record(update['message']);
  if (message === null) return ignored(updateId, 'unsupported_update');
  const chat = record(message['chat']);
  const sender = record(message['from']);
  const messageId = safeInteger(message['message_id']);
  const chatId = safeInteger(chat?.['id']);
  const senderId = safeInteger(sender?.['id']);
  const unixSeconds = safeInteger(message['date']);
  if (
    chat === null ||
    sender === null ||
    messageId === null ||
    chatId === null ||
    senderId === null ||
    unixSeconds === null ||
    typeof chat['type'] !== 'string'
  ) {
    return ignored(updateId, 'invalid_message', message);
  }
  const chatType = chat['type'];
  if (!['private', 'group', 'supergroup', 'channel'].includes(chatType)) {
    return ignored(updateId, 'invalid_chat_type', message);
  }
  if (typeof sender['is_bot'] !== 'boolean') return ignored(updateId, 'invalid_sender', message);
  const text = message['text'];
  if (typeof text !== 'string') return ignored(updateId, 'non_text_message', message);
  const normalized = text
    .normalize('NFKC')
    .replace(/[\t\r\n ]+/gu, ' ')
    .trim();
  const reply = record(message['reply_to_message']);
  const replyMessageId = safeInteger(reply?.['message_id']);
  const hasRussian = /[А-Яа-яЁё]/u.test(normalized);
  const hasEnglish = /[A-Za-z]/u.test(normalized);
  const locale = hasRussian ? 'ru' : 'en';
  return Object.freeze({
    kind: 'message',
    message: Object.freeze({
      updateId,
      chatId,
      senderId,
      messageId,
      sentAt: new Date(Number(unixSeconds) * 1000).toISOString(),
      text: normalized,
      textHash: createHash('sha256').update(normalized).digest('hex'),
      locale,
      localeDetected: hasRussian || hasEnglish,
      chatType: chatType as TelegramMessage['chatType'],
      senderIsBot: sender['is_bot'],
      forwarded: message['forward_origin'] !== undefined || message['forward_date'] !== undefined,
      replyToMessageId: replyMessageId,
    }),
  });
}
