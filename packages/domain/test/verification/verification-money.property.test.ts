import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  EUR,
  MAX_MONEY_MINOR,
  MIN_MONEY_MINOR,
  MoneyOverflowError,
  addMoney,
  createMoney,
  parseCurrencyCode,
  parseMoneyDto,
  serializeMoney,
  subtractMoney,
} from '../../src/index.js';

import { propertyOptions } from './property-options.js';

const SAFE_OPERAND_MIN = MIN_MONEY_MINOR / 2n;
const SAFE_OPERAND_MAX = MAX_MONEY_MINOR / 2n;

describe('Stage 4 Money properties', () => {
  it('preserves exact addition, subtraction, zero identity, and self subtraction', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: SAFE_OPERAND_MIN, max: SAFE_OPERAND_MAX }),
        fc.bigInt({ min: SAFE_OPERAND_MIN, max: SAFE_OPERAND_MAX }),
        (leftMinor, rightMinor) => {
          const left = createMoney(leftMinor, EUR);
          const right = createMoney(rightMinor, EUR);
          const zero = createMoney(0n, EUR);

          expect(addMoney(left, right).amountMinor).toBe(leftMinor + rightMinor);
          expect(subtractMoney(left, right).amountMinor).toBe(leftMinor - rightMinor);
          expect(addMoney(left, zero)).toEqual(left);
          expect(subtractMoney(left, left)).toEqual(zero);
        },
      ),
      propertyOptions(20_260_940, 200),
    );
  });

  it('round-trips every signed PostgreSQL BIGINT value through the canonical DTO', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: MIN_MONEY_MINOR, max: MAX_MONEY_MINOR }), (amountMinor) => {
        const value = createMoney(amountMinor, EUR);
        expect(parseMoneyDto(serializeMoney(value))).toEqual(value);
      }),
      propertyOptions(20_260_941, 200),
    );
  });

  it('rejects currency mixing for both arithmetic directions', () => {
    const eur = createMoney(1n, EUR);
    const usd = createMoney(1n, parseCurrencyCode('USD'));

    expect(() => addMoney(eur, usd)).toThrowError(CurrencyMismatchError);
    expect(() => subtractMoney(usd, eur)).toThrowError(CurrencyMismatchError);
  });

  it('rejects values and arithmetic outside the signed PostgreSQL BIGINT range', () => {
    expect(() => createMoney(MAX_MONEY_MINOR + 1n, EUR)).toThrowError(MoneyOverflowError);
    expect(() => createMoney(MIN_MONEY_MINOR - 1n, EUR)).toThrowError(MoneyOverflowError);
    expect(() => addMoney(createMoney(MAX_MONEY_MINOR, EUR), createMoney(1n, EUR))).toThrowError(
      MoneyOverflowError,
    );
    expect(() =>
      subtractMoney(createMoney(MIN_MONEY_MINOR, EUR), createMoney(1n, EUR)),
    ).toThrowError(MoneyOverflowError);
  });
});
