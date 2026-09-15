import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from './database.js';
import { normalizeSnapshotJson } from './json-codec.js';
import {
  derivedPayCycles,
  engineRuns,
  metricSnapshots,
  recalculationRecords,
  sinkingRequirements,
} from './schema.js';
import { generateUuidV7 } from './uuid-v7.js';

export type EngineRunEnvelope = Readonly<{
  ownerId: string;
  inputVersion: bigint;
  asOf: string;
  effectiveDate: string;
  engineVersion: string;
  settingsVersion: string;
  inputWatermark: string;
  trigger: string;
  earliestAffectedAt: string | null;
  startedAt: string;
  completedAt: string;
}>;

const metricNames = [
  'netWorth',
  'ccr',
  'rollingCcr',
  'currentCycleSinkingDue',
  'spendingBaseline',
  'liquidityReserve',
  'safeToInvest',
  'cashDrag',
  'historicalInvestmentCapacity',
  'investmentContributionDecision',
  'forecast',
] as const;

export async function persistEngineResult(
  db: Database,
  envelope: EngineRunEnvelope,
  result: Readonly<Record<string, unknown>>,
): Promise<Readonly<{ runId: string; reused: boolean }>> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${envelope.ownerId}, 0))`);
    const existing = await tx.query.engineRuns.findFirst({
      where: and(
        eq(engineRuns.ownerId, envelope.ownerId),
        eq(engineRuns.inputVersion, envelope.inputVersion),
        eq(engineRuns.engineVersion, envelope.engineVersion),
        eq(engineRuns.settingsVersion, envelope.settingsVersion),
        eq(engineRuns.asOf, envelope.asOf),
      ),
    });
    if (existing?.status === 'completed')
      return Object.freeze({ runId: existing.id, reused: true });
    const runId = existing?.id ?? generateUuidV7('engine-run');
    if (existing === undefined) {
      await tx.insert(engineRuns).values({
        id: runId,
        ownerId: envelope.ownerId,
        inputVersion: envelope.inputVersion,
        asOf: envelope.asOf,
        effectiveDate: envelope.effectiveDate,
        engineVersion: envelope.engineVersion,
        settingsVersion: envelope.settingsVersion,
        inputWatermark: envelope.inputWatermark,
        trigger: envelope.trigger,
        earliestAffectedAt: envelope.earliestAffectedAt,
        startedAt: envelope.startedAt,
        completedAt: null,
        status: 'running',
        failureCategory: null,
        failureMessage: null,
        resultPayload: null,
      });
    } else {
      await tx
        .update(engineRuns)
        .set({ status: 'running', failureCategory: null, failureMessage: null })
        .where(eq(engineRuns.id, runId));
    }
    const previous = await tx
      .select()
      .from(metricSnapshots)
      .where(
        and(
          eq(metricSnapshots.ownerId, envelope.ownerId),
          eq(metricSnapshots.isAuthoritative, true),
        ),
      );
    await tx
      .update(metricSnapshots)
      .set({ isAuthoritative: false })
      .where(
        and(
          eq(metricSnapshots.ownerId, envelope.ownerId),
          eq(metricSnapshots.isAuthoritative, true),
        ),
      );
    const replacement = new Map<string, string>();
    for (const name of metricNames) {
      const value = result[name];
      if (value === undefined) continue;
      const id = generateUuidV7('metric-snapshot');
      replacement.set(`${name}:current`, id);
      const status =
        typeof value === 'object' && value !== null && 'status' in value
          ? String(value.status)
          : 'complete';
      await tx.insert(metricSnapshots).values({
        id,
        ownerId: envelope.ownerId,
        engineRunId: runId,
        metricKind: name,
        periodKey: 'current',
        status,
        payload: normalizeSnapshotJson(value),
        asOf: envelope.asOf,
        engineVersion: envelope.engineVersion,
        settingsVersion: envelope.settingsVersion,
        inputWatermark: envelope.inputWatermark,
        createdAt: envelope.completedAt,
        isAuthoritative: true,
        supersededBy: null,
      });
    }
    for (const old of previous) {
      const successor = replacement.get(`${old.metricKind}:${old.periodKey}`);
      if (successor !== undefined)
        await tx
          .update(metricSnapshots)
          .set({ supersededBy: successor })
          .where(eq(metricSnapshots.id, old.id));
    }
    const payCycles = Array.isArray(result['payCycles']) ? result['payCycles'] : [];
    for (const item of payCycles) {
      const cycle = item as Record<string, unknown>;
      const text = (key: string): string => {
        const value = cycle[key];
        if (typeof value !== 'string') throw new Error(`Pay Cycle ${key} must be a string.`);
        return value;
      };
      await tx.insert(derivedPayCycles).values({
        ownerId: envelope.ownerId,
        engineRunId: runId,
        cycleId: text('id'),
        openingSalaryTransactionId: text('openingSalaryTransactionId'),
        closingSalaryTransactionId:
          cycle['closingSalaryTransactionId'] === null ? null : text('closingSalaryTransactionId'),
        startDate: text('startDate'),
        endExclusive: cycle['endExclusive'] === null ? null : text('endExclusive'),
        status: text('status'),
        payload: normalizeSnapshotJson(cycle),
      });
    }
    const due = result['currentCycleSinkingDue'] as Readonly<Record<string, unknown>> | undefined;
    const dueValue = due?.['value'] as Readonly<Record<string, unknown>> | null | undefined;
    const byFund = Array.isArray(dueValue?.['byFund']) ? dueValue['byFund'] : [];
    const previousRequirements = await tx
      .select()
      .from(sinkingRequirements)
      .where(
        and(
          eq(sinkingRequirements.ownerId, envelope.ownerId),
          eq(sinkingRequirements.isAuthoritative, true),
        ),
      );
    await tx
      .update(sinkingRequirements)
      .set({ isAuthoritative: false })
      .where(
        and(
          eq(sinkingRequirements.ownerId, envelope.ownerId),
          eq(sinkingRequirements.isAuthoritative, true),
        ),
      );
    const requirementReplacements = new Map<string, string>();
    for (const raw of byFund) {
      const item = raw as Record<string, unknown>;
      const amount = (key: string) =>
        BigInt(String((item[key] as { amountMinor: unknown })['amountMinor']));
      const id = generateUuidV7('sinking-requirement');
      const fundId = String(item['fundId']);
      requirementReplacements.set(fundId, id);
      await tx.insert(sinkingRequirements).values({
        id,
        ownerId: envelope.ownerId,
        engineRunId: runId,
        fundId,
        cycleId: null,
        requiredMinor: amount('required'),
        satisfiedMinor: amount('satisfied'),
        outstandingMinor: amount('outstanding'),
        reservedMinor: amount('reserved'),
        protectedMinor: amount('protected'),
        currency: 'EUR',
        payload: normalizeSnapshotJson(item),
        isAuthoritative: true,
        supersededBy: null,
      });
    }
    for (const previousRequirement of previousRequirements) {
      const successor = requirementReplacements.get(previousRequirement.fundId);
      if (successor !== undefined)
        await tx
          .update(sinkingRequirements)
          .set({ supersededBy: successor })
          .where(eq(sinkingRequirements.id, previousRequirement.id));
    }
    await tx
      .update(engineRuns)
      .set({
        status: 'completed',
        completedAt: envelope.completedAt,
        resultPayload: normalizeSnapshotJson(result),
      })
      .where(eq(engineRuns.id, runId));
    return Object.freeze({ runId, reused: false });
  });
}

export async function latestEngineRun(db: Database, ownerId: string) {
  return db.query.engineRuns.findFirst({
    where: and(eq(engineRuns.ownerId, ownerId), eq(engineRuns.status, 'completed')),
    orderBy: [desc(engineRuns.completedAt)],
  });
}

export async function recentRecalculations(db: Database, ownerId: string, limit = 20) {
  return db
    .select()
    .from(recalculationRecords)
    .where(eq(recalculationRecords.ownerId, ownerId))
    .orderBy(desc(recalculationRecords.createdAt))
    .limit(limit);
}

export async function updateRecalculationStatus(
  db: Database,
  requestId: string,
  status: 'running' | 'completed' | 'failed',
  completedAt: string | null,
  failure?: Readonly<{ category: string; message: string }>,
): Promise<void> {
  await db
    .update(recalculationRecords)
    .set({
      status,
      completedAt,
      failureCategory: failure?.category ?? null,
      failureMessage: failure?.message.slice(0, 500) ?? null,
    })
    .where(eq(recalculationRecords.id, requestId));
}
