import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  auditEvents,
  claimTelegramDelivery,
  claimTelegramUpdate,
  completeTelegramDelivery,
  cashReconciliations,
  commandRecords,
  createDatabaseContext,
  createJobBoss,
  decodeSourceJson,
  economicFlows,
  engineRuns,
  ensureSyntheticOwner,
  expireTelegramState,
  financialTransactions,
  loadCanonicalFacts,
  loadSingleCashAccountState,
  migrateDatabase,
  ownerInputVersions,
  persistTelegramUpdatePage,
  primarySalaryTriggers,
  recordTelegramProcessingFailure,
  JOB_QUEUES,
  recalculationRecords,
  saveFinancialEngineSource,
  sinkingFunds,
  telegramPendingClarifications,
  telegramDeliveries,
  telegramUpdates,
  users,
} from '@personal-cfo/data';
import type { DatabaseContext, RecalculationJob } from '@personal-cfo/data';
import { normalizeTelegramUpdate } from '@personal-cfo/integrations';
import type { TelegramApi } from '@personal-cfo/integrations';
import { STANDARD_SPENDING_CATEGORIES } from '@personal-cfo/domain';
import { buildSyntheticScenario } from '../../../packages/financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import { processTelegramUpdate } from '../src/telegram/processor.js';
import { processRecalculationJob } from '../src/job-handlers.js';
import { startTelegramRuntime } from '../src/telegram/runtime.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;
const SOURCE = 'a'.repeat(64);
const ALLOWED = 123_456n;

suite('Telegram text input lifecycle', () => {
  let context: DatabaseContext;
  let boss: PgBoss;
  let ownerId: string;
  let nextUpdateId = 100n;
  let nextBotMessageId = 10_000n;
  let nowIndex = 0;

  const clock = {
    now: () => new Date(Date.UTC(2026, 8, 16, 11, nowIndex++)).toISOString(),
  };

  async function waitForRecalculation(id: string): Promise<void> {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      const record = await context.db.query.recalculationRecords.findFirst({
        where: eq(recalculationRecords.id, id),
      });
      if (record?.status === 'completed') return;
      if (record?.status === 'failed') throw new Error(`Recalculation ${id} failed.`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(`Timed out waiting for recalculation ${id}.`);
  }

  async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    throw new Error(`Timed out waiting for ${label}.`);
  }

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 12 });
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
    const scenario = buildSyntheticScenario('healthy_current');
    ownerId = await ensureSyntheticOwner(context.db, scenario.run.asOf);
    await saveFinancialEngineSource(context.db, ownerId, scenario, scenario.run.asOf);
    boss = createJobBoss(databaseUrl!, 3);
    await boss.start();
    await boss.work<RecalculationJob>(
      JOB_QUEUES.recalculate,
      { batchSize: 10, burstWhenBatchFull: true, pollingIntervalSeconds: 0.5 },
      async (jobs) => {
        for (const job of jobs) await processRecalculationJob(context.db, boss, job);
      },
    );
  });

  afterAll(async () => {
    await boss.stop({ graceful: true, timeout: 5_000, close: true });
    await context.close();
  });

  afterEach(() => vi.restoreAllMocks());

  function rawUpdate(
    text: string,
    updateId: bigint,
    options: Readonly<{ senderId?: bigint; replyToMessageId?: bigint }> = {},
  ) {
    return {
      update_id: Number(updateId),
      message: {
        message_id: Number(updateId + 1_000n),
        date: 1_789_555_200,
        text,
        chat: { id: Number(options.senderId ?? ALLOWED), type: 'private' },
        from: { id: Number(options.senderId ?? ALLOWED), is_bot: false },
        ...(options.replyToMessageId === undefined
          ? {}
          : { reply_to_message: { message_id: Number(options.replyToMessageId) } }),
      },
    };
  }

  async function persistAt(text: string, updateId: bigint, now: string): Promise<void> {
    await persistTelegramUpdatePage(context.db, {
      sourceKey: SOURCE,
      ownerId,
      allowedUserId: ALLOWED,
      updates: [normalizeTelegramUpdate(rawUpdate(text, updateId))],
      now,
    });
  }

  function failNextBossSends(failures: number): void {
    const send = vi.spyOn(boss, 'send');
    for (let index = 0; index < failures; index += 1) {
      send.mockRejectedValueOnce(new Error('Injected transient pg-boss send failure.'));
    }
  }

  async function ingest(
    text: string,
    options: Readonly<{
      updateId?: bigint;
      senderId?: bigint;
      replyToMessageId?: bigint;
      deliver?: boolean;
    }> = {},
  ) {
    const updateId = options.updateId ?? nextUpdateId++;
    const normalized = normalizeTelegramUpdate(
      rawUpdate(text, updateId, {
        ...(options.senderId === undefined ? {} : { senderId: options.senderId }),
        ...(options.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: options.replyToMessageId }),
      }),
    );
    const persisted = await persistTelegramUpdatePage(context.db, {
      sourceKey: SOURCE,
      ownerId,
      allowedUserId: ALLOWED,
      updates: [normalized],
      now: clock.now(),
    });
    const claimed = await claimTelegramUpdate(context.db, SOURCE, clock.now());
    if (claimed !== null) await processTelegramUpdate(context.db, boss, claimed, clock);
    const delivery = await claimTelegramDelivery(context.db, SOURCE, clock.now());
    let botMessageId: bigint | null = null;
    if (delivery !== null && options.deliver !== false) {
      botMessageId = nextBotMessageId++;
      await completeTelegramDelivery(context.db, {
        delivery,
        outcome: 'sent',
        botMessageId,
        now: clock.now(),
      });
    }
    return { updateId, inserted: persisted.inserted, claimed, delivery, botMessageId };
  }

  it('records one cash expense and replays the update without duplication', async () => {
    const before = await context.db.select().from(financialTransactions);
    const versionBefore = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    const first = await ingest('12 евро наличкой обед');
    expect(first.botMessageId).not.toBeNull();
    const replay = await ingest('12 евро наличкой обед', { updateId: first.updateId });
    expect(replay.inserted).toBe(0);
    expect(replay.claimed).toBeNull();
    const after = await context.db.select().from(financialTransactions);
    expect(after).toHaveLength(before.length + 1);
    const versionAfter = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(versionAfter!.version).toBe(versionBefore!.version + 1n);
    const update = await context.db.query.telegramUpdates.findFirst({
      where: and(
        eq(telegramUpdates.sourceKey, SOURCE),
        eq(telegramUpdates.updateId, first.updateId),
      ),
    });
    expect(update).toMatchObject({ status: 'completed', proposalKind: 'cash_expense' });
    expect(update?.messageText).toBeNull();
  });

  it('retries a rolled-back pg-boss enqueue and commits one financial effect', async () => {
    const updateId = nextUpdateId++;
    const firstAttemptAt = '2026-09-16T12:00:00.000Z';
    const retryAt = '2026-09-16T12:00:01.000Z';
    const transactionsBefore = await context.db.select().from(financialTransactions);
    const flowsBefore = await context.db.select().from(economicFlows);
    const recalculationsBefore = await context.db.select().from(recalculationRecords);
    const deliveriesBefore = await context.db.select().from(telegramDeliveries);
    const versionBefore = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    await persistAt('€13.37 cash groceries', updateId, firstAttemptAt);

    const firstClaim = await claimTelegramUpdate(context.db, SOURCE, firstAttemptAt);
    expect(firstClaim).toMatchObject({ updateId, attemptCount: 1 });
    failNextBossSends(1);
    await processTelegramUpdate(context.db, boss, firstClaim!, {
      now: () => firstAttemptAt,
    });
    const retryable = await context.db.query.telegramUpdates.findFirst({
      where: and(eq(telegramUpdates.sourceKey, SOURCE), eq(telegramUpdates.updateId, updateId)),
    });
    expect(retryable).toMatchObject({
      status: 'retryable',
      attemptCount: 1,
      safeErrorCategory: 'telegram_processing_failed',
    });
    expect(new Date(retryable!.nextProcessingAttemptAt!).toISOString()).toBe(retryAt);
    expect(retryable?.messageText).toBe('€13.37 cash groceries');
    expect(await claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:00:00.999Z')).toBeNull();

    const secondClaim = await claimTelegramUpdate(context.db, SOURCE, retryAt);
    expect(secondClaim).toMatchObject({ updateId, attemptCount: 2 });
    await processTelegramUpdate(context.db, boss, secondClaim!, { now: () => retryAt });

    expect(await context.db.select().from(financialTransactions)).toHaveLength(
      transactionsBefore.length + 1,
    );
    expect(await context.db.select().from(economicFlows)).toHaveLength(flowsBefore.length + 1);
    expect(await context.db.select().from(recalculationRecords)).toHaveLength(
      recalculationsBefore.length + 1,
    );
    expect(await context.db.select().from(telegramDeliveries)).toHaveLength(
      deliveriesBefore.length + 1,
    );
    const versionAfter = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(versionAfter?.version).toBe(versionBefore!.version + 1n);
    const commands = await context.db
      .select()
      .from(commandRecords)
      .where(
        and(
          eq(commandRecords.ownerId, ownerId),
          eq(commandRecords.idempotencyKey, `telegram:${SOURCE}:${updateId}:cash_expense`),
        ),
      );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ status: 'completed' });
    const completed = await context.db.query.telegramUpdates.findFirst({
      where: and(eq(telegramUpdates.sourceKey, SOURCE), eq(telegramUpdates.updateId, updateId)),
    });
    expect(completed).toMatchObject({ status: 'completed', attemptCount: 2 });
    expect(completed?.messageText).toBeNull();
    expect(completed?.nextProcessingAttemptAt).toBeNull();

    const delivery = await claimTelegramDelivery(context.db, SOURCE, retryAt);
    expect(delivery).not.toBeNull();
    await completeTelegramDelivery(context.db, {
      delivery: delivery!,
      outcome: 'sent',
      botMessageId: nextBotMessageId++,
      now: retryAt,
    });
  });

  it('exhausts three retryable processing attempts without a partial financial effect', async () => {
    const updateId = nextUpdateId++;
    const attemptTimes = [
      '2026-09-16T12:10:00.000Z',
      '2026-09-16T12:10:01.000Z',
      '2026-09-16T12:10:03.000Z',
    ] as const;
    const transactionsBefore = await context.db.select().from(financialTransactions);
    const flowsBefore = await context.db.select().from(economicFlows);
    const recalculationsBefore = await context.db.select().from(recalculationRecords);
    const versionBefore = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    await persistAt('€14.41 cash taxi', updateId, attemptTimes[0]);
    failNextBossSends(3);
    for (const [index, attemptAt] of attemptTimes.entries()) {
      const claimed = await claimTelegramUpdate(context.db, SOURCE, attemptAt);
      expect(claimed).toMatchObject({ updateId, attemptCount: index + 1 });
      await processTelegramUpdate(context.db, boss, claimed!, {
        now: () => attemptAt,
      });
    }

    const failed = await context.db.query.telegramUpdates.findFirst({
      where: and(eq(telegramUpdates.sourceKey, SOURCE), eq(telegramUpdates.updateId, updateId)),
    });
    expect(failed).toMatchObject({
      status: 'failed',
      attemptCount: 3,
      safeErrorCategory: 'telegram_processing_failed',
    });
    expect(failed?.messageText).toBeNull();
    expect(failed?.nextProcessingAttemptAt).toBeNull();
    expect(await context.db.select().from(financialTransactions)).toHaveLength(
      transactionsBefore.length,
    );
    expect(await context.db.select().from(economicFlows)).toHaveLength(flowsBefore.length);
    expect(await context.db.select().from(recalculationRecords)).toHaveLength(
      recalculationsBefore.length,
    );
    const versionAfter = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(versionAfter?.version).toBe(versionBefore?.version);
    expect(
      await context.db
        .select()
        .from(commandRecords)
        .where(
          and(
            eq(commandRecords.ownerId, ownerId),
            eq(commandRecords.idempotencyKey, `telegram:${SOURCE}:${updateId}:cash_expense`),
          ),
        ),
    ).toHaveLength(0);
    expect(await claimTelegramUpdate(context.db, SOURCE, '2026-09-17T12:10:03.000Z')).toBeNull();
    const failureDelivery = await claimTelegramDelivery(
      context.db,
      SOURCE,
      '2026-09-16T12:10:03.000Z',
    );
    expect(failureDelivery).toMatchObject({
      updateId,
      text: 'I couldn’t process this entry. Please send it again.',
      attemptCount: 1,
    });
    await completeTelegramDelivery(context.db, {
      delivery: failureDelivery!,
      outcome: 'sent',
      botMessageId: nextBotMessageId++,
      now: '2026-09-16T12:10:03.000Z',
    });
  });

  it('expires retryable text after 24 hours without resurrecting the update', async () => {
    const updateId = nextUpdateId++;
    const receivedAt = '2026-09-16T12:15:00.000Z';
    await persistAt('€10 cash lunch', updateId, receivedAt);
    const claimed = await claimTelegramUpdate(context.db, SOURCE, receivedAt);
    expect(claimed).toMatchObject({ updateId, attemptCount: 1 });
    await recordTelegramProcessingFailure(
      context.db,
      claimed!,
      { kind: 'retryable', category: 'telegram_processing_failed' },
      receivedAt,
    );
    const expiredAt = '2026-09-17T12:15:00.001Z';
    await expireTelegramState(context.db, SOURCE, expiredAt);
    const expired = await context.db.query.telegramUpdates.findFirst({
      where: and(eq(telegramUpdates.sourceKey, SOURCE), eq(telegramUpdates.updateId, updateId)),
    });
    expect(expired).toMatchObject({
      status: 'expired',
      safeErrorCategory: 'retention_expired',
    });
    expect(expired?.messageText).toBeNull();
    expect(expired?.nextProcessingAttemptAt).toBeNull();
    expect(await claimTelegramUpdate(context.db, SOURCE, expiredAt)).toBeNull();
  });

  it('reclaims a stale processing lease and allows only one concurrent claim', async () => {
    const staleUpdateId = nextUpdateId++;
    await persistAt('€11 cash groceries', staleUpdateId, '2026-09-16T12:20:00.000Z');
    const abandoned = await claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:20:00.000Z');
    expect(abandoned).toMatchObject({ updateId: staleUpdateId, attemptCount: 1 });
    const reclaimed = await claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:25:00.001Z');
    expect(reclaimed).toMatchObject({ updateId: staleUpdateId, attemptCount: 2 });
    await processTelegramUpdate(context.db, boss, reclaimed!, {
      now: () => '2026-09-16T12:25:00.001Z',
    });

    const concurrentUpdateId = nextUpdateId++;
    await persistAt('€12 cash sport', concurrentUpdateId, '2026-09-16T12:30:00.000Z');
    const claims = await Promise.all([
      claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:30:00.000Z'),
      claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:30:00.000Z'),
    ]);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);
    const claimed = claims.find((claim) => claim !== null)!;
    expect(claimed).toMatchObject({ updateId: concurrentUpdateId, attemptCount: 1 });
    await processTelegramUpdate(context.db, boss, claimed, {
      now: () => '2026-09-16T12:30:00.000Z',
    });

    for (const updateId of [staleUpdateId, concurrentUpdateId]) {
      const rows = await context.db
        .select()
        .from(commandRecords)
        .where(
          and(
            eq(commandRecords.ownerId, ownerId),
            eq(commandRecords.idempotencyKey, `telegram:${SOURCE}:${updateId}:cash_expense`),
          ),
        );
      expect(rows).toHaveLength(1);
    }
    for (;;) {
      const delivery = await claimTelegramDelivery(context.db, SOURCE, '2026-09-16T12:30:00.000Z');
      if (delivery === null) break;
      await completeTelegramDelivery(context.db, {
        delivery,
        outcome: 'sent',
        botMessageId: nextBotMessageId++,
        now: '2026-09-16T12:30:00.000Z',
      });
    }
  });

  it('terminalizes a stale lease after all three claimed attempts are consumed', async () => {
    const updateId = nextUpdateId++;
    const claimTimes = [
      '2026-09-16T12:40:00.000Z',
      '2026-09-16T12:45:00.001Z',
      '2026-09-16T12:50:00.002Z',
    ] as const;
    await persistAt('€15 cash groceries', updateId, claimTimes[0]);
    for (const [index, claimAt] of claimTimes.entries()) {
      expect(await claimTelegramUpdate(context.db, SOURCE, claimAt)).toMatchObject({
        updateId,
        attemptCount: index + 1,
      });
    }
    expect(await claimTelegramUpdate(context.db, SOURCE, '2026-09-16T12:55:00.003Z')).toBeNull();
    const failed = await context.db.query.telegramUpdates.findFirst({
      where: and(eq(telegramUpdates.sourceKey, SOURCE), eq(telegramUpdates.updateId, updateId)),
    });
    expect(failed).toMatchObject({
      status: 'failed',
      attemptCount: 3,
      safeErrorCategory: 'processing_lease_exhausted',
    });
    expect(failed?.messageText).toBeNull();
    const delivery = await claimTelegramDelivery(context.db, SOURCE, '2026-09-16T12:55:00.003Z');
    expect(delivery).toMatchObject({ updateId });
    await completeTelegramDelivery(context.db, {
      delivery: delivery!,
      outcome: 'sent',
      botMessageId: nextBotMessageId++,
      now: '2026-09-16T12:55:00.003Z',
    });
  });

  it('records side-hustle income without a primary salary trigger', async () => {
    const before = await context.db.select().from(primarySalaryTriggers);
    await ingest('получил 120 евро наличными за подработку');
    const facts = await loadCanonicalFacts(context.db, ownerId);
    expect(facts.economicFlows.at(-1)).toMatchObject({
      kind: 'earned_income',
      source: 'side_hustle',
      amount: { amountMinor: 12_000n },
    });
    expect(await context.db.select().from(primarySalaryTriggers)).toHaveLength(before.length);
  });

  it('persists and resolves an income-source clarification exactly once', async () => {
    const first = await ingest('received €75 cash');
    expect(first.delivery).not.toBeNull();
    expect(
      await context.db
        .select()
        .from(telegramPendingClarifications)
        .where(eq(telegramPendingClarifications.status, 'active')),
    ).toHaveLength(1);
    await ingest('side hustle');
    expect(
      await context.db
        .select()
        .from(telegramPendingClarifications)
        .where(eq(telegramPendingClarifications.status, 'active')),
    ).toHaveLength(0);
    const facts = await loadCanonicalFacts(context.db, ownerId);
    expect(
      facts.economicFlows.filter(
        (flow) => flow.kind === 'earned_income' && flow.amount.amountMinor === 7_500n,
      ),
    ).toHaveLength(1);
  });

  it('falls back to the owner locale when the message has no detectable language', async () => {
    await context.db.update(users).set({ locale: 'ru' }).where(eq(users.id, ownerId));
    try {
      const result = await ingest('12.50');
      expect(result.delivery?.text).toContain('Это расход');
      await ingest('/cancel');
    } finally {
      await context.db.update(users).set({ locale: 'en' }).where(eq(users.id, ownerId));
    }
  });

  it('cancels clarification without a financial mutation', async () => {
    const before = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    await ingest('received €33 cash');
    await ingest('/cancel');
    const after = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(after?.version).toBe(before?.version);
  });

  it('bounds clarification invalid attempts, supersession, and expiry', async () => {
    await ingest('received €31 cash');
    await ingest('not that');
    let active = await context.db
      .select()
      .from(telegramPendingClarifications)
      .where(eq(telegramPendingClarifications.status, 'active'));
    expect(active).toHaveLength(1);
    expect(active[0]?.invalidAttempts).toBe(1);
    await ingest('still unclear');
    active = await context.db
      .select()
      .from(telegramPendingClarifications)
      .where(eq(telegramPendingClarifications.status, 'active'));
    expect(active).toHaveLength(0);

    await ingest('received €32 cash');
    await ingest('€4 cash taxi');
    expect(
      await context.db
        .select()
        .from(telegramPendingClarifications)
        .where(eq(telegramPendingClarifications.status, 'active')),
    ).toHaveLength(0);

    await ingest('received €33 cash');
    nowIndex += 16;
    await expireTelegramState(context.db, SOURCE, clock.now());
    const expired = await context.db
      .select()
      .from(telegramPendingClarifications)
      .where(eq(telegramPendingClarifications.status, 'expired'));
    expect(expired.length).toBeGreaterThan(0);
    expect(expired.every((clarification) => clarification.knownFields === null)).toBe(true);
  });

  it('creates a manual-allocation future expense', async () => {
    const before = await context.db.select().from(sinkingFunds);
    await ingest('future expense Japan €1500 by 2027-05-01');
    const after = await context.db.select().from(sinkingFunds);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      targetMinor: 150_000n,
      dueDate: '2027-05-01',
      allocationPolicy: 'manual',
      status: 'active',
    });
  });

  it('preserves future-expense intent through a missing-date clarification', async () => {
    const before = await context.db.select().from(sinkingFunds);
    const initial = await ingest('future expense Iceland €1800');
    const persistedInitial = await context.db.query.telegramUpdates.findFirst({
      where: and(
        eq(telegramUpdates.sourceKey, SOURCE),
        eq(telegramUpdates.updateId, initial.updateId),
      ),
    });
    expect(persistedInitial).toMatchObject({
      status: 'awaiting_clarification',
      proposalKind: 'future_expense',
    });
    expect(await context.db.select().from(sinkingFunds)).toHaveLength(before.length);

    await ingest('2027-06-01');
    const after = await context.db.select().from(sinkingFunds);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)).toMatchObject({
      targetMinor: 180_000n,
      dueDate: '2027-06-01',
      allocationPolicy: 'manual',
      status: 'active',
    });
    expect(decodeSourceJson(after.at(-1)!.payload)).toMatchObject({ label: 'Iceland' });
    const active = await context.db
      .select()
      .from(telegramPendingClarifications)
      .where(eq(telegramPendingClarifications.status, 'active'));
    expect(active).toHaveLength(0);
  });

  it('treats an exact cash count as no-change and records a nonzero reconciliation', async () => {
    const reconciliationsBefore = await context.db
      .select()
      .from(cashReconciliations)
      .where(eq(cashReconciliations.ownerId, ownerId));
    const state = await context.db.transaction((tx) =>
      loadSingleCashAccountState(tx, ownerId, new Date(1_789_555_200_000).toISOString()),
    );
    expect(state.balanceMinor).toBeGreaterThan(0n);
    const versionBefore = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    const auditsBefore = await context.db.select().from(auditEvents);
    const recalculationsBefore = await context.db.select().from(recalculationRecords);
    const transactionsBefore = await context.db.select().from(financialTransactions);
    const exact = `${state.balanceMinor / 100n}.${(state.balanceMinor % 100n).toString().padStart(2, '0')}`;
    await ingest(`cash count €${exact}`);
    const versionAfterMatch = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(versionAfterMatch?.version).toBe(versionBefore?.version);
    expect(await context.db.select().from(auditEvents)).toHaveLength(auditsBefore.length);
    expect(await context.db.select().from(recalculationRecords)).toHaveLength(
      recalculationsBefore.length,
    );
    expect(await context.db.select().from(financialTransactions)).toHaveLength(
      transactionsBefore.length,
    );

    const adjusted = state.balanceMinor + 100n;
    await ingest(`cash count €${adjusted / 100n}.${(adjusted % 100n).toString().padStart(2, '0')}`);
    const reconciliationsAfter = await context.db
      .select()
      .from(cashReconciliations)
      .where(eq(cashReconciliations.ownerId, ownerId));
    expect(reconciliationsAfter).toHaveLength(reconciliationsBefore.length + 1);
  });

  it('corrects a Telegram expense by replying to its confirmation', async () => {
    const original = await ingest('€12 lunch paid in cash');
    expect(original.botMessageId).not.toBeNull();
    await ingest('actually €15', { replyToMessageId: original.botMessageId! });
    const facts = await loadCanonicalFacts(context.db, ownerId);
    const relevant = facts.economicFlows.filter(
      (flow) =>
        (flow.kind === 'consumption' || flow.kind === 'refund') &&
        (flow.amount.amountMinor === 1_200n || flow.amount.amountMinor === 1_500n),
    );
    expect(
      relevant.some((flow) => flow.kind === 'refund' && flow.amount.amountMinor === 1_200n),
    ).toBe(true);
    expect(
      relevant.some((flow) => flow.kind === 'consumption' && flow.amount.amountMinor === 1_500n),
    ).toBe(true);
  });

  it('corrects expense date and category while preserving both prior facts', async () => {
    const dated = await ingest('€24 cash taxi');
    await ingest('date 2026-09-15', { replyToMessageId: dated.botMessageId! });
    const categorized = await ingest('€25 cash lunch');
    await ingest('category groceries', { replyToMessageId: categorized.botMessageId! });

    const facts = await loadCanonicalFacts(context.db, ownerId);
    expect(
      facts.economicFlows.some(
        (flow) =>
          flow.kind === 'consumption' &&
          flow.amount.amountMinor === 2_400n &&
          flow.effectiveAt === '2026-09-15T09:00:00Z',
      ),
    ).toBe(true);
    const categorizedConsumptionIds = new Set(
      facts.economicFlows
        .filter((flow) => flow.kind === 'consumption' && flow.amount.amountMinor === 2_500n)
        .map((flow) => flow.id),
    );
    expect(
      facts.spendingObservations.some(
        (observation) =>
          categorizedConsumptionIds.has(observation.economicFlowId) &&
          observation.categoryId === STANDARD_SPENDING_CATEGORIES.groceries.id,
      ),
    ).toBe(true);
  });

  it('cancels once and rejects a repeated correction through the old confirmation', async () => {
    const original = await ingest('€26 cash sport');
    await ingest('cancel', { replyToMessageId: original.botMessageId! });
    const factsAfterCancel = await loadCanonicalFacts(context.db, ownerId);
    expect(
      factsAfterCancel.economicFlows.filter(
        (flow) => flow.amount.amountMinor === 2_600n && flow.kind === 'refund',
      ),
    ).toHaveLength(1);
    const versionAfterCancel = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    const repeated = await ingest('cancel', { replyToMessageId: original.botMessageId! });
    const versionAfterRepeat = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(versionAfterRepeat?.version).toBe(versionAfterCancel?.version);
    const repeatedUpdate = await context.db.query.telegramUpdates.findFirst({
      where: and(
        eq(telegramUpdates.sourceKey, SOURCE),
        eq(telegramUpdates.updateId, repeated.updateId),
      ),
    });
    expect(repeatedUpdate?.status).toBe('unsupported');
  });

  it('corrects a cash-income source through its recorded confirmation', async () => {
    const original = await ingest('received €27 cash from side hustle');
    await ingest('other', { replyToMessageId: original.botMessageId! });
    const facts = await loadCanonicalFacts(context.db, ownerId);
    expect(
      facts.economicFlows.some(
        (flow) =>
          flow.kind === 'earned_income' &&
          flow.amount.amountMinor === -2_700n &&
          flow.source === 'side_hustle',
      ),
    ).toBe(true);
    expect(
      facts.economicFlows.some(
        (flow) =>
          flow.kind === 'earned_income' &&
          flow.amount.amountMinor === 2_700n &&
          flow.source === 'other',
      ),
    ).toBe(true);
  });

  it('rejects an unauthorized sender before parsing or mutation', async () => {
    const before = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    const result = await ingest('€50 cash lunch', { senderId: 999n });
    expect(result.claimed).toBeNull();
    expect(result.delivery).toBeNull();
    const after = await context.db.query.ownerInputVersions.findFirst({
      where: eq(ownerInputVersions.ownerId, ownerId),
    });
    expect(after?.version).toBe(before?.version);
  });

  it('replays the durable inbox before polling, advances offsets, and aborts shutdown polling', async () => {
    const runtimeSource = 'b'.repeat(64);
    await persistTelegramUpdatePage(context.db, {
      sourceKey: runtimeSource,
      ownerId,
      allowedUserId: ALLOWED,
      updates: [normalizeTelegramUpdate(rawUpdate('/help', 99n))],
      now: clock.now(),
    });
    const offsets: Array<bigint | null> = [];
    let replayedBeforePoll = false;
    let sends = 0;
    let aborted = false;
    const api: TelegramApi = {
      getUpdates: async (request) => {
        offsets.push(request.offset);
        if (offsets.length === 1) {
          const replayed = await context.db.query.telegramUpdates.findFirst({
            where: and(
              eq(telegramUpdates.sourceKey, runtimeSource),
              eq(telegramUpdates.updateId, 99n),
            ),
          });
          replayedBeforePoll = replayed?.status === 'completed';
          return [{ update_id: 100 }, { update_id: 101 }];
        }
        return new Promise((resolvePromise) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolvePromise([]);
            },
            { once: true },
          );
        });
      },
      sendMessage: () => {
        sends += 1;
        return Promise.resolve({ messageId: 20_000n });
      },
    };
    const runtime = await startTelegramRuntime(context.db, boss, () => undefined, {
      configuration: {
        enabled: true,
        token: `123456:${'a'.repeat(32)}`,
        sourceKey: runtimeSource,
        allowedUserId: ALLOWED,
        ownerId,
      },
      api,
      clock,
      sleeper: () => Promise.resolve(),
    });
    await waitUntil(() => offsets.length >= 2, 'the second Telegram poll');
    await runtime.stop();
    expect(replayedBeforePoll).toBe(true);
    expect(offsets.slice(0, 2)).toEqual([100n, 102n]);
    expect(sends).toBe(1);
    expect(aborted).toBe(true);
  });

  it('shortens long polling when a durable processing retry is due', async () => {
    const retrySource = 'c'.repeat(64);
    const updateId = 5_000n;
    const failedAt = '2026-09-16T13:00:00.000Z';
    await persistTelegramUpdatePage(context.db, {
      sourceKey: retrySource,
      ownerId,
      allowedUserId: ALLOWED,
      updates: [normalizeTelegramUpdate(rawUpdate('€16 cash groceries', updateId))],
      now: failedAt,
    });
    const claimed = await claimTelegramUpdate(context.db, retrySource, failedAt);
    await recordTelegramProcessingFailure(
      context.db,
      claimed!,
      { kind: 'retryable', category: 'telegram_processing_failed' },
      failedAt,
    );
    const timeouts: number[] = [];
    let aborted = false;
    const api: TelegramApi = {
      getUpdates: (request) => {
        timeouts.push(request.timeoutSeconds);
        return new Promise((resolvePromise) => {
          request.signal?.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolvePromise([]);
            },
            { once: true },
          );
        });
      },
      sendMessage: () => Promise.resolve({ messageId: 30_000n }),
    };
    const runtime = await startTelegramRuntime(context.db, boss, () => undefined, {
      configuration: {
        enabled: true,
        token: `123456:${'a'.repeat(32)}`,
        sourceKey: retrySource,
        allowedUserId: ALLOWED,
        ownerId,
      },
      api,
      clock: { now: () => '2026-09-16T13:00:00.250Z' },
      sleeper: () => Promise.resolve(),
    });
    await waitUntil(() => timeouts.length === 1, 'the retry-bounded Telegram poll');
    await runtime.stop();
    expect(timeouts).toEqual([1]);
    expect(aborted).toBe(true);
  });

  it('serializes concurrent processing of the same claimed update', async () => {
    const updateId = nextUpdateId++;
    await persistTelegramUpdatePage(context.db, {
      sourceKey: SOURCE,
      ownerId,
      allowedUserId: ALLOWED,
      updates: [normalizeTelegramUpdate(rawUpdate('€9 cash groceries', updateId))],
      now: clock.now(),
    });
    const claimed = await claimTelegramUpdate(context.db, SOURCE, clock.now());
    expect(claimed).not.toBeNull();
    const before = await context.db.select().from(recalculationRecords);
    await Promise.all([
      processTelegramUpdate(context.db, boss, claimed!, clock),
      processTelegramUpdate(context.db, boss, claimed!, clock),
    ]);
    const after = await context.db.select().from(recalculationRecords);
    expect(after).toHaveLength(before.length + 1);
    const flows = await context.db
      .select()
      .from(economicFlows)
      .where(eq(economicFlows.amountMinor, 900n));
    expect(flows.filter((flow) => flow.ownerId === ownerId)).toHaveLength(1);
  });

  it('keeps recalculation durable even without a Telegram reply', async () => {
    const result = await ingest('€8 cash taxi', { deliver: false });
    expect(result.delivery).not.toBeNull();
    nowIndex += 6;
    await expireTelegramState(context.db, SOURCE, clock.now());
    const recoveredDelivery = await context.db.query.telegramDeliveries.findFirst({
      where: eq(telegramDeliveries.id, result.delivery!.id),
    });
    expect(recoveredDelivery).toMatchObject({
      status: 'uncertain',
      responseText: null,
      safeErrorCategory: 'delivery_interrupted',
    });
    const record = await context.db.query.recalculationRecords.findFirst({
      where: eq(recalculationRecords.ownerId, ownerId),
      orderBy: (table, { desc }) => [desc(table.createdAt)],
    });
    expect(record).toBeDefined();
    await waitForRecalculation(record!.id);
    expect(await context.db.select().from(engineRuns)).not.toHaveLength(0);
  }, 45_000);
});
