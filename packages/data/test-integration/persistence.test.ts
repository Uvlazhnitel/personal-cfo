import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assembleFinancialEngineInput } from '../../../apps/worker/src/engine-input.js';
import { buildSyntheticScenario } from '../../financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import { evaluateFinancialState } from '../../financial-engine/src/index.js';
import {
  accounts,
  auditEvents,
  authenticate,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  encodeSourceJson,
  engineRuns,
  ensureSyntheticOwner,
  exactRateExamples,
  executeFinancialCommand,
  financialTransactions,
  findSession,
  generateUuidV7,
  hashPassword,
  jobInfrastructureReady,
  loadCanonicalFacts,
  migrateDatabase,
  ownerInputVersions,
  persistEngineResult,
  recalculationRecords,
  revokeSession,
  saveFinancialEngineSource,
  sessions,
  stringifySnapshot,
  verifyCsrf,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('PostgreSQL persistent financial pipeline', () => {
  let context: DatabaseContext;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 8 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    const migrations = resolve(process.cwd(), 'packages/data/migrations');
    await migrateDatabase(context.db, migrations);
    await migrateDatabase(context.db, migrations);
  });

  afterAll(async () => context.close());

  it('applies empty and repeated migrations and installs all queues', async () => {
    expect(await jobInfrastructureReady(context.db)).toBe(true);
    const migrations = await context.pool.query<{ count: string }>(
      'select count(*)::text as count from drizzle.__drizzle_migrations',
    );
    expect(migrations.rows[0]?.count).toBe('6');
  });

  it('round-trips bigint, UTC microseconds, and exact numeric strings', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'roundtrip',
      password: 'a sufficiently long password',
    });
    const rateId = generateUuidV7('rate');
    await context.db
      .insert(exactRateExamples)
      .values({ id: rateId, ownerId, value: '0.12345678901234567890123456789' });
    const rate = await context.db.query.exactRateExamples.findFirst({
      where: eq(exactRateExamples.id, rateId),
    });
    expect(rate?.value).toBe('0.12345678901234567890123456789');
    const temporal = await context.pool.query<{ value: string }>(
      "select to_char('2026-09-14T08:00:00.123456Z'::timestamptz at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as value",
    );
    expect(temporal.rows[0]?.value).toBe('2026-09-14T08:00:00.123456Z');
    const big = await context.pool.query<{ value: string }>('select $1::bigint::text as value', [
      '9007199254740993',
    ]);
    expect(big.rows[0]?.value).toBe('9007199254740993');
  });

  it('enforces owner-scoped references', async () => {
    const first = await createLocalUser(context.db, {
      loginName: 'owner-one',
      password: 'a sufficiently long password',
    });
    const second = await createLocalUser(context.db, {
      loginName: 'owner-two',
      password: 'a sufficiently long password',
    });
    const accountId = generateUuidV7('account');
    const transactionId = generateUuidV7('transaction');
    await context.db.insert(accounts).values({
      id: accountId,
      ownerId: first,
      kind: 'cash',
      valueSource: 'ledger',
      currency: 'EUR',
      payload: encodeSourceJson({ id: accountId }),
    });
    await context.db
      .insert(financialTransactions)
      .values({ id: transactionId, ownerId: first, createdAt: '2026-09-15T08:00:00Z' });
    await expect(
      context.pool.query(
        "insert into cash_reconciliations (id, owner_id, account_id, adjustment_transaction_id, calculated_minor, counted_minor, variance_minor, currency, materiality, reconciled_at, payload) values ($1,$2,$3,$4,0,1,1,'EUR','material',now(),'{}')",
        [generateUuidV7('cash-reconciliation'), second, accountId, transactionId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      context.pool.query(
        "insert into account_balance_snapshots (owner_id, account_id, source_as_of, received_at, stale_at, reportability_status, original_amount_minor, original_currency, reporting_amount_minor, reporting_currency, fx_rate_id) values ($1,$2,'2026-09-15T08:00:00Z','2026-09-15T08:00:00Z','2026-09-15T09:00:00Z','available',100,'EUR',100,'EUR',null)",
        [second, accountId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('creates, rotates, expires, revokes, and verifies secure sessions', async () => {
    let now = new Date('2026-09-15T08:00:00Z');
    const clock = { now: () => now };
    const ownerId = await createLocalUser(
      context.db,
      { loginName: 'AUTH_USER', password: 'correct horse battery staple' },
      clock,
    );
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,(?:p=1,t=3|t=3,p=1)\$/u);
    const first = await authenticate(
      context.db,
      'auth_user',
      'correct horse battery staple',
      clock,
    );
    expect(first?.ownerId).toBe(ownerId);
    expect(
      first === null
        ? false
        : verifyCsrf(
            {
              ownerId,
              sessionId: 'x',
              csrfHash: (await context.db.query.sessions.findFirst({
                where: eq(sessions.ownerId, ownerId),
              }))!.csrfHash,
            },
            first.csrfToken,
          ),
    ).toBe(true);
    const second = await authenticate(
      context.db,
      'auth_user',
      'correct horse battery staple',
      clock,
    );
    expect(await findSession(context.db, first!.sessionToken, clock)).toBeNull();
    expect(await findSession(context.db, second!.sessionToken, clock)).not.toBeNull();
    await revokeSession(context.db, second!.sessionToken, clock);
    expect(await findSession(context.db, second!.sessionToken, clock)).toBeNull();
    const third = await authenticate(
      context.db,
      'auth_user',
      'correct horse battery staple',
      clock,
    );
    now = new Date('2026-09-22T08:00:01Z');
    expect(await findSession(context.db, third!.sessionToken, clock)).toBeNull();
  });

  it('throttles repeated login failures in a deterministic window', async () => {
    let now = new Date('2026-09-15T09:00:00Z');
    const clock = { now: () => now };
    await createLocalUser(
      context.db,
      { loginName: 'throttled', password: 'correct horse battery staple' },
      clock,
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(await authenticate(context.db, 'throttled', 'incorrect password', clock)).toBeNull();
    }
    expect(
      await authenticate(context.db, 'throttled', 'correct horse battery staple', clock),
    ).toBeNull();
    now = new Date('2026-09-15T09:16:00Z');
    expect(
      await authenticate(context.db, 'throttled', 'correct horse battery staple', clock),
    ).not.toBeNull();
  });

  it('imports deterministically and reproduces the unchanged Stage 4 golden', async () => {
    const scenario = buildSyntheticScenario('healthy_current');
    const ownerId = await ensureSyntheticOwner(context.db, '2026-09-15T08:00:00Z');
    const first = await saveFinancialEngineSource(
      context.db,
      ownerId,
      scenario,
      '2026-09-15T08:00:00Z',
    );
    const second = await saveFinancialEngineSource(
      context.db,
      ownerId,
      scenario,
      '2026-09-15T08:01:00Z',
    );
    expect(first).toEqual({ changed: true, inputVersion: 1n });
    expect(second).toEqual({ changed: false, inputVersion: 1n });
    const assembled = await assembleFinancialEngineInput(context.db, {
      ownerId,
      expectedInputVersion: 1n,
      asOf: scenario.run.asOf,
      effectiveDate: scenario.run.effectiveDate,
      cause: 'synthetic_import',
    });
    expect(assembled.status).toBe('ready');
    if (assembled.status !== 'ready') throw new Error('Synthetic assembly was superseded.');
    expect((await loadCanonicalFacts(context.db, ownerId)).transactions).toHaveLength(
      scenario.canonical.transactions.length,
    );
    const result = evaluateFinancialState(assembled.input);
    expect(result).toEqual(evaluateFinancialState(scenario));
    const golden = await readFile(
      resolve(process.cwd(), 'packages/financial-engine/test/golden/healthy-current.stage2g1.json'),
      'utf8',
    );
    expect(stringifySnapshot(result)).toBe(golden);
    const persisted = await persistEngineResult(
      context.db,
      {
        ownerId,
        inputVersion: 1n,
        asOf: scenario.run.asOf,
        effectiveDate: scenario.run.effectiveDate,
        engineVersion: scenario.run.engineVersion,
        settingsVersion: scenario.run.settingsVersion,
        inputWatermark: scenario.run.inputWatermark,
        trigger: 'synthetic_import',
        earliestAffectedAt: null,
        startedAt: '2026-09-15T08:02:00Z',
        completedAt: '2026-09-15T08:02:01Z',
      },
      result,
    );
    expect(persisted).toMatchObject({ status: 'published', reused: false });
    if (persisted.status !== 'published') throw new Error('Synthetic run was superseded.');
    expect(
      await context.db.query.engineRuns.findFirst({ where: eq(engineRuns.id, persisted.runId) }),
    ).toMatchObject({ status: 'completed', inputWatermark: scenario.run.inputWatermark });
  });

  it('serializes command replay and rejects a conflicting payload', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'commands',
      password: 'a sufficiently long password',
    });
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const command = (request: unknown) =>
        executeFinancialCommand(
          context.db,
          boss,
          {
            ownerId,
            kind: 'manual_recalculate',
            idempotencyKey: 'stable-key-001',
            request,
            asOf: '2026-09-15T08:00:00Z',
            effectiveDate: '2026-09-15',
            now: '2026-09-15T08:00:00Z',
          },
          () =>
            Promise.resolve({
              entityType: 'test',
              entityId: ownerId,
              earliestAffectedAt: null,
              result: Object.freeze({ accepted: true }),
            }),
        );
      const first = await command({ value: 'same' });
      const replay = await command({ value: 'same' });
      expect(first.replayed).toBe(false);
      expect(replay).toMatchObject({
        replayed: true,
        commandId: first.commandId,
        inputVersion: first.inputVersion,
      });
      expect(
        await context.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.commandId, first.commandId)),
      ).toHaveLength(1);
      expect(
        await context.db
          .select()
          .from(recalculationRecords)
          .where(eq(recalculationRecords.ownerId, ownerId)),
      ).toHaveLength(1);
      const queued = await context.pool.query<{ count: string }>(
        "select count(*)::text as count from pgboss.job where name = 'financial.recalculate' and data->>'ownerId' = $1",
        [ownerId],
      );
      expect(queued.rows[0]?.count).toBe('1');
      await expect(command({ value: 'different' })).rejects.toMatchObject({
        code: 'command.payload_conflict',
      });
      const version = await context.db.query.ownerInputVersions.findFirst({
        where: eq(ownerInputVersions.ownerId, ownerId),
      });
      expect(version?.version).toBe(1n);

      let mutations = 0;
      const concurrent = () =>
        executeFinancialCommand(
          context.db,
          boss,
          {
            ownerId,
            kind: 'classification_correction',
            idempotencyKey: 'concurrent-key-001',
            request: { value: 'same' },
            asOf: '2026-09-15T08:00:00Z',
            effectiveDate: '2026-09-15',
            now: '2026-09-15T08:01:00Z',
          },
          () => {
            mutations += 1;
            return Promise.resolve({
              entityType: 'test',
              entityId: ownerId,
              earliestAffectedAt: null,
              result: Object.freeze({ accepted: true }),
            });
          },
        );
      const pair = await Promise.all([concurrent(), concurrent()]);
      expect(pair.map((item) => item.replayed).sort()).toEqual([false, true]);
      expect(mutations).toBe(1);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });
});
