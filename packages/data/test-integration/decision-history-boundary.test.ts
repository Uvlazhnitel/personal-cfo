import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import { assembleFinancialEngineInput } from '../../../apps/worker/src/engine-input.js';
import { buildSyntheticScenario } from '../../financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import {
  auditEvents,
  createDatabaseContext,
  createJobBoss,
  decodeSourceJson,
  ensureSyntheticOwner,
  evaluationProfiles,
  executeFinancialCommand,
  financialTransactions,
  flowAmbiguities,
  generateUuidV7,
  migrateDatabase,
  ownerInputVersions,
  planningContexts,
  recalculationRecords,
  saveFinancialEngineSource,
  setDecisionHistoryBoundary,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('owner-confirmed decision history boundary', () => {
  let context: DatabaseContext;
  let boss: PgBoss;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 6 });
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
    boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 5_000, close: true });
    await context?.close();
  });

  async function runBoundary(ownerId: string, idempotencyKey: string) {
    const now = '2026-10-05T18:00:00Z';
    const request = {
      startDate: '2026-07-01',
      reason: 'Owner approved reliable decision history from July 2026.',
    };
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'decision_history_boundary',
        idempotencyKey,
        request,
        asOf: now,
        effectiveDate: '2026-10-05',
        now,
      },
      (tx) =>
        setDecisionHistoryBoundary(tx, ownerId, {
          ...request,
          asOf: now,
          effectiveDate: '2026-10-05',
        }),
    );
  }

  it('versions once, preserves the ledger, and excludes pre-boundary ambiguity from assembly', async () => {
    const scenario = buildSyntheticScenario('healthy_current');
    const ownerId = await ensureSyntheticOwner(context.db, scenario.run.asOf);
    const imported = await saveFinancialEngineSource(
      context.db,
      ownerId,
      scenario,
      scenario.run.asOf,
    );
    expect(imported.inputVersion).toBe(1n);

    const transactionRows = await context.db
      .select({ id: financialTransactions.id })
      .from(financialTransactions)
      .where(eq(financialTransactions.ownerId, ownerId));
    expect(transactionRows.length).toBeGreaterThanOrEqual(2);
    await context.db.insert(flowAmbiguities).values([
      {
        id: generateUuidV7('pre-boundary-ambiguity'),
        ownerId,
        transactionId: transactionRows[0]!.id,
        kind: 'unclassified_external_flow',
        materiality: 'material',
        effectiveAt: '2026-06-30T20:59:59Z',
      },
      {
        id: generateUuidV7('post-boundary-ambiguity'),
        ownerId,
        transactionId: transactionRows[1]!.id,
        kind: 'unclassified_external_flow',
        materiality: 'material',
        effectiveAt: '2026-06-30T21:00:00Z',
      },
    ]);
    const contextBefore = await context.db.query.planningContexts.findFirst({
      where: and(
        eq(planningContexts.ownerId, ownerId),
        eq(planningContexts.kind, 'current'),
        eq(planningContexts.checkpointKey, 'current'),
      ),
    });
    const qualityBefore = (
      decodeSourceJson(contextBefore!.payload) as Readonly<Record<string, unknown>>
    )['quality'];

    const first = await runBoundary(ownerId, 'decision-history-boundary-001');
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 2n });
    expect(first.result).toMatchObject({
      startDate: '2026-07-01',
      startInclusive: '2026-06-30T21:00:00Z',
      timeZone: 'Europe/Riga',
    });

    const profile = await context.db.query.evaluationProfiles.findFirst({
      where: eq(evaluationProfiles.ownerId, ownerId),
    });
    expect(decodeSourceJson(profile!.payload)).toMatchObject({
      decisionHistoryBoundary: {
        startDate: '2026-07-01',
        startInclusive: '2026-06-30T21:00:00Z',
        source: 'owner_confirmed',
      },
      ccrPeriod: {
        startInclusive: '2026-06-30T21:00:00Z',
        endExclusive: '2026-10-05T18:00:00Z',
      },
    });
    const contextAfter = await context.db.query.planningContexts.findFirst({
      where: and(
        eq(planningContexts.ownerId, ownerId),
        eq(planningContexts.kind, 'current'),
        eq(planningContexts.checkpointKey, 'current'),
      ),
    });
    const decodedContext = decodeSourceJson(contextAfter!.payload) as Readonly<
      Record<string, unknown>
    >;
    expect(decodedContext['quality']).toEqual(qualityBefore);
    expect(decodedContext).toMatchObject({
      historyCoverage: { startInclusive: '2026-06-30T21:00:00Z' },
      reservationCoverage: { startInclusive: '2026-06-30T21:00:00Z' },
    });
    expect(
      await context.db
        .select({ id: financialTransactions.id })
        .from(financialTransactions)
        .where(eq(financialTransactions.ownerId, ownerId)),
    ).toHaveLength(transactionRows.length);

    const assembled = await assembleFinancialEngineInput(context.db, {
      ownerId,
      expectedInputVersion: 2n,
      asOf: '2026-10-05T18:00:00Z',
      effectiveDate: '2026-10-05',
      cause: 'decision_history_boundary',
    });
    expect(assembled.status).toBe('ready');
    if (assembled.status !== 'ready') throw new Error('Boundary assembly was superseded.');
    expect(assembled.input.canonical.transactions).toHaveLength(transactionRows.length);
    expect(assembled.input.canonical.ambiguities).toHaveLength(1);
    expect(assembled.input.canonical.ambiguities[0]?.effectiveAt).toBe('2026-06-30T21:00:00Z');
    expect(assembled.input.ccrPeriod).toEqual(assembled.input.current.historyCoverage);
    expect(assembled.input.ccrPeriod.startInclusive).toBe('2026-06-30T21:00:00Z');

    const replay = await runBoundary(ownerId, 'decision-history-boundary-001');
    expect(replay).toMatchObject({
      replayed: true,
      commandId: first.commandId,
      inputVersion: 2n,
    });
    expect(
      await context.db
        .select()
        .from(ownerInputVersions)
        .where(eq(ownerInputVersions.ownerId, ownerId)),
    ).toMatchObject([{ version: 2n }]);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(
          and(
            eq(recalculationRecords.ownerId, ownerId),
            eq(recalculationRecords.cause, 'decision_history_boundary'),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toMatchObject([
      { eventKind: 'decision_history_boundary', entityType: 'decision_history_boundary' },
    ]);

    await expect(runBoundary(ownerId, 'decision-history-boundary-other')).rejects.toMatchObject({
      code: 'decision_history.already_set',
    });
  });
});
