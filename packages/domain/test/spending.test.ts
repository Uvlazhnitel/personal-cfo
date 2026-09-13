import { describe, expect, it } from 'vitest';

import {
  EUR,
  DomainValidationError,
  createCalendarMonthCoverage,
  createExactFraction,
  createFutureObligation,
  createMoney,
  createOperationalNeed,
  createRestrictedCash,
  createScheduledSpending,
  createSpendingObservation,
  parseEconomicFlowId,
  parseFutureObligationId,
  parseLocalDate,
  parseOperationalNeedId,
  parseRestrictedCashId,
  parseScheduledSpendingId,
  parseSpendingCategoryId,
  parseYearMonth,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed.toString(16).padStart(12, '0')}`;
}

describe('Stage 2D domain facts', () => {
  it('validates canonical YearMonth values', () => {
    expect(parseYearMonth('2026-09')).toBe('2026-09');
    expect(() => parseYearMonth('0000-01')).toThrow(DomainValidationError);
    expect(() => parseYearMonth('2026-13')).toThrow(DomainValidationError);
  });

  it('creates immutable spending observations and coverage proofs', () => {
    const observation = createSpendingObservation({
      economicFlowId: parseEconomicFlowId(uuid(1)),
      economicDate: parseLocalDate('2026-09-13'),
      categoryId: parseSpendingCategoryId(uuid(2)),
      necessity: 'essential',
      cadence: 'variable',
      irregular: false,
    });
    const coverage = createCalendarMonthCoverage({
      month: parseYearMonth('2026-09'),
      reconciled: true,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(Object.isFrozen(coverage)).toBe(true);
  });

  it('rejects invalid exact fractions and negative scheduled facts', () => {
    expect(() => createExactFraction(1n, 0n)).toThrow(DomainValidationError);
    expect(() =>
      createScheduledSpending({
        id: parseScheduledSpendingId(uuid(3)),
        dueDate: parseLocalDate('2026-10-01'),
        amount: createMoney(0n, EUR),
        necessity: 'essential',
      }),
    ).toThrow(DomainValidationError);
    expect(() =>
      createRestrictedCash({ id: parseRestrictedCashId(uuid(4)), amount: createMoney(-1n, EUR) }),
    ).toThrow(DomainValidationError);
  });

  it('validates obligation ranges and operational facts', () => {
    expect(() =>
      createFutureObligation({
        id: parseFutureObligationId(uuid(5)),
        dueDate: parseLocalDate('2026-10-01'),
        amount: { kind: 'range', lower: createMoney(200n, EUR), upper: createMoney(100n, EUR) },
        priority: 'mandatory',
        committed: true,
        status: 'open',
        coverage: { kind: 'uncovered' },
      }),
    ).toThrow(DomainValidationError);
    const operational = createOperationalNeed({
      id: parseOperationalNeedId(uuid(6)),
      dueDate: parseLocalDate('2026-10-01'),
      amount: createMoney(100n, EUR),
      necessity: 'discretionary',
      direction: 'debit',
      state: 'pending',
      scheduledSpendingId: null,
    });
    expect(operational.amount.amountMinor).toBe(100n);
  });
});
