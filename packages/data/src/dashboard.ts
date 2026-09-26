import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';

import type { Database } from './database.js';
import { SYNTHETIC_OWNER_ID } from './owners.js';
import {
  enableBankingBalanceReconciliations,
  enableBankingConnections,
  enableBankingProviderAccounts,
  enableBankingRuns,
  metricSnapshots,
  portfolioManagerSyncRuns,
  portfolioManagerSyncStates,
  portfolioProviderBindings,
  portfolioValuations,
  sharesightSyncRuns,
  sharesightSyncStates,
  users,
} from './schema.js';

export type DashboardDataState = 'available' | 'incomplete' | 'stale' | 'unavailable';

export type DashboardMoney = Readonly<{
  amountMinor: bigint;
  currency: 'EUR';
}>;

export type DashboardMetric<T> = Readonly<{
  state: DashboardDataState;
  value: T | null;
  asOf: string | null;
  reason: string | null;
}>;

export type DashboardSource = Readonly<{
  state: DashboardDataState;
  label: string;
  lastSuccessfulAt: string | null;
  detail: string;
}>;

export type DashboardOverview = Readonly<{
  locale: string;
  timeZone: string;
  synthetic: boolean;
  metrics: Readonly<{
    netWorth: DashboardMetric<DashboardMoney>;
    monthlyNetWorthChange: DashboardMetric<DashboardMoney>;
    capitalConversionRate: DashboardMetric<Readonly<{ numerator: bigint; denominator: bigint }>>;
    safeToInvest: DashboardMetric<DashboardMoney>;
    availableCash: DashboardMetric<DashboardMoney>;
    comfortReserve: DashboardMetric<DashboardMoney>;
    investmentPortfolio: DashboardMetric<DashboardMoney>;
    reservedSinkingFunds: DashboardMetric<DashboardMoney>;
  }>;
  sources: Readonly<{
    bank: DashboardSource;
    portfolio: DashboardSource;
    lastSuccessfulUpdate: string | null;
  }>;
}>;

type MetricRow = typeof metricSnapshots.$inferSelect;

const unavailable = <T>(reason = 'no_calculation'): DashboardMetric<T> =>
  Object.freeze({ state: 'unavailable', value: null, asOf: null, reason });

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function warningCodes(payload: Readonly<Record<string, unknown>>): readonly string[] {
  const warnings = payload['warnings'];
  if (!Array.isArray(warnings)) return Object.freeze([]);
  return Object.freeze(
    warnings.flatMap((warning) => {
      const parsed = record(warning);
      return typeof parsed?.['code'] === 'string' ? [parsed['code']] : [];
    }),
  );
}

function dataState(row: MetricRow, payload: Readonly<Record<string, unknown>>): DashboardDataState {
  if (warningCodes(payload).some((code) => code.includes('stale'))) return 'stale';
  if (row.status === 'complete') return 'available';
  if (row.status === 'partial') return 'incomplete';
  return 'unavailable';
}

function reasonFor(
  state: DashboardDataState,
  payload: Readonly<Record<string, unknown>>,
): string | null {
  if (state === 'available') return null;
  const codes = warningCodes(payload);
  if (state === 'stale') return 'source_data_stale';
  if (codes.includes('safe_to_invest.blocked')) return 'recommendation_blocked';
  if (codes.includes('ccr.missing_history_coverage')) return 'history_incomplete';
  if (state === 'incomplete') return 'source_data_incomplete';
  return 'required_data_unavailable';
}

function parseInteger(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?(0|[1-9][0-9]*)$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function parseMoney(value: unknown): DashboardMoney | null {
  const parsed = record(value);
  const amountMinor = parseInteger(parsed?.['amountMinor']);
  return amountMinor === null || parsed?.['currency'] !== 'EUR'
    ? null
    : Object.freeze({ amountMinor, currency: 'EUR' as const });
}

function nestedValue(row: MetricRow | undefined, key: string): DashboardMetric<DashboardMoney> {
  if (row === undefined) return unavailable();
  const payload = record(row.payload);
  if (payload === null) return unavailable('invalid_persisted_result');
  const value = record(payload['value']);
  const money = parseMoney(value?.[key]);
  const state = dataState(row, payload);
  if (state === 'unavailable')
    return Object.freeze({
      state,
      value: null,
      asOf: row.asOf,
      reason: reasonFor(state, payload),
    });
  if (money === null)
    return Object.freeze({
      state: state === 'stale' ? 'stale' : 'unavailable',
      value: null,
      asOf: row.asOf,
      reason: reasonFor(state, payload) ?? 'required_data_unavailable',
    });
  return Object.freeze({ state, value: money, asOf: row.asOf, reason: reasonFor(state, payload) });
}

function ratioValue(
  row: MetricRow | undefined,
): DashboardMetric<Readonly<{ numerator: bigint; denominator: bigint }>> {
  if (row === undefined) return unavailable();
  const payload = record(row.payload);
  const value = record(payload?.['value']);
  const ratio = record(value?.['ratio']);
  const numerator = parseInteger(ratio?.['numerator']);
  const denominator = parseInteger(ratio?.['denominator']);
  if (payload === null || numerator === null || denominator === null || denominator <= 0n)
    return Object.freeze({
      state: 'unavailable',
      value: null,
      asOf: row.asOf,
      reason: 'required_data_unavailable',
    });
  const state = dataState(row, payload);
  if (state === 'unavailable')
    return Object.freeze({
      state,
      value: null,
      asOf: row.asOf,
      reason: reasonFor(state, payload),
    });
  return Object.freeze({
    state,
    value: Object.freeze({ numerator, denominator }),
    asOf: row.asOf,
    reason: reasonFor(state, payload),
  });
}

function safeToInvestValue(row: MetricRow | undefined): DashboardMetric<DashboardMoney> {
  const parsed = nestedValue(row, 'recommended');
  if (parsed.state === 'available') return parsed;
  return Object.freeze({ ...parsed, value: null });
}

function monthKey(instant: string, timeZone: string): string | null {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value;
    const month = parts.find((part) => part.type === 'month')?.value;
    return year === undefined || month === undefined ? null : `${year}-${month}`;
  } catch {
    return null;
  }
}

function previousMonth(key: string): string {
  const [yearText, monthText] = key.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  return month === 1
    ? `${String(year - 1).padStart(4, '0')}-12`
    : `${String(year).padStart(4, '0')}-${String(month - 1).padStart(2, '0')}`;
}

function monthlyChange(
  currentRow: MetricRow | undefined,
  history: readonly MetricRow[],
  timeZone: string,
): DashboardMetric<DashboardMoney> {
  const current = nestedValue(currentRow, 'total');
  if (current.state !== 'available' || current.value === null || current.asOf === null)
    return unavailable('monthly_baseline_unavailable');
  const currentMonth = monthKey(current.asOf, timeZone);
  if (currentMonth === null) return unavailable('monthly_baseline_unavailable');
  const baselineRow = history.find(
    (row) =>
      row.id !== currentRow?.id && monthKey(row.asOf, timeZone) === previousMonth(currentMonth),
  );
  const baseline = nestedValue(baselineRow, 'total');
  if (baseline.state !== 'available' || baseline.value === null)
    return unavailable('monthly_baseline_unavailable');
  return Object.freeze({
    state: 'available',
    value: Object.freeze({
      amountMinor: current.value.amountMinor - baseline.value.amountMinor,
      currency: 'EUR' as const,
    }),
    asOf: current.asOf,
    reason: null,
  });
}

function latestInstant(values: readonly (string | null | undefined)[]): string | null {
  return (
    values
      .filter((value): value is string => value !== null && value !== undefined)
      .sort()
      .at(-1) ?? null
  );
}

async function bankSource(db: Database, ownerId: string): Promise<DashboardSource> {
  const connection = await db.query.enableBankingConnections.findFirst({
    where: eq(enableBankingConnections.ownerId, ownerId),
  });
  if (connection === undefined)
    return Object.freeze({
      state: 'unavailable',
      label: 'Not connected',
      lastSuccessfulAt: null,
      detail: 'No bank connection is configured.',
    });
  const [run, account, reconciliation] = await Promise.all([
    db.query.enableBankingRuns.findFirst({
      where: and(
        eq(enableBankingRuns.ownerId, ownerId),
        eq(enableBankingRuns.status, 'completed'),
        inArray(enableBankingRuns.kind, ['diagnostic_fetch', 'sync']),
      ),
      orderBy: [desc(enableBankingRuns.completedAt)],
    }),
    db.query.enableBankingProviderAccounts.findFirst({
      where: and(
        eq(enableBankingProviderAccounts.ownerId, ownerId),
        isNotNull(enableBankingProviderAccounts.canonicalAccountId),
      ),
    }),
    db.query.enableBankingBalanceReconciliations.findFirst({
      where: eq(enableBankingBalanceReconciliations.ownerId, ownerId),
      orderBy: [desc(enableBankingBalanceReconciliations.createdAt)],
    }),
  ]);
  if (connection.status !== 'active')
    return Object.freeze({
      state: connection.status === 'reauth_required' ? 'stale' : 'unavailable',
      label: connection.status === 'reauth_required' ? 'Reconnect required' : 'Unavailable',
      lastSuccessfulAt: run?.completedAt ?? null,
      detail: 'The bank connection needs attention.',
    });
  const activated =
    account?.ownerActivatedAt !== null &&
    account?.ownerActivatedAt !== undefined &&
    account.identityVerifiedAt !== null &&
    account.transactionIdentityVerifiedAt !== null;
  if (reconciliation?.status === 'provider_stale')
    return Object.freeze({
      state: 'stale',
      label: 'Connected',
      lastSuccessfulAt: run?.completedAt ?? null,
      detail: 'The latest bank balance is stale.',
    });
  if (run === undefined || !activated || reconciliation?.status !== 'reconciled')
    return Object.freeze({
      state: 'incomplete',
      label: 'Connected',
      lastSuccessfulAt: run?.completedAt ?? null,
      detail: 'Connection evidence is available, but canonical bank data is not fully reconciled.',
    });
  return Object.freeze({
    state: 'available',
    label: 'Connected',
    lastSuccessfulAt: run.completedAt,
    detail: 'Canonical bank data is reconciled.',
  });
}

async function portfolioSource(
  db: Database,
  ownerId: string,
  now: string,
): Promise<DashboardSource> {
  const binding = await db.query.portfolioProviderBindings.findFirst({
    where: eq(portfolioProviderBindings.ownerId, ownerId),
  });
  if (binding === undefined)
    return Object.freeze({
      state: 'unavailable',
      label: 'Not connected',
      lastSuccessfulAt: null,
      detail: 'No portfolio provider is configured.',
    });
  const valuation = await db.query.portfolioValuations.findFirst({
    where: and(
      eq(portfolioValuations.ownerId, ownerId),
      eq(portfolioValuations.accountId, binding.investmentAccountId),
    ),
    orderBy: [desc(portfolioValuations.sourceAsOf)],
  });
  if (binding.provider === 'portfolio-manager') {
    const [state, run] = await Promise.all([
      db.query.portfolioManagerSyncStates.findFirst({
        where: and(
          eq(portfolioManagerSyncStates.ownerId, ownerId),
          eq(portfolioManagerSyncStates.connectionId, binding.connectionId),
        ),
      }),
      db.query.portfolioManagerSyncRuns.findFirst({
        where: and(
          eq(portfolioManagerSyncRuns.ownerId, ownerId),
          eq(portfolioManagerSyncRuns.connectionId, binding.connectionId),
          eq(portfolioManagerSyncRuns.status, 'completed'),
        ),
        orderBy: [desc(portfolioManagerSyncRuns.completedAt)],
      }),
    ]);
    if (valuation !== undefined && Date.parse(valuation.staleAt) < Date.parse(now))
      return Object.freeze({
        state: 'stale',
        label: 'Portfolio Manager',
        lastSuccessfulAt: state?.lastSuccessfulSyncAt ?? run?.completedAt ?? null,
        detail: 'The latest canonical portfolio valuation is stale.',
      });
    const complete =
      run?.sourceCompleteness === 'complete' &&
      valuation?.reportabilityStatus === 'available' &&
      valuation.reportingAmountMinor !== null;
    return Object.freeze({
      state: complete ? 'available' : 'incomplete',
      label: 'Portfolio Manager',
      lastSuccessfulAt: state?.lastSuccessfulSyncAt ?? run?.completedAt ?? null,
      detail: complete
        ? 'A current canonical portfolio valuation is available.'
        : 'Provider evidence is available, but valuation authority is incomplete.',
    });
  }
  const [state, run] = await Promise.all([
    db.query.sharesightSyncStates.findFirst({
      where: and(
        eq(sharesightSyncStates.ownerId, ownerId),
        eq(sharesightSyncStates.connectionId, binding.connectionId),
      ),
    }),
    db.query.sharesightSyncRuns.findFirst({
      where: and(
        eq(sharesightSyncRuns.ownerId, ownerId),
        eq(sharesightSyncRuns.status, 'completed'),
      ),
      orderBy: [desc(sharesightSyncRuns.completedAt)],
    }),
  ]);
  if (valuation !== undefined && Date.parse(valuation.staleAt) < Date.parse(now))
    return Object.freeze({
      state: 'stale',
      label: 'Sharesight',
      lastSuccessfulAt: state?.lastSuccessfulSyncAt ?? run?.completedAt ?? null,
      detail: 'The latest canonical portfolio valuation is stale.',
    });
  return Object.freeze({
    state: 'incomplete',
    label: 'Sharesight',
    lastSuccessfulAt: state?.lastSuccessfulSyncAt ?? run?.completedAt ?? null,
    detail: 'Import freshness remains unconfirmed, so portfolio evidence is provisional.',
  });
}

export async function loadDashboardOverview(
  db: Database,
  ownerId: string,
  now: string,
): Promise<DashboardOverview> {
  const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
  if (owner === undefined) throw new Error('Dashboard owner does not exist.');
  const [rows, netWorthHistory, bank, portfolio] = await Promise.all([
    db
      .select()
      .from(metricSnapshots)
      .where(
        and(
          eq(metricSnapshots.ownerId, ownerId),
          eq(metricSnapshots.isAuthoritative, true),
          inArray(metricSnapshots.metricKind, [
            'netWorth',
            'ccr',
            'safeToInvest',
            'liquidityReserve',
            'currentCycleSinkingDue',
          ]),
        ),
      ),
    db
      .select()
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.ownerId, ownerId), eq(metricSnapshots.metricKind, 'netWorth')))
      .orderBy(desc(metricSnapshots.asOf))
      .limit(24),
    bankSource(db, ownerId),
    portfolioSource(db, ownerId, now),
  ]);
  const byKind = new Map(rows.map((row) => [row.metricKind, row]));
  const netWorthRow = byKind.get('netWorth');
  const liquidityRow = byKind.get('liquidityReserve');
  const sinkingRow = byKind.get('currentCycleSinkingDue');
  return Object.freeze({
    locale: owner.locale,
    timeZone: owner.timeZone,
    synthetic: ownerId === SYNTHETIC_OWNER_ID,
    metrics: Object.freeze({
      netWorth: nestedValue(netWorthRow, 'total'),
      monthlyNetWorthChange: monthlyChange(netWorthRow, netWorthHistory, owner.timeZone),
      capitalConversionRate: ratioValue(byKind.get('ccr')),
      safeToInvest: safeToInvestValue(byKind.get('safeToInvest')),
      availableCash: nestedValue(liquidityRow, 'currentLiquidCash'),
      comfortReserve: nestedValue(liquidityRow, 'comfortCash'),
      investmentPortfolio: nestedValue(netWorthRow, 'investmentMarketValue'),
      reservedSinkingFunds: nestedValue(sinkingRow, 'totalReserved'),
    }),
    sources: Object.freeze({
      bank,
      portfolio,
      lastSuccessfulUpdate: latestInstant([bank.lastSuccessfulAt, portfolio.lastSuccessfulAt]),
    }),
  });
}
