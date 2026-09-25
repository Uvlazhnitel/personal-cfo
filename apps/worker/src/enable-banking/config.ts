import { readFile, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { parseEnableBankingDataKey } from '@personal-cfo/data';
import type { EnableBankingDataKey } from '@personal-cfo/data';
import { parseDomainId } from '@personal-cfo/domain';

export type EnableBankingConfiguration = Readonly<{
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

function validateUrl(value: string, label: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowLoopbackHttp && loopback && url.protocol === 'http:')) {
    throw new Error(`${label} must use HTTPS except on loopback.`);
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error(`${label} cannot contain credentials, a query, or a fragment.`);
  }
  return url.toString();
}

export async function enableBankingConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EnableBankingConfiguration> {
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
  const privateKeyPem = await readFile(privateKeyPath, 'utf8');
  const ownerId = parseDomainId(required(environment, 'ENABLE_BANKING_OWNER_ID'), 'owner');
  const redirectUrl = validateUrl(
    required(environment, 'ENABLE_BANKING_REDIRECT_URL'),
    'ENABLE_BANKING_REDIRECT_URL',
    true,
  );
  const dataKey = parseEnableBankingDataKey(required(environment, 'ENABLE_BANKING_DATA_KEY'));
  const baseUrl = validateUrl(
    environment['ENABLE_BANKING_API_BASE_URL']?.trim() || 'https://api.enablebanking.com',
    'ENABLE_BANKING_API_BASE_URL',
    true,
  ).replace(/\/$/u, '');
  return Object.freeze({
    applicationId,
    privateKeyPem,
    ownerId,
    redirectUrl,
    dataKey,
    baseUrl,
  });
}
