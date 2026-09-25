import { createDatabaseContext, requireDatabaseUrl } from '@personal-cfo/data';

import { enableBankingConfiguration } from '../enable-banking/config.js';
import { executeEnableBankingDiagnosticFetch } from '../enable-banking/fetch.js';

const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 4 });
try {
  const configuration = await enableBankingConfiguration();
  const result = await executeEnableBankingDiagnosticFetch(database.db, configuration);
  console.info(
    JSON.stringify({
      event: 'enable_banking.fetch.completed',
      counts: result.counts,
      balanceKinds: result.balanceKinds,
      transactionStatuses: result.transactionStatuses,
      coverageStatus: result.coverage.status,
      coveragePresent: result.coverage.present,
      authoritativeBookedPresent: result.authoritativeBookedPresent,
      confirmedPrincipalsCreated: result.confirmedPrincipalsCreated,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'enable_banking.fetch.failed',
      category:
        error instanceof Error && 'category' in error && typeof error.category === 'string'
          ? error.category
          : error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : 'enable_banking_fetch_failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
