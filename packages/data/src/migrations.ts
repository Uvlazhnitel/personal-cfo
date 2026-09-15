import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from './database.js';

export async function migrateDatabase(db: Database, migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
