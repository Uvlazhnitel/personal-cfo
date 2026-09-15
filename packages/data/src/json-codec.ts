import { DataInvariantError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

const BIGINT_TAG = '$personalCfoBigInt';

function compareKeys(left: readonly [string, unknown], right: readonly [string, unknown]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
}

function encodeSource(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Object.freeze({ [BIGINT_TAG]: value.toString() });
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DataInvariantError(
        'json.unsafe_number',
        'Source JSON accepts only safe integer numbers.',
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new DataInvariantError(
      'json.unsupported_value',
      `Unsupported JSON value: ${typeof value}.`,
    );
  }
  if (value instanceof Date || value instanceof Map || value instanceof Set) {
    throw new DataInvariantError(
      'json.unsupported_class',
      'Date, Map, and Set values are forbidden.',
    );
  }
  if (seen.has(value)) throw new DataInvariantError('json.cycle', 'Cyclic values are forbidden.');
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) {
    throw new DataInvariantError('json.unsupported_class', 'Class instances are forbidden.');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => encodeSource(item, seen)));
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(compareKeys)
          .map(([key, item]) => {
            if (item === undefined) {
              throw new DataInvariantError('json.undefined', 'Undefined values are forbidden.');
            }
            return [key, encodeSource(item, seen)];
          }),
      ),
    );
  } finally {
    seen.delete(value);
  }
}

export function encodeSourceJson(value: unknown): JsonValue {
  return encodeSource(value, new Set());
}

export function decodeSourceJson(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  )
    return value;
  if (Array.isArray(value)) return Object.freeze(value.map(decodeSourceJson));
  if (typeof value !== 'object')
    throw new DataInvariantError('json.invalid_source', 'Invalid source JSON.');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record[BIGINT_TAG] === 'string') {
    if (!/^(0|-?[1-9][0-9]*)$/u.test(record[BIGINT_TAG])) {
      throw new DataInvariantError('json.invalid_bigint', 'Invalid tagged bigint.');
    }
    return BigInt(record[BIGINT_TAG]);
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record)
        .sort(compareKeys)
        .map(([key, item]) => [key, decodeSourceJson(item)]),
    ),
  );
}

function normalizeSnapshot(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new DataInvariantError(
        'snapshot.unsafe_number',
        'Snapshot numbers must be safe integers.',
      );
    return value;
  }
  if (typeof value !== 'object')
    throw new DataInvariantError(
      'snapshot.unsupported_value',
      `Unsupported snapshot value: ${typeof value}.`,
    );
  if (value instanceof Date || value instanceof Map || value instanceof Set)
    throw new DataInvariantError(
      'snapshot.unsupported_class',
      'Snapshot class instances are forbidden.',
    );
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value))
    throw new DataInvariantError(
      'snapshot.unsupported_class',
      'Snapshot class instances are forbidden.',
    );
  if (seen.has(value))
    throw new DataInvariantError('snapshot.cycle', 'Snapshot cycles are forbidden.');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return Object.freeze(value.map((item) => normalizeSnapshot(item, seen)));
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value)
          .sort(compareKeys)
          .map(([key, item]) => {
            if (item === undefined)
              throw new DataInvariantError(
                'snapshot.undefined',
                'Undefined snapshot values are forbidden.',
              );
            return [key, normalizeSnapshot(item, seen)];
          }),
      ),
    );
  } finally {
    seen.delete(value);
  }
}

export function normalizeSnapshotJson(value: unknown): JsonValue {
  return normalizeSnapshot(value, new Set());
}

export function stringifySnapshot(value: unknown): string {
  return `${JSON.stringify(normalizeSnapshotJson(value), null, 2)}\n`;
}
