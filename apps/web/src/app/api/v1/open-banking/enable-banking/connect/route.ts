import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../../server/auth.js';
import { startEnableBankingAuthorization } from '../../../../../../server/enable-banking.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    return NextResponse.redirect(await startEnableBankingAuthorization(session.ownerId), 303);
  } catch {
    return NextResponse.json({ error: 'enable_banking_connect_failed' }, { status: 502 });
  }
}
