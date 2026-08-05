import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DeviceOAuthProviderDef } from '../../src/providers/oauth.js';

// Fake OAuth server (DESIGN-OAUTH §7): device_authorization, token endpoint
// with pending/success sequences, refresh with rotation or invalid_grant, and
// a /v1/models verify endpoint. Sibling of fake-provider.ts.

export interface OAuthRequestRecord {
  path: string;
  form: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
}

export interface FakeOAuth {
  url: string;
  def: DeviceOAuthProviderDef;
  requests: OAuthRequestRecord[];
  /** Queue of responses for device_code grant polls (shifted per call). */
  deviceQueue: Record<string, unknown>[];
  refreshBehavior: { kind: 'rotate' } | { kind: 'invalid_grant' } | { kind: 'fixed'; accessToken: string };
  refreshCount: number;
  close(): Promise<void>;
}

let counter = 0;

export async function startFakeOAuth(): Promise<FakeOAuth> {
  const state: Omit<FakeOAuth, 'url' | 'def' | 'close'> = {
    requests: [],
    deviceQueue: [],
    refreshBehavior: { kind: 'rotate' },
    refreshCount: 0,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')));
      state.requests.push({ path, form, headers: req.headers });

      const json = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };

      // GitHub's OAuth endpoints answer form-urlencoded unless the caller asks
      // for JSON (verified live 2026-08-05: the first real Copilot login died on
      // it). The fake mirrors that, so every OAuth POST is pinned to ask.
      const oauthPost = path === '/api/oauth/device_authorization' || path === '/api/oauth/token';
      if (oauthPost && req.headers.accept !== 'application/json') {
        res.writeHead(200, { 'content-type': 'application/x-www-form-urlencoded' });
        res.end('error=lupin_never_asked_for_json');
        return;
      }

      if (path === '/api/oauth/device_authorization') {
        json(200, {
          device_code: 'dev-code-1',
          user_code: 'ABCD-1234',
          verification_uri: 'https://fake.example/activate',
          verification_uri_complete: 'https://fake.example/activate?code=ABCD-1234',
          expires_in: 60,
          interval: 0, // tests poll instantly
        });
        return;
      }
      if (path === '/api/oauth/token') {
        if (form['grant_type'] === 'refresh_token') {
          state.refreshCount++;
          const b = state.refreshBehavior;
          if (b.kind === 'invalid_grant') {
            json(400, { error: 'invalid_grant', error_description: 'refresh token revoked' });
          } else if (b.kind === 'fixed') {
            json(200, { access_token: b.accessToken, expires_in: 3600, token_type: 'Bearer' });
          } else {
            counter++;
            json(200, {
              access_token: `access-${String(counter)}`,
              refresh_token: `refresh-${String(counter)}`,
              expires_in: 3600,
              scope: 'kimi-code',
              token_type: 'Bearer',
            });
          }
          return;
        }
        // device_code grant
        const next = state.deviceQueue.shift() ?? {
          access_token: 'access-device',
          refresh_token: 'refresh-device',
          expires_in: 3600,
          scope: 'kimi-code',
          token_type: 'Bearer',
        };
        json('error' in next ? 400 : 200, next);
        return;
      }
      if (path === '/v1/models') {
        const auth = req.headers.authorization ?? '';
        if (auth.startsWith('Bearer ')) json(200, { data: [] });
        else json(401, { error: 'unauthorized' });
        return;
      }
      json(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}`;

  const def: DeviceOAuthProviderDef = {
    id: 'kimicode',
    aliases: ['kimi'],
    host: url,
    clientId: 'test-client',
    flow: {
      kind: 'device',
      deviceAuthorizationPath: '/api/oauth/device_authorization',
      pollIntervalMs: 1,
      deviceIdentityHeaders: true,
    },
    tokenPath: '/api/oauth/token',
    verifyUrl: `${url}/v1/models`,
    importPaths: [],
  };

  // Object.assign keeps `state`'s identity: the server closure and the test
  // handle mutate/read the SAME fields (refreshBehavior, refreshCount, queues).
  return Object.assign(state, {
    url,
    def,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  });
}
