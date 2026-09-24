import { createHash } from 'node:crypto';

import { parseDomainId } from '@personal-cfo/domain';
import { parseSharesightReceiptKey } from '@personal-cfo/data';
import type { SharesightReceiptKey } from '@personal-cfo/data';

export type SharesightConfiguration = Readonly<{
  clientId: string;
  clientSecret: string;
  portfolioId: string;
  ownerId: string;
  investmentAccountId: string;
  receiptKey: SharesightReceiptKey;
  apiBaseUrl: string;
  connectionId: string;
}>;

export function sharesightConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): SharesightConfiguration {
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
  };
  const clientId = required('SHARESIGHT_CLIENT_ID');
  const clientSecret = required('SHARESIGHT_CLIENT_SECRET');
  const portfolioId = required('SHARESIGHT_PORTFOLIO_ID');
  if (!/^[1-9]\d*$/u.test(portfolioId)) {
    throw new Error('SHARESIGHT_PORTFOLIO_ID must be a positive decimal identifier.');
  }
  const ownerId = parseDomainId(required('SHARESIGHT_OWNER_ID'), 'owner');
  const investmentAccountId = parseDomainId(
    required('SHARESIGHT_INVESTMENT_ACCOUNT_ID'),
    'account',
  );
  const receiptKey = parseSharesightReceiptKey(required('SHARESIGHT_RAW_RECEIPT_KEY'));
  const apiBaseUrl = environment['SHARESIGHT_API_BASE_URL']?.trim() || 'https://api.sharesight.com';
  const connectionId = createHash('sha256')
    .update(`sharesight:${clientId}:${portfolioId}`)
    .digest('hex');
  return Object.freeze({
    clientId,
    clientSecret,
    portfolioId,
    ownerId,
    investmentAccountId,
    receiptKey,
    apiBaseUrl,
    connectionId,
  });
}
