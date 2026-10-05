import { resolve } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  accountEntries,
  accounts,
  auditEvents,
  bootstrapCashAccount,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  decodeSourceJson,
  economicFlows,
  executeFinancialCommand,
  flowClassifications,
  financialTransactions,
  migrateDatabase,
  ownerInputVersions,
  recalculationRecords,
  transactionVersions,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('cash account bootstrap command', () => {
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

  async function createOwner(loginName: string): Promise<string> {
    return createLocalUser(context.db, {
      loginName,
      password: 'a sufficiently long password',
    });
  }

  async function bootstrap(ownerId: string, idempotencyKey: string) {
    const asOf = '2026-10-05T18:00:00Z';
    const request = {
      openingBalanceMinor: 12_500n,
      effectiveAt: '2026-07-01T00:00:00Z',
      reason: 'Owner confirmed the cash cutover balance.',
    };
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'cash_account_bootstrap',
        idempotencyKey,
        request,
        asOf,
        effectiveDate: '2026-10-05',
        now: asOf,
      },
      (tx) => bootstrapCashAccount(tx, ownerId, { ...request, asOf }),
    );
  }

  it('creates one owner-scoped account and neutral opening fact, then replays exactly', async () => {
    const ownerId = await createOwner('cash-bootstrap-owner');
    const otherOwnerId = await createOwner('cash-bootstrap-other');

    const first = await bootstrap(ownerId, 'cash-account-bootstrap-001');
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 1n });
    expect(first.result).toMatchObject({
      openingBalanceMinor: '12500',
      currency: 'EUR',
      effectiveAt: '2026-07-01T00:00:00Z',
    });

    const ownerAccounts = await context.db
      .select()
      .from(accounts)
      .where(eq(accounts.ownerId, ownerId));
    expect(ownerAccounts).toHaveLength(1);
    expect(ownerAccounts[0]).toMatchObject({
      kind: 'cash',
      valueSource: 'ledger',
      currency: 'EUR',
    });
    expect(decodeSourceJson(ownerAccounts[0]!.payload)).toMatchObject({
      subtype: 'cash',
      includeInNetWorth: true,
      valueSource: 'ledger',
      brokerageCashFor: null,
    });
    expect(
      await context.db.select().from(accounts).where(eq(accounts.ownerId, otherOwnerId)),
    ).toEqual([]);

    const transactions = await context.db
      .select()
      .from(transactionVersions)
      .where(eq(transactionVersions.ownerId, ownerId));
    expect(transactions).toMatchObject([
      {
        revision: 1,
        kind: 'opening_balance',
        bookingStatus: 'booked',
        effectiveAt: '2026-07-01 00:00:00+00',
        isCurrent: true,
      },
    ]);
    expect(
      await context.db.select().from(accountEntries).where(eq(accountEntries.ownerId, ownerId)),
    ).toMatchObject([{ amountMinor: 12_500n, currency: 'EUR', role: 'opening_balance' }]);
    expect(
      await context.db.select().from(economicFlows).where(eq(economicFlows.ownerId, ownerId)),
    ).toEqual([]);
    expect(
      await context.db
        .select()
        .from(flowClassifications)
        .where(eq(flowClassifications.ownerId, ownerId)),
    ).toEqual([]);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(eq(recalculationRecords.ownerId, ownerId)),
    ).toMatchObject([{ cause: 'cash_account_bootstrap', inputVersion: 1n, status: 'queued' }]);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toMatchObject([{ eventKind: 'cash_account_bootstrap', entityType: 'cash_account' }]);

    const replay = await bootstrap(ownerId, 'cash-account-bootstrap-001');
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
        .from(financialTransactions)
        .where(eq(financialTransactions.ownerId, ownerId)),
    ).toHaveLength(1);
  });

  it('allows only one concurrent initialization for an owner', async () => {
    const ownerId = await createOwner('cash-bootstrap-concurrent');
    const outcomes = await Promise.allSettled([
      bootstrap(ownerId, 'cash-account-bootstrap-concurrent-a'),
      bootstrap(ownerId, 'cash-account-bootstrap-concurrent-b'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: { code: 'cash_account.already_initialized' },
    });
    expect(
      await context.db.select().from(accounts).where(eq(accounts.ownerId, ownerId)),
    ).toHaveLength(1);
  });

  it('fails closed for an existing cash account and invalid cutover facts', async () => {
    const ownerId = await createOwner('cash-bootstrap-existing');
    await bootstrap(ownerId, 'cash-account-bootstrap-existing-first');
    await expect(
      bootstrap(ownerId, 'cash-account-bootstrap-existing-second'),
    ).rejects.toMatchObject({ code: 'cash_account.already_initialized' });

    const invalidOwnerId = await createOwner('cash-bootstrap-invalid');
    await expect(
      executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId: invalidOwnerId,
          kind: 'cash_account_bootstrap',
          idempotencyKey: 'cash-account-bootstrap-invalid',
          request: { openingBalanceMinor: 1n, effectiveAt: '2026-10-06T00:00:00Z' },
          asOf: '2026-10-05T18:00:00Z',
          effectiveDate: '2026-10-05',
          now: '2026-10-05T18:00:00Z',
        },
        (tx) =>
          bootstrapCashAccount(tx, invalidOwnerId, {
            openingBalanceMinor: 1n,
            effectiveAt: '2026-10-06T00:00:00Z',
            reason: 'future cutover',
            asOf: '2026-10-05T18:00:00Z',
          }),
      ),
    ).rejects.toMatchObject({ code: 'cash_account.future_effective_at' });
    await expect(
      context.db.transaction((tx) =>
        bootstrapCashAccount(tx, invalidOwnerId, {
          openingBalanceMinor: 1n,
          effectiveAt: '2026-13-01T00:00:00Z',
          reason: 'invalid date',
          asOf: '2026-10-05T18:00:00Z',
        }),
      ),
    ).rejects.toMatchObject({ code: 'cash_account.invalid_effective_at' });
    expect(
      await context.db.select().from(accounts).where(eq(accounts.ownerId, invalidOwnerId)),
    ).toEqual([]);
  });
});
