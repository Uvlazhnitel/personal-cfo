import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';

import { POST as commandPost } from '../src/app/api/v1/commands/[command]/route.js';
import { authConfiguration } from '../src/server/auth.js';

describe('web authentication boundary', () => {
  it('defaults session cookies to secure', () => {
    expect(
      authConfiguration({ APP_ORIGIN: 'https://cfo.example', NODE_ENV: 'production' }),
    ).toEqual({ appOrigin: 'https://cfo.example', secureCookies: true });
  });

  it('allows insecure cookies only for loopback development', () => {
    expect(
      authConfiguration({
        APP_ORIGIN: 'http://127.0.0.1:8080',
        NODE_ENV: 'development',
        SESSION_COOKIE_SECURE: 'false',
      }).secureCookies,
    ).toBe(false);
    expect(() =>
      authConfiguration({
        APP_ORIGIN: 'http://cfo.example',
        NODE_ENV: 'development',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('loopback development');
    expect(() =>
      authConfiguration({
        APP_ORIGIN: 'http://127.0.0.1:8080',
        NODE_ENV: 'production',
        SESSION_COOKIE_SECURE: 'false',
      }),
    ).toThrow('loopback development');
  });

  it('rejects an unauthenticated financial command', async () => {
    const request = new NextRequest('http://127.0.0.1:8080/api/v1/commands/sinking-allocation', {
      method: 'POST',
    });
    const response = await commandPost(request, {
      params: Promise.resolve({ command: 'sinking-allocation' }),
    });
    expect(response.status).toBe(403);
  });
});
