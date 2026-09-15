import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import { argon2id, hash as argonHash, verify as argonVerify } from 'argon2';

import type { Database } from './database.js';
import { DataConflictError } from './errors.js';
import { generateUuidV7 } from './uuid-v7.js';
import { loginAttempts, ownerInputVersions, sessions, users } from './schema.js';

const SESSION_BYTES = 32;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_MAX_FAILURES = 5;

export type AuthClock = Readonly<{ now: () => Date }>;
const systemClock: AuthClock = Object.freeze({ now: () => new Date() });

function instant(date: Date): string {
  return date.toISOString();
}

function token(): string {
  return randomBytes(SESSION_BYTES).toString('base64url');
}

export function hashBearerToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function canonicalLoginName(value: string): string {
  const normalized = value.normalize('NFKC').toLowerCase();
  if (!/^[a-z0-9._-]{3,64}$/u.test(normalized)) {
    throw new Error(
      'Login must contain 3-64 lowercase ASCII letters, digits, dots, underscores, or hyphens.',
    );
  }
  return normalized;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 256)
    throw new Error('Password must contain 12-256 characters.');
  return argonHash(password, {
    type: argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function createLocalUser(
  db: Database,
  input: Readonly<{ loginName: string; password: string; locale?: string }>,
  clock: AuthClock = systemClock,
): Promise<string> {
  const loginName = canonicalLoginName(input.loginName);
  const now = instant(clock.now());
  const id = generateUuidV7('owner');
  const passwordHash = await hashPassword(input.password);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id,
        loginName,
        passwordHash,
        locale: input.locale ?? 'en',
        timeZone: 'Europe/Riga',
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(ownerInputVersions).values({ ownerId: id, version: 0n, updatedAt: now });
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
      throw new DataConflictError('auth.duplicate_login', 'The login already exists.');
    }
    throw error;
  }
  return id;
}

export type CreatedSession = Readonly<{
  ownerId: string;
  sessionToken: string;
  csrfToken: string;
  expiresAt: string;
}>;

export async function authenticate(
  db: Database,
  login: string,
  password: string,
  clock: AuthClock = systemClock,
): Promise<CreatedSession | null> {
  const loginName = canonicalLoginName(login);
  const nowDate = clock.now();
  const now = instant(nowDate);
  const attempt = await db.query.loginAttempts.findFirst({
    where: eq(loginAttempts.loginKey, loginName),
  });
  if (
    attempt?.blockedUntil !== null &&
    attempt?.blockedUntil !== undefined &&
    Date.parse(attempt.blockedUntil) > nowDate.getTime()
  )
    return null;
  const user = await db.query.users.findFirst({ where: eq(users.loginName, loginName) });
  const valid = user !== undefined && (await verifyPassword(user.passwordHash, password));
  if (!valid) {
    const withinWindow =
      attempt !== undefined &&
      Date.parse(attempt.windowStartedAt) > nowDate.getTime() - LOGIN_WINDOW_MS;
    const failures = withinWindow ? attempt.failureCount + 1 : 1;
    const blockedUntil =
      failures >= LOGIN_MAX_FAILURES
        ? instant(new Date(nowDate.getTime() + LOGIN_WINDOW_MS))
        : null;
    const windowStartedAt = withinWindow && attempt !== undefined ? attempt.windowStartedAt : now;
    await db
      .insert(loginAttempts)
      .values({
        loginKey: loginName,
        failureCount: failures,
        windowStartedAt,
        blockedUntil,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: loginAttempts.loginKey,
        set: { failureCount: failures, windowStartedAt, blockedUntil, updatedAt: now },
      });
    return null;
  }
  const sessionToken = token();
  const csrfToken = token();
  const expiresAt = instant(new Date(nowDate.getTime() + SESSION_TTL_MS));
  await db.transaction(async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(and(eq(sessions.ownerId, user.id), isNull(sessions.revokedAt)));
    await tx.insert(sessions).values({
      id: generateUuidV7('session'),
      ownerId: user.id,
      tokenHash: hashBearerToken(sessionToken),
      csrfHash: hashBearerToken(csrfToken),
      createdAt: now,
      expiresAt,
      lastUsedAt: now,
      revokedAt: null,
    });
    await tx.delete(loginAttempts).where(eq(loginAttempts.loginKey, loginName));
  });
  return Object.freeze({ ownerId: user.id, sessionToken, csrfToken, expiresAt });
}

export type AuthenticatedSession = Readonly<{
  ownerId: string;
  sessionId: string;
  csrfHash: string;
}>;

export async function findSession(
  db: Database,
  sessionToken: string,
  clock: AuthClock = systemClock,
): Promise<AuthenticatedSession | null> {
  const nowDate = clock.now();
  const now = instant(nowDate);
  const found = await db.query.sessions.findFirst({
    where: and(
      eq(sessions.tokenHash, hashBearerToken(sessionToken)),
      isNull(sessions.revokedAt),
      gt(sessions.expiresAt, now),
    ),
  });
  if (found === undefined) return null;
  if (Date.parse(found.lastUsedAt) <= nowDate.getTime() - 5 * 60 * 1_000) {
    await db.update(sessions).set({ lastUsedAt: now }).where(eq(sessions.id, found.id));
  }
  return Object.freeze({ ownerId: found.ownerId, sessionId: found.id, csrfHash: found.csrfHash });
}

export function verifyCsrf(session: AuthenticatedSession, providedToken: string): boolean {
  const expected = Buffer.from(session.csrfHash, 'hex');
  const actual = Buffer.from(hashBearerToken(providedToken), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function revokeSession(
  db: Database,
  sessionToken: string,
  clock: AuthClock = systemClock,
): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: instant(clock.now()) })
    .where(and(eq(sessions.tokenHash, hashBearerToken(sessionToken)), isNull(sessions.revokedAt)));
}

export async function deleteExpiredSessions(
  db: Database,
  clock: AuthClock = systemClock,
): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, instant(clock.now())))
    .returning({ id: sessions.id });
  return deleted.length;
}
