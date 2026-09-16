import {
  appendManualSinkingAllocation,
  executeFinancialCommand,
  generateUuidV7,
} from '@personal-cfo/data';
import type { Database, SinkingAllocationJob } from '@personal-cfo/data';
import { createSinkingFundAllocation, parseInstant } from '@personal-cfo/domain';
import type { PgBoss } from 'pg-boss';
import {
  calculateAutomaticSinkingAllocations,
  evaluateFinancialState,
} from '@personal-cfo/financial-engine';

import { assembleFinancialEngineInput } from './engine-input.js';

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
