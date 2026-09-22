import { createDatabaseContext, requireDatabaseUrl } from '@personal-cfo/data';

import { sharesightConfiguration } from '../sharesight/config.js';
import { executeSharesightSync } from '../sharesight/sync.js';

const database = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 4 });
try {
  const result = await executeSharesightSync(database.db, sharesightConfiguration());
  console.info(
    JSON.stringify({
      event: 'sharesight.sync.completed',
      sourceFreshness: result.sourceFreshness,
      warnings: result.warnings,
      counts: result.counts,
      contributions: result.contributions.length,
      trades: result.trades.length,
      payouts: result.payouts.length,
      providerProfitLoss: result.providerProfitLoss.length,
      confirmedPrincipalsCreated: result.confirmedPrincipalsCreated,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: 'sharesight.sync.failed',
      category:
        error instanceof Error && 'category' in error && typeof error.category === 'string'
          ? error.category
          : 'sharesight_sync_failed',
    }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
