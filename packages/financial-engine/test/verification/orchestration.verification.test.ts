import { describe, expect, it } from 'vitest';

import { evaluateFinancialState } from '../../src/index.js';
import type {
  FinancialCheckpointContext,
  FinancialEngineCanonicalFacts,
  FinancialEngineInput,
  HistoricalFinancialCheckpoint,
} from '../../src/index.js';
import { buildSyntheticScenario } from '../fixtures/stage3/synthetic-scenarios.js';

function reversed<T>(values: readonly T[]): readonly T[] {
  return [...values].reverse();
}

function reorderContext<T extends FinancialCheckpointContext>(context: T): T {
  return {
    ...context,
    monthCoverage: reversed(context.monthCoverage),
    scheduledRecurring: reversed(context.scheduledRecurring),
    operationalNeeds: reversed(context.operationalNeeds),
    futureObligations: reversed(context.futureObligations),
    otherRestrictedCash: reversed(context.otherRestrictedCash),
    expectedPrimaryPaySchedule: context.expectedPrimaryPaySchedule,
  };
}

function reorderCanonical(canonical: FinancialEngineCanonicalFacts): FinancialEngineCanonicalFacts {
  return {
    ...canonical,
    accounts: reversed(canonical.accounts),
    transactions: reversed(canonical.transactions).map((transaction) => ({
      ...transaction,
      entries: reversed(transaction.entries),
    })),
    investmentContributions: reversed(canonical.investmentContributions),
    accountBalanceSnapshots: reversed(canonical.accountBalanceSnapshots),
    portfolioValuations: reversed(canonical.portfolioValuations),
    economicFlows: reversed(canonical.economicFlows),
    ambiguities: reversed(canonical.ambiguities),
    cashReconciliations: reversed(canonical.cashReconciliations),
    sinkingFunds: reversed(canonical.sinkingFunds),
    sinkingFundAllocations: reversed(canonical.sinkingFundAllocations),
    spendingObservations: reversed(canonical.spendingObservations),
    primarySalaryTriggers: reversed(canonical.primarySalaryTriggers),
    contributionAttributions: reversed(canonical.contributionAttributions),
    cashReconciliationResolutions: reversed(canonical.cashReconciliationResolutions),
  };
}

function reorderedInput(input: FinancialEngineInput): FinancialEngineInput {
  const historicalCheckpoints = reversed(input.historicalCheckpoints).map((checkpoint) =>
    reorderContext(checkpoint),
  ) as readonly HistoricalFinancialCheckpoint[];
  return {
    ...input,
    settingsHistory: reversed(input.settingsHistory),
    canonical: reorderCanonical(input.canonical),
    current: reorderContext(input.current),
    historicalCheckpoints,
    rollingCcrPeriods: input.rollingCcrPeriods,
    forwardProjection: {
      ...input.forwardProjection,
      cashFlows: reversed(input.forwardProjection.cashFlows),
      protectionDays: reversed(input.forwardProjection.protectionDays),
      contributionSchedule: input.forwardProjection.contributionSchedule,
    },
    forecastPlan: {
      capitalFlows: reversed(input.forecastPlan.capitalFlows),
      plannedExpenses: reversed(input.forecastPlan.plannedExpenses),
      includedOptionalExpenseIds: reversed(input.forecastPlan.includedOptionalExpenseIds),
    },
  };
}

describe('Stage 4 orchestration verification', () => {
  it('is repeatable and invariant to every semantically unordered Stage 3 input', () => {
    const input = buildSyntheticScenario('healthy_current');
    const expected = evaluateFinancialState(input);

    expect(evaluateFinancialState(input)).toEqual(expected);
    expect(evaluateFinancialState(reorderedInput(input))).toEqual(expected);
  });

  it('propagates one root metadata envelope to every current MetricResult', () => {
    const input = buildSyntheticScenario('healthy_current');
    const result = evaluateFinancialState(input);
    const metrics = [
      result.positions.liquidCash,
      result.positions.investmentMarketValue,
      result.netWorth,
      result.ccr,
      result.currentCycleSinkingDue,
      result.spendingBaseline,
      result.liquidityReserve,
      result.safeToInvest,
      result.cashDrag,
      result.historicalInvestmentCapacity,
      result.investmentContributionDecision,
      result.forecast,
    ];

    for (const metric of metrics) {
      expect(metric).toMatchObject({
        asOf: input.run.asOf,
        engineVersion: input.run.engineVersion,
        settingsVersion: input.run.settingsVersion,
        inputWatermark: input.run.inputWatermark,
      });
    }
  });

  it('keeps independent cash metrics usable when portfolio valuation is missing', () => {
    const input = buildSyntheticScenario('healthy_current');
    const result = evaluateFinancialState({
      ...input,
      canonical: { ...input.canonical, portfolioValuations: [] },
    });

    expect(result.positions.investmentMarketValue.status).toBe('unavailable');
    expect(result.netWorth.status).toBe('unavailable');
    expect(result.forecast.status).toBe('unavailable');
    expect(result.spendingBaseline.status).toBe('complete');
    expect(result.liquidityReserve.status).toBe('complete');
  });

  it.each([
    {
      name: 'missing liquid balance',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        canonical: { ...input.canonical, accountBalanceSnapshots: [] },
      }),
      expectedBlocker: 'incomplete_liquid_balance',
    },
    {
      name: 'missing complete month coverage',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        current: {
          ...input.current,
          monthCoverage: input.current.monthCoverage.map((coverage) => ({
            ...coverage,
            reconciled: false,
          })),
        },
      }),
      expectedBlocker: 'incomplete_spending_baseline',
    },
    {
      name: 'unknown reliable salary',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        current: { ...input.current, nextReliableIncomeDate: null },
      }),
      expectedBlocker: 'unknown_next_reliable_income',
    },
    {
      name: 'incomplete obligations',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        current: {
          ...input.current,
          quality: {
            ...input.current.quality,
            liquidityInputs: {
              ...input.current.quality.liquidityInputs,
              obligations: 'unavailable',
            },
          },
        },
      }),
      expectedBlocker: 'incomplete_obligations',
    },
    {
      name: 'incomplete reservation history',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        current: {
          ...input.current,
          quality: { ...input.current.quality, reservationHistory: 'unavailable' },
        },
      }),
      expectedBlocker: 'incomplete_sinking_protection',
    },
    {
      name: 'incomplete forward projection',
      change: (input: FinancialEngineInput): FinancialEngineInput => ({
        ...input,
        forwardProjection: {
          ...input.forwardProjection,
          coverage: {
            ...input.forwardProjection.coverage,
            normalSpending: 'partial',
          },
        },
      }),
      expectedBlocker: null,
    },
  ])('never turns $name into authoritative invest-more advice', ({ change, expectedBlocker }) => {
    const result = evaluateFinancialState(change(buildSyntheticScenario('healthy_current')));

    expect(result.investmentContributionDecision.value?.kind).not.toBe('step_up');
    if (expectedBlocker !== null) {
      expect(result.investabilityReadiness.kind).toBe('blocked');
      if (result.investabilityReadiness.kind === 'blocked') {
        expect(result.investabilityReadiness.reasons).toContain(expectedBlocker);
      }
      expect(result.safeToInvest.status).toBe('unavailable');
    }
  });

  it('derives complete, provisional, and blocked investability only from canonical facts', () => {
    const complete = evaluateFinancialState(buildSyntheticScenario('healthy_current'));
    const provisional = evaluateFinancialState(buildSyntheticScenario('cash_variance_unresolved'));
    const blocked = evaluateFinancialState(buildSyntheticScenario('material_transfer_unresolved'));

    expect(complete.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(provisional.investabilityReadiness).toEqual({
      kind: 'provisional',
      reasons: ['non_material_cash_variance'],
    });
    expect(provisional.safeToInvest.status).toBe('partial');
    expect(provisional.cashDrag.value?.eligible).toBe(false);
    expect(blocked.investabilityReadiness).toEqual({
      kind: 'blocked',
      reasons: ['material_unresolved_transfer'],
    });
    expect(blocked.netWorth.status).toBe('complete');
    expect(blocked.safeToInvest.status).toBe('unavailable');
    expect(blocked.cashDrag.status).toBe('unavailable');
    expect(blocked.investmentContributionDecision.value?.kind).not.toBe('step_up');
  }, 15_000);

  it('changes wealth and investable cash by the exact count variance without inventing flow', () => {
    const unresolvedInput = buildSyntheticScenario('cash_variance_unresolved');
    const reconciliation = unresolvedInput.canonical.cashReconciliations[0]!;
    const cleanInput: FinancialEngineInput = {
      ...unresolvedInput,
      canonical: {
        ...unresolvedInput.canonical,
        transactions: unresolvedInput.canonical.transactions.filter(
          (transaction) => transaction.id !== reconciliation.adjustmentTransactionId,
        ),
        economicFlows: unresolvedInput.canonical.economicFlows.filter(
          (flow) => flow.transactionId !== reconciliation.adjustmentTransactionId,
        ),
        cashReconciliations: [],
        cashReconciliationResolutions: [],
      },
    };
    const beforeCount = evaluateFinancialState(cleanInput);
    const afterCount = evaluateFinancialState(unresolvedInput);

    expect(
      beforeCount.netWorth.value!.total.amountMinor - afterCount.netWorth.value!.total.amountMinor,
    ).toBe(1_500n);
    expect(
      beforeCount.positions.liquidCash.value!.amountMinor -
        afterCount.positions.liquidCash.value!.amountMinor,
    ).toBe(1_500n);
    expect(
      beforeCount.safeToInvest.value!.unroundedRecommended.amountMinor -
        afterCount.safeToInvest.value!.unroundedRecommended.amountMinor,
    ).toBe(1_500n);
    expect(afterCount.ccr.value?.recognizedIncome).toEqual(beforeCount.ccr.value?.recognizedIncome);
    expect(afterCount.ccr.value?.netConsumption).toEqual(beforeCount.ccr.value?.netConsumption);
  });
});
