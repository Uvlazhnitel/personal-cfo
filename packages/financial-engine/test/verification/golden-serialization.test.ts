import { describe, expect, it } from 'vitest';

import { Decimal } from 'decimal.js';

import { evaluateFinancialState } from '../../src/index.js';
import { buildSyntheticScenario } from '../fixtures/stage3/synthetic-scenarios.js';
import goldenText from '../golden/healthy-current.stage2g1.json?raw';
import { serializeGolden } from './golden-serialization.js';

describe('Stage 4 canonical golden serialization', () => {
  it('matches the complete healthy-current Stage 2G.1 result byte for byte', () => {
    const result = evaluateFinancialState(buildSyntheticScenario('healthy_current'));
    expect(serializeGolden(result)).toBe(goldenText);
  });

  it('sorts object keys, preserves arrays, and renders bigint as decimal strings', () => {
    expect(serializeGolden({ z: 2n, a: ['second', 'first'] })).toBe(
      '{\n  "a": [\n    "second",\n    "first"\n  ],\n  "z": "2"\n}\n',
    );
  });

  it.each([
    undefined,
    () => undefined,
    Symbol('unsupported'),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    new Date('2026-09-14T08:00:00Z'),
    new Map(),
    new Set(),
    new Decimal('0.05'),
  ])('rejects unsupported value %#', (value) => {
    expect(() => serializeGolden({ value })).toThrowError(TypeError);
  });

  it('rejects cyclic structures', () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeGolden(cyclic)).toThrowError(TypeError);
  });
});
