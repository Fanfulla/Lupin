import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LupinConfig } from '../src/config/config.js';
import { setOAuthTokens, type OAuthTokens } from '../src/config/credentials.js';
import { createApp } from '../src/server/ingress.js';
import { startFakeOAuth, type FakeOAuth } from './helpers/fake-oauth.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';

// Integration (DESIGN-OAUTH §7): full server, oauth profile, fake provider +
// fake OAuth server. The translation core never knows where tokens come from.

const LOCAL_TOKEN = 'local-secret';
const dir = mkdtempSync(join(tmpdir(), 'lupin-oauth-int-'));
let storeN = 0;
let fake: FakeProvider;
let oauth: FakeOAuth;
const noopLogger = (): void => undefined;

function freshStore(): void {
  storeN++;
  process.env.LUPIN_CREDENTIALS = join(dir, `store-${String(storeN)}.json`);
}

function oauthConfig(providerBaseUrl: string): LupinConfig {
  return {
    activeProfile: 'kimi-sub',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      'kimi-sub': {
        provider: 'kimicode',
        mode: 'passthrough',
        baseUrl: providerBaseUrl,
        auth: { type: 'oauth' },
        slots: { opus: 'k3', sonnet: 'k3', haiku: 'kimi-for-coding' },
      },
    },
  };
}

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    expiresAt: Date.now() + 3_600_000,
    lifetimeMs: 3_600_000,
    tokenType: 'Bearer',
    ...overrides,
  };
}

async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  fake = await startFakeProvider();
  oauth = await startFakeOAuth();
});

afterAll(async () => {
  await fake.close();
  await oauth.close();
  delete process.env.LUPIN_CREDENTIALS;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  freshStore();
  fake.requests.length = 0;
  fake.respondWith({ kind: 'json', body: { ok: true } });
  oauth.refreshBehavior = { kind: 'rotate' };
  oauth.refreshCount = 0;
});

function app(): ReturnType<typeof createApp> {
  return createApp(oauthConfig(fake.url), { logger: noopLogger, oauthDefs: { kimicode: oauth.def } });
}

describe('oauth profiles end-to-end (DESIGN-OAUTH §7)', () => {
  it('fresh token → provider sees Authorization: Bearer, no refresh', async () => {
    setOAuthTokens('kimicode', tokens());
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(200);
    expect(fake.requests[0]?.headers['authorization']).toBe('Bearer access-old');
    expect(oauth.refreshCount).toBe(0);
  });

  it('near-expiry token → proactive refresh BEFORE the provider call', async () => {
    setOAuthTokens('kimicode', tokens({ expiresAt: Date.now() + 60_000 }));
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(200);
    expect(oauth.refreshCount).toBe(1);
    expect(fake.requests[0]?.headers['authorization']).toMatch(/^Bearer access-\d+$/);
  });

  it('provider 401 → ONE refresh + retry, then success', async () => {
    setOAuthTokens('kimicode', tokens());
    fake.respondOnce({ kind: 'error', status: 401, body: '{"error":{"message":"expired"}}' });
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(200);
    expect(oauth.refreshCount).toBe(1);
    expect(fake.requests.length).toBe(2);
    expect(fake.requests[1]?.headers['authorization']).toMatch(/^Bearer access-\d+$/);
  });

  it('provider 401 twice → surfaces 401, no retry loop', async () => {
    setOAuthTokens('kimicode', tokens());
    fake.respondWith({ kind: 'error', status: 401, body: '{"error":{"message":"still expired"}}' });
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(401);
    expect(fake.requests.length).toBe(2); // exactly one retry, never a loop
  });

  it('refresh rejected (invalid_grant) → 401 authentication_error telling to re-login', async () => {
    oauth.refreshBehavior = { kind: 'invalid_grant' };
    setOAuthTokens('kimicode', tokens({ expiresAt: Date.now() + 60_000 }));
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('lupin login');
    expect(fake.requests.length).toBe(0); // provider never called with a dead credential
  });

  it('not logged in → 401 with the login hint, provider untouched', async () => {
    const res = await post(app(), { model: 'claude-sonnet-9', max_tokens: 5, messages: [] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('lupin login');
    expect(fake.requests.length).toBe(0);
  });
});
