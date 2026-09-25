import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authenticatedRequest, authorizedCommand } from '../../../../../../server/auth.js';
import {
  bindEnableBankingAccount,
  getEnableBankingAccounts,
} from '../../../../../../server/enable-banking.js';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await authenticatedRequest(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  try {
    return NextResponse.json({ accounts: await getEnableBankingAccounts(session.ownerId) });
  } catch {
    return NextResponse.json({ error: 'enable_banking_accounts_failed' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    const body = (await request.json()) as unknown;
    if (
      typeof body !== 'object' ||
      body === null ||
      Array.isArray(body) ||
      typeof (body as Record<string, unknown>)['providerAccountId'] !== 'string' ||
      typeof (body as Record<string, unknown>)['canonicalAccountId'] !== 'string'
    ) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    await bindEnableBankingAccount(
      session.ownerId,
      (body as Record<string, string>)['providerAccountId']!,
      (body as Record<string, string>)['canonicalAccountId']!,
    );
    return NextResponse.json({ status: 'bound' });
  } catch {
    return NextResponse.json({ error: 'enable_banking_bind_failed' }, { status: 409 });
  }
}
