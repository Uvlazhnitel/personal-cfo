import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';

import * as schema from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type DatabaseContext = Readonly<{
  pool: Pool;
  db: Database;
  close: () => Promise<void>;
}>;

export function createDatabaseContext(
  connectionString: string,
  options: Readonly<{ maxConnections?: number }> = {},
): DatabaseContext {
  if (connectionString.length === 0) throw new Error('DATABASE_URL must not be empty.');
  const config: PoolConfig = {
    connectionString,
    max: options.maxConnections ?? 10,
    application_name: 'personal-cfo',
    options: '-c timezone=UTC',
  };
  const pool = new Pool(config);
  const db = drizzle({ client: pool, schema });
  return Object.freeze({ pool, db, close: () => pool.end() });
}

export function requireDatabaseUrl(environment: NodeJS.ProcessEnv = process.env): string {
  const value = environment['DATABASE_URL'];
  if (value === undefined || value.trim().length === 0) {
    throw new Error('DATABASE_URL is required.');
  }
  return value;
}
