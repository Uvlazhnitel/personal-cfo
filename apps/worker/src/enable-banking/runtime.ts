import {
  enqueueEnableBankingSync,
  JOB_QUEUES,
  listEnableBankingSyncTargets,
} from '@personal-cfo/data';
import type { Database, EnableBankingSyncJob } from '@personal-cfo/data';
import type { Job, PgBoss } from 'pg-boss';

import { enableBankingConfiguration, enableBankingScheduleConfiguration } from './config.js';
import { executeEnableBankingSync } from './sync.js';

export type EnableBankingRuntimeLogger = (
  event: string,
  fields?: Readonly<Record<string, unknown>>,
) => void;

function rigaDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Riga',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export async function startEnableBankingRuntime(
  db: Database,
  boss: PgBoss,
  log: EnableBankingRuntimeLogger,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ enabled: boolean }>> {
  const schedule = enableBankingScheduleConfiguration(environment);
  if (!schedule.enabled) {
    await boss.unschedule(JOB_QUEUES.enableBankingDispatch).catch(() => undefined);
    log('enable_banking.sync.disabled');
    return Object.freeze({ enabled: false });
  }
  const configuration = await enableBankingConfiguration(environment);
  await boss.schedule(JOB_QUEUES.enableBankingDispatch, schedule.cron, null, {
    tz: schedule.timeZone,
  });
  await boss.work(JOB_QUEUES.enableBankingDispatch, { batchSize: 1 }, async () => {
    const scheduledDate = rigaDate(new Date());
    const targets = await listEnableBankingSyncTargets(db);
    for (const target of targets) {
      await enqueueEnableBankingSync(boss, {
        ownerId: target.ownerId,
        connectionGeneration: target.connectionGeneration,
        scheduledDate,
      });
    }
    log('enable_banking.sync.dispatched', { targetCount: targets.length, scheduledDate });
  });
  await boss.work<EnableBankingSyncJob>(
    JOB_QUEUES.enableBankingSync,
    { batchSize: 1 },
    async (jobs: Job<EnableBankingSyncJob>[]) => {
      for (const job of jobs) {
        const targets = await listEnableBankingSyncTargets(db);
        const current = targets.find((target) => target.ownerId === job.data.ownerId);
        if (
          current === undefined ||
          current.connectionGeneration !== job.data.connectionGeneration ||
          job.data.ownerId !== configuration.ownerId
        ) {
          log('enable_banking.sync.stale_job', { jobId: job.id });
          continue;
        }
        const result = await executeEnableBankingSync(db, boss, configuration, {
          canonicalImportEnabled: configuration.canonicalImportEnabled ?? false,
        });
        log('enable_banking.sync.completed', {
          jobId: job.id,
          strategy: result.strategy,
          completionStatus: result.completionStatus,
          counts: result.counts,
          coverageStatus: result.coverage.status,
          reconciliationStatus: result.reconciliationStatus,
        });
      }
    },
  );
  log('enable_banking.sync.enabled', { cron: schedule.cron, timeZone: schedule.timeZone });
  return Object.freeze({ enabled: true });
}
