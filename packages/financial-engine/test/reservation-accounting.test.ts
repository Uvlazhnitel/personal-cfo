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
  createSinkingFund,
  createSinkingFundAllocation,
  parseAccountId,
  parseEconomicFlowId,
  parseEntryId,
  parseInstant,
  parseLocalDate,
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
  calculateFundedConsumptionCoverage,
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
const RESERVATION_HISTORY = period('2025-01-01T00:00:00Z', '2026-04-02T00:00:00Z');
const sinkingFund = createSinkingFund({
  id: fundId,
  label: 'Planned spending',
  target: createMoney(1_000_000n, EUR),
  dueDate: parseLocalDate('2027-01-01'),
  priority: 1,
  committed: true,
  status: 'active',
  allocationPolicy: 'manual',
  createdAt: RESERVATION_HISTORY.startInclusive,
});

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
  reservationCoverage: MeasurementPeriod = RESERVATION_HISTORY,
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
    sinkingFunds: [sinkingFund],
    sinkingFundAllocations: allocations,
    reservationCoverage,
    asOf: AS_OF,
    engineVersion: '2c.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
  };
}

function reservationEffect(
  allocations: readonly SinkingFundAllocation[],
  economicFlows: readonly EconomicFlow[] = [],
  funds = [sinkingFund],
) {
  return calculateReservationEffect({
    funds,
    allocations,
    reservationCoverage: RESERVATION_HISTORY,
    period: JANUARY,
    economicFlows,
    asOf: AS_OF,
    engineVersion: '2c.1.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
  });
}

describe('reservation accounting in CCR', () => {
  it('projects funded consumption through the validated reservation ledger', () => {
    const at = parseInstant('2026-02-15T12:00:00Z');
    const [trip, tripFlow] = consumption(20, 8_000n, at);
    const prior = reservation(29, 8_000n, parseInstant('2026-01-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const draw = reservation(30, 8_000n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: trip.id,
    });
    const result = calculateFundedConsumptionCoverage({
      funds: [sinkingFund],
      allocations: [prior, draw],
      economicFlows: [tripFlow],
      reservationCoverage: RESERVATION_HISTORY,
      asOf: AS_OF,
      engineVersion: '2d.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'watermark-1',
    });

    expect(result.status).toBe('complete');
    expect(result.value?.byTransaction).toEqual([
      { transactionId: trip.id, amount: createMoney(8_000n, EUR) },
    ]);
  });

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
    const priorAllocation = reservation(29, 30_000n, parseInstant('2026-01-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const draw = reservation(30, 30_000n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: trip.id,
    });
    const result = calculateCapitalConversionRate(
      input(FEBRUARY, [salary, trip], [salaryFlow, tripFlow], [priorAllocation, draw]),
    );

    expect(result.value?.netConsumption.amountMinor).toBe(30_000n);
    expect(result.value?.shortTermReservedFundsChange.amountMinor).toBe(-30_000n);
    expect(result.value?.capitalCreated.amountMinor).toBe(300_000n);
  });

  it('increases capital attribution when a reservation is explicitly released', () => {
    const allocation = reservation(29, 20_000n, parseInstant('2026-01-15T12:00:00Z'), {
      kind: 'allocation',
    });
    const release = reservation(30, 20_000n, parseInstant('2026-02-15T12:00:00Z'), {
      kind: 'release',
    });
    const result = calculateCapitalCreated(input(FEBRUARY, [], [], [allocation, release]));

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
    const common = input(QUARTER, [salary], [salaryFlow], [january, february, march]);
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
      ...input(twelveMonths, [salary], [salaryFlow], allocations),
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
      funds: [],
      allocations: [],
      reservationCoverage: RESERVATION_HISTORY,
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
      calculateCapitalCreated(
        input(
          FEBRUARY,
          [trip],
          [tripFlow],
          [
            reservation(29, 10_001n, parseInstant('2026-01-15T12:00:00Z'), {
              kind: 'allocation',
            }),
            tooLarge,
          ],
        ),
      ),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('rejects events for unknown funds and before fund creation', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    const valid = reservation(30, 10_000n, at, { kind: 'allocation' });
    const unknown = createSinkingFundAllocation({
      ...valid,
      id: parseSinkingFundAllocationId(uuid(31)),
      fundId: parseSinkingFundId(uuid(99)),
    });
    const beforeCreation = reservation(32, 10_000n, parseInstant('2024-12-31T12:00:00Z'), {
      kind: 'allocation',
    });

    expect(() => reservationEffect([unknown])).toThrowError(FinancialEngineInvariantError);
    expect(() => reservationEffect([beforeCreation])).toThrowError(FinancialEngineInvariantError);
  });

  it('rejects releases without enough currently reserved cash', () => {
    const allocation = reservation(30, 10_000n, parseInstant('2026-01-10T12:00:00Z'), {
      kind: 'allocation',
    });
    const releaseWithoutReserve = reservation(31, 10_000n, parseInstant('2026-01-09T12:00:00Z'), {
      kind: 'release',
    });
    const overRelease = reservation(32, 10_001n, parseInstant('2026-01-11T12:00:00Z'), {
      kind: 'release',
    });

    expect(() => reservationEffect([releaseWithoutReserve])).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() => reservationEffect([allocation, overRelease])).toThrowError(
      FinancialEngineInvariantError,
    );
  });

  it('rejects funded consumption without enough currently reserved cash', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    const [purchase, purchaseFlow] = consumption(60, 10_000n, at);
    const spending = reservation(30, 10_000n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: purchase.id,
    });
    const partialAllocation = reservation(31, 5_000n, parseInstant('2026-01-10T12:00:00Z'), {
      kind: 'allocation',
    });

    expect(() => reservationEffect([spending], [purchaseFlow])).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() => reservationEffect([partialAllocation, spending], [purchaseFlow])).toThrowError(
      FinancialEngineInvariantError,
    );
  });

  it('limits release after funded consumption to the remaining reserved cash', () => {
    const at = parseInstant('2026-01-15T12:00:00Z');
    const [purchase, purchaseFlow] = consumption(60, 40_000n, at);
    const allocation = reservation(30, 50_000n, parseInstant('2026-01-10T12:00:00Z'), {
      kind: 'allocation',
    });
    const spending = reservation(31, 40_000n, at, {
      kind: 'funded_consumption',
      relatedTransactionId: purchase.id,
    });
    const release = reservation(32, 15_000n, parseInstant('2026-01-16T12:00:00Z'), {
      kind: 'release',
    });

    expect(() => reservationEffect([allocation, spending, release], [purchaseFlow])).toThrowError(
      FinancialEngineInvariantError,
    );
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
