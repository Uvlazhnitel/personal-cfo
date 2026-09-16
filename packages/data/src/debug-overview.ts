import { and, desc, eq, sql } from 'drizzle-orm';

import type { Database } from './database.js';
import {
  auditEvents,
  cashReconciliationResolutions,
  cashReconciliations,
  derivedPayCycles,
  engineRuns,
  flowAmbiguities,
  metricSnapshots,
  ownerInputVersions,
  recalculationRecords,
  sinkingRequirements,
  telegramDeliveries,
  telegramIntegrationStatus,
  telegramUpdates,
} from './schema.js';

export type DebugOverview = Readonly<{
  currentInputVersion: string | null;
  latestRun: unknown;
  entityCounts: Readonly<Record<string, string>>;
  metrics: readonly unknown[];
  payCycles: readonly unknown[];
  sinkingRequirements: readonly unknown[];
  ambiguities: readonly unknown[];
  reconciliations: readonly unknown[];
  reconciliationResolutions: readonly unknown[];
  audit: readonly unknown[];
  recalculations: readonly unknown[];
  jobs: readonly unknown[];
  telegram: unknown;
}>;

export async function loadDebugOverview(db: Database, ownerId: string): Promise<DebugOverview> {
  const ownerVersion = await db.query.ownerInputVersions.findFirst({
    where: eq(ownerInputVersions.ownerId, ownerId),
  });
  const latestRun = await db.query.engineRuns.findFirst({
    where: and(eq(engineRuns.ownerId, ownerId), eq(engineRuns.status, 'completed')),
    orderBy: [desc(engineRuns.completedAt)],
  });
  const countsResult = await db.execute(sql<Record<string, string>>`
    select
      (select count(*)::text from accounts where owner_id = ${ownerId}) as accounts,
      (select count(*)::text from financial_transactions where owner_id = ${ownerId}) as transactions,
      (select count(*)::text from economic_flows where owner_id = ${ownerId}) as economic_flows,
      (select count(*)::text from sinking_funds where owner_id = ${ownerId}) as sinking_funds,
      (select count(*)::text from sinking_events where owner_id = ${ownerId}) as sinking_events,
      (select count(*)::text from engine_runs where owner_id = ${ownerId}) as engine_runs
  `);
  const metrics = await db
    .select()
    .from(metricSnapshots)
    .where(and(eq(metricSnapshots.ownerId, ownerId), eq(metricSnapshots.isAuthoritative, true)))
    .orderBy(metricSnapshots.metricKind, metricSnapshots.periodKey);
  const cycles =
    latestRun === undefined
      ? []
      : await db
          .select()
          .from(derivedPayCycles)
          .where(eq(derivedPayCycles.engineRunId, latestRun.id))
          .orderBy(derivedPayCycles.startDate);
  const requirements = await db
    .select()
    .from(sinkingRequirements)
    .where(
      and(eq(sinkingRequirements.ownerId, ownerId), eq(sinkingRequirements.isAuthoritative, true)),
    )
    .orderBy(sinkingRequirements.fundId);
  const ambiguities = await db
    .select()
    .from(flowAmbiguities)
    .where(and(eq(flowAmbiguities.ownerId, ownerId), eq(flowAmbiguities.status, 'unresolved')))
    .orderBy(flowAmbiguities.effectiveAt, flowAmbiguities.id);
  const reconciliations = await db
    .select()
    .from(cashReconciliations)
    .where(eq(cashReconciliations.ownerId, ownerId))
    .orderBy(desc(cashReconciliations.reconciledAt))
    .limit(20);
  const resolutions = await db
    .select()
    .from(cashReconciliationResolutions)
    .where(eq(cashReconciliationResolutions.ownerId, ownerId))
    .orderBy(desc(cashReconciliationResolutions.resolvedAt))
    .limit(20);
  const audit = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.ownerId, ownerId))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(20);
  const recalculations = await db
    .select()
    .from(recalculationRecords)
    .where(eq(recalculationRecords.ownerId, ownerId))
    .orderBy(desc(recalculationRecords.createdAt))
    .limit(20);
  const jobsResult = await db.execute(
    sql<
      Record<string, unknown>
    >`select id::text, name, state::text, retry_count, created_on::text, started_on::text, completed_on::text from pgboss.job where name in ('financial.recalculate','financial.recalculate.dead','sinking.allocate','sinking.allocate.dead') order by created_on desc limit 20`,
  );
  const telegramStatus = await db.query.telegramIntegrationStatus.findFirst({
    where: eq(telegramIntegrationStatus.name, 'default'),
  });
  const clarificationCount = await db.execute(sql<{ count: string }>`
    select count(*)::text as count
      from telegram_pending_clarifications
     where owner_id = ${ownerId} and status = 'active'
  `);
  const telegramFailures = await db
    .select({
      status: telegramUpdates.status,
      parserOutcome: telegramUpdates.parserOutcome,
      proposalKind: telegramUpdates.proposalKind,
      safeErrorCategory: telegramUpdates.safeErrorCategory,
      receivedAt: telegramUpdates.receivedAt,
      processedAt: telegramUpdates.processedAt,
    })
    .from(telegramUpdates)
    .where(
      and(
        eq(telegramUpdates.ownerId, ownerId),
        sql`${telegramUpdates.status} in ('failed','unsupported')`,
      ),
    )
    .orderBy(desc(telegramUpdates.receivedAt))
    .limit(10);
  const deliveryFailures = await db
    .select({
      purpose: telegramDeliveries.purpose,
      status: telegramDeliveries.status,
      attemptCount: telegramDeliveries.attemptCount,
      safeErrorCategory: telegramDeliveries.safeErrorCategory,
      createdAt: telegramDeliveries.createdAt,
      completedAt: telegramDeliveries.completedAt,
    })
    .from(telegramDeliveries)
    .where(
      and(
        eq(telegramDeliveries.ownerId, ownerId),
        sql`${telegramDeliveries.status} in ('failed','uncertain','retryable')`,
      ),
    )
    .orderBy(desc(telegramDeliveries.createdAt))
    .limit(10);
  const rawCounts = countsResult.rows[0] ?? {};
  const entityCounts = Object.freeze(
    Object.fromEntries(Object.entries(rawCounts).map(([key, value]) => [key, String(value)])),
  );
  return Object.freeze({
    currentInputVersion: ownerVersion?.version.toString() ?? null,
    latestRun: latestRun ?? null,
    entityCounts,
    metrics: Object.freeze(metrics),
    payCycles: Object.freeze(cycles),
    sinkingRequirements: Object.freeze(requirements),
    ambiguities: Object.freeze(ambiguities),
    reconciliations: Object.freeze(reconciliations),
    reconciliationResolutions: Object.freeze(resolutions),
    audit: Object.freeze(audit),
    recalculations: Object.freeze(recalculations),
    jobs: Object.freeze(jobsResult.rows),
    telegram: Object.freeze({
      status:
        telegramStatus === undefined
          ? null
          : Object.freeze({
              enabled: telegramStatus.enabled,
              status: telegramStatus.status,
              hasProcessedUpdate: telegramStatus.lastProcessedUpdateId !== null,
              lastProcessedAt: telegramStatus.lastProcessedAt,
              lastErrorCategory: telegramStatus.lastErrorCategory,
              updatedAt: telegramStatus.updatedAt,
            }),
      pendingClarifications: clarificationCount.rows[0]?.['count'] ?? '0',
      processingFailures: Object.freeze(telegramFailures),
      deliveryFailures: Object.freeze(deliveryFailures),
    }),
  });
}
