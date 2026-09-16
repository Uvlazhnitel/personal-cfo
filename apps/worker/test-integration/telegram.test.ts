import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditEvents,
  claimTelegramDelivery,
  claimTelegramUpdate,
  completeTelegramDelivery,
  cashReconciliations,
  createDatabaseContext,
  createJobBoss,
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
