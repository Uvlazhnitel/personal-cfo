import { DomainValidationError } from './errors.js';
import { parseLocalDate } from './local-date.js';

declare const instantBrand: unique symbol;

export type Instant = string & { readonly [instantBrand]: true };

const INSTANT_PATTERN =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.([0-9]{1,6}))?Z$/u;

export function parseInstant(value: unknown): Instant {
  if (typeof value !== 'string') {
    throw new DomainValidationError('instant.invalid_format', 'Instant must be a UTC string.');
  }

  const match = INSTANT_PATTERN.exec(value);
  if (match === null) {
    throw new DomainValidationError(
      'instant.invalid_format',
      'Instant must use YYYY-MM-DDTHH:mm:ss[.ffffff]Z with explicit UTC.',
    );
  }

  parseLocalDate(value.slice(0, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));

  if (hour > 23 || minute > 59 || second > 59) {
    throw new DomainValidationError(
      'instant.invalid_value',
      'Instant contains an invalid UTC time.',
    );
  }

  const fraction = match[1]?.replace(/0+$/u, '') ?? '';
  const canonical = `${value.slice(0, 19)}${fraction.length > 0 ? `.${fraction}` : ''}Z`;
  return canonical as Instant;
}

export function serializeInstant(instant: Instant): string {
  return instant;
}
