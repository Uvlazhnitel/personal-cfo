import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  accounts,
  auditEvents,
  bootstrapConservativeEvaluationProfile,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  decodeSourceJson,
  encodeSourceJson,
  evaluationProfiles,
  executeFinancialCommand,
  financialTransactions,
  generateUuidV7,
  migrateDatabase,
  ownerInputVersions,
  planningContexts,
  recalculationRecords,
  settingsVersions,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('conservative evaluation profile bootstrap command', () => {
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

  async function seedCanonicalOwner(loginName: string): Promise<string> {
    const ownerId = await createLocalUser(context.db, {
      loginName,
      password: 'a sufficiently long password',
    });
    const accountId = generateUuidV7('account');
    await context.db.insert(accounts).values({
      id: accountId,
      ownerId,
      kind: 'cash',
      valueSource: 'ledger',
      currency: 'EUR',
      payload: encodeSourceJson({ id: accountId }),
    });
    await context.db.insert(financialTransactions).values({
      id: generateUuidV7('transaction'),
      ownerId,
      createdAt: '2026-01-01T08:00:00Z',
    });
    const settingsVersion = generateUuidV7('settings-version');
    await context.db.insert(settingsVersions).values({
      ownerId,
      version: settingsVersion,
      effectiveFrom: '2026-01-01T00:00:00Z',
      payload: encodeSourceJson({ version: settingsVersion, effectiveFrom: '2026-01-01' }),
      isCurrent: true,
    });
    return ownerId;
  }

  async function bootstrap(ownerId: string, idempotencyKey: string) {
    const now = '2026-10-05T08:00:00Z';
    const request = {
      reason: 'Owner approved a conservative production engine profile.',
    };
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'engine_profile_bootstrap',
        idempotencyKey,
        request,
        asOf: now,
        effectiveDate: '2026-10-05',
        now,
      },
      (tx) =>
        bootstrapConservativeEvaluationProfile(tx, ownerId, {
          ...request,
          asOf: now,
          effectiveDate: '2026-10-05',
        }),
    );
  }

  it('initializes once, stays owner-scoped, enqueues atomically, and replays exactly', async () => {
    const ownerId = await seedCanonicalOwner('profile-bootstrap-owner');
    const otherOwnerId = await createLocalUser(context.db, {
      loginName: 'profile-bootstrap-other',
      password: 'a sufficiently long password',
    });

    const first = await bootstrap(ownerId, 'engine-profile-bootstrap-001');
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 1n });
    expect(first.result).toMatchObject({
      engineVersion: 'stage2g.1.0',
      conservativeCompleteness: true,
      historyStartInclusive: '2026-01-01T08:00:00Z',
    });

    const profile = await context.db.query.evaluationProfiles.findFirst({
      where: eq(evaluationProfiles.ownerId, ownerId),
    });
    expect(profile).toBeDefined();
    expect(decodeSourceJson(profile?.payload)).toMatchObject({
      sourceInputWatermark: `owner:${ownerId}:v1`,
      currentRecurringContribution: { amountMinor: 0n, currency: 'EUR' },
      rollingCcrPeriods: [],
      forwardProjection: {
        cashFlows: [],
        protectionDays: [],
        coverage: {
          expectedPrimarySalary: 'unavailable',
          normalSpending: 'unavailable',
          committedObligations: 'unavailable',
          sinkingProtection: 'unavailable',
        },
      },
      forecastPlan: { capitalFlows: [], plannedExpenses: [] },
    });
    const contexts = await context.db
      .select()
      .from(planningContexts)
      .where(eq(planningContexts.ownerId, ownerId));
    expect(contexts).toHaveLength(1);
    expect(decodeSourceJson(contexts[0]?.payload)).toMatchObject({
      recurringScheduleComplete: false,
      quality: {
        liquidBalance: 'unavailable',
        spendingClassification: 'unavailable',
        reservationHistory: 'unavailable',
      },
    });
    expect(
      await context.db
        .select()
        .from(evaluationProfiles)
        .where(eq(evaluationProfiles.ownerId, otherOwnerId)),
    ).toEqual([]);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(eq(recalculationRecords.ownerId, ownerId)),
    ).toMatchObject([{ cause: 'engine_profile_bootstrap', inputVersion: 1n, status: 'queued' }]);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toMatchObject([{ eventKind: 'engine_profile_bootstrap', entityType: 'evaluation_profile' }]);

    const replay = await bootstrap(ownerId, 'engine-profile-bootstrap-001');
    expect(replay).toMatchObject({
      replayed: true,
      commandId: first.commandId,
      inputVersion: 1n,
    });
    expect(
      await context.db
        .select()
        .from(ownerInputVersions)
        .where(eq(ownerInputVersions.ownerId, ownerId)),
    ).toMatchObject([{ version: 1n }]);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(eq(recalculationRecords.ownerId, ownerId)),
    ).toHaveLength(1);
  });

  it('fails closed when profile state exists under a different command key', async () => {
    const ownerId = await seedCanonicalOwner('profile-bootstrap-conflict');
    await bootstrap(ownerId, 'engine-profile-bootstrap-first');
    await expect(bootstrap(ownerId, 'engine-profile-bootstrap-second')).rejects.toMatchObject({
      code: 'engine_profile.already_initialized',
    });
  });

  it('requires canonical state and current settings', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'profile-bootstrap-empty',
      password: 'a sufficiently long password',
    });
    await expect(bootstrap(ownerId, 'engine-profile-bootstrap-empty')).rejects.toMatchObject({
      code: 'engine_profile.canonical_state_required',
    });
  });
});
