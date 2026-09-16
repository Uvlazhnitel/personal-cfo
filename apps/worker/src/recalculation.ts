import { persistEngineResult, updateRecalculationStatus } from '@personal-cfo/data';
import type { Database, RecalculationJob } from '@personal-cfo/data';
import { evaluateFinancialState } from '@personal-cfo/financial-engine';

import { assembleFinancialEngineInput } from './engine-input.js';

export async function recalculateFinancialState(
  db: Database,
  job: RecalculationJob,
  clock: Readonly<{ now: () => string }> = { now: () => new Date().toISOString() },
): Promise<
  | Readonly<{ status: 'published'; runId: string; reused: boolean }>
  | Readonly<{
      status: 'superseded';
      requestedInputVersion: bigint;
      currentInputVersion: bigint;
    }>
> {
  await updateRecalculationStatus(db, job.requestId, 'running', null);
  const startedAt = clock.now();
  const assembled = await assembleFinancialEngineInput(db, {
    ownerId: job.ownerId,
    expectedInputVersion: BigInt(job.inputVersion),
    asOf: job.asOf,
    effectiveDate: job.effectiveDate,
    cause: job.cause,
  });
  if (assembled.status === 'superseded') {
    const completedAt = clock.now();
    await updateRecalculationStatus(db, job.requestId, 'superseded', completedAt);
    return Object.freeze({
      status: assembled.status,
      requestedInputVersion: assembled.expectedInputVersion,
      currentInputVersion: assembled.loadedInputVersion,
    });
  }
  const input = assembled.input;
  const result = evaluateFinancialState(input);
  const completedAt = clock.now();
  const persisted = await persistEngineResult(
    db,
    {
      ownerId: job.ownerId,
      inputVersion: BigInt(job.inputVersion),
      asOf: input.run.asOf,
      effectiveDate: input.run.effectiveDate,
      engineVersion: input.run.engineVersion,
      settingsVersion: input.run.settingsVersion,
      inputWatermark: input.run.inputWatermark,
      trigger: job.cause,
      earliestAffectedAt: job.earliestAffectedAt,
      startedAt,
      completedAt,
    },
    result,
  );
  if (persisted.status === 'superseded') {
    await updateRecalculationStatus(db, job.requestId, 'superseded', completedAt);
    return persisted;
  }
  await updateRecalculationStatus(db, job.requestId, 'completed', completedAt);
  return Object.freeze({
    status: persisted.status,
    runId: persisted.runId,
    reused: persisted.reused,
  });
}
