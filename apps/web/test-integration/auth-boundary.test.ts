import { NextRequest } from 'next/server.js';
import { describe, expect, it } from 'vitest';

import { POST as commandPost } from '../src/app/api/v1/commands/[command]/route.js';
import { GET as callbackGet } from '../src/app/api/v1/open-banking/enable-banking/callback/route.js';
import { POST as activatePost } from '../src/app/api/v1/open-banking/enable-banking/activate/route.js';
import { POST as connectPost } from '../src/app/api/v1/open-banking/enable-banking/connect/route.js';
import { POST as disconnectPost } from '../src/app/api/v1/open-banking/enable-banking/disconnect/route.js';
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

  it('protects Enable Banking mutations and rejects malformed public callbacks', async () => {
    const connect = new NextRequest(
      'http://127.0.0.1:8080/api/v1/open-banking/enable-banking/connect',
      { method: 'POST' },
    );
    expect((await connectPost(connect)).status).toBe(403);
    const disconnect = new NextRequest(
      'http://127.0.0.1:8080/api/v1/open-banking/enable-banking/disconnect',
      { method: 'POST' },
    );
    expect((await disconnectPost(disconnect)).status).toBe(403);
    const activate = new NextRequest(
      'http://127.0.0.1:8080/api/v1/open-banking/enable-banking/activate',
      { method: 'POST' },
    );
    expect((await activatePost(activate)).status).toBe(403);
    const callback = new NextRequest(
      'http://attacker.example/api/v1/open-banking/enable-banking/callback?state=one&state=two&code=code',
    );
    const response = await callbackGet(callback);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('https://localhost/debug?open_banking=failed');
  });
});
