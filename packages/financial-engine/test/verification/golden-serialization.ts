type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function normalize(value: unknown, ancestors: Set<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString(10);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('Golden numbers must be finite safe integers.');
    }
    return value;
  }
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Golden value contains unsupported ${typeof value}.`);
  }
  if (typeof value !== 'object') throw new TypeError('Golden value is not serializable.');
  if (ancestors.has(value)) throw new TypeError('Golden value contains a cycle.');

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalize(item, ancestors));

    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Golden value contains a class instance.');
    }

    const normalized: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalize((value as Record<string, unknown>)[key], ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function serializeGolden(value: unknown): string {
  return `${JSON.stringify(normalize(value, new Set()), null, 2)}\n`;
}
