import {
  JOB_QUEUES,
  createDatabaseContext,
  createJobBoss,
  requireDatabaseUrl,
} from '@personal-cfo/data';
import type { RecalculationJob, SinkingAllocationJob } from '@personal-cfo/data';
import { processAutomaticSinkingAllocationJob, processRecalculationJob } from './job-handlers.js';
import { telegramConfiguration } from './telegram/config.js';
import { startTelegramRuntime } from './telegram/runtime.js';

const telegramConfig = telegramConfiguration();
const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 8 });
const boss = createJobBoss(requireDatabaseUrl(), 5);
let shuttingDown = false;

function log(event: string, fields: Readonly<Record<string, unknown>> = {}): void {
  console.info(JSON.stringify({ event, ...fields }));
}

await boss.start();
await boss.work<RecalculationJob>(JOB_QUEUES.recalculate, { batchSize: 1 }, async (jobs) => {
  for (const job of jobs) {
    await processRecalculationJob(database.db, boss, job, log);
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
const telegram = await startTelegramRuntime(database.db, boss, log, {
  configuration: telegramConfig,
});

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
    await telegram.stop();
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
