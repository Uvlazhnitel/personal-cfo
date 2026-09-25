import { createHash, randomBytes } from 'node:crypto';

import { and, asc, eq, gt, isNotNull, lte, ne } from 'drizzle-orm';

import type { Database } from './database.js';
import { DataConflictError, DataInvariantError } from './errors.js';
import {
  decryptProviderPayload,
  deriveProviderSubkey,
  encryptProviderPayload,
  parseProviderDataKey,
} from './portfolio-receipts.js';
import type { PortfolioReceiptKey, ProviderDataKey } from './portfolio-receipts.js';
import {
  accounts,
  enableBankingAuthorizationAttempts,
  enableBankingConnections,
  enableBankingProviderAccounts,
  enableBankingRawReceipts,
  enableBankingRuns,
  enableBankingSourceRevisions,
  users,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

const AUTHORIZATION_TTL_MILLISECONDS = 15 * 60_000;
const FETCH_LEASE_MILLISECONDS = 15 * 60_000;
const RAW_RETENTION_MILLISECONDS = 30 * 24 * 60 * 60_000;

export type EnableBankingDataKey = ProviderDataKey;

export type EnableBankingRunContext = Readonly<{
  runId: string;
  ownerId: string;
  connectionId: string;
}>;

export type EnableBankingAuthorization = EnableBankingRunContext &
  Readonly<{
    attemptId: string;
    state: string;
    expiresAt: string;
  }>;

export type ClaimedEnableBankingAuthorization = EnableBankingRunContext &
  Readonly<{ attemptId: string }>;

export type PersistedEnableBankingReceipt = Readonly<{
  id: string;
  runId: string;
  endpoint:
    | 'aspsps'
    | 'authorization'
    | 'session_exchange'
    | 'session'
    | 'account_details'
    | 'balances'
    | 'transactions'
    | 'disconnect';
  method: 'GET' | 'POST' | 'DELETE';
  requestKey: string;
  requestCursorHash: string | null;
  httpStatus: number;
  receivedAt: string;
  payloadSha256: string;
  payload: string;
}>;

export type EnableBankingRevisionInput = Readonly<{
  sourceKey: string;
  revisionSha256: string;
  recordKind: 'account' | 'balance' | 'transaction';
  providerStatus: string | null;
  providerAccountId: string;
}>;

export type EnableBankingRevisionDisposition = Readonly<{
  sourceKey: string;
  revisionSha256: string;
  disposition: 'new' | 'replay' | 'revision';
}>;

export type EnableBankingProviderAccountInput = Readonly<{
  identificationHash: string;
  uid: string;
  currency: string;
  displayHint: string | null;
}>;

export type EnableBankingDiscoveredAccount = Readonly<{
  id: string;
  currency: string;
  displayHint: string | null;
  canonicalAccountId: string | null;
  currentSession: boolean;
}>;

export type EnableBankingDiagnosticLease = EnableBankingRunContext &
  Readonly<{
    leaseId: string;
    providerAccountId: string;
    canonicalAccountId: string;
    sessionGeneration: string;
    connectionGeneration: string;
    sessionId: string;
    accountUid: string;
    identificationHash: string;
    continuationKey: string | null;
  }>;

export type EnableBankingDisconnectLease = EnableBankingRunContext &
  Readonly<{ leaseId: string; sessionId: string }>;

function instant(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new DataInvariantError('enable_banking.invalid_instant', 'Instant is invalid.');
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sessionAad(
  ownerId: string,
  connectionId: string,
  field: string,
  recordId: string,
): string {
  return `enable-banking|session-v1|${ownerId}|${connectionId}|${field}|${recordId}`;
}

function receiptAad(
  ownerId: string,
  connectionId: string,
  runId: string,
  receiptId: string,
  endpoint: string,
  requestKey: string,
  requestCursorHash: string | null,
): string {
  return `enable-banking|receipt-v1|${ownerId}|${connectionId}|${runId}|${receiptId}|${endpoint}|${requestKey}|${requestCursorHash ?? '-'}`;
}

function sessionKey(key: EnableBankingDataKey): PortfolioReceiptKey {
  return deriveProviderSubkey(key, 'session-v1');
}

function receiptKey(key: EnableBankingDataKey): PortfolioReceiptKey {
  return deriveProviderSubkey(key, 'receipt-v1');
}

function encryptSessionValue(
  value: string,
  key: EnableBankingDataKey,
  ownerId: string,
  connectionId: string,
  field: string,
  recordId: string,
) {
  return encryptProviderPayload(
    value,
    sessionKey(key),
    sessionAad(ownerId, connectionId, field, recordId),
  );
}

function decryptSessionValue(
  value: Readonly<{ ciphertext: string; iv: string; authTag: string }>,
  key: EnableBankingDataKey,
  ownerId: string,
  connectionId: string,
  field: string,
  recordId: string,
): string {
  return decryptProviderPayload(
    value.ciphertext,
    value.iv,
    value.authTag,
    sessionKey(key),
    sessionAad(ownerId, connectionId, field, recordId),
    'Enable Banking',
  );
}

export function parseEnableBankingDataKey(value: string): EnableBankingDataKey {
  return parseProviderDataKey(value, 'ENABLE_BANKING_DATA_KEY');
}

export function hashEnableBankingApplicationId(applicationId: string): string {
  return sha256(`enable-banking-application-v1|${applicationId}`);
}

export function hashEnableBankingAccountIdentity(ownerId: string, identificationHash: string) {
  return sha256(`enable-banking-account-v1|${ownerId}|${identificationHash}`);
}

export function hashEnableBankingSourceKey(
  ownerId: string,
  connectionId: string,
  sourceId: string,
): string {
  return sha256(`enable-banking-source-v1|${ownerId}|${connectionId}|${sourceId}`);
}

export function hashEnableBankingCursor(value: string): string {
  return sha256(`enable-banking-cursor-v1|${value}`);
}

export async function beginEnableBankingAuthorization(
  db: Database,
  input: Readonly<{ ownerId: string; applicationIdHash: string; now: string }>,
): Promise<EnableBankingAuthorization> {
  const now = instant(input.now);
  const owner = await db.query.users.findFirst({ where: eq(users.id, input.ownerId) });
  if (owner === undefined) {
    throw new DataInvariantError(
      'enable_banking.owner_missing',
      'Configured owner does not exist.',
    );
  }
  return db.transaction(async (tx) => {
    const connection = await tx.query.enableBankingConnections.findFirst({
      where: eq(enableBankingConnections.ownerId, input.ownerId),
    });
    if (connection !== undefined && connection.applicationIdHash !== input.applicationIdHash) {
      throw new DataConflictError(
        'enable_banking.application_rebind',
        'Enable Banking application cannot be silently rebound.',
      );
    }
    if (connection?.status === 'active') {
      throw new DataConflictError(
        'enable_banking.already_active',
        'The Enable Banking connection is already active.',
      );
    }
    const connectionId = connection?.id ?? generateUuidV7('enable-banking-connection');
    if (connection === undefined) {
      await tx.insert(enableBankingConnections).values({
        id: connectionId,
        ownerId: input.ownerId,
        generation: generateUuidV7('enable-banking-generation'),
        status: 'disconnected',
        applicationIdHash: input.applicationIdHash,
        createdAt: input.now,
        updatedAt: input.now,
      });
    }
    await tx
      .update(enableBankingAuthorizationAttempts)
      .set({
        status: 'failed',
        completedAt: input.now,
        failureCategory: 'enable_banking_authorization_superseded',
      })
      .where(
        and(
          eq(enableBankingAuthorizationAttempts.connectionId, connectionId),
          eq(enableBankingAuthorizationAttempts.status, 'pending'),
        ),
      );
    const runId = generateUuidV7('enable-banking-authorization-run');
    const attemptId = generateUuidV7('enable-banking-authorization-attempt');
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + AUTHORIZATION_TTL_MILLISECONDS).toISOString();
    await tx.insert(enableBankingRuns).values({
      id: runId,
      ownerId: input.ownerId,
      connectionId,
      kind: 'authorization',
      status: 'pending',
      startedAt: input.now,
    });
    await tx.insert(enableBankingAuthorizationAttempts).values({
      id: attemptId,
      ownerId: input.ownerId,
      connectionId,
      runId,
      stateHash: sha256(state),
      status: 'pending',
      expiresAt,
      createdAt: input.now,
    });
    await tx
      .update(enableBankingConnections)
      .set({ status: 'connecting', updatedAt: input.now, lastFailureCategory: null })
      .where(eq(enableBankingConnections.id, connectionId));
    return Object.freeze({
      runId,
      ownerId: input.ownerId,
      connectionId,
      attemptId,
      state,
      expiresAt,
    });
  });
}

export async function markEnableBankingAuthorizationStarted(
  db: Database,
  authorization: EnableBankingAuthorization,
): Promise<void> {
  await db
    .update(enableBankingRuns)
    .set({ status: 'running' })
    .where(
      and(eq(enableBankingRuns.id, authorization.runId), eq(enableBankingRuns.status, 'pending')),
    );
}

export async function claimEnableBankingAuthorization(
  db: Database,
  state: string,
  now: string,
): Promise<ClaimedEnableBankingAuthorization> {
  const stateHash = sha256(state);
  return db.transaction(async (tx) => {
    const claimed = await tx
      .update(enableBankingAuthorizationAttempts)
      .set({ status: 'exchanging', claimedAt: now })
      .where(
        and(
          eq(enableBankingAuthorizationAttempts.stateHash, stateHash),
          eq(enableBankingAuthorizationAttempts.status, 'pending'),
          gt(enableBankingAuthorizationAttempts.expiresAt, now),
        ),
      )
      .returning();
    const attempt = claimed[0];
    if (attempt === undefined) {
      const existing = await tx.query.enableBankingAuthorizationAttempts.findFirst({
        where: eq(enableBankingAuthorizationAttempts.stateHash, stateHash),
      });
      if (
        existing?.status === 'pending' &&
        instant(existing.expiresAt).getTime() <= instant(now).getTime()
      ) {
        await tx
          .update(enableBankingAuthorizationAttempts)
          .set({ status: 'expired', completedAt: now, failureCategory: 'authorization_expired' })
          .where(eq(enableBankingAuthorizationAttempts.id, existing.id));
      }
      throw new DataConflictError(
        'enable_banking.invalid_or_replayed_state',
        'Authorization state is invalid, expired, or already used.',
      );
    }
    return Object.freeze({
      runId: attempt.runId,
      ownerId: attempt.ownerId,
      connectionId: attempt.connectionId,
      attemptId: attempt.id,
    });
  });
}

export async function cancelEnableBankingAuthorization(
  db: Database,
  state: string,
  now: string,
  category = 'authorization_cancelled',
): Promise<void> {
  const stateHash = sha256(state);
  await db.transaction(async (tx) => {
    const rows = await tx
      .update(enableBankingAuthorizationAttempts)
      .set({ status: 'cancelled', completedAt: now, failureCategory: category })
      .where(
        and(
          eq(enableBankingAuthorizationAttempts.stateHash, stateHash),
          eq(enableBankingAuthorizationAttempts.status, 'pending'),
        ),
      )
      .returning();
    const attempt = rows[0];
    if (attempt === undefined) {
      throw new DataConflictError(
        'enable_banking.invalid_or_replayed_state',
        'Authorization state is invalid or already used.',
      );
    }
    await tx
      .update(enableBankingRuns)
      .set({ status: 'failed', completedAt: now, failureCategory: category })
      .where(eq(enableBankingRuns.id, attempt.runId));
    await tx
      .update(enableBankingConnections)
      .set({ status: 'disconnected', updatedAt: now, lastFailureCategory: category })
      .where(eq(enableBankingConnections.id, attempt.connectionId));
  });
}

export async function activateEnableBankingSession(
  db: Database,
  authorization: ClaimedEnableBankingAuthorization,
  key: EnableBankingDataKey,
  input: Readonly<{
    sessionId: string;
    validUntil: string;
    accounts: readonly EnableBankingProviderAccountInput[];
    now: string;
  }>,
): Promise<void> {
  const sessionGeneration = generateUuidV7('enable-banking-session-generation');
  const encryptedSession = encryptSessionValue(
    input.sessionId,
    key,
    authorization.ownerId,
    authorization.connectionId,
    'session-id',
    sessionGeneration,
  );
  await db.transaction(async (tx) => {
    const attempt = await tx.query.enableBankingAuthorizationAttempts.findFirst({
      where: and(
        eq(enableBankingAuthorizationAttempts.id, authorization.attemptId),
        eq(enableBankingAuthorizationAttempts.status, 'exchanging'),
      ),
    });
    if (attempt === undefined) {
      throw new DataConflictError(
        'enable_banking.authorization_not_claimed',
        'Authorization exchange is no longer claimable.',
      );
    }
    const seen = new Set<string>();
    for (const account of input.accounts) {
      const stableAccountKey = hashEnableBankingAccountIdentity(
        authorization.ownerId,
        account.identificationHash,
      );
      if (seen.has(stableAccountKey)) {
        throw new DataInvariantError(
          'enable_banking.duplicate_account_identity',
          'Provider returned a duplicate account identity.',
        );
      }
      seen.add(stableAccountKey);
      const providerAccountId =
        (
          await tx.query.enableBankingProviderAccounts.findFirst({
            where: and(
              eq(enableBankingProviderAccounts.ownerId, authorization.ownerId),
              eq(enableBankingProviderAccounts.stableAccountKey, stableAccountKey),
            ),
          })
        )?.id ?? generateUuidV7('enable-banking-provider-account');
      const encryptedIdentity = encryptSessionValue(
        account.identificationHash,
        key,
        authorization.ownerId,
        authorization.connectionId,
        'identification-hash',
        providerAccountId,
      );
      const encryptedUid = encryptSessionValue(
        account.uid,
        key,
        authorization.ownerId,
        authorization.connectionId,
        'account-uid',
        providerAccountId,
      );
      const encryptedHint =
        account.displayHint === null
          ? null
          : encryptSessionValue(
              account.displayHint,
              key,
              authorization.ownerId,
              authorization.connectionId,
              'display-hint',
              providerAccountId,
            );
      await tx
        .insert(enableBankingProviderAccounts)
        .values({
          id: providerAccountId,
          ownerId: authorization.ownerId,
          connectionId: authorization.connectionId,
          stableAccountKey,
          identificationHashCiphertext: encryptedIdentity.ciphertext,
          identificationHashIv: encryptedIdentity.iv,
          identificationHashAuthTag: encryptedIdentity.authTag,
          accountUidCiphertext: encryptedUid.ciphertext,
          accountUidIv: encryptedUid.iv,
          accountUidAuthTag: encryptedUid.authTag,
          displayHintCiphertext: encryptedHint?.ciphertext ?? null,
          displayHintIv: encryptedHint?.iv ?? null,
          displayHintAuthTag: encryptedHint?.authTag ?? null,
          sessionGeneration,
          currency: account.currency,
          observedAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: [
            enableBankingProviderAccounts.ownerId,
            enableBankingProviderAccounts.stableAccountKey,
          ],
          set: {
            connectionId: authorization.connectionId,
            identificationHashCiphertext: encryptedIdentity.ciphertext,
            identificationHashIv: encryptedIdentity.iv,
            identificationHashAuthTag: encryptedIdentity.authTag,
            accountUidCiphertext: encryptedUid.ciphertext,
            accountUidIv: encryptedUid.iv,
            accountUidAuthTag: encryptedUid.authTag,
            displayHintCiphertext: encryptedHint?.ciphertext ?? null,
            displayHintIv: encryptedHint?.iv ?? null,
            displayHintAuthTag: encryptedHint?.authTag ?? null,
            sessionGeneration,
            currency: account.currency,
            observedAt: input.now,
            updatedAt: input.now,
          },
        });
    }
    await tx
      .update(enableBankingProviderAccounts)
      .set({
        accountUidCiphertext: null,
        accountUidIv: null,
        accountUidAuthTag: null,
        sessionGeneration: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(enableBankingProviderAccounts.connectionId, authorization.connectionId),
          isNotNull(enableBankingProviderAccounts.sessionGeneration),
          ne(enableBankingProviderAccounts.sessionGeneration, sessionGeneration),
        ),
      );
    await tx
      .update(enableBankingConnections)
      .set({
        status: 'active',
        sessionIdCiphertext: encryptedSession.ciphertext,
        sessionIdIv: encryptedSession.iv,
        sessionIdAuthTag: encryptedSession.authTag,
        sessionGeneration,
        consentExpiresAt: input.validUntil,
        updatedAt: input.now,
        lastFailureCategory: null,
      })
      .where(eq(enableBankingConnections.id, authorization.connectionId));
    await tx
      .update(enableBankingAuthorizationAttempts)
      .set({ status: 'completed', completedAt: input.now, failureCategory: null })
      .where(eq(enableBankingAuthorizationAttempts.id, authorization.attemptId));
    await tx
      .update(enableBankingRuns)
      .set({ status: 'completed', completedAt: input.now, failureCategory: null })
      .where(eq(enableBankingRuns.id, authorization.runId));
  });
}

export async function failEnableBankingAuthorization(
  db: Database,
  authorization: ClaimedEnableBankingAuthorization | EnableBankingAuthorization,
  status: 'failed' | 'indeterminate',
  category: string,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(enableBankingAuthorizationAttempts)
      .set({ status, completedAt: now, failureCategory: category })
      .where(eq(enableBankingAuthorizationAttempts.id, authorization.attemptId));
    await tx
      .update(enableBankingRuns)
      .set({ status, completedAt: now, failureCategory: category })
      .where(eq(enableBankingRuns.id, authorization.runId));
    await tx
      .update(enableBankingConnections)
      .set({ status: 'error', updatedAt: now, lastFailureCategory: category })
      .where(eq(enableBankingConnections.id, authorization.connectionId));
  });
}

export async function listEnableBankingDiscoveredAccounts(
  db: Database,
  ownerId: string,
  key: EnableBankingDataKey,
): Promise<readonly EnableBankingDiscoveredAccount[]> {
  const connection = await db.query.enableBankingConnections.findFirst({
    where: eq(enableBankingConnections.ownerId, ownerId),
  });
  if (connection === undefined) return Object.freeze([]);
  const rows = await db.query.enableBankingProviderAccounts.findMany({
    where: eq(enableBankingProviderAccounts.connectionId, connection.id),
    orderBy: (table, { asc }) => [asc(table.id)],
  });
  return Object.freeze(
    rows.map((row) => {
      const displayHint =
        row.displayHintCiphertext === null ||
        row.displayHintIv === null ||
        row.displayHintAuthTag === null
          ? null
          : decryptSessionValue(
              {
                ciphertext: row.displayHintCiphertext,
                iv: row.displayHintIv,
                authTag: row.displayHintAuthTag,
              },
              key,
              row.ownerId,
              row.connectionId,
              'display-hint',
              row.id,
            );
      return Object.freeze({
        id: row.id,
        currency: row.currency,
        displayHint,
        canonicalAccountId: row.canonicalAccountId,
        currentSession: row.sessionGeneration === connection.sessionGeneration,
      });
    }),
  );
}

export async function bindEnableBankingProviderAccount(
  db: Database,
  input: Readonly<{
    ownerId: string;
    providerAccountId: string;
    canonicalAccountId: string;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    const providerAccount = await tx.query.enableBankingProviderAccounts.findFirst({
      where: and(
        eq(enableBankingProviderAccounts.id, input.providerAccountId),
        eq(enableBankingProviderAccounts.ownerId, input.ownerId),
      ),
    });
    if (providerAccount === undefined || providerAccount.currency !== 'EUR') {
      throw new DataInvariantError(
        'enable_banking.invalid_provider_account',
        'Selected provider account must be an owner-scoped EUR account.',
      );
    }
    const canonical = await tx.query.accounts.findFirst({
      where: and(eq(accounts.id, input.canonicalAccountId), eq(accounts.ownerId, input.ownerId)),
    });
    const payload = canonical?.payload as Record<string, unknown> | undefined;
    if (
      canonical === undefined ||
      canonical.kind !== 'bank' ||
      canonical.valueSource !== 'balance_snapshot' ||
      canonical.currency !== 'EUR' ||
      payload?.['includeInNetWorth'] !== true
    ) {
      throw new DataInvariantError(
        'enable_banking.invalid_canonical_account',
        'Canonical account must be an included owner-scoped EUR bank account.',
      );
    }
    await tx
      .update(enableBankingProviderAccounts)
      .set({ canonicalAccountId: input.canonicalAccountId, updatedAt: input.now })
      .where(eq(enableBankingProviderAccounts.id, input.providerAccountId));
  });
}

export async function persistEnableBankingRawReceipt(
  db: Database,
  run: EnableBankingRunContext,
  key: EnableBankingDataKey,
  input: Readonly<{
    endpoint: PersistedEnableBankingReceipt['endpoint'];
    method: PersistedEnableBankingReceipt['method'];
    requestKey: string;
    requestCursor: string | null;
    httpStatus: number;
    receivedAt: string;
    payload: string;
    normalizationVersion: string;
  }>,
): Promise<PersistedEnableBankingReceipt> {
  const id = generateUuidV7('enable-banking-receipt');
  const requestCursorHash =
    input.requestCursor === null ? null : sha256(`enable-banking-cursor-v1|${input.requestCursor}`);
  const encrypted = encryptProviderPayload(
    input.payload,
    receiptKey(key),
    receiptAad(
      run.ownerId,
      run.connectionId,
      run.runId,
      id,
      input.endpoint,
      input.requestKey,
      requestCursorHash,
    ),
  );
  const payloadSha256 = sha256(input.payload);
  const payloadExpiresAt = new Date(
    instant(input.receivedAt).getTime() + RAW_RETENTION_MILLISECONDS,
  ).toISOString();
  await db.insert(enableBankingRawReceipts).values({
    id,
    runId: run.runId,
    ownerId: run.ownerId,
    connectionId: run.connectionId,
    endpoint: input.endpoint,
    method: input.method,
    requestKey: input.requestKey,
    requestCursorHash,
    httpStatus: input.httpStatus,
    receivedAt: input.receivedAt,
    payloadSha256,
    payloadCiphertext: encrypted.ciphertext,
    payloadIv: encrypted.iv,
    payloadAuthTag: encrypted.authTag,
    payloadExpiresAt,
    status: 'received',
    normalizationVersion: input.normalizationVersion,
  });
  return Object.freeze({
    id,
    runId: run.runId,
    endpoint: input.endpoint,
    method: input.method,
    requestKey: input.requestKey,
    requestCursorHash,
    httpStatus: input.httpStatus,
    receivedAt: input.receivedAt,
    payloadSha256,
    payload: input.payload,
  });
}

export async function loadPendingEnableBankingReceipts(
  db: Database,
  run: EnableBankingRunContext,
  key: EnableBankingDataKey,
): Promise<readonly PersistedEnableBankingReceipt[]> {
  const rows = await db.query.enableBankingRawReceipts.findMany({
    where: and(
      eq(enableBankingRawReceipts.runId, run.runId),
      eq(enableBankingRawReceipts.status, 'received'),
    ),
    orderBy: (table, { asc }) => [asc(table.receivedAt), asc(table.id)],
  });
  return Object.freeze(
    rows.map((row) => {
      if (row.payloadCiphertext === null || row.payloadIv === null || row.payloadAuthTag === null) {
        throw new DataInvariantError(
          'enable_banking.receipt_expired',
          'Pending Enable Banking receipt payload is unavailable.',
        );
      }
      return Object.freeze({
        id: row.id,
        runId: row.runId,
        endpoint: row.endpoint as PersistedEnableBankingReceipt['endpoint'],
        method: row.method as PersistedEnableBankingReceipt['method'],
        requestKey: row.requestKey,
        requestCursorHash: row.requestCursorHash,
        httpStatus: row.httpStatus,
        receivedAt: row.receivedAt,
        payloadSha256: row.payloadSha256,
        payload: decryptProviderPayload(
          row.payloadCiphertext,
          row.payloadIv,
          row.payloadAuthTag,
          receiptKey(key),
          receiptAad(
            row.ownerId,
            row.connectionId,
            row.runId,
            row.id,
            row.endpoint,
            row.requestKey,
            row.requestCursorHash,
          ),
          'Enable Banking',
        ),
      });
    }),
  );
}

export async function finalizeEnableBankingReceipt(
  db: Database,
  run: EnableBankingRunContext,
  key: EnableBankingDataKey,
  input: Readonly<{
    receiptId: string;
    status: 'normalized' | 'quarantined';
    revisions: readonly EnableBankingRevisionInput[];
    responseCursor: string | null;
    advanceContinuation: boolean;
    failureCategory?: string | null;
    now: string;
  }>,
): Promise<readonly EnableBankingRevisionDisposition[]> {
  return db.transaction(async (tx) => {
    const receipt = await tx.query.enableBankingRawReceipts.findFirst({
      where: and(
        eq(enableBankingRawReceipts.id, input.receiptId),
        eq(enableBankingRawReceipts.runId, run.runId),
        eq(enableBankingRawReceipts.status, 'received'),
      ),
    });
    if (receipt === undefined) {
      throw new DataConflictError(
        'enable_banking.receipt_already_processed',
        'Enable Banking receipt is no longer pending.',
      );
    }
    const dispositions: EnableBankingRevisionDisposition[] = [];
    for (const revision of input.revisions) {
      const account = await tx.query.enableBankingProviderAccounts.findFirst({
        where: and(
          eq(enableBankingProviderAccounts.id, revision.providerAccountId),
          eq(enableBankingProviderAccounts.ownerId, run.ownerId),
          eq(enableBankingProviderAccounts.connectionId, run.connectionId),
        ),
      });
      if (account === undefined) {
        throw new DataInvariantError(
          'enable_banking.cross_account_revision',
          'Revision does not belong to the current owner and connection.',
        );
      }
      const exact = await tx.query.enableBankingSourceRevisions.findFirst({
        where: and(
          eq(enableBankingSourceRevisions.ownerId, run.ownerId),
          eq(enableBankingSourceRevisions.connectionId, run.connectionId),
          eq(enableBankingSourceRevisions.sourceKey, revision.sourceKey),
          eq(enableBankingSourceRevisions.revisionSha256, revision.revisionSha256),
        ),
      });
      if (exact !== undefined) {
        await tx
          .update(enableBankingSourceRevisions)
          .set({ lastSeenAt: input.now, receiptId: input.receiptId })
          .where(
            and(
              eq(enableBankingSourceRevisions.ownerId, run.ownerId),
              eq(enableBankingSourceRevisions.connectionId, run.connectionId),
              eq(enableBankingSourceRevisions.sourceKey, revision.sourceKey),
              eq(enableBankingSourceRevisions.revisionSha256, revision.revisionSha256),
            ),
          );
        dispositions.push({
          sourceKey: revision.sourceKey,
          revisionSha256: revision.revisionSha256,
          disposition: 'replay',
        });
        continue;
      }
      const current = await tx.query.enableBankingSourceRevisions.findFirst({
        where: and(
          eq(enableBankingSourceRevisions.ownerId, run.ownerId),
          eq(enableBankingSourceRevisions.connectionId, run.connectionId),
          eq(enableBankingSourceRevisions.sourceKey, revision.sourceKey),
          eq(enableBankingSourceRevisions.isCurrent, true),
        ),
      });
      if (current !== undefined) {
        await tx
          .update(enableBankingSourceRevisions)
          .set({ isCurrent: false })
          .where(
            and(
              eq(enableBankingSourceRevisions.ownerId, run.ownerId),
              eq(enableBankingSourceRevisions.connectionId, run.connectionId),
              eq(enableBankingSourceRevisions.sourceKey, revision.sourceKey),
              eq(enableBankingSourceRevisions.isCurrent, true),
            ),
          );
      }
      await tx.insert(enableBankingSourceRevisions).values({
        ownerId: run.ownerId,
        connectionId: run.connectionId,
        providerAccountId: revision.providerAccountId,
        sourceKey: revision.sourceKey,
        revisionSha256: revision.revisionSha256,
        recordKind: revision.recordKind,
        providerStatus: revision.providerStatus,
        receiptId: input.receiptId,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        isCurrent: true,
      });
      dispositions.push({
        sourceKey: revision.sourceKey,
        revisionSha256: revision.revisionSha256,
        disposition: current === undefined ? 'new' : 'revision',
      });
    }
    let continuationCiphertext: string | null = null;
    let continuationIv: string | null = null;
    let continuationAuthTag: string | null = null;
    let continuationHash: string | null = null;
    if (input.advanceContinuation && input.responseCursor !== null) {
      const encrypted = encryptSessionValue(
        input.responseCursor,
        key,
        run.ownerId,
        run.connectionId,
        'continuation',
        run.runId,
      );
      continuationCiphertext = encrypted.ciphertext;
      continuationIv = encrypted.iv;
      continuationAuthTag = encrypted.authTag;
      continuationHash = sha256(`enable-banking-cursor-v1|${input.responseCursor}`);
    }
    await tx
      .update(enableBankingRawReceipts)
      .set({
        status: input.status,
        sourceIds: input.revisions.map((item) => item.sourceKey),
        revisionIds: input.revisions.map((item) => item.revisionSha256),
        failureCategory: input.failureCategory ?? null,
        processedAt: input.now,
      })
      .where(eq(enableBankingRawReceipts.id, input.receiptId));
    if (input.advanceContinuation) {
      await tx
        .update(enableBankingRuns)
        .set({
          continuationCiphertext,
          continuationIv,
          continuationAuthTag,
          continuationHash,
        })
        .where(eq(enableBankingRuns.id, run.runId));
    }
    return Object.freeze(dispositions);
  });
}

export async function beginEnableBankingDiagnosticFetch(
  db: Database,
  ownerId: string,
  key: EnableBankingDataKey,
  now: string,
): Promise<EnableBankingDiagnosticLease> {
  return db.transaction(async (tx) => {
    const connection = await tx.query.enableBankingConnections.findFirst({
      where: eq(enableBankingConnections.ownerId, ownerId),
    });
    if (
      connection === undefined ||
      connection.status !== 'active' ||
      connection.sessionIdCiphertext === null ||
      connection.sessionIdIv === null ||
      connection.sessionIdAuthTag === null ||
      connection.sessionGeneration === null ||
      connection.consentExpiresAt === null
    ) {
      throw new DataInvariantError(
        'enable_banking.connection_not_active',
        'Enable Banking connection is not active.',
      );
    }
    if (instant(connection.consentExpiresAt).getTime() <= instant(now).getTime()) {
      await tx
        .update(enableBankingConnections)
        .set({ status: 'reauth_required', updatedAt: now })
        .where(eq(enableBankingConnections.id, connection.id));
      throw new DataInvariantError(
        'enable_banking.consent_expired',
        'Enable Banking consent requires reauthorization.',
      );
    }
    if (
      connection.leaseId !== null &&
      connection.leaseExpiresAt !== null &&
      instant(connection.leaseExpiresAt).getTime() > instant(now).getTime()
    ) {
      throw new DataConflictError(
        'enable_banking.operation_in_progress',
        'An Enable Banking operation is already running.',
      );
    }
    const bound = await tx.query.enableBankingProviderAccounts.findMany({
      where: and(
        eq(enableBankingProviderAccounts.ownerId, ownerId),
        isNotNull(enableBankingProviderAccounts.canonicalAccountId),
      ),
    });
    if (bound.length !== 1) {
      throw new DataInvariantError(
        'enable_banking.account_binding_not_unique',
        'Exactly one Enable Banking account must be explicitly bound.',
      );
    }
    const providerAccount = bound[0]!;
    if (
      providerAccount.currency !== 'EUR' ||
      providerAccount.sessionGeneration !== connection.sessionGeneration ||
      providerAccount.accountUidCiphertext === null ||
      providerAccount.accountUidIv === null ||
      providerAccount.accountUidAuthTag === null ||
      providerAccount.canonicalAccountId === null
    ) {
      throw new DataInvariantError(
        'enable_banking.bound_account_unavailable',
        'Bound EUR account is unavailable in the active session.',
      );
    }
    let run =
      connection.activeRunId === null
        ? undefined
        : await tx.query.enableBankingRuns.findFirst({
            where: and(
              eq(enableBankingRuns.id, connection.activeRunId),
              eq(enableBankingRuns.kind, 'diagnostic_fetch'),
              eq(enableBankingRuns.status, 'running'),
              eq(enableBankingRuns.sessionGeneration, connection.sessionGeneration),
            ),
          });
    if (run === undefined) {
      const runId = generateUuidV7('enable-banking-fetch-run');
      await tx.insert(enableBankingRuns).values({
        id: runId,
        ownerId,
        connectionId: connection.id,
        kind: 'diagnostic_fetch',
        status: 'running',
        strategy: 'longest',
        sessionGeneration: connection.sessionGeneration,
        providerAccountId: providerAccount.id,
        startedAt: now,
      });
      run = await tx.query.enableBankingRuns.findFirst({
        where: eq(enableBankingRuns.id, runId),
      });
    }
    if (run === undefined) throw new Error('Enable Banking fetch run was not created.');
    const leaseId = generateUuidV7('enable-banking-fetch-lease');
    const leaseExpiresAt = new Date(
      instant(now).getTime() + FETCH_LEASE_MILLISECONDS,
    ).toISOString();
    await tx
      .update(enableBankingConnections)
      .set({ activeRunId: run.id, leaseId, leaseExpiresAt, updatedAt: now })
      .where(eq(enableBankingConnections.id, connection.id));
    const sessionId = decryptSessionValue(
      {
        ciphertext: connection.sessionIdCiphertext,
        iv: connection.sessionIdIv,
        authTag: connection.sessionIdAuthTag,
      },
      key,
      ownerId,
      connection.id,
      'session-id',
      connection.sessionGeneration,
    );
    const accountUid = decryptSessionValue(
      {
        ciphertext: providerAccount.accountUidCiphertext,
        iv: providerAccount.accountUidIv,
        authTag: providerAccount.accountUidAuthTag,
      },
      key,
      ownerId,
      connection.id,
      'account-uid',
      providerAccount.id,
    );
    const identificationHash = decryptSessionValue(
      {
        ciphertext: providerAccount.identificationHashCiphertext,
        iv: providerAccount.identificationHashIv,
        authTag: providerAccount.identificationHashAuthTag,
      },
      key,
      ownerId,
      connection.id,
      'identification-hash',
      providerAccount.id,
    );
    const continuationKey =
      run.continuationCiphertext === null ||
      run.continuationIv === null ||
      run.continuationAuthTag === null
        ? null
        : decryptSessionValue(
            {
              ciphertext: run.continuationCiphertext,
              iv: run.continuationIv,
              authTag: run.continuationAuthTag,
            },
            key,
            ownerId,
            connection.id,
            'continuation',
            run.id,
          );
    return Object.freeze({
      runId: run.id,
      ownerId,
      connectionId: connection.id,
      leaseId,
      providerAccountId: providerAccount.id,
      canonicalAccountId: providerAccount.canonicalAccountId,
      sessionGeneration: connection.sessionGeneration,
      connectionGeneration: connection.generation,
      sessionId,
      accountUid,
      identificationHash,
      continuationKey,
    });
  });
}

export async function renewEnableBankingLease(
  db: Database,
  lease: EnableBankingDiagnosticLease | EnableBankingDisconnectLease,
  now: string,
): Promise<void> {
  const leaseExpiresAt = new Date(instant(now).getTime() + FETCH_LEASE_MILLISECONDS).toISOString();
  const rows = await db
    .update(enableBankingConnections)
    .set({ leaseExpiresAt, updatedAt: now })
    .where(
      and(
        eq(enableBankingConnections.id, lease.connectionId),
        eq(enableBankingConnections.ownerId, lease.ownerId),
        eq(enableBankingConnections.activeRunId, lease.runId),
        eq(enableBankingConnections.leaseId, lease.leaseId),
      ),
    )
    .returning({ id: enableBankingConnections.id });
  if (rows.length !== 1) {
    throw new DataConflictError('enable_banking.lease_lost', 'Enable Banking lease was lost.');
  }
}

export async function completeEnableBankingDiagnosticFetch(
  db: Database,
  lease: EnableBankingDiagnosticLease,
  input: Readonly<{
    counts: Record<string, number>;
    coverageFrom: string | null;
    coverageThrough: string | null;
    now: string;
  }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(enableBankingRuns)
      .set({
        status: 'completed',
        counts: input.counts,
        coverageFrom: input.coverageFrom,
        coverageThrough: input.coverageThrough,
        continuationCiphertext: null,
        continuationIv: null,
        continuationAuthTag: null,
        continuationHash: null,
        completedAt: input.now,
        failureCategory: null,
      })
      .where(eq(enableBankingRuns.id, lease.runId));
    await tx
      .update(enableBankingConnections)
      .set({
        activeRunId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: input.now,
        lastFailureCategory: null,
      })
      .where(
        and(
          eq(enableBankingConnections.id, lease.connectionId),
          eq(enableBankingConnections.leaseId, lease.leaseId),
        ),
      );
  });
}

export async function failEnableBankingRun(
  db: Database,
  lease: EnableBankingDiagnosticLease | EnableBankingDisconnectLease,
  category: string,
  now: string,
  indeterminate = false,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(enableBankingRuns)
      .set({
        status: indeterminate ? 'indeterminate' : 'failed',
        completedAt: now,
        failureCategory: category,
      })
      .where(eq(enableBankingRuns.id, lease.runId));
    await tx
      .update(enableBankingConnections)
      .set({
        ...(indeterminate ? { status: 'error' } : {}),
        activeRunId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: now,
        lastFailureCategory: category,
      })
      .where(
        and(
          eq(enableBankingConnections.id, lease.connectionId),
          eq(enableBankingConnections.leaseId, lease.leaseId),
        ),
      );
  });
}

export async function transitionEnableBankingConnectionStatus(
  db: Database,
  ownerId: string,
  status: 'active' | 'reauth_required' | 'error' | 'revoked',
  now: string,
  category: string | null = null,
): Promise<void> {
  await db
    .update(enableBankingConnections)
    .set({ status, updatedAt: now, lastFailureCategory: category })
    .where(eq(enableBankingConnections.ownerId, ownerId));
}

export async function beginEnableBankingDisconnect(
  db: Database,
  ownerId: string,
  key: EnableBankingDataKey,
  now: string,
): Promise<EnableBankingDisconnectLease> {
  return db.transaction(async (tx) => {
    const connection = await tx.query.enableBankingConnections.findFirst({
      where: eq(enableBankingConnections.ownerId, ownerId),
    });
    if (
      connection === undefined ||
      connection.sessionIdCiphertext === null ||
      connection.sessionIdIv === null ||
      connection.sessionIdAuthTag === null ||
      connection.sessionGeneration === null
    ) {
      throw new DataInvariantError(
        'enable_banking.session_unavailable',
        'Enable Banking session is unavailable for disconnect.',
      );
    }
    if (
      connection.leaseId !== null &&
      connection.leaseExpiresAt !== null &&
      instant(connection.leaseExpiresAt).getTime() > instant(now).getTime()
    ) {
      throw new DataConflictError(
        'enable_banking.operation_in_progress',
        'An Enable Banking operation is already running.',
      );
    }
    const runId = generateUuidV7('enable-banking-disconnect-run');
    const leaseId = generateUuidV7('enable-banking-disconnect-lease');
    const leaseExpiresAt = new Date(
      instant(now).getTime() + FETCH_LEASE_MILLISECONDS,
    ).toISOString();
    await tx.insert(enableBankingRuns).values({
      id: runId,
      ownerId,
      connectionId: connection.id,
      kind: 'disconnect',
      status: 'running',
      sessionGeneration: connection.sessionGeneration,
      startedAt: now,
    });
    await tx
      .update(enableBankingConnections)
      .set({ activeRunId: runId, leaseId, leaseExpiresAt, updatedAt: now })
      .where(eq(enableBankingConnections.id, connection.id));
    return Object.freeze({
      runId,
      ownerId,
      connectionId: connection.id,
      leaseId,
      sessionId: decryptSessionValue(
        {
          ciphertext: connection.sessionIdCiphertext,
          iv: connection.sessionIdIv,
          authTag: connection.sessionIdAuthTag,
        },
        key,
        ownerId,
        connection.id,
        'session-id',
        connection.sessionGeneration,
      ),
    });
  });
}

export async function completeEnableBankingDisconnect(
  db: Database,
  lease: EnableBankingDisconnectLease,
  now: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(enableBankingProviderAccounts)
      .set({
        accountUidCiphertext: null,
        accountUidIv: null,
        accountUidAuthTag: null,
        sessionGeneration: null,
        updatedAt: now,
      })
      .where(eq(enableBankingProviderAccounts.connectionId, lease.connectionId));
    await tx
      .update(enableBankingConnections)
      .set({
        status: 'revoked',
        sessionIdCiphertext: null,
        sessionIdIv: null,
        sessionIdAuthTag: null,
        sessionGeneration: null,
        consentExpiresAt: null,
        activeRunId: null,
        leaseId: null,
        leaseExpiresAt: null,
        updatedAt: now,
        lastFailureCategory: null,
      })
      .where(
        and(
          eq(enableBankingConnections.id, lease.connectionId),
          eq(enableBankingConnections.leaseId, lease.leaseId),
        ),
      );
    await tx
      .update(enableBankingRuns)
      .set({ status: 'completed', completedAt: now, failureCategory: null })
      .where(eq(enableBankingRuns.id, lease.runId));
  });
}

export async function expireEnableBankingRawPayloads(db: Database, now: string): Promise<number> {
  const rows = await db
    .update(enableBankingRawReceipts)
    .set({ payloadCiphertext: null, payloadIv: null, payloadAuthTag: null })
    .where(
      and(
        lte(enableBankingRawReceipts.payloadExpiresAt, now),
        isNotNull(enableBankingRawReceipts.payloadCiphertext),
      ),
    )
    .returning({ id: enableBankingRawReceipts.id });
  return rows.length;
}

export async function markEnableBankingReceiptFailed(
  db: Database,
  receiptId: string,
  category: string,
  now: string,
): Promise<void> {
  await db
    .update(enableBankingRawReceipts)
    .set({ status: 'failed', failureCategory: category, processedAt: now })
    .where(
      and(
        eq(enableBankingRawReceipts.id, receiptId),
        eq(enableBankingRawReceipts.status, 'received'),
      ),
    );
}

export async function loadEnableBankingConnectionStatus(
  db: Database,
  ownerId: string,
): Promise<Readonly<{ status: string; consentExpiresAt: string | null }> | null> {
  const row = await db.query.enableBankingConnections.findFirst({
    where: eq(enableBankingConnections.ownerId, ownerId),
  });
  return row === undefined
    ? null
    : Object.freeze({ status: row.status, consentExpiresAt: row.consentExpiresAt });
}

export async function clearExpiredEnableBankingAuthorizationStates(
  db: Database,
  now: string,
): Promise<number> {
  const rows = await db
    .update(enableBankingAuthorizationAttempts)
    .set({ status: 'expired', completedAt: now, failureCategory: 'authorization_expired' })
    .where(
      and(
        eq(enableBankingAuthorizationAttempts.status, 'pending'),
        lte(enableBankingAuthorizationAttempts.expiresAt, now),
      ),
    )
    .returning({ id: enableBankingAuthorizationAttempts.id });
  return rows.length;
}

export async function listPendingEnableBankingReceiptsForOwner(
  db: Database,
  ownerId: string,
): Promise<readonly string[]> {
  const rows = await db
    .select({ id: enableBankingRawReceipts.id })
    .from(enableBankingRawReceipts)
    .where(
      and(
        eq(enableBankingRawReceipts.ownerId, ownerId),
        eq(enableBankingRawReceipts.status, 'received'),
      ),
    )
    .orderBy(asc(enableBankingRawReceipts.receivedAt), asc(enableBankingRawReceipts.id));
  return Object.freeze(rows.map((row) => row.id));
}
