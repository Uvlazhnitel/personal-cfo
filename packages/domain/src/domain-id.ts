import { DomainValidationError } from './errors.js';

declare const domainIdBrand: unique symbol;

export type DomainId<Entity extends string> = string & {
  readonly [domainIdBrand]: Entity;
};

export type AccountId = DomainId<'account'>;
export type TransactionId = DomainId<'transaction'>;
export type EntryId = DomainId<'entry'>;

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

export function serializeDomainId<Entity extends string>(id: DomainId<Entity>): string {
  return id;
}
