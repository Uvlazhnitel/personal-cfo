import { describe, expect, it } from 'vitest';

import type { EconomicFlow, SinkingFundAllocation, YearMonth } from '@personal-cfo/domain';
import { parseInstant, parseLocalDate } from '@personal-cfo/domain';

import { calculateLedgerBalance, evaluateFinancialState } from '../src/index.js';
import { SYNTHETIC_EXPECTATIONS } from './fixtures/stage3/synthetic-expectations.js';
import {
  SYNTHETIC_AS_OF,
  SYNTHETIC_IDS,
  SYNTHETIC_MONTHS,
  SYNTHETIC_SALARY_DATES,
  buildSyntheticFinancialLife,
} from './fixtures/stage3/synthetic-financial-life.js';
import {
  SYNTHETIC_SCENARIO_IDS,
  buildSyntheticHistoricalCheckpoints,
  buildSyntheticScenario,
} from './fixtures/stage3/synthetic-scenarios.js';

function sumFlows(flows: readonly EconomicFlow[], kind: EconomicFlow['kind']): bigint {
  return flows
    .filter((item) => item.kind === kind)
    .reduce((sum, item) => sum + item.amount.amountMinor, 0n);
}

function reservationChange(allocations: readonly SinkingFundAllocation[]): bigint {
  return allocations.reduce(
    (sum, item) =>
      sum + (item.kind === 'allocation' ? item.amount.amountMinor : -item.amount.amountMinor),
    0n,
  );
}

function monthlySummary(month: YearMonth) {
  const life = buildSyntheticFinancialLife();
  const flows = life.economicFlows.filter((item) => item.effectiveAt.startsWith(month));
  return {
    recognizedIncome: sumFlows(flows, 'earned_income'),
    grossConsumption: sumFlows(flows, 'consumption'),
    refunds: sumFlows(flows, 'refund'),
    reservationChange: reservationChange(
      life.sinkingFundAllocations.filter((item) => item.effectiveAt.startsWith(month)),
    ),
    investmentPrincipal: life.investmentContributions
      .filter((item) => item.effectiveAt.startsWith(month))
      .reduce((sum, item) => sum + item.principal.amountMinor, 0n),
    reconciliationAdjustment: sumFlows(flows, 'cash_reconciliation_adjustment'),
  };
}

describe('Stage 3 synthetic financial dataset', () => {
  it('builds deterministically with stable, unique canonical identities', () => {
    const first = buildSyntheticFinancialLife();
    const second = buildSyntheticFinancialLife();
    const counts = SYNTHETIC_EXPECTATIONS.entityCounts;

    expect(first).toEqual(second);
    expect(SYNTHETIC_AS_OF).toBe('2026-09-14T08:00:00Z');
    expect(SYNTHETIC_MONTHS).toHaveLength(24);
    expect(SYNTHETIC_SALARY_DATES).toHaveLength(25);
    expect(first.accounts).toHaveLength(counts.accounts);
    expect(first.transactions).toHaveLength(counts.transactionsInLife);
    expect(first.economicFlows).toHaveLength(counts.economicFlows);
    expect(first.spendingObservations).toHaveLength(counts.spendingObservations);
    expect(first.primarySalaryTriggers).toHaveLength(counts.salaryTriggers);
    expect(first.investmentContributions).toHaveLength(counts.investmentContributions);
    expect(first.sinkingFunds).toHaveLength(counts.sinkingFunds);
    expect(first.sinkingFundAllocations).toHaveLength(counts.sinkingFundAllocations);
    expect(first.cashReconciliations).toHaveLength(counts.cashReconciliations);
    expect(first.cashReconciliationResolutions).toHaveLength(counts.cashReconciliationResolutions);
    expect(first.futureObligations).toHaveLength(counts.futureObligations);
    expect(first.accounts.map((account) => account.id)).toEqual([
      SYNTHETIC_IDS.bankAccount,
      SYNTHETIC_IDS.cashAccount,
      SYNTHETIC_IDS.investmentAccount,
    ]);
    expect(new Set(first.transactions.map((item) => item.id)).size).toBe(first.transactions.length);
    const entries = first.transactions.flatMap((item) => item.entries);
    expect(new Set(entries.map((item) => item.id)).size).toBe(entries.length);
  });

  it('provides the exact checkpoint and valuation catalog', () => {
    const input = buildSyntheticScenario('healthy_current');
    const checkpoints = buildSyntheticHistoricalCheckpoints();
    const counts = SYNTHETIC_EXPECTATIONS.entityCounts;

    expect(input.canonical.transactions).toHaveLength(counts.transactionsInHealthyScenario);
    expect(input.canonical.accountBalanceSnapshots).toHaveLength(counts.accountBalanceSnapshots);
    expect(input.canonical.portfolioValuations).toHaveLength(counts.portfolioValuations);
    expect(checkpoints.filter((item) => item.kind === 'cash_drag_day')).toHaveLength(
      counts.cashDragCheckpoints,
    );
    expect(checkpoints.filter((item) => item.kind === 'pre_closing')).toHaveLength(
      counts.preClosingCheckpoints,
    );
  });

  it('covers scheduled operational needs across calendar-month boundaries', () => {
    const cases = [
      {
        checkpointDate: '2026-08-30',
        nextSalaryDate: '2026-09-28',
        effectiveDate: '2026-09-14',
        asOf: '2026-09-14T08:00:00Z',
        expected: [
          ['2026-09-03', 90_000n],
          ['2026-09-06', 9_000n],
          ['2026-09-09', 4_500n],
          ['2026-09-12', 5_000n],
          ['2026-09-15', 1_500n],
        ],
      },
      {
        checkpointDate: '2026-09-29',
        nextSalaryDate: '2026-10-28',
        effectiveDate: '2026-10-14',
        asOf: '2026-10-14T08:00:00Z',
        expected: [
          ['2026-10-03', 90_000n],
          ['2026-10-06', 13_000n],
          ['2026-10-09', 4_500n],
          ['2026-10-12', 5_000n],
          ['2026-10-15', 1_500n],
        ],
      },
    ] as const;

    for (const testCase of cases) {
      const checkpoint = buildSyntheticHistoricalCheckpoints(
        parseLocalDate(testCase.effectiveDate),
        parseInstant(testCase.asOf),
      ).find((item) => item.kind === 'cash_drag_day' && item.date === testCase.checkpointDate);
      if (checkpoint === undefined) throw new Error('Expected synthetic checkpoint was not built.');
      expect(
        checkpoint.operationalNeeds.map((item) => [item.dueDate, item.amount.amountMinor]),
      ).toEqual(testCase.expected);
      expect(checkpoint.nextReliableIncomeDate).toBe(testCase.nextSalaryDate);
      expect(
        checkpoint.operationalNeeds.every(
          (item) =>
            item.dueDate > testCase.checkpointDate && item.dueDate < testCase.nextSalaryDate,
        ),
      ).toBe(true);
      expect(checkpoint.operationalNeeds.map((item) => `${item.dueDate}:${item.id}`)).toEqual(
        [...checkpoint.operationalNeeds]
          .sort(
            (left, right) =>
              left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id),
          )
          .map((item) => `${item.dueDate}:${item.id}`),
      );
      expect(checkpoint.quality.liquidityInputs.operationalNeeds).toBe('complete');
    }
  });

  it('constructs the literal salary-driven cycle catalog despite weekend drift and side income', () => {
    const input = buildSyntheticScenario('healthy_current');
    const result = evaluateFinancialState(input);
    const recent = result.payCycles.slice(-5);

    expect(result.payCycles).toHaveLength(25);
    expect(
      recent.map((item) => ({
        id: item.id,
        openingSalaryTransactionId: item.openingSalaryTransactionId,
        startDate: item.startDate,
        closingSalaryTransactionId: item.closingSalaryTransactionId,
        endExclusive: item.endExclusive,
        status: item.status,
        expectedNextPayDate: item.expectedNextPayDate,
      })),
    ).toEqual(SYNTHETIC_EXPECTATIONS.payCycles);
    expect(result.payCycles.some((item) => item.startDate === '2026-09-05')).toBe(false);
    expect(input.canonical.primarySalaryTriggers).toHaveLength(25);
  });

  it.each(Object.entries(SYNTHETIC_EXPECTATIONS.monthlySummaries))(
    'reconciles literal %s source totals',
    (month, expected) => {
      expect(monthlySummary(month as YearMonth)).toEqual(expected);
    },
  );

  it('matches the healthy current-state golden anchors', () => {
    const expected = SYNTHETIC_EXPECTATIONS.healthy;
    const result = evaluateFinancialState(buildSyntheticScenario('healthy_current'));

    expect(result.positions.liquidCash.value?.amountMinor).toBe(expected.currentLiquidCash);
    expect(result.positions.investmentMarketValue.value?.amountMinor).toBe(
      expected.investmentMarketValue,
    );
    expect(result.netWorth.value?.total.amountMinor).toBe(expected.netWorth);
    expect(result.currentCycleSinkingDue.value).toMatchObject({
      totalRequired: { amountMinor: expected.sinking.required },
      totalSatisfied: { amountMinor: expected.sinking.satisfied },
      totalOutstanding: { amountMinor: expected.sinking.outstanding },
      totalReserved: { amountMinor: expected.sinking.reserved },
      totalProtected: { amountMinor: expected.sinking.protected },
    });
    expect(result.spendingBaseline.value).toMatchObject({
      normalBaseline: { amountMinor: expected.baseline.normal },
      essentialBaseline: { amountMinor: expected.baseline.essential },
      recurringNormal: { amountMinor: expected.baseline.recurringNormal },
      variableNormal: { amountMinor: expected.baseline.variableNormal },
      variabilityBuffer: { amountMinor: expected.baseline.variabilityBuffer },
    });
    expect(result.liquidityReserve.value).toMatchObject({
      operationalEssential: { amountMinor: expected.liquidity.operationalEssential },
      operationalNormal: { amountMinor: expected.liquidity.operationalNormal },
      uncoveredObligations: { amountMinor: expected.liquidity.uncoveredObligations },
      minimumCash: { amountMinor: expected.liquidity.minimumCash },
      comfortCash: { amountMinor: expected.liquidity.comfortCash },
    });
    expect(result.safeToInvest.value).toMatchObject({
      conservative: { amountMinor: expected.safeToInvest.conservative },
      recommended: { amountMinor: expected.safeToInvest.recommended },
      maximum: { amountMinor: expected.safeToInvest.maximum },
    });
    expect(result.cashDrag.value).toMatchObject({
      eligible: expected.cashDrag.eligible,
      completeDays: expected.cashDrag.completeDays,
      positiveExcessDays: expected.cashDrag.positiveDays,
      averageExcess: { amountMinor: expected.cashDrag.averageExcess },
    });
    expect(result.historicalInvestmentCapacity.value?.sustainableCapacity?.amountMinor).toBe(
      expected.sustainableCapacity,
    );
    expect(result.investmentContributionDecision.value).toMatchObject({
      kind: 'step_up',
      currentContribution: { amountMinor: expected.currentContribution },
      proposedContribution: { amountMinor: expected.proposedContribution },
    });
  });

  it('matches the representative current CCR anchor exactly', () => {
    const expected = SYNTHETIC_EXPECTATIONS.healthy.ccr;
    const ccr = evaluateFinancialState(buildSyntheticScenario('healthy_current')).ccr.value;

    if (ccr === null || ccr.ratio === null) throw new Error('Healthy CCR must be available.');
    expect(ccr.recognizedIncome.amountMinor).toBe(expected.recognizedIncome);
    expect(ccr.netConsumption.amountMinor).toBe(expected.netConsumption);
    expect(ccr.shortTermReservedFundsChange.amountMinor).toBe(expected.reservationChange);
    expect(ccr.capitalCreated.amountMinor).toBe(expected.capitalCreated);
    expect(ccr.ratio.numerator * expected.reducedDenominator).toBe(
      ccr.ratio.denominator * expected.reducedNumerator,
    );
  });

  it('matches the literal rolling multi-month CCR reference exactly', () => {
    const expected = SYNTHETIC_EXPECTATIONS.healthy.rollingCcr;
    const rolling = evaluateFinancialState(buildSyntheticScenario('healthy_current')).rollingCcr;

    expect(rolling).toHaveLength(1);
    expect(rolling[0]?.period).toEqual({
      startInclusive: expected.startInclusive,
      endExclusive: expected.endExclusive,
    });
    expect(rolling[0]?.result.status).toBe(expected.status);
    const value = rolling[0]?.result.value;
    if (value === null || value === undefined || value.ratio === null) {
      throw new Error('Synthetic rolling CCR must be available.');
    }
    expect(value.recognizedIncome.amountMinor).toBe(expected.recognizedIncome);
    expect(value.grossConsumption.amountMinor).toBe(expected.grossConsumption);
    expect(value.refunds.amountMinor).toBe(expected.refunds);
    expect(value.netConsumption.amountMinor).toBe(expected.netConsumption);
    expect(value.shortTermReservedFundsChange.amountMinor).toBe(expected.reservationChange);
    expect(value.capitalCreated.amountMinor).toBe(expected.capitalCreated);
    expect(value.ratio).toEqual({
      numerator: expected.ratioNumerator,
      denominator: expected.ratioDenominator,
    });
    expect(value.ratio.numerator * expected.reducedDenominator).toBe(
      value.ratio.denominator * expected.reducedNumerator,
    );
  });

  it('keeps the 0% forecast explicit and independent of the Step-Up decision', () => {
    const expected = SYNTHETIC_EXPECTATIONS.healthy.forecastTwelveMonthZeroReturn;
    const result = evaluateFinancialState(buildSyntheticScenario('healthy_current'));
    const zero = result.forecast.value?.scenarios.find(
      (item) => item.assumption.annualReturnRate === '0',
    );
    const horizon = zero?.horizons.find((item) => item.months === 12)?.value;

    expect(horizon).toMatchObject({
      closingCash: { amountMinor: expected.cash },
      closingInvestment: { amountMinor: expected.investment },
      cumulativeInvestmentChange: { amountMinor: 60_000n },
      cumulativePlannedExpenses: { amountMinor: expected.plannedExpenses },
      cumulativeModeledReturn: { amountMinor: expected.modeledReturn },
      closingTotalCapital: { amountMinor: expected.totalCapital },
    });
    expect(horizon?.cumulativeInvestmentChange.amountMinor).toBe(12n * 5_000n);
  });

  it('counts the funded trip once and preserves its completed target progress', () => {
    const expected = SYNTHETIC_EXPECTATIONS.scenarios;
    const before = evaluateFinancialState(buildSyntheticScenario('trip_before_purchase'));
    const after = evaluateFinancialState(buildSyntheticScenario('trip_after_purchase'));
    const trip = after.currentCycleSinkingDue.value?.byFund.find(
      (item) => item.fundId === SYNTHETIC_IDS.travelFund,
    );

    expect(before.netWorth.value?.total.amountMinor).toBe(expected.tripBeforeNetWorth);
    expect(after.netWorth.value?.total.amountMinor).toBe(expected.tripAfterNetWorth);
    expect(before.netWorth.value!.total.amountMinor - after.netWorth.value!.total.amountMinor).toBe(
      120_000n,
    );
    expect(trip).toMatchObject({
      reserved: { amountMinor: 0n },
      fundedConsumption: { amountMinor: 120_000n },
      fulfilled: { amountMinor: 120_000n },
      remaining: { amountMinor: 0n },
    });
  });

  it('keeps ATM transfers, investments, opening state, and market changes out of CCR', () => {
    const input = buildSyntheticScenario('healthy_current');
    const result = evaluateFinancialState(input);
    const currentPeriodTransfers = input.canonical.transactions.filter(
      (item) =>
        item.effectiveAt >= input.ccrPeriod.startInclusive && item.kind === 'internal_transfer',
    );

    expect(currentPeriodTransfers).toHaveLength(1);
    expect(result.ccr.value).toMatchObject({
      recognizedIncome: { amountMinor: 335_000n },
      netConsumption: { amountMinor: 48_000n },
      otherExternalInflows: { amountMinor: 0n },
      otherExternalOutflows: { amountMinor: 0n },
      cashReconciliationAdjustments: { amountMinor: 0n },
    });
    expect(input.canonical.investmentContributions).toHaveLength(25);
    const valuationAmounts = input.canonical.portfolioValuations.map((item) =>
      item.marketValue.status === 'available' ? item.marketValue.reporting.amountMinor : null,
    );
    expect(
      valuationAmounts.some(
        (amount, index) =>
          index > 0 &&
          amount !== null &&
          valuationAmounts[index - 1] !== null &&
          amount < valuationAmounts[index - 1]!,
      ),
    ).toBe(true);
  });

  it('keeps the cash ledger auditable through count, reversal, and recovered spending', () => {
    const life = buildSyntheticFinancialLife();
    const ledger = {
      accounts: life.accounts,
      transactions: life.transactions,
      investmentContributions: life.investmentContributions,
    };

    expect(
      calculateLedgerBalance({
        ledger,
        accountId: SYNTHETIC_IDS.cashAccount,
        asOf: parseInstant('2026-08-20T11:59:59Z'),
      }).amountMinor,
    ).toBe(14_000n);
    expect(
      calculateLedgerBalance({
        ledger,
        accountId: SYNTHETIC_IDS.cashAccount,
        asOf: parseInstant('2026-08-22T08:00:00Z'),
      }).amountMinor,
    ).toBe(12_500n);
    expect(
      calculateLedgerBalance({
        ledger,
        accountId: SYNTHETIC_IDS.cashAccount,
        asOf: parseInstant('2026-08-26T08:00:00Z'),
      }).amountMinor,
    ).toBe(12_500n);
  });

  it('applies the linked refund once without treating it as income', () => {
    const input = buildSyntheticScenario('healthy_current');
    const result = evaluateFinancialState({
      ...input,
      ccrPeriod: {
        startInclusive: parseInstant('2026-04-01T00:00:00Z'),
        endExclusive: parseInstant('2026-05-01T00:00:00Z'),
      },
    });

    expect(result.ccr.value).toMatchObject({
      recognizedIncome: { amountMinor: 320_000n },
      grossConsumption: { amountMinor: 214_600n },
      refunds: { amountMinor: 3_000n },
      netConsumption: { amountMinor: 211_600n },
      shortTermReservedFundsChange: { amountMinor: 20_000n },
      capitalCreated: { amountMinor: 88_400n },
    });
  });

  it('preserves liquidity and STI when current due becomes reserved cash', () => {
    const before = evaluateFinancialState(buildSyntheticScenario('sinking_due_before_allocation'));
    const after = evaluateFinancialState(buildSyntheticScenario('sinking_due_after_allocation'));

    expect(before.currentCycleSinkingDue.value).toMatchObject({
      totalReserved: { amountMinor: 20_000n },
      totalOutstanding: { amountMinor: 13_334n },
    });
    expect(after.currentCycleSinkingDue.value).toMatchObject({
      totalReserved: { amountMinor: 30_000n },
      totalOutstanding: { amountMinor: 3_334n },
    });
    expect(after.liquidityReserve.value?.minimumCash).toEqual(
      before.liquidityReserve.value?.minimumCash,
    );
    expect(after.liquidityReserve.value?.comfortCash).toEqual(
      before.liquidityReserve.value?.comfortCash,
    );
    expect(after.safeToInvest.value?.recommended).toEqual(before.safeToInvest.value?.recommended);
  });

  it('keeps reconciliation cutoffs auditable and restores readiness only after resolution', () => {
    const expected = SYNTHETIC_EXPECTATIONS.scenarios;
    const before = evaluateFinancialState(buildSyntheticScenario('cash_variance_before'));
    const unresolved = evaluateFinancialState(buildSyntheticScenario('cash_variance_unresolved'));
    const resolved = evaluateFinancialState(buildSyntheticScenario('cash_variance_resolved'));

    expect(before.netWorth.value?.total.amountMinor).toBe(expected.cashBeforeNetWorth);
    expect(unresolved.netWorth.value?.total.amountMinor).toBe(expected.cashUnresolvedNetWorth);
    expect(resolved.netWorth.value?.total.amountMinor).toBe(expected.cashResolvedNetWorth);
    expect(before.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(unresolved.investabilityReadiness).toEqual({
      kind: 'provisional',
      reasons: ['non_material_cash_variance'],
    });
    expect(unresolved.safeToInvest.status).toBe('partial');
    expect(unresolved.cashDrag.value?.eligible).toBe(false);
    expect(unresolved.investmentContributionDecision.value?.kind).toBe('hold');
    expect(resolved.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(resolved.safeToInvest.status).toBe('complete');
  });

  it('blocks invest-more on material transfer ambiguity and restores it in the resolved variant', () => {
    const unresolved = evaluateFinancialState(
      buildSyntheticScenario('material_transfer_unresolved'),
    );
    const resolved = evaluateFinancialState(
      buildSyntheticScenario('material_transfer_resolved_variant'),
    );

    expect(unresolved.netWorth.value?.total).toEqual(resolved.netWorth.value?.total);
    expect(unresolved.investabilityReadiness).toEqual({
      kind: 'blocked',
      reasons: ['material_unresolved_transfer'],
    });
    expect(unresolved.safeToInvest.status).toBe('unavailable');
    expect(unresolved.cashDrag.status).toBe('unavailable');
    expect(unresolved.cashDrag.value).toBeNull();
    expect(unresolved.investmentContributionDecision.value?.kind).not.toBe('step_up');
    expect(resolved.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(resolved.investmentContributionDecision.value?.kind).toBe('step_up');
  });

  it('surfaces genuinely incomplete recent history instead of backfilling older capacity', () => {
    const result = evaluateFinancialState(buildSyntheticScenario('historical_incomplete_month'));

    expect(result.spendingBaseline.status).toBe('complete');
    expect(result.historicalInvestmentCapacity.status).toBe('partial');
    expect(result.historicalInvestmentCapacity.value?.sustainableCapacity).toBeNull();
    expect(result.historicalInvestmentCapacity.warnings.length).toBeGreaterThan(0);
    expect(result.investmentContributionDecision).toMatchObject({
      status: 'partial',
      value: { kind: 'hold' },
    });
  });

  it.each(SYNTHETIC_SCENARIO_IDS)('evaluates scenario %s deterministically', (scenarioId) => {
    const first = evaluateFinancialState(buildSyntheticScenario(scenarioId));
    const second = evaluateFinancialState(buildSyntheticScenario(scenarioId));
    expect(first).toEqual(second);
  });
});
