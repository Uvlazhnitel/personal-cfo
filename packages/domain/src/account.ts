import type { CurrencyCode } from './currency.js';
import { parseCurrencyCode } from './currency.js';
import type { AccountId } from './domain-id.js';
import { parseAccountId } from './domain-id.js';
import { DomainValidationError } from './errors.js';
import { parseStringEnum } from './validation.js';

export const ACCOUNT_SUBTYPES = ['bank', 'cash', 'investment', 'other_asset', 'liability'] as const;

export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const ACCOUNT_VALUE_SOURCES = ['ledger', 'balance_snapshot', 'portfolio_valuation'] as const;

export type AccountValueSource = (typeof ACCOUNT_VALUE_SOURCES)[number];

export type Account = Readonly<{
  id: AccountId;
  subtype: AccountSubtype;
  currency: CurrencyCode;
  includeInNetWorth: boolean;
  valueSource: AccountValueSource;
  brokerageCashFor: AccountId | null;
}>;

export function parseAccountSubtype(value: unknown): AccountSubtype {
  return parseStringEnum(value, ACCOUNT_SUBTYPES, 'AccountSubtype');
}

export function parseAccountValueSource(value: unknown): AccountValueSource {
  return parseStringEnum(value, ACCOUNT_VALUE_SOURCES, 'AccountValueSource');
}

function validateValueSource(subtype: AccountSubtype, source: AccountValueSource): void {
  const expected =
    subtype === 'cash'
      ? 'ledger'
      : subtype === 'investment'
        ? 'portfolio_valuation'
        : 'balance_snapshot';

  if (source !== expected) {
    throw new DomainValidationError(
      'account.invalid_value_source',
      `${subtype} accounts must use ${expected} as their value source.`,
    );
  }
}

export function createAccount(account: Account): Account {
  const id = parseAccountId(account.id);
  const subtype = parseAccountSubtype(account.subtype);
  const valueSource = parseAccountValueSource(account.valueSource);

  if (typeof account.includeInNetWorth !== 'boolean') {
    throw new DomainValidationError(
      'account.invalid_inclusion',
      'Account includeInNetWorth must be a boolean.',
    );
  }

  validateValueSource(subtype, valueSource);

  const brokerageCashFor =
    account.brokerageCashFor === null ? null : parseAccountId(account.brokerageCashFor);

  if (brokerageCashFor !== null && subtype !== 'cash') {
    throw new DomainValidationError(
      'account.invalid_brokerage_cash',
      'Only a cash account can be linked as brokerage cash.',
    );
  }

  if (brokerageCashFor === id) {
    throw new DomainValidationError(
      'account.self_linked_brokerage_cash',
      'A brokerage cash account cannot link to itself.',
    );
  }

  return Object.freeze({
    id,
    subtype,
    currency: parseCurrencyCode(account.currency),
    includeInNetWorth: account.includeInNetWorth,
    valueSource,
    brokerageCashFor,
  });
}
