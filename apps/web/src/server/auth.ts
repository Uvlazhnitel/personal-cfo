import { findSession, verifyCsrf } from '@personal-cfo/data';
import type { AuthenticatedSession } from '@personal-cfo/data';
import type { NextRequest } from 'next/server.js';

import { databaseContext } from './database.js';

export const SESSION_COOKIE = 'personal_cfo_session';
export const CSRF_COOKIE = 'personal_cfo_csrf';

// Next.js replaces direct process.env.NODE_ENV reads at build time. Enumerating
// the supplied environment keeps this startup check bound to the runtime
// container while retaining an injectable object for tests.
function runtimeNodeEnvironment(environment: NodeJS.ProcessEnv): string | undefined {
  if (environment === process.env) {
    const bootEnvironment = (globalThis as unknown as Readonly<Record<string, unknown>>)[
      '__PERSONAL_CFO_BOOT_NODE_ENV'
    ];
    if (typeof bootEnvironment === 'string') return bootEnvironment;
  }
  return Object.entries(environment).find(([key]) => key === 'NODE_ENV')?.[1];
}

export function authConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<{ appOrigin: string; secureCookies: boolean }> {
  const appOrigin = environment['APP_ORIGIN'] ?? 'https://localhost';
  const requestedSecure = environment['SESSION_COOKIE_SECURE'] !== 'false';
  if (!requestedSecure) {
    const url = new URL(appOrigin);
    const loopback =
      url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost');
    if (runtimeNodeEnvironment(environment) !== 'development' || !loopback)
      throw new Error('Insecure session cookies are allowed only for loopback development.');
  }
  return Object.freeze({ appOrigin, secureCookies: requestedSecure });
}

export async function authenticatedRequest(
  request: NextRequest,
): Promise<AuthenticatedSession | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  return token === undefined ? null : findSession(databaseContext().db, token);
}

export async function authorizedCommand(
  request: NextRequest,
): Promise<AuthenticatedSession | null> {
  const session = await authenticatedRequest(request);
  if (session === null) return null;
  const config = authConfiguration();
  if (request.headers.get('origin') !== config.appOrigin) return null;
  const header = request.headers.get('x-csrf-token');
  const cookie = request.cookies.get(CSRF_COOKIE)?.value;
  if (header === null || cookie === undefined || header !== cookie || !verifyCsrf(session, header))
    return null;
  return session;
}
