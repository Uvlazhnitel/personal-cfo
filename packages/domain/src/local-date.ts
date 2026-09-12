import { DomainValidationError } from './errors.js';

declare const localDateBrand: unique symbol;

export type LocalDate = string & { readonly [localDateBrand]: true };

const LOCAL_DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

export function parseLocalDate(value: unknown): LocalDate {
  if (typeof value !== 'string' || !LOCAL_DATE_PATTERN.test(value)) {
    throw new DomainValidationError(
      'date.invalid_format',
      'LocalDate must use the exact YYYY-MM-DD format.',
    );
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new DomainValidationError(
      'date.invalid_value',
      'LocalDate is not a valid calendar date.',
    );
  }

  return value as LocalDate;
}

export function serializeLocalDate(date: LocalDate): string {
  return date;
}
