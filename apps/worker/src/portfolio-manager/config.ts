import { createHash } from 'node:crypto';

import { parsePortfolioManagerReceiptKey } from '@personal-cfo/data';
import type { PortfolioManagerReceiptKey } from '@personal-cfo/data';
import { parseDomainId } from '@personal-cfo/domain';

export type PortfolioManagerConfiguration = Readonly<{
  baseUrl: string;
  apiToken: string;
  ownerId: string;
  investmentAccountId: string;
  receiptKey: PortfolioManagerReceiptKey;
  connectionId: string;
}>;

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('PORTFOLIO_MANAGER_BASE_URL cannot include credentials, query, or fragment.');
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('PORTFOLIO_MANAGER_BASE_URL must use HTTPS except on loopback.');
  }
  return url.toString().replace(/\/$/u, '');
}

export function portfolioManagerConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): PortfolioManagerConfiguration {
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
    return value;
  };
  const baseUrl = normalizeBaseUrl(required('PORTFOLIO_MANAGER_BASE_URL'));
  const apiToken = required('PORTFOLIO_MANAGER_API_TOKEN');
  if (/\s/u.test(apiToken)) throw new Error('PORTFOLIO_MANAGER_API_TOKEN is invalid.');
  const ownerId = parseDomainId(required('PORTFOLIO_MANAGER_OWNER_ID'), 'owner');
  const investmentAccountId = parseDomainId(
    required('PORTFOLIO_MANAGER_INVESTMENT_ACCOUNT_ID'),
    'account',
  );
  const receiptKey = parsePortfolioManagerReceiptKey(required('PORTFOLIO_MANAGER_RAW_RECEIPT_KEY'));
  const connectionId = createHash('sha256').update(`portfolio-manager:${baseUrl}`).digest('hex');
  return Object.freeze({
    baseUrl,
    apiToken,
    ownerId,
    investmentAccountId,
    receiptKey,
    connectionId,
  });
}
