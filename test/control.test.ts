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

async function completePkceLogin(
  app: ReturnType<typeof appWithControl>,
  provider = 'openai',
  extra: Record<string, unknown> = {},
): Promise<{ startStatus: number; jobStatus?: string }> {
  if (fake === undefined) throw new Error('PKCE fake not started');
  const start = await app.request('/v1/lupin/login', {
    method: 'POST',
    headers: jsonAuth,
    body: JSON.stringify({ provider, ...extra }),
  });
  if (start.status !== 200) return { startStatus: start.status };
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
  return { startStatus: start.status, jobStatus: status };
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
  it('lists every default with auth kind derived from the descriptor (ADR-51: locals included)', async () => {
    const res = await appWithControl().request('/v1/lupin/providers', { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: { id: string; authKind: string; economy?: string; startHint?: string }[];
    };
    expect(body.providers.find((p) => p.id === 'ollama')?.authKind).toBe('local');
    expect(body.providers.find((p) => p.id === 'lmstudio')?.startHint).toBe('lms server start');
    expect(body.providers.find((p) => p.id === 'openai-sub')?.authKind).toBe('oauth');
    expect(body.providers.find((p) => p.id === 'gpt')?.authKind).toBe('key');
    // The economy preset is advertised where the defaults declare one, so the
    // TUI knows when to offer the choice the wizard used to make.
    expect(body.providers.find((p) => p.id === 'kimi')?.economy).toBeDefined();
    expect(body.providers.find((p) => p.id === 'gpt')?.economy).toBeUndefined();
  });

  it('marks OAuth rows importable when official CLI credentials exist', async () => {
    const tokens = { accessToken: 'imported', expiresAt: Date.now() + 60_000, tokenType: 'Bearer' };
    const res = await appWithControl({ importCredentials: () => tokens }).request('/v1/lupin/providers', { headers: auth });
    const body = (await res.json()) as { providers: { id: string; authKind: string; importAvailable?: boolean }[] };
    expect(body.providers.find((p) => p.id === 'openai-sub')?.importAvailable).toBe(true);
    expect(body.providers.filter((p) => p.authKind !== 'oauth').every((p) => p.importAvailable === undefined)).toBe(true);
  });

  it('puts suspension warnings only on their OAuth profile rows', async () => {
    const res = await appWithControl().request('/v1/lupin/providers', { headers: auth });
    const body = (await res.json()) as {
      providers: { id: string; authKind: string; suspensionWarning?: string }[];
    };
    expect(body.providers.find((p) => p.id === 'gemini-sub')?.suspensionWarning).toBeDefined();
    expect(body.providers.find((p) => p.id === 'copilot-sub')?.suspensionWarning).toBeDefined();
    expect(body.providers.filter((p) => p.authKind === 'key').every((p) => p.suspensionWarning === undefined)).toBe(true);
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

  it('writes the economy preset slots and routes on request', async () => {
    const app = appWithControl({ testProviderKey: async () => ({ ok: true, detail: 'connected' }) });
    const res = await app.request('/v1/lupin/setup-key', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'kimi', key: 'k', economy: true }),
    });
    expect(res.status).toBe(200);
    const profile = loadConfig().profiles['kimi'];
    expect(profile?.slots.sonnet).not.toBe(profile?.slots.opus);
    expect(profile?.routes?.thinking).toBeDefined();
  });

  it('sets a validated failover and refuses an unknown one', async () => {
    const app = appWithControl({ testProviderKey: async () => ({ ok: true, detail: 'connected' }) });
    const bad = await app.request('/v1/lupin/setup-key', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'gpt', key: 'k', failover: 'nope' }),
    });
    expect(bad.status).toBe(404);
    expect(loadConfig().profiles['gpt']).toBeUndefined();
    const good = await app.request('/v1/lupin/setup-key', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'gpt', key: 'k', failover: 'a' }),
    });
    expect(good.status).toBe(200);
    expect(loadConfig().profiles['gpt']?.failover).toBe('a');
  });

  it('offers save-anyway on a failed test and honours the explicit retry', async () => {
    const app = appWithControl({ testProviderKey: async () => ({ ok: false, detail: 'rejected by provider' }) });
    const refused = await setupKey(app, 'gpt', 'suspect-key');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { canSaveAnyway?: boolean }).canSaveAnyway).toBe(true);
    expect(getCredential('OPENAI_API_KEY')).toBeUndefined();
    expect(loadConfig().profiles['gpt']).toBeUndefined();

    const saved = await app.request('/v1/lupin/setup-key', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'gpt', key: 'suspect-key', saveAnyway: true }),
    });
    expect(saved.status).toBe(200);
    expect(getCredential('OPENAI_API_KEY')).toBe('suspect-key');
    expect(loadConfig().profiles['gpt']?.provider).toBe('openai');
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

// A fake LM Studio: the /v1/models id list plus the native /api/v0/models
// metadata, the two calls discovery really makes (SPEC-PROVIDERS §3ter).
const lmFetch: typeof fetch = (input) => {
  const url = String(input);
  if (url.endsWith('/v1/models')) {
    return Promise.resolve(Response.json({ data: [{ id: 'big' }, { id: 'small' }, { id: 'pixel' }] }));
  }
  if (url.endsWith('/api/v0/models')) {
    return Promise.resolve(
      Response.json({
        data: [
          { id: 'big', type: 'llm', loaded_context_length: 131072, capabilities: ['tool_use'] },
          { id: 'small', type: 'llm', loaded_context_length: 8192, capabilities: [] },
          { id: 'pixel', type: 'vlm', loaded_context_length: 131072, capabilities: ['tool_use'] },
        ],
      }),
    );
  }
  return Promise.reject(new Error(`unexpected URL ${url}`));
};

describe('local setup through the control plane (ADR-51)', () => {
  it('discovers chat models with windows, capability flags and the too-small verdict', async () => {
    const res = await appWithControl({ fetchLocal: lmFetch }).request('/v1/lupin/discover-local', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'lmstudio' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { id: string; contextWindow?: number; supportsTools?: boolean; supportsVision?: boolean; contextTooSmall: boolean }[];
    };
    const big = body.models.find((m) => m.id === 'big');
    const small = body.models.find((m) => m.id === 'small');
    const pixel = body.models.find((m) => m.id === 'pixel');
    expect(big).toMatchObject({ contextWindow: 131072, supportsTools: true, contextTooSmall: false });
    expect(small?.contextTooSmall).toBe(true);
    expect(small?.supportsTools).toBe(false);
    expect(pixel?.supportsVision).toBe(true);
  });

  it('answers 502 with the start hint when the local server is down', async () => {
    const down: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    const res = await appWithControl({ fetchLocal: down }).request('/v1/lupin/discover-local', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'lmstudio' }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; startHint?: string };
    expect(body.error).toContain('unreachable');
    expect(body.startHint).toBe('lms server start');
  });

  it('rejects a non-local provider id', async () => {
    const res = await appWithControl({ fetchLocal: lmFetch }).request('/v1/lupin/discover-local', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'gpt' }),
    });
    expect(res.status).toBe(404);
  });

  it('writes the local profile with picks, windows, opt-in routes and failover', async () => {
    const res = await appWithControl({ fetchLocal: lmFetch }).request('/v1/lupin/setup-local', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({
        providerId: 'lmstudio',
        main: 'big',
        light: 'small',
        vision: 'pixel',
        longContext: true,
        failover: 'a',
      }),
    });
    expect(res.status).toBe(200);
    const config = loadConfig();
    expect(config.activeProfile).toBe('lmstudio');
    const profile = config.profiles['lmstudio'];
    expect(profile?.slots).toEqual({ opus: 'big', sonnet: 'big', haiku: 'small' });
    expect(profile?.contextWindows).toEqual({ big: 131072, small: 8192 });
    expect(profile?.routes).toEqual({ vision: { target: 'pixel' }, longContext: { target: 'big' } });
    expect(profile?.failover).toBe('a');
  });

  it('refuses a model the server does not list, a non-vision candidate, and a groundless long-context route', async () => {
    const app = appWithControl({ fetchLocal: lmFetch });
    const post = (body: unknown) =>
      app.request('/v1/lupin/setup-local', { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) });
    expect((await post({ providerId: 'lmstudio', main: 'ghost' })).status).toBe(404);
    expect((await post({ providerId: 'lmstudio', main: 'big', vision: 'small' })).status).toBe(400);
    expect((await post({ providerId: 'lmstudio', main: 'big', longContext: true })).status).toBe(400);
    expect(loadConfig().profiles['lmstudio']).toBeUndefined();
  });

  it('bootstraps a missing config from the daemon identity, like setup-key', async () => {
    const bootstrap: LupinConfig = { activeProfile: '', port: 7788, localToken: TOKEN, profiles: {} };
    const app = appWithControl({ fetchLocal: lmFetch }, bootstrap);
    rmSync(defaultConfigPath());
    const res = await app.request('/v1/lupin/setup-local', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ providerId: 'lmstudio', main: 'big' }),
    });
    expect(res.status).toBe(200);
    const persisted = loadConfig();
    expect(persisted.port).toBe(7788);
    expect(persisted.localToken).toBe(TOKEN);
    expect(persisted.profiles['lmstudio']?.slots.haiku).toBe('big');
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
      const result = await completePkceLogin(app);
      expect(result).toEqual({ startStatus: 200, jobStatus: 'done' });
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
      const result = await completePkceLogin(app);
      expect(result).toEqual({ startStatus: 200, jobStatus: 'error' });
      expect(getOAuthTokens('openai')).toBeUndefined();
      expect(loadConfig().profiles['openai-sub']).toBeUndefined();
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('rolls back the stored token when profile creation fails after a verified login', async () => {
    fake = await startFakePkce();
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real === undefined) throw new Error('openai descriptor missing');
    // A descriptor aimed at a default profile that does not exist makes
    // ensureOAuthProfile fail AFTER the token was verified and stored: the
    // token must not outlive the failed profile creation (Task 2 review).
    fake.def.defaultProfileId = 'no-such-default-profile';
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      const app = appWithControl({ verifyToken: async () => ({ ok: true, detail: 'verified' }) });
      const result = await completePkceLogin(app);
      expect(result).toEqual({ startStatus: 200, jobStatus: 'error' });
      expect(getOAuthTokens('openai')).toBeUndefined();
      expect(loadConfig().profiles['openai-sub']).toBeUndefined();
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('starts OAuth login with the provider id advertised by the catalogue', async () => {
    fake = await startFakePkce();
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real?.defaultProfileId === undefined) throw new Error('openai default profile missing');
    fake.def.defaultProfileId = real.defaultProfileId;
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      const app = appWithControl({ verifyToken: async () => ({ ok: true, detail: 'verified' }) });
      const catalogue = await app.request('/v1/lupin/providers', { headers: auth });
      const body = (await catalogue.json()) as { providers: { id: string; authKind: string }[] };
      const advertised = body.providers.find((p) => p.id === 'openai-sub' && p.authKind === 'oauth');
      if (advertised === undefined) throw new Error('openai OAuth row missing from catalogue');

      const result = await completePkceLogin(app, advertised.id);
      expect(result).toEqual({ startStatus: 200, jobStatus: 'done' });
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('logs an account label into its own store key and derived profile (§4nonies)', async () => {
    fake = await startFakePkce();
    const { OAUTH_PROVIDERS } = await import('../src/providers/oauth.js');
    const real = OAUTH_PROVIDERS['openai'];
    if (real?.defaultProfileId === undefined) throw new Error('openai default profile missing');
    fake.def.defaultProfileId = real.defaultProfileId;
    OAUTH_PROVIDERS['openai'] = fake.def;
    try {
      const app = appWithControl({ verifyToken: async () => ({ ok: true, detail: 'verified' }) });
      const result = await completePkceLogin(app, 'openai', { account: 'work' });
      expect(result).toEqual({ startStatus: 200, jobStatus: 'done' });
      expect(getOAuthTokens('openai#work')?.accessToken).toBe('pkce-access-token');
      expect(getOAuthTokens('openai')).toBeUndefined();
      expect(loadConfig().profiles['openai-sub@work']?.auth).toMatchObject({ type: 'oauth', provider: 'openai#work' });
    } finally {
      OAUTH_PROVIDERS['openai'] = real;
    }
  });

  it('refuses an invalid account label before starting a job', async () => {
    const res = await appWithControl().request('/v1/lupin/login', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ provider: 'openai', account: 'not ok!' }),
    });
    expect(res.status).toBe(400);
  });

  it('imports official CLI credentials on request, without a browser', async () => {
    let browserOpened = false;
    const tokens = { accessToken: 'imported-token', expiresAt: Date.now() + 60_000, tokenType: 'Bearer' };
    const app = appWithControl({
      openBrowser: () => {
        browserOpened = true;
      },
      importCredentials: () => tokens,
      verifyToken: async () => ({ ok: true, detail: 'verified' }),
    });
    const start = await app.request('/v1/lupin/login', {
      method: 'POST',
      headers: jsonAuth,
      body: JSON.stringify({ provider: 'openai', importIfAvailable: true }),
    });
    expect(start.status).toBe(200);
    const { job } = (await start.json()) as { job: string };
    let status = 'pending';
    for (let i = 0; i < 100 && status === 'pending'; i++) {
      const poll = await app.request(`/v1/lupin/login/${job}`, { headers: auth });
      status = ((await poll.json()) as { status: string }).status;
      if (status === 'pending') await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(status).toBe('done');
    expect(browserOpened).toBe(false);
    expect(getOAuthTokens('openai')?.accessToken).toBe('imported-token');
    expect(loadConfig().profiles['openai-sub']?.provider).toBe('openaisub');
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

describe('POST /v1/lupin/slots', () => {
  const aim = (body: unknown) =>
    appWithControl().request('/v1/lupin/slots', { method: 'POST', headers: jsonAuth, body: JSON.stringify(body) });

  it('writes the named slots as given and leaves the others alone', async () => {
    const res = await aim({ profile: 'a', opus: 'big-model', haiku: 'small-model' });
    expect(res.status).toBe(200);
    expect(loadConfig().profiles['a']?.slots).toEqual({ opus: 'big-model', sonnet: 'm', haiku: 'small-model' });
  });

  it('refuses an unknown profile, an empty aim, and a non-string model', async () => {
    expect((await aim({ profile: 'nope', opus: 'x' })).status).toBe(404);
    expect((await aim({ profile: 'a' })).status).toBe(400);
    expect((await aim({ profile: 'a', sonnet: '' })).status).toBe(400);
    expect(loadConfig().profiles['a']?.slots).toEqual({ opus: 'm', sonnet: 'm', haiku: 'm' });
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

  it('forgets only the named account and leaves the others (§4nonies)', async () => {
    const { setOAuthTokens, getOAuthTokens } = await import('../src/config/credentials.js');
    setOAuthTokens('openai', { accessToken: 'base', expiresAt: Date.now() + 1000, tokenType: 'Bearer' });
    setOAuthTokens('openai#work', { accessToken: 'work', expiresAt: Date.now() + 1000, tokenType: 'Bearer' });
    const res = await appWithControl().request('/v1/lupin/logout', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'openai', account: 'work' }),
    });
    expect(res.status).toBe(200);
    expect(getOAuthTokens('openai#work')).toBeUndefined();
    expect(getOAuthTokens('openai')?.accessToken).toBe('base');
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
