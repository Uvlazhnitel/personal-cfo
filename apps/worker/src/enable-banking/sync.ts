import { createHash } from 'node:crypto';

import {
  appendEnableBankingCanonicalBatch,
  beginEnableBankingSync,
  completeEnableBankingSync,
  executeFinancialCommand,
  expireEnableBankingRawPayloads,
  failEnableBankingRun,
  finalizeEnableBankingReceipt,
  generateUuidV7,
  hashEnableBankingCursor,
  hashEnableBankingSourceKey,
  loadEffectiveMaterialityThresholdMinor,
  loadEnableBankingActivationReadiness,
  loadEnableBankingRunBookedDateRange,
  loadCurrentEnableBankingObservations,
  loadPendingEnableBankingReceipts,
  markEnableBankingReceiptFailed,
  persistEnableBankingRawReceipt,
  recordEnableBankingObservationMatch,
  renewEnableBankingLease,
  transitionEnableBankingConnectionStatus,
} from '@personal-cfo/data';
import type {
  Database,
  EnableBankingBalanceObservationInput,
  EnableBankingCanonicalObservation,
  EnableBankingRevisionInput,
  EnableBankingSyncLease,
  EnableBankingTransactionObservationInput,
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
  EnableBankingFetch,
  EnableBankingSleeper,
  EnableBankingSyncResult,
} from '@personal-cfo/integrations/open-banking/enable-banking';
import type { PgBoss } from 'pg-boss';

import type { EnableBankingConfiguration } from './config.js';
import {
  INITIAL_ENABLE_BANKING_CONTINUATION_STATE,
  assessEnableBankingContinuation,
} from './continuation.js';

type Counts = {
  pages: number;
  balances: number;
  transactions: number;
  new: number;
  replay: number;
  revision: number;
  quarantined: number;
  canonicalMutations: number;
};

export type EnableBankingSyncOptions = Readonly<{
  canonicalImportEnabled?: boolean;
  clock?: EnableBankingClock;
  sleeper?: EnableBankingSleeper;
  fetchImplementation?: EnableBankingFetch;
  signal?: AbortSignal;
}>;

const defaultSleeper: EnableBankingSleeper = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
      return;
    }
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
      },
      { once: true },
    );
  });

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function safeFailureCategory(error: unknown): string {
  if (error instanceof EnableBankingApiError) return `enable_banking_${error.category}`;
  if (error instanceof DataConflictError) return 'enable_banking_data_conflict';
  if (error instanceof DataInvariantError) return error.code;
  return 'enable_banking_sync_failed';
}

function providerAccount(lease: EnableBankingSyncLease): BankProviderAccount {
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

function dateAtNoonUtc(value: string): string {
  return parseInstant(`${value}T12:00:00.000Z`);
}

function rigaDate(value: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function balanceSourceAsOf(value: BankBalanceObservation, receivedAt: string): string {
  if (value.lastChangedAt !== null) return value.lastChangedAt;
  if (value.referenceDate !== null) return dateAtNoonUtc(value.referenceDate);
  return receivedAt;
}

function hashNullable(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return digest(['enable-banking-safe-evidence-v1', value]);
}

function ambiguityKind(
  observation: BankTransactionObservation,
): 'unclassified_external_flow' | 'unresolved_transfer' {
  const text = [
    observation.bankTransactionCode?.code,
    observation.bankTransactionCode?.subCode,
    observation.bankTransactionCode?.description,
    observation.counterpartyName,
    observation.referenceNumber,
    ...observation.remittance,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .normalize('NFKC')
    .toLocaleLowerCase('en');
  return /\b(atm|cash withdrawal|broker|investment|securities|transfer)\b/u.test(text)
    ? 'unresolved_transfer'
    : 'unclassified_external_flow';
}

export async function executeEnableBankingSync(
  db: Database,
  boss: PgBoss,
  configuration: EnableBankingConfiguration,
  options: EnableBankingSyncOptions = {},
): Promise<EnableBankingSyncResult> {
  const clock = options.clock ?? { now: () => new Date() };
  const startedAt = parseInstant(clock.now().toISOString());
  const lease = await beginEnableBankingSync(
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
    new: 0,
    replay: 0,
    revision: 0,
    quarantined: 0,
    canonicalMutations: 0,
  };
  let authoritativeBooked: BankBalanceObservation | null = null;
  let continuationKey = lease.continuationKey;
  let lastReceiptId: string | null = null;
  let lastBalanceReceivedAt: string = startedAt;
  let continuationState = INITIAL_ENABLE_BANKING_CONTINUATION_STATE;
  const sleeper = options.sleeper ?? defaultSleeper;

  const finalize = async (
    receipt: PersistedEnableBankingReceipt,
    input: Readonly<{
      status: 'normalized' | 'quarantined';
      revisions: readonly EnableBankingRevisionInput[];
      transactions?: readonly EnableBankingTransactionObservationInput[];
      balances?: readonly EnableBankingBalanceObservationInput[];
      responseCursor?: string | null;
      advanceContinuation?: boolean;
      failureCategory?: string | null;
    }>,
  ): Promise<void> => {
    const dispositions = await finalizeEnableBankingReceipt(db, run, configuration.dataKey, {
      receiptId: receipt.id,
      status: input.status,
      revisions: input.revisions,
      transactionObservations: input.transactions ?? [],
      balanceObservations: input.balances ?? [],
      responseCursor: input.responseCursor ?? null,
      advanceContinuation: input.advanceContinuation ?? false,
      failureCategory: input.failureCategory ?? null,
      now: receipt.receivedAt,
    });
    for (const disposition of dispositions) counts[disposition.disposition] += 1;
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
        new Date(session.validUntil).getTime() <= new Date(receipt.receivedAt).getTime() ||
        session.accountAliases.filter(
          (alias) =>
            alias.uid === lease.accountUid && alias.identificationHash === lease.identificationHash,
        ).length !== 1
      ) {
        throw new DataInvariantError(
          'enable_banking.session_account_mismatch',
          'The active session does not contain the bound account identity.',
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
          'Account details crossed the bound EUR account identity.',
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
            revisionSha256: digest([
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
      authoritativeBooked = normalized.authoritativeBooked;
      lastBalanceReceivedAt = receipt.receivedAt;
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
        balances: normalized.balances.map((balance) => ({
          id: generateUuidV7('enable-banking-balance-observation'),
          providerAccountId: lease.providerAccountId,
          revisionSha256: balance.revision.fingerprint,
          balanceKind: balance.kind,
          amountMinor: balance.amount.amountMinor,
          currency: balance.amount.currency,
          sourceAsOf: balanceSourceAsOf(balance, receipt.receivedAt),
        })),
      });
      return false;
    }
    if (receipt.endpoint === 'transactions') {
      const page = decodeEnableBankingTransactions(receipt.payload);
      counts.pages += 1;
      counts.transactions += page.transactions.length;
      const continuation = assessEnableBankingContinuation(continuationState, {
        requestCursorHash: receipt.requestCursorHash,
        responseCursorHash:
          page.continuationKey === null ? null : hashEnableBankingCursor(page.continuationKey),
        transactionCount: page.transactions.length,
      });
      const revisions: EnableBankingRevisionInput[] = [];
      const observations: EnableBankingTransactionObservationInput[] = [];
      let quarantined = false;
      for (const value of page.transactions) {
        const normalized = normalizeEnableBankingTransaction(value, account);
        if (normalized.status === 'quarantined') {
          counts.quarantined += 1;
          quarantined = true;
        }
        const observation = normalized.observation;
        if (observation === null) continue;
        const id = generateUuidV7('enable-banking-transaction-observation');
        const sourceKey =
          observation.sourceId === null
            ? null
            : hashEnableBankingSourceKey(lease.ownerId, lease.connectionId, observation.sourceId);
        if (sourceKey !== null) {
          revisions.push({
            providerAccountId: lease.providerAccountId,
            sourceKey,
            revisionSha256: observation.revision.fingerprint,
            recordKind: 'transaction',
            providerStatus: observation.status,
          });
        }
        observations.push({
          id,
          providerAccountId: lease.providerAccountId,
          sourceKey,
          revisionSha256: observation.revision.fingerprint,
          providerStatus: observation.status,
          direction: observation.direction,
          amountMinor: observation.amount.amountMinor,
          currency: observation.amount.currency,
          bookingDate: observation.bookingDate,
          valueDate: observation.valueDate,
          transactionDate: observation.transactionDate,
          bankCodeHash: hashNullable(observation.bankTransactionCode),
          counterpartyHash: hashNullable([
            observation.counterpartyName,
            observation.counterpartyAccountHint,
          ]),
          referenceHash: hashNullable([observation.referenceNumber, observation.remittance]),
          canonicalization: observation.canonicalization,
          ambiguityKind: ambiguityKind(observation),
        });
      }
      await finalize(receipt, {
        status: quarantined ? 'quarantined' : 'normalized',
        revisions,
        transactions: observations,
        responseCursor: page.continuationKey,
        advanceContinuation: true,
        failureCategory: quarantined ? 'enable_banking_transaction_quarantined' : null,
      });
      continuationState = continuation.state;
      if (continuation.waitMilliseconds > 0) {
        await sleeper(continuation.waitMilliseconds, options.signal);
      }
      return page.continuationKey !== null;
    }
    throw new DataInvariantError(
      'enable_banking.unexpected_receipt',
      'Sync run contains an unexpected receipt.',
    );
  };

  try {
    await expireEnableBankingRawPayloads(db, startedAt);
    for (const receipt of await loadPendingEnableBankingReceipts(db, run, configuration.dataKey)) {
      await processReceipt(receipt);
    }
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
      requestCursor: string | null,
    ): Promise<boolean> => {
      if (response.receiptId === null) throw new Error('Enable Banking receipt sink was not used.');
      return processReceipt({
        id: response.receiptId,
        runId: lease.runId,
        endpoint,
        method: 'GET',
        requestKey: endpoint,
        requestCursorHash: requestCursor === null ? null : hashEnableBankingCursor(requestCursor),
        httpStatus: response.status,
        receivedAt: response.receivedAt,
        payloadSha256: '',
        payload: response.body,
      });
    };
    await consume(await client.getSession(lease.sessionId, options.signal), 'session', null);
    await consume(await client.getBalances(lease.accountUid, options.signal), 'balances', null);
    let hasMore = true;
    while (hasMore) {
      await renewEnableBankingLease(db, lease, parseInstant(clock.now().toISOString()));
      const requestCursor = continuationKey;
      const page = await client.getTransactions({
        accountUid: lease.accountUid,
        continuationKey: requestCursor,
        strategy: lease.strategy,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      hasMore = await consume(page, 'transactions', requestCursor);
    }

    const records = await loadCurrentEnableBankingObservations(
      db,
      lease.ownerId,
      lease.connectionId,
    );
    const runCoverage = await loadEnableBankingRunBookedDateRange(db, lease);
    const scanCompletedAt = parseInstant(clock.now().toISOString());
    const coverageFrom = runCoverage?.from ?? null;
    const coverageThrough = runCoverage === null ? null : rigaDate(scanCompletedAt);
    const pending = records.filter(
      (observation) =>
        observation.providerStatus === 'pending' || observation.providerStatus === 'hold',
    );
    const booked = records.filter((observation) => observation.providerStatus === 'booked');
    for (const left of pending) {
      for (const right of booked) {
        const leftDate = left.bookingDate ?? left.valueDate ?? left.transactionDate;
        const rightDate = right.bookingDate ?? right.valueDate ?? right.transactionDate;
        const distance =
          leftDate === null || rightDate === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(
                new Date(`${leftDate}T00:00:00Z`).getTime() -
                  new Date(`${rightDate}T00:00:00Z`).getTime(),
              ) / 86_400_000;
        const compatible =
          left.sourceKey !== right.sourceKey &&
          left.direction === right.direction &&
          left.amountMinor === right.amountMinor &&
          left.currency === right.currency &&
          distance <= 7 &&
          (left.bankCodeHash === null ||
            right.bankCodeHash === null ||
            left.bankCodeHash === right.bankCodeHash) &&
          (left.counterpartyHash === null ||
            right.counterpartyHash === null ||
            left.counterpartyHash === right.counterpartyHash) &&
          (left.referenceHash === null ||
            right.referenceHash === null ||
            left.referenceHash === right.referenceHash);
        if (compatible) {
          await recordEnableBankingObservationMatch(db, {
            ownerId: lease.ownerId,
            connectionId: lease.connectionId,
            leftObservationId: left.id,
            rightObservationId: right.id,
            kind: 'pending_booked',
            state: 'candidate',
            reason: 'changed provider identity requires owner review',
            now: parseInstant(clock.now().toISOString()),
          });
        }
      }
    }

    const activation = await loadEnableBankingActivationReadiness(
      db,
      lease.ownerId,
      options.canonicalImportEnabled ?? false,
    );
    let reconciliationStatus: EnableBankingSyncResult['reconciliationStatus'] = 'unavailable';
    const bookedBalance = authoritativeBooked as BankBalanceObservation | null;
    if (activation.allowed) {
      const threshold = await loadEffectiveMaterialityThresholdMinor(db, lease.ownerId);
      const canonical: EnableBankingCanonicalObservation[] = records
        .filter((observation) => observation.sourceKey !== null)
        .filter((observation) =>
          ['booked', 'cancelled', 'rejected'].includes(observation.providerStatus),
        )
        .map((observation) => {
          const date =
            observation.bookingDate ?? observation.valueDate ?? observation.transactionDate;
          if (date === null || observation.sourceKey === null) {
            throw new DataInvariantError(
              'enable_banking.missing_effective_date',
              'Canonical booked observation requires an economic date.',
            );
          }
          const absolute =
            observation.amountMinor < 0n ? -observation.amountMinor : observation.amountMinor;
          return Object.freeze({
            sourceKey: observation.sourceKey,
            revisionSha256: observation.revisionSha256,
            providerStatus: observation.providerStatus,
            amountMinor: observation.amountMinor,
            currency: observation.currency,
            effectiveAt: dateAtNoonUtc(date),
            ambiguityKind:
              observation.ambiguityKind as EnableBankingCanonicalObservation['ambiguityKind'],
            materiality: absolute >= threshold ? ('material' as const) : ('non_material' as const),
          });
        });
      const sourceAsOf =
        bookedBalance === null
          ? startedAt
          : balanceSourceAsOf(bookedBalance, lastBalanceReceivedAt);
      const unresolvedPending = pending.length > 0;
      const historyComplete = coverageFrom !== null && coverageThrough !== null;
      const providerStale =
        bookedBalance !== null &&
        new Date(sourceAsOf).getTime() < new Date(startedAt).getTime() - 48 * 60 * 60_000;
      const commandNow = parseInstant(clock.now().toISOString());
      const command = await executeFinancialCommand(
        db,
        boss,
        {
          ownerId: lease.ownerId,
          kind: 'bank_sync',
          idempotencyKey: `enable-banking:${lease.runId}:canonical`,
          request: {
            runId: lease.runId,
            revisionIds: canonical.map((item) => item.revisionSha256),
            balanceRevision: bookedBalance?.revision.fingerprint ?? null,
          },
          asOf: commandNow,
          effectiveDate: rigaDate(commandNow),
          now: commandNow,
        },
        (tx, commandId) =>
          appendEnableBankingCanonicalBatch(tx, {
            ownerId: lease.ownerId,
            connectionId: lease.connectionId,
            canonicalAccountId: lease.canonicalAccountId,
            commandId,
            observations: canonical,
            balance:
              bookedBalance === null
                ? null
                : {
                    sourceAsOf,
                    receivedAt: lastBalanceReceivedAt,
                    staleAt: new Date(
                      new Date(sourceAsOf).getTime() + 48 * 60 * 60_000,
                    ).toISOString(),
                    amountMinor: bookedBalance.amount.amountMinor,
                    historyComplete,
                    unresolvedPending,
                    providerStale,
                    materialityThresholdMinor: threshold,
                    runId: lease.runId,
                    providerAccountId: lease.providerAccountId,
                  },
            now: commandNow,
          }),
      );
      const mutationCount = command.result['mutationCount'];
      counts.canonicalMutations = typeof mutationCount === 'number' ? mutationCount : 0;
      const persistedStatus = command.result['reconciliationStatus'];
      reconciliationStatus =
        persistedStatus === 'reconciled' ||
        persistedStatus === 'provider_stale' ||
        persistedStatus === 'incomplete_history' ||
        persistedStatus === 'unresolved_pending' ||
        persistedStatus === 'material_mismatch'
          ? persistedStatus
          : 'unavailable';
    }
    const completedAt = parseInstant(clock.now().toISOString());
    await completeEnableBankingSync(db, lease, {
      counts,
      coverageFrom,
      coverageThrough,
      now: completedAt,
    });
    return Object.freeze({
      runId: lease.runId,
      strategy: lease.strategy,
      completionStatus: activation.allowed ? ('completed' as const) : ('evidence_only' as const),
      activation,
      counts: Object.freeze({ ...counts }),
      coverage: Object.freeze({
        status:
          coverageFrom === null || coverageThrough === null
            ? ('unavailable' as const)
            : ('complete' as const),
        from: coverageFrom,
        through: coverageThrough,
      }),
      reconciliationStatus,
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
    await failEnableBankingRun(db, lease, category, failedAt).catch(() => undefined);
    throw error;
  }
}
