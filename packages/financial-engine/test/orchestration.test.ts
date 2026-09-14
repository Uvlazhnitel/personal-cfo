import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountBalanceSnapshot,
  createCalendarMonthCoverage,
  createCanonicalTransaction,
  createCashReconciliation,
  createCashReconciliationResolution,
  createExactFraction,
  createEconomicFlow,
  createFlowAmbiguity,
  createForecastPlannedExpense,
  createForwardProjectionCashFlow,
  createForwardLiquidityProjectionCoverage,
  createForwardLiquidityProtectionDay,
  createMoney,
  createNativeReportableAmount,
  createPortfolioValuation,
  createPrimarySalaryTrigger,
  createRecurringInvestmentSchedule,
  createSinkingFund,
  createSinkingFundAllocation,
  createSpendingObservation,
  createFutureObligation,
  parseAccountId,
  parseCashReconciliationId,
  parseCurrencyCode,
  parseEconomicFlowId,
  parseEntryId,
  parseForecastPlannedExpenseId,
  parseForwardProjectionFlowId,
  parseFutureObligationId,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseRecurringInvestmentPlanId,
  parseRecurringInvestmentOccurrenceId,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseSpendingCategoryId,
  parseTransactionId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type { CanonicalTransaction, CurrencyCode, LocalDate, Money } from '@personal-cfo/domain';

import {
  DEFAULT_FORECAST_SETTINGS,
  DEFAULT_INVESTMENT_STEP_SETTINGS,
  deriveInvestabilityReadiness,
  evaluateFinancialState,
  projectCanonicalFinancialFactsAt,
} from '../src/index.js';
import type { CheckpointQuality, FinancialEngineInput } from '../src/index.js';
import { addLocalDays } from '../src/local-calendar.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const AS_OF = parseInstant('2026-09-14T08:00:00Z');
const EFFECTIVE_DATE = parseLocalDate('2026-09-14');
const BANK_ID = parseAccountId(uuid(1));
const INVESTMENT_ID = parseAccountId(uuid(2));
const PLAN_ID = parseRecurringInvestmentPlanId(uuid(3));

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function completeCoverage(month: string) {
  return createCalendarMonthCoverage({
    month: parseYearMonth(month),
    reconciled: true,
    materialAmbiguityFree: true,
    fxComplete: true,
    spendingClassificationComplete: true,
  });
}

function protection(date: LocalDate) {
  const zero = money(0n);
  return createForwardLiquidityProtectionDay({
    date,
    ringFencedCash: zero,
    currentCycleSinkingDue: zero,
    uncoveredObligations: zero,
    operationalEssential: zero,
    operationalNormal: zero,
    minimumReserveTarget: zero,
    comfortReserveTarget: zero,
    completeness: 'complete',
  });
}

function ambiguityTransaction(materiality: 'material' | 'non_material') {
  const transactionId = parseTransactionId(uuid(materiality === 'material' ? 11 : 12));
  const effectiveAt = parseInstant('2026-09-10T08:00:00Z');
  return {
    transaction: createCanonicalTransaction({
      id: transactionId,
      effectiveAt,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        {
          id: parseEntryId(uuid(materiality === 'material' ? 21 : 22)),
          transactionId,
          accountId: BANK_ID,
          amount: money(-10_000n),
          role: 'external_flow',
        },
      ],
    }),
    ambiguity: createFlowAmbiguity({
      transactionId,
      effectiveAt,
      kind: 'unresolved_transfer',
      materiality,
    }),
  };
}

function input(ambiguity: 'none' | 'material' | 'non_material' = 'none'): FinancialEngineInput {
  const selected = ambiguity === 'none' ? null : ambiguityTransaction(ambiguity);
  const zero = money(0n);
  const quality: CheckpointQuality = {
    liquidityInputs: {
      operationalNeeds: 'complete',
      obligations: 'complete',
      restrictedCash: 'complete',
    },
    liquidBalance: 'complete',
    spendingClassification: 'complete',
    reservationHistory: 'complete',
  };
  return {
    run: {
      asOf: AS_OF,
      effectiveDate: EFFECTIVE_DATE,
      engineVersion: '2g.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'fixture-watermark',
    },
    settingsHistory: [
      {
        effectiveFrom: parseLocalDate('2025-01-01'),
        version: 'settings-1',
        spendingBaseline: {
          baselineWindowMonths: 6,
          minimumCompleteMonths: 3,
          maximumBaselineLookbackMonths: 36,
          materialityThreshold: money(25_000n),
          variabilityPercentile: createExactFraction(4n, 5n),
          seasonalityMinimumMonths: 24,
          seasonalityCap: createExactFraction(1n, 5n),
          fallbackNormalBaseline: null,
          fallbackEssentialBaseline: null,
        },
        liquidity: {
          minimumReserveMonths: createExactFraction(1n, 1n),
          comfortReserveMonths: createExactFraction(3n, 1n),
          unknownIncomeHorizonDays: 31,
          obligationHorizonDays: 90,
        },
        safeToInvest: { recommendationIncrement: money(1_000n) },
        cashDrag: {
          windowDays: 60,
          minimumCompleteDays: 54,
          minimumPositiveExcessDays: 45,
          absoluteExcessThreshold: money(25_000n),
          relativeComfortThreshold: createExactFraction(1n, 10n),
        },
        investmentStep: DEFAULT_INVESTMENT_STEP_SETTINGS,
        forecast: DEFAULT_FORECAST_SETTINGS,
      },
    ],
    canonical: {
      accounts: [
        createAccount({
          id: BANK_ID,
          subtype: 'bank',
          currency: EUR,
          includeInNetWorth: true,
          valueSource: 'balance_snapshot',
          brokerageCashFor: null,
        }),
        createAccount({
          id: INVESTMENT_ID,
          subtype: 'investment',
          currency: EUR,
          includeInNetWorth: true,
          valueSource: 'portfolio_valuation',
          brokerageCashFor: null,
        }),
      ],
      transactions: selected === null ? [] : [selected.transaction],
      investmentContributions: [],
      accountBalanceSnapshots: [
        createAccountBalanceSnapshot({
          accountId: BANK_ID,
          value: createNativeReportableAmount(money(1_000_000n)),
          sourceAsOf: parseInstant('2025-01-01T00:00:00Z'),
          staleAt: parseInstant('2027-01-01T00:00:00Z'),
        }),
      ],
      portfolioValuations: [
        createPortfolioValuation({
          accountId: INVESTMENT_ID,
          marketValue: createNativeReportableAmount(money(2_000_000n)),
          sourceAsOf: parseInstant('2025-01-01T00:00:00Z'),
          staleAt: parseInstant('2027-01-01T00:00:00Z'),
          brokerageCashTreatment: 'included_in_market_value',
        }),
      ],
      economicFlows: [],
      ambiguities: selected === null ? [] : [selected.ambiguity],
      cashReconciliations: [],
      cashReconciliationResolutions: [],
      sinkingFunds: [],
      sinkingFundAllocations: [],
      spendingObservations: [],
      primarySalaryTriggers: [],
      contributionAttributions: [],
    },
    current: {
      monthCoverage: [
        completeCoverage('2026-06'),
        completeCoverage('2026-07'),
        completeCoverage('2026-08'),
      ],
      scheduledRecurring: [],
      recurringScheduleComplete: true,
      operationalNeeds: [],
      futureObligations: [],
      otherRestrictedCash: [],
      nextReliableIncomeDate: parseLocalDate('2026-09-27'),
      expectedPrimaryPaySchedule: {
        dates: [],
        completeThrough: parseLocalDate('2027-12-31'),
      },
      historyCoverage: {
        startInclusive: parseInstant('2025-01-01T00:00:00Z'),
        endExclusive: parseInstant('2027-01-01T00:00:00Z'),
      },
      reservationCoverage: {
        startInclusive: parseInstant('2025-01-01T00:00:00Z'),
        endExclusive: parseInstant('2027-01-01T00:00:00Z'),
      },
      quality,
    },
    historicalCheckpoints: [],
    ccrPeriod: {
      startInclusive: parseInstant('2026-09-01T00:00:00Z'),
      endExclusive: parseInstant('2026-09-14T08:00:00Z'),
    },
    rollingCcrPeriods: [],
    forwardProjection: {
      cashFlows: [],
      protectionDays: Array.from({ length: 60 }, (_, index) =>
        protection(addLocalDays(EFFECTIVE_DATE, index + 1)),
      ),
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
    },
    recurringPlanId: PLAN_ID,
    currentRecurringContribution: zero,
    lastIssuedStepUpCycleIds: null,
    forecastPlan: { capitalFlows: [], plannedExpenses: [], includedOptionalExpenseIds: [] },
  };
}

function inputWithSalaryHistory(): FinancialEngineInput {
  const base = input();
  const openingId = parseTransactionId(uuid(150));
  const opening = createCanonicalTransaction({
    id: openingId,
    effectiveAt: parseInstant('2026-01-01T08:00:00Z'),
    bookingStatus: 'booked',
    kind: 'opening_balance',
    entries: [
      {
        id: parseEntryId(uuid(151)),
        transactionId: openingId,
        accountId: BANK_ID,
        amount: money(1_000_000n),
        role: 'opening_balance',
      },
    ],
  });
  const dates = ['2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'];
  const salaries = dates.map((date, index) => {
    const transactionId = parseTransactionId(uuid(200 + index));
    const effectiveAt = parseInstant(`${date}T08:00:00Z`);
    return {
      transaction: createCanonicalTransaction({
        id: transactionId,
        effectiveAt,
        bookingStatus: 'booked',
        kind: 'external_flow',
        entries: [
          {
            id: parseEntryId(uuid(210 + index)),
            transactionId,
            accountId: BANK_ID,
            amount: money(300_000n),
            role: 'external_flow',
          },
        ],
      }),
      flow: createEconomicFlow({
        id: parseEconomicFlowId(uuid(220 + index)),
        transactionId,
        effectiveAt,
        amount: money(300_000n),
        kind: 'earned_income',
        source: 'salary',
      }),
      trigger: createPrimarySalaryTrigger({
        transactionId,
        effectiveDate: parseLocalDate(date),
      }),
    };
  });
  const monthCoverage = [
    '2026-01',
    '2026-02',
    '2026-03',
    '2026-04',
    '2026-05',
    '2026-06',
    '2026-07',
    '2026-08',
  ].map(completeCoverage);
  const current = {
    ...base.current,
    monthCoverage,
    expectedPrimaryPaySchedule: {
      dates: [parseLocalDate('2026-09-27')],
      completeThrough: parseLocalDate('2027-12-31'),
    },
  };
  const variables = {
    economicFlows: salaries.map((item) => item.flow),
    ambiguities: [],
    cashReconciliations: [],
    sinkingFunds: [],
    sinkingFundAllocations: [],
    spendingObservations: [],
  };
  const historicalCheckpoints = salaries.slice(0, 4).map((salary, index) => ({
    kind: 'pre_closing' as const,
    payCycleId: parsePayCycleId(salary.transaction.id),
    ...current,
    nextReliableIncomeDate: parseLocalDate(dates[index + 1]!),
    expectedPrimaryPaySchedule: {
      dates: [parseLocalDate(dates[index + 1]!)],
      completeThrough: parseLocalDate('2027-12-31'),
    },
  }));
  return {
    ...base,
    canonical: {
      ...base.canonical,
      accounts: [
        createAccount({
          id: BANK_ID,
          subtype: 'cash',
          currency: EUR,
          includeInNetWorth: true,
          valueSource: 'ledger',
          brokerageCashFor: null,
        }),
        base.canonical.accounts[1]!,
      ],
      transactions: [opening, ...salaries.map((item) => item.transaction)],
      accountBalanceSnapshots: [],
      economicFlows: variables.economicFlows,
      primarySalaryTriggers: salaries.map((item) => item.trigger),
    },
    current,
    historicalCheckpoints,
    ccrPeriod: {
      startInclusive: parseInstant('2026-08-01T00:00:00Z'),
      endExclusive: AS_OF,
    },
  };
}

function integratedInput(): FinancialEngineInput {
  const base = inputWithSalaryHistory();
  const fund = createSinkingFund({
    id: parseSinkingFundId(uuid(600)),
    label: 'Annual trip',
    target: money(120_000n),
    dueDate: parseLocalDate('2026-12-15'),
    priority: 1,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: parseInstant('2026-04-01T09:00:00Z'),
  });
  const allocation = createSinkingFundAllocation({
    id: parseSinkingFundAllocationId(uuid(601)),
    fundId: fund.id,
    amount: money(60_000n),
    effectiveAt: parseInstant('2026-04-02T09:00:00Z'),
    kind: 'allocation',
  });
  const obligation = createFutureObligation({
    id: parseFutureObligationId(uuid(602)),
    dueDate: parseLocalDate('2026-10-15'),
    amount: { kind: 'exact', amount: money(90_000n) },
    priority: 'mandatory',
    committed: true,
    status: 'open',
    coverage: { kind: 'uncovered' },
  });
  const scheduleDates = [
    '2026-05-01',
    '2026-06-01',
    '2026-07-01',
    '2026-08-01',
    '2026-09-27',
    '2026-10-27',
    '2026-11-27',
  ].map(parseLocalDate);
  const current = {
    ...base.current,
    futureObligations: [obligation],
    expectedPrimaryPaySchedule: {
      dates: scheduleDates,
      completeThrough: parseLocalDate('2026-12-15'),
    },
  };
  const preClosing = base.historicalCheckpoints.map((checkpoint) => ({
    ...checkpoint,
    expectedPrimaryPaySchedule: current.expectedPrimaryPaySchedule,
  }));
  const cashDragDays = Array.from({ length: 59 }, (_, index) => ({
    kind: 'cash_drag_day' as const,
    date: addLocalDays(EFFECTIVE_DATE, index - 59),
    ...current,
  }));
  const obligationDate = parseLocalDate('2026-10-15');
  return {
    ...base,
    canonical: {
      ...base.canonical,
      sinkingFunds: [fund],
      sinkingFundAllocations: [allocation],
    },
    current,
    historicalCheckpoints: [...preClosing, ...cashDragDays],
    forwardProjection: {
      cashFlows: [
        createForwardProjectionCashFlow({
          id: parseForwardProjectionFlowId(uuid(603)),
          date: obligationDate,
          kind: 'committed_obligation',
          amount: money(90_000n),
        }),
      ],
      protectionDays: Array.from({ length: 60 }, (_, index) => {
        const date = addLocalDays(EFFECTIVE_DATE, index + 1);
        return createForwardLiquidityProtectionDay({
          date,
          ringFencedCash: money(60_000n),
          currentCycleSinkingDue: money(15_000n),
          uncoveredObligations: date <= obligationDate ? money(90_000n) : money(0n),
          operationalEssential: money(0n),
          operationalNormal: money(0n),
          minimumReserveTarget: money(0n),
          comfortReserveTarget: money(0n),
          completeness: 'complete',
        });
      }),
      coverage: createForwardLiquidityProjectionCoverage({
        expectedPrimarySalary: 'complete',
        normalSpending: 'complete',
        committedObligations: 'complete',
        sinkingProtection: 'complete',
      }),
      contributionSchedule: createRecurringInvestmentSchedule({
        planId: PLAN_ID,
        occurrences: [
          {
            id: parseRecurringInvestmentOccurrenceId(uuid(604)),
            planId: PLAN_ID,
            date: parseLocalDate('2026-09-20'),
          },
          {
            id: parseRecurringInvestmentOccurrenceId(uuid(605)),
            planId: PLAN_ID,
            date: parseLocalDate('2026-10-20'),
          },
        ],
        completeThrough: addLocalDays(EFFECTIVE_DATE, 60),
      }),
    },
    forecastPlan: {
      capitalFlows: [],
      plannedExpenses: [
        createForecastPlannedExpense({
          id: parseForecastPlannedExpenseId(uuid(606)),
          dueMonth: parseYearMonth('2027-01'),
          amount: {
            kind: 'range',
            lower: money(70_000n),
            upper: money(90_000n),
          },
          priority: 'mandatory',
          committed: true,
        }),
      ],
      includedOptionalExpenseIds: [],
    },
  };
}

function withHistoricalConsumption(base: FinancialEngineInput): FinancialEngineInput {
  const transactions = [];
  const flows = [];
  const observations = [];
  for (const [index, month] of ['01', '02', '03'].entries()) {
    const transactionId = parseTransactionId(uuid(700 + index));
    const effectiveAt = parseInstant(`2026-${month}-15T08:00:00Z`);
    const flowId = parseEconomicFlowId(uuid(710 + index));
    transactions.push(
      createCanonicalTransaction({
        id: transactionId,
        effectiveAt,
        bookingStatus: 'booked',
        kind: 'external_flow',
        entries: [
          {
            id: parseEntryId(uuid(720 + index)),
            transactionId,
            accountId: BANK_ID,
            amount: money(-30_000n),
            role: 'external_flow',
          },
        ],
      }),
    );
    flows.push(
      createEconomicFlow({
        id: flowId,
        transactionId,
        effectiveAt,
        amount: money(30_000n),
        kind: 'consumption',
        reimbursable: false,
      }),
    );
    observations.push(
      createSpendingObservation({
        economicFlowId: flowId,
        economicDate: parseLocalDate(`2026-${month}-15`),
        categoryId: parseSpendingCategoryId(uuid(730)),
        necessity: 'essential',
        cadence: 'variable',
        irregular: false,
      }),
    );
  }
  return {
    ...base,
    canonical: {
      ...base.canonical,
      transactions: [...base.canonical.transactions, ...transactions],
      economicFlows: [...base.canonical.economicFlows, ...flows],
      spendingObservations: observations,
    },
  };
}

function withHistoricalSinkingAllocation(base: FinancialEngineInput): FinancialEngineInput {
  const fund = createSinkingFund({
    id: parseSinkingFundId(uuid(740)),
    label: 'Historical reserve',
    target: money(100_000n),
    dueDate: parseLocalDate('2026-12-15'),
    priority: 1,
    committed: false,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: parseInstant('2026-04-02T09:00:00Z'),
  });
  const allocation = createSinkingFundAllocation({
    id: parseSinkingFundAllocationId(uuid(741)),
    fundId: fund.id,
    amount: money(50_000n),
    effectiveAt: parseInstant('2026-04-03T09:00:00Z'),
    kind: 'allocation',
  });
  return {
    ...base,
    canonical: {
      ...base.canonical,
      sinkingFunds: [fund],
      sinkingFundAllocations: [allocation],
    },
  };
}

function withCashReconciliation(
  base: FinancialEngineInput,
  options: Readonly<{
    materiality?: 'material' | 'non_material';
    resolutionKind?: 'reclassified_adjustment' | 'reversed_adjustment' | null;
    reversalAmount?: bigint;
    reversalAccountId?: typeof BANK_ID;
    reversalCurrency?: CurrencyCode;
    reversalEffectiveAt?: string;
    resolutionTransactionKind?: 'valuation_adjustment' | 'opening_balance';
    includeUnrelatedReversalEntry?: boolean;
  }> = {},
): FinancialEngineInput {
  const adjustmentTransactionId = parseTransactionId(uuid(750));
  const reconciliationId = parseCashReconciliationId(uuid(751));
  const reconciledAt = parseInstant('2026-06-05T08:00:00Z');
  const adjustment = createCanonicalTransaction({
    id: adjustmentTransactionId,
    effectiveAt: reconciledAt,
    bookingStatus: 'booked',
    kind: 'valuation_adjustment',
    entries: [
      {
        id: parseEntryId(uuid(752)),
        transactionId: adjustmentTransactionId,
        accountId: BANK_ID,
        amount: money(-1_500n),
        role: 'valuation_adjustment',
      },
    ],
  });
  const adjustmentFlow = createEconomicFlow({
    id: parseEconomicFlowId(uuid(753)),
    transactionId: adjustmentTransactionId,
    effectiveAt: reconciledAt,
    amount: money(-1_500n),
    kind: 'cash_reconciliation_adjustment',
  });
  const reconciliation = createCashReconciliation({
    id: reconciliationId,
    accountId: BANK_ID,
    calculatedBalance: money(14_000n),
    countedBalance: money(12_500n),
    variance: money(-1_500n),
    reconciledAt,
    actor: 'fixture-user',
    reason: null,
    materiality: options.materiality ?? 'non_material',
    adjustmentTransactionId,
  });
  const resolutionKind = options.resolutionKind ?? null;
  let resolutionTransaction: CanonicalTransaction | null = null;
  if (resolutionKind === 'reversed_adjustment') {
    const transactionId = parseTransactionId(uuid(754));
    const kind = options.resolutionTransactionKind ?? 'valuation_adjustment';
    resolutionTransaction = createCanonicalTransaction({
      id: transactionId,
      effectiveAt: parseInstant(options.reversalEffectiveAt ?? '2026-06-08T08:00:00Z'),
      bookingStatus: 'booked',
      kind,
      entries: [
        {
          id: parseEntryId(uuid(755)),
          transactionId,
          accountId: options.reversalAccountId ?? BANK_ID,
          amount: createMoney(options.reversalAmount ?? 1_500n, options.reversalCurrency ?? EUR),
          role: kind === 'valuation_adjustment' ? 'valuation_adjustment' : 'opening_balance',
        },
        ...(options.includeUnrelatedReversalEntry === true && kind === 'valuation_adjustment'
          ? [
              {
                id: parseEntryId(uuid(756)),
                transactionId,
                accountId: INVESTMENT_ID,
                amount: money(700n),
                role: 'valuation_adjustment' as const,
              },
            ]
          : []),
      ],
    });
  }
  const resolution =
    resolutionKind === null
      ? null
      : createCashReconciliationResolution({
          kind: resolutionKind,
          reconciliationId,
          resolvedAt: parseInstant('2026-06-10T08:00:00Z'),
          resolutionTransactionId:
            resolutionKind === 'reclassified_adjustment'
              ? adjustmentTransactionId
              : resolutionTransaction!.id,
        });
  return {
    ...base,
    canonical: {
      ...base.canonical,
      transactions: [
        ...base.canonical.transactions,
        adjustment,
        ...(resolutionTransaction === null ? [] : [resolutionTransaction]),
      ],
      economicFlows: [...base.canonical.economicFlows, adjustmentFlow],
      cashReconciliations: [reconciliation],
      cashReconciliationResolutions: resolution === null ? [] : [resolution],
    },
  };
}

describe('financial state orchestration', () => {
  it('derives complete, provisional, and blocked investability from structured facts', () => {
    const complete = evaluateFinancialState(input());
    const provisional = evaluateFinancialState(input('non_material'));
    const blocked = evaluateFinancialState(input('material'));

    expect(complete.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(complete.safeToInvest.status).toBe('complete');
    expect(provisional.investabilityReadiness).toEqual({
      kind: 'provisional',
      reasons: ['non_material_unresolved_transfer'],
    });
    expect(provisional.safeToInvest.status).toBe('partial');
    expect(provisional.cashDrag.value?.eligible).toBe(false);
    expect(blocked.investabilityReadiness).toEqual({
      kind: 'blocked',
      reasons: ['material_unresolved_transfer'],
    });
    expect(blocked.safeToInvest.status).toBe('unavailable');
    expect(blocked.investmentContributionDecision.value?.kind).not.toBe('step_up');
  });

  it('uses one current metadata envelope and returns independent forecast despite unavailable CCR', () => {
    const result = evaluateFinancialState(input());
    const metrics = [
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
    expect(metrics.every((item) => item.asOf === AS_OF)).toBe(true);
    expect(metrics.every((item) => item.engineVersion === '2g.0.0')).toBe(true);
    expect(metrics.every((item) => item.settingsVersion === 'settings-1')).toBe(true);
    expect(metrics.every((item) => item.inputWatermark === 'fixture-watermark')).toBe(true);
    expect(result.ccr.status).toBe('unavailable');
    expect(result.forecast.status).toBe('complete');
    expect(result.forecast.value?.forecastStartMonth).toBe('2026-10');
    expect(result.netWorth.value?.total.amountMinor).toBe(3_000_000n);
  });

  it('derives four pre-closing STI snapshots and excludes each closing salary boundary', () => {
    const result = evaluateFinancialState(inputWithSalaryHistory());
    expect(result.payCycles.map((item) => item.status)).toEqual([
      'closed',
      'closed',
      'closed',
      'closed',
      'open',
    ]);
    expect(result.historicalInvestmentCapacity.status).toBe('complete');
    const capacity = result.historicalInvestmentCapacity.value!;
    expect(capacity.observations[0]!.preClosingRecommendedSafeToInvest?.amountMinor).toBe(
      1_300_000n,
    );
    expect(capacity.sustainableCapacity?.amountMinor).toBe(1_750_000n);
    expect(result.ccr.value?.recognizedIncome.amountMinor).toBe(300_000n);
  });

  it('derives historical consumption and Sinking protection from root canonical history', () => {
    const base = evaluateFinancialState(inputWithSalaryHistory());
    const withConsumption = evaluateFinancialState(
      withHistoricalConsumption(inputWithSalaryHistory()),
    );
    const withSinking = evaluateFinancialState(
      withHistoricalSinkingAllocation(inputWithSalaryHistory()),
    );
    const baseFirst =
      base.historicalInvestmentCapacity.value!.observations[0]!.preClosingRecommendedSafeToInvest!
        .amountMinor;
    expect(
      withConsumption.historicalInvestmentCapacity.value!.observations[0]!
        .preClosingRecommendedSafeToInvest!.amountMinor,
    ).toBeLessThan(baseFirst);
    expect(
      withSinking.historicalInvestmentCapacity.value!.observations[0]!
        .preClosingRecommendedSafeToInvest!.amountMinor,
    ).toBe(baseFirst - 50_000n);
  });

  it('cannot hide canonical material ambiguity from historical capacity', () => {
    const base = inputWithSalaryHistory();
    const transactionId = parseTransactionId(uuid(760));
    const effectiveAt = parseInstant('2026-06-10T08:00:00Z');
    const transaction = createCanonicalTransaction({
      id: transactionId,
      effectiveAt,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        {
          id: parseEntryId(uuid(761)),
          transactionId,
          accountId: BANK_ID,
          amount: money(-10_000n),
          role: 'external_flow',
        },
      ],
    });
    const ambiguity = createFlowAmbiguity({
      transactionId,
      effectiveAt,
      kind: 'unresolved_transfer',
      materiality: 'material',
    });
    const result = evaluateFinancialState({
      ...base,
      canonical: {
        ...base.canonical,
        transactions: [...base.canonical.transactions, transaction],
        ambiguities: [ambiguity],
      },
    });
    expect(result.historicalInvestmentCapacity.status).toBe('partial');
    expect(
      result.historicalInvestmentCapacity.value?.observations.some((item) =>
        item.issues.includes('missing_cycle_readiness'),
      ),
    ).toBe(true);
  });

  it('cannot hide an active material reconciliation from historical capacity', () => {
    const result = evaluateFinancialState(
      withCashReconciliation(inputWithSalaryHistory(), { materiality: 'material' }),
    );
    expect(result.historicalInvestmentCapacity.status).toBe('partial');
    expect(
      result.historicalInvestmentCapacity.value?.observations.some((item) =>
        item.issues.includes('missing_cycle_readiness'),
      ),
    ).toBe(true);
    expect(result.safeToInvest.status).toBe('unavailable');
    expect(result.cashDrag.status).toBe('unavailable');
    expect(result.investmentContributionDecision.value?.kind).not.toBe('step_up');
  });

  it('keeps a reconciliation active through resolvedAt and validates both resolution mechanisms', () => {
    const reclassified = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reclassified_adjustment',
    });
    expect(
      projectCanonicalFinancialFactsAt(reclassified.canonical, parseInstant('2026-06-05T23:59:59Z'))
        .cashReconciliations,
    ).toHaveLength(1);
    expect(
      projectCanonicalFinancialFactsAt(reclassified.canonical, parseInstant('2026-06-09T23:59:59Z'))
        .cashReconciliations,
    ).toHaveLength(1);
    expect(
      projectCanonicalFinancialFactsAt(reclassified.canonical, parseInstant('2026-06-15T00:00:00Z'))
        .cashReconciliations,
    ).toHaveLength(0);

    const reversed = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reversed_adjustment',
      includeUnrelatedReversalEntry: true,
    });
    expect(
      projectCanonicalFinancialFactsAt(reversed.canonical, parseInstant('2026-06-15T00:00:00Z'))
        .cashReconciliations,
    ).toHaveLength(0);
  });

  it('rejects a reclassification that references a different transaction', () => {
    const base = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reclassified_adjustment',
    });
    expect(() =>
      projectCanonicalFinancialFactsAt(
        {
          ...base.canonical,
          cashReconciliationResolutions: [
            {
              ...base.canonical.cashReconciliationResolutions[0]!,
              resolutionTransactionId: base.canonical.transactions[0]!.id,
            },
          ],
        },
        parseInstant('2026-06-15T00:00:00Z'),
      ),
    ).toThrowError(/adjustment transaction itself/u);
  });

  it('validates the original adjustment even when the reconciliation is resolved', () => {
    const base = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reclassified_adjustment',
    });
    expect(() =>
      projectCanonicalFinancialFactsAt(
        {
          ...base.canonical,
          cashReconciliations: [
            {
              ...base.canonical.cashReconciliations[0]!,
              adjustmentTransactionId: base.canonical.transactions[0]!.id,
            },
          ],
        },
        parseInstant('2026-06-15T00:00:00Z'),
      ),
    ).toThrowError(/booked audited adjustment/u);
  });

  it('rejects duplicate resolution facts for one reconciliation', () => {
    const base = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reclassified_adjustment',
    });
    expect(() =>
      projectCanonicalFinancialFactsAt(
        {
          ...base.canonical,
          cashReconciliationResolutions: [
            base.canonical.cashReconciliationResolutions[0]!,
            base.canonical.cashReconciliationResolutions[0]!,
          ],
        },
        parseInstant('2026-06-15T00:00:00Z'),
      ),
    ).toThrowError(/only one active resolution/u);
  });

  it.each([
    ['wrong amount', { reversalAmount: 1_499n }, /exactly negate/u],
    ['wrong account', { reversalAccountId: INVESTMENT_ID }, /exactly negate/u],
    ['wrong currency', { reversalCurrency: parseCurrencyCode('USD') }, /exactly negate/u],
    [
      'unrelated transaction',
      { resolutionTransactionKind: 'opening_balance' },
      /valuation adjustment/u,
    ],
    ['premature reversal', { reversalEffectiveAt: '2026-06-04T08:00:00Z' }, /resolution interval/u],
  ] as const)('rejects a %s as reconciliation reversal proof', (_label, override, expected) => {
    const base = withCashReconciliation(inputWithSalaryHistory(), {
      resolutionKind: 'reversed_adjustment',
      ...override,
    });
    expect(() =>
      projectCanonicalFinancialFactsAt(base.canonical, parseInstant('2026-06-15T00:00:00Z')),
    ).toThrowError(expected);
  });

  it('keeps non-material cash variance provisional until its valid resolution instant', () => {
    const unresolved = evaluateFinancialState(withCashReconciliation(inputWithSalaryHistory()));
    const resolved = evaluateFinancialState(
      withCashReconciliation(inputWithSalaryHistory(), {
        resolutionKind: 'reclassified_adjustment',
      }),
    );
    expect(unresolved.investabilityReadiness).toEqual({
      kind: 'provisional',
      reasons: ['non_material_cash_variance'],
    });
    expect(unresolved.safeToInvest.status).toBe('partial');
    expect(resolved.investabilityReadiness).toEqual({ kind: 'complete' });
    expect(resolved.safeToInvest.status).toBe('complete');
  });

  it('produces one coherent golden state across every Stage 2 branch', () => {
    const result = evaluateFinancialState(integratedInput());
    expect(result.netWorth.status).toBe('complete');
    expect(result.ccr.status).toBe('complete');
    expect(result.currentCycleSinkingDue.status).toBe('complete');
    expect(result.currentCycleSinkingDue.value?.totalReserved.amountMinor).toBe(60_000n);
    expect(result.spendingBaseline.status).toBe('complete');
    expect(result.liquidityReserve.status).toBe('complete');
    expect(result.liquidityReserve.value?.uncoveredObligations.amountMinor).toBe(90_000n);
    expect(result.safeToInvest.status).toBe('complete');
    expect(result.cashDrag.status).toBe('complete');
    expect(result.historicalInvestmentCapacity.status).toBe('complete');
    expect(result.investmentContributionDecision.value?.kind).toBe('step_up');
    expect(result.forecast.status).toBe('complete');
    const zero = result.forecast.value?.scenarios.find(
      (scenario) => scenario.assumption.annualReturnRate === '0',
    );
    expect(zero?.monthlyPath[3]?.value?.plannedExpenses.amountMinor).toBe(90_000n);
  });

  it('marks a pre-closing observation incomplete when same-date activity follows day close', () => {
    const base = inputWithSalaryHistory();
    const transactionId = parseTransactionId(uuid(500));
    const effectiveAt = parseInstant('2026-05-01T07:00:00Z');
    const transaction = createCanonicalTransaction({
      id: transactionId,
      effectiveAt,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        {
          id: parseEntryId(uuid(501)),
          transactionId,
          accountId: BANK_ID,
          amount: money(-10_000n),
          role: 'external_flow',
        },
      ],
    });
    const flow = createEconomicFlow({
      id: parseEconomicFlowId(uuid(502)),
      transactionId,
      effectiveAt,
      amount: money(-10_000n),
      kind: 'other_external_flow',
    });
    const result = evaluateFinancialState({
      ...base,
      canonical: {
        ...base.canonical,
        transactions: [...base.canonical.transactions, transaction],
        economicFlows: [...base.canonical.economicFlows, flow],
      },
    });
    expect(result.historicalInvestmentCapacity.status).toBe('partial');
    expect(result.historicalInvestmentCapacity.value?.observations[0]?.issues).toContain(
      'missing_cycle_readiness',
    );
  });

  it('is deterministic and invariant to semantically unordered projection rows', () => {
    const original = input();
    const reversed: FinancialEngineInput = {
      ...original,
      forwardProjection: {
        ...original.forwardProjection,
        protectionDays: [...original.forwardProjection.protectionDays].reverse(),
      },
    };
    expect(evaluateFinancialState(reversed)).toEqual(evaluateFinancialState(original));
    expect(evaluateFinancialState(original)).toEqual(evaluateFinancialState(original));
  });

  it('is invariant to canonical variable-fact and resolution ordering', () => {
    const original = withCashReconciliation(
      withHistoricalSinkingAllocation(withHistoricalConsumption(inputWithSalaryHistory())),
      { resolutionKind: 'reversed_adjustment' },
    );
    const reversed: FinancialEngineInput = {
      ...original,
      canonical: {
        ...original.canonical,
        economicFlows: [...original.canonical.economicFlows].reverse(),
        ambiguities: [...original.canonical.ambiguities].reverse(),
        cashReconciliations: [...original.canonical.cashReconciliations].reverse(),
        cashReconciliationResolutions: [
          ...original.canonical.cashReconciliationResolutions,
        ].reverse(),
        sinkingFunds: [...original.canonical.sinkingFunds].reverse(),
        sinkingFundAllocations: [...original.canonical.sinkingFundAllocations].reverse(),
        spendingObservations: [...original.canonical.spendingObservations].reverse(),
      },
    };
    expect(evaluateFinancialState(reversed)).toEqual(evaluateFinancialState(original));
  });

  it('builds Cash Drag observations from historical liquidity without upgrading partial days', () => {
    const base = input();
    const date = parseLocalDate('2026-09-13');
    const checkpoint = {
      kind: 'cash_drag_day' as const,
      date,
      ...base.current,
      quality: {
        ...base.current.quality,
        liquidityInputs: {
          ...base.current.quality.liquidityInputs,
          operationalNeeds: 'partial' as const,
        },
      },
    };
    const result = evaluateFinancialState({ ...base, historicalCheckpoints: [checkpoint] });
    expect(result.cashDrag.value?.completeDays).toBe(1);
    expect(result.cashDrag.value?.incompleteDays).toBe(1);
    expect(result.cashDrag.status).toBe('partial');
    expect(result.cashDrag.value?.eligible).toBe(false);
  });

  it('rejects an authoritative economic flow that is not linked to a booked transaction', () => {
    const broken = input();
    const transactionId = parseTransactionId(uuid(100));
    const pending = createCanonicalTransaction({
      id: transactionId,
      effectiveAt: parseInstant('2026-09-05T08:00:00Z'),
      bookingStatus: 'pending',
      kind: 'external_flow',
      entries: [
        {
          id: parseEntryId(uuid(101)),
          transactionId,
          accountId: BANK_ID,
          amount: money(1_000n),
          role: 'external_flow',
        },
      ],
    });
    expect(() =>
      evaluateFinancialState({
        ...broken,
        canonical: {
          ...broken.canonical,
          transactions: [pending],
          economicFlows: [
            {
              id: parseEconomicFlowId(uuid(102)),
              transactionId,
              effectiveAt: pending.effectiveAt,
              amount: money(1_000n),
              kind: 'earned_income',
              source: 'salary',
            },
          ],
        },
      }),
    ).toThrowError(/booked canonical transactions/u);
  });
});

describe('investability readiness derivation', () => {
  it('does not derive readiness from warning text', () => {
    const evaluated = evaluateFinancialState(input());
    const quality = input().current.quality;
    const first = deriveInvestabilityReadiness({
      positions: evaluated.positions,
      baseline: evaluated.spendingBaseline,
      sinkingProtection: evaluated.currentCycleSinkingDue,
      liquidity: evaluated.liquidityReserve,
      quality,
      nextReliableIncomeDate: parseLocalDate('2026-09-27'),
      ambiguities: [],
      cashReconciliations: [],
    });
    const second = deriveInvestabilityReadiness({
      positions: evaluated.positions,
      baseline: {
        ...evaluated.spendingBaseline,
        warnings: [{ code: 'harmless.changed', context: {} }],
      },
      sinkingProtection: evaluated.currentCycleSinkingDue,
      liquidity: evaluated.liquidityReserve,
      quality,
      nextReliableIncomeDate: parseLocalDate('2026-09-27'),
      ambiguities: [],
      cashReconciliations: [],
    });
    expect(first).toEqual({ kind: 'complete' });
    expect(second).toEqual(first);
  });
});
