import {
  EUR,
  createAccountBalanceSnapshot,
  createCalendarMonthCoverage,
  createCanonicalTransaction,
  createExactFraction,
  createFlowAmbiguity,
  createForecastCapitalFlow,
  createForecastPlannedExpense,
  createForwardLiquidityProjectionCoverage,
  createForwardLiquidityProtectionDay,
  createForwardProjectionCashFlow,
  createMoney,
  createNativeReportableAmount,
  createOperationalNeed,
  createPortfolioValuation,
  createRecurringInvestmentSchedule,
  createScheduledSpending,
  parseEntryId,
  parseForecastCapitalFlowId,
  parseForecastPlannedExpenseId,
  parseForwardProjectionFlowId,
  parseInstant,
  parseLocalDate,
  parseOperationalNeedId,
  parsePayCycleId,
  parseRecurringInvestmentOccurrenceId,
  parseScheduledSpendingId,
  parseTransactionId,
  parseYearMonth,
} from '@personal-cfo/domain';
import type {
  AccountBalanceSnapshot,
  CanonicalTransaction,
  FlowAmbiguity,
  Instant,
  LocalDate,
  Money,
  PortfolioValuation,
  YearMonth,
} from '@personal-cfo/domain';

import { DEFAULT_FORECAST_SETTINGS, DEFAULT_INVESTMENT_STEP_SETTINGS } from '../../../src/index.js';
import type {
  CheckpointQuality,
  FinancialCheckpointContext,
  FinancialEngineCanonicalFacts,
  FinancialEngineInput,
  FinancialEngineSettings,
  HistoricalFinancialCheckpoint,
} from '../../../src/index.js';
import { addLocalDays, addYearMonths, daysInGregorianMonth } from '../../../src/local-calendar.js';
import {
  SYNTHETIC_AS_OF,
  SYNTHETIC_EFFECTIVE_DATE,
  SYNTHETIC_HISTORY_END,
  SYNTHETIC_HISTORY_START,
  SYNTHETIC_IDS,
  SYNTHETIC_MONTHS,
  SYNTHETIC_SALARY_DATES,
  buildSyntheticFinancialLife,
  syntheticUuid,
} from './synthetic-financial-life.js';

export const SYNTHETIC_SCENARIO_IDS = Object.freeze([
  'healthy_current',
  'trip_before_purchase',
  'trip_after_purchase',
  'cash_variance_before',
  'cash_variance_unresolved',
  'cash_variance_resolved',
  'material_transfer_unresolved',
  'material_transfer_resolved_variant',
  'sinking_due_before_allocation',
  'sinking_due_after_allocation',
  'historical_incomplete_month',
] as const);

export type SyntheticScenarioId = (typeof SYNTHETIC_SCENARIO_IDS)[number];

const SCENARIO_BOUNDARIES: Readonly<Record<SyntheticScenarioId, readonly [Instant, LocalDate]>> = {
  healthy_current: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
  trip_before_purchase: [parseInstant('2026-06-11T08:00:00Z'), parseLocalDate('2026-06-11')],
  trip_after_purchase: [parseInstant('2026-06-13T08:00:00Z'), parseLocalDate('2026-06-13')],
  cash_variance_before: [parseInstant('2026-08-19T08:00:00Z'), parseLocalDate('2026-08-19')],
  cash_variance_unresolved: [parseInstant('2026-08-22T08:00:00Z'), parseLocalDate('2026-08-22')],
  cash_variance_resolved: [parseInstant('2026-08-26T08:00:00Z'), parseLocalDate('2026-08-26')],
  material_transfer_unresolved: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
  material_transfer_resolved_variant: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
  sinking_due_before_allocation: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
  sinking_due_after_allocation: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
  historical_incomplete_month: [SYNTHETIC_AS_OF, SYNTHETIC_EFFECTIVE_DATE],
};

const COMPLETE_QUALITY: CheckpointQuality = Object.freeze({
  liquidityInputs: Object.freeze({
    operationalNeeds: 'complete',
    obligations: 'complete',
    restrictedCash: 'complete',
  }),
  liquidBalance: 'complete',
  spendingClassification: 'complete',
  reservationHistory: 'complete',
});

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

function nextMonth(month: YearMonth): YearMonth {
  return addYearMonths(month, 1);
}

function monthOf(date: LocalDate): YearMonth {
  return parseYearMonth(date.slice(0, 7));
}

function endOfMonth(month: YearMonth): LocalDate {
  return parseLocalDate(
    `${month}-${daysInGregorianMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)))
      .toString()
      .padStart(2, '0')}`,
  );
}

function completeCoverage(incompleteMonth: YearMonth | null = null) {
  return SYNTHETIC_MONTHS.map((month) =>
    createCalendarMonthCoverage({
      month: parseYearMonth(month),
      reconciled: month !== incompleteMonth,
      materialAmbiguityFree: true,
      fxComplete: true,
      spendingClassificationComplete: true,
    }),
  );
}

function scheduledRecurring(month: YearMonth) {
  const utilityMonth = Number(month.slice(5, 7));
  const utility =
    utilityMonth >= 11 || utilityMonth <= 3
      ? 18_000n
      : utilityMonth === 4 || utilityMonth === 10
        ? 13_000n
        : 9_000n;
  const rows = [
    [3, 90_000n, 'essential'],
    [6, utility, 'essential'],
    [9, 4_500n, 'essential'],
    [12, 5_000n, 'essential'],
    [15, 1_500n, 'discretionary'],
  ] as const;
  const ordinal = (Number(month.slice(0, 4)) - 2024) * 12 + Number(month.slice(5, 7));
  return rows.map(([day, amountMinor, necessity], index) =>
    createScheduledSpending({
      id: parseScheduledSpendingId(syntheticUuid(20, ordinal * 10 + index)),
      dueDate: parseLocalDate(`${month}-${day.toString().padStart(2, '0')}`),
      amount: money(amountMinor),
      necessity,
    }),
  );
}

function nextSalaryDate(date: LocalDate): LocalDate | null {
  const value = SYNTHETIC_SALARY_DATES.find((salaryDate) => salaryDate > date);
  if (value !== undefined) return parseLocalDate(value);
  if (date < '2026-09-28') return parseLocalDate('2026-09-28');
  if (date < '2026-10-28') return parseLocalDate('2026-10-28');
  return null;
}

function expectedPayDates(date: LocalDate): readonly LocalDate[] {
  return ['2026-09-28', '2026-10-28']
    .filter((item) => item > date)
    .map((item) => parseLocalDate(item));
}

function monthsIntersectingInterval(date: LocalDate, nextIncome: LocalDate): readonly YearMonth[] {
  const endMonth = monthOf(nextIncome);
  const months: YearMonth[] = [];
  for (let month = monthOf(date); month <= endMonth; month = addYearMonths(month, 1)) {
    months.push(month);
  }
  return Object.freeze(months);
}

function operationalNeeds(date: LocalDate, nextIncome: LocalDate | null) {
  if (nextIncome === null) return [];
  return monthsIntersectingInterval(date, nextIncome)
    .flatMap((month) => scheduledRecurring(month))
    .filter((item) => item.dueDate > date && item.dueDate < nextIncome)
    .sort(
      (left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id),
    )
    .map((item, index) =>
      createOperationalNeed({
        id: parseOperationalNeedId(syntheticUuid(21, Number(date.replaceAll('-', '')) + index)),
        dueDate: item.dueDate,
        amount: item.amount,
        necessity: item.necessity,
        direction: 'debit',
        state: 'scheduled',
        scheduledSpendingId: item.id,
      }),
    );
}

function contextFor(
  date: LocalDate,
  input: Readonly<{ incompleteMonth?: YearMonth; incompleteQuality?: boolean }> = {},
): FinancialCheckpointContext {
  const nextIncome = nextSalaryDate(date);
  const targetMonth = monthOf(date);
  const life = buildSyntheticFinancialLife();
  const obligations = life.futureObligations.filter(
    (item) => item.coverage.kind !== 'sinking_fund' || date >= '2026-07-10',
  );
  const quality = input.incompleteQuality
    ? Object.freeze({
        ...COMPLETE_QUALITY,
        spendingClassification: 'partial' as const,
      })
    : COMPLETE_QUALITY;
  return Object.freeze({
    monthCoverage: Object.freeze(completeCoverage(input.incompleteMonth ?? null)),
    scheduledRecurring: Object.freeze(scheduledRecurring(targetMonth)),
    recurringScheduleComplete: true,
    operationalNeeds: Object.freeze(operationalNeeds(date, nextIncome)),
    futureObligations: Object.freeze(obligations),
    otherRestrictedCash: Object.freeze([]),
    nextReliableIncomeDate: nextIncome,
    expectedPrimaryPaySchedule: Object.freeze({
      dates: Object.freeze(expectedPayDates(date)),
      completeThrough: parseLocalDate('2026-12-31'),
    }),
    historyCoverage: Object.freeze({
      startInclusive: SYNTHETIC_HISTORY_START,
      endExclusive: SYNTHETIC_HISTORY_END,
    }),
    reservationCoverage: Object.freeze({
      startInclusive: SYNTHETIC_HISTORY_START,
      endExclusive: SYNTHETIC_HISTORY_END,
    }),
    quality,
  });
}

export const SYNTHETIC_SETTINGS: FinancialEngineSettings = Object.freeze({
  effectiveFrom: parseLocalDate('2024-08-01'),
  version: 'stage3-settings-v1',
  spendingBaseline: Object.freeze({
    baselineWindowMonths: 6,
    minimumCompleteMonths: 3,
    maximumBaselineLookbackMonths: 36,
    materialityThreshold: money(25_000n),
    variabilityPercentile: createExactFraction(4n, 5n),
    seasonalityMinimumMonths: 24,
    seasonalityCap: createExactFraction(1n, 5n),
    fallbackNormalBaseline: null,
    fallbackEssentialBaseline: null,
  }),
  liquidity: Object.freeze({
    minimumReserveMonths: createExactFraction(1n, 1n),
    comfortReserveMonths: createExactFraction(3n, 1n),
    unknownIncomeHorizonDays: 31,
    obligationHorizonDays: 90,
  }),
  safeToInvest: Object.freeze({ recommendationIncrement: money(1_000n) }),
  cashDrag: Object.freeze({
    windowDays: 60,
    minimumCompleteDays: 54,
    minimumPositiveExcessDays: 45,
    absoluteExcessThreshold: money(25_000n),
    relativeComfortThreshold: createExactFraction(1n, 10n),
  }),
  investmentStep: DEFAULT_INVESTMENT_STEP_SETTINGS,
  forecast: DEFAULT_FORECAST_SETTINGS,
});

function bankBalanceAt(transactions: readonly CanonicalTransaction[], cutoff: Instant): bigint {
  const opening = 600_000n;
  return transactions
    .filter(
      (transaction) =>
        transaction.effectiveAt > '2024-09-01T08:00:00Z' && transaction.effectiveAt <= cutoff,
    )
    .flatMap((transaction) => transaction.entries)
    .filter((entry) => entry.accountId === SYNTHETIC_IDS.bankAccount)
    .reduce((total, entry) => total + entry.amount.amountMinor, opening);
}

function checkpointInstant(date: LocalDate): Instant {
  return parseInstant(`${date}T20:00:00Z`);
}

function historicalDates(effectiveDate: LocalDate): readonly LocalDate[] {
  return Object.freeze(
    Array.from({ length: 59 }, (_, index) => addLocalDays(effectiveDate, index - 59)),
  );
}

function latestClosedCycleOpeningDates(asOf: Instant): readonly string[] {
  const salaryDates = SYNTHETIC_SALARY_DATES.filter((date) => `${date}T08:00:00Z` <= asOf);
  return salaryDates.slice(-5, -1);
}

export function buildSyntheticHistoricalCheckpoints(
  effectiveDate: LocalDate = SYNTHETIC_EFFECTIVE_DATE,
  asOf: Instant = SYNTHETIC_AS_OF,
  incompleteHistorical = false,
): readonly HistoricalFinancialCheckpoint[] {
  const daily = historicalDates(effectiveDate).map((date) => ({
    kind: 'cash_drag_day' as const,
    date,
    ...contextFor(date),
  }));
  const openings = latestClosedCycleOpeningDates(asOf);
  const preClosing = openings.map((openingDate, index) => {
    const openingIndex = SYNTHETIC_SALARY_DATES.indexOf(
      openingDate as (typeof SYNTHETIC_SALARY_DATES)[number],
    );
    const closingDate = SYNTHETIC_SALARY_DATES[openingIndex + 1]!;
    const checkpointDate = addLocalDays(parseLocalDate(closingDate), -1);
    return {
      kind: 'pre_closing' as const,
      payCycleId: parsePayCycleId(syntheticUuid(10, 1_000 + openingIndex)),
      ...contextFor(
        checkpointDate,
        incompleteHistorical && index === openings.length - 1
          ? { incompleteMonth: parseYearMonth('2026-04'), incompleteQuality: true }
          : {},
      ),
    };
  });
  return Object.freeze([...daily, ...preClosing]);
}

function accountSnapshots(
  transactions: readonly CanonicalTransaction[],
  effectiveDate: LocalDate,
  asOf: Instant,
): readonly AccountBalanceSnapshot[] {
  const instants = new Set<string>([
    ...historicalDates(effectiveDate).map(checkpointInstant),
    ...latestClosedCycleOpeningDates(asOf).map((openingDate) => {
      const index = SYNTHETIC_SALARY_DATES.indexOf(
        openingDate as (typeof SYNTHETIC_SALARY_DATES)[number],
      );
      return checkpointInstant(
        addLocalDays(parseLocalDate(SYNTHETIC_SALARY_DATES[index + 1]!), -1),
      );
    }),
    asOf,
  ]);
  return Object.freeze(
    [...instants].sort().map((sourceAsOf) =>
      createAccountBalanceSnapshot({
        accountId: SYNTHETIC_IDS.bankAccount,
        value: createNativeReportableAmount(
          money(bankBalanceAt(transactions, parseInstant(sourceAsOf))),
        ),
        sourceAsOf: parseInstant(sourceAsOf),
        staleAt: parseInstant(
          sourceAsOf === asOf
            ? '2026-09-15T08:00:00Z'
            : sourceAsOf.replace('20:00:00Z', '23:59:59Z'),
        ),
      }),
    ),
  );
}

function portfolioValuations(): readonly PortfolioValuation[] {
  const marketDeltas = [8_000n, -4_000n, 6_000n, 2_000n, -9_000n, 11_000n] as const;
  let value = 800_000n;
  const values = SYNTHETIC_MONTHS.map((month, index) => {
    value += 5_000n + marketDeltas[index % marketDeltas.length]!;
    if (month === '2025-03') value += 100_000n;
    const date = endOfMonth(parseYearMonth(month));
    return createPortfolioValuation({
      accountId: SYNTHETIC_IDS.investmentAccount,
      marketValue: createNativeReportableAmount(money(value)),
      sourceAsOf: parseInstant(`${date}T18:00:00Z`),
      staleAt: parseInstant(`${endOfMonth(nextMonth(parseYearMonth(month)))}T23:59:59Z`),
      brokerageCashTreatment: 'included_in_market_value',
    });
  });
  values.push(
    createPortfolioValuation({
      accountId: SYNTHETIC_IDS.investmentAccount,
      marketValue: createNativeReportableAmount(money(value - 3_000n)),
      sourceAsOf: parseInstant('2026-09-13T18:00:00Z'),
      staleAt: parseInstant('2026-10-01T00:00:00Z'),
      brokerageCashTreatment: 'included_in_market_value',
    }),
  );
  return Object.freeze(values);
}

function resolvedTransfer(): CanonicalTransaction {
  const id = parseTransactionId(syntheticUuid(10, 80_000));
  return createCanonicalTransaction({
    id,
    effectiveAt: parseInstant('2026-09-10T10:00:00Z'),
    bookingStatus: 'booked',
    kind: 'internal_transfer',
    entries: [
      {
        id: parseEntryId(syntheticUuid(16, 80_000)),
        transactionId: id,
        accountId: SYNTHETIC_IDS.bankAccount,
        amount: money(-10_000n),
        role: 'transfer_source',
      },
      {
        id: parseEntryId(syntheticUuid(16, 80_001)),
        transactionId: id,
        accountId: SYNTHETIC_IDS.cashAccount,
        amount: money(10_000n),
        role: 'transfer_destination',
      },
    ],
  });
}

function unresolvedTransfer(): Readonly<{
  transaction: CanonicalTransaction;
  ambiguity: FlowAmbiguity;
}> {
  const resolved = resolvedTransfer();
  const transaction = createCanonicalTransaction({
    ...resolved,
    kind: 'external_flow',
    entries: resolved.entries.map((entry) => ({ ...entry, role: 'external_flow' as const })),
  });
  return Object.freeze({
    transaction,
    ambiguity: createFlowAmbiguity({
      transactionId: transaction.id,
      effectiveAt: transaction.effectiveAt,
      kind: 'unresolved_transfer',
      materiality: 'material',
    }),
  });
}

function canonicalFor(scenario: SyntheticScenarioId): FinancialEngineCanonicalFacts {
  const life = buildSyntheticFinancialLife();
  const asOf = SCENARIO_BOUNDARIES[scenario][0];
  const unresolved = unresolvedTransfer();
  const transfer =
    scenario === 'material_transfer_unresolved' ? unresolved.transaction : resolvedTransfer();
  const omitCurrentAllocation = scenario === 'sinking_due_before_allocation';
  const transactions = Object.freeze([...life.transactions, transfer]);
  return Object.freeze({
    accounts: life.accounts,
    transactions,
    investmentContributions: life.investmentContributions,
    accountBalanceSnapshots: accountSnapshots(
      transactions,
      SCENARIO_BOUNDARIES[scenario][1],
      SCENARIO_BOUNDARIES[scenario][0],
    ),
    portfolioValuations: portfolioValuations(),
    economicFlows: life.economicFlows,
    ambiguities:
      scenario === 'material_transfer_unresolved'
        ? Object.freeze([unresolved.ambiguity])
        : life.ambiguities,
    cashReconciliations: life.cashReconciliations,
    cashReconciliationResolutions: life.cashReconciliationResolutions,
    sinkingFunds: life.sinkingFunds,
    sinkingFundAllocations: omitCurrentAllocation
      ? Object.freeze(
          life.sinkingFundAllocations.filter((item) => item.effectiveAt !== '2026-08-29T12:00:00Z'),
        )
      : life.sinkingFundAllocations,
    spendingObservations: life.spendingObservations,
    primarySalaryTriggers: Object.freeze(
      life.primarySalaryTriggers.filter((item) => {
        const transaction = transactions.find((candidate) => candidate.id === item.transactionId);
        return transaction !== undefined && transaction.effectiveAt <= asOf;
      }),
    ),
    contributionAttributions: life.contributionAttributions,
  });
}

function forwardProjection(effectiveDate: LocalDate) {
  const horizonEnd = addLocalDays(effectiveDate, 60);
  const cashFlowRows = [
    ['2026-09-28', 'expected_primary_salary', 320_000n],
    ['2026-10-28', 'expected_primary_salary', 320_000n],
    ['2026-09-18', 'normal_spending', 45_000n],
    ['2026-10-03', 'normal_spending', 90_000n],
    ['2026-10-10', 'committed_obligation', 30_000n],
    ['2026-10-15', 'normal_spending', 55_000n],
    ['2026-10-22', 'committed_obligation', 20_000n],
    ['2026-11-01', 'committed_obligation', 55_000n],
    ['2026-11-05', 'sinking_funded_spending', 60_000n],
  ] as const;
  const cashFlows = cashFlowRows
    .filter(([date]) => date > effectiveDate && date <= horizonEnd)
    .map(([date, kind, amountMinor], index) =>
      createForwardProjectionCashFlow({
        id: parseForwardProjectionFlowId(syntheticUuid(30, index)),
        date: parseLocalDate(date),
        kind,
        amount: money(amountMinor),
      }),
    );
  const protectionDays = Array.from({ length: 60 }, (_, index) => {
    const date = addLocalDays(effectiveDate, index + 1);
    const beforeSeptemberPay = date < '2026-09-28';
    const beforeOctoberPay = date < '2026-10-28';
    const beforePurchase = date < '2026-11-05';
    const ring = beforeSeptemberPay
      ? 30_000n
      : beforeOctoberPay
        ? 45_000n
        : beforePurchase
          ? 60_000n
          : 0n;
    const due = beforeSeptemberPay ? 3_334n : 0n;
    const uncovered =
      date < '2026-10-10'
        ? 105_000n
        : date < '2026-10-22'
          ? 75_000n
          : date < '2026-11-01'
            ? 55_000n
            : 0n;
    return createForwardLiquidityProtectionDay({
      date,
      ringFencedCash: money(ring),
      currentCycleSinkingDue: money(due),
      uncoveredObligations: money(uncovered),
      operationalEssential: money(120_000n),
      operationalNormal: money(160_000n),
      minimumReserveTarget: money(190_000n),
      comfortReserveTarget: money(590_000n),
      completeness: 'complete',
    });
  });
  const occurrences = ['2026-09-20', '2026-10-20']
    .filter((date) => date > effectiveDate && date <= horizonEnd)
    .map((date, index) => ({
      id: parseRecurringInvestmentOccurrenceId(syntheticUuid(31, index)),
      planId: SYNTHETIC_IDS.recurringPlan,
      date: parseLocalDate(date),
    }));
  return Object.freeze({
    cashFlows: Object.freeze(cashFlows),
    protectionDays: Object.freeze(protectionDays),
    coverage: createForwardLiquidityProjectionCoverage({
      expectedPrimarySalary: 'complete',
      normalSpending: 'complete',
      committedObligations: 'complete',
      sinkingProtection: 'complete',
    }),
    contributionSchedule: createRecurringInvestmentSchedule({
      planId: SYNTHETIC_IDS.recurringPlan,
      occurrences,
      completeThrough: horizonEnd,
    }),
  });
}

function forecastPlan() {
  const capitalFlows = Array.from({ length: 120 }, (_, index) => {
    const month = addYearMonths(parseYearMonth('2026-10'), index);
    return createForecastCapitalFlow({
      id: parseForecastCapitalFlowId(syntheticUuid(40, index)),
      month,
      cashChange: money(20_000n),
      investmentChange: money(5_000n),
    });
  });
  const plannedExpenses = [
    createForecastPlannedExpense({
      id: parseForecastPlannedExpenseId(syntheticUuid(41, 1)),
      dueMonth: parseYearMonth('2026-11'),
      amount: { kind: 'exact', amount: money(60_000n) },
      priority: 'mandatory',
      committed: true,
    }),
    createForecastPlannedExpense({
      id: parseForecastPlannedExpenseId(syntheticUuid(41, 2)),
      dueMonth: parseYearMonth('2027-01'),
      amount: { kind: 'range', lower: money(70_000n), upper: money(90_000n) },
      priority: 'mandatory',
      committed: true,
    }),
    createForecastPlannedExpense({
      id: parseForecastPlannedExpenseId(syntheticUuid(41, 3)),
      dueMonth: parseYearMonth('2027-08'),
      amount: { kind: 'exact', amount: money(50_000n) },
      priority: 'optional',
      committed: true,
    }),
  ];
  return Object.freeze({
    capitalFlows: Object.freeze(capitalFlows),
    plannedExpenses: Object.freeze(plannedExpenses),
    includedOptionalExpenseIds: Object.freeze([plannedExpenses[2]!.id]),
  });
}

function ccrStart(asOf: Instant): Instant {
  const latest = [...SYNTHETIC_SALARY_DATES].filter((date) => `${date}T08:00:00Z` <= asOf).at(-1)!;
  return parseInstant(`${latest}T08:00:00Z`);
}

export function buildSyntheticScenario(id: SyntheticScenarioId): FinancialEngineInput {
  const [asOf, effectiveDate] = SCENARIO_BOUNDARIES[id];
  const current = contextFor(effectiveDate);
  const historicalIncomplete = id === 'historical_incomplete_month';
  return Object.freeze({
    run: Object.freeze({
      asOf,
      effectiveDate,
      engineVersion: 'stage2g.1-synthetic',
      settingsVersion: SYNTHETIC_SETTINGS.version,
      inputWatermark: `stage3:${id}`,
    }),
    settingsHistory: Object.freeze([SYNTHETIC_SETTINGS]),
    canonical: canonicalFor(id),
    current,
    historicalCheckpoints: buildSyntheticHistoricalCheckpoints(
      effectiveDate,
      asOf,
      historicalIncomplete,
    ),
    ccrPeriod: Object.freeze({ startInclusive: ccrStart(asOf), endExclusive: asOf }),
    rollingCcrPeriods:
      id === 'healthy_current'
        ? Object.freeze([
            Object.freeze({
              startInclusive: parseInstant('2026-06-14T08:00:00Z'),
              endExclusive: parseInstant('2026-09-14T08:00:00Z'),
            }),
          ])
        : Object.freeze([]),
    forwardProjection: forwardProjection(effectiveDate),
    recurringPlanId: SYNTHETIC_IDS.recurringPlan,
    currentRecurringContribution: money(5_000n),
    lastIssuedStepUpCycleIds: null,
    forecastPlan: forecastPlan(),
  });
}
