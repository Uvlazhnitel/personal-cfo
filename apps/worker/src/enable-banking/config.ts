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
  canonicalImportEnabled?: boolean;
}>;

export type EnableBankingScheduleConfiguration = Readonly<{
  enabled: boolean;
  cron: string;
  timeZone: string;
}>;

function booleanFlag(environment: NodeJS.ProcessEnv, name: string): boolean {
  const value = environment[name]?.trim().toLocaleLowerCase('en') ?? 'false';
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

export function enableBankingScheduleConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): EnableBankingScheduleConfiguration {
  const cron = environment['ENABLE_BANKING_SYNC_CRON']?.trim() || '15 3 * * *';
  if (cron.split(/\s+/u).length !== 5) {
    throw new Error('ENABLE_BANKING_SYNC_CRON must contain five cron fields.');
  }
  const timeZone = environment['ENABLE_BANKING_SYNC_TIME_ZONE']?.trim() || 'Europe/Riga';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(new Date());
  } catch {
    throw new Error('ENABLE_BANKING_SYNC_TIME_ZONE is invalid.');
  }
  return Object.freeze({
    enabled: booleanFlag(environment, 'ENABLE_BANKING_SYNC_ENABLED'),
    cron,
    timeZone,
  });
}

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
    canonicalImportEnabled: booleanFlag(environment, 'ENABLE_BANKING_CANONICAL_IMPORT_ENABLED'),
  });
}
