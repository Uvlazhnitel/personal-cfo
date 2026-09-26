import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { executeEnableBankingDiagnosticFetch } from '../../../apps/worker/src/enable-banking/fetch.js';
import { executeEnableBankingSync } from '../../../apps/worker/src/enable-banking/sync.js';
import type { EnableBankingConfiguration } from '../../../apps/worker/src/enable-banking/config.js';
import { ENABLE_BANKING_CONTRACT_FIXTURES } from '../../integrations/src/open-banking/enable-banking/index.js';
import {
  accounts,
  accountEntries,
  activateEnableBankingCanonicalImport,
  activateEnableBankingSession,
  beginEnableBankingAuthorization,
  beginEnableBankingDiagnosticFetch,
  beginEnableBankingDisconnect,
  bindEnableBankingProviderAccount,
  claimEnableBankingAuthorization,
  completeEnableBankingDisconnect,
  createDatabaseContext,
  createJobBoss,
  enableBankingBalanceReconciliations,
  enableBankingCanonicalImports,
  enableBankingHistoryCoverage,
  enableBankingRawReceipts,
  enableBankingConnections,
  enableBankingProviderAccounts,
  enableBankingSourceRevisions,
  encodeSourceJson,
  hashEnableBankingApplicationId,
  investmentContributions,
  listEnableBankingDiscoveredAccounts,
  loadMergedEnableBankingCoverage,
  loadEnableBankingActivationReadiness,
  loadCanonicalLedgerBalanceAt,
  migrateDatabase,
  ownerInputVersions,
  parseEnableBankingDataKey,
  persistEnableBankingRawReceipt,
  portfolioValuations,
  recalculationRecords,
  settingsVersions,
  transitionEnableBankingConnectionStatus,
  failEnableBankingRun,
  finalizeEnableBankingReceipt,
  users,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;
const ownerId = '018f0000-0000-7000-8000-000000000a10';
const accountId = '018f0000-0000-7000-8000-000000000a11';
const providerUid = '018f0000-0000-7000-8000-000000000a12';
const sessionId = '018f0000-0000-7000-8000-000000000a13';
const identificationHash = 'synthetic-swedbank-account-hash';
const dataKey = parseEnableBankingDataKey(Buffer.alloc(32, 29).toString('base64'));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function response(body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });
}

function fixture(value: string): unknown {
  return JSON.parse(value) as unknown;
}

suite('Enable Banking durable evidence-only diagnostic synchronization', () => {
  let context: DatabaseContext;
  let configuration: EnableBankingConfiguration;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 5 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test') {
      throw new Error('Integration tests require the personal_cfo_test database.');
    }
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
    await context.db.insert(users).values({
      id: ownerId,
      loginName: 'enable-banking-owner',
      passwordHash: 'not-used',
      locale: 'en',
      timeZone: 'Europe/Riga',
      createdAt: '2026-09-25T08:00:00Z',
      updatedAt: '2026-09-25T08:00:00Z',
    });
    await context.db.insert(accounts).values({
      id: accountId,
      ownerId,
      kind: 'bank',
      valueSource: 'balance_snapshot',
      currency: 'EUR',
      payload: encodeSourceJson({
        id: accountId,
        subtype: 'bank',
        currency: 'EUR',
        includeInNetWorth: true,
        valueSource: 'balance_snapshot',
      }),
    });
    configuration = Object.freeze({
      applicationId: '018f0000-0000-7000-8000-000000000a14',
      privateKeyPem,
      ownerId,
      redirectUrl: 'http://127.0.0.1:3000/api/v1/open-banking/enable-banking/callback',
      dataKey,
      baseUrl: 'http://127.0.0.1:4000',
    });
    const authorization = await beginEnableBankingAuthorization(context.db, {
      ownerId,
      applicationIdHash: hashEnableBankingApplicationId(configuration.applicationId),
      now: '2026-09-25T08:00:00Z',
    });
    const claimed = await claimEnableBankingAuthorization(
      context.db,
      authorization.state,
      '2026-09-25T08:00:01Z',
    );
    await expect(
      claimEnableBankingAuthorization(context.db, authorization.state, '2026-09-25T08:00:02Z'),
    ).rejects.toMatchObject({ code: 'enable_banking.invalid_or_replayed_state' });
    await activateEnableBankingSession(context.db, claimed, dataKey, {
      sessionId,
      validUntil: '2027-03-25T08:00:00Z',
      accounts: [
        {
          uid: providerUid,
          identificationHash,
          currency: 'EUR',
          displayHint: 'LV00 •••• 0010',
        },
      ],
      now: '2026-09-25T08:00:03Z',
    });
    const discovered = await listEnableBankingDiscoveredAccounts(context.db, ownerId, dataKey);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({ currency: 'EUR', currentSession: true });
    await bindEnableBankingProviderAccount(context.db, {
      ownerId,
      providerAccountId: discovered[0]!.id,
      canonicalAccountId: accountId,
      now: '2026-09-25T08:00:04Z',
    });
  });

  afterAll(async () => context.close());

  it('rejects a concurrent lease and resumes the same encrypted continuation after staleness', async () => {
    const encryptedConnection = await context.db.query.enableBankingConnections.findFirst({
      where: eq(enableBankingConnections.ownerId, ownerId),
    });
    const encryptedAccount = await context.db.query.enableBankingProviderAccounts.findFirst({
      where: eq(enableBankingProviderAccounts.ownerId, ownerId),
    });
    expect(encryptedConnection?.sessionIdCiphertext).not.toContain(sessionId);
    expect(encryptedAccount?.accountUidCiphertext).not.toContain(providerUid);
    expect(encryptedAccount?.identificationHashCiphertext).not.toContain(identificationHash);
    const lease = await beginEnableBankingDiagnosticFetch(
      context.db,
      ownerId,
      dataKey,
      '2026-09-25T08:01:00Z',
    );
    await expect(
      beginEnableBankingDiagnosticFetch(context.db, ownerId, dataKey, '2026-09-25T08:02:00Z'),
    ).rejects.toMatchObject({ code: 'enable_banking.operation_in_progress' });
    const run = { runId: lease.runId, ownerId, connectionId: lease.connectionId };
    const receipt = await persistEnableBankingRawReceipt(context.db, run, dataKey, {
      endpoint: 'transactions',
      method: 'GET',
      requestKey: 'transactions',
      requestCursor: null,
      httpStatus: 200,
      receivedAt: '2026-09-25T08:01:01Z',
      payload: ENABLE_BANKING_CONTRACT_FIXTURES.emptyContinuationPage,
      normalizationVersion: 'test-v1',
    });
    await finalizeEnableBankingReceipt(context.db, run, dataKey, {
      receiptId: receipt.id,
      status: 'normalized',
      revisions: [],
      responseCursor: 'synthetic-page-3',
      advanceContinuation: true,
      now: '2026-09-25T08:01:02Z',
    });
    const recovered = await beginEnableBankingDiagnosticFetch(
      context.db,
      ownerId,
      dataKey,
      '2026-09-25T08:17:00Z',
    );
    expect(recovered.runId).toBe(lease.runId);
    expect(recovered.leaseId).not.toBe(lease.leaseId);
    expect(recovered.continuationKey).toBe('synthetic-page-3');
    await failEnableBankingRun(
      context.db,
      recovered,
      'test_recovered_run_closed',
      '2026-09-25T08:17:01Z',
    );
  });

  it('encrypts before normalization, checkpoints pages, replays, and writes no canonical facts', async () => {
    const baseline = {
      valuations: Number(
        (await context.db.select({ value: count() }).from(portfolioValuations))[0]!.value,
      ),
      contributions: Number(
        (await context.db.select({ value: count() }).from(investmentContributions))[0]!.value,
      ),
      inputVersions: Number(
        (await context.db.select({ value: count() }).from(ownerInputVersions))[0]!.value,
      ),
      recalculations: Number(
        (await context.db.select({ value: count() }).from(recalculationRecords))[0]!.value,
      ),
    };
    const fixtureAccount = ENABLE_BANKING_CONTRACT_FIXTURES.items.account;
    const bodies = () => [
      {
        status: 'AUTHORIZED',
        accounts_data: [{ uid: providerUid, identification_hash: identificationHash }],
        aspsp: { name: 'Swedbank', country: 'LV' },
        psu_type: 'personal',
        access: { valid_until: '2027-03-25T08:00:00Z' },
        created: '2026-09-25T08:00:00Z',
        authorized: '2026-09-25T08:00:03Z',
        closed: null,
      },
      {
        ...fixtureAccount,
        uid: providerUid,
        identification_hash: identificationHash,
        identification_hashes: [identificationHash],
        name: 'Synthetic daily account',
        account_id: { iban: 'LV00SYNTHETIC0010' },
      },
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.balances),
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.firstPage),
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.finalPage),
    ];
    const run = async (at: string) => {
      const queue = bodies();
      const transport = vi.fn(() => Promise.resolve(response(queue.shift())));
      const result = await executeEnableBankingDiagnosticFetch(context.db, configuration, {
        clock: { now: () => new Date(at) },
        fetchImplementation: transport,
      });
      expect(transport).toHaveBeenCalledTimes(5);
      expect(result.confirmedPrincipalsCreated).toBe(0);
      expect(result.authoritativeBookedPresent).toBe(true);
      expect(result.transactionStatuses).toMatchObject({ booked: 6, pending: 1 });
      return result;
    };
    const first = await run('2026-09-25T09:00:00Z');
    expect(first.counts.new).toBeGreaterThan(0);
    const second = await run('2026-09-25T09:05:00Z');
    expect(second.counts.replay).toBe(first.counts.new + first.counts.revision);
    expect(second.counts.revision).toBe(0);

    const receipts = await context.db.select().from(enableBankingRawReceipts);
    expect(receipts).toHaveLength(11);
    expect(
      receipts.every(
        (receipt) =>
          receipt.payloadCiphertext !== null &&
          receipt.payloadIv !== null &&
          receipt.payloadAuthTag !== null &&
          !receipt.payloadCiphertext.includes('Synthetic daily account') &&
          new Date(receipt.payloadExpiresAt).getTime() - new Date(receipt.receivedAt).getTime() ===
            30 * 24 * 60 * 60_000,
      ),
    ).toBe(true);
    const revisions = await context.db.select().from(enableBankingSourceRevisions);
    expect(revisions.length).toBe(first.counts.new + first.counts.revision);
    expect(revisions.filter((revision) => revision.isCurrent)).toHaveLength(first.counts.new);
    expect({
      valuations: Number(
        (await context.db.select({ value: count() }).from(portfolioValuations))[0]!.value,
      ),
      contributions: Number(
        (await context.db.select({ value: count() }).from(investmentContributions))[0]!.value,
      ),
      inputVersions: Number(
        (await context.db.select({ value: count() }).from(ownerInputVersions))[0]!.value,
      ),
      recalculations: Number(
        (await context.db.select({ value: count() }).from(recalculationRecords))[0]!.value,
      ),
    }).toEqual(baseline);
  });

  it('keeps raw provider observations distinct from confirmed contribution principal', async () => {
    const revisions = await context.db
      .select({ kind: enableBankingSourceRevisions.recordKind })
      .from(enableBankingSourceRevisions)
      .where(eq(enableBankingSourceRevisions.ownerId, ownerId));
    expect(revisions.some((revision) => revision.kind === 'transaction')).toBe(true);
    expect(await context.db.select().from(investmentContributions)).toEqual([]);
  });

  it('gates canonical activation, imports once, and preserves replay idempotency', async () => {
    await context.db.insert(ownerInputVersions).values({
      ownerId,
      version: 0n,
      updatedAt: '2026-09-25T09:10:00Z',
    });
    await context.db.insert(settingsVersions).values({
      ownerId,
      version: 'enable-banking-test-v1',
      effectiveFrom: '2026-01-01T00:00:00Z',
      payload: encodeSourceJson({
        spendingBaseline: {
          materialityThreshold: { amountMinor: 1_000n, currency: 'EUR' },
        },
      }),
      isCurrent: true,
    });
    const fixtureAccount = ENABLE_BANKING_CONTRACT_FIXTURES.items.account;
    const bodies = () => [
      {
        status: 'AUTHORIZED',
        accounts_data: [{ uid: providerUid, identification_hash: identificationHash }],
        aspsp: { name: 'Swedbank', country: 'LV' },
        psu_type: 'personal',
        access: { valid_until: '2027-03-25T08:00:00Z' },
        created: '2026-09-25T08:00:00Z',
        authorized: '2026-09-25T08:00:03Z',
        closed: null,
      },
      {
        ...fixtureAccount,
        uid: providerUid,
        identification_hash: identificationHash,
        identification_hashes: [identificationHash],
        name: 'Synthetic daily account',
        account_id: { iban: 'LV00SYNTHETIC0010' },
      },
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.balances),
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.firstPage),
      fixture(ENABLE_BANKING_CONTRACT_FIXTURES.finalPage),
    ];
    const boss = createJobBoss(databaseUrl!, 3);
    await boss.start();
    try {
      const evidenceQueue = bodies();
      const evidenceOnly = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: false,
        clock: { now: () => new Date('2026-09-25T09:15:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(evidenceQueue.shift()))),
      });
      expect(evidenceOnly).toMatchObject({
        strategy: 'longest',
        completionStatus: 'evidence_only',
        confirmedPrincipalsCreated: 0,
      });
      expect(await context.db.select().from(enableBankingCanonicalImports)).toEqual([]);
      expect(await context.db.select().from(enableBankingHistoryCoverage)).toHaveLength(1);

      const providerAccount = await context.db.query.enableBankingProviderAccounts.findFirst({
        where: eq(enableBankingProviderAccounts.ownerId, ownerId),
      });
      expect(providerAccount?.transactionIdentityVerifiedAt).toBeNull();
      const proofQueue = bodies();
      const proof = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:18:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(proofQueue.shift()))),
      });
      expect(proof).toMatchObject({
        strategy: 'default',
        completionStatus: 'evidence_only',
      });
      expect(proof.activation.unmet).toContain('owner_not_activated');
      const verifiedAccount = await context.db.query.enableBankingProviderAccounts.findFirst({
        where: eq(enableBankingProviderAccounts.ownerId, ownerId),
      });
      expect(verifiedAccount?.transactionIdentityVerifiedAt).not.toBeNull();
      await activateEnableBankingCanonicalImport(
        context.db,
        ownerId,
        providerAccount!.id,
        '2026-09-25T09:19:00Z',
      );

      const importQueue = bodies();
      const imported = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:20:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(importQueue.shift()))),
      });
      expect(imported.strategy).toBe('default');
      expect(imported.completionStatus).toBe('completed');
      expect(imported.counts.canonicalMutations).toBeGreaterThan(0);
      const imports = await context.db.select().from(enableBankingCanonicalImports);
      expect(imports).toHaveLength(5);
      expect(await context.db.select().from(accountEntries)).toHaveLength(5);
      expect(await context.db.select().from(enableBankingBalanceReconciliations)).toHaveLength(1);
      expect((await context.db.query.ownerInputVersions.findFirst())?.version).toBe(1n);
      expect(await context.db.select().from(recalculationRecords)).toHaveLength(1);

      const revisionBodies = (status: 'BOOK' | 'CNCL', amount: string) => {
        const values = bodies();
        const page = values[3] as {
          transactions: Record<string, unknown>[];
          continuation_key: string;
        };
        values[3] = {
          ...page,
          transactions: page.transactions.map((transaction) =>
            transaction['entry_reference'] === 'archive-salary-001'
              ? {
                  ...transaction,
                  status,
                  transaction_amount: { currency: 'EUR', amount },
                }
              : transaction,
          ),
        };
        return values;
      };
      const balanceBeforeCorrection = await loadCanonicalLedgerBalanceAt(
        context.db,
        ownerId,
        accountId,
        '2026-09-25T23:59:59Z',
      );
      const correctedQueue = revisionBodies('BOOK', '2600.00');
      const corrected = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:27:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(correctedQueue.shift()))),
      });
      expect(corrected.counts.canonicalMutations).toBe(2);
      expect(
        await loadCanonicalLedgerBalanceAt(context.db, ownerId, accountId, '2026-09-25T23:59:59Z'),
      ).toBe(balanceBeforeCorrection + 10_000n);

      const cancelledQueue = revisionBodies('CNCL', '2600.00');
      const cancelled = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:28:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(cancelledQueue.shift()))),
      });
      expect(cancelled.counts.canonicalMutations).toBe(1);
      expect(
        await loadCanonicalLedgerBalanceAt(context.db, ownerId, accountId, '2026-09-25T23:59:59Z'),
      ).toBe(balanceBeforeCorrection - 250_000n);

      const rebookedQueue = revisionBodies('BOOK', '2700.00');
      const rebooked = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:29:00Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(rebookedQueue.shift()))),
      });
      expect(rebooked.counts.canonicalMutations).toBe(1);
      expect(
        await loadCanonicalLedgerBalanceAt(context.db, ownerId, accountId, '2026-09-25T23:59:59Z'),
      ).toBe(balanceBeforeCorrection + 20_000n);
      expect(await context.db.select().from(enableBankingCanonicalImports)).toHaveLength(8);

      const replayQueue = revisionBodies('BOOK', '2700.00');
      const replay = await executeEnableBankingSync(context.db, boss, configuration, {
        canonicalImportEnabled: true,
        clock: { now: () => new Date('2026-09-25T09:29:30Z') },
        fetchImplementation: vi.fn(() => Promise.resolve(response(replayQueue.shift()))),
      });
      expect(replay.counts.canonicalMutations).toBe(0);
      expect(await context.db.select().from(enableBankingCanonicalImports)).toHaveLength(8);
      expect((await context.db.query.ownerInputVersions.findFirst())?.version).toBe(4n);
      expect(await context.db.select().from(recalculationRecords)).toHaveLength(4);
      expect(
        await loadMergedEnableBankingCoverage(context.db, ownerId, '2026-09-25T09:26:00Z'),
      ).toEqual([{ coveredFrom: '2026-09-01', coveredThrough: '2026-09-25' }]);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('requires a new session generation to prove identity and coverage again', async () => {
    await transitionEnableBankingConnectionStatus(
      context.db,
      ownerId,
      'reauth_required',
      '2026-09-25T09:29:59Z',
      'enable_banking_session_expired',
    );
    const authorization = await beginEnableBankingAuthorization(context.db, {
      ownerId,
      applicationIdHash: hashEnableBankingApplicationId(configuration.applicationId),
      now: '2026-09-25T09:30:00Z',
    });
    const claimed = await claimEnableBankingAuthorization(
      context.db,
      authorization.state,
      '2026-09-25T09:30:01Z',
    );
    await activateEnableBankingSession(context.db, claimed, dataKey, {
      sessionId: '018f0000-0000-7000-8000-000000000a15',
      validUntil: '2027-03-25T09:30:00Z',
      accounts: [
        {
          uid: providerUid,
          identificationHash,
          currency: 'EUR',
          displayHint: 'LV00 •••• 0010',
        },
      ],
      now: '2026-09-25T09:30:02Z',
    });
    const account = await context.db.query.enableBankingProviderAccounts.findFirst({
      where: eq(enableBankingProviderAccounts.ownerId, ownerId),
    });
    expect(account?.ownerActivatedAt).not.toBeNull();
    expect(account).toMatchObject({
      identityVerifiedAt: null,
      transactionIdentityVerifiedAt: null,
    });
    expect(await loadEnableBankingActivationReadiness(context.db, ownerId, true)).toEqual({
      allowed: false,
      unmet: [
        'account_identity_unverified',
        'transaction_identity_unverified',
        'history_coverage_unavailable',
      ],
    });
  });

  it('revokes consent and erases usable session aliases without deleting evidence', async () => {
    const lease = await beginEnableBankingDisconnect(
      context.db,
      ownerId,
      dataKey,
      '2026-09-25T10:00:00Z',
    );
    expect(lease.sessionId).toBe('018f0000-0000-7000-8000-000000000a15');
    await completeEnableBankingDisconnect(context.db, lease, '2026-09-25T10:00:01Z');
    const connection = await context.db.query.enableBankingConnections.findFirst({
      where: eq(enableBankingConnections.ownerId, ownerId),
    });
    expect(connection).toMatchObject({
      status: 'revoked',
      sessionIdCiphertext: null,
      sessionGeneration: null,
    });
    const providerAccount = await context.db.query.enableBankingProviderAccounts.findFirst({
      where: eq(enableBankingProviderAccounts.ownerId, ownerId),
    });
    expect(providerAccount).toMatchObject({
      canonicalAccountId: accountId,
      accountUidCiphertext: null,
      sessionGeneration: null,
    });
    expect(await context.db.select().from(enableBankingSourceRevisions)).not.toEqual([]);
  });
});
