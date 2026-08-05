// The post-login verification probe (DESIGN-OAUTH §4.2 step 3). Most providers
// verify with a GET on a models list; Google Code Assist has no such GET, its
// entry point is POST :loadCodeAssist, so the descriptor carries the body.

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyToken } from '../src/cli/login.js';
import { OAUTH_PROVIDERS, type OAuthProviderDef } from '../src/providers/oauth.js';

interface Seen {
  method: string;
  path: string;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

let server: Server | undefined;
const seen: Seen[] = [];

function listen(status: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += String(c)));
      req.on('end', () => {
        seen.push({
          method: req.method ?? '',
          path: req.url ?? '',
          auth: req.headers.authorization,
          contentType: req.headers['content-type'],
          body,
        });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(payload);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server?.address();
      resolve(`http://127.0.0.1:${String(typeof addr === 'object' && addr ? addr.port : 0)}`);
    });
  });
}

function def(over: Partial<OAuthProviderDef>): OAuthProviderDef {
  return {
    id: 'x',
    aliases: ['x'],
    host: 'https://example.invalid',
    clientId: 'c',
    flow: { kind: 'device', deviceAuthorizationPath: '/d', pollIntervalMs: 1 },
    tokenPath: '/t',
    verifyUrl: 'https://example.invalid/models',
    importPaths: [],
    ...over,
  };
}

const tokens = { accessToken: 'tok-123', expiresAt: Date.now() + 60_000, tokenType: 'Bearer' };

afterEach(() => {
  server?.close();
  server = undefined;
  seen.length = 0;
});

describe('verifyToken', () => {
  it('no verifyBody → GET with the Bearer, 200 accepted', async () => {
    const base = await listen(200, '{"data":[]}');
    const verdict = await verifyToken(def({ verifyUrl: `${base}/v1/models` }), tokens);
    expect(verdict.ok).toBe(true);
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.auth).toBe('Bearer tok-123');
    expect(seen[0]?.body).toBe('');
  });

  it('verifyBody → POST application/json with that exact body', async () => {
    const base = await listen(200, '{"currentTier":{"id":"free-tier"}}');
    const body = { metadata: { ideType: 'IDE_UNSPECIFIED', pluginType: 'GEMINI' } };
    const verdict = await verifyToken(def({ verifyUrl: `${base}/v1internal:loadCodeAssist`, verifyBody: body }), tokens);
    expect(verdict.ok).toBe(true);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.contentType).toBe('application/json');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(body);
    expect(verdict.detail).toContain('POST');
  });

  it('non-2xx → not ok, the provider body is surfaced (truncated)', async () => {
    const base = await listen(403, '{"error":{"message":"Code Assist is not enabled"}}');
    const verdict = await verifyToken(def({ verifyUrl: `${base}/v1internal:loadCodeAssist`, verifyBody: {} }), tokens);
    expect(verdict.ok).toBe(false);
    expect(verdict.detail).toContain('403');
    expect(verdict.detail).toContain('Code Assist is not enabled');
  });

  it('a free tier account is told so at login, before its first session', async () => {
    const base = await listen(
      200,
      JSON.stringify({
        currentTier: { id: 'free-tier', upgradeSubscriptionUri: 'https://example.invalid/upgrade' },
        cloudaicompanionProject: 'proj-1',
      }),
    );
    const verdict = await verifyToken(def({ verifyUrl: `${base}/v1internal:loadCodeAssist`, verifyBody: {} }), tokens);
    expect(verdict.ok).toBe(true);
    expect(verdict.notice).toContain('FREE tier');
    expect(verdict.notice).toContain('SONNET slot');
    // The data-collection warning is not optional: it decides what a user is
    // willing to route through this provider at all.
    expect(verdict.notice).toContain('human reviewers');
    expect(verdict.notice).toContain('https://example.invalid/upgrade');
  });

  it('a paid tier gets no notice', async () => {
    const base = await listen(200, JSON.stringify({ currentTier: { id: 'standard-tier' } }));
    const verdict = await verifyToken(def({ verifyUrl: `${base}/x:loadCodeAssist`, verifyBody: {} }), tokens);
    expect(verdict.notice).toBeUndefined();
  });

  it('the Gemini descriptor probes Code Assist, not the public Gemini endpoint', () => {
    const gemini = OAUTH_PROVIDERS['gemini'];
    // The OAuth token spends on Code Assist; the public generativelanguage
    // endpoint refuses it, which is why the token was never persisted before.
    expect(gemini?.verifyUrl).toBe('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist');
    expect(gemini?.verifyBody).toBeDefined();
  });
});
