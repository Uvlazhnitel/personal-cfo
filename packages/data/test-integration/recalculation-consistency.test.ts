import { resolve } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EUR,
  createCashReconciliation,
  createCashReconciliationResolution,
  createCanonicalTransaction,
  createEconomicFlow,
  createMoney,
  createSinkingFund,
  createSinkingFundAllocation,
} from '@personal-cfo/domain';

import { assembleFinancialEngineInput } from '../../../apps/worker/src/engine-input.js';
import {
  processAutomaticSinkingAllocationJob,
  processRecalculationJob,
} from '../../../apps/worker/src/job-handlers.js';
import { recalculateFinancialState } from '../../../apps/worker/src/recalculation.js';
import { buildSyntheticScenario } from '../../financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import { evaluateFinancialState } from '../../financial-engine/src/index.js';
import {
  appendClassificationCorrection,
  appendCashReconciliation,
  appendManualSinkingAllocation,
  appendReconciliationResolution,
  canonicalDatabaseInstant,
  createDatabaseContext,
  createJobBoss,
  ensureSyntheticOwner,
  executeFinancialCommand,
  flowClassifications,
  economicFlows,
  engineRuns,
  flowAmbiguities,
  generateUuidV7,
  metricSnapshots,
  migrateDatabase,
  ownerInputVersions,
  persistEngineResult,
  recalculationRecords,
  resolveTransferCandidate,
  saveFinancialEngineSource,
  sinkingEvents,
  sinkingRequirements,
  transactionVersions,
} from '../src/index.js';
import type { DatabaseContext, RecalculationJob } from '../src/index.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('recalculation publication consistency', () => {
  let context: DatabaseContext;

  beforeEach(async () => {
    context ??= createDatabaseContext(databaseUrl!, { maxConnections: 10 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
  });

  afterAll(async () => context?.close());

  async function seedSynthetic(
    scenarioId: Parameters<typeof buildSyntheticScenario>[0] = 'healthy_current',
    scenarioOverride?: ReturnType<typeof buildSyntheticScenario>,
  ) {
    const scenario = scenarioOverride ?? buildSyntheticScenario(scenarioId);
    const ownerId = await ensureSyntheticOwner(context.db, '2026-09-14T08:00:00Z');
    const saved = await saveFinancialEngineSource(
      context.db,
      ownerId,
      scenario,
      '2026-09-14T08:00:00Z',
    );
    const assembled = await assembleFinancialEngineInput(context.db, {
      ownerId,
      expectedInputVersion: saved.inputVersion,
      asOf: scenario.run.asOf,
      effectiveDate: scenario.run.effectiveDate,
      cause: 'synthetic_import',
    });
    if (assembled.status !== 'ready') throw new Error('Initial assembly was superseded.');
    const result = evaluateFinancialState(assembled.input);
    const publication = await persistEngineResult(
      context.db,
      {
        ownerId,
        inputVersion: saved.inputVersion,
        asOf: scenario.run.asOf,
        effectiveDate: scenario.run.effectiveDate,
        engineVersion: scenario.run.engineVersion,
        settingsVersion: scenario.run.settingsVersion,
        inputWatermark: scenario.run.inputWatermark,
        trigger: 'synthetic_import',
        earliestAffectedAt: null,
        startedAt: '2026-09-14T08:00:01Z',
        completedAt: '2026-09-14T08:00:02Z',
      },
      result,
    );
    if (publication.status !== 'published') throw new Error('Initial publication was superseded.');
    return { ownerId, scenario, runId: publication.runId, result };
  }

  function jobFromRecord(
    ownerId: string,
    record: typeof recalculationRecords.$inferSelect,
    asOf = '2026-09-14T09:00:00Z',
  ): RecalculationJob {
    return {
      requestId: record.id,
      ownerId,
      inputVersion: record.inputVersion.toString(),
      cause: record.cause as RecalculationJob['cause'],
      asOf,
      effectiveDate: '2026-09-14',
      earliestAffectedAt: record.earliestAffectedAt,
    };
  }

  async function recalculateVersion(ownerId: string, inputVersion: bigint, asOf: string) {
    const record = await context.db.query.recalculationRecords.findFirst({
      where: and(
        eq(recalculationRecords.ownerId, ownerId),
        eq(recalculationRecords.inputVersion, inputVersion),
      ),
    });
    if (record === undefined) throw new Error(`Missing recalculation record for v${inputVersion}.`);
    return recalculateFinancialState(context.db, jobFromRecord(ownerId, record, asOf));
  }

  it('marks an out-of-order old job superseded and publishes only the newest version', async () => {
    const { ownerId } = await seedSynthetic();
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const command = (key: string) =>
        executeFinancialCommand(
          context.db,
          boss,
          {
            ownerId,
            kind: 'manual_recalculate',
            idempotencyKey: key,
            request: { key },
            asOf: '2026-09-14T08:00:10Z',
            effectiveDate: '2026-09-14',
            now: '2026-09-14T08:00:10Z',
          },
          () =>
            Promise.resolve({
              entityType: 'test',
              entityId: ownerId,
              earliestAffectedAt: null,
              result: Object.freeze({ accepted: true }),
            }),
        );
      await command('version-race-a');
      await command('version-race-b');
      const records = await context.db.query.recalculationRecords.findMany({
        where: eq(recalculationRecords.ownerId, ownerId),
        orderBy: (table, { asc }) => [asc(table.inputVersion)],
      });
      expect(records.map((record) => record.inputVersion)).toEqual([2n, 3n]);
      const stale = await recalculateFinancialState(
        context.db,
        jobFromRecord(ownerId, records[0]!),
      );
      expect(stale).toMatchObject({
        status: 'superseded',
        requestedInputVersion: 2n,
        currentInputVersion: 3n,
      });
      const current = await recalculateFinancialState(
        context.db,
        jobFromRecord(ownerId, records[1]!),
      );
      expect(current.status).toBe('published');
      expect(
        (
          await context.db.query.recalculationRecords.findFirst({
            where: eq(recalculationRecords.id, records[0]!.id),
          })
        )?.status,
      ).toBe('superseded');
      const authoritative = await context.db
        .select()
        .from(metricSnapshots)
        .innerJoin(engineRuns, eq(engineRuns.id, metricSnapshots.engineRunId))
        .where(
          and(eq(metricSnapshots.ownerId, ownerId), eq(metricSnapshots.isAuthoritative, true)),
        );
      expect(authoritative.length).toBeGreaterThan(0);
      expect(new Set(authoritative.map((row) => row.engine_runs.inputVersion))).toEqual(
        new Set([3n]),
      );
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('rejects publication when the owner version advances after assembly', async () => {
    const { ownerId, scenario, runId } = await seedSynthetic();
    const assembled = await assembleFinancialEngineInput(context.db, {
      ownerId,
      expectedInputVersion: 1n,
      asOf: scenario.run.asOf,
      effectiveDate: scenario.run.effectiveDate,
      cause: 'synthetic_import',
    });
    if (assembled.status !== 'ready') throw new Error('Assembly was superseded too early.');
    const result = evaluateFinancialState(assembled.input);
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'manual_recalculate',
          idempotencyKey: 'publication-race',
          request: { mutation: true },
          asOf: '2026-09-14T08:00:20Z',
          effectiveDate: '2026-09-14',
          now: '2026-09-14T08:00:20Z',
        },
        () =>
          Promise.resolve({
            entityType: 'test',
            entityId: ownerId,
            earliestAffectedAt: null,
            result: Object.freeze({ accepted: true }),
          }),
      );
      const publication = await persistEngineResult(
        context.db,
        {
          ownerId,
          inputVersion: 1n,
          asOf: scenario.run.asOf,
          effectiveDate: scenario.run.effectiveDate,
          engineVersion: scenario.run.engineVersion,
          settingsVersion: scenario.run.settingsVersion,
          inputWatermark: scenario.run.inputWatermark,
          trigger: 'synthetic_import',
          earliestAffectedAt: null,
          startedAt: '2026-09-14T08:00:21Z',
          completedAt: '2026-09-14T08:00:22Z',
        },
        result,
      );
      expect(publication).toEqual({
        status: 'superseded',
        requestedInputVersion: 1n,
        currentInputVersion: 2n,
      });
      const authoritative = await context.db
        .select()
        .from(metricSnapshots)
        .where(
          and(eq(metricSnapshots.ownerId, ownerId), eq(metricSnapshots.isAuthoritative, true)),
        );
      expect(new Set(authoritative.map((snapshot) => snapshot.engineRunId))).toEqual(
        new Set([runId]),
      );
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('appends classification meaning while preserving relational flow identity', async () => {
    const { ownerId, scenario, runId } = await seedSynthetic();
    const flow = scenario.canonical.economicFlows.find(
      (candidate) => candidate.kind === 'consumption',
    );
    if (flow === undefined || flow.kind !== 'consumption') throw new Error('Missing consumption.');
    const baseBefore = await context.db.query.economicFlows.findFirst({
      where: and(eq(economicFlows.ownerId, ownerId), eq(economicFlows.id, flow.id)),
    });
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const command = await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'classification_correction',
          idempotencyKey: 'classification-life',
          request: { flowId: flow.id, reimbursable: !flow.reimbursable },
          asOf: '2026-09-14T08:00:30Z',
          effectiveDate: '2026-09-14',
          now: '2026-09-14T08:00:30Z',
        },
        (tx) =>
          appendClassificationCorrection(
            tx,
            ownerId,
            flow.id,
            { kind: 'consumption', reimbursable: !flow.reimbursable },
            '2026-09-14T08:00:30Z',
            'integration correction',
          ),
      );
      expect(command.inputVersion).toBe(2n);
      const revisions = await context.db
        .select()
        .from(flowClassifications)
        .where(
          and(eq(flowClassifications.ownerId, ownerId), eq(flowClassifications.flowId, flow.id)),
        );
      expect(revisions).toHaveLength(2);
      expect(revisions.filter((revision) => revision.isCurrent)).toHaveLength(1);
      expect(
        await context.db.query.economicFlows.findFirst({
          where: and(eq(economicFlows.ownerId, ownerId), eq(economicFlows.id, flow.id)),
        }),
      ).toEqual(baseBefore);
      const record = await context.db.query.recalculationRecords.findFirst({
        where: and(
          eq(recalculationRecords.ownerId, ownerId),
          eq(recalculationRecords.inputVersion, 2n),
        ),
      });
      if (record === undefined) throw new Error('Missing recalculation record.');
      expect(record.earliestAffectedAt).toBe(baseBefore?.effectiveAt);
      expect(
        (await recalculateFinancialState(context.db, jobFromRecord(ownerId, record))).status,
      ).toBe('published');
      const oldSnapshots = await context.db
        .select()
        .from(metricSnapshots)
        .where(eq(metricSnapshots.engineRunId, runId));
      expect(oldSnapshots.every((snapshot) => !snapshot.isAuthoritative)).toBe(true);
      expect(
        (
          await context.db.query.ownerInputVersions.findFirst({
            where: eq(ownerInputVersions.ownerId, ownerId),
          })
        )?.version,
      ).toBe(2n);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('resolves a transfer candidate, derives its cutoff, and publishes the replacement revision', async () => {
    const { ownerId, scenario } = await seedSynthetic('material_transfer_unresolved');
    const ambiguity = scenario.canonical.ambiguities[0];
    if (ambiguity === undefined) throw new Error('Missing unresolved transfer fixture.');
    const resolved = buildSyntheticScenario('material_transfer_resolved_variant');
    const replacement = resolved.canonical.transactions.find(
      (transaction) => transaction.id === ambiguity.transactionId,
    );
    if (replacement === undefined) throw new Error('Missing confirmed transfer replacement.');
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const command = await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'transfer_resolution',
          idempotencyKey: 'transfer-resolution-life',
          request: { candidateId: ambiguity.transactionId, resolution: 'confirmed_transfer' },
          asOf: '2026-09-14T09:10:00Z',
          effectiveDate: '2026-09-14',
          now: '2026-09-14T09:10:00Z',
        },
        (tx) =>
          resolveTransferCandidate(
            tx,
            ownerId,
            ambiguity.transactionId,
            'confirmed_transfer',
            '2026-09-14T09:10:00Z',
            'confirmed by integration test',
            replacement,
          ),
      );
      expect(command.inputVersion).toBe(2n);
      const record = await context.db.query.recalculationRecords.findFirst({
        where: and(
          eq(recalculationRecords.ownerId, ownerId),
          eq(recalculationRecords.inputVersion, 2n),
        ),
      });
      expect(canonicalDatabaseInstant(record!.earliestAffectedAt!)).toBe(ambiguity.effectiveAt);
      expect(
        await context.db.query.flowAmbiguities.findFirst({
          where: and(
            eq(flowAmbiguities.ownerId, ownerId),
            eq(flowAmbiguities.id, ambiguity.transactionId),
          ),
        }),
      ).toMatchObject({ status: 'confirmed_transfer' });
      const revisions = await context.db
        .select()
        .from(transactionVersions)
        .where(
          and(
            eq(transactionVersions.ownerId, ownerId),
            eq(transactionVersions.transactionId, ambiguity.transactionId),
          ),
        );
      expect(revisions).toHaveLength(2);
      expect(revisions.find((revision) => revision.isCurrent)).toMatchObject({
        revision: 2,
        kind: 'internal_transfer',
      });
      expect((await recalculateVersion(ownerId, 2n, '2026-09-14T09:11:00Z')).status).toBe(
        'published',
      );
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('publishes a manual Sinking allocation with a due-to-reserved protection swap', async () => {
    const { ownerId, scenario } = await seedSynthetic();
    const fund = scenario.canonical.sinkingFunds.find(
      (candidate) => candidate.label === 'Annual insurance',
    );
    if (fund === undefined) throw new Error('Missing current Sinking Fund.');
    const before = await context.db.query.sinkingRequirements.findFirst({
      where: and(
        eq(sinkingRequirements.ownerId, ownerId),
        eq(sinkingRequirements.fundId, fund.id),
        eq(sinkingRequirements.isAuthoritative, true),
      ),
    });
    if (before === undefined) throw new Error('Missing initial Sinking requirement.');
    const allocation = createSinkingFundAllocation({
      id: generateUuidV7('integration-sinking-allocation') as never,
      fundId: fund.id,
      kind: 'allocation',
      amount: createMoney(3_334n, EUR),
      effectiveAt: '2026-09-14T09:20:00Z' as never,
    });
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const command = await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'sinking_allocation',
          idempotencyKey: 'manual-sinking-life',
          request: { allocation },
          asOf: '2026-09-14T09:20:00Z',
          effectiveDate: '2026-09-14',
          now: '2026-09-14T09:20:00Z',
        },
        (tx, commandId) => appendManualSinkingAllocation(tx, ownerId, allocation, commandId),
      );
      expect(command.inputVersion).toBe(2n);
      expect(
        await context.db.query.sinkingEvents.findFirst({
          where: and(eq(sinkingEvents.ownerId, ownerId), eq(sinkingEvents.id, allocation.id)),
        }),
      ).toMatchObject({ amountMinor: 3_334n, commandId: command.commandId });
      expect((await recalculateVersion(ownerId, 2n, '2026-09-14T09:21:00Z')).status).toBe(
        'published',
      );
      const after = await context.db.query.sinkingRequirements.findFirst({
        where: and(
          eq(sinkingRequirements.ownerId, ownerId),
          eq(sinkingRequirements.fundId, fund.id),
          eq(sinkingRequirements.isAuthoritative, true),
        ),
      });
      if (after === undefined) throw new Error('Missing replacement Sinking requirement.');
      expect(after.outstandingMinor).toBe(before.outstandingMinor - 3_334n);
      expect(after.reservedMinor).toBe(before.reservedMinor + 3_334n);
      expect(after.protectedMinor).toBe(before.protectedMinor);
      expect(
        await context.db.query.sinkingRequirements.findFirst({
          where: eq(sinkingRequirements.id, before.id),
        }),
      ).toMatchObject({ isAuthoritative: false, supersededBy: after.id });
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('publishes exact reconciliation effects and preserves resolution cutoff history', async () => {
    const { ownerId, scenario, result: before } = await seedSynthetic();
    const cash = scenario.canonical.accounts.find((account) => account.subtype === 'cash');
    if (cash === undefined) throw new Error('Missing cash account.');
    const transactionId = generateUuidV7('integration-reconciliation-transaction') as never;
    const reconciledAt = '2026-09-14T07:30:00Z' as const;
    const commandAt = '2026-09-14T09:30:00Z' as const;
    const transaction = createCanonicalTransaction({
      id: transactionId,
      effectiveAt: reconciledAt as never,
      bookingStatus: 'booked',
      kind: 'valuation_adjustment',
      entries: [
        {
          id: generateUuidV7('integration-reconciliation-entry') as never,
          transactionId,
          accountId: cash.id,
          amount: createMoney(-1_500n, EUR),
          role: 'valuation_adjustment',
        },
      ],
    });
    const flow = createEconomicFlow({
      id: generateUuidV7('integration-reconciliation-flow') as never,
      transactionId,
      effectiveAt: reconciledAt as never,
      amount: createMoney(-1_500n, EUR),
      kind: 'cash_reconciliation_adjustment',
    });
    const reconciliation = createCashReconciliation({
      id: generateUuidV7('integration-reconciliation') as never,
      accountId: cash.id,
      calculatedBalance: createMoney(12_500n, EUR),
      countedBalance: createMoney(11_000n, EUR),
      variance: createMoney(-1_500n, EUR),
      reconciledAt: reconciledAt as never,
      actor: 'integration-user',
      reason: 'integration count',
      materiality: 'non_material',
      adjustmentTransactionId: transactionId,
    });
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      await boss.work<RecalculationJob>('financial.recalculate', { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) await processRecalculationJob(context.db, boss, job);
      });
      const waitForVersion = async (version: bigint): Promise<void> => {
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const record = await context.db.query.recalculationRecords.findFirst({
            where: and(
              eq(recalculationRecords.ownerId, ownerId),
              eq(recalculationRecords.inputVersion, version),
            ),
          });
          if (record?.status === 'completed') return;
          if (record?.status === 'failed' || record?.status === 'superseded')
            throw new Error(`Reconciliation recalculation ended as ${record.status}.`);
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
        }
        throw new Error(`Timed out waiting for reconciliation version ${version}.`);
      };
      await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'cash_reconciliation',
          idempotencyKey: 'cash-reconciliation-life',
          request: { reconciliationId: reconciliation.id },
          asOf: commandAt,
          effectiveDate: '2026-09-14',
          now: commandAt,
        },
        (tx) => appendCashReconciliation(tx, ownerId, transaction, flow, reconciliation),
      );
      const createRecord = await context.db.query.recalculationRecords.findFirst({
        where: and(
          eq(recalculationRecords.ownerId, ownerId),
          eq(recalculationRecords.inputVersion, 2n),
        ),
      });
      expect(canonicalDatabaseInstant(createRecord!.earliestAffectedAt!)).toBe(reconciledAt);
      await waitForVersion(2n);

      const afterAssembly = await assembleFinancialEngineInput(context.db, {
        ownerId,
        expectedInputVersion: 2n,
        asOf: commandAt,
        effectiveDate: '2026-09-14',
        cause: 'cash_reconciliation',
      });
      if (afterAssembly.status !== 'ready') throw new Error('Reconciliation assembly superseded.');
      const after = evaluateFinancialState(afterAssembly.input);
      expect(after.netWorth.value!.total.amountMinor).toBe(
        before.netWorth.value!.total.amountMinor - 1_500n,
      );
      expect(after.positions.liquidCash.value!.amountMinor).toBe(
        before.positions.liquidCash.value!.amountMinor - 1_500n,
      );
      expect(after.liquidityReserve.value!.currentLiquidCash.amountMinor).toBe(
        before.liquidityReserve.value!.currentLiquidCash.amountMinor - 1_500n,
      );
      expect(after.safeToInvest.value!.unroundedRecommended.amountMinor).toBe(
        before.safeToInvest.value!.unroundedRecommended.amountMinor - 1_500n,
      );
      expect(before.safeToInvest.value!.recommended.amountMinor).toBe(2_559_000n);
      expect(after.safeToInvest.value!.recommended.amountMinor).toBe(2_558_000n);
      expect(after.safeToInvest.status).toBe('partial');
      expect(after.investabilityReadiness).toMatchObject({ kind: 'provisional' });
      expect(after.ccr.value).not.toBeNull();
      expect(before.ccr.value).not.toBeNull();
      for (const component of [
        'recognizedIncome',
        'grossConsumption',
        'refunds',
        'reimbursements',
        'netConsumption',
        'shortTermReservedFundsChange',
        'capitalCreated',
      ] as const) {
        expect(after.ccr.value![component].amountMinor).toBe(
          before.ccr.value![component].amountMinor,
        );
      }
      expect(after.ccr.value!.cashReconciliationAdjustments.amountMinor).toBe(
        before.ccr.value!.cashReconciliationAdjustments.amountMinor - 1_500n,
      );

      const resolvedAt = '2026-09-14T09:40:00Z' as const;
      const resolution = createCashReconciliationResolution({
        kind: 'reclassified_adjustment',
        reconciliationId: reconciliation.id,
        resolutionTransactionId: reconciliation.adjustmentTransactionId,
        resolvedAt: resolvedAt as never,
      });
      await executeFinancialCommand(
        context.db,
        boss,
        {
          ownerId,
          kind: 'cash_reconciliation_resolution',
          idempotencyKey: 'cash-resolution-life',
          request: { reconciliationId: reconciliation.id, resolvedAt },
          asOf: resolvedAt,
          effectiveDate: '2026-09-14',
          now: resolvedAt,
        },
        (tx) => appendReconciliationResolution(tx, ownerId, resolution),
      );
      const resolutionRecord = await context.db.query.recalculationRecords.findFirst({
        where: and(
          eq(recalculationRecords.ownerId, ownerId),
          eq(recalculationRecords.inputVersion, 3n),
        ),
      });
      expect(canonicalDatabaseInstant(resolutionRecord!.earliestAffectedAt!)).toBe(resolvedAt);
      await waitForVersion(3n);

      const at = async (asOf: string) => {
        const assembled = await assembleFinancialEngineInput(context.db, {
          ownerId,
          expectedInputVersion: 3n,
          asOf,
          effectiveDate: '2026-09-14',
          cause: 'cash_reconciliation_resolution',
        });
        if (assembled.status !== 'ready') throw new Error('Resolution assembly superseded.');
        return evaluateFinancialState(assembled.input);
      };
      const beforeResolutionCutoff = await at('2026-09-14T09:35:00Z');
      const afterResolutionCutoff = await at('2026-09-14T09:41:00Z');
      expect(beforeResolutionCutoff.investabilityReadiness).toMatchObject({
        kind: 'provisional',
      });
      expect(afterResolutionCutoff.investabilityReadiness).toEqual({ kind: 'complete' });
      expect(afterResolutionCutoff.netWorth.value!.total.amountMinor).toBe(
        after.netWorth.value!.total.amountMinor,
      );
      expect(afterResolutionCutoff.positions.liquidCash.value!.amountMinor).toBe(
        after.positions.liquidCash.value!.amountMinor,
      );
      expect(afterResolutionCutoff.safeToInvest.status).toBe('complete');
      expect(
        (
          await context.db.query.recalculationRecords.findFirst({
            where: and(
              eq(recalculationRecords.ownerId, ownerId),
              eq(recalculationRecords.inputVersion, 3n),
            ),
          })
        )?.status,
      ).toBe('completed');
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });

  it('makes automatic allocation retries version-safe and idempotent by salary', async () => {
    const base = buildSyntheticScenario('healthy_current');
    const currentFund = base.canonical.sinkingFunds.find(
      (fund) => fund.label === 'Annual insurance',
    );
    if (currentFund === undefined) throw new Error('Missing current Sinking Fund.');
    const automaticFund = createSinkingFund({
      ...currentFund,
      allocationPolicy: 'on_primary_income',
    });
    const scenario = Object.freeze({
      ...base,
      canonical: Object.freeze({
        ...base.canonical,
        sinkingFunds: Object.freeze(
          base.canonical.sinkingFunds.map((fund) =>
            fund.id === automaticFund.id ? automaticFund : fund,
          ),
        ),
      }),
    });
    const { ownerId } = await seedSynthetic('healthy_current', scenario);
    const salary = scenario.canonical.primarySalaryTriggers.at(-1);
    if (salary === undefined) throw new Error('Missing primary salary trigger.');
    const initialEventCount = (
      await context.db.select().from(sinkingEvents).where(eq(sinkingEvents.ownerId, ownerId))
    ).length;
    const boss = createJobBoss(databaseUrl!, 2);
    await boss.start();
    try {
      const job = {
        ownerId,
        salaryTransactionId: salary.transactionId,
        inputVersion: '1',
        asOf: scenario.run.asOf,
        effectiveDate: scenario.run.effectiveDate,
      } as const;
      const first = await processAutomaticSinkingAllocationJob(context.db, boss, job, {
        now: () => '2026-09-14T09:50:00Z',
      });
      expect(first.status).toBe('allocated');
      const retry = await processAutomaticSinkingAllocationJob(context.db, boss, job, {
        now: () => '2026-09-14T09:50:01Z',
      });
      expect(retry.status).toBe('superseded');
      const events = await context.db
        .select()
        .from(sinkingEvents)
        .where(eq(sinkingEvents.ownerId, ownerId));
      expect(events).toHaveLength(initialEventCount + 1);
      expect(events.at(-1)).toMatchObject({
        fundId: automaticFund.id,
        kind: 'allocation',
        amountMinor: 3_334n,
      });
      expect(
        await context.db
          .select()
          .from(recalculationRecords)
          .where(eq(recalculationRecords.ownerId, ownerId)),
      ).toHaveLength(1);
      expect(
        (
          await context.db.query.ownerInputVersions.findFirst({
            where: eq(ownerInputVersions.ownerId, ownerId),
          })
        )?.version,
      ).toBe(2n);
    } finally {
      await boss.stop({ graceful: true, timeout: 5_000, close: true });
    }
  });
});
