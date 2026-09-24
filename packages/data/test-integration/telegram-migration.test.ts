import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseContext, migrateDatabase } from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('Stage 5 through Stage 7.2B migrations', () => {
  let context: DatabaseContext;
  let temporaryMigrations: string;
  const sourceMigrations = resolve(process.cwd(), 'packages/data/migrations');

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 4 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test') {
      throw new Error('Integration tests require the personal_cfo_test database.');
    }
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    temporaryMigrations = await mkdtemp(join(tmpdir(), 'personal-cfo-stage6-'));
    await mkdir(join(temporaryMigrations, 'meta'));
    const journal = JSON.parse(
      await readFile(join(sourceMigrations, 'meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ idx: number; tag: string }> };
    for (let index = 0; index <= 5; index += 1) {
      const filename = journal.entries.find((entry) => entry.idx === index)?.tag;
      if (typeof filename !== 'string') throw new Error(`Missing migration ${index}.`);
      await cp(
        join(sourceMigrations, `${filename}.sql`),
        join(temporaryMigrations, `${filename}.sql`),
      );
    }
    await writeFile(
      join(temporaryMigrations, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.filter((entry) => entry.idx <= 5) }),
    );
  });

  afterAll(async () => {
    await context.close();
    await rm(temporaryMigrations, { recursive: true, force: true });
  });

  it('upgrades Stage 5 through Stage 6 and Stage 6.1, then remains repeatable', async () => {
    await migrateDatabase(context.db, temporaryMigrations);
    const before = await context.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name like 'telegram_%'",
    );
    expect(before.rows).toEqual([]);

    const fullJournalPath = join(sourceMigrations, 'meta/_journal.json');
    const fullJournal = JSON.parse(await readFile(fullJournalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const stageSix = fullJournal.entries.find((entry) => entry.idx === 6);
    if (stageSix === undefined) throw new Error('Stage 6 migration is missing.');
    await cp(
      join(sourceMigrations, `${stageSix.tag}.sql`),
      join(temporaryMigrations, basename(`${stageSix.tag}.sql`)),
    );
    await writeFile(
      join(temporaryMigrations, 'meta/_journal.json'),
      JSON.stringify({
        ...fullJournal,
        entries: fullJournal.entries.filter((entry) => entry.idx <= 6),
      }),
    );
    await migrateDatabase(context.db, temporaryMigrations);

    const afterStageSix = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name like 'telegram_%'",
    );
    expect(afterStageSix.rows[0]?.count).toBe('7');
    const beforeRepair = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'telegram_updates' and column_name = 'next_processing_attempt_at'",
    );
    expect(beforeRepair.rows[0]?.count).toBe('0');

    const stageSixRepair = fullJournal.entries.find((entry) => entry.idx === 7);
    if (stageSixRepair === undefined) throw new Error('Stage 6.1 migration is missing.');
    await cp(
      join(sourceMigrations, `${stageSixRepair.tag}.sql`),
      join(temporaryMigrations, basename(`${stageSixRepair.tag}.sql`)),
    );
    await writeFile(
      join(temporaryMigrations, 'meta/_journal.json'),
      JSON.stringify({
        ...fullJournal,
        entries: fullJournal.entries.filter((entry) => entry.idx <= 7),
      }),
    );
    await migrateDatabase(context.db, temporaryMigrations);
    await migrateDatabase(context.db, temporaryMigrations);

    const afterRepair = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.columns where table_schema = 'public' and table_name = 'telegram_updates' and column_name = 'next_processing_attempt_at'",
    );
    expect(afterRepair.rows[0]?.count).toBe('1');

    const sharesight = fullJournal.entries.find((entry) => entry.idx === 8);
    if (sharesight === undefined) throw new Error('Stage 7.1 migration is missing.');
    await cp(
      join(sourceMigrations, `${sharesight.tag}.sql`),
      join(temporaryMigrations, basename(`${sharesight.tag}.sql`)),
    );
    await writeFile(
      join(temporaryMigrations, 'meta/_journal.json'),
      JSON.stringify({
        ...fullJournal,
        entries: fullJournal.entries.filter((entry) => entry.idx <= 8),
      }),
    );
    await migrateDatabase(context.db, temporaryMigrations);
    await migrateDatabase(context.db, temporaryMigrations);

    const sharesightTables = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name like 'sharesight_%'",
    );
    expect(sharesightTables.rows[0]?.count).toBe('4');

    await context.pool.query(`
      insert into users (id, login_name, password_hash, locale, time_zone, created_at, updated_at)
      values (
        '018f0000-0000-7000-8000-000000000991',
        'stage-71-upgrade',
        'not-used',
        'en',
        'Europe/Riga',
        '2026-09-23T00:00:00Z',
        '2026-09-23T00:00:00Z'
      );
      insert into accounts (id, owner_id, kind, value_source, currency, payload)
      values (
        '018f0000-0000-7000-8000-000000000992',
        '018f0000-0000-7000-8000-000000000991',
        'investment',
        'portfolio_valuation',
        'EUR',
        '{"includeInNetWorth":true}'::jsonb
      );
      insert into sharesight_sync_states (
        owner_id,
        provider_portfolio_id,
        investment_account_id,
        connection_id,
        created_at,
        updated_at
      ) values (
        '018f0000-0000-7000-8000-000000000991',
        '293304',
        '018f0000-0000-7000-8000-000000000992',
        'sharesight-upgrade-connection',
        '2026-09-23T00:00:00Z',
        '2026-09-23T00:00:00Z'
      );
    `);

    const portfolioManager = fullJournal.entries.find((entry) => entry.idx === 9);
    if (portfolioManager === undefined) throw new Error('Stage 7.2B migration is missing.');
    await cp(
      join(sourceMigrations, `${portfolioManager.tag}.sql`),
      join(temporaryMigrations, basename(`${portfolioManager.tag}.sql`)),
    );
    await writeFile(join(temporaryMigrations, 'meta/_journal.json'), JSON.stringify(fullJournal));
    await migrateDatabase(context.db, temporaryMigrations);
    await migrateDatabase(context.db, temporaryMigrations);

    const portfolioManagerTables = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name like 'portfolio_manager_%'",
    );
    expect(portfolioManagerTables.rows[0]?.count).toBe('4');
    const providerBinding = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name = 'portfolio_provider_bindings'",
    );
    expect(providerBinding.rows[0]?.count).toBe('1');
    const backfilledBinding = await context.pool.query<{
      provider: string;
      connection_id: string;
      provider_portfolio_id: string;
    }>(
      "select provider, connection_id, provider_portfolio_id from portfolio_provider_bindings where owner_id = '018f0000-0000-7000-8000-000000000991'",
    );
    expect(backfilledBinding.rows).toEqual([
      {
        provider: 'sharesight',
        connection_id: 'sharesight-upgrade-connection',
        provider_portfolio_id: '293304',
      },
    ]);
  });
});
