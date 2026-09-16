import {
  JOB_QUEUES,
  createDatabaseContext,
  createJobBoss,
  DataInvariantError,
  requireDatabaseUrl,
  updateRecalculationStatus,
} from '@personal-cfo/data';
import type { RecalculationJob, SinkingAllocationJob } from '@personal-cfo/data';
import { processAutomaticSinkingAllocationJob } from './job-handlers.js';
import { recalculateFinancialState } from './recalculation.js';

const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 8 });
const boss = createJobBoss(requireDatabaseUrl(), 5);
let shuttingDown = false;

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  console.info(JSON.stringify({ event, ...fields }));
}

await boss.start();
await boss.work<RecalculationJob>(JOB_QUEUES.recalculate, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    log('financial.recalculation.started', { jobId: job.id, ownerId: job.data.ownerId });
    try {
      const result = await recalculateFinancialState(database.db, job.data);
      if (result.status === 'superseded') {
        log('financial.recalculation.superseded', {
          jobId: job.id,
          requestedInputVersion: result.requestedInputVersion.toString(),
          currentInputVersion: result.currentInputVersion.toString(),
        });
      } else {
        log('financial.recalculation.completed', {
          jobId: job.id,
          runId: result.runId,
          reused: result.reused,
        });
      }
    } catch (error) {
      const permanent = error instanceof DataInvariantError;
      const message = error instanceof Error ? error.message : 'Unknown recalculation failure.';
      await updateRecalculationStatus(
        database.db,
        job.data.requestId,
        permanent ? 'failed' : 'queued',
        permanent ? new Date().toISOString() : null,
        { category: permanent ? 'permanent_input' : 'transient_runtime', message },
      );
      if (!permanent) throw error;
      await boss.send(JOB_QUEUES.recalculateDead, {
        requestId: job.data.requestId,
        ownerId: job.data.ownerId,
        inputVersion: job.data.inputVersion,
        category: 'permanent_input',
      });
      log('financial.recalculation.dead-lettered', { jobId: job.id, category: 'permanent_input' });
    }
  }
});
await boss.work<SinkingAllocationJob>(
  JOB_QUEUES.sinkingAllocate,
  { batchSize: 1 },
  async (jobs) => {
    for (const job of jobs) {
      await processAutomaticSinkingAllocationJob(database.db, boss, job.data);
    }
  },
);

log('worker.started');

async function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log('worker.shutdown.started', { signal });
  const timeout = setTimeout(() => {
    log('worker.shutdown.timeout', { signal });
    process.exitCode = 1;
  }, 15_000);
  timeout.unref();
  try {
    await boss.stop({ graceful: true, timeout: 10_000, close: true });
    await database.close();
    process.exitCode = 0;
    log('worker.shutdown.completed', { signal });
  } finally {
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => void shutDown('SIGINT'));
process.once('SIGTERM', () => void shutDown('SIGTERM'));
