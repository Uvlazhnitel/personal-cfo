import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  EUR,
  createCycleInvestmentCapacityReadiness,
  createForwardLiquidityProjectionDay,
  createInvestmentContributionAttribution,
  createMoney,
  createRecurringInvestmentSchedule,
  parseLocalDate,
  parsePayCycleId,
  parseRecurringInvestmentOccurrenceId,
  parseRecurringInvestmentPlanId,
  parseTransactionId,
} from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

describe('investment-step domain facts', () => {
  it('distinguishes recurring-plan and ad-hoc contribution attribution', () => {
    const recurring = createInvestmentContributionAttribution({
      transactionId: parseTransactionId(uuid(1)),
      kind: 'recurring_plan',
      planId: parseRecurringInvestmentPlanId(uuid(2)),
    });
    const adHoc = createInvestmentContributionAttribution({
      transactionId: parseTransactionId(uuid(3)),
      kind: 'ad_hoc',
    });

    expect(recurring.kind).toBe('recurring_plan');
    expect(adHoc.kind).toBe('ad_hoc');
    expect(Object.isFrozen(recurring)).toBe(true);
  });

  it('requires explicit unique reasons for incomplete historical readiness', () => {
    const cycleId = parsePayCycleId(uuid(1));
    expect(
      createCycleInvestmentCapacityReadiness({
        cycleId,
        kind: 'incomplete',
        reasons: ['material_cash_variance', 'unreconciled_source'],
      }).reasons,
    ).toEqual(['unreconciled_source', 'material_cash_variance']);
    expect(() =>
      createCycleInvestmentCapacityReadiness({ cycleId, kind: 'incomplete', reasons: [] }),
    ).toThrowError(DomainValidationError);
  });

  it('validates recurring schedules and coverage', () => {
    const planId = parseRecurringInvestmentPlanId(uuid(1));
    const occurrence = {
      id: parseRecurringInvestmentOccurrenceId(uuid(2)),
      planId,
      date: parseLocalDate('2026-10-20'),
    } as const;
    expect(
      createRecurringInvestmentSchedule({
        planId,
        occurrences: [occurrence],
        completeThrough: parseLocalDate('2026-11-30'),
      }).occurrences,
    ).toHaveLength(1);
    expect(() =>
      createRecurringInvestmentSchedule({
        planId,
        occurrences: [occurrence, occurrence],
        completeThrough: parseLocalDate('2026-11-30'),
      }),
    ).toThrowError(DomainValidationError);
  });

  it('accepts signed projected cash but rejects negative components and reversed thresholds', () => {
    const valid = createForwardLiquidityProjectionDay({
      date: parseLocalDate('2026-09-15'),
      expectedPrimarySalaryInflow: createMoney(0n, EUR),
      normalSpendingOutflow: createMoney(10_000n, EUR),
      committedObligationOutflow: createMoney(0n, EUR),
      sinkingFundedSpendingOutflow: createMoney(0n, EUR),
      sinkingProtectedCash: createMoney(5_000n, EUR),
      baseLiquidCashBeforeContribution: createMoney(-1_000n, EUR),
      minimumCash: createMoney(0n, EUR),
      comfortCash: createMoney(5_000n, EUR),
      completeness: 'complete',
    });
    expect(valid.baseLiquidCashBeforeContribution.amountMinor).toBe(-1_000n);
    expect(() =>
      createForwardLiquidityProjectionDay({
        ...valid,
        normalSpendingOutflow: createMoney(-1n, EUR),
      }),
    ).toThrowError(DomainValidationError);
    expect(() =>
      createForwardLiquidityProjectionDay({
        ...valid,
        minimumCash: createMoney(6_000n, EUR),
      }),
    ).toThrowError(DomainValidationError);
  });
});
