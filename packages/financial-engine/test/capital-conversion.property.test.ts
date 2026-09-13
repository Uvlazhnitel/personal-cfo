import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountEntry,
  createCanonicalTransaction,
  createCashReconciliation,
  createEconomicFlow,
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
  EconomicFlow,
} from '@personal-cfo/domain';

import { calculateCapitalConversionRate, calculateCapitalCreated } from '../src/index.js';
import type { CapitalConversionInput } from '../src/index.js';

const PROPERTY_OPTIONS = { seed: 20_260_913, numRuns: 100 } as const;
const EFFECTIVE_AT = parseInstant('2026-09-15T12:00:00Z');
const PERIOD = createMeasurementPeriod({
  startInclusive: parseInstant('2026-09-01T00:00:00Z'),
  endExclusive: parseInstant('2026-10-01T00:00:00Z'),
});

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

function account(seed: number, subtype: 'bank' | 'cash' | 'investment'): Account {
  return createAccount({
    id: parseAccountId(uuid(seed)),
    subtype,
    currency: EUR,
    includeInNetWorth: true,
    valueSource:
      subtype === 'cash'
        ? 'ledger'
        : subtype === 'investment'
          ? 'portfolio_valuation'
          : 'balance_snapshot',
    brokerageCashFor: null,
  });
}

const BANK = account(1, 'bank');
const CASH = account(2, 'cash');
const INVESTMENT = account(3, 'investment');

function transaction(
  seed: number,
  kind: CanonicalTransactionKind,
  postings: readonly Readonly<{ target: Account; amount: bigint; role: AccountEntryRole }>[],
): CanonicalTransaction {
  const id = parseTransactionId(uuid(seed));
  return createCanonicalTransaction({
    id,
    effectiveAt: EFFECTIVE_AT,
    bookingStatus: 'booked',
    kind,
    entries: postings.map((posting, index) =>
      createAccountEntry({
        id: parseEntryId(uuid(seed * 10 + index + 1)),
        transactionId: id,
        accountId: posting.target.id,
        amount: createMoney(posting.amount, EUR),
        role: posting.role,
      }),
    ),
  });
}

function classified(
  seed: number,
  signedAmount: bigint,
  detail:
    | Readonly<{ kind: 'earned_income'; source: 'salary' }>
    | Readonly<{ kind: 'consumption'; reimbursable: boolean }>,
): readonly [CanonicalTransaction, EconomicFlow] {
  const canonical = transaction(seed, 'external_flow', [
    { target: BANK, amount: signedAmount, role: 'external_flow' },
  ]);
  return [
    canonical,
    createEconomicFlow({
      id: parseEconomicFlowId(uuid(seed + 500)),
      transactionId: canonical.id,
      effectiveAt: canonical.effectiveAt,
      amount: createMoney(signedAmount < 0n ? -signedAmount : signedAmount, EUR),
      ...detail,
    }),
  ];
}

function input(
  transactions: readonly CanonicalTransaction[],
  economicFlows: readonly EconomicFlow[],
  overrides: Partial<CapitalConversionInput> = {},
): CapitalConversionInput {
  return {
    accounts: [BANK, CASH, INVESTMENT],
    transactions,
    investmentContributions: [],
    economicFlows,
    cashReconciliations: [],
    ambiguities: [],
    period: PERIOD,
    historyCoverage: PERIOD,
    sinkingFundAllocations: [],
    reservationCoverage: PERIOD,
    asOf: PERIOD.endExclusive,
    engineVersion: '2b.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'property-test',
    ...overrides,
  };
}

function economicTotals(result: ReturnType<typeof calculateCapitalConversionRate>) {
  if (result.value === null) throw new Error('Expected value.');
  return {
    income: result.value.recognizedIncome.amountMinor,
    consumption: result.value.netConsumption.amountMinor,
    capital: result.value.capitalCreated.amountMinor,
    ratio: result.value.ratio,
  };
}

describe('capital conversion properties', () => {
  it('balanced internal transfers never change CCR economic totals', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (amount) => {
        const [salary, salaryFlow] = classified(10, 2_000_000n, {
          kind: 'earned_income',
          source: 'salary',
        });
        const base = calculateCapitalConversionRate(input([salary], [salaryFlow]));
        const transfer = transaction(20, 'internal_transfer', [
          { target: BANK, amount: -amount, role: 'transfer_source' },
          { target: CASH, amount, role: 'transfer_destination' },
        ]);
        const expanded = calculateCapitalConversionRate(input([salary, transfer], [salaryFlow]));

        expect(economicTotals(expanded)).toEqual(economicTotals(base));
      }),
      PROPERTY_OPTIONS,
    );
  });

  it('investment allocation and market valuation movements never change CCR', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((value) => value !== 0n),
        (contributionAmount, marketMovement) => {
          const [salary, salaryFlow] = classified(10, 2_000_000n, {
            kind: 'earned_income',
            source: 'salary',
          });
          const contribution = transaction(20, 'investment_contribution', [
            { target: BANK, amount: -contributionAmount, role: 'transfer_source' },
            { target: INVESTMENT, amount: contributionAmount, role: 'transfer_destination' },
          ]);
          const valuation = transaction(30, 'valuation_adjustment', [
            { target: INVESTMENT, amount: marketMovement, role: 'valuation_adjustment' },
          ]);
          const principal = createInvestmentContribution({
            transactionId: contribution.id,
            investmentAccountId: INVESTMENT.id,
            principal: createMoney(contributionAmount, EUR),
            effectiveAt: contribution.effectiveAt,
          });
          const base = calculateCapitalConversionRate(input([salary], [salaryFlow]));
          const expanded = calculateCapitalConversionRate(
            input([salary, contribution, valuation], [salaryFlow], {
              investmentContributions: [principal],
            }),
          );

          expect(economicTotals(expanded)).toEqual(economicTotals(base));
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('linked refunds and reimbursements reduce consumption by exactly their amounts', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        (first, second) => {
          const expenseAmount = first + second;
          const [expense, expenseFlow] = classified(10, -expenseAmount, {
            kind: 'consumption',
            reimbursable: true,
          });
          const refundTransaction = transaction(20, 'external_flow', [
            { target: BANK, amount: first, role: 'external_flow' },
          ]);
          const reimbursementTransaction = transaction(30, 'external_flow', [
            { target: BANK, amount: second, role: 'external_flow' },
          ]);
          const refund = createEconomicFlow({
            id: parseEconomicFlowId(uuid(520)),
            transactionId: refundTransaction.id,
            effectiveAt: refundTransaction.effectiveAt,
            amount: createMoney(first, EUR),
            kind: 'refund',
            relatedTransactionId: expense.id,
          });
          const reimbursement = createEconomicFlow({
            id: parseEconomicFlowId(uuid(530)),
            transactionId: reimbursementTransaction.id,
            effectiveAt: reimbursementTransaction.effectiveAt,
            amount: createMoney(second, EUR),
            kind: 'reimbursement',
            relatedTransactionId: expense.id,
          });
          const result = calculateCapitalCreated(
            input(
              [expense, refundTransaction, reimbursementTransaction],
              [expenseFlow, refund, reimbursement],
            ),
          );

          expect(result.value?.netConsumption.amountMinor).toBe(0n);
          expect(result.value?.recognizedIncome.amountMinor).toBe(0n);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });

  it('cash reconciliation variance is never income, consumption, or capital creation', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((value) => value !== 0n),
        (variance) => {
          const adjustment = transaction(60, 'valuation_adjustment', [
            { target: CASH, amount: variance, role: 'valuation_adjustment' },
          ]);
          const adjustmentFlow = createEconomicFlow({
            id: parseEconomicFlowId(uuid(560)),
            transactionId: adjustment.id,
            effectiveAt: adjustment.effectiveAt,
            amount: createMoney(variance, EUR),
            kind: 'cash_reconciliation_adjustment',
          });
          const reconciliation = createCashReconciliation({
            id: parseCashReconciliationId(uuid(700)),
            accountId: CASH.id,
            calculatedBalance: createMoney(2_000_000n, EUR),
            countedBalance: createMoney(2_000_000n + variance, EUR),
            variance: createMoney(variance, EUR),
            reconciledAt: adjustment.effectiveAt,
            actor: 'property-test',
            reason: null,
            materiality: 'non_material',
            adjustmentTransactionId: adjustment.id,
          });
          const result = calculateCapitalCreated(
            input([adjustment], [adjustmentFlow], { cashReconciliations: [reconciliation] }),
          );

          expect(result.value?.recognizedIncome.amountMinor).toBe(0n);
          expect(result.value?.netConsumption.amountMinor).toBe(0n);
          expect(result.value?.capitalCreated.amountMinor).toBe(0n);
        },
      ),
      PROPERTY_OPTIONS,
    );
  });
});
