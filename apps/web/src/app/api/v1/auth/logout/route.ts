import { revokeSession } from '@personal-cfo/data';
import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { CSRF_COOKIE, SESSION_COOKIE, authorizedCommand } from '../../../../../server/auth.js';
import { databaseContext } from '../../../../../server/database.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token !== undefined) await revokeSession(databaseContext().db, token);
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  response.cookies.delete(CSRF_COOKIE);
  return response;
}
