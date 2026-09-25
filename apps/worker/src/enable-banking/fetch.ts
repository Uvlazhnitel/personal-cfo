import { createHash } from 'node:crypto';

import {
  beginEnableBankingDiagnosticFetch,
  completeEnableBankingDiagnosticFetch,
  expireEnableBankingRawPayloads,
  failEnableBankingRun,
  finalizeEnableBankingReceipt,
  hashEnableBankingCursor,
  hashEnableBankingSourceKey,
  loadPendingEnableBankingReceipts,
  markEnableBankingReceiptFailed,
  persistEnableBankingRawReceipt,
  renewEnableBankingLease,
  transitionEnableBankingConnectionStatus,
} from '@personal-cfo/data';
import type {
  Database,
  EnableBankingDiagnosticLease,
  EnableBankingRevisionInput,
  PersistedEnableBankingReceipt,
} from '@personal-cfo/data';
import { DataConflictError, DataInvariantError } from '@personal-cfo/data';
import { EUR, parseInstant } from '@personal-cfo/domain';
import type {
  BankBalanceObservation,
  BankProviderAccount,
  BankTransactionObservation,
} from '@personal-cfo/domain';
import {
  ENABLE_BANKING_ASPSP,
  ENABLE_BANKING_NORMALIZATION_VERSION,
  EnableBankingApiClient,
  EnableBankingApiError,
  decodeEnableBankingAccountDetails,
  decodeEnableBankingBalances,
  decodeEnableBankingSession,
  decodeEnableBankingTransactions,
  normalizeEnableBankingBalances,
  normalizeEnableBankingTransaction,
} from '@personal-cfo/integrations/open-banking/enable-banking';
import type {
  EnableBankingClock,
  EnableBankingDiagnosticFetchResult,
  EnableBankingFetch,
  EnableBankingSleeper,
} from '@personal-cfo/integrations/open-banking/enable-banking';

import type { EnableBankingConfiguration } from './config.js';

type Counts = {
  pages: number;
  balances: number;
  transactions: number;
  normalized: number;
  quarantined: number;
  new: number;
  replay: number;
  revision: number;
};

export type EnableBankingFetchOptions = Readonly<{
  clock?: EnableBankingClock;
  sleeper?: EnableBankingSleeper;
  fetchImplementation?: EnableBankingFetch;
  signal?: AbortSignal;
}>;

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof EnableBankingApiError) return `enable_banking_${error.category}`;
  if (error instanceof DataConflictError) return 'enable_banking_data_conflict';
  if (error instanceof DataInvariantError) return error.code;
  return 'enable_banking_diagnostic_fetch_failed';
}

function addDispositions(
  counts: Counts,
  dispositions: readonly Readonly<{ disposition: 'new' | 'replay' | 'revision' }>[],
): void {
  for (const disposition of dispositions) counts[disposition.disposition] += 1;
}

function providerAccount(lease: EnableBankingDiagnosticLease): BankProviderAccount {
  return Object.freeze({
    authority: 'provider_account_observation',
    connection: Object.freeze({
      provider: 'enable-banking',
      connectionId: lease.connectionId,
      generation: lease.connectionGeneration,
    }),
    accountId: lease.canonicalAccountId as never,
    providerAccountUid: lease.accountUid,
    stableAccountIdentity: lease.identificationHash,
    currency: EUR,
  });
}

function transactionDate(item: BankTransactionObservation): string | null {
  return item.bookingDate ?? item.valueDate ?? item.transactionDate;
}

export async function executeEnableBankingDiagnosticFetch(
  db: Database,
  configuration: EnableBankingConfiguration,
  options: EnableBankingFetchOptions = {},
): Promise<EnableBankingDiagnosticFetchResult> {
  const clock = options.clock ?? { now: () => new Date() };
  const startedAt = parseInstant(clock.now().toISOString());
  const lease = await beginEnableBankingDiagnosticFetch(
    db,
    configuration.ownerId,
    configuration.dataKey,
    startedAt,
  );
  const run = Object.freeze({
    runId: lease.runId,
    ownerId: lease.ownerId,
    connectionId: lease.connectionId,
  });
  const account = providerAccount(lease);
  const counts: Counts = {
    pages: 0,
    balances: 0,
    transactions: 0,
    normalized: 0,
    quarantined: 0,
    new: 0,
    replay: 0,
    revision: 0,
  };
  const balancesByRevision = new Map<string, BankBalanceObservation>();
  const transactionsByRevision = new Map<string, BankTransactionObservation>();
  let authoritativeBooked: BankBalanceObservation | null = null;
  let continuationKey = lease.continuationKey;
  let lastReceiptId: string | null = null;
  let coverageFrom: string | null = null;
  let coverageThrough: string | null = null;

  const finalize = async (
    receipt: PersistedEnableBankingReceipt,
    input: Readonly<{
      status: 'normalized' | 'quarantined';
      revisions: readonly EnableBankingRevisionInput[];
      responseCursor?: string | null;
      advanceContinuation?: boolean;
      failureCategory?: string | null;
    }>,
  ): Promise<void> => {
    const dispositions = await finalizeEnableBankingReceipt(db, run, configuration.dataKey, {
      receiptId: receipt.id,
      status: input.status,
      revisions: input.revisions,
      responseCursor: input.responseCursor ?? null,
      advanceContinuation: input.advanceContinuation ?? false,
      failureCategory: input.failureCategory ?? null,
      now: receipt.receivedAt,
    });
    addDispositions(counts, dispositions);
    if (input.advanceContinuation === true) continuationKey = input.responseCursor ?? null;
  };

  const processReceipt = async (receipt: PersistedEnableBankingReceipt): Promise<boolean> => {
    lastReceiptId = receipt.id;
    if (receipt.httpStatus < 200 || receipt.httpStatus >= 300) {
      await markEnableBankingReceiptFailed(
        db,
        receipt.id,
        'enable_banking_provider_error_response',
        receipt.receivedAt,
      );
      return false;
    }
    if (receipt.endpoint === 'session') {
      const session = decodeEnableBankingSession(receipt.payload);
      if (
        session.aspsp.name !== ENABLE_BANKING_ASPSP.name ||
        session.aspsp.country !== ENABLE_BANKING_ASPSP.country ||
        session.psuType !== 'personal'
      ) {
        throw new DataInvariantError(
          'enable_banking.session_identity_mismatch',
          'Session does not belong to personal Swedbank Latvia access.',
        );
      }
      if (session.status === 'EXPIRED') {
        await transitionEnableBankingConnectionStatus(
          db,
          lease.ownerId,
          'reauth_required',
          receipt.receivedAt,
          'enable_banking_session_expired',
        );
        throw new DataInvariantError(
          'enable_banking.session_expired',
          'Enable Banking session requires reauthorization.',
        );
      }
      if (session.status === 'REVOKED' || session.status === 'CLOSED') {
        await transitionEnableBankingConnectionStatus(
          db,
          lease.ownerId,
          'revoked',
          receipt.receivedAt,
          'enable_banking_session_revoked',
        );
        throw new DataInvariantError(
          'enable_banking.session_revoked',
          'Enable Banking session is revoked.',
        );
      }
      if (
        session.status !== 'AUTHORIZED' ||
        new Date(session.validUntil).getTime() <= new Date(receipt.receivedAt).getTime()
      ) {
        throw new DataInvariantError(
          'enable_banking.session_not_authorized',
          'Enable Banking session is not authorized.',
        );
      }
      const matching = session.accountAliases.filter(
        (alias) =>
          alias.uid === lease.accountUid && alias.identificationHash === lease.identificationHash,
      );
      if (matching.length !== 1) {
        throw new DataInvariantError(
          'enable_banking.session_account_mismatch',
          'Bound account is not uniquely present in the active session.',
        );
      }
      await finalize(receipt, { status: 'normalized', revisions: [] });
      return false;
    }
    if (receipt.endpoint === 'account_details') {
      const details = decodeEnableBankingAccountDetails(receipt.payload);
      if (
        details.uid !== lease.accountUid ||
        details.identificationHash !== lease.identificationHash ||
        details.currency !== 'EUR'
      ) {
        throw new DataInvariantError(
          'enable_banking.account_identity_mismatch',
          'Account details crossed the bound account identity.',
        );
      }
      await finalize(receipt, {
        status: 'normalized',
        revisions: [
          {
            providerAccountId: lease.providerAccountId,
            sourceKey: hashEnableBankingSourceKey(
              lease.ownerId,
              lease.connectionId,
              `account:${details.identificationHash}`,
            ),
            revisionSha256: sha256([
              'enable-banking-account-v1',
              details.identificationHash,
              details.currency,
              details.usage,
              details.cashAccountType,
            ]),
            recordKind: 'account',
            providerStatus: null,
          },
        ],
      });
      return false;
    }
    if (receipt.endpoint === 'balances') {
      const normalized = normalizeEnableBankingBalances(
        decodeEnableBankingBalances(receipt.payload),
        account,
      );
      counts.balances += normalized.balances.length;
      for (const balance of normalized.balances) {
        balancesByRevision.set(balance.revision.fingerprint, balance);
      }
      if (normalized.authoritativeBooked !== null) {
        authoritativeBooked = normalized.authoritativeBooked;
      }
      await finalize(receipt, {
        status: 'normalized',
        revisions: normalized.balances.map((balance) => ({
          providerAccountId: lease.providerAccountId,
          sourceKey: hashEnableBankingSourceKey(
            lease.ownerId,
            lease.connectionId,
            balance.revision.sourceId ?? balance.revision.fingerprint,
          ),
          revisionSha256: balance.revision.fingerprint,
          recordKind: 'balance',
          providerStatus: balance.kind,
        })),
      });
      return false;
    }
    if (receipt.endpoint === 'transactions') {
      const page = decodeEnableBankingTransactions(receipt.payload);
      counts.pages += 1;
      counts.transactions += page.transactions.length;
      if (
        page.continuationKey !== null &&
        receipt.requestCursorHash !== null &&
        hashEnableBankingCursor(page.continuationKey) === receipt.requestCursorHash
      ) {
        throw new DataInvariantError(
          'enable_banking.non_advancing_continuation',
          'Enable Banking continuation key did not advance.',
        );
      }
      const revisions: EnableBankingRevisionInput[] = [];
      let quarantined = false;
      for (const providerTransaction of page.transactions) {
        const normalized = normalizeEnableBankingTransaction(providerTransaction, account);
        if (normalized.status === 'quarantined') {
          counts.quarantined += 1;
          quarantined = true;
          if (normalized.observation !== null) {
            transactionsByRevision.set(
              normalized.observation.revision.fingerprint,
              normalized.observation,
            );
          }
          continue;
        }
        counts.normalized += 1;
        const observation = normalized.observation;
        transactionsByRevision.set(observation.revision.fingerprint, observation);
        const economicDate = transactionDate(observation);
        if (observation.status === 'booked' && economicDate !== null) {
          coverageFrom =
            coverageFrom === null || economicDate < coverageFrom ? economicDate : coverageFrom;
          coverageThrough =
            coverageThrough === null || economicDate > coverageThrough
              ? economicDate
              : coverageThrough;
        }
        if (observation.sourceId !== null) {
          revisions.push({
            providerAccountId: lease.providerAccountId,
            sourceKey: hashEnableBankingSourceKey(
              lease.ownerId,
              lease.connectionId,
              observation.sourceId,
            ),
            revisionSha256: observation.revision.fingerprint,
            recordKind: 'transaction',
            providerStatus: observation.status,
          });
        }
      }
      await finalize(receipt, {
        status: quarantined ? 'quarantined' : 'normalized',
        revisions,
        responseCursor: page.continuationKey,
        advanceContinuation: true,
        failureCategory: quarantined ? 'enable_banking_transaction_quarantined' : null,
      });
      return page.continuationKey !== null;
    }
    throw new DataInvariantError(
      'enable_banking.unexpected_receipt',
      'Diagnostic run contains an unexpected receipt.',
    );
  };

  try {
    await expireEnableBankingRawPayloads(db, startedAt);
    const pending = await loadPendingEnableBankingReceipts(db, run, configuration.dataKey);
    for (const receipt of pending) await processReceipt(receipt);

    const client = new EnableBankingApiClient({
      applicationId: configuration.applicationId,
      privateKeyPem: configuration.privateKeyPem,
      baseUrl: configuration.baseUrl,
      clock,
      ...(options.fetchImplementation === undefined
        ? {}
        : { fetchImplementation: options.fetchImplementation }),
      ...(options.sleeper === undefined ? {} : { sleeper: options.sleeper }),
      responseSink: async (response) => {
        const persisted = await persistEnableBankingRawReceipt(db, run, configuration.dataKey, {
          endpoint: response.endpoint,
          method: response.method,
          requestKey: response.endpoint,
          requestCursor: response.requestCursor,
          httpStatus: response.status,
          receivedAt: response.receivedAt,
          payload: response.body,
          normalizationVersion: ENABLE_BANKING_NORMALIZATION_VERSION,
        });
        lastReceiptId = persisted.id;
        return persisted.id;
      },
      responseFailureSink: async (receiptId, category, receivedAt) =>
        markEnableBankingReceiptFailed(db, receiptId, `enable_banking_${category}`, receivedAt),
    });

    const consume = async (
      response: Readonly<{
        receiptId: string | null;
        body: string;
        receivedAt: string;
        status: number;
      }>,
      endpoint: PersistedEnableBankingReceipt['endpoint'],
      method: PersistedEnableBankingReceipt['method'],
      requestCursor: string | null,
    ): Promise<boolean> => {
      if (response.receiptId === null) throw new Error('Enable Banking receipt sink was not used.');
      return processReceipt({
        id: response.receiptId,
        runId: lease.runId,
        endpoint,
        method,
        requestKey: endpoint,
        requestCursorHash: requestCursor === null ? null : hashEnableBankingCursor(requestCursor),
        httpStatus: response.status,
        receivedAt: response.receivedAt,
        payloadSha256: '',
        payload: response.body,
      });
    };

    const session = await client.getSession(lease.sessionId, options.signal);
    await consume(session, 'session', 'GET', null);
    const details = await client.getAccountDetails(lease.accountUid, options.signal);
    await consume(details, 'account_details', 'GET', null);
    const balances = await client.getBalances(lease.accountUid, options.signal);
    await consume(balances, 'balances', 'GET', null);

    let hasMore = true;
    while (hasMore) {
      await renewEnableBankingLease(db, lease, parseInstant(clock.now().toISOString()));
      const requestCursor = continuationKey;
      const page = await client.getTransactions({
        accountUid: lease.accountUid,
        continuationKey: requestCursor,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      hasMore = await consume(page, 'transactions', 'GET', requestCursor);
    }

    const completedAt = parseInstant(clock.now().toISOString());
    await completeEnableBankingDiagnosticFetch(db, lease, {
      counts,
      coverageFrom,
      coverageThrough,
      now: completedAt,
    });
    const balanceKinds: Record<string, number> = {};
    for (const balance of balancesByRevision.values()) {
      balanceKinds[balance.kind] = (balanceKinds[balance.kind] ?? 0) + 1;
    }
    const transactionStatuses: Record<string, number> = {};
    for (const transaction of transactionsByRevision.values()) {
      transactionStatuses[transaction.status] = (transactionStatuses[transaction.status] ?? 0) + 1;
    }
    const coveragePresent = coverageFrom !== null && coverageThrough !== null;
    return Object.freeze({
      counts: Object.freeze({ ...counts }),
      balanceKinds: Object.freeze(balanceKinds),
      transactionStatuses: Object.freeze(transactionStatuses),
      coverage: Object.freeze({
        status: coveragePresent ? ('complete' as const) : ('unavailable' as const),
        present: coveragePresent,
      }),
      authoritativeBookedPresent: authoritativeBooked !== null,
      confirmedPrincipalsCreated: 0 as const,
    });
  } catch (error) {
    const category = safeFailureCategory(error);
    const failedAt = parseInstant(clock.now().toISOString());
    if (lastReceiptId !== null) {
      await markEnableBankingReceiptFailed(db, lastReceiptId, category, failedAt).catch(
        () => undefined,
      );
    }
    await failEnableBankingRun(
      db,
      lease,
      category,
      failedAt,
      error instanceof EnableBankingApiError && error.category === 'indeterminate_mutation',
    ).catch(() => undefined);
    throw error;
  }
}
