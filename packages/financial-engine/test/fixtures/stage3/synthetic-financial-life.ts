import {
  EUR,
  createAccount,
  createCanonicalTransaction,
  createCashReconciliation,
  createCashReconciliationResolution,
  createEconomicFlow,
  createFutureObligation,
  createInvestmentContribution,
  createInvestmentContributionAttribution,
  createMoney,
  createPrimarySalaryTrigger,
  createSinkingFund,
  createSinkingFundAllocation,
  createSpendingObservation,
  parseAccountId,
  parseCashReconciliationId,
  parseEconomicFlowId,
  parseEntryId,
  parseFutureObligationId,
  parseInstant,
  parseLocalDate,
  parseRecurringInvestmentPlanId,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseSpendingCategoryId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  Account,
  AccountId,
  CanonicalTransaction,
  CashReconciliation,
  CashReconciliationResolution,
  EconomicFlow,
  FlowAmbiguity,
  FutureObligation,
  Instant,
  InvestmentContribution,
  InvestmentContributionAttribution,
  Money,
  PrimarySalaryTrigger,
  SinkingFund,
  SinkingFundAllocation,
  SpendingObservation,
  TransactionId,
} from '@personal-cfo/domain';

export const SYNTHETIC_AS_OF = parseInstant('2026-09-14T08:00:00Z');
export const SYNTHETIC_EFFECTIVE_DATE = parseLocalDate('2026-09-14');
export const SYNTHETIC_HISTORY_START = parseInstant('2024-08-01T00:00:00Z');
export const SYNTHETIC_HISTORY_END = parseInstant('2026-12-01T00:00:00Z');

export function syntheticUuid(subsystem: number, index: number): string {
  const suffix = (BigInt(subsystem) * 100_000n + BigInt(index)).toString(16).padStart(12, '0');
  return `018f0000-0000-7000-8000-${suffix}`;
}

function money(amountMinor: bigint): Money {
  return createMoney(amountMinor, EUR);
}

export const SYNTHETIC_MONTHS = Object.freeze([
  '2024-09',
  '2024-10',
  '2024-11',
  '2024-12',
  '2025-01',
  '2025-02',
  '2025-03',
  '2025-04',
  '2025-05',
  '2025-06',
  '2025-07',
  '2025-08',
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
] as const);

export const SYNTHETIC_SALARY_DATES = Object.freeze([
  '2024-08-28',
  '2024-09-27',
  '2024-10-28',
  '2024-11-28',
  '2024-12-27',
  '2025-01-28',
  '2025-02-28',
  '2025-03-28',
  '2025-04-28',
  '2025-05-28',
  '2025-06-27',
  '2025-07-28',
  '2025-08-28',
  '2025-09-29',
  '2025-10-28',
  '2025-11-28',
  '2025-12-29',
  '2026-01-28',
  '2026-02-27',
  '2026-03-27',
  '2026-04-28',
  '2026-05-28',
  '2026-06-29',
  '2026-07-28',
  '2026-08-28',
] as const);

export const SYNTHETIC_IDS = Object.freeze({
  bankAccount: parseAccountId(syntheticUuid(1, 1)),
  cashAccount: parseAccountId(syntheticUuid(1, 2)),
  investmentAccount: parseAccountId(syntheticUuid(1, 3)),
  recurringPlan: parseRecurringInvestmentPlanId(syntheticUuid(2, 1)),
  travelFund: parseSinkingFundId(syntheticUuid(3, 1)),
  currentFund: parseSinkingFundId(syntheticUuid(3, 2)),
  categories: Object.freeze({
    housing: parseSpendingCategoryId(syntheticUuid(4, 1)),
    utilities: parseSpendingCategoryId(syntheticUuid(4, 2)),
    connectivity: parseSpendingCategoryId(syntheticUuid(4, 3)),
    transport: parseSpendingCategoryId(syntheticUuid(4, 4)),
    subscription: parseSpendingCategoryId(syntheticUuid(4, 5)),
    groceries: parseSpendingCategoryId(syntheticUuid(4, 6)),
    restaurants: parseSpendingCategoryId(syntheticUuid(4, 7)),
    localTransport: parseSpendingCategoryId(syntheticUuid(4, 8)),
    household: parseSpendingCategoryId(syntheticUuid(4, 9)),
    discretionary: parseSpendingCategoryId(syntheticUuid(4, 10)),
    travel: parseSpendingCategoryId(syntheticUuid(4, 11)),
    cashAdjustment: parseSpendingCategoryId(syntheticUuid(4, 12)),
  }),
});

export type SyntheticFinancialLife = Readonly<{
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  investmentContributions: readonly InvestmentContribution[];
  economicFlows: readonly EconomicFlow[];
  ambiguities: readonly FlowAmbiguity[];
  cashReconciliations: readonly CashReconciliation[];
  cashReconciliationResolutions: readonly CashReconciliationResolution[];
  sinkingFunds: readonly SinkingFund[];
  sinkingFundAllocations: readonly SinkingFundAllocation[];
  spendingObservations: readonly SpendingObservation[];
  primarySalaryTriggers: readonly PrimarySalaryTrigger[];
  contributionAttributions: readonly InvestmentContributionAttribution[];
  futureObligations: readonly FutureObligation[];
  openingBankBalance: Money;
  openingBankBalanceAt: Instant;
}>;

type Collections = {
  transactions: CanonicalTransaction[];
  flows: EconomicFlow[];
  observations: SpendingObservation[];
  contributions: InvestmentContribution[];
  attributions: InvestmentContributionAttribution[];
};

function transactionId(index: number): TransactionId {
  return parseTransactionId(syntheticUuid(10, index));
}

function instant(date: string, time = '08:00:00'): Instant {
  return parseInstant(`${date}T${time}Z`);
}

function addExternal(
  target: Collections,
  input: Readonly<{
    index: number;
    date: string;
    accountId: AccountId;
    entryAmount: bigint;
    flow:
      | Readonly<{ kind: 'earned_income'; source: 'salary' | 'side_hustle' | 'other' }>
      | Readonly<{ kind: 'consumption'; reimbursable: boolean }>
      | Readonly<{
          kind: 'refund' | 'reimbursement';
          relatedTransactionId: TransactionId | null;
        }>
      | Readonly<{ kind: 'other_external_flow' }>;
    observation?: Readonly<{
      categoryId: SpendingObservation['categoryId'];
      necessity: SpendingObservation['necessity'];
      cadence: SpendingObservation['cadence'];
      irregular: boolean;
    }>;
    time?: string;
  }>,
): Readonly<{ transactionId: TransactionId; flow: EconomicFlow }> {
  const id = transactionId(input.index);
  const effectiveAt = instant(input.date, input.time);
  target.transactions.push(
    createCanonicalTransaction({
      id,
      effectiveAt,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        {
          id: parseEntryId(syntheticUuid(11, input.index)),
          transactionId: id,
          accountId: input.accountId,
          amount: money(input.entryAmount),
          role: 'external_flow',
        },
      ],
    }),
  );
  const flow = createEconomicFlow({
    id: parseEconomicFlowId(syntheticUuid(12, input.index)),
    transactionId: id,
    effectiveAt,
    amount: money(input.entryAmount < 0n ? -input.entryAmount : input.entryAmount),
    ...input.flow,
  });
  target.flows.push(flow);
  if (input.observation !== undefined) {
    target.observations.push(
      createSpendingObservation({
        economicFlowId: flow.id,
        economicDate: parseLocalDate(input.date),
        ...input.observation,
      }),
    );
  }
  return Object.freeze({ transactionId: id, flow });
}

function addTransfer(
  target: Collections,
  index: number,
  date: string,
  sourceAccount: AccountId,
  destinationAccount: AccountId,
  amountMinor: bigint,
  kind: 'internal_transfer' | 'investment_contribution' = 'internal_transfer',
): TransactionId {
  const id = transactionId(index);
  const effectiveAt = instant(date, '10:00:00');
  target.transactions.push(
    createCanonicalTransaction({
      id,
      effectiveAt,
      bookingStatus: 'booked',
      kind,
      entries: [
        {
          id: parseEntryId(syntheticUuid(16, index * 2)),
          transactionId: id,
          accountId: sourceAccount,
          amount: money(-amountMinor),
          role: 'transfer_source',
        },
        {
          id: parseEntryId(syntheticUuid(16, index * 2 + 1)),
          transactionId: id,
          accountId: destinationAccount,
          amount: money(amountMinor),
          role: 'transfer_destination',
        },
      ],
    }),
  );
  return id;
}

function utilityForMonth(month: string): bigint {
  const number = Number(month.slice(5, 7));
  if (number >= 11 || number <= 3) return 18_000n;
  if (number === 4 || number === 10) return 13_000n;
  return 9_000n;
}

function variableAmounts(monthIndex: number, month: string): readonly bigint[] {
  const calendarMonth = Number(month.slice(5, 7));
  const summer = calendarMonth >= 6 && calendarMonth <= 8 ? 2_000n : 0n;
  const december = calendarMonth === 12 ? 5_000n : 0n;
  return Object.freeze([
    36_000n + BigInt(monthIndex % 5) * 900n,
    9_000n + BigInt(monthIndex % 4) * 1_100n + summer,
    5_000n + BigInt(monthIndex % 3) * 700n,
    7_000n + BigInt(monthIndex % 6) * 800n,
    10_000n + BigInt(monthIndex % 5) * 1_300n + december,
  ]);
}

function recurringFacts(target: Collections, month: string, monthIndex: number): void {
  const categories = SYNTHETIC_IDS.categories;
  const rows = [
    [3, 90_000n, categories.housing, 'essential'],
    [6, utilityForMonth(month), categories.utilities, 'essential'],
    [9, 4_500n, categories.connectivity, 'essential'],
    [12, 5_000n, categories.transport, 'essential'],
    [15, 1_500n, categories.subscription, 'discretionary'],
  ] as const;
  rows.forEach(([day, amount, categoryId, necessity], rowIndex) => {
    const effectiveDay = month === '2026-06' && rowIndex === 3 ? 11 : day;
    addExternal(target, {
      index: 10_000 + monthIndex * 20 + rowIndex,
      date: `${month}-${effectiveDay.toString().padStart(2, '0')}`,
      accountId: SYNTHETIC_IDS.bankAccount,
      entryAmount: -amount,
      flow: { kind: 'consumption', reimbursable: false },
      observation: { categoryId, necessity, cadence: 'recurring', irregular: false },
    });
  });
}

function variableFacts(target: Collections, month: string, monthIndex: number): void {
  const categories = [
    SYNTHETIC_IDS.categories.groceries,
    SYNTHETIC_IDS.categories.restaurants,
    SYNTHETIC_IDS.categories.localTransport,
    SYNTHETIC_IDS.categories.household,
    SYNTHETIC_IDS.categories.discretionary,
  ] as const;
  const necessities = [
    'essential',
    'discretionary',
    'essential',
    'essential',
    'discretionary',
  ] as const;
  variableAmounts(monthIndex, month).forEach((base, rowIndex) => {
    const outlier = month === '2026-02' && rowIndex === 4 ? 90_000n : 0n;
    addExternal(target, {
      index: 20_000 + monthIndex * 20 + rowIndex,
      date: `${month}-${(17 + rowIndex * 2).toString().padStart(2, '0')}`,
      accountId: SYNTHETIC_IDS.bankAccount,
      entryAmount: -(base + outlier),
      flow: { kind: 'consumption', reimbursable: false },
      observation: {
        categoryId: categories[rowIndex]!,
        necessity: necessities[rowIndex]!,
        cadence: 'variable',
        irregular: false,
      },
    });
  });
}

export function buildSyntheticFinancialLife(): SyntheticFinancialLife {
  const target: Collections = {
    transactions: [],
    flows: [],
    observations: [],
    contributions: [],
    attributions: [],
  };
  const accounts = Object.freeze([
    createAccount({
      id: SYNTHETIC_IDS.bankAccount,
      subtype: 'bank',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    }),
    createAccount({
      id: SYNTHETIC_IDS.cashAccount,
      subtype: 'cash',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'ledger',
      brokerageCashFor: null,
    }),
    createAccount({
      id: SYNTHETIC_IDS.investmentAccount,
      subtype: 'investment',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'portfolio_valuation',
      brokerageCashFor: null,
    }),
  ]);

  SYNTHETIC_SALARY_DATES.forEach((date, index) => {
    addExternal(target, {
      index: 1_000 + index,
      date,
      accountId: SYNTHETIC_IDS.bankAccount,
      entryAmount: 320_000n,
      flow: { kind: 'earned_income', source: 'salary' },
    });
  });
  const primarySalaryTriggers = Object.freeze(
    SYNTHETIC_SALARY_DATES.map((date, index) =>
      createPrimarySalaryTrigger({
        transactionId: transactionId(1_000 + index),
        effectiveDate: parseLocalDate(date),
      }),
    ),
  );

  SYNTHETIC_MONTHS.forEach((month, monthIndex) => {
    recurringFacts(target, month, monthIndex);
    variableFacts(target, month, monthIndex);
    const contributionId = addTransfer(
      target,
      30_000 + monthIndex,
      `${month}-20`,
      SYNTHETIC_IDS.bankAccount,
      SYNTHETIC_IDS.investmentAccount,
      5_000n,
      'investment_contribution',
    );
    const effectiveAt = instant(`${month}-20`, '10:00:00');
    target.contributions.push(
      createInvestmentContribution({
        transactionId: contributionId,
        investmentAccountId: SYNTHETIC_IDS.investmentAccount,
        principal: money(5_000n),
        effectiveAt,
      }),
    );
    target.attributions.push(
      createInvestmentContributionAttribution({
        transactionId: contributionId,
        kind: 'recurring_plan',
        planId: SYNTHETIC_IDS.recurringPlan,
      }),
    );
  });

  const adHocId = addTransfer(
    target,
    30_100,
    '2025-03-15',
    SYNTHETIC_IDS.bankAccount,
    SYNTHETIC_IDS.investmentAccount,
    100_000n,
    'investment_contribution',
  );
  target.contributions.push(
    createInvestmentContribution({
      transactionId: adHocId,
      investmentAccountId: SYNTHETIC_IDS.investmentAccount,
      principal: money(100_000n),
      effectiveAt: instant('2025-03-15', '10:00:00'),
    }),
  );
  target.attributions.push(
    createInvestmentContributionAttribution({ transactionId: adHocId, kind: 'ad_hoc' }),
  );

  const sideIncome = [
    ['2024-11-10', 12_000n, SYNTHETIC_IDS.bankAccount],
    ['2025-01-10', 4_000n, SYNTHETIC_IDS.cashAccount],
    ['2025-05-11', 18_000n, SYNTHETIC_IDS.bankAccount],
    ['2025-10-12', 3_500n, SYNTHETIC_IDS.cashAccount],
    ['2026-03-11', 22_000n, SYNTHETIC_IDS.bankAccount],
    ['2026-09-05', 15_000n, SYNTHETIC_IDS.bankAccount],
  ] as const;
  sideIncome.forEach(([date, amount, accountId], index) =>
    addExternal(target, {
      index: 40_000 + index,
      date,
      accountId,
      entryAmount: amount,
      flow: { kind: 'earned_income', source: 'side_hustle' },
    }),
  );

  const currentGroceries = addExternal(target, {
    index: 41_000,
    date: '2026-09-03',
    accountId: SYNTHETIC_IDS.bankAccount,
    entryAmount: -38_000n,
    flow: { kind: 'consumption', reimbursable: false },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.groceries,
      necessity: 'essential',
      cadence: 'variable',
      irregular: false,
    },
  });
  addExternal(target, {
    index: 41_001,
    date: '2026-09-07',
    accountId: SYNTHETIC_IDS.bankAccount,
    entryAmount: -10_000n,
    flow: { kind: 'consumption', reimbursable: false },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.restaurants,
      necessity: 'discretionary',
      cadence: 'variable',
      irregular: false,
    },
  });
  void currentGroceries;

  const refundOriginal = addExternal(target, {
    index: 42_000,
    date: '2026-04-05',
    accountId: SYNTHETIC_IDS.bankAccount,
    entryAmount: -10_000n,
    flow: { kind: 'consumption', reimbursable: false },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.household,
      necessity: 'essential',
      cadence: 'variable',
      irregular: false,
    },
  });
  addExternal(target, {
    index: 42_001,
    date: '2026-04-09',
    accountId: SYNTHETIC_IDS.bankAccount,
    entryAmount: 3_000n,
    flow: { kind: 'refund', relatedTransactionId: refundOriginal.transactionId },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.household,
      necessity: 'essential',
      cadence: 'variable',
      irregular: false,
    },
  });

  const cashOpeningId = transactionId(50_000);
  target.transactions.push(
    createCanonicalTransaction({
      id: cashOpeningId,
      effectiveAt: instant('2024-09-01'),
      bookingStatus: 'booked',
      kind: 'opening_balance',
      entries: [
        {
          id: parseEntryId(syntheticUuid(11, 50_000)),
          transactionId: cashOpeningId,
          accountId: SYNTHETIC_IDS.cashAccount,
          amount: money(10_000n),
          role: 'opening_balance',
        },
      ],
    }),
  );
  const cashActivity = [
    ['2024-10-15', 50_010, 10_000n, 'transfer'],
    ['2024-10-20', 50_011, 8_000n, 'spend'],
    ['2025-04-10', 50_012, 10_000n, 'transfer'],
    ['2025-04-15', 50_013, 12_000n, 'spend'],
    ['2025-10-10', 50_014, 10_000n, 'transfer'],
    ['2025-10-20', 50_015, 13_500n, 'spend'],
    ['2026-04-10', 50_016, 10_000n, 'transfer'],
    ['2026-04-15', 50_017, 10_000n, 'spend'],
  ] as const;
  cashActivity.forEach(([date, index, amount, kind]) => {
    if (kind === 'transfer') {
      addTransfer(
        target,
        index,
        date,
        SYNTHETIC_IDS.bankAccount,
        SYNTHETIC_IDS.cashAccount,
        amount,
      );
    } else {
      addExternal(target, {
        index,
        date,
        accountId: SYNTHETIC_IDS.cashAccount,
        entryAmount: -amount,
        flow: { kind: 'consumption', reimbursable: false },
        observation: {
          categoryId: SYNTHETIC_IDS.categories.cashAdjustment,
          necessity: 'discretionary',
          cadence: 'variable',
          irregular: true,
        },
      });
    }
  });

  const travelFund = createSinkingFund({
    id: SYNTHETIC_IDS.travelFund,
    label: 'Completed trip',
    target: money(120_000n),
    dueDate: parseLocalDate('2026-06-15'),
    priority: 1,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: instant('2026-01-10'),
  });
  const currentFund = createSinkingFund({
    id: SYNTHETIC_IDS.currentFund,
    label: 'Annual insurance',
    target: money(60_000n),
    dueDate: parseLocalDate('2026-11-05'),
    priority: 2,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: instant('2026-07-10'),
  });
  const travelAllocationDates = [
    '2026-01-10',
    '2026-01-28',
    '2026-02-27',
    '2026-03-27',
    '2026-04-28',
    '2026-05-28',
  ] as const;
  const allocations: SinkingFundAllocation[] = travelAllocationDates.map((date, index) =>
    createSinkingFundAllocation({
      id: parseSinkingFundAllocationId(syntheticUuid(13, index)),
      fundId: travelFund.id,
      amount: money(20_000n),
      effectiveAt: instant(date, '12:00:00'),
      kind: 'allocation',
    }),
  );
  const tripPurchase = addExternal(target, {
    index: 60_000,
    date: '2026-06-12',
    accountId: SYNTHETIC_IDS.bankAccount,
    entryAmount: -120_000n,
    flow: { kind: 'consumption', reimbursable: false },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.travel,
      necessity: 'discretionary',
      cadence: 'variable',
      irregular: false,
    },
  });
  allocations.push(
    createSinkingFundAllocation({
      id: parseSinkingFundAllocationId(syntheticUuid(13, 10)),
      fundId: travelFund.id,
      amount: money(120_000n),
      effectiveAt: instant('2026-06-12'),
      kind: 'funded_consumption',
      relatedTransactionId: tripPurchase.transactionId,
    }),
    createSinkingFundAllocation({
      id: parseSinkingFundAllocationId(syntheticUuid(13, 20)),
      fundId: currentFund.id,
      amount: money(20_000n),
      effectiveAt: instant('2026-07-10', '12:00:00'),
      kind: 'allocation',
    }),
    createSinkingFundAllocation({
      id: parseSinkingFundAllocationId(syntheticUuid(13, 21)),
      fundId: currentFund.id,
      amount: money(10_000n),
      effectiveAt: instant('2026-08-29', '12:00:00'),
      kind: 'allocation',
    }),
  );

  const reconciliationTransactionId = transactionId(70_000);
  target.transactions.push(
    createCanonicalTransaction({
      id: reconciliationTransactionId,
      effectiveAt: instant('2026-08-20', '12:00:00'),
      bookingStatus: 'booked',
      kind: 'valuation_adjustment',
      entries: [
        {
          id: parseEntryId(syntheticUuid(11, 70_000)),
          transactionId: reconciliationTransactionId,
          accountId: SYNTHETIC_IDS.cashAccount,
          amount: money(-1_500n),
          role: 'valuation_adjustment',
        },
      ],
    }),
  );
  target.flows.push(
    createEconomicFlow({
      id: parseEconomicFlowId(syntheticUuid(12, 70_000)),
      transactionId: reconciliationTransactionId,
      effectiveAt: instant('2026-08-20', '12:00:00'),
      amount: money(-1_500n),
      kind: 'cash_reconciliation_adjustment',
    }),
  );
  const reconciliation = createCashReconciliation({
    id: parseCashReconciliationId(syntheticUuid(14, 1)),
    accountId: SYNTHETIC_IDS.cashAccount,
    calculatedBalance: money(14_000n),
    countedBalance: money(12_500n),
    variance: money(-1_500n),
    reconciledAt: instant('2026-08-20', '12:00:00'),
    actor: 'synthetic-user',
    reason: 'Fixture physical count',
    materiality: 'non_material',
    adjustmentTransactionId: reconciliationTransactionId,
  });
  const reversalId = transactionId(70_001);
  target.transactions.push(
    createCanonicalTransaction({
      id: reversalId,
      effectiveAt: instant('2026-08-25', '09:00:00'),
      bookingStatus: 'booked',
      kind: 'valuation_adjustment',
      entries: [
        {
          id: parseEntryId(syntheticUuid(11, 70_001)),
          transactionId: reversalId,
          accountId: SYNTHETIC_IDS.cashAccount,
          amount: money(1_500n),
          role: 'valuation_adjustment',
        },
      ],
    }),
  );
  addExternal(target, {
    index: 70_002,
    date: '2026-08-25',
    time: '10:00:00',
    accountId: SYNTHETIC_IDS.cashAccount,
    entryAmount: -1_500n,
    flow: { kind: 'consumption', reimbursable: false },
    observation: {
      categoryId: SYNTHETIC_IDS.categories.cashAdjustment,
      necessity: 'discretionary',
      cadence: 'variable',
      irregular: true,
    },
  });

  const futureObligations = Object.freeze([
    createFutureObligation({
      id: parseFutureObligationId(syntheticUuid(15, 1)),
      dueDate: parseLocalDate('2026-10-10'),
      amount: { kind: 'exact', amount: money(30_000n) },
      priority: 'mandatory',
      committed: true,
      status: 'open',
      coverage: { kind: 'uncovered' },
    }),
    createFutureObligation({
      id: parseFutureObligationId(syntheticUuid(15, 2)),
      dueDate: parseLocalDate('2026-11-01'),
      amount: { kind: 'range', lower: money(40_000n), upper: money(55_000n) },
      priority: 'mandatory',
      committed: true,
      status: 'open',
      coverage: { kind: 'uncovered' },
    }),
    createFutureObligation({
      id: parseFutureObligationId(syntheticUuid(15, 3)),
      dueDate: parseLocalDate('2026-10-22'),
      amount: { kind: 'exact', amount: money(20_000n) },
      priority: 'optional',
      committed: true,
      status: 'open',
      coverage: { kind: 'uncovered' },
    }),
    createFutureObligation({
      id: parseFutureObligationId(syntheticUuid(15, 4)),
      dueDate: parseLocalDate('2026-12-15'),
      amount: { kind: 'exact', amount: money(40_000n) },
      priority: 'optional',
      committed: false,
      status: 'open',
      coverage: { kind: 'uncovered' },
    }),
    createFutureObligation({
      id: parseFutureObligationId(syntheticUuid(15, 5)),
      dueDate: parseLocalDate('2026-11-05'),
      amount: { kind: 'exact', amount: money(60_000n) },
      priority: 'mandatory',
      committed: true,
      status: 'open',
      coverage: { kind: 'sinking_fund', fundId: currentFund.id },
    }),
  ]);

  return Object.freeze({
    accounts,
    transactions: Object.freeze(
      [...target.transactions].sort(
        (a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.id.localeCompare(b.id),
      ),
    ),
    investmentContributions: Object.freeze(target.contributions),
    economicFlows: Object.freeze(
      [...target.flows].sort(
        (a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.id.localeCompare(b.id),
      ),
    ),
    ambiguities: Object.freeze([]),
    cashReconciliations: Object.freeze([reconciliation]),
    cashReconciliationResolutions: Object.freeze([
      createCashReconciliationResolution({
        kind: 'reversed_adjustment',
        reconciliationId: reconciliation.id,
        resolvedAt: instant('2026-08-25', '12:00:00'),
        resolutionTransactionId: reversalId,
      }),
    ]),
    sinkingFunds: Object.freeze([travelFund, currentFund]),
    sinkingFundAllocations: Object.freeze(allocations),
    spendingObservations: Object.freeze(target.observations),
    primarySalaryTriggers,
    contributionAttributions: Object.freeze(target.attributions),
    futureObligations,
    openingBankBalance: money(600_000n),
    openingBankBalanceAt: instant('2024-09-01'),
  });
}
