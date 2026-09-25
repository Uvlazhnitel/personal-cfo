import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../../server/auth.js';
import { disconnectEnableBanking } from '../../../../../../server/enable-banking.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    await disconnectEnableBanking(session.ownerId);
    return NextResponse.json({ status: 'revoked' });
  } catch {
    return NextResponse.json({ error: 'enable_banking_disconnect_failed' }, { status: 502 });
  }
}
