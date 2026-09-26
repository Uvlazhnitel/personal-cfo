import { NextRequest, NextResponse } from 'next/server.js';
import { describe, expect, it, vi } from 'vitest';

import { POST as commandPost } from '../src/app/api/v1/commands/[command]/route.js';
import { GET as callbackGet } from '../src/app/api/v1/open-banking/enable-banking/callback/route.js';
import { POST as activatePost } from '../src/app/api/v1/open-banking/enable-banking/activate/route.js';
import {
  POST as connectPost,
  enableBankingAuthorizationResponse,
} from '../src/app/api/v1/open-banking/enable-banking/connect/route.js';
import { readCookieValue, startEnableBankingConnection } from '../src/app/debug/connect-bank.js';
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

  it('starts Connect Bank with the session CSRF token and navigates without exposing the URL', async () => {
    expect(readCookieValue('first=one; personal_cfo_csrf=token%2Bvalue', 'personal_cfo_csrf')).toBe(
      'token+value',
    );
    expect(readCookieValue('first=one', 'personal_cfo_csrf')).toBeNull();
    const fetchImplementation = vi.fn(() =>
      Promise.resolve(
        NextResponse.json({
          authorizationUrl: 'https://auth.enablebanking.com/authorization/synthetic',
        }),
      ),
    );
    const navigate = vi.fn();
    await startEnableBankingConnection(
      'personal_cfo_csrf=token%2Bvalue',
      fetchImplementation,
      navigate,
    );
    expect(fetchImplementation).toHaveBeenCalledWith(
      '/api/v1/open-banking/enable-banking/connect',
      expect.objectContaining({
        method: 'POST',
        headers: { Accept: 'application/json', 'x-csrf-token': 'token+value' },
      }),
    );
    expect(navigate).toHaveBeenCalledOnce();
  });

  it('returns authorization URLs only in an explicit no-store JSON response', async () => {
    const authorizationUrl = 'https://auth.enablebanking.com/authorization/synthetic';
    const jsonRequest = new NextRequest(
      'http://localhost:3000/api/v1/open-banking/enable-banking/connect',
      { method: 'POST', headers: { accept: 'application/json' } },
    );
    const json = enableBankingAuthorizationResponse(jsonRequest, authorizationUrl);
    expect(json.status).toBe(200);
    expect(json.headers.get('cache-control')).toBe('no-store');
    expect(await json.json()).toEqual({ authorizationUrl });

    const redirectRequest = new NextRequest(
      'http://localhost:3000/api/v1/open-banking/enable-banking/connect',
      { method: 'POST' },
    );
    const redirect = enableBankingAuthorizationResponse(redirectRequest, authorizationUrl);
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe(authorizationUrl);
  });
});
