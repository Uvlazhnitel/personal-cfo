import {
  activateEnableBankingCanonicalImport,
  activateEnableBankingSession,
  beginEnableBankingAuthorization,
  beginEnableBankingDisconnect,
  bindEnableBankingProviderAccount,
  cancelEnableBankingAuthorization,
  claimEnableBankingAuthorization,
  completeEnableBankingDisconnect,
  failEnableBankingAuthorization,
  failEnableBankingRun,
  finalizeEnableBankingReceipt,
  hashEnableBankingApplicationId,
  listEnableBankingDiscoveredAccounts,
  markEnableBankingAuthorizationStarted,
  markEnableBankingReceiptFailed,
  persistEnableBankingRawReceipt,
} from '@personal-cfo/data';
import type {
  ClaimedEnableBankingAuthorization,
  EnableBankingAuthorization,
  EnableBankingDataKey,
  EnableBankingDisconnectLease,
  EnableBankingRunContext,
} from '@personal-cfo/data';
import {
  ENABLE_BANKING_ASPSP,
  ENABLE_BANKING_NORMALIZATION_VERSION,
  EnableBankingApiClient,
  EnableBankingApiError,
  assertEnableBankingSessionBinding,
} from '@personal-cfo/integrations/open-banking/enable-banking';
import type { EnableBankingRawResponseSink } from '@personal-cfo/integrations/open-banking/enable-banking';

import { databaseContext } from './database.js';
import {
  enableBankingWebConfiguration,
  type EnableBankingWebConfiguration,
} from './enable-banking-config.js';

const CONSENT_TRANSPORT_MARGIN_MILLISECONDS = 60_000;

function nowInstant(): string {
  return new Date().toISOString();
}

function safeCategory(error: unknown): string {
  return error instanceof EnableBankingApiError
    ? `enable_banking_${error.category}`
    : 'enable_banking_operation_failed';
}

function responseSink(
  run: EnableBankingRunContext,
  key: EnableBankingDataKey,
): EnableBankingRawResponseSink {
  return async (response) =>
    (
      await persistEnableBankingRawReceipt(databaseContext().db, run, key, {
        endpoint: response.endpoint,
        method: response.method,
        requestKey: response.endpoint,
        requestCursor: response.requestCursor,
        httpStatus: response.status,
        receivedAt: response.receivedAt,
        payload: response.body,
        normalizationVersion: ENABLE_BANKING_NORMALIZATION_VERSION,
      })
    ).id;
}

function client(
  configuration: EnableBankingWebConfiguration,
  run: EnableBankingRunContext,
): EnableBankingApiClient {
  return new EnableBankingApiClient({
    applicationId: configuration.applicationId,
    privateKeyPem: configuration.privateKeyPem,
    baseUrl: configuration.baseUrl,
    responseSink: responseSink(run, configuration.dataKey),
    responseFailureSink: (receiptId, category, receivedAt): Promise<void> =>
      markEnableBankingReceiptFailed(
        databaseContext().db,
        receiptId,
        `enable_banking_${category}`,
        receivedAt,
      ),
  });
}

async function finishReceipt(
  run: EnableBankingRunContext,
  key: EnableBankingDataKey,
  receiptId: string | null,
): Promise<void> {
  if (receiptId === null) return;
  await finalizeEnableBankingReceipt(databaseContext().db, run, key, {
    receiptId,
    status: 'normalized',
    revisions: [],
    responseCursor: null,
    advanceContinuation: false,
    now: nowInstant(),
  });
}

function authorizationValidity(now: Date, maximumSeconds: number): string {
  const milliseconds = maximumSeconds * 1_000 - CONSENT_TRANSPORT_MARGIN_MILLISECONDS;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error('Enable Banking consent validity is too short.');
  }
  return new Date(now.getTime() + milliseconds).toISOString();
}

export async function startEnableBankingAuthorization(ownerId: string): Promise<string> {
  const configuration = await enableBankingWebConfiguration();
  if (ownerId !== configuration.ownerId) throw new Error('Enable Banking owner is not configured.');
  const authorization = await beginEnableBankingAuthorization(databaseContext().db, {
    ownerId,
    applicationIdHash: hashEnableBankingApplicationId(configuration.applicationId),
    now: nowInstant(),
  });
  try {
    const api = client(configuration, authorization);
    const directory = await api.listAspsps();
    await finishReceipt(authorization, configuration.dataKey, directory.receiptId);
    const matches = directory.value.aspsps.filter(
      (aspsp) =>
        aspsp.name === ENABLE_BANKING_ASPSP.name &&
        aspsp.country === ENABLE_BANKING_ASPSP.country &&
        aspsp.psuTypes.includes('personal'),
    );
    if (matches.length !== 1) throw new Error('Exactly one Swedbank Latvia ASPSP is required.');
    const started = await api.startAuthorization({
      state: authorization.state,
      redirectUrl: configuration.redirectUrl,
      validUntil: authorizationValidity(new Date(), matches[0]!.maximumConsentValiditySeconds),
    });
    await finishReceipt(authorization, configuration.dataKey, started.receiptId);
    await markEnableBankingAuthorizationStarted(databaseContext().db, authorization);
    return started.value.url;
  } catch (error) {
    const status =
      error instanceof EnableBankingApiError && error.category === 'indeterminate_mutation'
        ? 'indeterminate'
        : 'failed';
    await failEnableBankingAuthorization(
      databaseContext().db,
      authorization,
      status,
      safeCategory(error),
      nowInstant(),
    );
    throw error;
  }
}

export async function cancelEnableBankingCallback(state: string): Promise<void> {
  await cancelEnableBankingAuthorization(
    databaseContext().db,
    state,
    nowInstant(),
    'authorization_cancelled',
  );
}

export async function completeEnableBankingCallback(state: string, code: string): Promise<void> {
  const configuration = await enableBankingWebConfiguration();
  const authorization = await claimEnableBankingAuthorization(
    databaseContext().db,
    state,
    nowInstant(),
  );
  if (authorization.ownerId !== configuration.ownerId) {
    await failEnableBankingAuthorization(
      databaseContext().db,
      authorization,
      'failed',
      'enable_banking_owner_mismatch',
      nowInstant(),
    );
    throw new Error('Enable Banking owner does not match authorization state.');
  }
  try {
    const api = client(configuration, authorization);
    const exchanged = await api.authorizeSession({ code });
    const session = assertEnableBankingSessionBinding(exchanged.value);
    await finishReceipt(authorization, configuration.dataKey, exchanged.receiptId);
    const accounts = [];
    for (const account of session.accounts) {
      const details = await api.getAccountDetails(account.uid);
      if (
        details.value.uid !== account.uid ||
        details.value.identificationHash !== account.identificationHash
      ) {
        throw new Error('Enable Banking account detail identity does not match the session.');
      }
      await finishReceipt(authorization, configuration.dataKey, details.receiptId);
      accounts.push({
        uid: account.uid,
        identificationHash: account.identificationHash,
        currency: account.currency,
        displayHint: details.value.accountHint ?? details.value.displayName,
      });
    }
    await activateEnableBankingSession(databaseContext().db, authorization, configuration.dataKey, {
      sessionId: session.sessionId,
      validUntil: session.validUntil,
      accounts,
      now: nowInstant(),
    });
  } catch (error) {
    await failEnableBankingAuthorization(
      databaseContext().db,
      authorization,
      error instanceof EnableBankingApiError && error.category === 'indeterminate_mutation'
        ? 'indeterminate'
        : 'failed',
      safeCategory(error),
      nowInstant(),
    );
    throw error;
  }
}

export async function getEnableBankingAccounts(ownerId: string) {
  const configuration = await enableBankingWebConfiguration();
  if (ownerId !== configuration.ownerId) throw new Error('Enable Banking owner is not configured.');
  return listEnableBankingDiscoveredAccounts(databaseContext().db, ownerId, configuration.dataKey);
}

export async function bindEnableBankingAccount(
  ownerId: string,
  providerAccountId: string,
  canonicalAccountId: string,
): Promise<void> {
  const configuration = await enableBankingWebConfiguration();
  if (ownerId !== configuration.ownerId) throw new Error('Enable Banking owner is not configured.');
  await bindEnableBankingProviderAccount(databaseContext().db, {
    ownerId,
    providerAccountId,
    canonicalAccountId,
    now: nowInstant(),
  });
}

export async function activateEnableBankingAccount(
  ownerId: string,
  providerAccountId: string,
): Promise<void> {
  const configuration = await enableBankingWebConfiguration();
  if (ownerId !== configuration.ownerId) throw new Error('Enable Banking owner is not configured.');
  await activateEnableBankingCanonicalImport(
    databaseContext().db,
    ownerId,
    providerAccountId,
    nowInstant(),
  );
}

export async function disconnectEnableBanking(ownerId: string): Promise<void> {
  const configuration = await enableBankingWebConfiguration();
  if (ownerId !== configuration.ownerId) throw new Error('Enable Banking owner is not configured.');
  const lease = await beginEnableBankingDisconnect(
    databaseContext().db,
    ownerId,
    configuration.dataKey,
    nowInstant(),
  );
  try {
    const response = await client(configuration, lease).deleteSession(lease.sessionId);
    await finishReceipt(lease, configuration.dataKey, response.receiptId);
    await completeEnableBankingDisconnect(databaseContext().db, lease, nowInstant());
  } catch (error) {
    if (error instanceof EnableBankingApiError && error.category === 'not_found') {
      await completeEnableBankingDisconnect(databaseContext().db, lease, nowInstant());
      return;
    }
    await failEnableBankingRun(
      databaseContext().db,
      lease,
      safeCategory(error),
      nowInstant(),
      true,
    );
    throw error;
  }
}

export type {
  EnableBankingAuthorization,
  ClaimedEnableBankingAuthorization,
  EnableBankingDisconnectLease,
};
