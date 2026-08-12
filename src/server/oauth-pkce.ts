// OAuth Authorization Code + PKCE login (DESIGN-OAUTH-PKCE-TUI §1.2): the flow
// kind for OpenAI and Google, alongside the Kimi device flow. PKCE generation
// uses node:crypto only; the loopback listener is a short-lived 127.0.0.1
// server that exists for the duration of the login and is then closed. No new
// long-lived route: the daemon's HTTP surface stays unchanged. Converges on the
// same OAuthTokens record and the same refresh runtime as the device flow.

import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { OAuthTokens } from '../config/credentials.js';
import type { OAuthProviderDef } from '../providers/oauth.js';
import { tokenUrl } from '../providers/oauth.js';
import { OAuthError, postOAuthForm, tokensFromResponse } from './oauth.js';

export interface PkcePair {
  verifier: string;
  challenge: string;
  state: string;
}

/** base64url without padding (RFC 7636): no Buffer.toString('base64url') before Node 15. */
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generatePkce(): PkcePair {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, state: b64url(randomBytes(16)) };
}

export interface PkceLoginHooks {
  /** Opens the browser best-effort; the printed URL is the real path. */
  openBrowser: (url: string) => void;
  /** Receives the authorize URL so the caller can print it. */
  onUrl?: (url: string) => void;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Injected for tests: bound port override (0 = ephemeral). */
  port?: number;
}

/** The full authorize URL the user must visit. */
export function authorizeUrl(def: OAuthProviderDef, pkce: PkcePair, redirectUri: string): string {
  if (def.flow.kind !== 'pkce') throw new OAuthError('bad_flow', `provider "${def.id}" is not a pkce-flow provider`);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: def.clientId,
    redirect_uri: redirectUri,
    scope: def.flow.scope,
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
  });
  return `${def.host}${def.flow.authorizePath}?${q.toString()}`;
}

/**
 * Runs the PKCE login: start a loopback listener, print/open the authorize
 * URL, wait for the provider redirect, validate state, exchange the code.
 * The listener is ALWAYS closed, on success and on failure.
 */
export async function runPkceLogin(def: OAuthProviderDef, hooks: PkceLoginHooks): Promise<OAuthTokens> {
  if (def.flow.kind !== 'pkce') throw new OAuthError('bad_flow', `provider "${def.id}" is not a pkce-flow provider`);
  if (def.clientId === '') {
    throw new OAuthError(
      'no_client_id',
      `no public OAuth client_id captured for "${def.id}" yet (see DESIGN-OAUTH-PKCE-TUI §1.1): use an API key from the hub (run: lupin)`,
    );
  }
  const pkce = generatePkce();
  const cb = await waitForCallback(def, pkce, hooks);
  try {
    // Google's installed-app flow demands the public client_secret even with
    // PKCE; a bare public client (OpenAI) has none and the field is omitted.
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: def.clientId,
      code: cb.code,
      redirect_uri: cb.redirectUri,
      code_verifier: pkce.verifier,
    };
    if (def.clientSecret !== undefined) form['client_secret'] = def.clientSecret;
    const r = await postOAuthForm(tokenUrl(def), form, hooks.fetchImpl ?? fetch);
    return tokensFromResponse(r);
  } finally {
    await cb.close();
  }
}

interface CallbackResult {
  code: string;
  /** The redirect_uri actually bound, echoed back to the provider on exchange. */
  redirectUri: string;
  close: () => Promise<void>;
}

/**
 * The loopback half of the flow. Opens the browser with the authorize URL,
 * then resolves with the authorization code once the provider redirects to
 * 127.0.0.1. Rejects on state mismatch, on a provider error, on timeout.
 */
async function waitForCallback(def: OAuthProviderDef, pkce: PkcePair, hooks: PkceLoginHooks): Promise<CallbackResult> {
  if (def.flow.kind !== 'pkce') throw new OAuthError('bad_flow', `provider "${def.id}" is not a pkce-flow provider`);
  const redirectPath = def.flow.redirectPath;
  const expectedState = pkce.state;
  const requestedPort = hooks.port ?? def.flow.redirectPort;

  const server: Server = createServer();
  const closeServer = (): Promise<void> =>
    new Promise<void>((res2) => {
      // close() waits for keep-alive connections to drain; the provider's own
      // redirect can hold one open and hang the login. Force them shut.
      server.closeAllConnections?.();
      server.close(() => res2());
    });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', () => resolve());
  });
  // The redirect_uri must carry the port actually bound: an ephemeral request
  // (port 0) resolves to a real one only after listen(). The host is the one
  // the provider registered: Google wants the literal 127.0.0.1, OpenAI
  // localhost (a mismatch makes the token endpoint answer 400).
  const bound = server.address() as AddressInfo;
  const redirectHost = def.flow.redirectHost ?? '127.0.0.1';
  const redirectUri = `http://${redirectHost}:${String(bound.port)}${redirectPath}`;

  const result = new Promise<CallbackResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new OAuthError('timeout', 'no OAuth callback received within 10 minutes'));
    }, 600_000);

    const finish = (fn: () => void): void => {
      clearTimeout(timeout);
      fn();
    };

    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== redirectPath) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      const err = url.searchParams.get('error');
      if (err !== null) {
        res.writeHead(200, { 'content-type': 'text/html' }).end('<p>Login failed. You can close this tab.</p>');
        finish(() => reject(new OAuthError(err, url.searchParams.get('error_description') ?? `provider error: ${err}`)));
        return;
      }
      if (url.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('state mismatch');
        finish(() => reject(new OAuthError('state_mismatch', 'OAuth state mismatch: possible CSRF, login aborted')));
        return;
      }
      const code = url.searchParams.get('code');
      if (code === null || code === '') {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('missing code');
        finish(() => reject(new OAuthError('bad_response', 'OAuth callback without a code')));
        return;
      }
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<p>Login complete. You can close this tab and return to the terminal.</p>');
      finish(() => resolve({ code, redirectUri, close: closeServer }));
    });
    server.on('error', (e) => finish(() => reject(new OAuthError('listen_failed', `loopback listener failed: ${e.message}`))));
  });

  // The listener is ALWAYS closed, on success and on failure: a login that
  // aborts (state mismatch, provider error, timeout) must not leave a port
  // bound behind it. On success runPkceLogin closes after the exchange; on
  // failure this finally closes it here.
  const url = authorizeUrl(def, pkce, redirectUri);
  hooks.onUrl?.(url);
  hooks.openBrowser(url);
  try {
    return await result;
  } catch (e) {
    await closeServer();
    throw e;
  }
}
