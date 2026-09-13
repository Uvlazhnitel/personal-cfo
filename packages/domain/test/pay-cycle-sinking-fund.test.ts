import { describe, expect, it } from 'vitest';

import {
  DomainValidationError,
  EUR,
  createExpectedPrimaryPaySchedule,
  createMoney,
  createPayCycle,
  createPrimarySalaryTrigger,
  createSinkingFund,
  createSinkingFundAllocation,
  parseInstant,
  parseLocalDate,
  parsePayCycleId,
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseTransactionId,
  sinkingFundAllocationDelta,
} from '../src/index.js';
import type { SinkingFund } from '../src/index.js';

function uuid(seed: number): string {
  return `01890f3e-7b2c-7${seed.toString(16).padStart(3, '0')}-8abc-${seed
    .toString(16)
    .padStart(12, '0')}`;
}

function fund(overrides: Partial<SinkingFund> = {}): SinkingFund {
  return createSinkingFund({
    id: parseSinkingFundId(uuid(1)),
    label: 'Annual insurance',
    target: createMoney(120_000n, EUR),
    dueDate: parseLocalDate('2027-01-15'),
    priority: 1,
    committed: true,
    status: 'active',
    allocationPolicy: 'manual',
    createdAt: parseInstant('2026-09-13T08:00:00Z'),
    ...overrides,
  });
}

describe('Pay Cycle domain facts', () => {
  it('normalizes immutable salary triggers and open cycles', () => {
    const transactionId = parseTransactionId(uuid(10));
    const trigger = createPrimarySalaryTrigger({
      transactionId,
      effectiveDate: parseLocalDate('2026-09-27'),
    });
    const cycle = createPayCycle({
      id: parsePayCycleId(transactionId),
      openingSalaryTransactionId: transactionId,
      startInclusive: parseInstant('2026-09-27T08:00:00Z'),
      startDate: trigger.effectiveDate,
      closingSalaryTransactionId: null,
      endExclusive: null,
      expectedNextPayDate: parseLocalDate('2026-10-28'),
      status: 'open',
    });

    expect(Object.isFrozen(trigger)).toBe(true);
    expect(Object.isFrozen(cycle)).toBe(true);
    expect(cycle.id).toBe(transactionId);
  });

  it('rejects inconsistent closure and expected-date state', () => {
    const transactionId = parseTransactionId(uuid(10));
    const base = {
      id: parsePayCycleId(transactionId),
      openingSalaryTransactionId: transactionId,
      startInclusive: parseInstant('2026-09-27T08:00:00Z'),
      startDate: parseLocalDate('2026-09-27'),
      closingSalaryTransactionId: null,
      endExclusive: null,
      expectedNextPayDate: null,
      status: 'open' as const,
    };

    expect(() =>
      createPayCycle({
        ...base,
        closingSalaryTransactionId: parseTransactionId(uuid(11)),
      }),
    ).toThrowError(DomainValidationError);
    expect(() =>
      createPayCycle({
        ...base,
        expectedNextPayDate: parseLocalDate('2026-09-27'),
      }),
    ).toThrowError(DomainValidationError);
    expect(() =>
      createPayCycle({
        ...base,
        closingSalaryTransactionId: parseTransactionId(uuid(11)),
        endExclusive: parseInstant('2026-10-28T08:00:00Z'),
        expectedNextPayDate: parseLocalDate('2026-10-28'),
        status: 'closed',
      }),
    ).toThrowError(DomainValidationError);
  });

  it('requires expected salary dates to be unique, ordered, and covered', () => {
    expect(() =>
      createExpectedPrimaryPaySchedule({
        dates: [parseLocalDate('2026-10-28'), parseLocalDate('2026-10-28')],
        completeThrough: parseLocalDate('2026-12-31'),
      }),
    ).toThrowError(DomainValidationError);
    expect(() =>
      createExpectedPrimaryPaySchedule({
        dates: [parseLocalDate('2027-01-28')],
        completeThrough: parseLocalDate('2026-12-31'),
      }),
    ).toThrowError(DomainValidationError);
  });
});

describe('Sinking Fund domain facts', () => {
  it('supports manual and opt-in primary-income policies as immutable configuration', () => {
    const manual = fund();
    const automatic = fund({ allocationPolicy: 'on_primary_income' });

    expect(manual.allocationPolicy).toBe('manual');
    expect(automatic.allocationPolicy).toBe('on_primary_income');
    expect(Object.isFrozen(automatic)).toBe(true);
  });

  it('rejects invalid targets, priorities, and commitments', () => {
    expect(() => fund({ target: createMoney(0n, EUR) })).toThrowError(DomainValidationError);
    expect(() => fund({ priority: -1 })).toThrowError(DomainValidationError);
    expect(() => fund({ committed: 'yes' as unknown as boolean })).toThrowError(
      DomainValidationError,
    );
  });

  it('uses positive event magnitudes and deterministic signed reservation deltas', () => {
    const target = fund();
    const base = {
      fundId: target.id,
      amount: createMoney(5_000n, EUR),
      effectiveAt: parseInstant('2026-09-28T08:00:00Z'),
    };
    const allocation = createSinkingFundAllocation({
      ...base,
      id: parseSinkingFundAllocationId(uuid(20)),
      kind: 'allocation',
    });
    const release = createSinkingFundAllocation({
      ...base,
      id: parseSinkingFundAllocationId(uuid(21)),
      kind: 'release',
    });
    const fundedConsumption = createSinkingFundAllocation({
      ...base,
      id: parseSinkingFundAllocationId(uuid(22)),
      kind: 'funded_consumption',
      relatedTransactionId: parseTransactionId(uuid(23)),
    });

    expect(sinkingFundAllocationDelta(allocation)).toBe(5_000n);
    expect(sinkingFundAllocationDelta(release)).toBe(-5_000n);
    expect(sinkingFundAllocationDelta(fundedConsumption)).toBe(-5_000n);
    expect(Object.isFrozen(fundedConsumption)).toBe(true);
    expect(() =>
      createSinkingFundAllocation({
        ...base,
        id: parseSinkingFundAllocationId(uuid(24)),
        amount: createMoney(0n, EUR),
        kind: 'allocation',
      }),
    ).toThrowError(DomainValidationError);
  });
});
