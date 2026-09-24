import { resolve } from 'node:path';

import { count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executePortfolioManagerSync } from '../../../apps/worker/src/portfolio-manager/sync.js';
import { PORTFOLIO_MANAGER_CONTRACT_FIXTURES } from '../../integrations/src/portfolio/portfolio-manager/index.js';
import {
  accounts,
  beginPortfolioManagerSync,
  beginSharesightSync,
  completePortfolioManagerSync,
  createDatabaseContext,
  encodeSourceJson,
  expirePortfolioManagerRawPayloads,
  finalizePortfolioManagerReceipt,
  investmentContributions,
  loadPendingPortfolioManagerReceipts,
  migrateDatabase,
  ownerInputVersions,
  parsePortfolioManagerReceiptKey,
  persistPortfolioManagerRawReceipt,
  portfolioManagerRawReceipts,
  portfolioManagerSourceRevisions,
  portfolioManagerSyncRuns,
  portfolioManagerSyncStates,
  portfolioValuations,
  recalculationRecords,
  users,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;
const ownerId = '018f0000-0000-7000-8000-000000000981';
const accountId = '018f0000-0000-7000-8000-000000000982';
const lowLevelOwnerId = '018f0000-0000-7000-8000-000000000983';
const lowLevelAccountId = '018f0000-0000-7000-8000-000000000984';
const receiptKey = parsePortfolioManagerReceiptKey(Buffer.alloc(32, 19).toString('base64'));
const connectionId = 'portfolio-manager-test-connection';

function response(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function emptyPage(cursor: string | null): string {
  const identity = JSON.parse(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities) as Record<
    string,
    unknown
  >;
  delete identity['capabilities'];
  return JSON.stringify({ ...identity, items: [], hasMore: false, nextCursor: cursor });
}

suite('Portfolio Manager durable read-only synchronization', () => {
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
      loginName: 'portfolio-manager-owner',
      passwordHash: 'not-used',
      locale: 'en',
      timeZone: 'Europe/Riga',
      createdAt: '2026-09-23T08:00:00Z',
      updatedAt: '2026-09-23T08:00:00Z',
    });
    await context.db.insert(users).values({
      id: lowLevelOwnerId,
      loginName: 'portfolio-manager-low-level-owner',
      passwordHash: 'not-used',
      locale: 'en',
      timeZone: 'Europe/Riga',
      createdAt: '2026-09-23T08:00:00Z',
      updatedAt: '2026-09-23T08:00:00Z',
    });
    await context.db.insert(accounts).values(
      [
        [ownerId, accountId],
        [lowLevelOwnerId, lowLevelAccountId],
      ].map(([accountOwnerId, id]) => ({
        id: id!,
        ownerId: accountOwnerId!,
        kind: 'investment',
        valueSource: 'portfolio_valuation',
        currency: 'EUR',
        payload: encodeSourceJson({
          id,
          subtype: 'investment',
          currency: 'EUR',
          includeInNetWorth: true,
          valueSource: 'portfolio_valuation',
          brokerageCashFor: null,
        }),
      })),
    );
  });

  afterAll(async () => context.close());

  it('encrypts receipts, recovers leases, and orders late revisions deterministically', async () => {
    const first = await beginPortfolioManagerSync(context.db, {
      ownerId: lowLevelOwnerId,
      investmentAccountId: lowLevelAccountId,
      connectionId: 'portfolio-manager-low-level',
      now: '2026-09-23T08:00:00Z',
    });
    await expect(
      beginPortfolioManagerSync(context.db, {
        ownerId: lowLevelOwnerId,
        investmentAccountId: lowLevelAccountId,
        connectionId: 'portfolio-manager-low-level',
        now: '2026-09-23T08:01:00Z',
      }),
    ).rejects.toMatchObject({ code: 'portfolio_manager.sync_in_progress' });
    const payload = '{"private":"provider-payload"}';
    const receipt = await persistPortfolioManagerRawReceipt(context.db, first, receiptKey, {
      endpoint: 'capital_flows',
      requestKey: 'capital_flows',
      requestCursor: null,
      receivedAt: '2026-09-23T08:00:01Z',
      payload,
      normalizationVersion: 'test-v1',
    });
    const stored = await context.db.query.portfolioManagerRawReceipts.findFirst({
      where: eq(portfolioManagerRawReceipts.id, receipt.id),
    });
    expect(stored?.payloadCiphertext).not.toContain('provider-payload');
    expect(
      (await loadPendingPortfolioManagerReceipts(context.db, first, receiptKey))[0]?.payload,
    ).toBe(payload);
    expect(
      (
        await finalizePortfolioManagerReceipt(context.db, first, {
          receiptId: receipt.id,
          status: 'normalized',
          revisions: [
            {
              sourceId: 'capital-flow:event-1',
              revisionSha256: 'b'.repeat(64),
              recordKind: 'capital_flow',
              providerRevisionId: 'revision-2',
              providerStatus: 'VOIDED',
              changedAt: '2026-09-23T08:00:02Z',
              replacesRevisionId: 'revision-1',
              replacementRevisionIds: [],
            },
          ],
          responseCursor: 'cursor-2',
          advanceCheckpoint: true,
          now: '2026-09-23T08:00:02Z',
        })
      )[0]?.disposition,
    ).toBe('new');
    const olderReceipt = await persistPortfolioManagerRawReceipt(context.db, first, receiptKey, {
      endpoint: 'capital_flows',
      requestKey: 'capital_flows-old',
      requestCursor: null,
      receivedAt: '2026-09-23T08:00:03Z',
      payload,
      normalizationVersion: 'test-v1',
    });
    expect(
      (
        await finalizePortfolioManagerReceipt(context.db, first, {
          receiptId: olderReceipt.id,
          status: 'normalized',
          revisions: [
            {
              sourceId: 'capital-flow:event-1',
              revisionSha256: 'a'.repeat(64),
              recordKind: 'capital_flow',
              providerRevisionId: 'revision-1',
              providerStatus: 'ACTIVE',
              changedAt: '2026-09-22T08:00:00Z',
              replacesRevisionId: null,
              replacementRevisionIds: ['revision-2'],
            },
          ],
          responseCursor: 'cursor-2',
          advanceCheckpoint: false,
          now: '2026-09-23T08:00:03Z',
        })
      )[0]?.disposition,
    ).toBe('revision');
    const revisions = await context.db.query.portfolioManagerSourceRevisions.findMany({
      where: eq(portfolioManagerSourceRevisions.sourceId, 'capital-flow:event-1'),
    });
    expect(revisions.filter((item) => item.isCurrent)).toEqual([
      expect.objectContaining({ providerRevisionId: 'revision-2', providerStatus: 'VOIDED' }),
    ]);

    const recovered = await beginPortfolioManagerSync(context.db, {
      ownerId: lowLevelOwnerId,
      investmentAccountId: lowLevelAccountId,
      connectionId: 'portfolio-manager-low-level',
      now: '2026-09-23T08:16:00Z',
    });
    expect(recovered.runId).toBe(first.runId);
    expect(recovered.checkpoint).toBe('cursor-2');
    await completePortfolioManagerSync(context.db, recovered, {
      counts: { new: 1, revision: 1 },
      sourceCompleteness: 'partial',
      now: '2026-09-23T08:16:01Z',
    });
    expect(
      await expirePortfolioManagerRawPayloads(context.db, '2026-10-30T00:00:00Z'),
    ).toBeGreaterThan(0);
    const expiredReceipt = await context.db.query.portfolioManagerRawReceipts.findFirst({
      where: eq(portfolioManagerRawReceipts.id, receipt.id),
    });
    expect(expiredReceipt?.payloadCiphertext).toBeNull();
    expect(expiredReceipt?.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('executes paged sync, replay, replacement, and void without canonical writes', async () => {
    let mode: 'initial' | 'replay' | 'revision' = 'initial';
    const seenCapitalUrls: string[] = [];
    const fetchImplementation = (input: string): Promise<Response> => {
      if (input.endsWith('/capabilities')) {
        return Promise.resolve(response(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capabilities));
      }
      if (input.endsWith('/snapshot')) {
        return Promise.resolve(response(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.completeSnapshot));
      }
      seenCapitalUrls.push(input);
      const url = new URL(input);
      const cursor = url.searchParams.get('cursor');
      if (mode === 'initial' && cursor === null) {
        return Promise.resolve(response(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.capitalFlows));
      }
      if (mode === 'revision') {
        mode = 'replay';
        return Promise.resolve(response(PORTFOLIO_MANAGER_CONTRACT_FIXTURES.replacementFlows));
      }
      return Promise.resolve(response(emptyPage(cursor)));
    };
    const configuration = {
      baseUrl: 'http://127.0.0.1:3010',
      apiToken: 'test-token',
      ownerId,
      investmentAccountId: accountId,
      receiptKey,
      connectionId,
    } as const;
    const times = [
      '2026-09-23T12:00:00Z',
      '2026-09-23T12:00:01Z',
      '2026-09-23T12:00:02Z',
      '2026-09-23T12:00:03Z',
      '2026-09-23T12:00:04Z',
      '2026-09-23T12:00:05Z',
      '2026-09-23T12:00:06Z',
      '2026-09-23T12:00:07Z',
      '2026-09-23T12:00:08Z',
      '2026-09-23T12:00:09Z',
      '2026-09-23T12:00:10Z',
      '2026-09-23T12:00:11Z',
      '2026-09-23T12:00:12Z',
      '2026-09-23T12:00:13Z',
      '2026-09-23T12:00:14Z',
    ];
    const clock = { now: () => new Date(times.shift() ?? '2026-09-23T12:00:15Z') };
    const first = await executePortfolioManagerSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(first.contributions).toHaveLength(2);
    expect(first.confirmedPrincipalsCreated).toBe(0);
    expect(first.checkpoint).not.toBeNull();
    expect(first.readiness.recommendationAllowed).toBe(false);
    expect(first.readiness.warnings).toContain('valuation_components_mismatch');

    mode = 'replay';
    const replay = await executePortfolioManagerSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(replay.counts.replay).toBeGreaterThan(0);
    expect(replay.contributions).toHaveLength(0);

    mode = 'revision';
    const revised = await executePortfolioManagerSync(context.db, configuration, {
      fetchImplementation,
      clock,
    });
    expect(revised.capitalFlows.map((item) => item.status)).toEqual([
      'REPLACED',
      'ACTIVE',
      'VOIDED',
    ]);
    expect(revised.contributions).toHaveLength(0);
    expect(revised.counts.revision).toBeGreaterThan(0);
    const current = await context.db.query.portfolioManagerSourceRevisions.findFirst({
      where: eq(portfolioManagerSourceRevisions.sourceId, 'capital-flow:event-deposit-1'),
    });
    const currentRows = await context.db.query.portfolioManagerSourceRevisions.findMany({
      where: eq(portfolioManagerSourceRevisions.sourceId, 'capital-flow:event-deposit-1'),
    });
    expect(currentRows.find((item) => item.isCurrent)).toMatchObject({
      providerRevisionId: 'revision-deposit-3',
      providerStatus: 'VOIDED',
    });
    expect(current).toBeDefined();
    expect(seenCapitalUrls.every((url) => url.includes('limit=500'))).toBe(true);

    expect((await context.db.select({ value: count() }).from(portfolioValuations))[0]?.value).toBe(
      0,
    );
    expect(
      (await context.db.select({ value: count() }).from(investmentContributions))[0]?.value,
    ).toBe(0);
    expect((await context.db.select({ value: count() }).from(ownerInputVersions))[0]?.value).toBe(
      0,
    );
    expect((await context.db.select({ value: count() }).from(recalculationRecords))[0]?.value).toBe(
      0,
    );
    expect(
      (await context.db.select({ value: count() }).from(portfolioManagerSyncRuns))[0]?.value,
    ).toBeGreaterThanOrEqual(3);
    const state = await context.db.query.portfolioManagerSyncStates.findFirst({
      where: eq(portfolioManagerSyncStates.connectionId, connectionId),
    });
    expect(state?.checkpoint).toBe(revised.checkpoint);
  });

  it('prevents Sharesight from becoming authoritative for the same canonical account', async () => {
    await expect(
      beginSharesightSync(context.db, {
        ownerId,
        portfolioId: '293304',
        investmentAccountId: accountId,
        connectionId: 'sharesight-conflict',
        now: '2026-09-24T08:00:00Z',
      }),
    ).rejects.toMatchObject({ code: 'portfolio.binding_conflict' });
  });
});
