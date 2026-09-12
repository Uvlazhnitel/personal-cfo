import type { CurrencyCode } from './currency.js';
import { parseCurrencyCode, serializeCurrencyCode } from './currency.js';
import { CurrencyMismatchError, DomainValidationError, MoneyOverflowError } from './errors.js';
import { expectExactKeys, expectRecord } from './validation.js';

export const MIN_MONEY_MINOR = -9_223_372_036_854_775_808n;
export const MAX_MONEY_MINOR = 9_223_372_036_854_775_807n;

export type Money = Readonly<{
  amountMinor: bigint;
  currency: CurrencyCode;
}>;

export type MoneyDto = Readonly<{
  amountMinor: string;
  currency: string;
}>;

export type MoneySign = -1 | 0 | 1;
export type MoneyComparison = -1 | 0 | 1;

const MINOR_UNITS_PATTERN = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/u;

function validateAmountMinor(value: unknown): bigint {
  if (typeof value !== 'bigint') {
    throw new DomainValidationError('money.invalid_amount', 'Money amountMinor must be a bigint.');
  }

  if (value < MIN_MONEY_MINOR || value > MAX_MONEY_MINOR) {
    throw new MoneyOverflowError();
  }

  return value;
}

function requireSameCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new CurrencyMismatchError(left.currency, right.currency);
  }
}

export function createMoney(amountMinor: bigint, currency: CurrencyCode): Money;
export function createMoney(amountMinor: unknown, currency: unknown): Money {
  return Object.freeze({
    amountMinor: validateAmountMinor(amountMinor),
    currency: parseCurrencyCode(currency),
  });
}

export function addMoney(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return createMoney(left.amountMinor + right.amountMinor, left.currency);
}

export function subtractMoney(left: Money, right: Money): Money {
  requireSameCurrency(left, right);
  return createMoney(left.amountMinor - right.amountMinor, left.currency);
}

export function compareMoney(left: Money, right: Money): MoneyComparison {
  requireSameCurrency(left, right);

  if (left.amountMinor < right.amountMinor) return -1;
  if (left.amountMinor > right.amountMinor) return 1;
  return 0;
}

export function moneySign(money: Money): MoneySign {
  if (money.amountMinor < 0n) return -1;
  if (money.amountMinor > 0n) return 1;
  return 0;
}

export function isZeroMoney(money: Money): boolean {
  return money.amountMinor === 0n;
}

export function parseMoneyDto(value: unknown): Money {
  const dto = expectRecord(value, 'MoneyDto');
  expectExactKeys(dto, ['amountMinor', 'currency'], 'MoneyDto');

  if (typeof dto['amountMinor'] !== 'string' || !MINOR_UNITS_PATTERN.test(dto['amountMinor'])) {
    throw new DomainValidationError(
      'money.invalid_dto_amount',
      'MoneyDto amountMinor must be a canonical base-10 integer string.',
    );
  }

  return createMoney(BigInt(dto['amountMinor']), parseCurrencyCode(dto['currency']));
}

export function serializeMoney(money: Money): MoneyDto {
  return Object.freeze({
    amountMinor: money.amountMinor.toString(),
    currency: serializeCurrencyCode(money.currency),
  });
}
