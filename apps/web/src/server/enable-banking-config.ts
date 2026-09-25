import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { parseEnableBankingDataKey } from '@personal-cfo/data';
import type { EnableBankingDataKey } from '@personal-cfo/data';
import { parseDomainId } from '@personal-cfo/domain';

export type EnableBankingWebConfiguration = Readonly<{
  applicationId: string;
  privateKeyPem: string;
  ownerId: string;
  redirectUrl: string;
  dataKey: EnableBankingDataKey;
  baseUrl: string;
}>;

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function secureUrl(value: string, label: string): string {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS except on loopback.`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} cannot contain credentials, a query, or a fragment.`);
  }
  return url.toString();
}

export async function enableBankingWebConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EnableBankingWebConfiguration> {
  const applicationId = required(environment, 'ENABLE_BANKING_APPLICATION_ID');
  if (/\s/u.test(applicationId)) throw new Error('ENABLE_BANKING_APPLICATION_ID is invalid.');
  const privateKeyPath = required(environment, 'ENABLE_BANKING_PRIVATE_KEY_PATH');
  if (!isAbsolute(privateKeyPath)) {
    throw new Error('ENABLE_BANKING_PRIVATE_KEY_PATH must be absolute.');
  }
  const metadata = await stat(privateKeyPath);
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('ENABLE_BANKING_PRIVATE_KEY_PATH must reference a mode-0600 file.');
  }
  const redirectUrl = secureUrl(
    required(environment, 'ENABLE_BANKING_REDIRECT_URL'),
    'ENABLE_BANKING_REDIRECT_URL',
  );
  const expectedCallbackPath = '/api/v1/open-banking/enable-banking/callback';
  if (new URL(redirectUrl).pathname !== expectedCallbackPath) {
    throw new Error(`ENABLE_BANKING_REDIRECT_URL must use ${expectedCallbackPath}.`);
  }
  return Object.freeze({
    applicationId,
    privateKeyPem: await readFile(privateKeyPath, 'utf8'),
    ownerId: parseDomainId(required(environment, 'ENABLE_BANKING_OWNER_ID'), 'owner'),
    redirectUrl,
    dataKey: parseEnableBankingDataKey(required(environment, 'ENABLE_BANKING_DATA_KEY')),
    baseUrl: secureUrl(
      environment['ENABLE_BANKING_API_BASE_URL']?.trim() || 'https://api.enablebanking.com',
      'ENABLE_BANKING_API_BASE_URL',
    ).replace(/\/$/u, ''),
  });
}
