import { NextRequest } from 'next/server.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authorizedCommand = vi.fn();
const activateEnableBankingAccount = vi.fn();

vi.mock('../src/server/auth.js', () => ({ authorizedCommand }));
vi.mock('../src/server/enable-banking.js', () => ({ activateEnableBankingAccount }));

const { POST } = await import('../src/app/api/v1/open-banking/enable-banking/activate/route.js');

function request(body: unknown): NextRequest {
  return new NextRequest('https://localhost:3443/api/v1/open-banking/enable-banking/activate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Enable Banking atomic activation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authorizedCommand.mockResolvedValue({ ownerId: '018f0000-0000-7000-8000-000000000001' });
  });

  it('rejects the legacy timestamp-only activation request', async () => {
    const response = await POST(
      request({ providerAccountId: '018f0000-0000-7000-8000-000000000002' }),
    );
    expect(response.status).toBe(400);
    expect(activateEnableBankingAccount).not.toHaveBeenCalled();
  });

  it('passes exact opening evidence and explicit confirmation to atomic activation', async () => {
    activateEnableBankingAccount.mockResolvedValue({
      replayed: false,
      bookedImported: 804,
      reconciliationStatus: 'unresolved_pending',
      inputVersion: 1n,
    });
    const response = await POST(
      request({
        evidence: {
          providerAccountId: '018f0000-0000-7000-8000-000000000002',
          openingBalanceMinor: '-12345',
          currency: 'EUR',
          statementPeriodFrom: '2024-09-27',
          statementPeriodThrough: '2026-09-27',
          balanceBoundaryAt: '2024-09-26T21:00:00.000Z',
          statementSha256: 'a'.repeat(64),
        },
        expectedPlanFingerprint: 'b'.repeat(64),
        confirmation: 'ACTIVATE_CANONICAL_IMPORT',
      }),
    );
    expect(response.status).toBe(200);
    const activationCall = activateEnableBankingAccount.mock.calls[0] as
      [string, { evidence: { openingBalanceMinor: bigint }; confirmation: string }] | undefined;
    expect(activationCall?.[0]).toBe('018f0000-0000-7000-8000-000000000001');
    expect(activationCall?.[1].evidence.openingBalanceMinor).toBe(-12_345n);
    expect(activationCall?.[1].confirmation).toBe('ACTIVATE_CANONICAL_IMPORT');
    await expect(response.json()).resolves.toMatchObject({
      status: 'activated',
      bookedImported: 804,
      inputVersion: '1',
    });
  });
});
