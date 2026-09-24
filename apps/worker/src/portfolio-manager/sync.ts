import {
  beginPortfolioManagerSync,
  bindPortfolioManagerSyncIdentity,
  completePortfolioManagerSync,
  expirePortfolioManagerRawPayloads,
  failPortfolioManagerReceipt,
  failPortfolioManagerSync,
  finalizePortfolioManagerReceipt,
  loadPendingPortfolioManagerReceipts,
  persistPortfolioManagerRawReceipt,
  renewPortfolioManagerSyncLease,
} from '@personal-cfo/data';
import type {
  Database,
  PersistedPortfolioManagerReceipt,
  PortfolioManagerRevisionInput,
} from '@personal-cfo/data';
import { DataConflictError, DataInvariantError } from '@personal-cfo/data';
import { DomainValidationError, EUR, createMoney, parseInstant } from '@personal-cfo/domain';
import { assessPortfolioReadiness, reconcileHoldings } from '@personal-cfo/integrations';
import type { PortfolioWarningCode } from '@personal-cfo/integrations';
import {
  PortfolioManagerApiClient,
  PortfolioManagerApiError,
  assertPortfolioManagerIdentity,
  decodePortfolioManagerCapabilities,
  decodePortfolioManagerCapitalFlows,
  decodePortfolioManagerSnapshot,
  normalizePortfolioManagerCapitalFlow,
  normalizePortfolioManagerSnapshot,
  validatePortfolioManagerCapabilities,
} from '@personal-cfo/integrations/portfolio/portfolio-manager';
import type {
  PortfolioManagerClock,
  PortfolioManagerFetch,
  PortfolioManagerIdentity,
  PortfolioManagerSleeper,
  PortfolioManagerSyncResult,
} from '@personal-cfo/integrations/portfolio/portfolio-manager';

import type { PortfolioManagerConfiguration } from './config.js';

type MutableCounts = {
  new: number;
  replay: number;
  revision: number;
  quarantined: number;
  ignored: number;
};

export type PortfolioManagerSyncOptions = Readonly<{
  clock?: PortfolioManagerClock;
  sleeper?: PortfolioManagerSleeper;
  fetchImplementation?: PortfolioManagerFetch;
  signal?: AbortSignal;
}>;

function safeFailureCategory(error: unknown): string {
  if (error instanceof PortfolioManagerApiError) return `portfolio_manager_${error.category}`;
  if (error instanceof DataConflictError) return 'portfolio_manager_data_conflict';
  if (error instanceof DataInvariantError) return 'portfolio_manager_data_invariant';
  if (error instanceof DomainValidationError) return 'portfolio_manager_contract_invalid';
  return 'portfolio_manager_sync_failed';
}

function revisionHash(revision: Readonly<{ version: Readonly<{ kind: string; value: string }> }>) {
  if (revision.version.kind !== 'sha256_fingerprint') {
    throw new DataInvariantError(
      'portfolio_manager.invalid_revision_kind',
      'Portfolio Manager revision must use a SHA-256 fingerprint.',
    );
  }
  return revision.version.value;
}

function addDispositions(
  counts: MutableCounts,
  dispositions: readonly Readonly<{ disposition: 'new' | 'replay' | 'revision' }>[],
): void {
  for (const disposition of dispositions) counts[disposition.disposition] += 1;
}

export async function executePortfolioManagerSync(
  db: Database,
  configuration: PortfolioManagerConfiguration,
  options: PortfolioManagerSyncOptions = {},
): Promise<PortfolioManagerSyncResult> {
  const clock = options.clock ?? { now: () => new Date() };
  const startedAt = parseInstant(clock.now().toISOString());
  const lease = await beginPortfolioManagerSync(db, {
    ownerId: configuration.ownerId,
    investmentAccountId: configuration.investmentAccountId,
    connectionId: configuration.connectionId,
    now: startedAt,
  });
  const counts: MutableCounts = { new: 0, replay: 0, revision: 0, quarantined: 0, ignored: 0 };
  const contributionsByEvent = new Map<
    string,
    PortfolioManagerSyncResult['contributions'][number]
  >();
  const capitalFlows: PortfolioManagerSyncResult['capitalFlows'][number][] = [];
  let providerSnapshot: PortfolioManagerSyncResult['providerSnapshot'] = null;
  let snapshot: PortfolioManagerSyncResult['snapshot'] = null;
  let holdings: PortfolioManagerSyncResult['holdings'] = Object.freeze([]);
  let normalizationWarnings: readonly PortfolioWarningCode[] = Object.freeze([]);
  let expectedIdentity: PortfolioManagerIdentity | null = null;
  let checkpoint = lease.checkpoint;
  let lastReceiptId: string | null = null;

  const acceptIdentity = async (identity: PortfolioManagerIdentity, now: string): Promise<void> => {
    if (expectedIdentity !== null) assertPortfolioManagerIdentity(expectedIdentity, identity);
    await bindPortfolioManagerSyncIdentity(db, lease, {
      providerInstanceId: identity.providerInstanceId,
      providerPortfolioId: identity.portfolioId,
      now,
    });
    expectedIdentity ??= identity;
  };

  const finalize = async (
    receiptId: string,
    input: Readonly<{
      status: 'normalized' | 'quarantined';
      revisions: readonly PortfolioManagerRevisionInput[];
      responseCursor: string | null;
      advanceCheckpoint: boolean;
      failureCategory?: string | null;
      now: string;
    }>,
  ): Promise<void> => {
    const dispositions = await finalizePortfolioManagerReceipt(db, lease, {
      receiptId,
      ...input,
    });
    addDispositions(counts, dispositions);
    if (input.advanceCheckpoint) checkpoint = input.responseCursor;
  };

  const processReceipt = async (receipt: PersistedPortfolioManagerReceipt): Promise<boolean> => {
    lastReceiptId = receipt.id;
    if (receipt.endpoint === 'capabilities') {
      const capabilities = decodePortfolioManagerCapabilities(receipt.payload);
      validatePortfolioManagerCapabilities(capabilities);
      await acceptIdentity(capabilities, receipt.receivedAt);
      await finalize(receipt.id, {
        status: 'normalized',
        revisions: [],
        responseCursor: null,
        advanceCheckpoint: false,
        now: receipt.receivedAt,
      });
      return false;
    }
    if (receipt.endpoint === 'snapshot') {
      const decoded = decodePortfolioManagerSnapshot(receipt.payload);
      await acceptIdentity(decoded, receipt.receivedAt);
      providerSnapshot = decoded;
      const normalized = normalizePortfolioManagerSnapshot(decoded, {
        ownerId: configuration.ownerId as never,
        accountId: configuration.investmentAccountId as never,
        connectionId: configuration.connectionId,
        receivedAt: parseInstant(receipt.receivedAt),
        freshStaleAt: parseInstant(receipt.receivedAt),
      });
      if (normalized.status === 'quarantined') {
        counts.quarantined += 1;
        await finalize(receipt.id, {
          status: 'quarantined',
          revisions: [],
          responseCursor: null,
          advanceCheckpoint: false,
          failureCategory: normalized.category,
          now: receipt.receivedAt,
        });
      } else {
        snapshot = normalized.snapshot;
        holdings = normalized.holdings;
        normalizationWarnings = normalized.warnings;
        await finalize(receipt.id, {
          status: 'normalized',
          revisions: [
            {
              sourceId: normalized.snapshot.revision.sourceId,
              revisionSha256: revisionHash(normalized.snapshot.revision),
              recordKind: 'snapshot',
              providerRevisionId: null,
              providerStatus: null,
              changedAt: decoded.generatedAt,
              replacesRevisionId: null,
              replacementRevisionIds: [],
            },
          ],
          responseCursor: null,
          advanceCheckpoint: false,
          now: receipt.receivedAt,
        });
      }
      return false;
    }

    const page = decodePortfolioManagerCapitalFlows(receipt.payload);
    await acceptIdentity(page, receipt.receivedAt);
    if (page.hasMore && page.nextCursor === receipt.requestCursor) {
      throw new PortfolioManagerApiError(
        'invalid_response',
        'Portfolio Manager continuation cursor did not advance.',
      );
    }
    const revisions: PortfolioManagerRevisionInput[] = [];
    let pageQuarantined = false;
    for (const item of page.items) {
      const normalized = normalizePortfolioManagerCapitalFlow(item, {
        connectionId: configuration.connectionId,
        providerInstanceId: page.providerInstanceId,
        providerPortfolioId: page.portfolioId,
      });
      capitalFlows.push(normalized.observation);
      contributionsByEvent.delete(normalized.observation.eventId);
      revisions.push({
        sourceId: normalized.observation.revision.sourceId,
        revisionSha256: revisionHash(normalized.observation.revision),
        recordKind: 'capital_flow',
        providerRevisionId: normalized.observation.revisionId,
        providerStatus: normalized.observation.status,
        changedAt: normalized.observation.changedAt,
        replacesRevisionId: normalized.observation.replacesRevisionId,
        replacementRevisionIds: normalized.observation.replacementRevisionIds,
      });
      if (normalized.status === 'quarantined') {
        counts.quarantined += 1;
        pageQuarantined = true;
      } else if (normalized.evidence === null) {
        counts.ignored += 1;
      } else {
        contributionsByEvent.set(normalized.observation.eventId, normalized.evidence);
      }
    }
    await finalize(receipt.id, {
      status: pageQuarantined ? 'quarantined' : 'normalized',
      revisions,
      responseCursor: page.nextCursor,
      advanceCheckpoint: true,
      failureCategory: pageQuarantined ? 'portfolio_manager_capital_flow_quarantined' : null,
      now: receipt.receivedAt,
    });
    return page.hasMore;
  };

  try {
    await expirePortfolioManagerRawPayloads(db, startedAt);
    const pending = await loadPendingPortfolioManagerReceipts(db, lease, configuration.receiptKey);
    for (const receipt of pending) await processReceipt(receipt);

    const client = new PortfolioManagerApiClient({
      baseUrl: configuration.baseUrl,
      apiToken: configuration.apiToken,
      clock,
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
      responseSink: async (response) => {
        const persisted = await persistPortfolioManagerRawReceipt(
          db,
          lease,
          configuration.receiptKey,
          {
            endpoint: response.endpoint,
            requestKey: response.path,
            requestCursor: response.requestCursor,
            receivedAt: response.receivedAt,
            payload: response.body,
            normalizationVersion: 'portfolio-manager-normalization-v1',
          },
        );
        lastReceiptId = persisted.id;
        return persisted.id;
      },
    });

    const capabilitiesResponse = await client.getCapabilities(options.signal);
    if (capabilitiesResponse.receiptId === null) {
      throw new Error('Portfolio Manager receipt sink was not used.');
    }
    await processReceipt({
      id: capabilitiesResponse.receiptId,
      runId: lease.runId,
      endpoint: 'capabilities',
      requestKey: '/api/integrations/personal-cfo/v1/capabilities',
      requestCursor: null,
      receivedAt: capabilitiesResponse.receivedAt,
      payloadSha256: '',
      payload: capabilitiesResponse.body,
    });

    const snapshotResponse = await client.getSnapshot(options.signal);
    if (snapshotResponse.receiptId === null) {
      throw new Error('Portfolio Manager receipt sink was not used.');
    }
    await processReceipt({
      id: snapshotResponse.receiptId,
      runId: lease.runId,
      endpoint: 'snapshot',
      requestKey: '/api/integrations/personal-cfo/v1/snapshot',
      requestCursor: null,
      receivedAt: snapshotResponse.receivedAt,
      payloadSha256: '',
      payload: snapshotResponse.body,
    });

    let hasMore = true;
    while (hasMore) {
      await renewPortfolioManagerSyncLease(db, lease, parseInstant(clock.now().toISOString()));
      const requestCursor = checkpoint;
      const response = await client.getCapitalFlows({
        cursor: requestCursor,
        limit: 500,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (response.receiptId === null) {
        throw new Error('Portfolio Manager receipt sink was not used.');
      }
      hasMore = await processReceipt({
        id: response.receiptId,
        runId: lease.runId,
        endpoint: 'capital_flows',
        requestKey: 'capital_flows',
        requestCursor,
        receivedAt: response.receivedAt,
        payloadSha256: '',
        payload: response.body,
      });
    }

    const completedSnapshot = snapshot as PortfolioManagerSyncResult['snapshot'];
    const holdingsReconciliation =
      completedSnapshot === null
        ? Object.freeze({ status: 'unavailable' as const, difference: null })
        : reconcileHoldings(completedSnapshot, createMoney(0n, EUR));
    const completedAt = parseInstant(clock.now().toISOString());
    const readiness = assessPortfolioReadiness(completedSnapshot, completedAt, {
      holdingsReconciliation,
    });
    const warnings = Object.freeze(
      [...new Set([...normalizationWarnings, ...readiness.warnings])].sort(),
    );
    const sourceCompleteness = completedSnapshot?.sourceCompleteness ?? 'unavailable';
    await completePortfolioManagerSync(db, lease, {
      counts,
      sourceCompleteness,
      now: completedAt,
    });
    return Object.freeze({
      snapshot: completedSnapshot,
      providerSnapshot,
      holdings,
      capitalFlows: Object.freeze(capitalFlows),
      contributions: Object.freeze([...contributionsByEvent.values()]),
      counts: Object.freeze({ ...counts }),
      checkpoint,
      sourceCompleteness,
      holdingsReconciliation,
      readiness,
      warnings,
      confirmedPrincipalsCreated: 0,
    });
  } catch (error) {
    const category = safeFailureCategory(error);
    const failedAt = parseInstant(clock.now().toISOString());
    if (lastReceiptId !== null) {
      await failPortfolioManagerReceipt(db, lastReceiptId, category, failedAt).catch(
        () => undefined,
      );
    }
    await failPortfolioManagerSync(db, lease, category, failedAt).catch(() => undefined);
    throw error;
  }
}
