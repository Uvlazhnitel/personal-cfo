import {
  appendManualSinkingAllocation,
  DataInvariantError,
  executeFinancialCommand,
  generateUuidV7,
  JOB_QUEUES,
  updateRecalculationStatus,
} from '@personal-cfo/data';
import type { Database, RecalculationJob, SinkingAllocationJob } from '@personal-cfo/data';
import { createSinkingFundAllocation, parseInstant } from '@personal-cfo/domain';
import type { Job, PgBoss } from 'pg-boss';
import {
  calculateAutomaticSinkingAllocations,
  evaluateFinancialState,
} from '@personal-cfo/financial-engine';

import { assembleFinancialEngineInput } from './engine-input.js';
import { recalculateFinancialState } from './recalculation.js';

export type RecalculationJobOutcome =
  | Readonly<{ status: 'published'; runId: string; reused: boolean }>
  | Readonly<{
      status: 'superseded';
      requestedInputVersion: bigint;
      currentInputVersion: bigint;
    }>
  | Readonly<{ status: 'dead_lettered'; category: 'permanent_input' }>;

export type WorkerEventLogger = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export async function processRecalculationJob(
  db: Database,
  boss: PgBoss,
  job: Job<RecalculationJob>,
  log: WorkerEventLogger = () => undefined,
): Promise<RecalculationJobOutcome> {
  log('financial.recalculation.started', { jobId: job.id, ownerId: job.data.ownerId });
  try {
    const result = await recalculateFinancialState(db, job.data);
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
    return result;
  } catch (error) {
    const permanent = error instanceof DataInvariantError;
    const message = error instanceof Error ? error.message : 'Unknown recalculation failure.';
    await updateRecalculationStatus(
      db,
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
    log('financial.recalculation.dead-lettered', {
      jobId: job.id,
      category: 'permanent_input',
    });
    return Object.freeze({ status: 'dead_lettered', category: 'permanent_input' });
  }
}

export type AutomaticAllocationOutcome =
  | Readonly<{ status: 'superseded' | 'nothing_to_allocate' | 'replayed' }>
  | Readonly<{ status: 'allocated'; allocationIds: readonly string[] }>;

export async function processAutomaticSinkingAllocationJob(
  db: Database,
  boss: PgBoss,
  job: SinkingAllocationJob,
  clock: Readonly<{ now: () => string }> = { now: () => new Date().toISOString() },
): Promise<AutomaticAllocationOutcome> {
  const effectiveAt = parseInstant(job.asOf);
  const assembled = await assembleFinancialEngineInput(db, {
    ownerId: job.ownerId,
    expectedInputVersion: BigInt(job.inputVersion),
    asOf: effectiveAt,
    effectiveDate: job.effectiveDate,
    cause: 'automatic_sinking_allocation',
  });
  if (assembled.status === 'superseded') return Object.freeze({ status: 'superseded' });

  const input = assembled.input;
  const state = evaluateFinancialState(input);
  const plan = calculateAutomaticSinkingAllocations({
    funds: input.canonical.sinkingFunds,
    sinkingProtection: state.currentCycleSinkingDue,
    liquidity: state.liquidityReserve,
  });
  if (plan.value === null || plan.value.allocations.length === 0)
    return Object.freeze({ status: 'nothing_to_allocate' });

  const command = await executeFinancialCommand(
    db,
    boss,
    {
      ownerId: job.ownerId,
      kind: 'automatic_sinking_allocation',
      idempotencyKey: `auto:${job.salaryTransactionId}`,
      request: {
        salaryTransactionId: job.salaryTransactionId,
        inputVersion: job.inputVersion,
      },
      asOf: effectiveAt,
      effectiveDate: job.effectiveDate,
      now: clock.now(),
    },
    async (tx, commandId) => {
      const ids: string[] = [];
      for (const allocation of plan.value!.allocations) {
        const event = createSinkingFundAllocation({
          id: generateUuidV7('sinking-fund-allocation'),
          fundId: allocation.fundId,
          kind: 'allocation',
          amount: allocation.amount,
          effectiveAt,
        });
        await appendManualSinkingAllocation(tx, job.ownerId, event, commandId);
        ids.push(event.id);
      }
      return Object.freeze({
        entityType: 'automatic_sinking_allocation',
        entityId: job.salaryTransactionId,
        earliestAffectedAt: effectiveAt,
        result: Object.freeze({ allocationIds: Object.freeze(ids) }),
      });
    },
  );
  if (command.replayed) return Object.freeze({ status: 'replayed' });
  const allocationIds = command.result['allocationIds'];
  if (!Array.isArray(allocationIds) || allocationIds.some((id) => typeof id !== 'string')) {
    throw new Error('Automatic allocation command returned invalid allocation IDs.');
  }
  return Object.freeze({ status: 'allocated', allocationIds: Object.freeze(allocationIds) });
}
