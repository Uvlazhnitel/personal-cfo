import {
  createDatabaseContext,
  ensureSyntheticOwner,
  generateUuidV7,
  requireDatabaseUrl,
  saveFinancialEngineSource,
} from '@personal-cfo/data';

import { buildSyntheticScenario } from '../../../../packages/financial-engine/test/fixtures/stage3/synthetic-scenarios.js';
import { recalculateFinancialState } from '../recalculation.js';

const context = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 4 });
try {
  const scenario = buildSyntheticScenario('healthy_current');
  const now = new Date().toISOString();
  const ownerId = await ensureSyntheticOwner(context.db, now);
  const imported = await saveFinancialEngineSource(context.db, ownerId, scenario, now);
  const recalculated = await recalculateFinancialState(context.db, {
    requestId: generateUuidV7('recalculation'),
    ownerId,
    inputVersion: imported.inputVersion.toString(),
    cause: 'synthetic_import',
    asOf: scenario.run.asOf,
    effectiveDate: scenario.run.effectiveDate,
    earliestAffectedAt: null,
  });
  console.info(
    JSON.stringify({
      event: 'synthetic.imported',
      ownerId,
      changed: imported.changed,
      inputVersion: imported.inputVersion.toString(),
      runId: recalculated.runId,
      reused: recalculated.reused,
    }),
  );
} finally {
  await context.close();
}
