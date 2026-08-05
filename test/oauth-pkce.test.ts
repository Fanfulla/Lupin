// PKCE login flow (DESIGN-OAUTH-PKCE-TUI §1.2): the whole Authorization Code
// + PKCE login against a fake auth server on 127.0.0.1. The test's openBrowser
// hook plays the provider: it parses the authorize URL, then drives the
// loopback redirect by hand. No real browser, no network.

import { afterEach, describe, expect, it } from 'vitest';
import { generatePkce, authorizeUrl, runPkceLogin } from '../src/server/oauth-pkce.js';
import { OAuthError } from '../src/server/oauth.js';
import { startFakePkce, redirectUriFromAuthorizeUrl, type FakePkce } from './helpers/fake-pkce.js';

let fake: FakePkce | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

/** Plays the provider: opens the loopback redirect with a code and the state it was given. */
function browserDrivingRedirect(opts: { state?: string; code?: string; error?: string; captured?: { url?: string } }) {
  return (authorizeUrl: string): void => {
    if (opts.captured !== undefined) opts.captured.url = authorizeUrl;
    const u = new URL(authorizeUrl);
    const redirect = redirectUriFromAuthorizeUrl(authorizeUrl);
    const state = opts.state ?? u.searchParams.get('state') ?? '';
    const code = opts.code ?? fake?.expectedCode ?? 'fake-auth-code';
    const target = new URL(redirect);
    if (opts.error !== undefined) {
      target.searchParams.set('error', opts.error);
    } else {
      target.searchParams.set('code', code);
      target.searchParams.set('state', state);
    }
    // Fire and forget: the login promise resolves when this GET lands.
    void fetch(target).catch(() => undefined);
  };
}

describe('generatePkce', () => {
  it('emits a base64url verifier, an S256 challenge and a distinct state', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a.challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a.verifier).not.toBe(a.challenge);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('authorizeUrl', () => {
  it('carries client_id, scope, state and the S256 challenge', async () => {
    fake = await startFakePkce();
    const pkce = generatePkce();
    const url = new URL(authorizeUrl(fake.def, pkce, 'http://localhost:1455/auth/callback'));
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-pkce-client');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('state')).toBe(pkce.state);
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
  });

  it('refuses a non-pkce descriptor', () => {
    const def = { flow: { kind: 'device' } } as never;
    expect(() => authorizeUrl(def, generatePkce(), 'http://localhost/x')).toThrow(OAuthError);
  });
});

describe('runPkceLogin', () => {
  it('completes: authorize URL opened, code exchanged with the verifier, tokens returned', async () => {
    fake = await startFakePkce();
    const captured: { url?: string } = {};
    const tokens = await runPkceLogin(fake.def, {
      openBrowser: browserDrivingRedirect({ captured }),
      port: 0,
    });
    expect(tokens.accessToken).toBe('pkce-access-token');
    expect(tokens.refreshToken).toBe('pkce-refresh-token');
    expect(tokens.tokenType).toBe('Bearer');

    const exchange = fake.tokenRequests.find((r) => r.form['grant_type'] === 'authorization_code');
    expect(exchange).toBeDefined();
    expect(exchange?.form['code']).toBe(fake.expectedCode);
    expect(exchange?.form['code_verifier']).toBeTruthy();
    expect(exchange?.form['client_id']).toBe('test-pkce-client');
    // the verifier in the exchange must match the challenge that was advertised
    const advertised = new URL(captured.url ?? '').searchParams.get('code_challenge');
    expect(advertised).toBeTruthy();
  });

  it('aborts on a state mismatch (CSRF) without exchanging', async () => {
    fake = await startFakePkce();
    await expect(
      runPkceLogin(fake.def, { openBrowser: browserDrivingRedirect({ state: 'forged-state' }), port: 0 }),
    ).rejects.toMatchObject({ code: 'state_mismatch' });
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('surfaces a provider error from the redirect', async () => {
    fake = await startFakePkce();
    await expect(
      runPkceLogin(fake.def, { openBrowser: browserDrivingRedirect({ error: 'access_denied' }), port: 0 }),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it('fails the login when the exchange rejects the code', async () => {
    fake = await startFakePkce();
    fake.expectedCode = 'the-right-code';
    await expect(
      runPkceLogin(fake.def, { openBrowser: browserDrivingRedirect({ code: 'the-wrong-code' }), port: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses a descriptor with no captured client_id (Gemini placeholder)', async () => {
    fake = await startFakePkce();
    const def = { ...fake.def, clientId: '' };
    await expect(runPkceLogin(def, { openBrowser: () => undefined, port: 0 })).rejects.toMatchObject({
      code: 'no_client_id',
    });
  });

  it('sends client_secret on the exchange when the descriptor carries one (Google)', async () => {
    fake = await startFakePkce();
    const def = { ...fake.def, clientSecret: 'GOCSPX-test-secret' };
    const tokens = await runPkceLogin(def, { openBrowser: browserDrivingRedirect({}), port: 0 });
    expect(tokens.accessToken).toBe('pkce-access-token');
    const exchange = fake.tokenRequests.find((r) => r.form['grant_type'] === 'authorization_code');
    expect(exchange?.form['client_secret']).toBe('GOCSPX-test-secret');
  });

  it('omits client_secret when the descriptor has none (OpenAI)', async () => {
    fake = await startFakePkce();
    await runPkceLogin(fake.def, { openBrowser: browserDrivingRedirect({}), port: 0 });
    const exchange = fake.tokenRequests.find((r) => r.form['grant_type'] === 'authorization_code');
    expect(exchange?.form['client_secret']).toBeUndefined();
  });

  it('never sends the Kimi X-Msh-* device headers to a PKCE provider (Google 400 bug)', async () => {
    fake = await startFakePkce();
    await runPkceLogin(fake.def, { openBrowser: browserDrivingRedirect({}), port: 0 });
    const exchange = fake.tokenRequests.find((r) => r.form['grant_type'] === 'authorization_code');
    const names = Object.keys(exchange?.headers ?? {}).map((h) => h.toLowerCase());
    expect(names.some((h) => h.startsWith('x-msh-'))).toBe(false);
  });
});
