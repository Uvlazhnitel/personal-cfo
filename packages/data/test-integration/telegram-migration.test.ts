import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabaseContext, migrateDatabase } from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('Stage 5 to Stage 6 Telegram migration', () => {
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

  it('upgrades a Stage 5 database and remains repeatable', async () => {
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
    await writeFile(join(temporaryMigrations, 'meta/_journal.json'), JSON.stringify(fullJournal));
    await migrateDatabase(context.db, temporaryMigrations);
    await migrateDatabase(context.db, temporaryMigrations);

    const after = await context.pool.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name like 'telegram_%'",
    );
    expect(after.rows[0]?.count).toBe('7');
  });
});
