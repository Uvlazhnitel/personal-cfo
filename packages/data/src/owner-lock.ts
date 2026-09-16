import { sql } from 'drizzle-orm';

import type { Database } from './database.js';

export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function lockOwnerFinancialState(
  tx: DatabaseTransaction,
  ownerId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
}
