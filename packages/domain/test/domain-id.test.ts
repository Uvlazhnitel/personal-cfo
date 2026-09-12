import { describe, expect, it } from 'vitest';

import {
  parseAccountId,
  parseDomainId,
  parseEntryId,
  parseTransactionId,
  serializeDomainId,
} from '../src/index.js';

describe('DomainId', () => {
  it('validates UUIDv7 and normalizes its DTO form to lowercase', () => {
    const id = parseAccountId('01890F3E-7B2C-7CC2-98C4-DC0C0C07398F');

    expect(serializeDomainId(id)).toBe('01890f3e-7b2c-7cc2-98c4-dc0c0c07398f');
  });

  it('creates distinct reusable entity IDs', () => {
    expect(serializeDomainId(parseTransactionId('01890f3e-7b2c-7aa1-8abc-111111111111'))).toBe(
      '01890f3e-7b2c-7aa1-8abc-111111111111',
    );
    expect(serializeDomainId(parseEntryId('01890f3e-7b2c-7bb2-babc-222222222222'))).toBe(
      '01890f3e-7b2c-7bb2-babc-222222222222',
    );
    expect(serializeDomainId(parseDomainId('01890f3e-7b2c-7dd3-aabc-333333333333', 'fund'))).toBe(
      '01890f3e-7b2c-7dd3-aabc-333333333333',
    );
  });

  it.each([
    '',
    'not-a-uuid',
    '01890f3e-7b2c-4cc2-98c4-dc0c0c07398f',
    '01890f3e-7b2c-7cc2-78c4-dc0c0c07398f',
  ])('rejects malformed or non-v7 ID %j', (value) => {
    expect(() => parseAccountId(value)).toThrowError();
  });
});
