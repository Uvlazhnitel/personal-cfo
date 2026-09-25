import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

import { DataInvariantError } from './errors.js';

export type PortfolioReceiptKey = Uint8Array & {
  readonly __portfolioReceiptKey: unique symbol;
};

export type ProviderDataKey = Uint8Array & {
  readonly __providerDataKey: unique symbol;
};

export function parsePortfolioReceiptKey(
  value: string,
  environmentName = 'PORTFOLIO_RAW_RECEIPT_KEY',
): PortfolioReceiptKey {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new DataInvariantError(
      'portfolio.invalid_receipt_key',
      `${environmentName} must be a base64-encoded 32-byte key.`,
    );
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new DataInvariantError(
      'portfolio.invalid_receipt_key',
      `${environmentName} must be a base64-encoded 32-byte key.`,
    );
  }
  return Uint8Array.from(decoded) as PortfolioReceiptKey;
}

export function parseProviderDataKey(
  value: string,
  environmentName = 'PROVIDER_DATA_KEY',
): ProviderDataKey {
  return parsePortfolioReceiptKey(value, environmentName) as unknown as ProviderDataKey;
}

export function deriveProviderSubkey(
  key: ProviderDataKey,
  purpose: 'receipt-v1' | 'session-v1',
): PortfolioReceiptKey {
  return new Uint8Array(
    hkdfSync('sha256', key, Buffer.from('personal-cfo-provider-data-v1'), purpose, 32),
  ) as PortfolioReceiptKey;
}

export function encryptPortfolioPayload(payload: string, key: PortfolioReceiptKey) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  });
}

export function decryptPortfolioPayload(
  ciphertext: string,
  iv: string,
  authTag: string,
  key: PortfolioReceiptKey,
  providerLabel: string,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DataInvariantError(
      'portfolio.receipt_decryption_failed',
      `${providerLabel} raw receipt could not be decrypted.`,
    );
  }
}

export function encryptProviderPayload(
  payload: string,
  key: PortfolioReceiptKey,
  authenticatedMetadata: string,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(authenticatedMetadata, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  return Object.freeze({
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  });
}

export function decryptProviderPayload(
  ciphertext: string,
  iv: string,
  authTag: string,
  key: PortfolioReceiptKey,
  authenticatedMetadata: string,
  providerLabel: string,
): string {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(authenticatedMetadata, 'utf8'));
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new DataInvariantError(
      'provider.receipt_decryption_failed',
      `${providerLabel} encrypted value could not be decrypted.`,
    );
  }
}
