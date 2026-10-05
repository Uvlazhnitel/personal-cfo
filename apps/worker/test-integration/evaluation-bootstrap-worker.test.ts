import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import { buildSyntheticScenario } from '../../../packages/financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import {
  JOB_QUEUES,
  bootstrapConservativeEvaluationProfile,
  createDatabaseContext,
  createJobBoss,
  ensureSyntheticOwner,
  engineRuns,
  evaluationProfiles,
  executeFinancialCommand,
  metricSnapshots,
  migrateDatabase,
  planningContexts,
  recalculationRecords,
  saveFinancialEngineSource,
} from '../../../packages/data/src/index.js';
import type { DatabaseContext, RecalculationJob } from '../../../packages/data/src/index.js';
import { processRecalculationJob } from '../src/job-handlers.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('evaluation profile bootstrap worker publication', () => {
  let context: DatabaseContext;
  let boss: PgBoss;

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
    boss = createJobBoss(databaseUrl!, 3);
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: true, timeout: 5_000, close: true });
    await context?.close();
  });

  it('replaces the missing profile with conservative state and publishes one run', async () => {
    const scenario = buildSyntheticScenario('healthy_current');
    const ownerId = await ensureSyntheticOwner(context.db, scenario.run.asOf);
    const imported = await saveFinancialEngineSource(
      context.db,
      ownerId,
      scenario,
      scenario.run.asOf,
    );
    expect(imported.inputVersion).toBe(1n);
    await context.db.delete(planningContexts).where(eq(planningContexts.ownerId, ownerId));
    await context.db.delete(evaluationProfiles).where(eq(evaluationProfiles.ownerId, ownerId));

    const now = '2026-10-05T08:00:00Z';
    const command = await executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'engine_profile_bootstrap',
        idempotencyKey: 'engine-profile-worker-publication',
        request: { reason: 'integration verification' },
        asOf: now,
        effectiveDate: '2026-10-05',
        now,
      },
      (tx) =>
        bootstrapConservativeEvaluationProfile(tx, ownerId, {
          reason: 'integration verification',
          asOf: now,
          effectiveDate: '2026-10-05',
        }),
    );
    expect(command).toMatchObject({ inputVersion: 2n, replayed: false, mutated: true });

    await boss.work<RecalculationJob>(JOB_QUEUES.recalculate, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await processRecalculationJob(context.db, boss, job);
    });
    const deadline = Date.now() + 20_000;
    let status: string | undefined;
    while (Date.now() < deadline) {
      status = (
        await context.db.query.recalculationRecords.findFirst({
          where: and(
            eq(recalculationRecords.ownerId, ownerId),
            eq(recalculationRecords.inputVersion, 2n),
          ),
        })
      )?.status;
      if (status === 'completed' || status === 'failed' || status === 'superseded') break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
    }
    expect(status).toBe('completed');

    const runs = await context.db
      .select()
      .from(engineRuns)
      .where(
        and(
          eq(engineRuns.ownerId, ownerId),
          eq(engineRuns.inputVersion, 2n),
          eq(engineRuns.status, 'completed'),
        ),
      );
    expect(runs).toHaveLength(1);
    const snapshots = await context.db
      .select()
      .from(metricSnapshots)
      .where(eq(metricSnapshots.engineRunId, runs[0]!.id));
    expect(snapshots).toHaveLength(11);
    expect(snapshots.every((snapshot) => snapshot.isAuthoritative)).toBe(true);
    expect(snapshots.some((snapshot) => snapshot.status !== 'complete')).toBe(true);
  });
});
