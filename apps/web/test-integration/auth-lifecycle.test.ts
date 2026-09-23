import { resolve } from 'node:path';

import {
  authenticate,
  createDatabaseContext,
  createLocalUser,
  migrateDatabase,
  revokeSession,
} from '@personal-cfo/data';
import type { DatabaseContext } from '@personal-cfo/data';
import { NextRequest } from 'next/server.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CSRF_COOKIE, SESSION_COOKIE, authorizedCommandWith } from '../src/server/auth.js';
import { loadAuthorizedDebugOverview } from '../src/server/debug-access.js';
import { parseClassificationInput } from '../src/app/api/v1/commands/[command]/route.js';

const databaseUrl = process.env['DATABASE_URL'];
const suite = databaseUrl === undefined ? describe.skip : describe;

suite('authenticated browser boundaries', () => {
  let context: DatabaseContext;
  const origin = 'http://127.0.0.1:8080';
  const now = new Date();
  const clock = { now: () => now };
  let session: NonNullable<Awaited<ReturnType<typeof authenticate>>>;

  beforeAll(async () => {
    context = createDatabaseContext(databaseUrl!, { maxConnections: 4 });
    const databaseName = await context.pool.query<{ current_database: string }>(
      'select current_database()',
    );
    if (databaseName.rows[0]?.current_database !== 'personal_cfo_test')
      throw new Error('Integration tests require the personal_cfo_test database.');
    await context.pool.query(
      'drop schema if exists pgboss cascade; drop schema if exists drizzle cascade; drop schema public cascade; create schema public',
    );
    await migrateDatabase(context.db, resolve(process.cwd(), 'packages/data/migrations'));
    await createLocalUser(
      context.db,
      { loginName: 'browser-user', password: 'correct horse battery staple' },
      clock,
    );
    const authenticated = await authenticate(
      context.db,
      'browser-user',
      'correct horse battery staple',
      clock,
    );
    if (authenticated === null) throw new Error('Authentication setup failed.');
    session = authenticated;
  });

  afterAll(async () => context.close());

  function request(options: {
    origin?: string;
    headerCsrf?: string;
    cookieCsrf?: string;
    includeSession?: boolean;
  }): NextRequest {
    const cookies = [
      options.includeSession === false ? null : `${SESSION_COOKIE}=${session.sessionToken}`,
      options.cookieCsrf === undefined ? null : `${CSRF_COOKIE}=${options.cookieCsrf}`,
    ]
      .filter((value): value is string => value !== null)
      .join('; ');
    const headers = new Headers();
    if (cookies.length > 0) headers.set('cookie', cookies);
    if (options.origin !== undefined) headers.set('origin', options.origin);
    if (options.headerCsrf !== undefined) headers.set('x-csrf-token', options.headerCsrf);
    return new NextRequest(`${origin}/api/v1/commands/sinking-allocation`, {
      method: 'POST',
      headers,
    });
  }

  it('rejects missing, wrong, mismatched CSRF and wrong Origin, then accepts valid proof', async () => {
    expect(await authorizedCommandWith(context.db, request({ origin }), origin)).toBeNull();
    expect(
      await authorizedCommandWith(
        context.db,
        request({ origin, headerCsrf: 'wrong', cookieCsrf: 'wrong' }),
        origin,
      ),
    ).toBeNull();
    expect(
      await authorizedCommandWith(
        context.db,
        request({ origin, headerCsrf: session.csrfToken, cookieCsrf: 'different' }),
        origin,
      ),
    ).toBeNull();
    expect(
      await authorizedCommandWith(
        context.db,
        request({
          origin: 'http://wrong.example',
          headerCsrf: session.csrfToken,
          cookieCsrf: session.csrfToken,
        }),
        origin,
      ),
    ).toBeNull();
    expect(
      await authorizedCommandWith(
        context.db,
        request({
          origin,
          headerCsrf: session.csrfToken,
          cookieCsrf: session.csrfToken,
        }),
        origin,
      ),
    ).toMatchObject({ ownerId: session.ownerId });
  });

  it('guards debug access for missing, valid, revoked, and expired sessions', async () => {
    expect(await loadAuthorizedDebugOverview(context.db, undefined, clock)).toEqual({
      status: 'unauthorized',
    });
    expect(
      (await loadAuthorizedDebugOverview(context.db, session.sessionToken, clock)).status,
    ).toBe('authorized');
    await revokeSession(context.db, session.sessionToken, clock);
    expect(await loadAuthorizedDebugOverview(context.db, session.sessionToken, clock)).toEqual({
      status: 'unauthorized',
    });

    const replacement = await authenticate(
      context.db,
      'browser-user',
      'correct horse battery staple',
      clock,
    );
    if (replacement === null) throw new Error('Replacement session setup failed.');
    const expiredClock = { now: () => new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000 + 1) };
    expect(
      await loadAuthorizedDebugOverview(context.db, replacement.sessionToken, expiredClock),
    ).toEqual({ status: 'unauthorized' });
  });

  it.each(['transactionId', 'effectiveAt', 'amount', 'currency'])(
    'rejects classification payloads attempting to change %s',
    (identityField) => {
      expect(() =>
        parseClassificationInput({
          kind: 'consumption',
          reimbursable: false,
          [identityField]: 'forbidden',
        }),
      ).toThrow('unsupported fields');
    },
  );
});
