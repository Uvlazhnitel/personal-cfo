import { describe, expect, it } from 'vitest';

import type { Clock } from '../src/index.js';
import {
  parseInstant,
  parseLocalDate,
  serializeInstant,
  serializeLocalDate,
} from '../src/index.js';

describe('LocalDate', () => {
  it('round-trips a valid leap date deterministically', () => {
    const date = parseLocalDate('2024-02-29');

    expect(serializeLocalDate(date)).toBe('2024-02-29');
  });

  it.each(['2023-02-29', '2026-00-12', '2026-13-12', '2026-04-31', '0000-01-01'])(
    'rejects invalid calendar date %s',
    (value) => {
      expect(() => parseLocalDate(value)).toThrowError();
    },
  );

  it.each(['2026-1-01', '2026-01-1', '2026/01/01', ' 2026-01-01'])(
    'rejects non-canonical date %j',
    (value) => {
      expect(() => parseLocalDate(value)).toThrowError();
    },
  );
});

describe('Instant', () => {
  it('parses and serializes explicit UTC', () => {
    const instant = parseInstant('2026-09-13T14:05:06Z');

    expect(serializeInstant(instant)).toBe('2026-09-13T14:05:06Z');
  });

  it('canonicalizes PostgreSQL-compatible fractional precision', () => {
    expect(serializeInstant(parseInstant('2026-09-13T14:05:06.120000Z'))).toBe(
      '2026-09-13T14:05:06.12Z',
    );
    expect(serializeInstant(parseInstant('2026-09-13T14:05:06.000000Z'))).toBe(
      '2026-09-13T14:05:06Z',
    );
  });

  it.each([
    '2026-09-13T14:05:06',
    '2026-09-13T14:05:06+00:00',
    '2026-09-13 14:05:06Z',
    '2026-02-29T14:05:06Z',
    '2026-09-13T24:00:00Z',
    '2026-09-13T14:60:00Z',
    '2026-09-13T14:05:60Z',
    '2026-09-13T14:05:06.1234567Z',
  ])('rejects ambiguous or invalid instant %s', (value) => {
    expect(() => parseInstant(value)).toThrowError();
  });

  it('supports deterministic clocks without accessing system time', () => {
    const expected = parseInstant('2026-09-13T14:05:06Z');
    const clock: Clock = { now: () => expected };

    expect(clock.now()).toBe(expected);
  });
});
