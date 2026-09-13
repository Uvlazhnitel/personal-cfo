import {
  createAccount,
  createCanonicalTransaction,
  createInvestmentContribution,
  createMoney,
  compareInstants,
  parseAccountId,
  parseInstant,
} from '@personal-cfo/domain';
import type {
  Account,
  AccountId,
  CanonicalTransaction,
  Instant,
  InvestmentContribution,
  Money,
} from '@personal-cfo/domain';

import { FinancialEngineInvariantError } from './errors.js';

export type LedgerInput = Readonly<{
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  investmentContributions: readonly InvestmentContribution[];
}>;

export type ValidatedLedger = Readonly<{
  accounts: readonly Account[];
  transactions: readonly CanonicalTransaction[];
  investmentContributions: readonly InvestmentContribution[];
}>;

function requireUnique(values: readonly string[], code: string, label: string): void {
  if (new Set(values).size !== values.length) {
    throw new FinancialEngineInvariantError(code, `${label} must be unique.`);
  }
}

function validateBrokerageCashLinks(accounts: readonly Account[]): void {
  const byId = new Map(accounts.map((account) => [account.id, account]));

  for (const account of accounts) {
    if (account.brokerageCashFor === null) continue;
    const investmentAccount = byId.get(account.brokerageCashFor);

    if (investmentAccount?.subtype !== 'investment') {
      throw new FinancialEngineInvariantError(
        'ledger.invalid_brokerage_cash_link',
        'Brokerage cash must link to an existing investment account.',
      );
    }
  }
}

function validateEntries(
  accounts: readonly Account[],
  transactions: readonly CanonicalTransaction[],
): void {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const entries = transactions.flatMap((transaction) => transaction.entries);
  requireUnique(
    entries.map((entry) => entry.id),
    'ledger.duplicate_entry_id',
    'Entry IDs across the ledger',
  );

  for (const entry of entries) {
    const account = byId.get(entry.accountId);
    if (account === undefined) {
      throw new FinancialEngineInvariantError(
        'ledger.unknown_account',
        'Every account entry must reference a known account.',
      );
    }

    if (entry.amount.currency !== account.currency) {
      throw new FinancialEngineInvariantError(
        'ledger.entry_currency_mismatch',
        'Account entries must use their account currency.',
      );
    }
  }
}

function validateContributions(
  accounts: readonly Account[],
  transactions: readonly CanonicalTransaction[],
  contributions: readonly InvestmentContribution[],
): void {
  const accountsById = new Map(accounts.map((account) => [account.id, account]));
  const transactionsById = new Map(
    transactions.map((transaction) => [transaction.id, transaction]),
  );

  requireUnique(
    contributions.map((contribution) => contribution.transactionId),
    'ledger.duplicate_contribution',
    'Investment contribution transaction IDs',
  );

  for (const transaction of transactions) {
    if (
      transaction.kind === 'investment_contribution' &&
      !contributions.some((contribution) => contribution.transactionId === transaction.id)
    ) {
      throw new FinancialEngineInvariantError(
        'ledger.missing_contribution_fact',
        'Every investment contribution transaction requires a principal fact.',
      );
    }
  }

  for (const contribution of contributions) {
    const account = accountsById.get(contribution.investmentAccountId);
    const transaction = transactionsById.get(contribution.transactionId);

    if (account?.subtype !== 'investment') {
      throw new FinancialEngineInvariantError(
        'ledger.invalid_contribution_account',
        'Investment contribution principal must target an investment account.',
      );
    }

    if (
      transaction?.kind !== 'investment_contribution' ||
      transaction.bookingStatus !== 'booked' ||
      transaction.effectiveAt !== contribution.effectiveAt
    ) {
      throw new FinancialEngineInvariantError(
        'ledger.invalid_contribution_transaction',
        'Investment contribution principal must match its booked transfer transaction.',
      );
    }

    const destinationPrincipal = transaction.entries
      .filter(
        (entry) =>
          entry.role === 'transfer_destination' &&
          entry.accountId === contribution.investmentAccountId,
      )
      .reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);

    if (
      contribution.principal.currency !== account.currency ||
      destinationPrincipal !== contribution.principal.amountMinor
    ) {
      throw new FinancialEngineInvariantError(
        'ledger.contribution_principal_mismatch',
        'Contribution principal must equal the investment destination entries.',
      );
    }
  }
}

export function validateLedger(input: LedgerInput): ValidatedLedger {
  const accounts = Object.freeze(input.accounts.map((account) => createAccount(account)));
  const transactions = Object.freeze(
    input.transactions.map((transaction) => createCanonicalTransaction(transaction)),
  );
  const investmentContributions = Object.freeze(
    input.investmentContributions.map((contribution) => createInvestmentContribution(contribution)),
  );

  requireUnique(
    accounts.map((account) => account.id),
    'ledger.duplicate_account_id',
    'Account IDs',
  );
  requireUnique(
    transactions.map((transaction) => transaction.id),
    'ledger.duplicate_transaction_id',
    'Transaction IDs',
  );
  validateBrokerageCashLinks(accounts);
  validateEntries(accounts, transactions);
  validateContributions(accounts, transactions, investmentContributions);

  return Object.freeze({ accounts, transactions, investmentContributions });
}

export type LedgerBalanceInput = Readonly<{
  ledger: ValidatedLedger;
  accountId: AccountId;
  asOf: Instant;
}>;

export function calculateLedgerBalance(input: LedgerBalanceInput): Money {
  const accountId = parseAccountId(input.accountId);
  const asOf = parseInstant(input.asOf);
  const account = input.ledger.accounts.find((candidate) => candidate.id === accountId);

  if (account === undefined) {
    throw new FinancialEngineInvariantError(
      'ledger.unknown_balance_account',
      'Cannot calculate a balance for an unknown account.',
    );
  }

  if (account.valueSource !== 'ledger') {
    throw new FinancialEngineInvariantError(
      'ledger.non_authoritative_balance_source',
      'Ledger balances are authoritative only for accounts configured with a ledger value source.',
    );
  }

  const amountMinor = input.ledger.transactions.reduce((balance, transaction) => {
    if (
      transaction.bookingStatus !== 'booked' ||
      compareInstants(transaction.effectiveAt, asOf) > 0
    ) {
      return balance;
    }

    return transaction.entries.reduce(
      (entryBalance, entry) =>
        entry.accountId === accountId ? entryBalance + entry.amount.amountMinor : entryBalance,
      balance,
    );
  }, 0n);

  return createMoney(amountMinor, account.currency);
}
