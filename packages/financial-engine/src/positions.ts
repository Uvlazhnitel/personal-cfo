import {
  EUR,
  compareInstants,
  createAccountBalanceSnapshot,
  createMetricResult,
  createMoney,
  createPortfolioValuation,
  parseInstant,
} from '@personal-cfo/domain';
import type {
  AccountBalanceSnapshot,
  DataWarning,
  Instant,
  MetricResult,
  Money,
  PortfolioValuation,
  ReportableAmount,
} from '@personal-cfo/domain';

import type { LedgerInput } from './ledger.js';
import { calculateLedgerBalance, validateLedger } from './ledger.js';
import { calculateNetWorth } from './net-worth.js';

export type CurrentPositions = Readonly<{
  liquidCash: MetricResult<Money>;
  investmentMarketValue: MetricResult<Money>;
}>;

export type CurrentPositionsInput = LedgerInput &
  Readonly<{
    accountBalanceSnapshots: readonly AccountBalanceSnapshot[];
    portfolioValuations: readonly PortfolioValuation[];
    asOf: Instant;
    engineVersion: string;
    settingsVersion: string;
    inputWatermark: string;
  }>;

function warning(code: string, accountId: string): DataWarning {
  return Object.freeze({ code, context: Object.freeze({ accountId }) });
}

function reported(value: ReportableAmount): Money | null {
  return value.status === 'missing_fx' || value.reporting.currency !== EUR ? null : value.reporting;
}

export function calculateCurrentPositions(input: CurrentPositionsInput): CurrentPositions {
  const asOf = parseInstant(input.asOf);
  // Reuse all accepted cross-account and brokerage-cash validation before projecting components.
  calculateNetWorth(input);
  const ledger = validateLedger(input);
  const snapshots = input.accountBalanceSnapshots.map((item) => createAccountBalanceSnapshot(item));
  const valuations = input.portfolioValuations.map((item) => createPortfolioValuation(item));
  const base = {
    asOf,
    engineVersion: input.engineVersion,
    settingsVersion: input.settingsVersion,
    inputWatermark: input.inputWatermark,
  } as const;

  const component = (kind: 'liquid' | 'investment'): MetricResult<Money> => {
    const accounts = ledger.accounts.filter(
      (account) =>
        account.includeInNetWorth &&
        (kind === 'liquid'
          ? account.subtype === 'bank' || account.subtype === 'cash'
          : account.subtype === 'investment'),
    );
    let total = 0n;
    let missing = false;
    let partial = false;
    const warnings: DataWarning[] = [];
    for (const account of accounts) {
      if (account.valueSource === 'ledger') {
        total += calculateLedgerBalance({ ledger, accountId: account.id, asOf }).amountMinor;
        continue;
      }
      const source =
        account.valueSource === 'balance_snapshot'
          ? snapshots
              .filter((item) => item.accountId === account.id && item.sourceAsOf <= asOf)
              .sort((a, b) => compareInstants(a.sourceAsOf, b.sourceAsOf))
              .at(-1)
          : valuations
              .filter((item) => item.accountId === account.id && item.sourceAsOf <= asOf)
              .sort((a, b) => compareInstants(a.sourceAsOf, b.sourceAsOf))
              .at(-1);
      if (source === undefined) {
        missing = true;
        warnings.push(warning('positions.missing_value', account.id));
        continue;
      }
      const value = 'value' in source ? reported(source.value) : reported(source.marketValue);
      if (value === null) {
        missing = true;
        warnings.push(warning('positions.missing_fx', account.id));
        continue;
      }
      total += value.amountMinor;
      if (compareInstants(asOf, source.staleAt) > 0) {
        partial = true;
        warnings.push(warning('positions.stale_value', account.id));
      }
    }
    warnings.sort(
      (a, b) =>
        a.code.localeCompare(b.code) ||
        (a.context['accountId'] ?? '').localeCompare(b.context['accountId'] ?? ''),
    );
    return createMetricResult<Money>({
      ...base,
      status: missing ? 'unavailable' : partial ? 'partial' : 'complete',
      value: missing ? null : createMoney(total, EUR),
      explanation: missing
        ? []
        : [
            {
              ruleId: `positions.${kind}`,
              inputKey: kind,
              value: total.toString(),
            },
          ],
      warnings,
    });
  };

  return Object.freeze({
    liquidCash: component('liquid'),
    investmentMarketValue: component('investment'),
  });
}
