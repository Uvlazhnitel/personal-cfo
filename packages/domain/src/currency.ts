import { DomainValidationError } from './errors.js';

declare const currencyCodeBrand: unique symbol;
declare const currencyScaleBrand: unique symbol;

export type CurrencyCode = string & { readonly [currencyCodeBrand]: true };
export type CurrencyScale = number & { readonly [currencyScaleBrand]: true };

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/u;

export function parseCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== 'string' || !CURRENCY_CODE_PATTERN.test(value)) {
    throw new DomainValidationError(
      'currency.invalid_code',
      'Currency code must be exactly three uppercase ASCII letters.',
    );
  }

  return value as CurrencyCode;
}

export function serializeCurrencyCode(currency: CurrencyCode): string {
  return currency;
}

export const EUR = parseCurrencyCode('EUR');

const CURRENCY_SCALES: Readonly<Record<string, CurrencyScale>> = Object.freeze({
  EUR: 2 as CurrencyScale,
});

export function currencyScaleFor(currency: CurrencyCode): CurrencyScale | undefined {
  return CURRENCY_SCALES[currency];
}
