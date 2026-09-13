import { DomainValidationError } from './errors.js';

declare const yearMonthBrand: unique symbol;

export type YearMonth = string & { readonly [yearMonthBrand]: true };

const YEAR_MONTH_PATTERN = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/u;

export function parseYearMonth(value: unknown): YearMonth {
  if (typeof value !== 'string' || !YEAR_MONTH_PATTERN.test(value) || value.startsWith('0000-')) {
    throw new DomainValidationError(
      'year_month.invalid',
      'YearMonth must be a Gregorian month in canonical YYYY-MM form for years 0001-9999.',
    );
  }
  return value as YearMonth;
}

export function yearMonthOf(date: string): YearMonth {
  return parseYearMonth(date.slice(0, 7));
}
