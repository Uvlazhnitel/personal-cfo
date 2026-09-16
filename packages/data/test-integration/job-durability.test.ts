import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import { processRecalculationJob } from '../../../apps/worker/src/job-handlers.js';
import { assembleFinancialEngineInput } from '../../../apps/worker/src/engine-input.js';
import { buildSyntheticScenario } from '../../financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import { evaluateFinancialState } from '../../financial-engine/src/index.js';
import {
  JOB_QUEUES,
  createDatabaseContext,
  createJobBoss,
  derivedPayCycles,
  engineRuns,
  ensureSyntheticOwner,
  executeFinancialCommand,
  metricSnapshots,
  migrateDatabase,
  persistEngineResult,
  recalculationRecords,
  saveFinancialEngineSource,
  sinkingRequirements,
} from '../src/index.js';
import type { DatabaseContext, RecalculationJob } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('durable financial jobs', () => {
  let context: DatabaseContext;
  const bosses = new Set<PgBoss>();

  beforeEach(async () => {
    context ??= createDatabaseContext(databaseUrl!, { maxConnections: 10 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
  });

  afterEach(async () => {
    await Promise.all(
      [...bosses].map(async (boss) => {
        try {
          await boss.stop({ graceful: true, timeout: 5_000, close: true });
        } catch {
          // The assertion path may already have closed the consumer under test.
        }
      }),
    );
    bosses.clear();
  });

  afterAll(async () => context?.close());

  async function startBoss(): Promise<PgBoss> {
    const boss = createJobBoss(databaseUrl!, 2);
    bosses.add(boss);
    await boss.start();
    return boss;
  }

  async function seedSynthetic(): Promise<string> {
    const scenario = buildSyntheticScenario('healthy_current');
    const ownerId = await ensureSyntheticOwner(context.db, scenario.run.asOf);
    const saved = await saveFinancialEngineSource(context.db, ownerId, scenario, scenario.run.asOf);
    const assembled = await assembleFinancialEngineInput(context.db, {
      ownerId,
      expectedInputVersion: saved.inputVersion,
      asOf: scenario.run.asOf,
      effectiveDate: scenario.run.effectiveDate,
      cause: 'synthetic_import',
    });
    if (assembled.status !== 'ready') throw new Error('Initial assembly was superseded.');
    const publication = await persistEngineResult(
      context.db,
      {
        ownerId,
        inputVersion: saved.inputVersion,
        asOf: scenario.run.asOf,
        effectiveDate: scenario.run.effectiveDate,
        engineVersion: scenario.run.engineVersion,
        settingsVersion: scenario.run.settingsVersion,
        inputWatermark: scenario.run.inputWatermark,
        trigger: 'synthetic_import',
        earliestAffectedAt: null,
        startedAt: '2026-09-14T08:00:01Z',
        completedAt: '2026-09-14T08:00:02Z',
      },
      evaluateFinancialState(assembled.input),
    );
    if (publication.status !== 'published') throw new Error('Initial publication was superseded.');
    return ownerId;
  }

  async function enqueueRecalculation(
    boss: PgBoss,
    ownerId: string,
    key: string,
  ): Promise<{ jobId: string; requestId: string }> {
    const command = await executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'manual_recalculate',
        idempotencyKey: key,
        request: { reason: key },
        asOf: '2026-09-14T09:00:00Z',
        effectiveDate: '2026-09-14',
        now: '2026-09-14T09:00:00Z',
      },
      () =>
        Promise.resolve({
          entityType: 'verification_probe',
          entityId: ownerId,
          earliestAffectedAt: null,
          result: Object.freeze({ accepted: true }),
        }),
    );
    const record = await context.db.query.recalculationRecords.findFirst({
      where: and(
        eq(recalculationRecords.ownerId, ownerId),
        eq(recalculationRecords.inputVersion, command.inputVersion),
      ),
    });
    if (record?.jobId === null || record?.jobId === undefined)
      throw new Error('Recalculation command did not persist its job identity.');
    return { jobId: record.jobId, requestId: record.id };
  }

  async function waitForCompleted(requestId: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const record = await context.db.query.recalculationRecords.findFirst({
        where: eq(recalculationRecords.id, requestId),
      });
      if (record?.status === 'completed') return;
      if (record?.status === 'failed' || record?.status === 'superseded')
        throw new Error(`Recalculation ended unexpectedly with status ${record.status}.`);
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
    }
    throw new Error('Timed out waiting for the durable recalculation job.');
  }

  async function assertSinglePublication(ownerId: string, inputVersion: bigint): Promise<void> {
    const runs = await context.db
      .select()
      .from(engineRuns)
      .where(
        and(
          eq(engineRuns.ownerId, ownerId),
          eq(engineRuns.inputVersion, inputVersion),
          eq(engineRuns.status, 'completed'),
        ),
      );
    expect(runs).toHaveLength(1);
    const runId = runs[0]!.id;
    const snapshots = await context.db
      .select()
      .from(metricSnapshots)
      .where(eq(metricSnapshots.engineRunId, runId));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(new Set(snapshots.map((row) => `${row.metricKind}:${row.periodKey}`)).size).toBe(
      snapshots.length,
    );
    expect(snapshots.every((row) => row.isAuthoritative)).toBe(true);
    const authoritative = await context.db
      .select()
      .from(metricSnapshots)
      .where(and(eq(metricSnapshots.ownerId, ownerId), eq(metricSnapshots.isAuthoritative, true)));
    expect(new Set(authoritative.map((row) => `${row.metricKind}:${row.periodKey}`)).size).toBe(
      authoritative.length,
    );
    expect(new Set(authoritative.map((row) => row.engineRunId))).toEqual(new Set([runId]));

    const cycles = await context.db
      .select()
      .from(derivedPayCycles)
      .where(eq(derivedPayCycles.engineRunId, runId));
    expect(cycles.length).toBeGreaterThan(0);
    expect(new Set(cycles.map((row) => row.cycleId)).size).toBe(cycles.length);
    const requirements = await context.db
      .select()
      .from(sinkingRequirements)
      .where(eq(sinkingRequirements.engineRunId, runId));
    expect(requirements.length).toBeGreaterThan(0);
    expect(new Set(requirements.map((row) => row.fundId)).size).toBe(requirements.length);
    expect(requirements.every((row) => row.isAuthoritative)).toBe(true);
  }

  it('processes a persisted recalculation with a fresh pg-boss consumer', async () => {
    const ownerId = await seedSynthetic();
    const firstBoss = await startBoss();
    const queued = await enqueueRecalculation(firstBoss, ownerId, 'restart-durability');
    const beforeStop = await context.pool.query<{
      id: string;
      name: string;
      state: string;
    }>('select id::text, name, state from pgboss.job where id = $1', [queued.jobId]);
    expect(beforeStop.rows).toEqual([
      expect.objectContaining({
        id: queued.jobId,
        name: JOB_QUEUES.recalculate,
        state: 'created',
      }),
    ]);

    await firstBoss.stop({ graceful: true, timeout: 5_000, close: true });
    bosses.delete(firstBoss);

    const secondBoss = await startBoss();
    let secondConsumerCalls = 0;
    await secondBoss.work<RecalculationJob>(
      JOB_QUEUES.recalculate,
      { batchSize: 1 },
      async (jobs) => {
        for (const job of jobs) {
          secondConsumerCalls += 1;
          await processRecalculationJob(context.db, secondBoss, job);
        }
      },
    );
    await waitForCompleted(queued.requestId);

    expect(secondConsumerCalls).toBe(1);
    const completedJob = await context.pool.query<{ state: string }>(
      'select state from pgboss.job where id = $1',
      [queued.jobId],
    );
    expect(completedJob.rows[0]?.state).toBe('completed');
    await assertSinglePublication(ownerId, 2n);
  });

  it('retries one transient failure and publishes one authoritative result', async () => {
    const ownerId = await seedSynthetic();
    const boss = await startBoss();
    const queued = await enqueueRecalculation(boss, ownerId, 'transient-retry');
    let attempts = 0;
    await boss.work<RecalculationJob>(JOB_QUEUES.recalculate, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) {
        attempts += 1;
        if (attempts === 1) throw new Error('Transient Stage 5.2 retry probe.');
        await processRecalculationJob(context.db, boss, job);
      }
    });
    await waitForCompleted(queued.requestId, 25_000);

    expect(attempts).toBe(2);
    const completedJob = await context.pool.query<{
      state: string;
      retry_count: number;
    }>('select state, retry_count from pgboss.job where id = $1', [queued.jobId]);
    expect(completedJob.rows[0]).toMatchObject({ state: 'completed', retry_count: 1 });
    expect(
      (
        await context.db.query.recalculationRecords.findFirst({
          where: eq(recalculationRecords.id, queued.requestId),
        })
      )?.status,
    ).toBe('completed');
    await assertSinglePublication(ownerId, 2n);
  }, 30_000);
});
