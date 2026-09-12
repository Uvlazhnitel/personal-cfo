import { describe, expect, it } from 'vitest';

import {
  CurrencyMismatchError,
  EUR,
  MAX_MONEY_MINOR,
  MIN_MONEY_MINOR,
  MoneyOverflowError,
  addMoney,
  compareMoney,
  createMoney,
  isZeroMoney,
  moneySign,
  parseCurrencyCode,
  parseMoneyDto,
  serializeMoney,
  subtractMoney,
} from '../src/index.js';

describe('Money', () => {
  it('creates an immutable exact amount', () => {
    const value = createMoney(12_345n, EUR);

    expect(value).toEqual({ amountMinor: 12_345n, currency: 'EUR' });
    expect(Object.isFrozen(value)).toBe(true);
  });

  it.each([
    [-42n, -1],
    [0n, 0],
    [42n, 1],
  ] as const)('reports the sign of %s explicitly', (amountMinor, expectedSign) => {
    const value = createMoney(amountMinor, EUR);

    expect(moneySign(value)).toBe(expectedSign);
    expect(isZeroMoney(value)).toBe(expectedSign === 0);
  });

  it('adds and subtracts without passing through JavaScript number', () => {
    const beyondSafeInteger = createMoney(9_007_199_254_740_993n, EUR);
    const one = createMoney(1n, EUR);

    expect(addMoney(beyondSafeInteger, one).amountMinor).toBe(9_007_199_254_740_994n);
    expect(subtractMoney(beyondSafeInteger, one).amountMinor).toBe(9_007_199_254_740_992n);
  });

  it('compares exact values', () => {
    const low = createMoney(-1n, EUR);
    const high = createMoney(1n, EUR);

    expect(compareMoney(low, high)).toBe(-1);
    expect(compareMoney(high, low)).toBe(1);
    expect(compareMoney(low, createMoney(-1n, EUR))).toBe(0);
  });

  it('rejects arithmetic and comparison across currencies', () => {
    const eur = createMoney(100n, EUR);
    const usd = createMoney(100n, parseCurrencyCode('USD'));

    expect(() => addMoney(eur, usd)).toThrowError(CurrencyMismatchError);
    expect(() => subtractMoney(eur, usd)).toThrowError(CurrencyMismatchError);
    expect(() => compareMoney(eur, usd)).toThrowError(CurrencyMismatchError);
  });

  it('accepts the full signed PostgreSQL BIGINT range', () => {
    expect(createMoney(MIN_MONEY_MINOR, EUR).amountMinor).toBe(MIN_MONEY_MINOR);
    expect(createMoney(MAX_MONEY_MINOR, EUR).amountMinor).toBe(MAX_MONEY_MINOR);
  });

  it('rejects construction and arithmetic outside signed PostgreSQL BIGINT', () => {
    expect(() => createMoney(MAX_MONEY_MINOR + 1n, EUR)).toThrowError(MoneyOverflowError);
    expect(() => createMoney(MIN_MONEY_MINOR - 1n, EUR)).toThrowError(MoneyOverflowError);
    expect(() => addMoney(createMoney(MAX_MONEY_MINOR, EUR), createMoney(1n, EUR))).toThrowError(
      MoneyOverflowError,
    );
    expect(() =>
      subtractMoney(createMoney(MIN_MONEY_MINOR, EUR), createMoney(1n, EUR)),
    ).toThrowError(MoneyOverflowError);
  });

  it('rejects a non-bigint constructor value at runtime', () => {
    expect(() => createMoney(100 as never, EUR)).toThrowError(/bigint/u);
  });

  it('round-trips bigint minor units through a string DTO', () => {
    const value = createMoney(-9_007_199_254_740_993n, EUR);
    const dto = serializeMoney(value);

    expect(dto).toEqual({ amountMinor: '-9007199254740993', currency: 'EUR' });
    expect(parseMoneyDto(dto)).toEqual(value);
    expect(Object.isFrozen(dto)).toBe(true);
  });

  it.each(['1.00', '+1', '01', '-0', '1e3', ' 1', '1 '])(
    'rejects non-canonical minor-unit string %j',
    (amountMinor) => {
      expect(() => parseMoneyDto({ amountMinor, currency: 'EUR' })).toThrowError();
    },
  );

  it('rejects non-string, non-canonical currency, and unexpected DTO fields', () => {
    expect(() => parseMoneyDto({ amountMinor: 100, currency: 'EUR' })).toThrowError();
    expect(() => parseMoneyDto({ amountMinor: '100', currency: 'eur' })).toThrowError();
    expect(() =>
      parseMoneyDto({ amountMinor: '100', currency: 'EUR', formatted: '€1.00' }),
    ).toThrowError();
  });
});
