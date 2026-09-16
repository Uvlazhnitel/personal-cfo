import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';
import type { Job, PgBoss as PgBossType } from 'pg-boss';

import type { Database } from './database.js';

export const JOB_QUEUES = Object.freeze({
  recalculate: 'financial.recalculate',
  recalculateDead: 'financial.recalculate.dead',
  sinkingAllocate: 'sinking.allocate',
  sinkingAllocateDead: 'sinking.allocate.dead',
});

export const RECALCULATION_CAUSES = [
  'synthetic_import',
  'classification_correction',
  'transfer_resolution',
  'cash_reconciliation',
  'cash_reconciliation_resolution',
  'sinking_allocation',
  'automatic_sinking_allocation',
  'manual_recalculate',
] as const;
export type RecalculationCause = (typeof RECALCULATION_CAUSES)[number];

export type RecalculationJob = Readonly<{
  requestId: string;
  ownerId: string;
  inputVersion: string;
  cause: RecalculationCause;
  asOf: string;
  effectiveDate: string;
  earliestAffectedAt: string | null;
}>;

export type SinkingAllocationJob = Readonly<{
  ownerId: string;
  salaryTransactionId: string;
  inputVersion: string;
  asOf: string;
  effectiveDate: string;
}>;

type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createJobBoss(connectionString: string, maxConnections = 5): PgBossType {
  return new PgBoss({
    connectionString,
    schema: 'pgboss',
    migrate: false,
    createSchema: false,
    max: maxConnections,
    application_name: 'personal-cfo-worker',
  });
}

export async function enqueueRecalculation(
  boss: PgBossType,
  tx: DatabaseTransaction,
  payload: RecalculationJob,
): Promise<string> {
  const id = await boss.send(JOB_QUEUES.recalculate, payload, {
    db: fromDrizzle(tx, sql),
    singletonKey: `${payload.ownerId}:${payload.inputVersion}`,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    deadLetter: JOB_QUEUES.recalculateDead,
  });
  if (id === null) throw new Error('Recalculation job was not enqueued.');
  return id;
}

export async function enqueueSinkingAllocation(
  boss: PgBossType,
  tx: DatabaseTransaction,
  payload: SinkingAllocationJob,
): Promise<string> {
  const id = await boss.send(JOB_QUEUES.sinkingAllocate, payload, {
    db: fromDrizzle(tx, sql),
    singletonKey: `${payload.ownerId}:${payload.salaryTransactionId}`,
    retryLimit: 3,
    retryDelay: 5,
    retryBackoff: true,
    deadLetter: JOB_QUEUES.sinkingAllocateDead,
  });
  if (id === null) throw new Error('Sinking allocation job was not enqueued.');
  return id;
}

export type RecalculationJobHandler = (job: Job<RecalculationJob>) => Promise<void>;
export type SinkingAllocationJobHandler = (job: Job<SinkingAllocationJob>) => Promise<void>;

export async function jobInfrastructureReady(db: Database): Promise<boolean> {
  const result = await db.execute(
    sql<{
      count: string;
    }>`select count(*)::text as count from pgboss.queue where name in (${JOB_QUEUES.recalculate}, ${JOB_QUEUES.sinkingAllocate}, ${JOB_QUEUES.recalculateDead}, ${JOB_QUEUES.sinkingAllocateDead})`,
  );
  return result.rows[0]?.['count'] === '4';
}
