import { describe, expect, it } from 'vitest';

import { localDateStartInstant } from '../src/decision-history-boundary.js';

describe('decision history local-date boundary', () => {
  it('converts the owner date to the exact Europe/Riga midnight instant', () => {
    expect(localDateStartInstant('2026-07-01', 'Europe/Riga')).toBe('2026-06-30T21:00:00Z');
    expect(localDateStartInstant('2026-01-01', 'Europe/Riga')).toBe('2025-12-31T22:00:00Z');
  });

  it.each(['2026-02-30', '2026-7-01', 'not-a-date'])(
    'rejects an invalid local date: %s',
    (value) => {
      expect(() => localDateStartInstant(value, 'Europe/Riga')).toThrow(
        expect.objectContaining({ code: 'decision_history.invalid_start_date' }),
      );
    },
  );
});
