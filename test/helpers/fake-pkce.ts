// Fake OAuth PKCE provider (DESIGN-OAUTH-PKCE-TUI §1.2): the sibling of
// fake-oauth.ts for the Authorization Code + PKCE flow. It plays the auth
// server (token exchange) and lets the test drive the loopback redirect by
// hand, so the whole login runs against 127.0.0.1 with no browser.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuthProviderDef } from '../../src/providers/oauth.js';

export interface PkceTokenRequest {
  form: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakePkce {
  url: string;
  def: OAuthProviderDef;
  /** Every token-endpoint form received, in order. */
  tokenRequests: PkceTokenRequest[];
  /** The code the fake will accept on exchange; any other code is an error. */
  expectedCode: string;
  /** When set, the exchange answers this OAuth error instead of tokens. */
  exchangeError?: { error: string; error_description?: string };
  close(): Promise<void>;
}

/**
 * Starts the fake auth server on an ephemeral port. The descriptor's
 * redirectPort is 0 (ephemeral) so the login's loopback listener picks a free
 * port and the test reads it back from the authorize URL.
 */
export async function startFakePkce(): Promise<FakePkce> {
  const tokenRequests: PkceTokenRequest[] = [];
  const state: FakePkce = {
    url: '',
    def: undefined as unknown as OAuthProviderDef,
    tokenRequests,
    expectedCode: 'fake-auth-code',
    close: () => Promise.resolve(),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
        tokenRequests.push({ form, headers: req.headers });
        res.setHeader('content-type', 'application/json');
        if (state.exchangeError !== undefined) {
          res.end(JSON.stringify(state.exchangeError));
          return;
        }
        if (form['grant_type'] === 'authorization_code') {
          if (form['code'] !== state.expectedCode) {
            res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'wrong code' }));
            return;
          }
          if (form['code_verifier'] === undefined || form['code_verifier'] === '') {
            res.end(JSON.stringify({ error: 'invalid_request', error_description: 'missing code_verifier' }));
            return;
          }
          res.end(
            JSON.stringify({
              access_token: 'pkce-access-token',
              refresh_token: 'pkce-refresh-token',
              expires_in: 3600,
              scope: 'openid profile email offline_access',
              token_type: 'Bearer',
            }),
          );
          return;
        }
        res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;
  state.url = url;
  state.def = {
    id: 'openai',
    aliases: ['openai'],
    host: url,
    clientId: 'test-pkce-client',
    flow: {
      kind: 'pkce',
      authorizePath: '/oauth/authorize',
      redirectPort: 0, // ephemeral: the test reads the real port from the URL
      redirectPath: '/auth/callback',
      scope: 'openid profile email offline_access',
    },
    tokenPath: '/oauth/token',
    verifyUrl: `${url}/v1/models`,
    importPaths: [],
  };
  state.close = () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return state;
}

/** Reads the loopback redirect_uri out of an authorize URL (port + path). */
export function redirectUriFromAuthorizeUrl(authorizeUrl: string): string {
  const redirect = new URL(authorizeUrl).searchParams.get('redirect_uri');
  if (redirect === null) throw new Error('authorize URL has no redirect_uri');
  return redirect;
}
