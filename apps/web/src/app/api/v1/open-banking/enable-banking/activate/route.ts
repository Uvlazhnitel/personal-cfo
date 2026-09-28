import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';

import { authorizedCommand } from '../../../../../../server/auth.js';
import { activateEnableBankingAccount } from '../../../../../../server/enable-banking.js';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await authorizedCommand(request);
  if (session === null) return NextResponse.json({ error: 'unauthorized' }, { status: 403 });
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    const rawEvidence = record['evidence'];
    if (typeof rawEvidence !== 'object' || rawEvidence === null || Array.isArray(rawEvidence))
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    const evidence = rawEvidence as Record<string, unknown>;
    const amountMinor = evidence['openingBalanceMinor'];
    if (
      typeof evidence['providerAccountId'] !== 'string' ||
      typeof amountMinor !== 'string' ||
      !/^-?[0-9]+$/u.test(amountMinor) ||
      evidence['currency'] !== 'EUR' ||
      typeof evidence['statementPeriodFrom'] !== 'string' ||
      typeof evidence['statementPeriodThrough'] !== 'string' ||
      typeof evidence['balanceBoundaryAt'] !== 'string' ||
      typeof evidence['statementSha256'] !== 'string' ||
      typeof record['expectedPlanFingerprint'] !== 'string' ||
      record['confirmation'] !== 'ACTIVATE_CANONICAL_IMPORT'
    )
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    const result = await activateEnableBankingAccount(session.ownerId, {
      evidence: {
        providerAccountId: evidence['providerAccountId'],
        openingBalanceMinor: BigInt(amountMinor),
        currency: 'EUR',
        statementPeriodFrom: evidence['statementPeriodFrom'],
        statementPeriodThrough: evidence['statementPeriodThrough'],
        balanceBoundaryAt: evidence['balanceBoundaryAt'],
        statementSha256: evidence['statementSha256'],
      },
      expectedPlanFingerprint: record['expectedPlanFingerprint'],
      confirmation: 'ACTIVATE_CANONICAL_IMPORT',
    });
    return NextResponse.json({
      status: 'activated',
      replayed: result.replayed,
      bookedImported: result.bookedImported,
      reconciliationStatus: result.reconciliationStatus,
      inputVersion: result.inputVersion.toString(),
    });
  } catch {
    return NextResponse.json({ error: 'enable_banking_activation_blocked' }, { status: 409 });
  }
}
