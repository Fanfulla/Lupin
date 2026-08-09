// Agent routes (SPEC-PROVIDERS §4decies, ADR-47): the id
// `claude-lupin-agent:<name>` resolves through the global `agents` table.
// Same harness as the other ingress tests: sandboxed LUPIN_DIR, in-process
// app.request calls.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import { loadConfig, saveConfig, validateConfig, type LupinConfig } from '../src/config/config.js';
import { agentRouteId, agentRouteName, applyContentRoutes, resolveRequest } from '../src/providers/resolve.js';
import { runEnv } from '../src/cli/run.js';

let dir: string;
let prevDir: string | undefined;

const TOKEN = 'test-local-token';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

function baseConfig(): LupinConfig {
  return {
    activeProfile: 'main',
    port: 0,
    localToken: TOKEN,
    profiles: {
      main: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'X' },
        slots: { opus: 'big', sonnet: 'mid', haiku: 'small' },
        routes: { vision: { target: 'vision-model' } },
      },
      local: {
        provider: 'ollama',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'none' },
        slots: { opus: 'l-big', sonnet: 'l-mid', haiku: 'l-small' },
      },
    },
    agents: {
      explore: { profile: 'local' },
      planner: 'big',
      subagents: { profile: 'local' },
    },
  };
}

beforeEach(() => {
  prevDir = process.env.LUPIN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'lupin-agents-'));
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

describe('the agent-id algebra', () => {
  it('round trips an agent name', () => {
    expect(agentRouteName(agentRouteId('explore'))).toBe('explore');
  });

  it('an ordinary model id is not an agent route', () => {
    for (const id of ['claude-fable-5', 'claude-lupin-k3', 'claude-lupin-switch:x', 'agent', '']) {
      expect(agentRouteName(id)).toBeUndefined();
    }
  });

  // Same door as every other id: [1m] and the gateway prefix strip first.
  it('survives the [1m] suffix the client may append', () => {
    expect(agentRouteName(`${agentRouteId('explore')}[1m]`)).toBe('explore');
  });
});

describe('resolution through the agents table', () => {
  it('a string target is a model of the profile serving the request', () => {
    const r = resolveRequest(baseConfig(), agentRouteId('planner'));
    expect(r).toMatchObject({ profileName: 'main', model: 'big', slot: 'agent' });
  });

  it('a delegation lands on the target profile sonnet slot', () => {
    const r = resolveRequest(baseConfig(), agentRouteId('explore'));
    expect(r).toMatchObject({ profileName: 'local', model: 'l-mid', slot: 'agent' });
  });

  it('an unknown name serves on the normal path (sonnet slot), never an error', () => {
    const r = resolveRequest(baseConfig(), agentRouteId('ghost'));
    expect(r).toMatchObject({ profileName: 'main', model: 'mid', slot: 'sonnet' });
  });

  it('with no table at all the id still serves on the sonnet slot', () => {
    const cfg = baseConfig();
    delete cfg.agents;
    const r = resolveRequest(cfg, agentRouteId('explore'));
    expect(r).toMatchObject({ model: 'mid', slot: 'sonnet' });
  });

  // Total control: the request goes exactly where aimed, like direct use.
  it('content routes never reroute an agent-routed request', () => {
    const cfg = baseConfig();
    const resolved = resolveRequest(cfg, agentRouteId('planner'));
    const visionBody = {
      model: agentRouteId('planner'),
      messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
    };
    const out = applyContentRoutes(cfg, 'main', agentRouteId('planner'), resolved, visionBody);
    expect(out.routed).toBeUndefined();
    expect(out.resolved.model).toBe('big');
  });
});

describe('config validation (§4decies)', () => {
  it('accepts a valid table and refuses a bad name, target or profile', () => {
    expect(() => validateConfig(baseConfig())).not.toThrow();
    const badName = { ...baseConfig(), agents: { 'bad:name': 'm' } };
    expect(() => validateConfig(badName)).toThrow(/not a valid agent name/);
    const badTarget = { ...baseConfig(), agents: { a: 7 } };
    expect(() => validateConfig(badTarget)).toThrow(/target must be/);
    const ghostProfile = { ...baseConfig(), agents: { a: { profile: 'ghost' } } };
    expect(() => validateConfig(ghostProfile)).toThrow(/"ghost" is not defined/);
  });
});

describe('the ingress serves and logs agent routes', () => {
  const okResponse = (): Response =>
    new Response(JSON.stringify({ id: 'msg_1', content: [], usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('an agent id is served on the target and the log names the route', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(okResponse()));
    const lines: Record<string, unknown>[] = [];
    const app = createApp(baseConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: (l) => lines.push(l as unknown as Record<string, unknown>),
    });

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: agentRouteId('explore'), messages: [] }),
    });

    expect(res.status).toBe(200);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(sent.model).toBe('l-mid');
    expect(lines.at(-1)?.['agentRoute']).toBe('explore');
    expect(lines.at(-1)?.['profile']).toBe('local');
  });

  it('an unknown route serves the session and says so', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(okResponse()));
    const lines: Record<string, unknown>[] = [];
    const app = createApp(baseConfig(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      logger: (l) => lines.push(l as unknown as Record<string, unknown>),
    });

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: agentRouteId('ghost'), messages: [] }),
    });

    expect(res.status).toBe(200);
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { model: string };
    expect(sent.model).toBe('mid');
    expect(lines.at(-1)?.['agentRoute']).toBe('unknown:ghost');
  });

  // The ids are typed into agent definitions, not picked: an inert row with no
  // gesture behind it would be picker noise.
  it('GET /v1/models does not publish agent rows', async () => {
    const app = createApp(baseConfig());
    const res = await app.request('/v1/models', { headers: auth });
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.every((m) => agentRouteName(m.id) === undefined)).toBe(true);
  });
});

describe('POST /v1/lupin/agents (control API)', () => {
  const control = { openBrowser: () => undefined };

  it('replaces the whole table atomically', async () => {
    const app = createApp(baseConfig(), { control });
    const res = await app.request('/v1/lupin/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agents: { explore: { profile: 'local' } } }),
    });
    expect(res.status).toBe(200);
    expect(loadConfig().agents).toEqual({ explore: { profile: 'local' } });
  });

  it('an empty table removes the key: absent is the documented off state', async () => {
    const app = createApp(baseConfig(), { control });
    const res = await app.request('/v1/lupin/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agents: {} }),
    });
    expect(res.status).toBe(200);
    expect(loadConfig().agents).toBeUndefined();
  });

  it('a bad table is the caller mistake: 400, config untouched', async () => {
    const app = createApp(baseConfig(), { control });
    const res = await app.request('/v1/lupin/agents', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ agents: { explore: { profile: 'ghost' } } }),
    });
    expect(res.status).toBe(400);
    expect(loadConfig().agents).toEqual(baseConfig().agents);
  });

  it('refuses without the local token', async () => {
    const app = createApp(baseConfig(), { control });
    const res = await app.request('/v1/lupin/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agents: {} }),
    });
    expect(res.status).toBe(401);
  });
});

describe('lupin run fills CLAUDE_CODE_SUBAGENT_MODEL (§4decies)', () => {
  it('fills the var when the subagents route is declared and the var is unset', () => {
    const env = runEnv(1, 't', {}, [], { subagents: { profile: 'local' } });
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBe(agentRouteId('subagents'));
  });

  it('an explicit user value always wins, empty included', () => {
    for (const value of ['my-model', '']) {
      const env = runEnv(1, 't', { CLAUDE_CODE_SUBAGENT_MODEL: value }, [], { subagents: 'm' });
      expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBeUndefined();
    }
  });

  it('without the declared route nothing is filled (opt-in, ADR-7)', () => {
    const env = runEnv(1, 't', {}, [], { explore: 'm' });
    expect(env['CLAUDE_CODE_SUBAGENT_MODEL']).toBeUndefined();
  });
});
