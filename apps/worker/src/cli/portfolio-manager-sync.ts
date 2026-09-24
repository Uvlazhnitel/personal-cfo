import { createDatabaseContext, requireDatabaseUrl } from '@personal-cfo/data';

import { portfolioManagerConfiguration } from '../portfolio-manager/config.js';
import { executePortfolioManagerSync } from '../portfolio-manager/sync.js';

const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 4 });
try {
  const result = await executePortfolioManagerSync(database.db, portfolioManagerConfiguration());
  console.info(
    JSON.stringify({
      event: 'portfolio_manager.sync.completed',
      sourceCompleteness: result.sourceCompleteness,
      warnings: result.warnings,
      counts: result.counts,
      holdings: result.holdings.length,
      capitalFlows: result.capitalFlows.length,
      contributions: result.contributions.length,
      checkpointPresent: result.checkpoint !== null,
      confirmedPrincipalsCreated: result.confirmedPrincipalsCreated,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'portfolio_manager.sync.failed',
      category:
        error instanceof Error && 'category' in error && typeof error.category === 'string'
          ? error.category
          : 'portfolio_manager_sync_failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
