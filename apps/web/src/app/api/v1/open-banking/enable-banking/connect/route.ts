import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../../server/auth.js';
import { startEnableBankingAuthorization } from '../../../../../../server/enable-banking.js';

export function enableBankingAuthorizationResponse(
  request: NextRequest,
  authorizationUrl: string,
): NextResponse {
  if (request.headers.get('accept')?.includes('application/json') === true) {
    return NextResponse.json(
      { authorizationUrl },
      { headers: { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } },
    );
  }
  return NextResponse.redirect(authorizationUrl, 303);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    return enableBankingAuthorizationResponse(
      request,
      await startEnableBankingAuthorization(session.ownerId),
    );
  } catch {
    return NextResponse.json({ error: 'enable_banking_connect_failed' }, { status: 502 });
  }
}
