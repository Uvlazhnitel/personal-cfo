import type { SinkingFundAllocationId, SinkingFundId, TransactionId } from './domain-id.js';
import {
  parseSinkingFundAllocationId,
  parseSinkingFundId,
  parseTransactionId,
} from './domain-id.js';
import { DomainValidationError } from './errors.js';
import type { Instant } from './instant.js';
import { parseInstant } from './instant.js';
import type { LocalDate } from './local-date.js';
import { parseLocalDate } from './local-date.js';
import type { Money } from './money.js';
import { createMoney } from './money.js';
import { expectNonEmptyString, parseStringEnum } from './validation.js';

export const SINKING_FUND_STATUSES = ['active', 'completed', 'cancelled'] as const;
export type SinkingFundStatus = (typeof SINKING_FUND_STATUSES)[number];

export const SINKING_FUND_ALLOCATION_POLICIES = ['manual', 'on_primary_income'] as const;
export type SinkingFundAllocationPolicy = (typeof SINKING_FUND_ALLOCATION_POLICIES)[number];

export type SinkingFund = Readonly<{
  id: SinkingFundId;
  label: string;
  target: Money;
  dueDate: LocalDate;
  priority: number;
  committed: boolean;
  status: SinkingFundStatus;
  allocationPolicy: SinkingFundAllocationPolicy;
  createdAt: Instant;
}>;

export function createSinkingFund(value: SinkingFund): SinkingFund {
  const target = createMoney(value.target.amountMinor, value.target.currency);
  if (target.amountMinor <= 0n) {
    throw new DomainValidationError(
      'sinking_fund.invalid_target',
      'A Sinking Fund target must be positive.',
    );
  }
  if (!Number.isSafeInteger(value.priority) || value.priority < 0) {
    throw new DomainValidationError(
      'sinking_fund.invalid_priority',
      'Sinking Fund priority must be a non-negative safe integer.',
    );
  }
  if (typeof value.committed !== 'boolean') {
    throw new DomainValidationError(
      'sinking_fund.invalid_commitment',
      'Sinking Fund committed must be a boolean.',
    );
  }

  return Object.freeze({
    id: parseSinkingFundId(value.id),
    label: expectNonEmptyString(value.label, 'SinkingFund.label'),
    target,
    dueDate: parseLocalDate(value.dueDate),
    priority: value.priority,
    committed: value.committed,
    status: parseStringEnum(value.status, SINKING_FUND_STATUSES, 'SinkingFundStatus'),
    allocationPolicy: parseStringEnum(
      value.allocationPolicy,
      SINKING_FUND_ALLOCATION_POLICIES,
      'SinkingFundAllocationPolicy',
    ),
    createdAt: parseInstant(value.createdAt),
  });
}

export const SINKING_FUND_ALLOCATION_KINDS = [
  'allocation',
  'funded_consumption',
  'release',
] as const;
export type SinkingFundAllocationKind = (typeof SINKING_FUND_ALLOCATION_KINDS)[number];

type SinkingFundAllocationBase = Readonly<{
  id: SinkingFundAllocationId;
  fundId: SinkingFundId;
  amount: Money;
  effectiveAt: Instant;
}>;

export type SinkingFundAllocation =
  | (SinkingFundAllocationBase & Readonly<{ kind: 'allocation' | 'release' }>)
  | (SinkingFundAllocationBase &
      Readonly<{ kind: 'funded_consumption'; relatedTransactionId: TransactionId }>);

export function createSinkingFundAllocation(value: SinkingFundAllocation): SinkingFundAllocation {
  parseStringEnum(value.kind, SINKING_FUND_ALLOCATION_KINDS, 'SinkingFundAllocationKind');
  const base = {
    id: parseSinkingFundAllocationId(value.id),
    fundId: parseSinkingFundId(value.fundId),
    amount: createMoney(value.amount.amountMinor, value.amount.currency),
    effectiveAt: parseInstant(value.effectiveAt),
  };
  if (base.amount.amountMinor <= 0n) {
    throw new DomainValidationError(
      'sinking_fund.invalid_allocation_amount',
      'Sinking Fund allocation events use positive magnitudes.',
    );
  }

  return value.kind === 'funded_consumption'
    ? Object.freeze({
        ...base,
        kind: value.kind,
        relatedTransactionId: parseTransactionId(value.relatedTransactionId),
      })
    : Object.freeze({ ...base, kind: value.kind });
}

export function sinkingFundAllocationDelta(value: SinkingFundAllocation): bigint {
  return value.kind === 'allocation' ? value.amount.amountMinor : -value.amount.amountMinor;
}

export function sinkingFundFulfillmentDelta(value: SinkingFundAllocation): bigint {
  if (value.kind === 'allocation') return value.amount.amountMinor;
  if (value.kind === 'release') return -value.amount.amountMinor;
  return 0n;
}

export function sinkingFundFundedConsumptionDelta(value: SinkingFundAllocation): bigint {
  return value.kind === 'funded_consumption' ? value.amount.amountMinor : 0n;
}
