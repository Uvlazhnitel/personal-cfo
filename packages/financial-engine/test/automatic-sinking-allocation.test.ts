import { createMetricResult, createSinkingFund } from '@personal-cfo/domain';
import { describe, expect, it } from 'vitest';

import { calculateAutomaticSinkingAllocations, evaluateFinancialState } from '../src/index.js';
import type { LiquidityReserve } from '../src/index.js';
import { buildSyntheticScenario } from './fixtures/stage3/synthetic-scenarios.js';

describe('calculateAutomaticSinkingAllocations', () => {
  it('selects only opted-in funds and respects the current outstanding amount', () => {
    const input = buildSyntheticScenario('healthy_current');
    const state = evaluateFinancialState(input);
    const funds = input.canonical.sinkingFunds.map((fund) =>
      createSinkingFund({
        ...fund,
        allocationPolicy: fund.dueDate === '2026-11-05' ? 'on_primary_income' : 'manual',
      }),
    );
    const result = calculateAutomaticSinkingAllocations({
      funds,
      sinkingProtection: state.currentCycleSinkingDue,
      liquidity: state.liquidityReserve,
    });
    expect(result.status).toBe('complete');
    expect(result.value?.allocations).toHaveLength(1);
    expect(result.value?.allocations[0]?.amount.amountMinor).toBe(3_334n);
  });

  it('never allocates manual funds', () => {
    const input = buildSyntheticScenario('healthy_current');
    const state = evaluateFinancialState(input);
    const result = calculateAutomaticSinkingAllocations({
      funds: input.canonical.sinkingFunds,
      sinkingProtection: state.currentCycleSinkingDue,
      liquidity: state.liquidityReserve,
    });
    expect(result.value?.allocatedTotal.amountMinor).toBe(0n);
  });

  it('returns unavailable when authoritative liquidity is unavailable', () => {
    const input = buildSyntheticScenario('healthy_current');
    const state = evaluateFinancialState(input);
    const liquidity = createMetricResult<LiquidityReserve>({
      asOf: state.liquidityReserve.asOf,
      engineVersion: state.liquidityReserve.engineVersion,
      settingsVersion: state.liquidityReserve.settingsVersion,
      inputWatermark: state.liquidityReserve.inputWatermark,
      status: 'unavailable',
      value: null,
      explanation: [],
      warnings: [],
    });
    const result = calculateAutomaticSinkingAllocations({
      funds: input.canonical.sinkingFunds,
      sinkingProtection: state.currentCycleSinkingDue,
      liquidity,
    });
    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
  });
});
