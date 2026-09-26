import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../../server/auth.js';
import { activateEnableBankingAccount } from '../../../../../../server/enable-banking.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    const body = (await request.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>)['providerAccountId'] !== 'string'
    ) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    await activateEnableBankingAccount(
      session.ownerId,
      (body as Record<string, string>)['providerAccountId']!,
    );
    return NextResponse.json({ status: 'activated' });
  } catch {
    return NextResponse.json({ error: 'enable_banking_activation_blocked' }, { status: 409 });
  }
}
