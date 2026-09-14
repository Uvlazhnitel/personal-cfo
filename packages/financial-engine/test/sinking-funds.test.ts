import { describe, expect, it } from 'vitest';

import {
  EUR,
  createAccount,
  createAccountBalanceSnapshot,
  createEconomicFlow,
  createExpectedPrimaryPaySchedule,
  createMeasurementPeriod,
  createMoney,
  createNativeReportableAmount,
  createPayCycle,
  createSinkingFund,
  createSinkingFundAllocation,
  parseAccountId,
  parseCurrencyCode,
  parseEconomicFlowId,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseTransactionId,
} from '@personal-cfo/domain';
import type {
  EconomicFlow,
  Instant,
  SinkingFund,
  SinkingFundAllocation,
} from '@personal-cfo/domain';

import {
  FinancialEngineInvariantError,
  calculateCurrentCycleSinkingDue,
  calculateFundedConsumptionCoverage,
  calculateNetWorth,
  calculateReservationEffect,
  calculateReservedCash,
  calculateSinkingFundSchedule,
} from '../src/index.js';
import type { SinkingFundScheduleInput } from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

const CYCLE_START = parseInstant('2026-01-27T08:00:00Z');
const AS_OF = parseInstant('2026-01-30T12:00:00Z');
const COVERAGE = createMeasurementPeriod({
  startInclusive: parseInstant('2025-01-01T00:00:00Z'),
  endExclusive: parseInstant('2027-01-01T00:00:00Z'),
});
const CYCLE = createPayCycle({
  id: parsePayCycleId(uuid(10)),
  openingSalaryTransactionId: parseTransactionId(uuid(10)),
  startInclusive: CYCLE_START,
  startDate: parseLocalDate('2026-01-27'),
  closingSalaryTransactionId: null,
  endExclusive: null,
  expectedNextPayDate: parseLocalDate('2026-02-27'),
  status: 'open',
});
const EXPECTED_PAY = createExpectedPrimaryPaySchedule({
  dates: [parseLocalDate('2026-02-27'), parseLocalDate('2026-03-27'), parseLocalDate('2026-04-27')],
  completeThrough: parseLocalDate('2026-12-31'),
});

function fund(
  seed: number,
  targetMinor: bigint,
  dueDate = '2026-03-27',
  createdAt: Instant = parseInstant('2026-01-01T00:00:00Z'),
  overrides: Partial<SinkingFund> = {},
): SinkingFund {
  return createSinkingFund({
    id: parseSinkingFundId(uuid(seed)),
    label: `Fund ${seed}`,
    target: createMoney(targetMinor, EUR),
    dueDate: parseLocalDate(dueDate),
    priority: seed,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt,
    ...overrides,
  });
}

function allocation(
  seed: number,
  target: SinkingFund,
  amountMinor: bigint,
  effectiveAt: Instant,
  kind: 'allocation' | 'release' = 'allocation',
): SinkingFundAllocation {
  return createSinkingFundAllocation({
    id: parseSinkingFundAllocationId(uuid(seed)),
    fundId: target.id,
    amount: createMoney(amountMinor, EUR),
    effectiveAt,
    kind,
  });
}

function fundedConsumption(
  seed: number,
  target: SinkingFund,
  amountMinor: bigint,
  effectiveAt: Instant,
): readonly [SinkingFundAllocation, EconomicFlow] {
  const transactionId = parseTransactionId(uuid(seed + 100));
  return [
    createSinkingFundAllocation({
      id: parseSinkingFundAllocationId(uuid(seed)),
      fundId: target.id,
      amount: createMoney(amountMinor, EUR),
      effectiveAt,
      kind: 'funded_consumption',
      relatedTransactionId: transactionId,
    }),
    createEconomicFlow({
      id: parseEconomicFlowId(uuid(seed + 200)),
      transactionId,
      effectiveAt,
      amount: createMoney(amountMinor, EUR),
      kind: 'consumption',
      reimbursable: false,
    }),
  ];
}

function input(
  funds: readonly SinkingFund[],
  allocations: readonly SinkingFundAllocation[] = [],
  overrides: Partial<SinkingFundScheduleInput> = {},
): SinkingFundScheduleInput {
  return {
    funds,
    allocations,
    economicFlows: [],
    reservationCoverage: COVERAGE,
    payCycles: [CYCLE],
    expectedPrimaryPaySchedule: EXPECTED_PAY,
    effectiveDate: parseLocalDate('2026-01-30'),
    asOf: AS_OF,
    engineVersion: '2c.0.0',
    settingsVersion: 'settings-1',
    inputWatermark: 'watermark-1',
    ...overrides,
  };
}

function scheduleValue(result: ReturnType<typeof calculateSinkingFundSchedule>) {
  expect(result.value).not.toBeNull();
  if (result.value === null) throw new Error('Expected Sinking Fund schedule.');
  return result.value;
}

describe('Sinking Fund schedules', () => {
  it('divides €600 exactly across three funding opportunities', () => {
    const value = scheduleValue(calculateSinkingFundSchedule(input([fund(20, 60_000n)])));
    const item = value.funds[0]!;

    expect(item.currentCycleRequirement?.requiredAmount.amountMinor).toBe(20_000n);
    expect(item.futureContributions.map((part) => part.amount.amountMinor)).toEqual([
      20_000n,
      20_000n,
    ]);
  });

  it('front-loads remainder cents and preserves the exact €100 target', () => {
    const item = scheduleValue(calculateSinkingFundSchedule(input([fund(20, 10_000n)]))).funds[0]!;
    const amounts = [
      item.currentCycleRequirement!.outstandingAmount.amountMinor,
      ...item.futureContributions.map((part) => part.amount.amountMinor),
    ];

    expect(amounts).toEqual([3_334n, 3_333n, 3_333n]);
    expect(amounts.reduce((sum, amount) => sum + amount, 0n)).toBe(10_000n);
  });

  it('schedules only the remainder already partially funded before the cycle', () => {
    const target = fund(20, 120_000n);
    const prior = allocation(30, target, 30_000n, parseInstant('2026-01-10T12:00:00Z'));
    const item = scheduleValue(calculateSinkingFundSchedule(input([target], [prior]))).funds[0]!;

    expect(item.reserved.amountMinor).toBe(30_000n);
    expect(item.currentCycleRequirement?.requiredAmount.amountMinor).toBe(30_000n);
    expect(
      item.currentCycleRequirement!.outstandingAmount.amountMinor +
        item.futureContributions.reduce((sum, part) => sum + part.amount.amountMinor, 0n),
    ).toBe(90_000n);
  });

  it('returns zero future due for fully funded and overfunded funds while retaining excess', () => {
    const complete = fund(20, 10_000n);
    const over = fund(21, 10_000n);
    const value = scheduleValue(
      calculateSinkingFundSchedule(
        input(
          [complete, over],
          [
            allocation(30, complete, 10_000n, parseInstant('2026-01-10T12:00:00Z')),
            allocation(31, over, 11_000n, parseInstant('2026-01-10T12:00:00Z')),
          ],
        ),
      ),
    );

    expect(value.funds[0]?.state).toBe('fully_funded');
    expect(value.funds[0]?.currentCycleRequirement?.outstandingAmount.amountMinor).toBe(0n);
    expect(value.funds[1]?.state).toBe('overfunded');
    expect(value.funds[1]?.excess.amountMinor).toBe(1_000n);
  });

  it('preserves fully funded targets after reserved cash is partially or fully spent', () => {
    const partial = fund(20, 60_000n);
    const full = fund(21, 60_000n);
    const partialAllocation = allocation(
      30,
      partial,
      60_000n,
      parseInstant('2026-01-10T12:00:00Z'),
    );
    const fullAllocation = allocation(31, full, 60_000n, parseInstant('2026-01-10T12:00:00Z'));
    const [partialSpend, partialFlow] = fundedConsumption(
      40,
      partial,
      50_000n,
      parseInstant('2026-01-28T12:00:00Z'),
    );
    const [fullSpend, fullFlow] = fundedConsumption(
      41,
      full,
      60_000n,
      parseInstant('2026-01-28T13:00:00Z'),
    );
    const value = scheduleValue(
      calculateSinkingFundSchedule(
        input([partial, full], [partialAllocation, fullAllocation, partialSpend, fullSpend], {
          economicFlows: [partialFlow, fullFlow],
        }),
      ),
    );

    expect(value.funds[0]).toMatchObject({
      state: 'fully_funded',
      reserved: { amountMinor: 10_000n },
      fundedConsumption: { amountMinor: 50_000n },
      fulfilled: { amountMinor: 60_000n },
      remaining: { amountMinor: 0n },
      futureContributions: [],
    });
    expect(value.funds[0]?.currentCycleRequirement?.outstandingAmount.amountMinor).toBe(0n);
    expect(value.funds[1]).toMatchObject({
      state: 'fully_funded',
      reserved: { amountMinor: 0n },
      fundedConsumption: { amountMinor: 60_000n },
      fulfilled: { amountMinor: 60_000n },
      remaining: { amountMinor: 0n },
      futureContributions: [],
    });
  });

  it('retains partial target progress after funded consumption', () => {
    const target = fund(20, 60_000n);
    const prior = allocation(30, target, 30_000n, parseInstant('2026-01-10T12:00:00Z'));
    const [spend, flow] = fundedConsumption(
      40,
      target,
      20_000n,
      parseInstant('2026-01-28T12:00:00Z'),
    );
    const item = scheduleValue(
      calculateSinkingFundSchedule(
        input([target], [prior, spend], {
          economicFlows: [flow],
        }),
      ),
    ).funds[0]!;

    expect(item).toMatchObject({
      reserved: { amountMinor: 10_000n },
      fundedConsumption: { amountMinor: 20_000n },
      fulfilled: { amountMinor: 30_000n },
      remaining: { amountMinor: 30_000n },
    });
  });

  it('does not require salary or expected-pay coverage for an already funded target', () => {
    const complete = fund(20, 10_000n);
    const prior = allocation(30, complete, 10_000n, parseInstant('2026-01-10T12:00:00Z'));
    const shortPaySchedule = createExpectedPrimaryPaySchedule({
      dates: [],
      completeThrough: parseLocalDate('2026-01-01'),
    });
    const item = scheduleValue(
      calculateSinkingFundSchedule(
        input([complete], [prior], {
          payCycles: [],
          expectedPrimaryPaySchedule: shortPaySchedule,
        }),
      ),
    ).funds[0]!;

    expect(item.state).toBe('fully_funded');
    expect(item.currentCycleRequirement).toBeNull();
    expect(item.futureContributions).toEqual([]);
  });

  it('makes the full remainder due when the target precedes the next salary', () => {
    const item = scheduleValue(
      calculateSinkingFundSchedule(input([fund(20, 30_000n, '2026-02-15')])),
    ).funds[0]!;

    expect(item.currentCycleRequirement?.requiredAmount.amountMinor).toBe(30_000n);
    expect(item.currentCycleRequirement?.outstandingAmount.amountMinor).toBe(30_000n);
    expect(item.futureContributions).toEqual([]);
  });

  it('excludes a salary opportunity after the target boundary', () => {
    const item = scheduleValue(
      calculateSinkingFundSchedule(
        input([fund(20, 60_000n, '2026-04-15')], [], {
          effectiveDate: parseLocalDate('2026-01-27'),
        }),
      ),
    ).funds[0]!;

    expect(item.currentCycleRequirement?.remainingFundingOpportunities).toBe(2);
    expect(item.currentCycleRequirement?.requiredAmount.amountMinor).toBe(20_000n);
    expect(item.futureContributions.map((part) => part.fundingDate)).toEqual([
      '2026-02-27',
      '2026-03-27',
    ]);
  });

  it('uses the active cycle immediately for a fund created mid-cycle', () => {
    const midCycle = fund(20, 60_000n, '2026-03-27', parseInstant('2026-01-29T12:00:00Z'));
    const item = scheduleValue(calculateSinkingFundSchedule(input([midCycle]))).funds[0]!;

    expect(item.currentCycleRequirement?.effectiveAt).toBe(midCycle.createdAt);
    expect(item.currentCycleRequirement?.requiredAmount.amountMinor).toBe(20_000n);
  });

  it('reports an overdue underfunded fund without dividing by zero', () => {
    const item = scheduleValue(
      calculateSinkingFundSchedule(
        input([fund(20, 30_000n, '2026-01-29')], [], {
          effectiveDate: parseLocalDate('2026-01-30'),
        }),
      ),
    ).funds[0]!;

    expect(item.state).toBe('overdue');
    expect(item.currentCycleRequirement?.outstandingAmount.amountMinor).toBe(30_000n);
  });

  it('requires complete salary and allocation history', () => {
    const target = fund(20, 30_000n);
    const incomplete = createMeasurementPeriod({
      startInclusive: parseInstant('2026-01-15T00:00:00Z'),
      endExclusive: COVERAGE.endExclusive,
    });
    const shortPaySchedule = createExpectedPrimaryPaySchedule({
      dates: [],
      completeThrough: parseLocalDate('2026-02-01'),
    });

    expect(calculateSinkingFundSchedule(input([target], [], { payCycles: [] })).status).toBe(
      'unavailable',
    );
    expect(
      calculateSinkingFundSchedule(input([target], [], { reservationCoverage: incomplete })).status,
    ).toBe('unavailable');
    expect(
      calculateSinkingFundSchedule(
        input([target], [], { expectedPrimaryPaySchedule: shortPaySchedule }),
      ).status,
    ).toBe('unavailable');
    expect(() =>
      calculateSinkingFundSchedule(
        input([target], [], { effectiveDate: parseLocalDate('2026-01-26') }),
      ),
    ).toThrowError(FinancialEngineInvariantError);
  });
});

describe('Sinking Fund allocations and protected cash', () => {
  it('converts current due to reserved cash one-for-one for partial and full allocation', () => {
    const target = fund(20, 60_000n);
    const before = calculateCurrentCycleSinkingDue(input([target]));
    const partialAllocation = allocation(30, target, 8_000n, parseInstant('2026-01-28T12:00:00Z'));
    const partial = calculateCurrentCycleSinkingDue(input([target], [partialAllocation]));
    const fullAllocation = allocation(31, target, 12_000n, parseInstant('2026-01-29T12:00:00Z'));
    const full = calculateCurrentCycleSinkingDue(
      input([target], [partialAllocation, fullAllocation]),
    );

    expect(before.value?.totalProtected.amountMinor).toBe(20_000n);
    expect(partial.value?.byFund[0]).toMatchObject({
      reserved: { amountMinor: 8_000n },
      outstanding: { amountMinor: 12_000n },
      protected: { amountMinor: 20_000n },
    });
    expect(full.value?.byFund[0]).toMatchObject({
      reserved: { amountMinor: 20_000n },
      outstanding: { amountMinor: 0n },
      protected: { amountMinor: 20_000n },
    });
  });

  it('restores current-cycle outstanding due when allocated cash is released', () => {
    const target = fund(20, 60_000n);
    const allocated = allocation(30, target, 20_000n, parseInstant('2026-01-28T08:00:00Z'));
    const released = allocation(
      31,
      target,
      8_000n,
      parseInstant('2026-01-29T08:00:00Z'),
      'release',
    );
    const result = calculateCurrentCycleSinkingDue(input([target], [allocated, released]));

    expect(result.value?.byFund[0]).toMatchObject({
      reserved: { amountMinor: 12_000n },
      fulfilled: { amountMinor: 12_000n },
      outstanding: { amountMinor: 8_000n },
      protected: { amountMinor: 20_000n },
    });
  });

  it('does not reopen current-cycle due when reserved cash funds consumption', () => {
    const target = fund(20, 60_000n);
    const allocated = allocation(30, target, 20_000n, parseInstant('2026-01-28T08:00:00Z'));
    const [spent, flow] = fundedConsumption(
      40,
      target,
      10_000n,
      parseInstant('2026-01-29T08:00:00Z'),
    );
    const result = calculateCurrentCycleSinkingDue(
      input([target], [allocated, spent], { economicFlows: [flow] }),
    );

    expect(result.value?.byFund[0]).toMatchObject({
      required: { amountMinor: 20_000n },
      satisfied: { amountMinor: 20_000n },
      reserved: { amountMinor: 10_000n },
      fundedConsumption: { amountMinor: 10_000n },
      fulfilled: { amountMinor: 20_000n },
      outstanding: { amountMinor: 0n },
    });
  });

  it('restores only released fulfillment after funded consumption', () => {
    const target = fund(20, 60_000n);
    const allocated = allocation(30, target, 20_000n, parseInstant('2026-01-28T08:00:00Z'));
    const [spent, flow] = fundedConsumption(
      40,
      target,
      10_000n,
      parseInstant('2026-01-29T08:00:00Z'),
    );
    const released = allocation(
      31,
      target,
      5_000n,
      parseInstant('2026-01-30T08:00:00Z'),
      'release',
    );
    const result = calculateCurrentCycleSinkingDue(
      input([target], [allocated, spent, released], { economicFlows: [flow] }),
    );

    expect(result.value?.byFund[0]).toMatchObject({
      reserved: { amountMinor: 5_000n },
      fundedConsumption: { amountMinor: 10_000n },
      fulfilled: { amountMinor: 15_000n },
      outstanding: { amountMinor: 5_000n },
    });
  });

  it('aggregates multiple allocations and multiple funds exactly', () => {
    const japan = fund(20, 60_000n);
    const insurance = fund(21, 24_000n);
    const allocations = [
      allocation(30, japan, 5_000n, parseInstant('2026-01-28T08:00:00Z')),
      allocation(31, japan, 7_000n, parseInstant('2026-01-28T09:00:00Z')),
      allocation(32, japan, 8_000n, parseInstant('2026-01-28T10:00:00Z')),
    ];
    const result = calculateCurrentCycleSinkingDue(input([japan, insurance], allocations));

    expect(
      result.value?.byFund.find((item) => item.fundId === japan.id)?.reserved.amountMinor,
    ).toBe(20_000n);
    expect(result.value?.totalOutstanding.amountMinor).toBe(8_000n);
    expect(result.value?.byFund.reduce((sum, item) => sum + item.outstanding.amountMinor, 0n)).toBe(
      result.value?.totalOutstanding.amountMinor,
    );
  });

  it('keeps owned cash and Net Worth unchanged after virtual allocation', () => {
    const target = fund(20, 60_000n);
    const event = allocation(30, target, 20_000n, parseInstant('2026-01-28T08:00:00Z'));
    const reserved = calculateReservedCash({
      funds: [target],
      allocations: [event],
      economicFlows: [],
      reservationCoverage: COVERAGE,
      liquidCash: createMoney(600_000n, EUR),
      asOf: AS_OF,
      engineVersion: '2c.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'watermark-1',
    });
    const bank = createAccount({
      id: parseAccountId(uuid(80)),
      subtype: 'bank',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    });
    const snapshot = createAccountBalanceSnapshot({
      accountId: bank.id,
      value: createNativeReportableAmount(createMoney(600_000n, EUR)),
      sourceAsOf: parseInstant('2026-01-30T10:00:00Z'),
      staleAt: parseInstant('2026-02-01T00:00:00Z'),
    });
    const netWorth = calculateNetWorth({
      accounts: [bank],
      transactions: [],
      investmentContributions: [],
      accountBalanceSnapshots: [snapshot],
      portfolioValuations: [],
      asOf: AS_OF,
      engineVersion: '2c.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'watermark-1',
    });

    expect(reserved.value).toMatchObject({
      totalReserved: { amountMinor: 20_000n },
      freeLiquidCash: { amountMinor: 580_000n },
      totalOwnedLiquidCash: { amountMinor: 600_000n },
    });
    expect(netWorth.value?.total.amountMinor).toBe(600_000n);
  });

  it('ignores allocations after as-of and rejects negative or excessive reservation state', () => {
    const target = fund(20, 60_000n);
    const future = allocation(30, target, 10_000n, parseInstant('2026-02-01T00:00:00Z'));
    const release = allocation(31, target, 1n, parseInstant('2026-01-28T00:00:00Z'), 'release');
    const common = {
      funds: [target],
      economicFlows: [],
      reservationCoverage: COVERAGE,
      liquidCash: createMoney(5_000n, EUR),
      asOf: AS_OF,
      engineVersion: '2c.0.0',
      settingsVersion: 'settings-1',
      inputWatermark: 'watermark-1',
    } as const;

    expect(
      calculateReservedCash({ ...common, allocations: [future] }).value?.totalReserved.amountMinor,
    ).toBe(0n);
    expect(() => calculateReservedCash({ ...common, allocations: [release] })).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() =>
      calculateReservedCash({
        ...common,
        allocations: [allocation(32, target, 5_001n, parseInstant('2026-01-28T00:00:00Z'))],
      }),
    ).toThrowError(FinancialEngineInvariantError);
  });

  it('rejects duplicate events, currency mismatches, and retained reserve on inactive funds', () => {
    const target = fund(20, 60_000n);
    const event = allocation(30, target, 1_000n, parseInstant('2026-01-28T00:00:00Z'));
    const wrongCurrency = createSinkingFundAllocation({
      ...event,
      id: parseSinkingFundAllocationId(uuid(31)),
      amount: createMoney(1_000n, parseCurrencyCode('USD')),
    });
    const completed = fund(21, 60_000n, '2026-03-27', undefined, { status: 'completed' });
    const retained = allocation(32, completed, 1_000n, parseInstant('2026-01-28T00:00:00Z'));

    expect(() => calculateSinkingFundSchedule(input([target], [event, event]))).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() => calculateSinkingFundSchedule(input([target], [wrongCurrency]))).toThrowError(
      FinancialEngineInvariantError,
    );
    expect(() => calculateSinkingFundSchedule(input([completed], [retained]))).toThrowError(
      FinancialEngineInvariantError,
    );
  });

  describe('Stage 4 reservation validation coverage', () => {
    it('rejects funded consumption without a matching same-instant consumption flow', () => {
      const target = fund(90, 10_000n);
      const reserved = allocation(91, target, 10_000n, parseInstant('2026-01-10T00:00:00Z'));
      const [spent, consumptionFlow] = fundedConsumption(
        92,
        target,
        1_000n,
        parseInstant('2026-01-20T00:00:00Z'),
      );
      const mismatchedFlow = createEconomicFlow({
        ...consumptionFlow,
        effectiveAt: parseInstant('2026-01-20T00:00:01Z'),
      });

      expect(() =>
        calculateSinkingFundSchedule(
          input([target], [reserved, spent], { economicFlows: [mismatchedFlow] }),
        ),
      ).toThrowError(FinancialEngineInvariantError);
    });

    it('rejects non-EUR funds and inconsistent Pay Cycle sequences', () => {
      const usdTarget = fund(93, 10_000n, undefined, undefined, {
        target: createMoney(10_000n, parseCurrencyCode('USD')),
      });
      expect(() => calculateSinkingFundSchedule(input([usdTarget]))).toThrowError(
        FinancialEngineInvariantError,
      );

      const laterCycle = createPayCycle({
        id: parsePayCycleId(uuid(94)),
        openingSalaryTransactionId: parseTransactionId(uuid(94)),
        startInclusive: parseInstant('2026-02-27T08:00:00Z'),
        startDate: parseLocalDate('2026-02-27'),
        closingSalaryTransactionId: null,
        endExclusive: null,
        expectedNextPayDate: parseLocalDate('2026-03-27'),
        status: 'open',
      });
      expect(() =>
        calculateSinkingFundSchedule(
          input([fund(95, 10_000n)], [], { payCycles: [CYCLE, laterCycle] }),
        ),
      ).toThrowError(FinancialEngineInvariantError);
    });

    it('caps reopened due at current remaining when prior overfunding absorbs a release', () => {
      const target = fund(96, 10_000n);
      const overfunded = allocation(97, target, 20_000n, parseInstant('2026-01-10T00:00:00Z'));
      const release = allocation(
        98,
        target,
        5_000n,
        parseInstant('2026-01-28T00:00:00Z'),
        'release',
      );
      const item = scheduleValue(
        calculateSinkingFundSchedule(input([target], [overfunded, release])),
      ).funds[0]!;

      expect(item.excess.amountMinor).toBe(5_000n);
      expect(item.remaining.amountMinor).toBe(0n);
      expect(item.currentCycleRequirement?.outstandingAmount.amountMinor).toBe(0n);
    });

    it('uses stable ID ordering when due date and priority are equal', () => {
      const first = fund(99, 10_000n, '2026-03-27', undefined, { priority: 1 });
      const second = fund(100, 10_000n, '2026-03-27', undefined, { priority: 1 });
      const value = scheduleValue(calculateSinkingFundSchedule(input([second, first])));

      expect(value.funds.map((item) => item.fundId)).toEqual([first.id, second.id]);
    });

    it('represents inactive and overfunded funds without requiring a Pay Cycle', () => {
      const inactive = fund(101, 10_000n, '2026-03-27', undefined, {
        status: 'cancelled',
        committed: false,
      });
      const overfunded = fund(102, 10_000n);
      const event = allocation(103, overfunded, 11_000n, parseInstant('2026-01-10T00:00:00Z'));
      const result = scheduleValue(
        calculateSinkingFundSchedule(input([overfunded, inactive], [event], { payCycles: [] })),
      );

      expect(result.funds.find((item) => item.fundId === inactive.id)?.state).toBe('inactive');
      expect(result.funds.find((item) => item.fundId === overfunded.id)?.state).toBe('overfunded');
    });

    it('propagates unavailable history through every reservation projection', () => {
      const target = fund(104, 10_000n);
      const incomplete = createMeasurementPeriod({
        startInclusive: parseInstant('2026-01-15T00:00:00Z'),
        endExclusive: COVERAGE.endExclusive,
      });
      const common = {
        funds: [target],
        allocations: [],
        economicFlows: [],
        reservationCoverage: incomplete,
        asOf: AS_OF,
        engineVersion: '2c.0.0',
        settingsVersion: 'settings-1',
        inputWatermark: 'watermark-1',
      } as const;

      expect(
        calculateCurrentCycleSinkingDue(input([target], [], { reservationCoverage: incomplete })),
      ).toMatchObject({ status: 'unavailable', value: null });
      expect(
        calculateReservedCash({ ...common, liquidCash: createMoney(10_000n, EUR) }),
      ).toMatchObject({ status: 'unavailable', value: null });
      expect(calculateFundedConsumptionCoverage(common)).toMatchObject({
        status: 'unavailable',
        value: null,
      });
    });

    it('rejects non-EUR liquid cash and reservation periods after as-of', () => {
      const target = fund(105, 10_000n);
      const common = {
        funds: [target],
        allocations: [],
        economicFlows: [],
        reservationCoverage: COVERAGE,
        asOf: AS_OF,
        engineVersion: '2c.0.0',
        settingsVersion: 'settings-1',
        inputWatermark: 'watermark-1',
      } as const;
      expect(() =>
        calculateReservedCash({
          ...common,
          liquidCash: createMoney(10_000n, parseCurrencyCode('USD')),
        }),
      ).toThrowError(FinancialEngineInvariantError);
      expect(() =>
        calculateReservationEffect({
          ...common,
          period: createMeasurementPeriod({
            startInclusive: AS_OF,
            endExclusive: parseInstant('2026-02-01T00:00:00Z'),
          }),
        }),
      ).toThrowError(FinancialEngineInvariantError);
    });
  });
});
