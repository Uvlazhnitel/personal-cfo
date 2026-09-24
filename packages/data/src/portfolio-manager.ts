import { createHash } from 'node:crypto';

import { and, eq, isNotNull, lte } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import {
  bindPortfolioProviderIdentity,
  claimPortfolioProviderBinding,
} from './portfolio-provider-bindings.js';
import {
  decryptPortfolioPayload,
  encryptPortfolioPayload,
  parsePortfolioReceiptKey,
} from './portfolio-receipts.js';
import type { PortfolioReceiptKey } from './portfolio-receipts.js';
import {
  portfolioManagerRawReceipts,
  portfolioManagerSourceRevisions,
  portfolioManagerSyncRuns,
  portfolioManagerSyncStates,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

const LEASE_MILLISECONDS = 15 * 60_000;
const RAW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;

export type PortfolioManagerReceiptKey = PortfolioReceiptKey;

export type PortfolioManagerSyncLease = Readonly<{
  leaseId: string;
  runId: string;
  ownerId: string;
  investmentAccountId: string;
  connectionId: string;
  checkpoint: string | null;
}>;

export type PersistedPortfolioManagerReceipt = Readonly<{
  id: string;
  runId: string;
  endpoint: 'capabilities' | 'snapshot' | 'capital_flows';
  requestKey: string;
  requestCursor: string | null;
  receivedAt: string;
  payloadSha256: string;
  payload: string;
}>;

export type PortfolioManagerRevisionInput = Readonly<{
  sourceId: string;
  revisionSha256: string;
  recordKind: 'snapshot' | 'capital_flow';
  providerRevisionId: string | null;
  providerStatus: 'ACTIVE' | 'REPLACED' | 'VOIDED' | null;
  changedAt: string | null;
  replacesRevisionId: string | null;
  replacementRevisionIds: readonly string[];
}>;

export type PortfolioManagerRevisionDisposition = Readonly<{
  sourceId: string;
  revisionSha256: string;
  disposition: 'new' | 'replay' | 'revision';
}>;

function date(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DataInvariantError(
      'portfolio_manager.invalid_instant',
      'Portfolio Manager instant is invalid.',
    );
  }
  return parsed;
}

export function parsePortfolioManagerReceiptKey(value: string): PortfolioManagerReceiptKey {
  return parsePortfolioReceiptKey(value, 'PORTFOLIO_MANAGER_RAW_RECEIPT_KEY');
}

export async function beginPortfolioManagerSync(
  db: Database,
  input: Readonly<{
    ownerId: string;
    investmentAccountId: string;
    connectionId: string;
    now: string;
  }>,
): Promise<PortfolioManagerSyncLease> {
  await claimPortfolioProviderBinding(db, {
    ownerId: input.ownerId,
    investmentAccountId: input.investmentAccountId,
    provider: 'portfolio-manager',
    connectionId: input.connectionId,
    providerInstanceId: null,
    providerPortfolioId: null,
    now: input.now,
  });
  return db.transaction(async (tx) => {
    const existing = await tx.query.portfolioManagerSyncStates.findFirst({
      where: and(
        eq(portfolioManagerSyncStates.ownerId, input.ownerId),
        eq(portfolioManagerSyncStates.connectionId, input.connectionId),
      ),
    });
    const nowDate = date(input.now);
    if (
      existing?.leaseId !== null &&
      existing?.leaseId !== undefined &&
      existing.leaseExpiresAt !== null &&
      date(existing.leaseExpiresAt).getTime() > nowDate.getTime()
    ) {
      throw new DataConflictError(
        'portfolio_manager.sync_in_progress',
        'A Portfolio Manager synchronization is already running.',
      );
    }
    const recoverableRun =
      existing?.activeRunId === null || existing?.activeRunId === undefined
        ? undefined
        : await tx.query.portfolioManagerSyncRuns.findFirst({
            where: and(
              eq(portfolioManagerSyncRuns.id, existing.activeRunId),
              eq(portfolioManagerSyncRuns.status, 'running'),
            ),
          });
    const runId = recoverableRun?.id ?? generateUuidV7('portfolio-manager-sync-run');
    const leaseId = generateUuidV7('portfolio-manager-lease');
    const checkpoint = recoverableRun?.continuationCursor ?? existing?.checkpoint ?? null;
    const leaseExpiresAt = new Date(nowDate.getTime() + LEASE_MILLISECONDS).toISOString();
    if (recoverableRun === undefined) {
      await tx.insert(portfolioManagerSyncRuns).values({
        id: runId,
        ownerId: input.ownerId,
        connectionId: input.connectionId,
        status: 'running',
        startingCursor: checkpoint,
        continuationCursor: checkpoint,
        counts: {},
        sourceCompleteness: 'unavailable',
        startedAt: input.now,
        completedAt: null,
        failureCategory: null,
      });
    }
    await tx
      .insert(portfolioManagerSyncStates)
      .values({
        ownerId: input.ownerId,
        connectionId: input.connectionId,
        investmentAccountId: input.investmentAccountId,
        checkpoint,
        leaseId,
        leaseExpiresAt,
        activeRunId: runId,
        lastSuccessfulSyncAt: null,
        lastFailureCategory: null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [portfolioManagerSyncStates.ownerId, portfolioManagerSyncStates.connectionId],
        set: { leaseId, leaseExpiresAt, activeRunId: runId, updatedAt: input.now },
      });
    return Object.freeze({
      leaseId,
      runId,
      ownerId: input.ownerId,
      investmentAccountId: input.investmentAccountId,
      connectionId: input.connectionId,
      checkpoint,
    });
  });
}

export async function bindPortfolioManagerSyncIdentity(
  db: Database,
  lease: PortfolioManagerSyncLease,
  input: Readonly<{ providerInstanceId: string; providerPortfolioId: string; now: string }>,
): Promise<void> {
  await bindPortfolioProviderIdentity(db, {
    ownerId: lease.ownerId,
    investmentAccountId: lease.investmentAccountId,
    provider: 'portfolio-manager',
    connectionId: lease.connectionId,
    providerInstanceId: input.providerInstanceId,
    providerPortfolioId: input.providerPortfolioId,
    now: input.now,
  });
}

export async function renewPortfolioManagerSyncLease(
  db: Database,
  lease: PortfolioManagerSyncLease,
  now: string,
): Promise<void> {
  const leaseExpiresAt = new Date(date(now).getTime() + LEASE_MILLISECONDS).toISOString();
  const updated = await db
    .update(portfolioManagerSyncStates)
    .set({ leaseExpiresAt, updatedAt: now })
    .where(
      and(
        eq(portfolioManagerSyncStates.ownerId, lease.ownerId),
        eq(portfolioManagerSyncStates.connectionId, lease.connectionId),
        eq(portfolioManagerSyncStates.leaseId, lease.leaseId),
        eq(portfolioManagerSyncStates.activeRunId, lease.runId),
      ),
    )
    .returning({ ownerId: portfolioManagerSyncStates.ownerId });
  if (updated.length !== 1) {
    throw new DataConflictError(
      'portfolio_manager.lease_lost',
      'Portfolio Manager synchronization lease was lost.',
    );
  }
}

export async function persistPortfolioManagerRawReceipt(
  db: Database,
  lease: PortfolioManagerSyncLease,
  key: PortfolioManagerReceiptKey,
  input: Readonly<{
    endpoint: 'capabilities' | 'snapshot' | 'capital_flows';
    requestKey: string;
    requestCursor: string | null;
    receivedAt: string;
    payload: string;
    normalizationVersion: string;
  }>,
): Promise<PersistedPortfolioManagerReceipt> {
  const encrypted = encryptPortfolioPayload(input.payload, key);
  const payloadSha256 = createHash('sha256').update(input.payload).digest('hex');
  const id = generateUuidV7('portfolio-manager-receipt');
  const payloadExpiresAt = new Date(
    date(input.receivedAt).getTime() + RAW_RETENTION_MILLISECONDS,
  ).toISOString();
  await db.insert(portfolioManagerRawReceipts).values({
    id,
    runId: lease.runId,
    ownerId: lease.ownerId,
    connectionId: lease.connectionId,
    endpoint: input.endpoint,
    requestKey: input.requestKey,
    requestCursor: input.requestCursor,
    responseCursor: null,
    receivedAt: input.receivedAt,
    payloadSha256,
    payloadCiphertext: encrypted.ciphertext,
    payloadIv: encrypted.iv,
    payloadAuthTag: encrypted.authTag,
    payloadExpiresAt,
    status: 'received',
    normalizationVersion: input.normalizationVersion,
    sourceIds: [],
    revisionIds: [],
    failureCategory: null,
    processedAt: null,
  });
  return Object.freeze({ id, runId: lease.runId, payloadSha256, ...input });
}

export async function loadPendingPortfolioManagerReceipts(
  db: Database,
  lease: PortfolioManagerSyncLease,
  key: PortfolioManagerReceiptKey,
): Promise<readonly PersistedPortfolioManagerReceipt[]> {
  const rows = await db.query.portfolioManagerRawReceipts.findMany({
    where: and(
      eq(portfolioManagerRawReceipts.runId, lease.runId),
      eq(portfolioManagerRawReceipts.status, 'received'),
    ),
    orderBy: (table, { asc }) => [asc(table.receivedAt), asc(table.id)],
  });
  return Object.freeze(
    rows.map((row) => {
      if (row.payloadCiphertext === null || row.payloadIv === null || row.payloadAuthTag === null) {
        throw new DataInvariantError(
          'portfolio_manager.receipt_payload_expired',
          'Pending Portfolio Manager receipt payload is unavailable.',
        );
      }
      return Object.freeze({
        id: row.id,
        runId: row.runId,
        endpoint: row.endpoint as PersistedPortfolioManagerReceipt['endpoint'],
        requestKey: row.requestKey,
        requestCursor: row.requestCursor,
        receivedAt: row.receivedAt,
        payloadSha256: row.payloadSha256,
        payload: decryptPortfolioPayload(
          row.payloadCiphertext,
          row.payloadIv,
          row.payloadAuthTag,
          key,
          'Portfolio Manager',
        ),
      });
    }),
  );
}

function newerThanCurrent(
  revision: PortfolioManagerRevisionInput,
  current: Readonly<{ changedAt: string | null; providerRevisionId: string | null }>,
): boolean {
  if (revision.recordKind !== 'capital_flow') return true;
  if (revision.changedAt === null) return false;
  if (current.changedAt === null) return true;
  if (revision.changedAt !== current.changedAt) return revision.changedAt > current.changedAt;
  return (revision.providerRevisionId ?? '') > (current.providerRevisionId ?? '');
}

export async function finalizePortfolioManagerReceipt(
  db: Database,
  lease: PortfolioManagerSyncLease,
  input: Readonly<{
    receiptId: string;
    status: 'normalized' | 'quarantined';
    revisions: readonly PortfolioManagerRevisionInput[];
    responseCursor: string | null;
    advanceCheckpoint: boolean;
    now: string;
    failureCategory?: string | null;
  }>,
): Promise<readonly PortfolioManagerRevisionDisposition[]> {
  return db.transaction(async (tx) => {
    const receipt = await tx.query.portfolioManagerRawReceipts.findFirst({
      where: and(
        eq(portfolioManagerRawReceipts.id, input.receiptId),
        eq(portfolioManagerRawReceipts.runId, lease.runId),
        eq(portfolioManagerRawReceipts.status, 'received'),
      ),
    });
    if (receipt === undefined) {
      throw new DataConflictError(
        'portfolio_manager.receipt_already_processed',
        'Portfolio Manager receipt is no longer pending.',
      );
    }
    const dispositions: PortfolioManagerRevisionDisposition[] = [];
    for (const revision of input.revisions) {
      const exact = await tx.query.portfolioManagerSourceRevisions.findFirst({
        where: and(
          eq(portfolioManagerSourceRevisions.ownerId, lease.ownerId),
          eq(portfolioManagerSourceRevisions.connectionId, lease.connectionId),
          eq(portfolioManagerSourceRevisions.sourceId, revision.sourceId),
          eq(portfolioManagerSourceRevisions.revisionSha256, revision.revisionSha256),
        ),
      });
      if (exact !== undefined) {
        await tx
          .update(portfolioManagerSourceRevisions)
          .set({ lastSeenAt: input.now, receiptId: input.receiptId })
          .where(
            and(
              eq(portfolioManagerSourceRevisions.ownerId, lease.ownerId),
              eq(portfolioManagerSourceRevisions.connectionId, lease.connectionId),
              eq(portfolioManagerSourceRevisions.sourceId, revision.sourceId),
              eq(portfolioManagerSourceRevisions.revisionSha256, revision.revisionSha256),
            ),
          );
        dispositions.push({
          sourceId: revision.sourceId,
          revisionSha256: revision.revisionSha256,
          disposition: 'replay',
        });
        continue;
      }
      const current = await tx.query.portfolioManagerSourceRevisions.findFirst({
        where: and(
          eq(portfolioManagerSourceRevisions.ownerId, lease.ownerId),
          eq(portfolioManagerSourceRevisions.connectionId, lease.connectionId),
          eq(portfolioManagerSourceRevisions.sourceId, revision.sourceId),
          eq(portfolioManagerSourceRevisions.isCurrent, true),
        ),
      });
      const becomesCurrent = current === undefined || newerThanCurrent(revision, current);
      if (current !== undefined && becomesCurrent) {
        await tx
          .update(portfolioManagerSourceRevisions)
          .set({ isCurrent: false })
          .where(
            and(
              eq(portfolioManagerSourceRevisions.ownerId, lease.ownerId),
              eq(portfolioManagerSourceRevisions.connectionId, lease.connectionId),
              eq(portfolioManagerSourceRevisions.sourceId, revision.sourceId),
              eq(portfolioManagerSourceRevisions.isCurrent, true),
            ),
          );
      }
      await tx.insert(portfolioManagerSourceRevisions).values({
        ownerId: lease.ownerId,
        connectionId: lease.connectionId,
        sourceId: revision.sourceId,
        revisionSha256: revision.revisionSha256,
        recordKind: revision.recordKind,
        providerRevisionId: revision.providerRevisionId,
        providerStatus: revision.providerStatus,
        changedAt: revision.changedAt,
        replacesRevisionId: revision.replacesRevisionId,
        replacementRevisionIds: [...revision.replacementRevisionIds],
        receiptId: input.receiptId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        isCurrent: becomesCurrent,
      });
      dispositions.push({
        sourceId: revision.sourceId,
        revisionSha256: revision.revisionSha256,
        disposition: current === undefined ? 'new' : 'revision',
      });
    }
    await tx
      .update(portfolioManagerRawReceipts)
      .set({
        status: input.status,
        responseCursor: input.responseCursor,
        sourceIds: input.revisions.map((item) => item.sourceId),
        revisionIds: input.revisions.map((item) => item.revisionSha256),
        failureCategory: input.failureCategory ?? null,
        processedAt: input.now,
      })
      .where(eq(portfolioManagerRawReceipts.id, input.receiptId));
    if (input.advanceCheckpoint) {
      await tx
        .update(portfolioManagerSyncRuns)
        .set({ continuationCursor: input.responseCursor })
        .where(
          and(
            eq(portfolioManagerSyncRuns.id, lease.runId),
            eq(portfolioManagerSyncRuns.status, 'running'),
          ),
        );
      await tx
        .update(portfolioManagerSyncStates)
        .set({ checkpoint: input.responseCursor, updatedAt: input.now })
        .where(
          and(
            eq(portfolioManagerSyncStates.ownerId, lease.ownerId),
            eq(portfolioManagerSyncStates.connectionId, lease.connectionId),
            eq(portfolioManagerSyncStates.leaseId, lease.leaseId),
          ),
        );
    }
    return Object.freeze(dispositions.map((item) => Object.freeze(item)));
  });
}

export async function failPortfolioManagerReceipt(
  db: Database,
  receiptId: string,
  category: string,
  now: string,
): Promise<void> {
  await db
    .update(portfolioManagerRawReceipts)
    .set({ status: 'failed', failureCategory: category, processedAt: now })
    .where(
      and(
        eq(portfolioManagerRawReceipts.id, receiptId),
        eq(portfolioManagerRawReceipts.status, 'received'),
      ),
    );
}

export async function completePortfolioManagerSync(
  db: Database,
  lease: PortfolioManagerSyncLease,
  input: Readonly<{
    counts: Readonly<Record<string, number>>;
    sourceCompleteness: 'complete' | 'partial' | 'unavailable';
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(portfolioManagerSyncRuns)
      .set({
        status: 'completed',
        counts: input.counts,
        sourceCompleteness: input.sourceCompleteness,
        completedAt: input.now,
      })
      .where(
        and(
          eq(portfolioManagerSyncRuns.id, lease.runId),
          eq(portfolioManagerSyncRuns.status, 'running'),
        ),
      );
    const released = await tx
      .update(portfolioManagerSyncStates)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        activeRunId: null,
        lastSuccessfulSyncAt: input.now,
        lastFailureCategory: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(portfolioManagerSyncStates.ownerId, lease.ownerId),
          eq(portfolioManagerSyncStates.connectionId, lease.connectionId),
          eq(portfolioManagerSyncStates.leaseId, lease.leaseId),
        ),
      )
      .returning({ ownerId: portfolioManagerSyncStates.ownerId });
    if (released.length !== 1) {
      throw new DataConflictError(
        'portfolio_manager.lease_lost',
        'Portfolio Manager synchronization lease was lost.',
      );
    }
  });
}

export async function failPortfolioManagerSync(
  db: Database,
  lease: PortfolioManagerSyncLease,
  category: string,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(portfolioManagerSyncRuns)
      .set({ status: 'failed', completedAt: now, failureCategory: category })
      .where(
        and(
          eq(portfolioManagerSyncRuns.id, lease.runId),
          eq(portfolioManagerSyncRuns.status, 'running'),
        ),
      );
    await tx
      .update(portfolioManagerSyncStates)
      .set({
        leaseId: null,
        leaseExpiresAt: null,
        activeRunId: null,
        lastFailureCategory: category,
        updatedAt: now,
      })
      .where(
        and(
          eq(portfolioManagerSyncStates.ownerId, lease.ownerId),
          eq(portfolioManagerSyncStates.connectionId, lease.connectionId),
          eq(portfolioManagerSyncStates.leaseId, lease.leaseId),
        ),
      );
  });
}

export async function expirePortfolioManagerRawPayloads(
  db: Database,
  now: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .update(portfolioManagerRawReceipts)
      .set({
        status: 'failed',
        failureCategory: 'portfolio_manager_receipt_expired',
        processedAt: now,
      })
      .where(
        and(
          lte(portfolioManagerRawReceipts.payloadExpiresAt, now),
          eq(portfolioManagerRawReceipts.status, 'received'),
        ),
      );
    const rows = await tx
      .update(portfolioManagerRawReceipts)
      .set({ payloadCiphertext: null, payloadIv: null, payloadAuthTag: null })
      .where(
        and(
          lte(portfolioManagerRawReceipts.payloadExpiresAt, now),
          isNotNull(portfolioManagerRawReceipts.payloadCiphertext),
        ),
      )
      .returning({ id: portfolioManagerRawReceipts.id });
    return rows.length;
  });
}
