import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountEntry,
  createCanonicalTransaction,
  createEconomicFlow,
  createFlowAmbiguity,
  createMeasurementPeriod,
  createMoney,
  createSinkingFundAllocation,
  parseAccountId,
  parseEconomicFlowId,
  parseEntryId,
  parseInstant,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  CanonicalTransaction,
  EconomicFlow,
  Instant,
  MeasurementPeriod,
  SinkingFundAllocation,
} from '@personal-cfo/domain';

import {
  FinancialEngineInvariantError,
  calculateCapitalConversionRate,
  calculateCapitalCreated,
  calculateReservationEffect,
  calculateRollingCapitalConversionRates,
} from '../src/index.js';
import type { CapitalConversionInput } from '../src/index.js';

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
const fundId = parseSinkingFundId(uuid(3));
const JANUARY = period('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
const FEBRUARY = period('2026-02-01T00:00:00Z', '2026-03-01T00:00:00Z');
const MARCH = period('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z');
const QUARTER = period('2026-01-01T00:00:00Z', '2026-04-01T00:00:00Z');
const AS_OF = parseInstant('2026-04-01T00:00:00Z');

function period(start: string, end: string): MeasurementPeriod {
  return createMeasurementPeriod({
    startInclusive: parseInstant(start),
    endExclusive: parseInstant(end),
  });
}

function external(seed: number, amountMinor: bigint, effectiveAt: Instant) {
  const id = parseTransactionId(uuid(seed));
  return createCanonicalTransaction({
    id,
    effectiveAt,
    bookingStatus: 'booked',
    kind: 'external_flow',
    entries: [
      createAccountEntry({
        id: parseEntryId(uuid(seed + 100)),
        transactionId: id,
        accountId: bank.id,
        amount: createMoney(amountMinor, EUR),
        role: 'external_flow',
      }),
    ],
  });
}

function income(seed: number, amountMinor: bigint, effectiveAt: Instant) {
  const transaction = external(seed, amountMinor, effectiveAt);
  return [
    transaction,
    createEconomicFlow({
      id: parseEconomicFlowId(uuid(seed + 200)),
      transactionId: transaction.id,
      effectiveAt,
      amount: createMoney(amountMinor, EUR),
      kind: 'earned_income',
      source: 'salary',
    }),
  ] as const;
}

function consumption(seed: number, amountMinor: bigint, effectiveAt: Instant) {
  const transaction = external(seed, -amountMinor, effectiveAt);
  return [
    transaction,
    createEconomicFlow({
      id: parseEconomicFlowId(uuid(seed + 200)),
      transactionId: transaction.id,
      effectiveAt,
      amount: createMoney(amountMinor, EUR),
      kind: 'consumption',
      reimbursable: false,
    }),
  ] as const;
}

function reservation(
  seed: number,
  amountMinor: bigint,
  effectiveAt: Instant,
  detail:
    | Readonly<{ kind: 'allocation' | 'release' }>
    | Readonly<{ kind: 'funded_consumption'; relatedTransactionId: CanonicalTransaction['id'] }>,
): SinkingFundAllocation {
  const base = {
    id: parseSinkingFundAllocationId(uuid(seed)),
    fundId,
    amount: createMoney(amountMinor, EUR),
    effectiveAt,
  };
  return detail.kind === 'funded_consumption'
    ? createSinkingFundAllocation({ ...base, ...detail })
    : createSinkingFundAllocation({ ...base, kind: detail.kind });
}

function input(
  measurementPeriod: MeasurementPeriod,
  transactions: readonly CanonicalTransaction[],
  economicFlows: readonly EconomicFlow[],
  allocations: readonly SinkingFundAllocation[],
  reservationCoverage: MeasurementPeriod = measurementPeriod,
): CapitalConversionInput {
  return {
    accounts: [bank, cash],
    transactions,
    investmentContributions: [],
    economicFlows,
    cashReconciliations: [],
    ambiguities: [],
    period: measurementPeriod,
    historyCoverage: QUARTER,
    sinkingFundAllocations: allocations,
    reservationCoverage,
    asOf: AS_OF,
    engineVersion: '2c.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
  };
}

describe('reservation accounting in CCR', () => {
  it('reduces capital created when future-consumption cash is reserved', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    const [salary, salaryFlow] = income(10, 300_000n, at);
    const [spending, spendingFlow] = consumption(20, 150_000n, at);
    const allocation = reservation(30, 30_000n, at, { kind: 'allocation' });
    const result = calculateCapitalConversionRate(
      input(JANUARY, [salary, spending], [salaryFlow, spendingFlow], [allocation]),
    );

    expect(result.value?.shortTermReservedFundsChange.amountMinor).toBe(30_000n);
    expect(result.value?.capitalCreated.amountMinor).toBe(120_000n);
  });

  it('offsets later funded spending so the planned expense is counted only once', () => {
    const at = parseInstant('2026-02-15T12:00:00Z');
    const [salary, salaryFlow] = income(10, 300_000n, at);
    const [trip, tripFlow] = consumption(20, 30_000n, at);
    const draw = reservation(30, 30_000n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: trip.id,
    });
    const result = calculateCapitalConversionRate(
      input(FEBRUARY, [salary, trip], [salaryFlow, tripFlow], [draw]),
    );

    expect(result.value?.netConsumption.amountMinor).toBe(30_000n);
    expect(result.value?.shortTermReservedFundsChange.amountMinor).toBe(-30_000n);
    expect(result.value?.capitalCreated.amountMinor).toBe(300_000n);
  });

  it('increases capital attribution when a reservation is explicitly released', () => {
    const release = reservation(30, 20_000n, parseInstant('2026-02-15T12:00:00Z'), {
      kind: 'release',
    });
    const result = calculateCapitalCreated(input(FEBRUARY, [], [], [release]));

    expect(result.value?.shortTermReservedFundsChange.amountMinor).toBe(-20_000n);
    expect(result.value?.capitalCreated.amountMinor).toBe(20_000n);
  });

  it('derives independent reservation changes for each rolling period', () => {
    const january = reservation(30, 10_000n, parseInstant('2026-01-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const february = reservation(31, 20_000n, parseInstant('2026-02-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const march = reservation(32, 5_000n, parseInstant('2026-03-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const [salary, salaryFlow] = income(10, 300_000n, parseInstant('2026-03-15T12:00:00Z'));
    const common = input(QUARTER, [salary], [salaryFlow], [january, february, march], QUARTER);
    const results = calculateRollingCapitalConversionRates({
      ...common,
      periods: [MARCH, QUARTER],
    });

    expect(results[0]?.result.value?.shortTermReservedFundsChange.amountMinor).toBe(5_000n);
    expect(results[1]?.result.value?.shortTermReservedFundsChange.amountMinor).toBe(35_000n);
  });

  it('uses distinct reservation effects for supplied 3-, 6-, and 12-month windows', () => {
    const twelveMonths = period('2025-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const sixMonths = period('2025-07-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const threeMonths = period('2025-10-01T00:00:00Z', '2026-01-01T00:00:00Z');
    const allocations = [
      reservation(40, 10_000n, parseInstant('2025-02-15T12:00:00Z'), {
        kind: 'allocation',
      }),
      reservation(41, 20_000n, parseInstant('2025-08-15T12:00:00Z'), {
        kind: 'allocation',
      }),
      reservation(42, 5_000n, parseInstant('2025-11-15T12:00:00Z'), {
        kind: 'allocation',
      }),
    ];
    const [salary, salaryFlow] = income(43, 300_000n, parseInstant('2025-11-15T12:00:00Z'));
    const base = {
      ...input(twelveMonths, [salary], [salaryFlow], allocations, twelveMonths),
      asOf: twelveMonths.endExclusive,
      historyCoverage: twelveMonths,
    };
    const results = calculateRollingCapitalConversionRates({
      ...base,
      periods: [threeMonths, sixMonths, twelveMonths],
    });

    expect(
      results.map((result) => result.result.value?.shortTermReservedFundsChange.amountMinor),
    ).toEqual([5_000n, 25_000n, 35_000n]);
  });

  it('treats empty covered reservation history as zero and missing coverage as unavailable', () => {
    const empty = calculateReservationEffect({
      allocations: [],
      reservationCoverage: JANUARY,
      period: JANUARY,
      economicFlows: [],
      asOf: AS_OF,
      engineVersion: '2c.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'watermark-1',
    });
    const incomplete = period('2026-01-02T00:00:00Z', '2026-02-01T00:00:00Z');

    expect(empty.status).toBe('complete');
    expect(empty.value?.change.amountMinor).toBe(0n);
    expect(calculateCapitalCreated(input(JANUARY, [], [], [], incomplete)).status).toBe(
      'unavailable',
    );
  });

  it('rejects funded-consumption over-coverage and missing links', () => {
    const at = parseInstant('2026-02-15T12:00:00Z');
    const [trip, tripFlow] = consumption(20, 10_000n, at);
    const tooLarge = reservation(30, 10_001n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: trip.id,
    });

    expect(() =>
      calculateCapitalCreated(input(FEBRUARY, [trip], [tripFlow], [tooLarge])),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('does not duplicate reservation effects for a physical internal transfer', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    const [salary, salaryFlow] = income(10, 100_000n, at);
    const allocation = reservation(30, 10_000n, at, { kind: 'allocation' });
    const transferId = parseTransactionId(uuid(40));
    const transfer = createCanonicalTransaction({
      id: transferId,
      effectiveAt: at,
      bookingStatus: 'booked',
      kind: 'internal_transfer',
      entries: [
        createAccountEntry({
          id: parseEntryId(uuid(41)),
          transactionId: transferId,
          accountId: bank.id,
          amount: createMoney(-10_000n, EUR),
          role: 'transfer_source',
        }),
        createAccountEntry({
          id: parseEntryId(uuid(42)),
          transactionId: transferId,
          accountId: cash.id,
          amount: createMoney(10_000n, EUR),
          role: 'transfer_destination',
        }),
      ],
    });
    const before = calculateCapitalCreated(input(JANUARY, [salary], [salaryFlow], [allocation]));
    const after = calculateCapitalCreated(
      input(JANUARY, [salary, transfer], [salaryFlow], [allocation]),
    );

    expect(after.value?.capitalCreated.amountMinor).toBe(before.value?.capitalCreated.amountMinor);
  });

  it('requires active ambiguity for every unlinked refund and reimbursement', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    for (const [index, kind] of ['refund', 'reimbursement'].entries()) {
      const transaction = external(50 + index, 1_000n, at);
      const flow = createEconomicFlow({
        id: parseEconomicFlowId(uuid(300 + index)),
        transactionId: transaction.id,
        effectiveAt: at,
        amount: createMoney(1_000n, EUR),
        kind: kind as 'refund' | 'reimbursement',
        relatedTransactionId: null,
      });

      expect(() => calculateCapitalCreated(input(JANUARY, [transaction], [flow], []))).toThrowError(
        FinancialEngineInvariantError,
      );
      const ambiguity = createFlowAmbiguity({
        transactionId: transaction.id,
        effectiveAt: at,
        kind: kind === 'refund' ? 'unlinked_refund' : 'unlinked_reimbursement',
        materiality: 'non_material',
      });
      expect(
        calculateCapitalCreated({
          ...input(JANUARY, [transaction], [flow], []),
          ambiguities: [ambiguity],
        }).status,
      ).toBe('partial');
    }
  });
});
