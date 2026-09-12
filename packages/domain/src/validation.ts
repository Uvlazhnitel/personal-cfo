import { DomainValidationError } from './errors.js';

export function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DomainValidationError('dto.invalid_object', `${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

export function expectExactKeys(
  record: Readonly<Record<string, unknown>>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const expected = new Set(expectedKeys);
  const actualKeys = Object.keys(record);

  if (actualKeys.length !== expected.size || actualKeys.some((key) => !expected.has(key))) {
    throw new DomainValidationError(
      'dto.invalid_shape',
      `${label} must contain exactly: ${expectedKeys.join(', ')}.`,
    );
  }
}

export function expectNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new DomainValidationError(
      'value.invalid_string',
      `${label} must be a non-empty string without surrounding whitespace.`,
    );
  }

  return value;
}

export function parseStringEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== 'string' || !values.some((candidate) => candidate === value)) {
    throw new DomainValidationError(
      'value.invalid_enum',
      `${label} must be one of: ${values.join(', ')}.`,
    );
  }

  return value;
}
