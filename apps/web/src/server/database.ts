import { createDatabaseContext, requireDatabaseUrl } from '@personal-cfo/data';
import type { DatabaseContext } from '@personal-cfo/data';

let context: DatabaseContext | undefined;

export function databaseContext(): DatabaseContext {
  context ??= createDatabaseContext(requireDatabaseUrl(), { maxConnections: 10 });
  return context;
}
