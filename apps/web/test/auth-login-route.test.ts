import { NextRequest } from 'next/server.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@personal-cfo/data', () => ({
  authenticate: vi.fn(() =>
    Promise.resolve({
      ownerId: '01990000-0000-7000-8000-000000000001',
      sessionToken: 'session-token',
      csrfToken: 'csrf-token',
      expiresAt: '2026-10-04T00:00:00.000Z',
    }),
  ),
}));

vi.mock('../src/server/database.js', () => ({
  databaseContext: () => ({ db: {} }),
}));

import { POST } from '../src/app/api/v1/auth/login/route.js';

describe('login route', () => {
  beforeEach(() => {
    process.env['APP_ORIGIN'] = 'https://localhost:3443';
    process.env['SESSION_COOKIE_SECURE'] = 'true';
  });

  afterEach(() => {
    delete process.env['APP_ORIGIN'];
    delete process.env['SESSION_COOKIE_SECURE'];
  });

  it('redirects to the configured public origin behind a reverse proxy', async () => {
    const request = new NextRequest('https://localhost:3000/api/v1/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://localhost:3443',
      },
      body: new URLSearchParams({ login: 'production-owner', password: 'not-inspected' }),
    });

    const response = await POST(request);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://localhost:3443/');
  });
});
