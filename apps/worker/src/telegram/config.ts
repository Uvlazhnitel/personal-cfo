import { createHash } from 'node:crypto';
import { parseDomainId } from '@personal-cfo/domain';

export type TelegramConfiguration =
  | Readonly<{ enabled: false }>
  | Readonly<{
      enabled: true;
      token: string;
      sourceKey: string;
      allowedUserId: bigint;
      ownerId: string;
    }>;

export function telegramConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): TelegramConfiguration {
  const configured = (name: string) => {
    const value = environment[name]?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  };
  const token = configured('TELEGRAM_BOT_TOKEN');
  const allowed = configured('TELEGRAM_ALLOWED_USER_ID');
  const owner = configured('TELEGRAM_OWNER_ID');
  if (token === undefined && allowed === undefined && owner === undefined) {
    return Object.freeze({ enabled: false });
  }
  if (token === undefined || allowed === undefined || owner === undefined) {
    throw new Error(
      'TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, and TELEGRAM_OWNER_ID must be set together.',
    );
  }
  const tokenMatch = /^(\d+):[A-Za-z0-9_-]{20,}$/u.exec(token);
  if (tokenMatch === null) throw new Error('TELEGRAM_BOT_TOKEN is invalid.');
  if (!/^[1-9]\d{0,15}$/u.test(allowed)) throw new Error('TELEGRAM_ALLOWED_USER_ID is invalid.');
  const allowedUserId = BigInt(allowed);
  if (allowedUserId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('TELEGRAM_ALLOWED_USER_ID exceeds Telegram safe-integer bounds.');
  }
  parseDomainId(owner, 'owner');
  return Object.freeze({
    enabled: true,
    token,
    sourceKey: createHash('sha256').update(tokenMatch[1]!).digest('hex'),
    allowedUserId,
    ownerId: owner,
  });
}
