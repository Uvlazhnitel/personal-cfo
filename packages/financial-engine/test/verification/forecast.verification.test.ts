import { describe, expect, it } from 'vitest';

import { evaluateFinancialState } from '../../src/index.js';
import { buildSyntheticScenario } from '../fixtures/stage3/synthetic-scenarios.js';

describe('Stage 4 forecast verification', () => {
  it('reconciles every monthly boundary in every 0/3/5/7 percent scenario', () => {
    const forecast = evaluateFinancialState(buildSyntheticScenario('healthy_current')).forecast;
    expect(forecast.status).toBe('complete');
    expect(
      forecast.value?.scenarios.map((scenario) => scenario.assumption.annualReturnRate),
    ).toEqual(['0', '0.03', '0.05', '0.07']);

    for (const scenario of forecast.value!.scenarios) {
      expect(scenario.horizons.map((horizon) => horizon.months)).toEqual([12, 36, 60, 120]);
      for (const row of scenario.monthlyPath) {
        expect(row.status).toBe('complete');
        const value = row.value!;
        expect(value.closingInvestment.amountMinor).toBe(
          value.openingInvestment.amountMinor +
            value.modeledReturn.amountMinor +
            value.investmentChange.amountMinor,
        );
        expect(value.closingCash.amountMinor).toBe(
          value.openingCash.amountMinor +
            value.cashChange.amountMinor -
            value.plannedExpenses.amountMinor,
        );
        expect(value.closingTotalCapital.amountMinor).toBe(
          value.closingCash.amountMinor + value.closingInvestment.amountMinor,
        );
      }
    }
  });

  it('keeps contributions-only return exactly zero and reconciles all 120 months', () => {
    const forecast = evaluateFinancialState(buildSyntheticScenario('healthy_current')).forecast;
    const zero = forecast.value!.scenarios.find(
      (scenario) => scenario.assumption.annualReturnRate === '0',
    )!;
    expect(zero.monthlyReturnFactor).toBe('0');
    expect(zero.monthlyPath).toHaveLength(120);
    expect(zero.monthlyPath.every((row) => row.value?.modeledReturn.amountMinor === 0n)).toBe(true);
    const ending = zero.horizons.at(-1)!.value!;
    expect(ending.cumulativeModeledReturn.amountMinor).toBe(0n);
    expect(ending.closingTotalCapital.amountMinor).toBe(
      zero.startingCash.amountMinor +
        zero.startingInvestment.amountMinor +
        ending.cumulativeCashChange.amountMinor +
        ending.cumulativeInvestmentChange.amountMinor -
        ending.cumulativePlannedExpenses.amountMinor,
    );
  });

  it('keeps positive-return scenarios monotonic at every required horizon', () => {
    const scenarios = evaluateFinancialState(buildSyntheticScenario('healthy_current')).forecast
      .value!.scenarios;
    for (const horizonIndex of [0, 1, 2, 3]) {
      const values = scenarios.map(
        (scenario) => scenario.horizons[horizonIndex]!.value!.closingInvestment.amountMinor,
      );
      expect(values[1]).toBeGreaterThanOrEqual(values[0]!);
      expect(values[2]).toBeGreaterThanOrEqual(values[1]!);
      expect(values[3]).toBeGreaterThanOrEqual(values[2]!);
    }
  });

  it('does not mutate explicit forecast flows when Step-Up is suppressed for the same window', () => {
    const input = buildSyntheticScenario('healthy_current');
    const initial = evaluateFinancialState(input);
    const cycleIds = initial.historicalInvestmentCapacity.value!.reassessmentCycleIds;
    const suppressed = evaluateFinancialState({ ...input, lastIssuedStepUpCycleIds: cycleIds });

    expect(initial.investmentContributionDecision.value?.kind).toBe('step_up');
    expect(suppressed.investmentContributionDecision.value?.kind).toBe('hold');
    expect(suppressed.forecast).toEqual(initial.forecast);
  });

  it('uses historical checkpoint liquidity and never upgrades an incomplete recent cycle', () => {
    const healthy = evaluateFinancialState(buildSyntheticScenario('healthy_current'));
    const incomplete = evaluateFinancialState(
      buildSyntheticScenario('historical_incomplete_month'),
    );

    expect(healthy.cashDrag.value?.completeDays).toBe(60);
    expect(incomplete.historicalInvestmentCapacity.status).toBe('partial');
    expect(incomplete.historicalInvestmentCapacity.value?.sustainableCapacity).toBeNull();
    expect(incomplete.investmentContributionDecision).toMatchObject({
      status: 'partial',
      value: { kind: 'hold' },
    });
  });
});
