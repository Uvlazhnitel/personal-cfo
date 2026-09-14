import { DomainValidationError } from './errors.js';

declare const decimalRateBrand: unique symbol;

export type DecimalRate = string & { readonly [decimalRateBrand]: true };

const CANONICAL_DECIMAL = /^(?:0|-?(?:[1-9][0-9]*(?:\.[0-9]*[1-9])?|0\.[0-9]*[1-9]))$/u;

export function parseDecimalRate(value: unknown): DecimalRate {
  if (typeof value !== 'string' || !CANONICAL_DECIMAL.test(value)) {
    throw new DomainValidationError(
      'decimal_rate.invalid',
      'A decimal rate must be a canonical finite decimal string without exponent or padding.',
    );
  }
  return value as DecimalRate;
}

export function serializeDecimalRate(value: DecimalRate): string {
  return value;
}
