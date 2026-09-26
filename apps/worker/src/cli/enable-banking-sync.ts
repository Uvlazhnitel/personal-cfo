import { createDatabaseContext, createJobBoss, requireDatabaseUrl } from '@personal-cfo/data';

import { enableBankingConfiguration } from '../enable-banking/config.js';
import { executeEnableBankingSync } from '../enable-banking/sync.js';

const configuration = await enableBankingConfiguration();
const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 5 });
const boss = createJobBoss(requireDatabaseUrl(), 3);

try {
  await boss.start();
  const result = await executeEnableBankingSync(database.db, boss, configuration, {
    canonicalImportEnabled: configuration.canonicalImportEnabled ?? false,
  });
  console.info(
    JSON.stringify({
      event: 'enable_banking.sync.completed',
      strategy: result.strategy,
      completionStatus: result.completionStatus,
      counts: result.counts,
      coverageStatus: result.coverage.status,
      reconciliationStatus: result.reconciliationStatus,
      activationUnmet: result.activation.unmet,
      confirmedPrincipalsCreated: result.confirmedPrincipalsCreated,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'enable_banking.sync.failed',
      category:
        error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'enable_banking_sync_failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await boss.stop({ graceful: true, timeout: 5_000, close: true }).catch(() => undefined);
  await database.close();
}
