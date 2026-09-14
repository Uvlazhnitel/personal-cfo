import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createForecastCapitalFlow,
  createMetricResult,
  createMoney,
  parseForecastCapitalFlowId,
  parseInstant,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { Money } from '@personal-cfo/domain';

import { DEFAULT_FORECAST_SETTINGS, calculateFinancialForecast } from '../src/index.js';

const AS_OF = parseInstant('2026-09-14T08:00:00Z');

function metric(value: Money) {
  return createMetricResult({
    status: 'complete',
    value,
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'property',
    explanation: [],
    warnings: [],
  });
}

function calculate(startCash: bigint, startInvestment: bigint, change: bigint) {
  return calculateFinancialForecast({
    startingCash: metric(createMoney(startCash, EUR)),
    startingInvestment: metric(createMoney(startInvestment, EUR)),
    forecastStartMonth: parseYearMonth('2026-10'),
    capitalFlows: [
      createForecastCapitalFlow({
        id: parseForecastCapitalFlowId('01890f3e-7b2c-7001-8abc-000000000001'),
        month: parseYearMonth('2026-10'),
        cashChange: createMoney(change, EUR),
        investmentChange: createMoney(change, EUR),
      }),
    ],
    plannedExpenses: [],
    includedOptionalExpenseIds: [],
    settings: DEFAULT_FORECAST_SETTINGS,
    asOf: AS_OF,
    engineVersion: '2g.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'property',
  }).value!;
}

describe('forecast properties', () => {
  it('reconciles the 0% path exactly for bigint starting values and signed user flows', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 100_000n, max: 9_000_000_000_000_000n }),
        fc.bigInt({ min: 100_000n, max: 9_000_000_000_000_000n }),
        fc.bigInt({ min: -100_000n, max: 100_000n }),
        (cash, investment, change) => {
          const result = calculate(cash, investment, change);
          const zero = result.scenarios.find((item) => item.assumption.annualReturnRate === '0')!;
          const ending = zero.horizons.find((item) => item.months === 12)!.value!;
          expect(ending.cumulativeModeledReturn.amountMinor).toBe(0n);
          expect(ending.closingCash.amountMinor).toBe(cash + change);
          expect(ending.closingInvestment.amountMinor).toBe(investment + change);
          expect(ending.closingTotalCapital.amountMinor).toBe(cash + investment + 2n * change);
        },
      ),
      { seed: 20_260_914, numRuns: 30 },
    );
  });

  it('keeps higher non-negative return scenarios monotone for a positive investment path', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000_000n }), (investment) => {
        const result = calculate(0n, investment, 0n);
        const ending = result.scenarios.map(
          (item) =>
            item.horizons.find((horizon) => horizon.months === 120)!.value!.closingInvestment
              .amountMinor,
        );
        expect(ending[0]! <= ending[1]!).toBe(true);
        expect(ending[1]! <= ending[2]!).toBe(true);
        expect(ending[2]! <= ending[3]!).toBe(true);
      }),
      { seed: 20_260_915, numRuns: 20 },
    );
  });
});
