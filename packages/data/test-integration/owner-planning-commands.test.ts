import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import {
  EUR,
  STANDARD_SPENDING_CATEGORIES,
  createAccount,
  createAccountEntry,
  createCanonicalTransaction,
} from '@personal-cfo/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgBoss } from 'pg-boss';

import {
  accountEntries,
  accounts,
  appendExistingFlowSpendingObservation,
  auditEvents,
  createDatabaseContext,
  createJobBoss,
  createLocalUser,
  decodeSourceJson,
  economicFlows,
  encodeSourceJson,
  executeFinancialCommand,
  failRecalculationAfterRetryExhaustion,
  financialTransactions,
  flowClassifications,
  generateUuidV7,
  migrateDatabase,
  ownerInputVersions,
  planningContexts,
  recalculationRecords,
  settingsVersions,
  spendingObservations,
  transactionVersions,
  updateCurrentPlanningContext,
} from '../src/index.js';
import type { DatabaseContext, RecalculationCause } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('owner planning commands', () => {
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

  async function owner(loginName: string): Promise<string> {
    const ownerId = await createLocalUser(context.db, {
      loginName,
      password: 'a sufficiently long password',
    });
    await context.db.insert(settingsVersions).values({
      ownerId,
      version: 'settings-v1',
      effectiveFrom: '2026-07-01T00:00:00Z',
      payload: encodeSourceJson({
        version: 'settings-v1',
        effectiveFrom: '2026-07-01',
        spendingBaseline: { materialityThreshold: { amountMinor: 10_000n, currency: 'EUR' } },
        liquidity: { unknownIncomeHorizonDays: 31 },
      }),
      isCurrent: true,
    });
    await context.db.insert(planningContexts).values({
      ownerId,
      kind: 'current',
      checkpointKey: 'current',
      effectiveAt: '2026-10-01T00:00:00Z',
      payload: encodeSourceJson({
        monthCoverage: [],
        scheduledRecurring: [],
        recurringScheduleComplete: false,
        operationalNeeds: [],
        futureObligations: [],
        otherRestrictedCash: [],
        nextReliableIncomeDate: null,
        expectedPrimaryPaySchedule: { dates: [], completeThrough: '2026-10-01' },
        historyCoverage: {
          startInclusive: '2026-07-01T00:00:00Z',
          endExclusive: '2026-10-07T12:00:00Z',
        },
        reservationCoverage: {
          startInclusive: '2026-07-01T00:00:00Z',
          endExclusive: '2026-10-07T12:00:00.001Z',
        },
        quality: {
          liquidityInputs: {
            operationalNeeds: 'unavailable',
            obligations: 'unavailable',
            restrictedCash: 'unavailable',
          },
          liquidBalance: 'unavailable',
          spendingClassification: 'unavailable',
          reservationHistory: 'unavailable',
        },
      }),
    });
    return ownerId;
  }

  async function flow(
    ownerId: string,
    day: number,
    kind: 'consumption' | 'reimbursement' | 'other_external_flow',
    payload: Readonly<Record<string, unknown>>,
  ) {
    let account = await context.db.query.accounts.findFirst({
      where: eq(accounts.ownerId, ownerId),
    });
    if (account === undefined) {
      const value = createAccount({
        id: generateUuidV7(`owner-planning-account-${ownerId}`) as never,
        subtype: 'bank',
        currency: EUR,
        includeInNetWorth: true,
        valueSource: 'balance_snapshot',
        brokerageCashFor: null,
      });
      [account] = await context.db
        .insert(accounts)
        .values({
          id: value.id,
          ownerId,
          kind: value.subtype,
          valueSource: value.valueSource,
          currency: value.currency,
          payload: encodeSourceJson(value),
        })
        .returning();
    }
    const transactionId = generateUuidV7(`owner-planning-transaction-${ownerId}-${day}`);
    const flowId = generateUuidV7(`owner-planning-flow-${ownerId}-${day}`);
    const effectiveAt = `2026-09-${day.toString().padStart(2, '0')}T09:00:00Z`;
    const amountMinor = kind === 'reimbursement' ? 10_000n : -16_300n;
    const transaction = createCanonicalTransaction({
      id: transactionId as never,
      effectiveAt: effectiveAt as never,
      bookingStatus: 'booked',
      kind: 'external_flow',
      entries: [
        createAccountEntry({
          id: generateUuidV7(`owner-planning-entry-${ownerId}-${day}`) as never,
          transactionId: transactionId as never,
          accountId: account!.id as never,
          amount: { amountMinor, currency: EUR },
          role: 'external_flow',
        }),
      ],
    });
    await context.db.insert(financialTransactions).values({
      id: transactionId,
      ownerId,
      createdAt: effectiveAt,
    });
    await context.db.insert(transactionVersions).values({
      ownerId,
      transactionId,
      revision: 1,
      kind: 'external_flow',
      bookingStatus: 'booked',
      effectiveAt,
      payload: encodeSourceJson(transaction),
      isCurrent: true,
      supersededAt: null,
    });
    await context.db.insert(accountEntries).values({
      ownerId,
      transactionId,
      transactionRevision: 1,
      entryId: transaction.entries[0]!.id,
      accountId: account!.id,
      amountMinor,
      currency: 'EUR',
      role: 'external_flow',
    });
    await context.db.insert(economicFlows).values({
      id: flowId,
      ownerId,
      transactionId,
      effectiveAt,
      amountMinor: amountMinor < 0n ? -amountMinor : amountMinor,
      currency: 'EUR',
    });
    await context.db.insert(flowClassifications).values({
      ownerId,
      flowId,
      revision: 1,
      kind,
      source: 'user',
      reason: 'Test fixture',
      payload: encodeSourceJson(payload),
      decidedAt: effectiveAt,
      isCurrent: true,
    });
    return { flowId, transactionId };
  }

  function command(
    ownerId: string,
    kind: RecalculationCause,
    idempotencyKey: string,
    request: unknown,
    mutate: Parameters<typeof executeFinancialCommand>[3],
  ) {
    return executeFinancialCommand(
      context.db,
      boss,
      {
        ownerId,
        kind,
        idempotencyKey,
        request,
        asOf: '2026-10-07T12:00:00Z',
        effectiveDate: '2026-10-07',
        now: '2026-10-07T12:00:00Z',
      },
      mutate,
    );
  }

  it('attaches an observation to existing consumption and replays exactly', async () => {
    const ownerId = await owner('spending-observation-owner');
    const consumption = await flow(ownerId, 26, 'consumption', { reimbursable: true });
    const request = {
      economicFlowId: consumption.flowId,
      categoryCode: 'health' as const,
      cadence: 'variable' as const,
      irregular: true,
      reason: 'Owner confirmed doctor spending.',
    };
    const run = () =>
      command(ownerId, 'spending_observation', 'spending-observation-001', request, (tx) =>
        appendExistingFlowSpendingObservation(tx, ownerId, request),
      );
    const first = await run();
    const replay = await run();
    expect(first).toMatchObject({ replayed: false, inputVersion: 1n });
    expect(replay).toMatchObject({ replayed: true, commandId: first.commandId, inputVersion: 1n });
    expect(
      await context.db.query.spendingObservations.findFirst({
        where: and(
          eq(spendingObservations.ownerId, ownerId),
          eq(spendingObservations.economicFlowId, consumption.flowId),
        ),
      }),
    ).toMatchObject({
      categoryId: STANDARD_SPENDING_CATEGORIES.health.id,
      necessity: 'essential',
      cadence: 'variable',
      irregular: true,
      economicDate: '2026-09-26',
    });
    await expect(
      command(ownerId, 'spending_observation', 'spending-observation-duplicate', request, (tx) =>
        appendExistingFlowSpendingObservation(tx, ownerId, request),
      ),
    ).rejects.toMatchObject({ code: 'spending_observation.already_exists' });
  });

  it('inherits linked reimbursement semantics exactly', async () => {
    const ownerId = await owner('spending-reimbursement-owner');
    const original = await flow(ownerId, 26, 'consumption', { reimbursable: true });
    const reimbursement = await flow(ownerId, 24, 'reimbursement', {
      relatedTransactionId: original.transactionId,
    });
    const originalRequest = {
      economicFlowId: original.flowId,
      categoryCode: 'health' as const,
      cadence: 'variable' as const,
      irregular: true,
      reason: 'Owner confirmed doctor spending.',
    };
    await command(ownerId, 'spending_observation', 'spending-original-001', originalRequest, (tx) =>
      appendExistingFlowSpendingObservation(tx, ownerId, originalRequest),
    );
    const reversalRequest = {
      economicFlowId: reimbursement.flowId,
      reason: 'Owner confirmed linked reimbursement.',
    };
    await command(ownerId, 'spending_observation', 'spending-reversal-001', reversalRequest, (tx) =>
      appendExistingFlowSpendingObservation(tx, ownerId, reversalRequest),
    );
    const observations = await context.db
      .select()
      .from(spendingObservations)
      .where(eq(spendingObservations.ownerId, ownerId));
    expect(observations).toHaveLength(2);
    expect(observations.find((item) => item.economicFlowId === reimbursement.flowId)).toMatchObject(
      {
        categoryId: STANDARD_SPENDING_CATEGORIES.health.id,
        necessity: 'essential',
        cadence: 'variable',
        irregular: true,
        economicDate: '2026-09-24',
      },
    );
  });

  it('refuses missing and incompatible flows without incrementing the owner version', async () => {
    const ownerId = await owner('spending-invalid-owner');
    const foreignOwnerId = await owner('spending-foreign-owner');
    const foreign = await flow(foreignOwnerId, 19, 'consumption', { reimbursable: false });
    const incompatible = await flow(ownerId, 20, 'other_external_flow', {});
    for (const [key, flowId] of [
      ['spending-missing-001', generateUuidV7('missing-flow')],
      ['spending-foreign-001', foreign.flowId],
      ['spending-incompatible-001', incompatible.flowId],
    ] as const) {
      const request = {
        economicFlowId: flowId,
        categoryCode: 'other' as const,
        cadence: 'variable' as const,
        irregular: true,
        reason: 'Invalid test input.',
      };
      await expect(
        command(ownerId, 'spending_observation', key, request, (tx) =>
          appendExistingFlowSpendingObservation(tx, ownerId, request),
        ),
      ).rejects.toBeDefined();
    }
    expect(
      await context.db.query.ownerInputVersions.findFirst({
        where: eq(ownerInputVersions.ownerId, ownerId),
      }),
    ).toMatchObject({ version: 0n });
  });

  it('atomically records durable monthly declarations without canonical facts', async () => {
    const ownerId = await owner('planning-context-owner');
    const request = {
      scheduledRecurring: [
        {
          amountMinor: 1_999n,
          categoryCode: 'sport' as const,
          recurrence: { kind: 'monthly_day_of_month' as const, dayOfMonth: 3 },
        },
      ],
      recurringScheduleComplete: true,
      operationalNeeds: [],
      operationalNeedsComplete: true,
      futureObligations: [],
      obligationsComplete: true,
      otherRestrictedCash: [],
      restrictedCashComplete: true,
      primaryPaySchedule: { kind: 'monthly_day_of_month' as const, dayOfMonth: 5 },
      asOf: '2026-10-07T12:00:00Z',
      effectiveDate: '2026-10-07',
      reason: 'Owner confirmed current planning declarations.',
    };
    const run = () =>
      command(ownerId, 'planning_context_update', 'planning-context-001', request, (tx) =>
        updateCurrentPlanningContext(tx, ownerId, request),
      );
    const result = await run();
    const replay = await run();
    expect(result).toMatchObject({ replayed: false, inputVersion: 1n });
    expect(replay).toMatchObject({ replayed: true, commandId: result.commandId, inputVersion: 1n });
    const contextRow = await context.db.query.planningContexts.findFirst({
      where: eq(planningContexts.ownerId, ownerId),
    });
    expect(contextRow).toBeDefined();
    expect(decodeSourceJson(contextRow!.payload)).toMatchObject({
      recurringSpendingDeclarations: [
        {
          amountMinor: 1_999n,
          currency: 'EUR',
          categoryCode: 'sport',
          recurrence: { kind: 'monthly_day_of_month', dayOfMonth: 3 },
        },
      ],
      scheduledRecurring: [],
      recurringScheduleComplete: true,
      operationalNeeds: [],
      futureObligations: [],
      otherRestrictedCash: [],
      primaryPaySchedule: { kind: 'monthly_day_of_month', dayOfMonth: 5 },
      nextReliableIncomeDate: null,
      expectedPrimaryPaySchedule: { dates: [], completeThrough: '2026-10-07' },
      quality: {
        liquidityInputs: {
          operationalNeeds: 'complete',
          obligations: 'complete',
          restrictedCash: 'complete',
        },
      },
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
    expect(
      await context.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.commandId, result.commandId)),
    ).toMatchObject([{ eventKind: 'planning_context_update', entityType: 'planning_context' }]);
    expect(
      await context.db.query.transactionVersions.findMany({
        where: eq(transactionVersions.ownerId, ownerId),
      }),
    ).toHaveLength(0);
    expect(
      await context.db.query.economicFlows.findMany({ where: eq(economicFlows.ownerId, ownerId) }),
    ).toHaveLength(0);
  });

  it('terminalizes only queued or running recalculation records after retry exhaustion', async () => {
    const ownerId = await owner('retry-exhaustion-owner');
    const request = {
      scheduledRecurring: [],
      recurringScheduleComplete: false,
      operationalNeeds: [],
      operationalNeedsComplete: false,
      futureObligations: [],
      obligationsComplete: false,
      otherRestrictedCash: [],
      restrictedCashComplete: false,
      primaryPaySchedule: null,
      asOf: '2026-10-07T12:00:00Z',
      effectiveDate: '2026-10-07',
      reason: 'Preserve unknown declarations.',
    };
    await command(ownerId, 'planning_context_update', 'planning-retry-001', request, (tx) =>
      updateCurrentPlanningContext(tx, ownerId, request),
    );
    const unknownContext = await context.db.query.planningContexts.findFirst({
      where: eq(planningContexts.ownerId, ownerId),
    });
    expect(decodeSourceJson(unknownContext!.payload)).toMatchObject({
      operationalNeeds: [],
      futureObligations: [],
      otherRestrictedCash: [],
      quality: {
        liquidityInputs: {
          operationalNeeds: 'unavailable',
          obligations: 'unavailable',
          restrictedCash: 'unavailable',
        },
      },
    });
    const recalculation = await context.db.query.recalculationRecords.findFirst({
      where: eq(recalculationRecords.ownerId, ownerId),
    });
    expect(recalculation).toBeDefined();
    expect(
      await failRecalculationAfterRetryExhaustion(
        context.db,
        recalculation!.id,
        '2026-10-07T12:01:00Z',
      ),
    ).toBe(true);
    expect(
      await context.db.query.recalculationRecords.findFirst({
        where: eq(recalculationRecords.id, recalculation!.id),
      }),
    ).toMatchObject({
      status: 'failed',
      failureCategory: 'retry_exhausted',
      failureMessage: 'Recalculation retries were exhausted.',
    });
    expect(
      await failRecalculationAfterRetryExhaustion(
        context.db,
        recalculation!.id,
        '2026-10-07T12:02:00Z',
      ),
    ).toBe(false);
  });
});
