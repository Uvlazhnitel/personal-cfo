import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountEntry,
  createCanonicalTransaction,
  createCashReconciliation,
  createEconomicFlow,
  createFlowAmbiguity,
  createInvestmentContribution,
  createMeasurementPeriod,
  createMoney,
  parseAccountId,
  parseCashReconciliationId,
  parseEconomicFlowId,
  parseEntryId,
  parseInstant,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  Account,
  AccountEntryRole,
  CanonicalTransaction,
  CanonicalTransactionKind,
  CashReconciliation,
  EconomicFlow,
  Instant,
  InvestmentContribution,
  TransactionId,
} from '@personal-cfo/domain';

import {
  FinancialEngineInvariantError,
  calculateCapitalConversionRate,
  calculateCapitalCreated,
  calculateLedgerBalance,
  calculateRollingCapitalConversionRates,
  validateLedger,
} from '../src/index.js';
import type { CapitalConversionInput } from '../src/index.js';

const SEPTEMBER = createMeasurementPeriod({
  startInclusive: parseInstant('2026-09-01T00:00:00Z'),
  endExclusive: parseInstant('2026-10-01T00:00:00Z'),
});
const AUGUST = createMeasurementPeriod({
  startInclusive: parseInstant('2026-08-01T00:00:00Z'),
  endExclusive: parseInstant('2026-09-01T00:00:00Z'),
});
const AS_OF = parseInstant('2026-10-01T00:00:00Z');
const IN_PERIOD = parseInstant('2026-09-15T12:00:00Z');

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const bank = createAccount({
  id: parseAccountId(uuid(1)),
  subtype: 'bank',
  currency: EUR,
  includeInNetWorth: true,
  valueSource: 'balance_snapshot',
  brokerageCashFor: null,
});
const cash = createAccount({
  id: parseAccountId(uuid(2)),
  subtype: 'cash',
  currency: EUR,
  includeInNetWorth: true,
  valueSource: 'ledger',
  brokerageCashFor: null,
});
const investment = createAccount({
  id: parseAccountId(uuid(3)),
  subtype: 'investment',
  currency: EUR,
  includeInNetWorth: true,
  valueSource: 'portfolio_valuation',
  brokerageCashFor: null,
});

function transaction(
  seed: number,
  kind: CanonicalTransactionKind,
  postings: readonly Readonly<{ account: Account; amount: bigint; role: AccountEntryRole }>[],
  effectiveAt: Instant = IN_PERIOD,
): CanonicalTransaction {
  const id = parseTransactionId(uuid(seed));
  return createCanonicalTransaction({
    id,
    effectiveAt,
    bookingStatus: 'booked',
    kind,
    entries: postings.map((posting, index) =>
      createAccountEntry({
        id: parseEntryId(uuid(seed * 10 + index + 1)),
        transactionId: id,
        accountId: posting.account.id,
        amount: createMoney(posting.amount, EUR),
        role: posting.role,
      }),
    ),
  });
}

function external(seed: number, signedAmount: bigint, effectiveAt: Instant = IN_PERIOD) {
  return transaction(
    seed,
    'external_flow',
    [{ account: bank, amount: signedAmount, role: 'external_flow' }],
    effectiveAt,
  );
}

function flow(
  seed: number,
  target: CanonicalTransaction,
  detail:
    | Readonly<{
        kind: 'earned_income';
        amount: bigint;
        source?: 'salary' | 'side_hustle' | 'other';
      }>
    | Readonly<{ kind: 'consumption'; amount: bigint; reimbursable?: boolean }>
    | Readonly<{
        kind: 'refund' | 'reimbursement';
        amount: bigint;
        relatedTransactionId: TransactionId | null;
      }>
    | Readonly<{ kind: 'cash_reconciliation_adjustment' | 'other_external_flow'; amount: bigint }>,
): EconomicFlow {
  const base = {
    id: parseEconomicFlowId(uuid(seed + 500)),
    transactionId: target.id,
    effectiveAt: target.effectiveAt,
    amount: createMoney(detail.amount, EUR),
  };
  switch (detail.kind) {
    case 'earned_income':
      return createEconomicFlow({ ...base, kind: detail.kind, source: detail.source ?? 'salary' });
    case 'consumption':
      return createEconomicFlow({
        ...base,
        kind: detail.kind,
        reimbursable: detail.reimbursable ?? false,
      });
    case 'refund':
    case 'reimbursement':
      return createEconomicFlow({
        ...base,
        kind: detail.kind,
        relatedTransactionId: detail.relatedTransactionId,
      });
    case 'cash_reconciliation_adjustment':
    case 'other_external_flow':
      return createEconomicFlow({ ...base, kind: detail.kind });
  }
}

function input(
  transactions: readonly CanonicalTransaction[],
  economicFlows: readonly EconomicFlow[],
  overrides: Partial<CapitalConversionInput> = {},
): CapitalConversionInput {
  return {
    accounts: [bank, cash, investment],
    transactions,
    investmentContributions: [],
    economicFlows,
    cashReconciliations: [],
    ambiguities: [],
    period: SEPTEMBER,
    historyCoverage: SEPTEMBER,
    shortTermReserveEffect: { status: 'complete', change: createMoney(0n, EUR) },
    asOf: AS_OF,
    engineVersion: '2b.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
    ...overrides,
  };
}

function requireValue(result: ReturnType<typeof calculateCapitalConversionRate>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected CCR value.');
  return result.value;
}

describe('capital conversion rate', () => {
  it('calculates a normal salary month exactly (FR-030)', () => {
    const salary = external(10, 300_000n);
    const spending = external(20, -180_000n);
    const result = calculateCapitalConversionRate(
      input(
        [salary, spending],
        [
          flow(10, salary, { kind: 'earned_income', amount: 300_000n }),
          flow(20, spending, { kind: 'consumption', amount: 180_000n }),
        ],
      ),
    );
    const value = requireValue(result);

    expect(result.status).toBe('complete');
    expect(value.capitalCreated.amountMinor).toBe(120_000n);
    expect(value.ratio).toEqual({ numerator: 120_000n, denominator: 300_000n });
  });

  it('recognizes salary and explicitly classified side-hustle income', () => {
    const salary = external(10, 300_000n);
    const sideHustle = external(11, 20_000n);
    const spending = external(20, -180_000n);
    const value = requireValue(
      calculateCapitalConversionRate(
        input(
          [salary, sideHustle, spending],
          [
            flow(10, salary, { kind: 'earned_income', amount: 300_000n }),
            flow(11, sideHustle, { kind: 'earned_income', amount: 20_000n, source: 'side_hustle' }),
            flow(20, spending, { kind: 'consumption', amount: 180_000n }),
          ],
        ),
      ),
    );

    expect(value.recognizedIncome.amountMinor).toBe(320_000n);
    expect(value.capitalCreated.amountMinor).toBe(140_000n);
  });

  it('preserves negative capital creation and an exact negative ratio', () => {
    const salary = external(10, 300_000n);
    const spending = external(20, -340_000n);
    const value = requireValue(
      calculateCapitalConversionRate(
        input(
          [salary, spending],
          [
            flow(10, salary, { kind: 'earned_income', amount: 300_000n }),
            flow(20, spending, { kind: 'consumption', amount: 340_000n }),
          ],
        ),
      ),
    );

    expect(value.capitalCreated.amountMinor).toBe(-40_000n);
    expect(value.ratio.numerator).toBe(-40_000n);
  });

  it('reduces consumption with a linked refund without treating it as income', () => {
    const purchase = external(10, -10_000n);
    const refund = external(11, 3_000n);
    const result = calculateCapitalCreated(
      input(
        [purchase, refund],
        [
          flow(10, purchase, { kind: 'consumption', amount: 10_000n }),
          flow(11, refund, { kind: 'refund', amount: 3_000n, relatedTransactionId: purchase.id }),
        ],
      ),
    );

    expect(result.value?.recognizedIncome.amountMinor).toBe(0n);
    expect(result.value?.netConsumption.amountMinor).toBe(7_000n);
  });

  it('books a refund locally when the original consumption is in a prior period', () => {
    const purchaseAt = parseInstant('2026-08-15T12:00:00Z');
    const purchase = external(10, -10_000n, purchaseAt);
    const refund = external(11, 3_000n);
    const created = calculateCapitalCreated(
      input(
        [purchase, refund],
        [
          flow(10, purchase, { kind: 'consumption', amount: 10_000n }),
          flow(11, refund, { kind: 'refund', amount: 3_000n, relatedTransactionId: purchase.id }),
        ],
      ),
    );

    expect(created.value?.netConsumption.amountMinor).toBe(-3_000n);
    expect(created.value?.capitalCreated.amountMinor).toBe(3_000n);
  });

  it.each([
    [6_000n, 4_000n],
    [10_000n, 0n],
  ])(
    'neutralizes linked reimbursement %s without creating income',
    (reimbursed, expectedConsumption) => {
      const expense = external(10, -10_000n);
      const reimbursement = external(11, reimbursed);
      const created = calculateCapitalCreated(
        input(
          [expense, reimbursement],
          [
            flow(10, expense, { kind: 'consumption', amount: 10_000n, reimbursable: true }),
            flow(11, reimbursement, {
              kind: 'reimbursement',
              amount: reimbursed,
              relatedTransactionId: expense.id,
            }),
          ],
        ),
      );

      expect(created.value?.recognizedIncome.amountMinor).toBe(0n);
      expect(created.value?.netConsumption.amountMinor).toBe(expectedConsumption);
    },
  );

  it('rejects over-reimbursement and incompatible reimbursement targets', () => {
    const expense = external(10, -10_000n);
    const reimbursement = external(11, 10_001n);
    const flows = [
      flow(10, expense, { kind: 'consumption', amount: 10_000n }),
      flow(11, reimbursement, {
        kind: 'reimbursement',
        amount: 10_001n,
        relatedTransactionId: expense.id,
      }),
    ];

    expect(() => calculateCapitalCreated(input([expense, reimbursement], flows))).toThrowError(
      FinancialEngineInvariantError,
    );
  });

  it('rejects duplicate flow identity and economically invalid reversal signs', () => {
    const purchase = external(10, -10_000n);
    const refund = external(11, 3_000n);
    const purchaseFlow = flow(10, purchase, {
      kind: 'consumption',
      amount: 10_000n,
    });
    const refundFlow = flow(11, refund, {
      kind: 'refund',
      amount: 3_000n,
      relatedTransactionId: purchase.id,
    });

    expect(() =>
      calculateCapitalCreated(input([purchase, refund], [purchaseFlow, purchaseFlow])),
    ).toThrowError(FinancialEngineInvariantError);
    expect(() =>
      calculateCapitalCreated(
        input(
          [purchase, refund],
          [
            purchaseFlow,
            createEconomicFlow({
              ...refundFlow,
              amount: createMoney(-3_000n, EUR),
            }),
          ],
        ),
      ),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('makes material ambiguity unavailable and non-material ambiguity partial', () => {
    const salary = external(9, 100_000n);
    const unknown = external(10, -5_000n);
    const material = createFlowAmbiguity({
      transactionId: unknown.id,
      effectiveAt: unknown.effectiveAt,
      kind: 'unresolved_transfer',
      materiality: 'material',
    });
    const nonMaterial = createFlowAmbiguity({ ...material, materiality: 'non_material' });

    expect(
      calculateCapitalConversionRate(
        input([salary, unknown], [flow(9, salary, { kind: 'earned_income', amount: 100_000n })], {
          ambiguities: [material],
        }),
      ).status,
    ).toBe('unavailable');
    expect(
      calculateCapitalConversionRate(
        input([salary, unknown], [flow(9, salary, { kind: 'earned_income', amount: 100_000n })], {
          ambiguities: [nonMaterial],
        }),
      ).status,
    ).toBe('partial');
  });

  it('excludes unlinked refunds until resolved and reports their ambiguity', () => {
    const salary = external(10, 100_000n);
    const refund = external(11, 3_000n);
    const refundFlow = flow(11, refund, {
      kind: 'refund',
      amount: 3_000n,
      relatedTransactionId: null,
    });
    const ambiguity = createFlowAmbiguity({
      transactionId: refund.id,
      effectiveAt: refund.effectiveAt,
      kind: 'unlinked_refund',
      materiality: 'non_material',
    });
    const result = calculateCapitalConversionRate(
      input(
        [salary, refund],
        [flow(10, salary, { kind: 'earned_income', amount: 100_000n }), refundFlow],
        { ambiguities: [ambiguity] },
      ),
    );

    expect(result.status).toBe('partial');
    expect(result.value?.refunds.amountMinor).toBe(0n);
    expect(result.value?.recognizedIncome.amountMinor).toBe(100_000n);
  });

  it('keeps internal transfers, brokerage contributions, opening balances, and valuations neutral', () => {
    const salary = external(10, 100_000n);
    const transfer = transaction(20, 'internal_transfer', [
      { account: bank, amount: -10_000n, role: 'transfer_source' },
      { account: cash, amount: 10_000n, role: 'transfer_destination' },
    ]);
    const contribution = transaction(30, 'investment_contribution', [
      { account: bank, amount: -20_000n, role: 'transfer_source' },
      { account: investment, amount: 20_000n, role: 'transfer_destination' },
    ]);
    const opening = transaction(40, 'opening_balance', [
      { account: cash, amount: 50_000n, role: 'opening_balance' },
    ]);
    const marketMovement = transaction(50, 'valuation_adjustment', [
      { account: investment, amount: 70_000n, role: 'valuation_adjustment' },
    ]);
    const principal: InvestmentContribution = createInvestmentContribution({
      transactionId: contribution.id,
      investmentAccountId: investment.id,
      principal: createMoney(20_000n, EUR),
      effectiveAt: contribution.effectiveAt,
    });
    const base = input([salary], [flow(10, salary, { kind: 'earned_income', amount: 100_000n })]);
    const expanded = calculateCapitalConversionRate({
      ...base,
      transactions: [salary, transfer, contribution, opening, marketMovement],
      investmentContributions: [principal],
    });

    expect(requireValue(expanded).capitalCreated.amountMinor).toBe(
      requireValue(calculateCapitalConversionRate(base)).capitalCreated.amountMinor,
    );
  });

  it('keeps both market gains and losses out of CCR', () => {
    const gain = transaction(50, 'valuation_adjustment', [
      { account: investment, amount: 70_000n, role: 'valuation_adjustment' },
    ]);
    const loss = transaction(51, 'valuation_adjustment', [
      { account: investment, amount: -40_000n, role: 'valuation_adjustment' },
    ]);

    for (const movement of [gain, loss]) {
      const result = calculateCapitalConversionRate(input([movement], []));
      expect(result.value).toBeNull();
      expect(result.warnings.map((item) => item.code)).toContain('ccr.zero_recognized_income');
      const created = calculateCapitalCreated(input([movement], []));
      expect(created.value?.capitalCreated.amountMinor).toBe(0n);
    }
  });

  it('records reconciliation variance in wealth but not income, consumption, or capital created', () => {
    const opening = transaction(59, 'opening_balance', [
      { account: cash, amount: 14_000n, role: 'opening_balance' },
    ]);
    const adjustment = transaction(60, 'valuation_adjustment', [
      { account: cash, amount: -1_500n, role: 'valuation_adjustment' },
    ]);
    const adjustmentFlow = flow(60, adjustment, {
      kind: 'cash_reconciliation_adjustment',
      amount: -1_500n,
    });
    const reconciliation: CashReconciliation = createCashReconciliation({
      id: parseCashReconciliationId(uuid(700)),
      accountId: cash.id,
      calculatedBalance: createMoney(14_000n, EUR),
      countedBalance: createMoney(12_500n, EUR),
      variance: createMoney(-1_500n, EUR),
      reconciledAt: adjustment.effectiveAt,
      actor: 'local-user',
      reason: null,
      materiality: 'material',
      adjustmentTransactionId: adjustment.id,
    });
    const created = calculateCapitalCreated(
      input([opening, adjustment], [adjustmentFlow], { cashReconciliations: [reconciliation] }),
    );
    const ledger = validateLedger({
      accounts: [cash],
      transactions: [opening, adjustment],
      investmentContributions: [],
    });

    expect(created.status).toBe('partial');
    expect(calculateLedgerBalance({ ledger, accountId: cash.id, asOf: AS_OF }).amountMinor).toBe(
      12_500n,
    );
    expect(created.value).toMatchObject({
      recognizedIncome: { amountMinor: 0n },
      grossConsumption: { amountMinor: 0n },
      capitalCreated: { amountMinor: 0n },
      cashReconciliationAdjustments: { amountMinor: -1_500n },
    });
  });

  it('returns capital created but no ratio for zero or negative recognized income', () => {
    const correction = external(10, -5_000n);
    const correctionFlow = flow(10, correction, { kind: 'earned_income', amount: -5_000n });

    expect(calculateCapitalConversionRate(input([], [])).status).toBe('unavailable');
    expect(
      calculateCapitalCreated(input([correction], [correctionFlow])).value?.capitalCreated
        .amountMinor,
    ).toBe(-5_000n);
    expect(
      calculateCapitalConversionRate(input([correction], [correctionFlow])).warnings.map(
        (item) => item.code,
      ),
    ).toContain('ccr.negative_recognized_income');
  });

  it('requires complete history, classification, and explicit reservation coverage', () => {
    const unknown = external(10, 100n);
    const incompleteCoverage = createMeasurementPeriod({
      startInclusive: parseInstant('2026-09-02T00:00:00Z'),
      endExclusive: SEPTEMBER.endExclusive,
    });

    expect(calculateCapitalConversionRate(input([unknown], [])).status).toBe('unavailable');
    expect(
      calculateCapitalConversionRate(input([], [], { historyCoverage: incompleteCoverage })).status,
    ).toBe('unavailable');
    expect(
      calculateCapitalConversionRate(
        input([], [], {
          shortTermReserveEffect: {
            status: 'unavailable',
            change: null,
            reasonCode: 'not-evaluated',
          },
        }),
      ).status,
    ).toBe('unavailable');
  });

  it('keeps neutral other external flows visible without changing capital created', () => {
    const salary = external(10, 100_000n);
    const loan = external(11, 25_000n);
    const value = requireValue(
      calculateCapitalConversionRate(
        input(
          [salary, loan],
          [
            flow(10, salary, { kind: 'earned_income', amount: 100_000n }),
            flow(11, loan, { kind: 'other_external_flow', amount: 25_000n }),
          ],
        ),
      ),
    );

    expect(value.otherExternalInflows.amountMinor).toBe(25_000n);
    expect(value.capitalCreated.amountMinor).toBe(100_000n);
  });

  it('preserves exact bigint arithmetic above Number.MAX_SAFE_INTEGER', () => {
    const exact = 9_007_199_254_740_993n;
    const salary = external(10, exact);
    const value = requireValue(
      calculateCapitalConversionRate(
        input([salary], [flow(10, salary, { kind: 'earned_income', amount: exact })]),
      ),
    );

    expect(value.ratio).toEqual({ numerator: exact, denominator: exact });
  });

  it('calculates rolling windows independently as ratios of aggregate period flows', () => {
    const augustSalary = external(10, 100_000n, parseInstant('2026-08-15T12:00:00Z'));
    const augustSpend = external(11, -50_000n, parseInstant('2026-08-16T12:00:00Z'));
    const septemberSalary = external(12, 300_000n);
    const septemberSpend = external(13, -270_000n);
    const results = calculateRollingCapitalConversionRates({
      ...input(
        [augustSalary, augustSpend, septemberSalary, septemberSpend],
        [
          flow(10, augustSalary, { kind: 'earned_income', amount: 100_000n }),
          flow(11, augustSpend, { kind: 'consumption', amount: 50_000n }),
          flow(12, septemberSalary, { kind: 'earned_income', amount: 300_000n }),
          flow(13, septemberSpend, { kind: 'consumption', amount: 270_000n }),
        ],
        {
          historyCoverage: createMeasurementPeriod({
            startInclusive: AUGUST.startInclusive,
            endExclusive: SEPTEMBER.endExclusive,
          }),
        },
      ),
      periods: [
        AUGUST,
        createMeasurementPeriod({
          startInclusive: AUGUST.startInclusive,
          endExclusive: SEPTEMBER.endExclusive,
        }),
      ],
    });

    expect(results[0]?.result.value?.ratio).toEqual({ numerator: 50_000n, denominator: 100_000n });
    expect(results[1]?.result.value?.ratio).toEqual({ numerator: 80_000n, denominator: 400_000n });
  });

  it('reconciles explanation operands exactly to capital created', () => {
    const salary = external(10, 300_000n);
    const spending = external(20, -180_000n);
    const result = calculateCapitalConversionRate(
      input(
        [salary, spending],
        [
          flow(10, salary, { kind: 'earned_income', amount: 300_000n }),
          flow(20, spending, { kind: 'consumption', amount: 180_000n }),
        ],
      ),
    );
    const operands = result.explanation
      .slice(0, 5)
      .reduce((sum, item) => sum + BigInt(item.value), 0n);

    expect(operands).toBe(result.value?.capitalCreated.amountMinor);
  });
});
