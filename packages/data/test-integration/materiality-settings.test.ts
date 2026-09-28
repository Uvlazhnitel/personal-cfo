import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  appendMaterialitySettingsVersion,
  auditEvents,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  decodeSourceJson,
  executeFinancialCommand,
  migrateDatabase,
  ownerInputVersions,
  recalculationRecords,
  settingsVersions,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('versioned materiality settings command', () => {
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

  async function change(
    ownerId: string,
    idempotencyKey: string,
    amountMinor: bigint,
    now: string,
    effectiveDate: string,
  ) {
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'settings_change',
        idempotencyKey,
        request: { amountMinor, currency: 'EUR', reason: 'owner-approved materiality change' },
        asOf: now,
        effectiveDate,
        now,
      },
      (tx) =>
        appendMaterialitySettingsVersion(tx, ownerId, {
          amountMinor,
          currency: 'EUR',
          effectiveAt: now,
          effectiveDate,
        }),
    );
  }

  it('creates, replays, rotates, audits, and owner-scopes materiality versions', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'settings-owner',
      password: 'a sufficiently long password',
    });
    const otherOwnerId = await createLocalUser(context.db, {
      loginName: 'settings-other-owner',
      password: 'a sufficiently long password',
    });
    const first = await change(
      ownerId,
      'settings-materiality-001',
      10_000n,
      '2026-09-28T12:00:00Z',
      '2026-09-28',
    );
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 1n });
    expect(first.result).toMatchObject({
      previousSettingsVersion: null,
      effectiveFrom: '2026-09-28',
      materialityThreshold: { amountMinor: '10000', currency: 'EUR' },
      unchanged: false,
    });

    const firstRows = await context.db
      .select()
      .from(settingsVersions)
      .where(eq(settingsVersions.ownerId, ownerId));
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]?.isCurrent).toBe(true);
    expect(decodeSourceJson(firstRows[0]?.payload)).toMatchObject({
      version: firstRows[0]?.version,
      effectiveFrom: '2026-09-28',
      spendingBaseline: {
        materialityThreshold: { amountMinor: 10_000n, currency: 'EUR' },
      },
    });
    expect(
      await context.db
        .select()
        .from(settingsVersions)
        .where(eq(settingsVersions.ownerId, otherOwnerId)),
    ).toEqual([]);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toHaveLength(1);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(eq(recalculationRecords.ownerId, ownerId)),
    ).toMatchObject([{ cause: 'settings_change', inputVersion: 1n }]);

    const replay = await change(
      ownerId,
      'settings-materiality-001',
      10_000n,
      '2026-09-28T12:00:00Z',
      '2026-09-28',
    );
    expect(replay).toMatchObject({
      replayed: true,
      commandId: first.commandId,
      inputVersion: 1n,
    });
    expect(
      await context.db.select().from(settingsVersions).where(eq(settingsVersions.ownerId, ownerId)),
    ).toHaveLength(1);

    const unchanged = await change(
      ownerId,
      'settings-materiality-unchanged',
      10_000n,
      '2026-09-29T12:00:00Z',
      '2026-09-29',
    );
    expect(unchanged).toMatchObject({ mutated: false, inputVersion: 1n });
    expect(unchanged.result).toMatchObject({ unchanged: true });

    const second = await change(
      ownerId,
      'settings-materiality-002',
      20_000n,
      '2026-09-29T13:00:00Z',
      '2026-09-29',
    );
    expect(second).toMatchObject({ replayed: false, mutated: true, inputVersion: 2n });
    const rotated = await context.db
      .select()
      .from(settingsVersions)
      .where(eq(settingsVersions.ownerId, ownerId));
    expect(rotated).toHaveLength(2);
    expect(rotated.filter((row) => row.isCurrent)).toHaveLength(1);
    expect(rotated.find((row) => row.version === firstRows[0]?.version)?.isCurrent).toBe(false);

    const other = await change(
      otherOwnerId,
      'settings-materiality-other',
      5_000n,
      '2026-09-28T14:00:00Z',
      '2026-09-28',
    );
    expect(other).toMatchObject({ mutated: true, inputVersion: 1n });
    expect(
      await context.db.query.ownerInputVersions.findFirst({
        where: eq(ownerInputVersions.ownerId, ownerId),
      }),
    ).toMatchObject({ version: 2n });
    expect(
      await context.db.query.ownerInputVersions.findFirst({
        where: eq(ownerInputVersions.ownerId, otherOwnerId),
      }),
    ).toMatchObject({ version: 1n });
  });

  it('rejects a different version on the same Europe/Riga effective date', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'settings-date-conflict',
      password: 'a sufficiently long password',
    });
    await change(ownerId, 'settings-date-first', 10_000n, '2026-09-28T12:00:00Z', '2026-09-28');
    await expect(
      change(ownerId, 'settings-date-second', 20_000n, '2026-09-28T13:00:00Z', '2026-09-28'),
    ).rejects.toMatchObject({ code: 'settings.effective_date_conflict' });
    expect(
      await context.db.select().from(settingsVersions).where(eq(settingsVersions.ownerId, ownerId)),
    ).toHaveLength(1);
  });
});
