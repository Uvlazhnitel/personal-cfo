import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  enableBankingConfiguration,
  enableBankingScheduleConfiguration,
} from '../src/enable-banking/config.js';

const temporaryDirectories: string[] = [];

async function privateKeyFile(mode = 0o600): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'personal-cfo-enable-banking-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'application.pem');
  await writeFile(path, 'synthetic-test-key');
  await chmod(path, mode);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('Enable Banking server-only configuration', () => {
  it('requires complete configuration only when the manual command is invoked', async () => {
    await expect(enableBankingConfiguration({})).rejects.toThrow(
      'ENABLE_BANKING_APPLICATION_ID is required',
    );
  });

  it('loads an external mode-0600 key and exact 32-byte data key', async () => {
    const path = await privateKeyFile();
    await expect(
      enableBankingConfiguration({
        ENABLE_BANKING_APPLICATION_ID: 'application-id',
        ENABLE_BANKING_PRIVATE_KEY_PATH: path,
        ENABLE_BANKING_OWNER_ID: '018f0000-0000-7000-8000-000000000810',
        ENABLE_BANKING_REDIRECT_URL:
          'http://127.0.0.1:8080/api/v1/open-banking/enable-banking/callback',
        ENABLE_BANKING_DATA_KEY: Buffer.alloc(32, 12).toString('base64'),
      }),
    ).resolves.toMatchObject({
      applicationId: 'application-id',
      privateKeyPem: 'synthetic-test-key',
      baseUrl: 'https://api.enablebanking.com',
      canonicalImportEnabled: false,
    });
  });

  it('keeps daily synchronization disabled by default and validates schedule settings', () => {
    expect(enableBankingScheduleConfiguration({})).toEqual({
      enabled: false,
      cron: '15 3 * * *',
      timeZone: 'Europe/Riga',
    });
    expect(
      enableBankingScheduleConfiguration({
        ENABLE_BANKING_SYNC_ENABLED: 'true',
        ENABLE_BANKING_SYNC_CRON: '0 4 * * *',
        ENABLE_BANKING_SYNC_TIME_ZONE: 'UTC',
      }),
    ).toEqual({ enabled: true, cron: '0 4 * * *', timeZone: 'UTC' });
    expect(() =>
      enableBankingScheduleConfiguration({ ENABLE_BANKING_SYNC_ENABLED: 'yes' }),
    ).toThrow('true or false');
    expect(() => enableBankingScheduleConfiguration({ ENABLE_BANKING_SYNC_CRON: '* * *' })).toThrow(
      'five cron fields',
    );
    expect(() =>
      enableBankingScheduleConfiguration({ ENABLE_BANKING_SYNC_TIME_ZONE: 'Not/AZone' }),
    ).toThrow('invalid');
  });

  it('rejects permissive key files, partial data keys, and remote HTTP origins', async () => {
    const path = await privateKeyFile(0o644);
    const base = {
      ENABLE_BANKING_APPLICATION_ID: 'application-id',
      ENABLE_BANKING_PRIVATE_KEY_PATH: path,
      ENABLE_BANKING_OWNER_ID: '018f0000-0000-7000-8000-000000000810',
      ENABLE_BANKING_REDIRECT_URL:
        'https://cfo.example/api/v1/open-banking/enable-banking/callback',
      ENABLE_BANKING_DATA_KEY: Buffer.alloc(32, 12).toString('base64'),
    };
    await expect(enableBankingConfiguration(base)).rejects.toThrow('mode-0600');
    await chmod(path, 0o600);
    await expect(
      enableBankingConfiguration({
        ...base,
        ENABLE_BANKING_DATA_KEY: Buffer.alloc(31).toString('base64'),
      }),
    ).rejects.toThrow('base64-encoded 32-byte key');
    await expect(
      enableBankingConfiguration({ ...base, ENABLE_BANKING_API_BASE_URL: 'http://bank.example' }),
    ).rejects.toThrow('HTTPS');
  });
});
