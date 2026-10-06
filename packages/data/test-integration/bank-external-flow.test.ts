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
  classifyBankTransactionAsExternalFlow,
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
  investmentContributions,
  loadCanonicalFacts,
  migrateDatabase,
  ownerInputVersions,
  portfolioValuations,
  primarySalaryTriggers,
  recalculationRecords,
  spendingObservations,
  transactionVersions,
} from '../src/index.js';
import type { BankExternalFlowClassification, DatabaseContext } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('owner-confirmed bank external-flow classification', () => {
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

  async function importedExternal(ownerId: string, amountMinor: bigint, day: number) {
    let account = await context.db.query.accounts.findFirst({
      where: eq(accounts.ownerId, ownerId),
    });
    if (account === undefined) {
      const domain = createAccount({
        id: generateUuidV7(`bank-external-account-${ownerId}`) as never,
        subtype: 'bank',
        currency: EUR,
        includeInNetWorth: true,
        valueSource: 'balance_snapshot',
        brokerageCashFor: null,
      });
      [account] = await context.db
        .insert(accounts)
        .values({
          id: domain.id,
          ownerId,
          kind: domain.subtype,
          valueSource: domain.valueSource,
          currency: domain.currency,
          payload: encodeSourceJson(domain),
        })
        .returning();
    }
    const transactionId = generateUuidV7(`bank-external-transaction-${day}`);
    const effectiveAt = `2026-09-${String(day).padStart(2, '0')}T09:00:00Z`;
    const transaction = createCanonicalTransaction({
      id: transactionId as never,
      effectiveAt: effectiveAt as never,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        createAccountEntry({
          id: generateUuidV7(`bank-external-entry-${day}`) as never,
          transactionId: transactionId as never,
          accountId: account!.id as never,
          amount: { amountMinor, currency: EUR },
          role: 'external_flow',
        }),
      ],
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
      accountId: account!.id,
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

  function run(
    ownerId: string,
    transactionId: string,
    classification: BankExternalFlowClassification,
    idempotencyKey: string,
  ) {
    const now = '2026-10-06T10:00:00Z';
    const request = {
      transactionId,
      classification,
      reason: 'Owner confirmed the economic meaning.',
    };
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind: 'bank_external_flow',
        idempotencyKey,
        request,
        asOf: now,
        effectiveDate: '2026-10-06',
        now,
      },
      (tx) => classifyBankTransactionAsExternalFlow(tx, ownerId, { ...request, now }),
    );
  }

  it('classifies consumption atomically and replays exactly', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'bank-consumption-owner',
      password: 'a sufficiently long password',
    });
    const transactionId = await importedExternal(ownerId, -35_000n, 12);
    const first = await run(
      ownerId,
      transactionId,
      { kind: 'consumption', reimbursable: false },
      'bank-consumption-001',
    );
    expect(first).toMatchObject({ replayed: false, mutated: true, inputVersion: 1n });
    const replay = await run(
      ownerId,
      transactionId,
      { kind: 'consumption', reimbursable: false },
      'bank-consumption-001',
    );
    expect(replay).toMatchObject({ replayed: true, commandId: first.commandId, inputVersion: 1n });
    expect(
      await context.db.select().from(economicFlows).where(eq(economicFlows.ownerId, ownerId)),
    ).toMatchObject([{ transactionId, amountMinor: 35_000n, currency: 'EUR' }]);
    expect(
      await context.db
        .select()
        .from(flowClassifications)
        .where(eq(flowClassifications.ownerId, ownerId)),
    ).toMatchObject([{ revision: 1, kind: 'consumption', source: 'user', isCurrent: true }]);
    expect(
      await context.db.select().from(flowAmbiguities).where(eq(flowAmbiguities.ownerId, ownerId)),
    ).toMatchObject([{ transactionId, status: 'rejected_transfer', resolver: 'user' }]);
    expect(
      await context.db
        .select()
        .from(recalculationRecords)
        .where(
          and(
            eq(recalculationRecords.ownerId, ownerId),
            eq(recalculationRecords.cause, 'bank_external_flow'),
          ),
        ),
    ).toHaveLength(1);
    expect(
      await context.db.select().from(auditEvents).where(eq(auditEvents.commandId, first.commandId)),
    ).toMatchObject([{ eventKind: 'bank_external_flow', entityType: 'economic_flow' }]);
  });

  it('links a reimbursement only to reimbursable owner consumption', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'bank-reimbursement-owner',
      password: 'a sufficiently long password',
    });
    const doctor = await importedExternal(ownerId, -16_300n, 26);
    const reimbursement = await importedExternal(ownerId, 10_000n, 24);
    await run(ownerId, doctor, { kind: 'consumption', reimbursable: true }, 'bank-doctor-001');
    await run(
      ownerId,
      reimbursement,
      { kind: 'reimbursement', relatedTransactionId: doctor },
      'bank-reimbursement-001',
    );
    const canonical = await loadCanonicalFacts(context.db, ownerId);
    expect(canonical.economicFlows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transactionId: doctor, kind: 'consumption', reimbursable: true }),
        expect.objectContaining({
          transactionId: reimbursement,
          kind: 'reimbursement',
          relatedTransactionId: doctor,
        }),
      ]),
    );

    const excessive = await importedExternal(ownerId, 7_000n, 23);
    await expect(
      run(
        ownerId,
        excessive,
        { kind: 'reimbursement', relatedTransactionId: doctor },
        'bank-reimbursement-excessive-001',
      ),
    ).rejects.toMatchObject({ code: 'bank_external_flow.reversal_exceeds_consumption' });

    const otherOwner = await createLocalUser(context.db, {
      loginName: 'bank-cross-owner',
      password: 'a sufficiently long password',
    });
    const crossOwnerCredit = await importedExternal(otherOwner, 5_000n, 25);
    await expect(
      run(
        otherOwner,
        crossOwnerCredit,
        { kind: 'reimbursement', relatedTransactionId: doctor },
        'bank-cross-owner-001',
      ),
    ).rejects.toMatchObject({ code: 'bank_external_flow.invalid_related_transaction' });
  });

  it('preserves signed neutral flows without creating derived financial facts', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'bank-neutral-owner',
      password: 'a sufficiently long password',
    });
    const inflow = await importedExternal(ownerId, 20_000n, 14);
    const outflow = await importedExternal(ownerId, -13_180n, 15);
    await run(ownerId, inflow, { kind: 'other_external_flow' }, 'bank-neutral-in-001');
    await run(ownerId, outflow, { kind: 'other_external_flow' }, 'bank-neutral-out-001');
    expect(
      await context.db.select().from(economicFlows).where(eq(economicFlows.ownerId, ownerId)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ transactionId: inflow, amountMinor: 20_000n }),
        expect.objectContaining({ transactionId: outflow, amountMinor: -13_180n }),
      ]),
    );
    expect(
      await context.db
        .select()
        .from(primarySalaryTriggers)
        .where(eq(primarySalaryTriggers.ownerId, ownerId)),
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(spendingObservations)
        .where(eq(spendingObservations.ownerId, ownerId)),
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(investmentContributions)
        .where(eq(investmentContributions.ownerId, ownerId)),
    ).toHaveLength(0);
    expect(
      await context.db
        .select()
        .from(portfolioValuations)
        .where(eq(portfolioValuations.ownerId, ownerId)),
    ).toHaveLength(0);
  });

  it('rejects invalid signs and concurrent second classifications', async () => {
    const ownerId = await createLocalUser(context.db, {
      loginName: 'bank-conflict-owner',
      password: 'a sufficiently long password',
    });
    const credit = await importedExternal(ownerId, 10_000n, 20);
    await expect(
      run(ownerId, credit, { kind: 'consumption', reimbursable: false }, 'bank-invalid-sign-001'),
    ).rejects.toMatchObject({ code: 'bank_external_flow.invalid_consumption' });
    const results = await Promise.allSettled([
      run(ownerId, credit, { kind: 'other_external_flow' }, 'bank-concurrent-001'),
      run(ownerId, credit, { kind: 'other_external_flow' }, 'bank-concurrent-002'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await context.db
        .select()
        .from(ownerInputVersions)
        .where(eq(ownerInputVersions.ownerId, ownerId)),
    ).toMatchObject([{ version: 1n }]);
    expect(
      await context.db.select().from(economicFlows).where(eq(economicFlows.ownerId, ownerId)),
    ).toHaveLength(1);
  });
});
