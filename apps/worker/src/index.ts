import {
  JOB_QUEUES,
  appendManualSinkingAllocation,
  createDatabaseContext,
  createJobBoss,
  DataInvariantError,
  executeFinancialCommand,
  generateUuidV7,
  requireDatabaseUrl,
  updateRecalculationStatus,
} from '@personal-cfo/data';
import type { RecalculationJob, SinkingAllocationJob } from '@personal-cfo/data';
import { createSinkingFundAllocation } from '@personal-cfo/domain';
import {
  calculateAutomaticSinkingAllocations,
  evaluateFinancialState,
} from '@personal-cfo/financial-engine';

import { assembleFinancialEngineInput } from './engine-input.js';
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
      log('financial.recalculation.completed', {
        jobId: job.id,
        runId: result.runId,
        reused: result.reused,
      });
    } catch (error) {
      const permanent = error instanceof DataInvariantError;
      const message = error instanceof Error ? error.message : 'Unknown recalculation failure.';
      await updateRecalculationStatus(
        database.db,
        job.data.requestId,
        'failed',
        new Date().toISOString(),
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
      const input = await assembleFinancialEngineInput(database.db, job.data.ownerId);
      const state = evaluateFinancialState(input);
      const plan = calculateAutomaticSinkingAllocations({
        funds: input.canonical.sinkingFunds,
        sinkingProtection: state.currentCycleSinkingDue,
        liquidity: state.liquidityReserve,
      });
      if (plan.value === null || plan.value.allocations.length === 0) continue;
      await executeFinancialCommand(
        database.db,
        boss,
        {
          ownerId: job.data.ownerId,
          kind: 'automatic_sinking_allocation',
          idempotencyKey: `auto:${job.data.salaryTransactionId}`,
          request: {
            salaryTransactionId: job.data.salaryTransactionId,
            inputVersion: job.data.inputVersion,
          },
          earliestAffectedAt: job.data.asOf,
          asOf: job.data.asOf,
          effectiveDate: input.run.effectiveDate,
          now: new Date().toISOString(),
        },
        async (tx, commandId) => {
          const ids: string[] = [];
          for (const allocation of plan.value!.allocations) {
            const event = createSinkingFundAllocation({
              id: generateUuidV7('sinking-fund-allocation'),
              fundId: allocation.fundId,
              kind: 'allocation',
              amount: allocation.amount,
              effectiveAt: job.data.asOf as never,
            });
            await appendManualSinkingAllocation(tx, job.data.ownerId, event, commandId);
            ids.push(event.id);
          }
          return Object.freeze({
            entityType: 'automatic_sinking_allocation',
            entityId: job.data.salaryTransactionId,
            result: Object.freeze({ allocationIds: Object.freeze(ids) }),
          });
        },
      );
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
