import { persistEngineResult, updateRecalculationStatus } from '@personal-cfo/data';
import type { Database, RecalculationJob } from '@personal-cfo/data';
import { evaluateFinancialState } from '@personal-cfo/financial-engine';

import { assembleFinancialEngineInput } from './engine-input.js';

export async function recalculateFinancialState(
  db: Database,
  job: RecalculationJob,
): Promise<Readonly<{ runId: string; reused: boolean }>> {
  await updateRecalculationStatus(db, job.requestId, 'running', null);
  const input = await assembleFinancialEngineInput(db, job.ownerId);
  const result = evaluateFinancialState(input);
  const completedAt = new Date().toISOString();
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
      startedAt: completedAt,
      completedAt,
    },
    result,
  );
  await updateRecalculationStatus(db, job.requestId, 'completed', completedAt);
  return persisted;
}
