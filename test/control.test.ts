// Control API (DESIGN-OAUTH-PKCE-TUI §2.2): state, profile switch, OAuth
// login jobs, logout, and the localToken guard. Against a real app on an
// ephemeral port with a sandboxed LUPIN_DIR, the same pattern the other
// ingress tests use.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import { loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
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

function appWithControl() {
  return createApp(baseConfig(), { control: { openBrowser: () => undefined } });
}

const auth = { authorization: `Bearer ${TOKEN}` };

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
  it('runs a PKCE login as a job, stores the tokens, reports done', async () => {
    fake = await startFakePkce();
    // Point the openai descriptor at the fake auth server.
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real === undefined) throw new Error('openai descriptor missing');
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      const app = appWithControl();
      // Drive the loopback redirect by hand once the job publishes its URL.
      const start = await app.request('/v1/lupin/login', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      });
      expect(start.status).toBe(200);
      const { job } = (await start.json()) as { job: string };

      // Wait for the job to publish the authorize URL, then drive the redirect.
      let url: string | undefined;
      for (let i = 0; i < 50; i++) {
        const poll = await app.request(`/v1/lupin/login/${job}`, { headers: auth });
        const b = (await poll.json()) as { status: string; message?: string };
        if (b.message !== undefined) {
          url = b.message;
          break;
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(url).toBeDefined();
      const u = new URL(url ?? '');
      const redirect = new URL(u.searchParams.get('redirect_uri') ?? '');
      redirect.searchParams.set('code', fake.expectedCode);
      redirect.searchParams.set('state', u.searchParams.get('state') ?? '');
      await fetch(redirect);

      // Poll to done.
      let status = 'pending';
      for (let i = 0; i < 100; i++) {
        const poll = await app.request(`/v1/lupin/login/${job}`, { headers: auth });
        status = ((await poll.json()) as { status: string }).status;
        if (status !== 'pending') break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(status).toBe('done');

      const { getOAuthTokens } = await import('../src/config/credentials.js');
      expect(getOAuthTokens('openai')?.accessToken).toBe('pkce-access-token');
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
