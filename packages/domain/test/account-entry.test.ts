import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_ENTRY_ROLES,
  EUR,
  createAccountEntry,
  createMoney,
  moneySign,
  parseAccountEntryDto,
  parseAccountEntryRole,
  parseAccountId,
  parseEntryId,
  parseTransactionId,
  serializeAccountEntry,
} from '../src/index.js';

const entryId = parseEntryId('01890f3e-7b2c-7bb2-babc-222222222222');
const transactionId = parseTransactionId('01890f3e-7b2c-7aa1-8abc-111111111111');
const accountId = parseAccountId('01890f3e-7b2c-7cc2-98c4-dc0c0c07398f');

describe('AccountEntry', () => {
  it.each([
    [12_500n, 1],
    [-12_500n, -1],
  ] as const)('preserves the %s signed account-balance effect', (amountMinor, expectedSign) => {
    const entry = createAccountEntry({
      id: entryId,
      transactionId,
      accountId,
      amount: createMoney(amountMinor, EUR),
      role: 'external_flow',
    });

    expect(entry.amount.amountMinor).toBe(amountMinor);
    expect(moneySign(entry.amount)).toBe(expectedSign);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.amount)).toBe(true);
  });

  it.each(ACCOUNT_ENTRY_ROLES)('validates supported role %s', (role) => {
    expect(parseAccountEntryRole(role)).toBe(role);
  });

  it('rejects unsupported roles', () => {
    expect(() => parseAccountEntryRole('unresolved_transfer')).toThrowError();
  });

  it('round-trips exact money and typed IDs through its DTO', () => {
    const dto = {
      id: '01890f3e-7b2c-7bb2-babc-222222222222',
      transactionId: '01890f3e-7b2c-7aa1-8abc-111111111111',
      accountId: '01890f3e-7b2c-7cc2-98c4-dc0c0c07398f',
      amount: { amountMinor: '9007199254740993', currency: 'EUR' },
      role: 'opening_balance',
    };

    const entry = parseAccountEntryDto(dto);

    expect(entry.amount.amountMinor).toBe(9_007_199_254_740_993n);
    expect(serializeAccountEntry(entry)).toEqual(dto);
  });

  it('rejects malformed and extended DTOs', () => {
    expect(() => parseAccountEntryDto({})).toThrowError();
    expect(() =>
      parseAccountEntryDto({
        id: '01890f3e-7b2c-7bb2-babc-222222222222',
        transactionId: '01890f3e-7b2c-7aa1-8abc-111111111111',
        accountId: '01890f3e-7b2c-7cc2-98c4-dc0c0c07398f',
        amount: { amountMinor: '100', currency: 'EUR' },
        role: 'external_flow',
        provider: 'bank',
      }),
    ).toThrowError();
  });
});
