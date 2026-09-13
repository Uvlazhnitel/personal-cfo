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

export function serializeDomainId<Entity extends string>(id: DomainId<Entity>): string {
  return id;
}
