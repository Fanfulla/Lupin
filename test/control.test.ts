// Control API (DESIGN-OAUTH-PKCE-TUI §2.2): state, profile switch, OAuth
// login jobs, logout, and the localToken guard. Against a real app on an
// ephemeral port with a sandboxed LUPIN_DIR, the same pattern the other
// ingress tests use.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import { defaultConfigPath, loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import { getCredential, getOAuthTokens } from '../src/config/credentials.js';
import type { ControlDeps } from '../src/server/control.js';
import { startFakePkce, type FakePkce } from './helpers/fake-pkce.js';

let dir: string;
let prevDir: string | undefined;
let fake: FakePkce | undefined;

const TOKEN = 'test-local-token';

function baseConfig(): LupinConfig {
  return {
    activeProfile: 'a',
    port: 0,
    localToken: TOKEN,
    profiles: {
      a: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'X' },
        slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
      },
      b: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'X' },
        slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
      },
    },
  };
}

beforeEach(() => {
  prevDir = process.env.LUPIN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'lupin-control-'));
  process.env.LUPIN_DIR = dir;
  saveConfig(baseConfig());
});

afterEach(async () => {
  await fake?.close();
  fake = undefined;
  if (prevDir === undefined) delete process.env.LUPIN_DIR;
  else process.env.LUPIN_DIR = prevDir;
  rmSync(dir, { recursive: true, force: true });
});

function appWithControl(control: Partial<ControlDeps> = {}, config: LupinConfig = baseConfig()) {
  return createApp(config, { control: { openBrowser: () => undefined, ...control } });
}

const auth = { authorization: `Bearer ${TOKEN}` };
const jsonAuth = { ...auth, 'content-type': 'application/json' };

function setupKey(app: ReturnType<typeof appWithControl>, providerId: string, key: string) {
  return app.request('/v1/lupin/setup-key', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ providerId, key }),
  });
}

async function completePkceLogin(app: ReturnType<typeof appWithControl>): Promise<string> {
  if (fake === undefined) throw new Error('PKCE fake not started');
  const start = await app.request('/v1/lupin/login', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ provider: 'openai' }),
  });
  if (start.status !== 200) throw new Error(`login start answered ${String(start.status)}`);
  const { job } = (await start.json()) as { job: string };

  let url: string | undefined;
  for (let i = 0; i < 50; i++) {
    const poll = await app.request(`/v1/lupin/login/${job}`, { headers: auth });
    const body = (await poll.json()) as { status: string; message?: string };
    if (body.message !== undefined) {
      url = body.message;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (url === undefined) throw new Error('login job did not publish an authorize URL');
  const authorize = new URL(url);
  const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  redirect.searchParams.set('code', fake.expectedCode);
  redirect.searchParams.set('state', authorize.searchParams.get('state') ?? '');
  await fetch(redirect);

  let status = 'pending';
  for (let i = 0; i < 100; i++) {
    const poll = await app.request(`/v1/lupin/login/${job}`, { headers: auth });
    status = ((await poll.json()) as { status: string }).status;
    if (status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return status;
}

describe('control API guard', () => {
  it('rejects every control route without the local token', async () => {
    const app = appWithControl();
    for (const path of ['/v1/lupin/state']) {
      const res = await app.request(path, { method: 'GET' });
      expect(res.status).toBe(401);
    }
    const use = await app.request('/v1/lupin/use', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'b' }),
    });
    expect(use.status).toBe(401);
  });
});

describe('GET /v1/lupin/state', () => {
  it('returns the on-disk config', async () => {
    const res = await appWithControl().request('/v1/lupin/state', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; config: LupinConfig };
    expect(body.ok).toBe(true);
    expect(body.config.activeProfile).toBe('a');
    expect(Object.keys(body.config.profiles)).toEqual(['a', 'b']);
  });
});

describe('GET /v1/lupin/providers', () => {
  it('lists non-local defaults with auth kind derived from the descriptor', async () => {
    const res = await appWithControl().request('/v1/lupin/providers', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { providers: { id: string; authKind: string }[] };
    expect(body.providers.some((p) => p.id === 'ollama')).toBe(false);
    expect(body.providers.find((p) => p.id === 'openai-sub')?.authKind).toBe('oauth');
    expect(body.providers.find((p) => p.id === 'gpt')?.authKind).toBe('key');
  });
});

describe('POST /v1/lupin/setup-key', () => {
  it('does not save a key or profile when key verification fails', async () => {
    const before = structuredClone(loadConfig().profiles);
    const app = appWithControl({ testProviderKey: async () => ({ ok: false, detail: 'rejected by provider' }) });
    const res = await setupKey(app, 'gpt', 'bad');
    expect(res.status).toBe(400);
    expect(getCredential('OPENAI_API_KEY')).toBeUndefined();
    expect(loadConfig().profiles).toEqual(before);
  });

  it('saves the verified key and activates the matching default profile', async () => {
    const app = appWithControl({ testProviderKey: async () => ({ ok: true, detail: 'connected' }) });
    const res = await setupKey(app, 'gpt', 'verified-key');
    expect(res.status).toBe(200);
    expect(getCredential('OPENAI_API_KEY')).toBe('verified-key');
    expect(loadConfig().activeProfile).toBe('gpt');
    expect(loadConfig().profiles['gpt']?.provider).toBe('openai');
  });

  it('returns 404 for an unknown provider id without changing config', async () => {
    const before = loadConfig();
    const res = await setupKey(appWithControl(), 'missing', 'key');
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('unknown provider');
    expect(loadConfig()).toEqual(before);
  });

  it.each(['ollama', 'openai-sub'])('rejects the non-key profile %s', async (providerId) => {
    const before = loadConfig();
    const res = await setupKey(appWithControl(), providerId, 'key');
    expect(res.status).toBe(400);
    expect(loadConfig()).toEqual(before);
  });

  it('preserves the running daemon identity when setup bootstraps a missing config', async () => {
    const bootstrap: LupinConfig = { activeProfile: '', port: 7788, localToken: TOKEN, profiles: {} };
    const app = appWithControl({ testProviderKey: async () => ({ ok: true, detail: 'connected' }) }, bootstrap);
    rmSync(defaultConfigPath());

    const res = await setupKey(app, 'gpt', 'verified-key');
    const persisted = loadConfig();
    expect(res.status).toBe(200);
    expect(persisted.port).toBe(7788);
    expect(persisted.localToken).toBe(TOKEN);
    expect(persisted.activeProfile).toBe('gpt');
  });
});

describe('POST /v1/lupin/use', () => {
  it('switches the active profile on disk (the hot-reload write path)', async () => {
    const res = await appWithControl().request('/v1/lupin/use', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'b' }),
    });
    expect(res.status).toBe(200);
    expect(loadConfig().activeProfile).toBe('b');
  });

  it('404s on an unknown profile and changes nothing', async () => {
    const res = await appWithControl().request('/v1/lupin/use', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'nope' }),
    });
    expect(res.status).toBe(404);
    expect(loadConfig().activeProfile).toBe('a');
  });
});

describe('POST /v1/lupin/login', () => {
  it('verifies before saving a PKCE token and creates the subscription profile', async () => {
    fake = await startFakePkce();
    // Point the openai descriptor at the fake auth server while retaining its profile mapping.
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real === undefined) throw new Error('openai descriptor missing');
    if (real.defaultProfileId === undefined) throw new Error('openai default profile missing');
    fake.def.defaultProfileId = real.defaultProfileId;
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      let verifiedBeforeWrite = false;
      const app = appWithControl({
        verifyToken: async () => {
          verifiedBeforeWrite = getOAuthTokens('openai') === undefined;
          return { ok: true, detail: 'verified' };
        },
      });
      const status = await completePkceLogin(app);
      expect(status).toBe('done');
      expect(verifiedBeforeWrite).toBe(true);
      expect(getOAuthTokens('openai')?.accessToken).toBe('pkce-access-token');
      expect(loadConfig().profiles['openai-sub']?.provider).toBe('openaisub');
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('persists neither token nor profile when PKCE token verification fails', async () => {
    fake = await startFakePkce();
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real === undefined) throw new Error('openai descriptor missing');
    if (real.defaultProfileId === undefined) throw new Error('openai default profile missing');
    fake.def.defaultProfileId = real.defaultProfileId;
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      const app = appWithControl({ verifyToken: async () => ({ ok: false, detail: 'rejected token' }) });
      const status = await completePkceLogin(app);
      expect(status).toBe('error');
      expect(getOAuthTokens('openai')).toBeUndefined();
      expect(loadConfig().profiles['openai-sub']).toBeUndefined();
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('blocks a suspension-risk provider without acceptRisk', async () => {
    const res = await appWithControl().request('/v1/lupin/login', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'gemini' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { requiresRiskAcceptance?: boolean };
    expect(body.requiresRiskAcceptance).toBe(true);
  });
});

describe('POST /v1/lupin/logout', () => {
  it('deletes stored OAuth tokens', async () => {
    const { setOAuthTokens, getOAuthTokens } = await import('../src/config/credentials.js');
    setOAuthTokens('openai', { accessToken: 'x', expiresAt: Date.now() + 1000, tokenType: 'Bearer' });
    const res = await appWithControl().request('/v1/lupin/logout', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai' }),
    });
    expect(res.status).toBe(200);
    expect(getOAuthTokens('openai')).toBeUndefined();
  });
});

describe('POST /v1/lupin/switch-order (ADR-34)', () => {
  function saveThree(mutate?: (c: LupinConfig) => void): void {
    const c = baseConfig();
    c.profiles['c'] = { ...c.profiles['a']!, slots: { ...c.profiles['a']!.slots } };
    mutate?.(c);
    saveConfig(c);
  }

  const post = (app: ReturnType<typeof appWithControl>, body: unknown) =>
    app.request('/v1/lupin/switch-order', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('sets the chain and clears the last link', async () => {
    // c starts with a stale failover: a reorder must not leave a stale tail.
    saveThree((c) => {
      c.profiles['c']!.failover = 'a';
    });
    const res = await post(appWithControl(), { order: ['a', 'b', 'c'] });
    expect(res.status).toBe(200);
    const after = loadConfig();
    expect(after.profiles['a']?.failover).toBe('b');
    expect(after.profiles['b']?.failover).toBe('c');
    expect(after.profiles['c']?.failover).toBeUndefined();
  });

  it('a profile outside the order keeps its own failover', async () => {
    saveThree((c) => {
      c.profiles['c']!.failover = 'a';
    });
    const res = await post(appWithControl(), { order: ['a', 'b'] });
    expect(res.status).toBe(200);
    const after = loadConfig();
    expect(after.profiles['a']?.failover).toBe('b');
    expect(after.profiles['c']?.failover).toBe('a');
  });

  it('rejects a duplicate, a single name, an unknown profile and a bad body', async () => {
    saveThree();
    const app = appWithControl();
    expect((await post(app, { order: ['a', 'a'] })).status).toBe(400);
    expect((await post(app, { order: ['a'] })).status).toBe(400);
    expect((await post(app, { order: ['a', 'nope'] })).status).toBe(404);
    expect((await post(app, { order: 'a,b' })).status).toBe(400);
    // nothing was written by any of the refusals
    expect(loadConfig().profiles['a']?.failover).toBeUndefined();
  });

  it('is behind the local token like every control route', async () => {
    const res = await appWithControl().request('/v1/lupin/switch-order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ order: ['a', 'b'] }),
    });
    expect(res.status).toBe(401);
  });
});
