import {
  EUR,
  createExactFraction,
  createMetricResult,
  createMoney,
  parseInstant,
  parseLocalDate,
  parseYearMonth,
} from '@personal-cfo/domain';
import {
  calculateLiquidityReserve,
  type FinancialCheckpointContext,
} from '@personal-cfo/financial-engine';
import { describe, expect, it } from 'vitest';

import { deriveRunPlanningContext } from '../src/planning-recurrence.js';

const DECLARATION_ID = '018f0000-0000-7000-8000-000000000901';
const MANUAL_NEED_ID = '018f0000-0000-7000-8000-000000000902';

function context(overrides: Readonly<Record<string, unknown>> = {}): FinancialCheckpointContext {
  return {
    monthCoverage: [],
    scheduledRecurring: [],
    recurringSpendingDeclarations: [
      {
        id: DECLARATION_ID,
        amountMinor: 1_999n,
        currency: 'EUR',
        categoryCode: 'sport',
        recurrence: { kind: 'monthly_day_of_month', dayOfMonth: 3 },
      },
    ],
    recurringScheduleComplete: true,
    operationalNeeds: [],
    futureObligations: [],
    otherRestrictedCash: [],
    primaryPaySchedule: { kind: 'monthly_day_of_month', dayOfMonth: 5 },
    nextReliableIncomeDate: null,
    expectedPrimaryPaySchedule: { dates: [], completeThrough: '2026-10-07' },
    historyCoverage: {
      startInclusive: '2026-07-01T00:00:00Z',
      endExclusive: '2026-10-07T12:00:00Z',
    },
    reservationCoverage: {
      startInclusive: '2026-07-01T00:00:00Z',
      endExclusive: '2026-10-07T12:00:00.001Z',
    },
    quality: {
      liquidityInputs: {
        operationalNeeds: 'complete',
        obligations: 'complete',
        restrictedCash: 'complete',
      },
      liquidBalance: 'complete',
      spendingClassification: 'partial',
      reservationHistory: 'complete',
    },
    ...overrides,
  } as unknown as FinancialCheckpointContext;
}

describe('run-relative planning recurrence', () => {
  it('feeds one discretionary Gym occurrence into baseline and pre-salary liquidity', () => {
    const result = deriveRunPlanningContext(context(), '2026-10-07', 31);
    expect(result.nextReliableIncomeDate).toBe('2026-11-05');
    expect(result.expectedPrimaryPaySchedule).toEqual({
      dates: ['2026-11-05'],
      completeThrough: '2026-11-07',
    });
    expect(result.scheduledRecurring).toMatchObject([
      {
        dueDate: '2026-10-03',
        amount: { amountMinor: 1_999n, currency: 'EUR' },
        necessity: 'discretionary',
      },
      {
        dueDate: '2026-11-03',
        amount: { amountMinor: 1_999n, currency: 'EUR' },
        necessity: 'discretionary',
      },
    ]);
    expect(result.operationalNeeds).toMatchObject([
      {
        dueDate: '2026-11-03',
        amount: { amountMinor: 1_999n, currency: 'EUR' },
        necessity: 'discretionary',
        direction: 'debit',
        state: 'scheduled',
      },
    ]);
    expect(result.operationalNeeds[0]?.scheduledSpendingId).toBe(result.scheduledRecurring[1]?.id);
    const metadata = {
      asOf: parseInstant('2026-10-07T12:00:00Z'),
      engineVersion: 'stage2g.1.0',
      settingsVersion: 'settings-v1',
      inputWatermark: 'owner:test:v1',
    } as const;
    const zero = createMoney(0n, EUR);
    const liquidity = calculateLiquidityReserve({
      baseline: createMetricResult({
        ...metadata,
        status: 'complete',
        value: {
          normalBaseline: createMoney(1_999n, EUR),
          essentialBaseline: zero,
          recurringNormal: createMoney(1_999n, EUR),
          recurringEssential: zero,
          variableNormal: zero,
          variableEssential: zero,
          variabilityBuffer: zero,
          excludedIrregular: zero,
          excludedFundedConsumption: zero,
          excludedReversalExcess: zero,
          eligibleCompleteMonths: 3,
          historicalWindowUsed: [parseYearMonth('2026-09')],
          seasonalAdjustment: null,
          source: 'historical',
        },
        explanation: [],
        warnings: [],
      }),
      sinkingProtection: createMetricResult({
        ...metadata,
        status: 'complete',
        value: {
          byFund: [],
          totalRequired: zero,
          totalSatisfied: zero,
          totalOutstanding: zero,
          totalReserved: zero,
          totalProtected: zero,
        },
        explanation: [],
        warnings: [],
      }),
      currentLiquidCash: createMetricResult({
        ...metadata,
        status: 'complete',
        value: createMoney(100_000n, EUR),
        explanation: [],
        warnings: [],
      }),
      operationalNeeds: result.operationalNeeds,
      futureObligations: [],
      otherRestrictedCash: [],
      inputCompleteness: {
        operationalNeeds: 'complete',
        obligations: 'complete',
        restrictedCash: 'complete',
      },
      nextReliableIncomeDate: result.nextReliableIncomeDate,
      effectiveDate: parseLocalDate('2026-10-07'),
      settings: {
        minimumReserveMonths: createExactFraction(1n, 1n),
        comfortReserveMonths: createExactFraction(3n, 1n),
        unknownIncomeHorizonDays: 31,
        obligationHorizonDays: 90,
      },
      ...metadata,
    });
    expect(liquidity.value?.operationalNormal.amountMinor).toBe(1_999n);
    expect(liquidity.value?.operationalEssential.amountMinor).toBe(0n);
    expect(deriveRunPlanningContext(context(), '2026-10-07', 31)).toEqual(result);
  });

  it('does not duplicate equivalent manual operational evidence', () => {
    const result = deriveRunPlanningContext(
      context({
        operationalNeeds: [
          {
            id: MANUAL_NEED_ID,
            dueDate: '2026-11-03',
            amount: createMoney(1_999n, EUR),
            necessity: 'discretionary',
            direction: 'debit',
            state: 'pending',
            scheduledSpendingId: null,
          },
        ],
      }),
      '2026-10-07',
      31,
    );
    expect(result.operationalNeeds).toHaveLength(1);
    expect(result.operationalNeeds[0]?.id).toBe(MANUAL_NEED_ID);
  });

  it('keeps an unknown primary-pay declaration fail-closed', () => {
    const result = deriveRunPlanningContext(
      context({ primaryPaySchedule: null }),
      '2026-10-07',
      31,
    );
    expect(result.nextReliableIncomeDate).toBeNull();
    expect(result.expectedPrimaryPaySchedule).toEqual({
      dates: [],
      completeThrough: '2026-10-07',
    });
  });

  it.each([
    ['2026-10-07', '2026-11-05', '2026-11-03'],
    ['2026-11-05', '2026-12-05', '2026-12-03'],
    ['2026-11-06', '2026-12-05', '2026-12-03'],
  ])(
    'derives strictly future salary and current operational recurrence for %s',
    (effectiveDate, nextIncome, operationalGymDate) => {
      const result = deriveRunPlanningContext(context(), effectiveDate, 31);
      expect(result.nextReliableIncomeDate).toBe(nextIncome);
      expect(result.nextReliableIncomeDate! > effectiveDate).toBe(true);
      expect(result.operationalNeeds).toHaveLength(1);
      expect(result.operationalNeeds[0]?.dueDate).toBe(operationalGymDate);
      expect(result.scheduledRecurring).toContainEqual(
        expect.objectContaining({ dueDate: `${effectiveDate.slice(0, 7)}-03` }),
      );
    },
  );

  it('fails closed when a legacy dated recurring schedule has expired', () => {
    const legacy = context({
      recurringSpendingDeclarations: undefined,
      primaryPaySchedule: undefined,
      scheduledRecurring: [
        {
          id: '018f0000-0000-7000-8000-000000000903',
          dueDate: '2026-10-03',
          amount: createMoney(1_999n, EUR),
          necessity: 'discretionary',
        },
      ],
      nextReliableIncomeDate: '2026-11-05',
      expectedPrimaryPaySchedule: {
        dates: ['2026-11-05'],
        completeThrough: '2026-11-07',
      },
    }) as unknown as Record<string, unknown>;
    delete legacy['recurringSpendingDeclarations'];
    delete legacy['primaryPaySchedule'];
    const result = deriveRunPlanningContext(
      legacy as unknown as FinancialCheckpointContext,
      '2026-11-06',
      31,
    );
    expect(result.recurringScheduleComplete).toBe(false);
    expect(result.nextReliableIncomeDate).toBeNull();
    expect(result.expectedPrimaryPaySchedule).toEqual({
      dates: [],
      completeThrough: '2026-11-06',
    });
  });
});
