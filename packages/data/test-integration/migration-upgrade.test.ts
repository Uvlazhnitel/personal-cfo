import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSyntheticScenario } from '../../financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import {
  accounts,
  createDatabaseContext,
  economicFlows,
  encodeSourceJson,
  factPayloads,
  financialTransactions,
  flowClassifications,
  loadCanonicalFacts,
  migrateDatabase,
  ownerInputVersions,
  users,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('Stage 5 schema upgrade', () => {
  let context: DatabaseContext;
  let stage5Migrations: string;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 4 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    const migrations = resolve(process.cwd(), 'packages/data/migrations');
    stage5Migrations = await mkdtemp(join(tmpdir(), 'personal-cfo-stage5-'));
    await mkdir(join(stage5Migrations, 'meta'));
    const journal = JSON.parse(
      await readFile(join(migrations, 'meta', '_journal.json'), 'utf8'),
    ) as { version: string; dialect: string; entries: unknown[] };
    await writeFile(
      join(stage5Migrations, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, 5) }),
    );
    for (const file of [
      '0000_identity_auth_commands.sql',
      '0001_canonical_finance.sql',
      '0002_planning_reconciliation.sql',
      '0003_engine_snapshots.sql',
      '0004_pgboss_queues.sql',
    ]) {
      await cp(join(migrations, file), join(stage5Migrations, basename(file)));
    }
    await migrateDatabase(context.db, stage5Migrations);
  });

  afterAll(async () => {
    await context.close();
    await rm(stage5Migrations, { recursive: true, force: true });
  });

  it('backfills canonical JSON facts into dedicated relational tables', async () => {
    const scenario = buildSyntheticScenario('healthy_current');
    const ownerId = '018f0000-0000-7000-8000-000000000099';
    await context.db.insert(users).values({
      id: ownerId,
      loginName: 'stage5-upgrade',
      passwordHash: 'not-used',
      locale: 'en',
      timeZone: 'Europe/Riga',
      createdAt: scenario.run.asOf,
      updatedAt: scenario.run.asOf,
    });
    await context.db.insert(ownerInputVersions).values({
      ownerId,
      version: 1n,
      updatedAt: scenario.run.asOf,
    });

    const snapshot = scenario.canonical.accountBalanceSnapshots[0]!;
    const valuation = scenario.canonical.portfolioValuations[0]!;
    const contribution = scenario.canonical.investmentContributions[0]!;
    const attribution = scenario.canonical.contributionAttributions.find(
      (item) => item.transactionId === contribution.transactionId,
    )!;
    const salary = scenario.canonical.primarySalaryTriggers[0]!;
    const observation = scenario.canonical.spendingObservations[0]!;
    const flow = scenario.canonical.economicFlows.find(
      (item) => item.id === observation.economicFlowId,
    )!;
    const requiredAccountIds = new Set([
      snapshot.accountId,
      valuation.accountId,
      contribution.investmentAccountId,
    ]);
    await context.db.insert(accounts).values(
      scenario.canonical.accounts
        .filter((account) => requiredAccountIds.has(account.id))
        .map((account) => ({
          id: account.id,
          ownerId,
          kind: account.subtype,
          valueSource: account.valueSource,
          currency: account.currency,
          payload: encodeSourceJson(account),
        })),
    );
    const transactionIds = new Set([
      contribution.transactionId,
      salary.transactionId,
      flow.transactionId,
    ]);
    const transactionTimes = new Map(
      scenario.canonical.transactions
        .filter((transaction) => transactionIds.has(transaction.id))
        .map((transaction) => [transaction.id, transaction.effectiveAt]),
    );
    await context.db
      .insert(financialTransactions)
      .values(
        [...transactionIds].map((id) => ({ id, ownerId, createdAt: transactionTimes.get(id)! })),
      );
    await context.db.insert(economicFlows).values({
      id: flow.id,
      ownerId,
      transactionId: flow.transactionId,
      effectiveAt: flow.effectiveAt,
      amountMinor: flow.amount.amountMinor,
      currency: flow.amount.currency,
    });
    await context.db.insert(flowClassifications).values({
      ownerId,
      flowId: flow.id,
      revision: 1,
      kind: flow.kind,
      source: 'canonical_import',
      reason: null,
      payload: encodeSourceJson(flow),
      decidedAt: flow.effectiveAt,
      isCurrent: true,
    });
    await context.db.insert(factPayloads).values([
      {
        ownerId,
        factType: 'account_balance_snapshot',
        factId: `${snapshot.accountId}|${snapshot.sourceAsOf}`,
        effectiveAt: snapshot.sourceAsOf,
        payload: encodeSourceJson(snapshot),
      },
      {
        ownerId,
        factType: 'portfolio_valuation',
        factId: `${valuation.accountId}|${valuation.sourceAsOf}`,
        effectiveAt: valuation.sourceAsOf,
        payload: encodeSourceJson(valuation),
      },
      {
        ownerId,
        factType: 'investment_contribution',
        factId: contribution.transactionId,
        effectiveAt: contribution.effectiveAt,
        payload: encodeSourceJson(contribution),
      },
      {
        ownerId,
        factType: 'contribution_attribution',
        factId: attribution.transactionId,
        effectiveAt: null,
        payload: encodeSourceJson(attribution),
      },
      {
        ownerId,
        factType: 'primary_salary_trigger',
        factId: salary.transactionId,
        effectiveAt: null,
        payload: encodeSourceJson(salary),
      },
      {
        ownerId,
        factType: 'spending_observation',
        factId: observation.economicFlowId,
        effectiveAt: null,
        payload: encodeSourceJson(observation),
      },
    ]);

    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
    const facts = await loadCanonicalFacts(context.db, ownerId);
    expect(facts.accountBalanceSnapshots).toEqual([snapshot]);
    expect(facts.portfolioValuations).toEqual([valuation]);
    expect(facts.investmentContributions).toEqual([contribution]);
    expect(facts.contributionAttributions).toEqual([attribution]);
    expect(facts.primarySalaryTriggers).toEqual([salary]);
    expect(facts.spendingObservations).toEqual([observation]);
    expect(facts.economicFlows).toEqual([flow]);
    expect(
      await context.db.select().from(factPayloads).where(eq(factPayloads.ownerId, ownerId)),
    ).toEqual([]);
    await expect(
      context.db.insert(factPayloads).values({
        ownerId,
        factType: 'account_balance_snapshot',
        factId: 'legacy-write-after-upgrade',
        effectiveAt: snapshot.sourceAsOf,
        payload: encodeSourceJson(snapshot),
      }),
    ).rejects.toMatchObject({ cause: { code: '23514' } });
  });
});
