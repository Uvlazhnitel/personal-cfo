import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  EUR,
  createForecastCapitalFlow,
  createForecastPlannedExpense,
  createMoney,
  parseDecimalRate,
  parseForecastCapitalFlowId,
  parseForecastPlannedExpenseId,
  parseYearMonth,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

describe('forecast domain facts', () => {
  it('accepts canonical decimal strings and rejects binary/ambiguous values', () => {
    expect(parseDecimalRate('0.05')).toBe('0.05');
    expect(parseDecimalRate('-0.5')).toBe('-0.5');
    for (const value of [0.05, ' 0.05', '05', '0.050', '5e-2', 'NaN', 'Infinity', '-0']) {
      expect(() => parseDecimalRate(value)).toThrowError(DomainValidationError);
    }
  });

  it('creates immutable signed flows and validated expense ranges', () => {
    const flow = createForecastCapitalFlow({
      id: parseForecastCapitalFlowId(uuid(1)),
      month: parseYearMonth('2027-01'),
      cashChange: createMoney(-10_000n, EUR),
      investmentChange: createMoney(10_000n, EUR),
    });
    expect(flow).toEqual(expect.objectContaining({ month: '2027-01' }));
    expect(Object.isFrozen(flow)).toBe(true);

    const expense = createForecastPlannedExpense({
      id: parseForecastPlannedExpenseId(uuid(2)),
      dueMonth: parseYearMonth('2027-04'),
      amount: {
        kind: 'range',
        lower: createMoney(70_000n, EUR),
        upper: createMoney(90_000n, EUR),
      },
      priority: 'mandatory',
      committed: true,
    });
    expect(expense.amount.kind).toBe('range');
    expect(Object.isFrozen(expense)).toBe(true);
  });
});
