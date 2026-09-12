import { describe, expect, it } from 'vitest';

import {
  COMPLETENESS_STATUSES,
  createMetricResult,
  parseBookingStatus,
  parseCompleteness,
  parseInstant,
} from '../src/index.js';

const base = {
  asOf: parseInstant('2026-09-13T14:05:06Z'),
  engineVersion: 'engine-v1',
  settingsVersion: 'settings-v1',
  inputWatermark: 'watermark-001',
  explanation: [{ ruleId: 'rule.cash', inputKey: 'liquid_cash', value: '700000' }],
  warnings: [{ code: 'source.stale', context: { source: 'cash' } }],
} as const;

describe('Completeness and booking status', () => {
  it.each(COMPLETENESS_STATUSES)('validates completeness state %s', (status) => {
    expect(parseCompleteness(status)).toBe(status);
  });

  it.each(['pending', 'booked', 'reversed'] as const)('validates booking status %s', (status) => {
    expect(parseBookingStatus(status)).toBe(status);
  });

  it('rejects unknown states', () => {
    expect(() => parseCompleteness('unknown')).toThrowError();
    expect(() => parseBookingStatus('settled')).toThrowError();
  });
});

describe('MetricResult', () => {
  it('requires and preserves a complete value', () => {
    const result = createMetricResult({ ...base, status: 'complete', value: 42n });

    expect(result.status).toBe('complete');
    expect(result.value).toBe(42n);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('supports partial results with or without a provisional value', () => {
    expect(createMetricResult<number>({ ...base, status: 'partial', value: 42 }).value).toBe(42);
    expect(
      createMetricResult<number>({ ...base, status: 'partial', value: null }).value,
    ).toBeNull();
  });

  it('requires unavailable results to contain null', () => {
    const result = createMetricResult<number>({ ...base, status: 'unavailable', value: null });

    expect(result).toMatchObject({ status: 'unavailable', value: null });
    expect(() =>
      createMetricResult<number>({ ...base, status: 'unavailable', value: 42 }),
    ).toThrowError(/cannot contain/u);
  });

  it('rejects complete results without a value', () => {
    expect(() =>
      createMetricResult<number>({ ...base, status: 'complete', value: null }),
    ).toThrowError(/must contain/u);
  });

  it('defensively freezes explanation and warning data', () => {
    const result = createMetricResult({ ...base, status: 'complete', value: 1n });

    expect(Object.isFrozen(result.explanation)).toBe(true);
    expect(Object.isFrozen(result.explanation[0])).toBe(true);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(Object.isFrozen(result.warnings[0])).toBe(true);
    expect(Object.isFrozen(result.warnings[0]?.context)).toBe(true);
  });

  it('rejects empty provenance and explanation identifiers', () => {
    expect(() =>
      createMetricResult({ ...base, engineVersion: '', status: 'complete', value: 1n }),
    ).toThrowError();
    expect(() =>
      createMetricResult({
        ...base,
        explanation: [{ ruleId: '', inputKey: 'cash', value: '1' }],
        status: 'complete',
        value: 1n,
      }),
    ).toThrowError();
  });
});
