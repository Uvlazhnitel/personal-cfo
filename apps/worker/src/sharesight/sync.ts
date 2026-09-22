import { createHash } from 'node:crypto';

import { EUR, createMoney } from '@personal-cfo/domain';
import {
  beginSharesightSync,
  completeSharesightSync,
  expireSharesightRawPayloads,
  failSharesightReceipt,
  failSharesightSync,
  finalizeSharesightReceipt,
  loadPendingSharesightReceipts,
  persistSharesightRawReceipt,
  renewSharesightSyncLease,
  setSharesightSyncBounds,
} from '@personal-cfo/data';
import type {
  Database,
  SharesightRevisionDisposition as PersistedRevisionDisposition,
} from '@personal-cfo/data';
import {
  SHARESIGHT_BINDING_VERSION,
  SharesightApiClient,
  SharesightApiError,
  assessPortfolioReadiness,
  createSharesightScanWindows,
  decodeSharesightPortfolios,
  normalizeSharesightCashTransaction,
  normalizeSharesightPayout,
  normalizeSharesightPerformance,
  normalizeSharesightTrade,
  normalizeSharesightValuation,
  reconcileHoldings,
} from '@personal-cfo/integrations';
import type {
  SharesightClock,
  SharesightFetch,
  SharesightScanWindow,
  SharesightSleeper,
  SharesightSyncResult,
} from '@personal-cfo/integrations';

import type { SharesightConfiguration } from './config.js';

const MONTHS = Object.freeze({
  Jan: '01',
  Feb: '02',
  Mar: '03',
  Apr: '04',
  May: '05',
  Jun: '06',
  Jul: '07',
  Aug: '08',
  Sep: '09',
  Oct: '10',
  Nov: '11',
  Dec: '12',
} as const);

export type SharesightSyncOptions = Readonly<{
  signal?: AbortSignal;
  clock?: SharesightClock;
  sleeper?: SharesightSleeper;
  fetchImplementation?: SharesightFetch;
}>;

function inceptionDate(value: string): string {
  const match = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4})$/u.exec(value);
  const month = match?.[2] === undefined ? undefined : MONTHS[match[2] as keyof typeof MONTHS];
  if (match === null || month === undefined) {
    throw new SharesightApiError(
      'invalid_response',
      'Sharesight portfolio inception date is invalid.',
    );
  }
  const result = `${match[3]}-${month}-${match[1]}`;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== result) {
    throw new SharesightApiError(
      'invalid_response',
      'Sharesight portfolio inception date is invalid.',
    );
  }
  return result;
}

function portfolioDate(now: Date, timeZoneName: string): string {
  const timeZone =
    timeZoneName === 'Riga'
      ? 'Europe/Riga'
      : timeZoneName === 'Tallinn'
        ? 'Europe/Tallinn'
        : timeZoneName === 'Wellington'
          ? 'Pacific/Auckland'
          : timeZoneName;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((item) => item.type === type)?.value;
    const year = part('year');
    const month = part('month');
    const day = part('day');
    if (year === undefined || month === undefined || day === undefined) throw new Error();
    return `${year}-${month}-${day}`;
  } catch {
    throw new SharesightApiError(
      'invalid_response',
      'Sharesight portfolio timezone is unsupported.',
    );
  }
}

function fingerprint(parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(':');
    hash.update(part);
    hash.update('|');
  }
  return hash.digest('hex');
}

function revision(
  identity: Readonly<{ sourceId: string; version: Readonly<{ value: string }> }>,
  kind: string,
) {
  return Object.freeze({
    sourceId: identity.sourceId,
    revisionSha256: identity.version.value,
    recordKind: kind,
  });
}

function failureCategory(error: unknown): string {
  if (error instanceof SharesightApiError) return `sharesight_${error.category}`;
  if (error instanceof Error && error.name === 'DataConflictError')
    return 'sharesight_data_conflict';
  if (error instanceof Error && error.name === 'DataInvariantError')
    return 'sharesight_data_invariant';
  return 'sharesight_sync_failed';
}

function requestMetadata(path: string) {
  const url = new URL(path, 'https://sharesight.invalid');
  const capability = url.pathname.includes('cash_account_transactions')
    ? 'contribution_history'
    : url.pathname.endsWith('/cash_accounts.json')
      ? 'brokerage_cash'
      : url.pathname.endsWith('/valuation.json')
        ? 'total_market_value'
        : url.pathname.endsWith('/trades.json')
          ? 'fees'
          : url.pathname.endsWith('/payouts.json')
            ? 'distributions'
            : url.pathname.endsWith('/performance.json')
              ? 'provider_profit_loss'
              : 'currency';
  return Object.freeze({
    capability,
    requestKey: `${url.pathname}?${[...url.searchParams.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&')}`,
    requestFrom: url.searchParams.get('from') ?? url.searchParams.get('start_date'),
    requestTo:
      url.searchParams.get('to') ??
      url.searchParams.get('end_date') ??
      url.searchParams.get('balance_date'),
  });
}

function remainingWindows<T extends SharesightScanWindow>(
  windows: readonly T[],
  continuation: Readonly<Record<string, string>> | null,
): readonly T[] {
  if (continuation === null) return windows;
  const position = windows.findIndex(
    (window) =>
      window.cursor.kind === 'composite' &&
      JSON.stringify(window.cursor.value) === JSON.stringify(continuation),
  );
  return position < 0 ? windows : windows.slice(position + 1);
}

export async function executeSharesightSync(
  db: Database,
  configuration: SharesightConfiguration,
  options: SharesightSyncOptions = {},
): Promise<SharesightSyncResult> {
  const clock = options.clock ?? { now: () => new Date() };
  const startedAt = clock.now().toISOString();
  const lease = await beginSharesightSync(db, {
    ownerId: configuration.ownerId,
    portfolioId: configuration.portfolioId,
    investmentAccountId: configuration.investmentAccountId,
    connectionId: configuration.connectionId,
    now: startedAt,
  });
  const counts = { new: 0, replay: 0, revision: 0, quarantined: 0, ignored: 0 };
  const contributions = [] as SharesightSyncResult['contributions'][number][];
  const trades = [] as SharesightSyncResult['trades'][number][];
  const payouts = [] as SharesightSyncResult['payouts'][number][];
  const providerProfitLoss = [] as SharesightSyncResult['providerProfitLoss'][number][];
  let snapshot: SharesightSyncResult['snapshot'] = null;
  let warnings: SharesightSyncResult['warnings'] = Object.freeze(['source_incomplete']);
  let lastReceiptId: string | null = null;

  const addDispositions = (items: readonly PersistedRevisionDisposition[]) => {
    for (const item of items) counts[item.disposition] += 1;
  };
  const finalize = async (
    receiptId: string,
    revisions: readonly Readonly<{
      sourceId: string;
      revisionSha256: string;
      recordKind: string;
    }>[],
    status: 'normalized' | 'quarantined' = 'normalized',
    continuation: Readonly<Record<string, string>> | null = null,
    category: string | null = null,
  ) => {
    const dispositions = await finalizeSharesightReceipt(db, lease, {
      receiptId,
      status,
      revisions,
      continuation,
      now: clock.now().toISOString(),
      failureCategory: category,
    });
    addDispositions(dispositions);
    if (status === 'quarantined') counts.quarantined += 1;
    lastReceiptId = null;
  };

  try {
    await expireSharesightRawPayloads(db, startedAt);
    const pending = await loadPendingSharesightReceipts(db, lease, configuration.receiptKey);
    for (const receipt of pending) {
      if (receipt.capability === 'currency') {
        const portfolios = decodeSharesightPortfolios(receipt.payload);
        const matching = portfolios.filter((item) => item.id === configuration.portfolioId);
        if (matching.length !== 1) {
          await finalize(receipt.id, [], 'quarantined', null, 'sharesight_portfolio_mismatch');
        } else {
          const item = matching[0]!;
          await finalize(receipt.id, [
            {
              sourceId: `portfolio:${item.id}`,
              revisionSha256: fingerprint([
                item.id,
                item.name,
                item.currencyCode,
                item.inceptionDate,
                item.timeZoneName,
              ]),
              recordKind: 'portfolio',
            },
          ]);
        }
      } else {
        await finalize(
          receipt.id,
          [],
          'quarantined',
          null,
          'sharesight_interrupted_receipt_requires_rescan',
        );
      }
    }

    const client = new SharesightApiClient({
      clientId: configuration.clientId,
      clientSecret: configuration.clientSecret,
      baseUrl: configuration.apiBaseUrl,
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      clock,
      ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
      rawResponseSink: async ({ path, body, receivedAt }) => {
        const metadata = requestMetadata(path);
        const receipt = await persistSharesightRawReceipt(db, lease, configuration.receiptKey, {
          ...metadata,
          receivedAt,
          payload: body,
          normalizationVersion: SHARESIGHT_BINDING_VERSION,
        });
        lastReceiptId = receipt.id;
        return receipt.id;
      },
    });

    const portfoliosResponse = await client.listPortfolios(options.signal);
    const matching = portfoliosResponse.value.filter(
      (item) => item.id === configuration.portfolioId,
    );
    if (matching.length !== 1 || portfoliosResponse.receiptId === null) {
      throw new SharesightApiError(
        'invalid_response',
        'Configured Sharesight portfolio was not found.',
      );
    }
    const portfolio = matching[0]!;
    await finalize(portfoliosResponse.receiptId, [
      {
        sourceId: `portfolio:${portfolio.id}`,
        revisionSha256: fingerprint([
          portfolio.id,
          portfolio.name,
          portfolio.currencyCode,
          portfolio.inceptionDate,
          portfolio.timeZoneName,
        ]),
        recordKind: 'portfolio',
      },
    ]);
    const from = inceptionDate(portfolio.inceptionDate);
    const to = portfolioDate(clock.now(), portfolio.timeZoneName);
    await setSharesightSyncBounds(db, lease, from, to);

    const valuationResponse = await client.getValuation(portfolio.id, to, options.signal);
    if (valuationResponse.receiptId === null)
      throw new Error('Sharesight receipt sink was not used.');
    const normalizedValuation = normalizeSharesightValuation(portfolio, valuationResponse.value, {
      ownerId: configuration.ownerId as never,
      accountId: configuration.investmentAccountId as never,
      connectionId: configuration.connectionId,
      receivedAt: valuationResponse.receivedAt,
      staleAt: valuationResponse.receivedAt,
      sourceFreshnessConfirmed: false,
    });
    if (normalizedValuation.status === 'quarantined') {
      await finalize(
        valuationResponse.receiptId,
        [],
        'quarantined',
        null,
        normalizedValuation.category,
      );
    } else {
      snapshot = normalizedValuation.snapshot;
      const reconciliation = reconcileHoldings(snapshot, createMoney(1n, EUR));
      const readiness = assessPortfolioReadiness(snapshot, valuationResponse.receivedAt, {
        holdingsReconciliation: reconciliation,
      });
      warnings = readiness.warnings;
      await finalize(valuationResponse.receiptId, [
        revision(snapshot.revision, 'valuation'),
        ...snapshot.holdings.items.map((item) => revision(item.revision, 'holding')),
      ]);
    }

    const cashResponse = await client.listCashAccounts(portfolio.id, options.signal);
    if (cashResponse.receiptId === null) throw new Error('Sharesight receipt sink was not used.');
    const cashAccounts = [...cashResponse.value].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (cashAccounts.some((item) => item.portfolioId !== portfolio.id)) {
      await finalize(
        cashResponse.receiptId,
        [],
        'quarantined',
        null,
        'sharesight_portfolio_mismatch',
      );
      throw new SharesightApiError(
        'invalid_response',
        'Sharesight cash account crossed portfolios.',
      );
    }
    await finalize(
      cashResponse.receiptId,
      cashAccounts.map((item) => ({
        sourceId: `portfolio:${portfolio.id}:cash-account:${item.id}`,
        revisionSha256: fingerprint([
          item.id,
          item.currencyCode,
          item.portfolioCurrencyCode,
          item.date,
          item.balance,
          item.balanceInPortfolioCurrency,
        ]),
        recordKind: 'cash_account',
      })),
    );

    const cashById = new Map(cashAccounts.map((account) => [account.id, account]));
    const scanWindows = remainingWindows(
      [
        ...cashAccounts.flatMap((account) =>
          createSharesightScanWindows({
            phase: 'cash_transactions',
            portfolioId: portfolio.id,
            resourceId: account.id,
            from,
            to,
          }),
        ),
        ...createSharesightScanWindows({
          phase: 'trades',
          portfolioId: portfolio.id,
          resourceId: portfolio.id,
          from,
          to,
        }),
        ...createSharesightScanWindows({
          phase: 'payouts',
          portfolioId: portfolio.id,
          resourceId: portfolio.id,
          from,
          to,
        }),
      ],
      lease.continuation,
    );

    for (const window of scanWindows) {
      await renewSharesightSyncLease(db, lease, clock.now().toISOString());
      if (window.phase === 'cash_transactions') {
        const account = cashById.get(window.resourceId);
        if (account === undefined) {
          throw new SharesightApiError(
            'invalid_response',
            'Sharesight cash scan account is missing.',
          );
        }
        const response = await client.listCashTransactions(
          account.id,
          window.from,
          window.to,
          options.signal,
        );
        if (response.receiptId === null) throw new Error('Sharesight receipt sink was not used.');
        const revisions = [] as Array<ReturnType<typeof revision>>;
        let quarantined = false;
        for (const item of response.value) {
          const normalized = normalizeSharesightCashTransaction(item, {
            connection: { provider: 'sharesight', connectionId: configuration.connectionId },
            providerPortfolioId: portfolio.id,
            cashAccountId: account.id,
            currencyCode: account.currencyCode,
          });
          if (normalized.status === 'normalized') {
            contributions.push(normalized.evidence);
            revisions.push(revision(normalized.evidence.revision, 'contribution_evidence'));
          } else if (normalized.status === 'ignored') {
            counts.ignored += 1;
          } else {
            quarantined = true;
            counts.quarantined += 1;
          }
        }
        await finalize(
          response.receiptId,
          revisions,
          quarantined ? 'quarantined' : 'normalized',
          window.cursor.kind === 'composite' ? window.cursor.value : null,
          quarantined ? 'sharesight_cash_record_quarantined' : null,
        );
      } else if (window.phase === 'trades') {
        const response = await client.listTrades(
          portfolio.id,
          window.from,
          window.to,
          options.signal,
        );
        if (response.receiptId === null) throw new Error('Sharesight receipt sink was not used.');
        const evidence = response.value.map((item) => normalizeSharesightTrade(item, portfolio.id));
        trades.push(...evidence);
        await finalize(
          response.receiptId,
          evidence.map((item) => revision(item.revision, 'trade')),
          'normalized',
          window.cursor.kind === 'composite' ? window.cursor.value : null,
        );
      } else {
        const response = await client.listPayouts(
          portfolio.id,
          window.from,
          window.to,
          options.signal,
        );
        if (response.receiptId === null) throw new Error('Sharesight receipt sink was not used.');
        const evidence = response.value.map((item) =>
          normalizeSharesightPayout(item, portfolio.id),
        );
        payouts.push(...evidence);
        await finalize(
          response.receiptId,
          evidence.map((item) => revision(item.revision, 'payout')),
          'normalized',
          window.cursor.kind === 'composite' ? window.cursor.value : null,
        );
      }
    }

    const performanceResponse = await client.getPerformance(portfolio.id, from, to, options.signal);
    if (performanceResponse.receiptId === null)
      throw new Error('Sharesight receipt sink was not used.');
    const performance = normalizeSharesightPerformance(
      performanceResponse.value,
      portfolio.id,
      portfolio.currencyCode,
      `${from}T00:00:00.000Z`,
      `${to}T23:59:59.999Z`,
    );
    if (performance !== null) providerProfitLoss.push(performance);
    await finalize(performanceResponse.receiptId, [
      {
        sourceId: `portfolio:${portfolio.id}:performance:${from}:${to}`,
        revisionSha256: fingerprint([
          performanceResponse.value.reportId,
          performanceResponse.value.value,
          performanceResponse.value.capitalGain,
          performanceResponse.value.payoutGain,
          performanceResponse.value.currencyGain,
          performanceResponse.value.totalGain,
        ]),
        recordKind: 'provider_profit_loss',
      },
    ]);

    await completeSharesightSync(db, lease, counts, clock.now().toISOString());
    return Object.freeze({
      status: 'completed',
      snapshot,
      contributions: Object.freeze(contributions),
      trades: Object.freeze(trades),
      payouts: Object.freeze(payouts),
      providerProfitLoss: Object.freeze(providerProfitLoss),
      warnings,
      counts: Object.freeze({ ...counts }),
      sourceFreshness: 'unconfirmed',
      confirmedPrincipalsCreated: 0,
    });
  } catch (error) {
    const category = failureCategory(error);
    if (lastReceiptId !== null) {
      await failSharesightReceipt(db, lastReceiptId, category, clock.now().toISOString()).catch(
        () => undefined,
      );
    }
    await failSharesightSync(db, lease, category, clock.now().toISOString()).catch(() => undefined);
    throw error;
  }
}
