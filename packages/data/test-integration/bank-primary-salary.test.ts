import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import {
  EUR,
  createAccount,
  createAccountEntry,
  createCanonicalTransaction,
} from '@personal-cfo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  accountEntries,
  accounts,
  auditEvents,
  classifyBankTransactionAsPrimarySalary,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  economicFlows,
  encodeSourceJson,
  executeFinancialCommand,
  financialTransactions,
  flowAmbiguities,
  flowClassifications,
  generateUuidV7,
  migrateDatabase,
  ownerInputVersions,
  primarySalaryTriggers,
  recalculationRecords,
  transactionVersions,
} from '../src/index.js';
import type { DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('owner-confirmed bank primary salary classification', () => {
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

  async function importedCredit(ownerId: string, amountMinor: bigint) {
    const account = createAccount({
      id: generateUuidV7('salary-account') as never,
      subtype: 'bank',
      currency: EUR,
      includeInNetWorth: true,
      valueSource: 'balance_snapshot',
      brokerageCashFor: null,
    });
    const transactionId = generateUuidV7('salary-transaction');
    const effectiveAt = '2026-08-05T09:30:00Z';
    const transaction = createCanonicalTransaction({
      id: transactionId as never,
      effectiveAt: effectiveAt as never,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        createAccountEntry({
          id: generateUuidV7('salary-entry') as never,
          transactionId: transactionId as never,
          accountId: account.id,
          amount: { amountMinor, currency: EUR },
          role: 'external_flow',
        }),
      ],
    });
    await context.db.insert(accounts).values({
      id: account.id,
      ownerId,
      kind: account.subtype,
      valueSource: account.valueSource,
      currency: account.currency,
      payload: encodeSourceJson(account),
    });
    await context.db.insert(financialTransactions).values({
      id: transaction.id,
      ownerId,
      createdAt: effectiveAt,
    });
    await context.db.insert(transactionVersions).values({
      ownerId,
      transactionId: transaction.id,
      revision: 1,
      kind: transaction.kind,
      bookingStatus: transaction.bookingStatus,
      effectiveAt,
      payload: encodeSourceJson(transaction),
      isCurrent: true,
      supersededAt: null,
    });
    await context.db.insert(accountEntries).values({
      ownerId,
      transactionId: transaction.id,
      transactionRevision: 1,
      entryId: transaction.entries[0]!.id,
      accountId: account.id,
      amountMinor,
      currency: 'EUR',
      role: 'external_flow',
    });
    await context.db.insert(flowAmbiguities).values({
      id: transaction.id,
      ownerId,
      transactionId: transaction.id,
      kind: 'unclassified_external_flow',
      materiality: 'material',
      status: 'unresolved',
      evidence: encodeSourceJson({ provider: 'sanitized-fixture' }),
      effectiveAt,
      resolvedAt: null,
      resolver: null,
      reason: null,
    });
    return transaction.id;
  }

  async function run(ownerId: string, transactionId: string, idempotencyKey: string) {
    const now = '2026-10-06T08:00:00Z';
    const request = {
      transactionId,
      reason: 'Owner confirmed Stafferty primary salary receipt.',
    };
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'bank_primary_salary',
        idempotencyKey,
        request,
        asOf: now,
        effectiveDate: '2026-10-06',
        now,
      },
      (tx) => classifyBankTransactionAsPrimarySalary(tx, ownerId, { ...request, now }),
    );
  }

  it('creates one salary flow and primary trigger, resolves ambiguity, and replays exactly', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'salary-owner',
      password: 'a sufficiently long password',
    });
    const transactionId = await importedCredit(ownerId, 45_224n);

    const first = await run(ownerId, transactionId, 'bank-primary-salary-001');
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 1n });
    expect(first.result).toMatchObject({
      transactionId,
      earnedIncomeSource: 'salary',
      primarySalary: true,
      effectiveDate: '2026-08-05',
    });
    const flowId = first.result['flowId'];
    expect(typeof flowId).toBe('string');
    expect(
      await context.db.select().from(economicFlows).where(eq(economicFlows.ownerId, ownerId)),
    ).toMatchObject([{ transactionId, amountMinor: 45_224n, currency: 'EUR' }]);
    expect(
      await context.db
        .select()
        .from(flowClassifications)
        .where(eq(flowClassifications.ownerId, ownerId)),
    ).toMatchObject([
      { flowId, revision: 1, kind: 'earned_income', source: 'user', isCurrent: true },
    ]);
    expect(
      await context.db
        .select()
        .from(primarySalaryTriggers)
        .where(eq(primarySalaryTriggers.ownerId, ownerId)),
    ).toEqual([{ ownerId, transactionId, effectiveDate: '2026-08-05' }]);
    expect(
      await context.db.select().from(flowAmbiguities).where(eq(flowAmbiguities.ownerId, ownerId)),
    ).toMatchObject([{ transactionId, status: 'rejected_transfer', resolver: 'user' }]);

    const replay = await run(ownerId, transactionId, 'bank-primary-salary-001');
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
        .where(
          and(
            eq(recalculationRecords.ownerId, ownerId),
            eq(recalculationRecords.cause, 'bank_primary_salary'),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toMatchObject([{ eventKind: 'bank_primary_salary', entityType: 'economic_flow' }]);
    await expect(run(ownerId, transactionId, 'bank-primary-salary-other')).rejects.toMatchObject({
      code: 'bank_salary.not_unresolved',
    });
  });

  it('rejects a debit without advancing the input version', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'salary-debit-owner',
      password: 'a sufficiently long password',
    });
    const transactionId = await importedCredit(ownerId, -12_345n);
    await expect(run(ownerId, transactionId, 'bank-primary-salary-debit')).rejects.toMatchObject({
      code: 'bank_salary.invalid_credit',
    });
    expect(
      await context.db
        .select()
        .from(ownerInputVersions)
        .where(eq(ownerInputVersions.ownerId, ownerId)),
    ).toMatchObject([{ version: 0n }]);
  });
});
