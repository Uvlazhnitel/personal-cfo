import { describe, expect, it } from 'vitest';

import {
  DataInvariantError,
  decodeSourceJson,
  encodeSourceJson,
  normalizeSnapshotJson,
} from '../src/index.js';

describe('persistent JSON codecs', () => {
  it('round-trips bigint source values and sorts object keys', () => {
    const encoded = encodeSourceJson({ z: 9_007_199_254_740_993n, a: 'value' });
    expect(Object.keys(encoded as object)).toEqual(['a', 'z']);
    expect(decodeSourceJson(encoded)).toEqual({ a: 'value', z: 9_007_199_254_740_993n });
  });

  it('normalizes snapshot bigint values to decimal strings', () => {
    expect(normalizeSnapshotJson({ amount: 9_007_199_254_740_993n })).toEqual({
      amount: '9007199254740993',
    });
  });

  it.each([new Date(), new Map(), new Set(), () => undefined, Symbol('x'), undefined])(
    'rejects unsafe snapshot value %#',
    (value) => expect(() => normalizeSnapshotJson({ value })).toThrow(DataInvariantError),
  );

  it('rejects cycles', () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => normalizeSnapshotJson(value)).toThrow('Snapshot cycles are forbidden.');
  });
});
