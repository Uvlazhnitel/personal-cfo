import { resolve } from 'node:path';

import { createDatabaseContext, migrateDatabase, requireDatabaseUrl } from '@personal-cfo/data';

const context = createDatabaseContext(requireDatabaseUrl(), { maxConnections: 2 });
try {
  const migrationsFolder =
    process.env['MIGRATIONS_DIR'] ?? resolve(process.cwd(), '../../packages/data/migrations');
  await migrateDatabase(context.db, migrationsFolder);
  console.info(JSON.stringify({ event: 'database.migrated' }));
} finally {
  await context.close();
}
