import { DomainValidationError } from './errors.js';

declare const domainIdBrand: unique symbol;

export type DomainId<Entity extends string> = string & {
  readonly [domainIdBrand]: Entity;
};

export type AccountId = DomainId<'account'>;
export type TransactionId = DomainId<'transaction'>;
export type EntryId = DomainId<'entry'>;
export type FxRateId = DomainId<'fx-rate'>;
export type EconomicFlowId = DomainId<'economic-flow'>;
export type CashReconciliationId = DomainId<'cash-reconciliation'>;
export type PayCycleId = DomainId<'pay-cycle'>;
export type SinkingFundId = DomainId<'sinking-fund'>;
export type SinkingFundAllocationId = DomainId<'sinking-fund-allocation'>;
export type SpendingCategoryId = DomainId<'spending-category'>;
export type ScheduledSpendingId = DomainId<'scheduled-spending'>;
export type OperationalNeedId = DomainId<'operational-need'>;
export type FutureObligationId = DomainId<'future-obligation'>;
export type RestrictedCashId = DomainId<'restricted-cash'>;
export type RecurringInvestmentPlanId = DomainId<'recurring-investment-plan'>;
export type RecurringInvestmentOccurrenceId = DomainId<'recurring-investment-occurrence'>;

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseDomainId<Entity extends string>(
  value: unknown,
  entity: Entity,
): DomainId<Entity> {
  if (typeof value !== 'string' || !UUID_V7_PATTERN.test(value)) {
    throw new DomainValidationError('id.invalid_uuid_v7', `${entity} ID must be a valid UUIDv7.`);
  }

  return value.toLowerCase() as DomainId<Entity>;
}

export function parseAccountId(value: unknown): AccountId {
  return parseDomainId(value, 'account');
}

export function parseTransactionId(value: unknown): TransactionId {
  return parseDomainId(value, 'transaction');
}

export function parseEntryId(value: unknown): EntryId {
  return parseDomainId(value, 'entry');
}

export function parseFxRateId(value: unknown): FxRateId {
  return parseDomainId(value, 'fx-rate');
}

export function parseEconomicFlowId(value: unknown): EconomicFlowId {
  return parseDomainId(value, 'economic-flow');
}

export function parseCashReconciliationId(value: unknown): CashReconciliationId {
  return parseDomainId(value, 'cash-reconciliation');
}

export function parsePayCycleId(value: unknown): PayCycleId {
  return parseDomainId(value, 'pay-cycle');
}

export function parseSinkingFundId(value: unknown): SinkingFundId {
  return parseDomainId(value, 'sinking-fund');
}

export function parseSinkingFundAllocationId(value: unknown): SinkingFundAllocationId {
  return parseDomainId(value, 'sinking-fund-allocation');
}

export function parseSpendingCategoryId(value: unknown): SpendingCategoryId {
  return parseDomainId(value, 'spending-category');
}

export function parseScheduledSpendingId(value: unknown): ScheduledSpendingId {
  return parseDomainId(value, 'scheduled-spending');
}

export function parseOperationalNeedId(value: unknown): OperationalNeedId {
  return parseDomainId(value, 'operational-need');
}

export function parseFutureObligationId(value: unknown): FutureObligationId {
  return parseDomainId(value, 'future-obligation');
}

export function parseRestrictedCashId(value: unknown): RestrictedCashId {
  return parseDomainId(value, 'restricted-cash');
}

export function parseRecurringInvestmentPlanId(value: unknown): RecurringInvestmentPlanId {
  return parseDomainId(value, 'recurring-investment-plan');
}

export function parseRecurringInvestmentOccurrenceId(
  value: unknown,
): RecurringInvestmentOccurrenceId {
  return parseDomainId(value, 'recurring-investment-occurrence');
}

export function serializeDomainId<Entity extends string>(id: DomainId<Entity>): string {
  return id;
}
