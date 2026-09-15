import { eq } from 'drizzle-orm';

import type { Database } from './database.js';
import { hashPassword } from './auth.js';
import { ownerInputVersions, users } from './schema.js';

export const SYNTHETIC_OWNER_ID = '018f0000-0000-7000-8000-000000000001';
export const SYNTHETIC_LOGIN = 'synthetic_stage5';

export async function ensureSyntheticOwner(db: Database, now: string): Promise<string> {
  const existing = await db.query.users.findFirst({ where: eq(users.id, SYNTHETIC_OWNER_ID) });
  if (existing !== undefined) return existing.id;
  const unguessableUnusedPassword = `disabled-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const passwordHash = await hashPassword(unguessableUnusedPassword);
  await db.transaction(async (tx) => {
    await tx
      .insert(users)
      .values({
        id: SYNTHETIC_OWNER_ID,
        loginName: SYNTHETIC_LOGIN,
        passwordHash,
        locale: 'en',
        timeZone: 'Europe/Riga',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await tx
      .insert(ownerInputVersions)
      .values({ ownerId: SYNTHETIC_OWNER_ID, version: 0n, updatedAt: now })
      .onConflictDoNothing();
  });
  return SYNTHETIC_OWNER_ID;
}
