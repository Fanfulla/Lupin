import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getOAuthTokens,
  loadCredentials,
  oauthNeedsRefresh,
  setOAuthTokens,
  type OAuthTokens,
} from '../src/config/credentials.js';
import { validateConfig } from '../src/config/config.js';
import {
  pollDeviceToken,
  resolveOAuthAccessToken,
  startDeviceAuthorization,
  OAuthError,
} from '../src/server/oauth.js';
import type { DeviceOAuthProviderDef } from '../src/providers/oauth.js';
import { startFakeOAuth, type FakeOAuth } from './helpers/fake-oauth.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-oauth-'));
let storeN = 0;
let fake: FakeOAuth;

function freshStore(): string {
  storeN++;
  const p = join(dir, `store-${String(storeN)}.json`);
  process.env.LUPIN_CREDENTIALS = p;
  return p;
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

beforeAll(async () => {
  fake = await startFakeOAuth();
});

afterAll(async () => {
  await fake.close();
  delete process.env.LUPIN_CREDENTIALS;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  freshStore();
  fake.requests.length = 0;
  fake.deviceQueue.length = 0;
  fake.refreshBehavior = { kind: 'rotate' };
  fake.refreshCount = 0;
});

afterEach(() => {
  delete process.env.LUPIN_CREDENTIALS;
});

describe('device flow (RFC 8628, DESIGN-OAUTH §4)', () => {
  it('start → pending → granted', async () => {
    fake.deviceQueue.push({ error: 'authorization_pending' }, { error: 'authorization_pending' });
    const auth = await startDeviceAuthorization(fake.def);
    expect(auth.userCode).toBe('ABCD-1234');
    expect(auth.verificationUriComplete).toContain('code=ABCD-1234');

    let pendings = 0;
    const granted = await pollDeviceToken(fake.def, auth, {
      sleep: () => Promise.resolve(),
      onPending: () => pendings++,
    });
    expect(pendings).toBe(2);
    expect(granted.accessToken).toBe('access-device');
    expect(granted.refreshToken).toBe('refresh-device');
    expect(granted.expiresAt).toBeGreaterThan(Date.now());
  });

  it('slow_down increases the polling interval (RFC 8628 §3.5)', async () => {
    fake.deviceQueue.push({ error: 'slow_down' });
    const auth = await startDeviceAuthorization(fake.def);
    const sleeps: number[] = [];
    await pollDeviceToken(fake.def, auth, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const first = sleeps[0] ?? 0;
    const second = sleeps[1] ?? 0;
    expect(second).toBe(first + 5000);
  });

  it('transient network error while polling → keeps polling until granted', async () => {
    fake.deviceQueue.push({ error: 'authorization_pending' });
    const auth = await startDeviceAuthorization(fake.def);
    let calls = 0;
    const flaky: typeof fetch = (input, init) => {
      calls++;
      if (calls === 1) return Promise.reject(new TypeError('fetch failed'));
      return fetch(input, init);
    };
    const granted = await pollDeviceToken(fake.def, auth, {
      sleep: () => Promise.resolve(),
      fetchImpl: flaky,
    });
    expect(granted.accessToken).toBe('access-device');
    expect(calls).toBe(3); // network blip, pending, granted
  });

  it('network errors past the device-code deadline → expired_token', async () => {
    const auth = await startDeviceAuthorization(fake.def);
    auth.expiresInSec = -1; // deadline already passed at the first check
    const dead: typeof fetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(
      pollDeviceToken(fake.def, auth, { sleep: () => Promise.resolve(), fetchImpl: dead }),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('access_denied and expired_token abort with a clear code', async () => {
    fake.deviceQueue.push({ error: 'access_denied' });
    const auth = await startDeviceAuthorization(fake.def);
    await expect(pollDeviceToken(fake.def, auth, { sleep: () => Promise.resolve() })).rejects.toMatchObject({
      code: 'access_denied',
    });
  });
});

describe('token resolution and refresh (DESIGN-OAUTH §4.3)', () => {
  it('fresh token → returned as-is, no refresh call', async () => {
    setOAuthTokens(fake.def.id, tokens());
    const access = await resolveOAuthAccessToken(fake.def);
    expect(access).toBe('access-old');
    expect(fake.refreshCount).toBe(0);
  });

  it('near-expiry token → proactive refresh, rotated refresh token saved', async () => {
    setOAuthTokens(fake.def.id, tokens({ expiresAt: Date.now() + 60_000 }));
    const access = await resolveOAuthAccessToken(fake.def);
    expect(access).toMatch(/^access-\d+$/);
    expect(fake.refreshCount).toBe(1);
    const saved = getOAuthTokens(fake.def.id);
    expect(saved?.refreshToken).toMatch(/^refresh-\d+$/); // rotation persisted (§4.1)
  });

  it('single-flight: concurrent resolves share ONE refresh', async () => {
    setOAuthTokens(fake.def.id, tokens({ expiresAt: Date.now() + 60_000 }));
    const [a, b, c] = await Promise.all([
      resolveOAuthAccessToken(fake.def),
      resolveOAuthAccessToken(fake.def),
      resolveOAuthAccessToken(fake.def),
    ]);
    expect(fake.refreshCount).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('invalid_grant → tombstone + "lupin login" in the message', async () => {
    fake.refreshBehavior = { kind: 'invalid_grant' };
    setOAuthTokens(fake.def.id, tokens({ expiresAt: Date.now() + 60_000 }));
    await expect(resolveOAuthAccessToken(fake.def)).rejects.toThrow(/lupin login/);
    expect(getOAuthTokens(fake.def.id)).toBeUndefined(); // never reuse rejected refresh tokens
  });

  it('no stored credentials → clear not_logged_in error', async () => {
    await expect(resolveOAuthAccessToken(fake.def)).rejects.toMatchObject({ code: 'not_logged_in' });
  });
});

describe('store and expiry rules', () => {
  it('oauth tokens round-trip without touching plain keys', () => {
    const path = process.env.LUPIN_CREDENTIALS ?? '';
    setOAuthTokens('kimicode', tokens(), path);
    expect(getOAuthTokens('kimicode', path)?.accessToken).toBe('access-old');
    expect(loadCredentials(path)).toEqual({}); // objects are not API keys
  });

  it('oauthNeedsRefresh: half-life rule with 5-minute floor', () => {
    const now = 1_000_000_000_000;
    const fresh = tokens({ expiresAt: now + 3_000_000, lifetimeMs: 3_600_000 });
    expect(oauthNeedsRefresh(fresh, now)).toBe(false); // 50 min left of 60
    const pastHalf = tokens({ expiresAt: now + 1_500_000, lifetimeMs: 3_600_000 });
    expect(oauthNeedsRefresh(pastHalf, now)).toBe(true); // 25 min left < half-life 30
    const shortLived = tokens({ expiresAt: now + 240_000, lifetimeMs: 300_000 });
    expect(oauthNeedsRefresh(shortLived, now)).toBe(true); // 4 min left < 5-min floor
  });

  it('validateConfig accepts oauth auth and rejects unknown types', () => {
    const base = {
      activeProfile: 'kimi-sub',
      port: 3456,
      localToken: 't',
      profiles: {
        'kimi-sub': {
          provider: 'kimicode',
          mode: 'passthrough',
          auth: { type: 'oauth' },
          slots: { opus: 'k3', sonnet: 'k3', haiku: 'kimi-for-coding' },
        },
      },
    };
    expect(() => validateConfig(base)).not.toThrow();
    const bad = structuredClone(base) as Record<string, unknown>;
    (bad['profiles'] as Record<string, Record<string, unknown>>)['kimi-sub']!['auth'] = { type: 'magic' };
    expect(() => validateConfig(bad)).toThrow(/auth.type/);
  });
});

describe('OAuthError', () => {
  it('carries the RFC error code', () => {
    const e = new OAuthError('slow_down', 'x');
    expect(e.code).toBe('slow_down');
    expect(e.name).toBe('OAuthError');
  });
});

describe('device identity headers (DESIGN-OAUTH §6)', () => {
  it('device_authorization carries X-Msh-* with the Lupin-porting-CC name', async () => {
    process.env.LUPIN_DEVICE_ID = join(dir, 'test_device_id');
    await startDeviceAuthorization(fake.def);
    const req = fake.requests.find((r) => r.path === '/api/oauth/device_authorization');
    expect(req).toBeDefined();
    const h = req!.headers;
    expect(h['x-msh-device-name']).toContain('Lupin-porting-CC');
    expect(h['x-msh-platform']).toBe('lupin');
    expect(h['x-msh-device-id']).toMatch(/^[0-9a-f]{32}$/);
    expect(h['x-msh-version']).toBeTruthy();
    expect(h['x-msh-device-model']).toBeTruthy();
    expect(h['x-msh-os-version'] !== undefined).toBe(true);
    delete process.env.LUPIN_DEVICE_ID;
  });

  it('token poll and refresh carry the same device headers', async () => {
    process.env.LUPIN_DEVICE_ID = join(dir, 'test_device_id2');
    const auth = await startDeviceAuthorization(fake.def);
    await pollDeviceToken(fake.def, auth, { sleep: () => Promise.resolve() });
    const poll = fake.requests.find((r) => r.path === '/api/oauth/token');
    expect(poll?.headers['x-msh-device-name']).toContain('Lupin-porting-CC');
    delete process.env.LUPIN_DEVICE_ID;
  });

  // Both found by the first REAL Copilot login (2026-08-05). Until then Kimi was
  // the only device provider, so "the device flow" and "Kimi" were the same
  // thing and neither call site had a reason to distinguish them.
  it('the Kimi X-Msh-* headers stop at the descriptor that asks for them', async () => {
    const other: DeviceOAuthProviderDef = {
      ...fake.def,
      id: 'copilot',
      flow: { ...fake.def.flow, deviceIdentityHeaders: undefined },
    };
    const auth = await startDeviceAuthorization(other);
    await pollDeviceToken(other, auth, { sleep: () => Promise.resolve() });
    for (const r of fake.requests) {
      expect(Object.keys(r.headers).filter((k) => k.startsWith('x-msh-'))).toEqual([]);
    }
  });

  it('every OAuth form POST asks for JSON (GitHub answers form-urlencoded otherwise)', async () => {
    const auth = await startDeviceAuthorization(fake.def);
    await pollDeviceToken(fake.def, auth, { sleep: () => Promise.resolve() });
    expect(fake.requests.length).toBeGreaterThan(1);
    for (const r of fake.requests) expect(r.headers['accept']).toBe('application/json');
  });
});
