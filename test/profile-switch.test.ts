// Switching profile from INSIDE Claude Code (SPEC-PROVIDERS §4.3, ADR-37).
// The /model picker is the one client surface Lupin controls, so GET /v1/models
// publishes one inert pseudo-entry per profile and the ingress reads it as the
// gesture `lupin use <profile>`. Same harness as the other ingress tests: a
// sandboxed LUPIN_DIR and in-process app.request calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import { saveConfig, type LupinConfig } from '../src/config/config.js';
import { profileSwitchId, profileSwitchTarget } from '../src/providers/resolve.js';

let dir: string;
let prevDir: string | undefined;

const TOKEN = 'test-local-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function baseConfig(): LupinConfig {
  return {
    activeProfile: 'first',
    port: 0,
    localToken: TOKEN,
    profiles: {
      first: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'X' },
        slots: { opus: 'big-1', sonnet: 'mid-1', haiku: 'small-1' },
      },
      second: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'X' },
        slots: { opus: 'big-2', sonnet: 'mid-2', haiku: 'small-2' },
      },
    },
  };
}

beforeEach(() => {
  prevDir = process.env.LUPIN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'lupin-switch-'));
  process.env.LUPIN_DIR = dir;
  process.env['X'] = 'k';
  saveConfig(baseConfig());
});

afterEach(() => {
  if (prevDir === undefined) delete process.env.LUPIN_DIR;
  else process.env.LUPIN_DIR = prevDir;
  delete process.env['X'];
  rmSync(dir, { recursive: true, force: true });
});

describe('the pseudo-id algebra', () => {
  it('round trips a profile name', () => {
    expect(profileSwitchTarget(profileSwitchId('second'))).toBe('second');
  });

  it('an ordinary model id is not a switch', () => {
    for (const id of ['claude-fable-5', 'claude-lupin-k3', 'gpt-5.6-sol', 'switch', '']) {
      expect(profileSwitchTarget(id)).toBeUndefined();
    }
  });

  // Claude Code lets the user suffix any id with [1m]; normalizeModelId strips
  // it before every match, and a switch id must go through the same door.
  it('survives the [1m] suffix the client may append', () => {
    expect(profileSwitchTarget(`${profileSwitchId('second')}[1m]`)).toBe('second');
  });
});

describe('GET /v1/models publishes one switch row per profile', () => {
  it('every profile is listed, the active one included', async () => {
    const app = createApp(baseConfig());
    const res = await app.request('/v1/models', { headers: auth });
    const body = (await res.json()) as { data: { id: string; display_name: string }[] };
    const ids = body.data.map((m) => m.id);
    // The client fetches this list ONCE per session and caches it, so leaving
    // the active profile out would make the switch a one-way trip.
    expect(ids).toContain(profileSwitchId('first'));
    expect(ids).toContain(profileSwitchId('second'));
  });

  it('the model rows still come first: the picker is a model picker', async () => {
    const app = createApp(baseConfig());
    const res = await app.request('/v1/models', { headers: auth });
    const body = (await res.json()) as { data: { id: string }[] };
    const firstSwitch = body.data.findIndex((m) => profileSwitchTarget(m.id) !== undefined);
    const models = body.data.slice(0, firstSwitch);
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => profileSwitchTarget(m.id) === undefined)).toBe(true);
  });

  it('the row says what picking it does', async () => {
    const app = createApp(baseConfig());
    const res = await app.request('/v1/models', { headers: auth });
    const body = (await res.json()) as { data: { id: string; display_name: string }[] };
    const row = body.data.find((m) => m.id === profileSwitchId('second'));
    expect(row?.display_name).toContain('second');
    expect(row?.display_name.toLowerCase()).toContain('switch');
  });
});

describe('picking the row switches the profile and serves the request', () => {
  const okResponse = (): Response =>
    new Response(JSON.stringify({ id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('switches durably and answers through the target profile', async () => {
    const persist = vi.fn();
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(okResponse()));
    const lines: Record<string, unknown>[] = [];
    const app = createApp(baseConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistActiveProfile: persist,
      logger: (l) => lines.push(l as unknown as Record<string, unknown>),
    });

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: profileSwitchId('second'), messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(persist).toHaveBeenCalledWith('first', 'second');
    // The request itself is served, never bounced back: the user asked for a
    // model and must get an answer, not an error explaining a switch.
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(sent.model).toBe('big-2'); // the opus slot: where the client default lands
    expect(lines.at(-1)?.['profileSwitch']).toBe('second');
    expect(lines.at(-1)?.['profile']).toBe('second');
  });

  it('picking the profile that is already active changes nothing', async () => {
    const persist = vi.fn();
    const app = createApp(baseConfig(), {
      fetchImpl: (() => Promise.resolve(okResponse())) as unknown as typeof fetch,
      persistActiveProfile: persist,
    });
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: profileSwitchId('first'), messages: [] }),
    });
    expect(res.status).toBe(200);
    expect(persist).not.toHaveBeenCalled();
  });

  // The client re-sends the picked id on EVERY later turn. Acting on each one
  // would undo a `lupin use` made meanwhile from the CLI or the TUI, so the id
  // is a gesture (act on the transition), never a pin.
  it('a repeated id does not fight a switch made elsewhere', async () => {
    const persist = vi.fn();
    const app = createApp(baseConfig(), {
      fetchImpl: (() => Promise.resolve(okResponse())) as unknown as typeof fetch,
      persistActiveProfile: persist,
    });
    const send = async (): Promise<Response> =>
      await app.request('/v1/messages', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ model: profileSwitchId('second'), messages: [] }),
      });

    await send();
    expect(persist).toHaveBeenCalledTimes(1);
    await send();
    await send();
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('an unknown profile serves the session instead of breaking it', async () => {
    const persist = vi.fn();
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(okResponse()));
    const lines: Record<string, unknown>[] = [];
    const app = createApp(baseConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      persistActiveProfile: persist,
      logger: (l) => lines.push(l as unknown as Record<string, unknown>),
    });

    // A stale id: Claude Code persists the pick globally, so it can outlive
    // the profile it names (and can even arrive from a different config).
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: profileSwitchId('ghost'), messages: [] }),
    });

    expect(res.status).toBe(200);
    expect(persist).not.toHaveBeenCalled();
    expect(lines.at(-1)?.['profileSwitch']).toBe('unknown:ghost');
    expect(lines.at(-1)?.['profile']).toBe('first');
  });
});
