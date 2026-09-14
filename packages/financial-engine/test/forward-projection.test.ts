import { describe, expect, it } from 'vitest';

import {
  EUR,
  createForwardLiquidityProjectionCoverage,
  createForwardLiquidityProtectionDay,
  createForwardProjectionCashFlow,
  createMetricResult,
  createMoney,
  createRecurringInvestmentSchedule,
  parseForwardProjectionFlowId,
  parseInstant,
  parseLocalDate,
  parseRecurringInvestmentPlanId,
} from '@personal-cfo/domain';
import type { LocalDate, Money } from '@personal-cfo/domain';

import {
  DEFAULT_INVESTMENT_STEP_SETTINGS,
  assembleForwardLiquidityProjection,
} from '../src/index.js';
import type { LiquidityReserve } from '../src/index.js';
import { addLocalDays } from '../src/local-calendar.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');
const PLAN_ID = parseRecurringInvestmentPlanId('01890f3e-7b2c-7001-8abc-000000000001');

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function currentLiquidity(): ReturnType<typeof createMetricResult<LiquidityReserve>> {
  const zero = money(0n);
  const value: LiquidityReserve = Object.freeze({
    currentLiquidCash: money(100_000n),
    operationalEssential: zero,
    operationalNormal: zero,
    ringFencedCash: zero,
    sinkingFundReservedCash: zero,
    otherRestrictedCash: zero,
    currentCycleSinkingDue: zero,
    uncoveredObligations: zero,
    minimumReserveTarget: money(20_000n),
    comfortReserveTarget: money(30_000n),
    variabilityBuffer: zero,
    minimumCash: money(20_000n),
    comfortCash: money(30_000n),
    freeLiquidCash: money(100_000n),
    currentExcessAboveComfort: money(70_000n),
    operationalStartInclusive: EFFECTIVE_DATE,
    operationalEndExclusive: parseLocalDate('2026-10-01'),
  });
  return createMetricResult({
    status: 'complete',
    value,
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'fixture',
    explanation: [],
    warnings: [],
  });
}

function protection(date: LocalDate, reserved: bigint, due: bigint) {
  return createForwardLiquidityProtectionDay({
    date,
    ringFencedCash: money(reserved),
    currentCycleSinkingDue: money(due),
    uncoveredObligations: money(5_000n),
    operationalEssential: money(10_000n),
    operationalNormal: money(15_000n),
    minimumReserveTarget: money(20_000n),
    comfortReserveTarget: money(30_000n),
    completeness: 'complete',
  });
}

function source(reserved = 0n, due = 10_000n) {
  const days = Array.from({ length: 60 }, (_, index) =>
    protection(addLocalDays(EFFECTIVE_DATE, index + 1), reserved, due),
  );
  return {
    cashFlows: [
      createForwardProjectionCashFlow({
        id: parseForwardProjectionFlowId('01890f3e-7b2c-7002-8abc-000000000002'),
        date: addLocalDays(EFFECTIVE_DATE, 2),
        kind: 'normal_spending',
        amount: money(4_000n),
      }),
      createForwardProjectionCashFlow({
        id: parseForwardProjectionFlowId('01890f3e-7b2c-7003-8abc-000000000003'),
        date: addLocalDays(EFFECTIVE_DATE, 20),
        kind: 'expected_primary_salary',
        amount: money(30_000n),
      }),
      createForwardProjectionCashFlow({
        id: parseForwardProjectionFlowId('01890f3e-7b2c-7004-8abc-000000000004'),
        date: addLocalDays(EFFECTIVE_DATE, 30),
        kind: 'committed_obligation',
        amount: money(7_000n),
      }),
      createForwardProjectionCashFlow({
        id: parseForwardProjectionFlowId('01890f3e-7b2c-7005-8abc-000000000005'),
        date: addLocalDays(EFFECTIVE_DATE, 40),
        kind: 'sinking_funded_spending',
        amount: money(9_000n),
      }),
    ],
    protectionDays: days,
    coverage: createForwardLiquidityProjectionCoverage({
      expectedPrimarySalary: 'complete',
      normalSpending: 'complete',
      committedObligations: 'complete',
      sinkingProtection: 'complete',
    }),
    contributionSchedule: createRecurringInvestmentSchedule({
      planId: PLAN_ID,
      occurrences: [],
      completeThrough: addLocalDays(EFFECTIVE_DATE, 60),
    }),
  } as const;
}

function calculate(reserved = 0n, due = 10_000n) {
  return assembleForwardLiquidityProjection({
    currentLiquidity: currentLiquidity(),
    source: source(reserved, due),
    effectiveDate: EFFECTIVE_DATE,
    settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'fixture',
  });
}

describe('forward projection assembly', () => {
  it('reconciles base cash from named flows and applies salary only on its date', () => {
    const result = calculate();
    expect(result.status).toBe('complete');
    const rows = result.value!.projectionDays;
    expect(rows[0]!.baseLiquidCashBeforeContribution.amountMinor).toBe(100_000n);
    expect(rows[1]!.baseLiquidCashBeforeContribution.amountMinor).toBe(96_000n);
    expect(rows[18]!.baseLiquidCashBeforeContribution.amountMinor).toBe(96_000n);
    expect(rows[19]!.baseLiquidCashBeforeContribution.amountMinor).toBe(126_000n);
    expect(rows[29]!.baseLiquidCashBeforeContribution.amountMinor).toBe(119_000n);
    expect(rows[39]!.baseLiquidCashBeforeContribution.amountMinor).toBe(110_000n);
  });

  it('derives accepted protection thresholds and preserves a due-to-reserved swap', () => {
    const before = calculate(0n, 10_000n).value!;
    const after = calculate(10_000n, 0n).value!;
    expect(before.projectionDays.map((item) => item.minimumCash)).toEqual(
      after.projectionDays.map((item) => item.minimumCash),
    );
    expect(before.projectionDays.map((item) => item.comfortCash)).toEqual(
      after.projectionDays.map((item) => item.comfortCash),
    );
    expect(before.projectionDays[0]!.minimumCash.amountMinor).toBe(35_000n);
    expect(before.projectionDays[0]!.comfortCash.amountMinor).toBe(45_000n);
  });

  it('cannot turn incomplete source coverage into a complete stress path', () => {
    const incomplete = source();
    const result = assembleForwardLiquidityProjection({
      currentLiquidity: currentLiquidity(),
      source: {
        ...incomplete,
        coverage: { ...incomplete.coverage, committedObligations: 'partial' },
      },
      effectiveDate: EFFECTIVE_DATE,
      settings: DEFAULT_INVESTMENT_STEP_SETTINGS,
      asOf: AS_OF,
      engineVersion: '2g.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'fixture',
    });
    expect(result.status).toBe('partial');
    expect(result.value!.projectionDays.every((item) => item.completeness === 'partial')).toBe(
      true,
    );
  });
});
