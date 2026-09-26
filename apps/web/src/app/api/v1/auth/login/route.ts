import { authenticate } from '@personal-cfo/data';
import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { CSRF_COOKIE, SESSION_COOKIE, authConfiguration } from '../../../../../server/auth.js';
import { databaseContext } from '../../../../../server/database.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const config = authConfiguration();
  if (request.headers.get('origin') !== config.appOrigin)
    return NextResponse.json({ error: 'invalid_origin' }, { status: 403 });
  const form = await request.formData();
  const login = form.get('login');
  const password = form.get('password');
  if (typeof login !== 'string' || typeof password !== 'string')
    return NextResponse.json({ error: 'invalid_credentials' }, { status: 400 });
  const session = await authenticate(databaseContext().db, login, password);
  if (session === null) return NextResponse.json({ error: 'invalid_credentials' }, { status: 401 });
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.cookies.set(SESSION_COOKIE, session.sessionToken, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  });
  response.cookies.set(CSRF_COOKIE, session.csrfToken, {
    httpOnly: false,
    secure: config.secureCookies,
    sameSite: 'lax',
    path: '/',
    expires: new Date(session.expiresAt),
  });
  return response;
}
