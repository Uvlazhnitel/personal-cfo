import { resolve } from 'node:path';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeSharesightSync } from '../../../apps/worker/src/sharesight/sync.js';
import { SHARESIGHT_CONTRACT_FIXTURES } from '../../integrations/src/portfolio/index.js';
import {
  accounts,
  beginSharesightSync,
  completeSharesightSync,
  createDatabaseContext,
  encodeSourceJson,
  expireSharesightRawPayloads,
  finalizeSharesightReceipt,
  investmentContributions,
  loadPendingSharesightReceipts,
  migrateDatabase,
  parseSharesightReceiptKey,
  persistSharesightRawReceipt,
  portfolioValuations,
  sharesightRawReceipts,
  sharesightSourceRevisions,
  sharesightSyncRuns,
  users,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;
const ownerId = '018f0000-0000-7000-8000-000000000871';
const accountId = '018f0000-0000-7000-8000-000000000872';
const receiptKey = parseSharesightReceiptKey(Buffer.alloc(32, 11).toString('base64'));

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

suite('Sharesight durable read-only synchronization', () => {
  let context: DatabaseContext;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 8 });
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
      loginName: 'sharesight-owner',
      passwordHash: 'not-used',
      locale: 'en',
      timeZone: 'Europe/Riga',
      createdAt: '2026-01-15T08:00:00Z',
      updatedAt: '2026-01-15T08:00:00Z',
    });
    await context.db.insert(accounts).values({
      id: accountId,
      ownerId,
      kind: 'investment',
      valueSource: 'portfolio_valuation',
      currency: 'EUR',
      payload: encodeSourceJson({
        id: accountId,
        subtype: 'investment',
        currency: 'EUR',
        includeInNetWorth: true,
        valueSource: 'portfolio_valuation',
        brokerageCashFor: null,
      }),
    });
  });

  afterAll(async () => context.close());

  it('encrypts receipts, enforces leases, and tracks new/replay/revision identities', async () => {
    const first = await beginSharesightSync(context.db, {
      ownerId,
      portfolioId: '900001',
      investmentAccountId: accountId,
      connectionId: 'sharesight-test-900001',
      now: '2026-01-15T08:00:00Z',
    });
    await expect(
      beginSharesightSync(context.db, {
        ownerId,
        portfolioId: '900001',
        investmentAccountId: accountId,
        connectionId: 'sharesight-test-900001',
        now: '2026-01-15T08:01:00Z',
      }),
    ).rejects.toMatchObject({ code: 'sharesight.sync_in_progress' });
    const payload = '{"private":"raw-provider-value"}';
    const receipt = await persistSharesightRawReceipt(context.db, first, receiptKey, {
      capability: 'currency',
      requestKey: '/api/v2/portfolios.json?',
      requestFrom: null,
      requestTo: null,
      receivedAt: '2026-01-15T08:00:01Z',
      payload,
      normalizationVersion: 'test-v1',
    });
    const stored = await context.db.query.sharesightRawReceipts.findFirst({
      where: eq(sharesightRawReceipts.id, receipt.id),
    });
    expect(stored?.payloadCiphertext).not.toContain('raw-provider-value');
    expect((await loadPendingSharesightReceipts(context.db, first, receiptKey))[0]?.payload).toBe(
      payload,
    );
    const firstDisposition = await finalizeSharesightReceipt(context.db, first, {
      receiptId: receipt.id,
      status: 'normalized',
      revisions: [{ sourceId: 'source-1', revisionSha256: 'a'.repeat(64), recordKind: 'test' }],
      continuation: { phase: 'test' },
      now: '2026-01-15T08:00:02Z',
    });
    expect(firstDisposition[0]?.disposition).toBe('new');
    await completeSharesightSync(context.db, first, { new: 1 }, '2026-01-15T08:00:03Z');

    const second = await beginSharesightSync(context.db, {
      ownerId,
      portfolioId: '900001',
      investmentAccountId: accountId,
      connectionId: 'sharesight-test-900001',
      now: '2026-01-15T09:00:00Z',
    });
    const replayReceipt = await persistSharesightRawReceipt(context.db, second, receiptKey, {
      capability: 'currency',
      requestKey: '/api/v2/portfolios.json?',
      requestFrom: null,
      requestTo: null,
      receivedAt: '2026-01-15T09:00:01Z',
      payload,
      normalizationVersion: 'test-v1',
    });
    expect(
      (
        await finalizeSharesightReceipt(context.db, second, {
          receiptId: replayReceipt.id,
          status: 'normalized',
          revisions: [{ sourceId: 'source-1', revisionSha256: 'a'.repeat(64), recordKind: 'test' }],
          continuation: null,
          now: '2026-01-15T09:00:02Z',
        })
      )[0]?.disposition,
    ).toBe('replay');
    const revisedReceipt = await persistSharesightRawReceipt(context.db, second, receiptKey, {
      capability: 'currency',
      requestKey: '/api/v2/portfolios.json?revision=2',
      requestFrom: null,
      requestTo: null,
      receivedAt: '2026-01-15T09:00:03Z',
      payload: '{"private":"corrected"}',
      normalizationVersion: 'test-v1',
    });
    expect(
      (
        await finalizeSharesightReceipt(context.db, second, {
          receiptId: revisedReceipt.id,
          status: 'normalized',
          revisions: [{ sourceId: 'source-1', revisionSha256: 'b'.repeat(64), recordKind: 'test' }],
          continuation: null,
          now: '2026-01-15T09:00:04Z',
        })
      )[0]?.disposition,
    ).toBe('revision');
    const revisions = await context.db.query.sharesightSourceRevisions.findMany({
      where: eq(sharesightSourceRevisions.sourceId, 'source-1'),
    });
    expect(revisions).toHaveLength(2);
    expect(revisions.filter((item) => item.isCurrent)).toHaveLength(1);
    const abandonedReceipt = await persistSharesightRawReceipt(context.db, second, receiptKey, {
      capability: 'currency',
      requestKey: '/api/v2/portfolios.json?abandoned=true',
      requestFrom: null,
      requestTo: null,
      receivedAt: '2026-01-15T09:00:04Z',
      payload,
      normalizationVersion: 'test-v1',
    });
    await completeSharesightSync(
      context.db,
      second,
      { replay: 1, revision: 1 },
      '2026-01-15T09:00:05Z',
    );

    expect(await expireSharesightRawPayloads(context.db, '2026-02-20T00:00:00Z')).toBeGreaterThan(
      0,
    );
    const expired = await context.db.query.sharesightRawReceipts.findFirst({
      where: eq(sharesightRawReceipts.id, receipt.id),
    });
    expect(expired?.payloadCiphertext).toBeNull();
    expect(expired?.payloadSha256).toHaveLength(64);
    const abandoned = await context.db.query.sharesightRawReceipts.findFirst({
      where: eq(sharesightRawReceipts.id, abandonedReceipt.id),
    });
    expect(abandoned).toMatchObject({
      status: 'failed',
      payloadCiphertext: null,
      failureCategory: 'sharesight_receipt_expired',
    });
  });

  it('executes a full evidence-only sync idempotently without canonical financial writes', async () => {
    const portfolios = SHARESIGHT_CONTRACT_FIXTURES.portfolios.replace(
      '01 Jan 2024',
      '01 Jan 2026',
    );
    const valuation = SHARESIGHT_CONTRACT_FIXTURES.completeValuation.replace(
      '2026-09-21',
      '2026-01-15',
    );
    let tokenCalls = 0;
    let includeDeposit = true;
    let identitylessUnconfirmedRecords = false;
    const fetchImplementation = (input: string): Promise<Response> => {
      if (input.endsWith('/oauth2/token')) {
        tokenCalls += 1;
        return Promise.resolve(
          response(JSON.stringify({ access_token: `token-${tokenCalls}`, expires_in: 1800 })),
        );
      }
      if (input.includes('/valuation.json')) return Promise.resolve(response(valuation));
      if (input.includes('/cash_account_transactions.json')) {
        return Promise.resolve(
          response(
            includeDeposit
              ? SHARESIGHT_CONTRACT_FIXTURES.deposit
              : '{"cash_account_transactions":[]}',
          ),
        );
      }
      if (input.endsWith('/cash_accounts.json')) {
        return Promise.resolve(response(SHARESIGHT_CONTRACT_FIXTURES.cashAccounts));
      }
      if (input.includes('/trades.json')) {
        return Promise.resolve(
          response(
            identitylessUnconfirmedRecords
              ? SHARESIGHT_CONTRACT_FIXTURES.observedIdentitylessTrade
              : SHARESIGHT_CONTRACT_FIXTURES.pendingTrade,
          ),
        );
      }
      if (input.includes('/payouts.json')) {
        return Promise.resolve(
          response(
            identitylessUnconfirmedRecords
              ? SHARESIGHT_CONTRACT_FIXTURES.observedIdentitylessPayout
              : SHARESIGHT_CONTRACT_FIXTURES.payouts,
          ),
        );
      }
      if (input.includes('/performance.json')) {
        return Promise.resolve(response(SHARESIGHT_CONTRACT_FIXTURES.observedDirectPerformance));
      }
      return Promise.resolve(response(portfolios));
    };
    const configuration = {
      clientId: 'client',
      clientSecret: 'secret',
      portfolioId: '293304',
      ownerId,
      investmentAccountId: accountId,
      receiptKey,
      apiBaseUrl: 'http://127.0.0.1:8123',
      connectionId: 'sharesight-test-293304',
    } as const;
    const clock = { now: () => new Date('2026-01-15T08:00:00Z') };
    const first = await executeSharesightSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(first).toMatchObject({
      status: 'completed',
      sourceFreshness: 'unconfirmed',
      confirmedPrincipalsCreated: 0,
    });
    expect(first.warnings).toContain('source_incomplete');
    expect(first.contributions).toHaveLength(1);
    expect(first.trades[0]?.state).toBe('unconfirmed');
    expect(first.payouts).toHaveLength(1);
    expect(first.counts.new).toBeGreaterThan(0);

    const second = await executeSharesightSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(second.counts.replay).toBeGreaterThan(0);
    expect(second.counts.revision).toBe(0);
    includeDeposit = false;
    const withoutDeposit = await executeSharesightSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(withoutDeposit.contributions).toHaveLength(0);
    identitylessUnconfirmedRecords = true;
    const quarantinedIdentityless = await executeSharesightSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(quarantinedIdentityless).toMatchObject({
      status: 'completed',
      trades: [],
      payouts: [],
    });
    expect(quarantinedIdentityless.counts.quarantined).toBeGreaterThan(0);
    expect(tokenCalls).toBe(4);
    const retainedContribution = await context.db.query.sharesightSourceRevisions.findFirst({
      where: eq(sharesightSourceRevisions.sourceId, 'portfolio:293304:cash:754797206:798669676'),
    });
    expect(retainedContribution?.isCurrent).toBe(true);

    expect((await context.db.select({ value: count() }).from(portfolioValuations))[0]?.value).toBe(
      0,
    );
    expect(
      (await context.db.select({ value: count() }).from(investmentContributions))[0]?.value,
    ).toBe(0);
    const runs = await context.db.select().from(sharesightSyncRuns);
    expect(runs.filter((run) => run.providerPortfolioId === '293304')).toHaveLength(4);
    expect(runs.every((run) => run.status === 'completed')).toBe(true);
  });

  it('recovers a stale lease and rejects silent canonical-account rebinding', async () => {
    const stale = await beginSharesightSync(context.db, {
      ownerId,
      portfolioId: '900002',
      investmentAccountId: accountId,
      connectionId: 'sharesight-test-900002',
      now: '2026-01-15T10:00:00Z',
    });
    const checkpoint = {
      source: 'sharesight-application-window',
      phase: 'trades',
      portfolioId: '900002',
      resourceId: '900002',
      from: '2026-01-01',
      to: '2026-01-31',
    } as const;
    const checkpointReceipt = await persistSharesightRawReceipt(context.db, stale, receiptKey, {
      capability: 'fees',
      requestKey: '/api/v2/portfolios/900002/trades.json?start_date=2026-01-01',
      requestFrom: '2026-01-01',
      requestTo: '2026-01-31',
      receivedAt: '2026-01-15T10:00:01Z',
      payload: '{"trades":[]}',
      normalizationVersion: 'test-v1',
    });
    await finalizeSharesightReceipt(context.db, stale, {
      receiptId: checkpointReceipt.id,
      status: 'normalized',
      revisions: [],
      continuation: checkpoint,
      now: '2026-01-15T10:00:02Z',
    });
    const recovered = await beginSharesightSync(context.db, {
      ownerId,
      portfolioId: '900002',
      investmentAccountId: accountId,
      connectionId: 'sharesight-test-900002',
      now: '2026-01-15T10:16:00Z',
    });
    expect(recovered.runId).toBe(stale.runId);
    expect(recovered.continuation).toEqual(checkpoint);
    const oldRun = await context.db.query.sharesightSyncRuns.findFirst({
      where: eq(sharesightSyncRuns.id, stale.runId),
    });
    expect(oldRun).toMatchObject({ status: 'running', failureCategory: null });
    await completeSharesightSync(context.db, recovered, {}, '2026-01-15T10:16:01Z');

    await expect(
      beginSharesightSync(context.db, {
        ownerId,
        portfolioId: '900002',
        investmentAccountId: accountId,
        connectionId: 'different-connection',
        now: '2026-01-15T11:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'sharesight.binding_conflict' });
  });
});
