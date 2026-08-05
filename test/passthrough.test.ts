import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { validateConfig, type LupinConfig } from '../src/config/config.js';
import { createApp } from '../src/server/ingress.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';

// Integration level (TESTING.md §3): full server against the fake provider.

const LOCAL_TOKEN = 'local-secret';
const KEY_ENV = 'LUPIN_TEST_KEY';
const KEY_VALUE = 'test-key-123';

function testConfig(baseUrl: string, overrides: Partial<LupinConfig> = {}): LupinConfig {
  return {
    activeProfile: 'main',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      main: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
      },
    },
    ...overrides,
  };
}

async function post(
  app: ReturnType<typeof createApp>,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN, ...headers },
    body: JSON.stringify(body),
  });
}

let fake: FakeProvider;
const noopLogger = (): void => undefined;

beforeAll(async () => {
  process.env[KEY_ENV] = KEY_VALUE;
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.respondWith({ kind: 'json', body: { ok: true } });
});

describe('passthrough /v1/messages', () => {
  it('rewrites model by slot, sets bearer auth, pipes the JSON response', async () => {
    const providerBody = { id: 'msg_1', type: 'message', role: 'assistant', content: [] };
    fake.respondWith({ kind: 'json', body: providerBody });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9-9', max_tokens: 10, messages: [] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(providerBody);
    const seen = fake.requests[0];
    expect(seen?.path).toBe('/v1/messages');
    expect((seen?.body as Record<string, unknown>)['model']).toBe('model-mid');
    expect(seen?.headers['authorization']).toBe(`Bearer ${KEY_VALUE}`);
    expect(seen?.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('maps opus and haiku slots', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', { model: 'claude-opus-9', messages: [] });
    await post(app, '/v1/messages', { model: 'claude-haiku-9', messages: [] });
    expect((fake.requests[0]?.body as Record<string, unknown>)['model']).toBe('model-big');
    expect((fake.requests[1]?.body as Record<string, unknown>)['model']).toBe('model-small');
  });

  it('passes a real model name through unchanged (model picker direct use)', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', { model: 'model-small', messages: [] });
    expect((fake.requests[0]?.body as Record<string, unknown>)['model']).toBe('model-small');
  });

  it('uses x-api-key auth scheme when the profile says so', async () => {
    const config = testConfig(fake.url);
    const mainProfile = config.profiles['main'];
    if (!mainProfile) throw new Error('unreachable');
    mainProfile.auth = { type: 'x-api-key', apiKeyRef: KEY_ENV };
    const app = createApp(config, { logger: noopLogger });

    await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });
    expect(fake.requests[0]?.headers['x-api-key']).toBe(KEY_VALUE);
    expect(fake.requests[0]?.headers['authorization']).toBeUndefined();
  });

  it('forwards anthropic-version and anthropic-beta from the client', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(
      app,
      '/v1/messages',
      { model: 'claude-sonnet-9', messages: [] },
      { 'anthropic-version': '2024-01-01', 'anthropic-beta': 'some-beta' },
    );
    expect(fake.requests[0]?.headers['anthropic-version']).toBe('2024-01-01');
    expect(fake.requests[0]?.headers['anthropic-beta']).toBe('some-beta');
  });

  it('pipes SSE byte-per-byte, split chunks included', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ciao ',
      'mondo è"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    fake.respondWith({ kind: 'sse', chunks });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', stream: true, messages: [] });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toBe(chunks.join(''));
  });

  it('count_tokens: provider 404 → local estimate fallback (§8)', async () => {
    fake.respondWith({ kind: 'error', status: 404, body: 'not found' });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-9',
      messages: [{ role: 'user', content: 'Fix the bug in the auth middleware.' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
  });

  it('forwards count_tokens with the model rewritten', async () => {
    fake.respondWith({ kind: 'json', body: { input_tokens: 42 } });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages/count_tokens', { model: 'claude-sonnet-9', messages: [] });

    expect(await res.json()).toEqual({ input_tokens: 42 });
    expect(fake.requests[0]?.path).toBe('/v1/messages/count_tokens');
    expect((fake.requests[0]?.body as Record<string, unknown>)['model']).toBe('model-mid');
  });
});

describe('error normalization (SPEC-TRANSLATION §6)', () => {
  it('provider 401 → authentication_error with provider message', async () => {
    fake.respondWith({ kind: 'error', status: 401, body: '{"error":{"message":"bad key"}}' });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { type: string; error: { type: string; message: string } };
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('bad key');
  });

  it('provider 429 → rate_limit_error, retry-after preserved', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: '{"error":{"message":"slow down"}}', headers: { 'retry-after': '7' } });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });

    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('7');
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('rate_limit_error');
  });

  it('provider 500 → 529 overloaded_error (Claude Code auto-retries)', async () => {
    fake.respondWith({ kind: 'error', status: 500, body: 'internal' });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });

    expect(res.status).toBe(529);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('overloaded_error');
    expect(body.error.message).toContain('internal');
  });

  it('provider unreachable → 529 overloaded_error', async () => {
    // TEST-NET-1 address (RFC 5737): never routable, fails fast
    const app = createApp(testConfig('http://127.0.0.1:1'), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });

    expect(res.status).toBe(529);
    const body = (await res.json()) as { error: { type: string } };
    expect(body.error.type).toBe('overloaded_error');
  });

  it('wrong local token → 401, provider never called', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'wrong' },
      body: JSON.stringify({ model: 'claude-sonnet-9', messages: [] }),
    });

    expect(res.status).toBe(401);
    expect(fake.requests.length).toBe(0);
  });

  it('accepts the local token via Authorization: Bearer too', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_TOKEN}` },
      body: JSON.stringify({ model: 'claude-sonnet-9', messages: [] }),
    });
    expect(res.status).toBe(200);
  });

  it('missing API key env var → 401 naming the variable', async () => {
    const config = testConfig(fake.url);
    const mainProfile = config.profiles['main'];
    if (!mainProfile) throw new Error('unreachable');
    mainProfile.auth = { type: 'bearer', apiKeyRef: 'LUPIN_MISSING_KEY' };
    const app = createApp(config, { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', messages: [] });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('LUPIN_MISSING_KEY');
    expect(fake.requests.length).toBe(0);
  });

});

describe('tier-equivalent failover (SPEC-PROVIDERS §4ter)', () => {
  let backup: FakeProvider;
  const lines: import('../src/server/log.js').RequestLogLine[] = [];
  const capture = (l: import('../src/server/log.js').RequestLogLine): void => {
    lines.push(l);
  };

  function failoverConfig(): LupinConfig {
    const config = testConfig(fake.url);
    config.profiles['main']!.failover = 'backup';
    config.profiles['backup'] = {
      provider: 'moonshot',
      mode: 'passthrough',
      baseUrl: backup.url,
      auth: { type: 'bearer', apiKeyRef: KEY_ENV },
      slots: { opus: 'backup-big', sonnet: 'backup-mid', haiku: 'backup-small' },
    };
    return config;
  }

  beforeAll(async () => {
    backup = await startFakeProvider();
  });
  afterAll(async () => {
    await backup.close();
  });
  beforeEach(() => {
    lines.length = 0;
    backup.requests.length = 0;
    backup.respondWith({ kind: 'json', body: { id: 'msg_backup', content: [] } });
  });

  it('429 on the primary → one retry through the failover profile, visible in the log', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: '{"error":{"message":"rate limited"}}' });
    const app = createApp(failoverConfig(), { logger: capture });
    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe('msg_backup');
    expect((backup.requests[0]?.body as { model: string }).model).toBe('backup-mid'); // re-resolved on backup slots
    expect(lines[0]?.failedOver).toBe('main');
    expect(lines[0]?.profile).toBe('backup');
  });

  it('network error on the primary → failover', async () => {
    const config = failoverConfig();
    config.profiles['main']!.baseUrl = 'http://127.0.0.1:9'; // dead port
    const app = createApp(config, { logger: noopLogger });
    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
    expect(res.status).toBe(200);
    expect(backup.requests.length).toBe(1);
  });

  it('4xx on the primary → NO failover, error propagates untouched', async () => {
    fake.respondWith({ kind: 'error', status: 400, body: '{"error":{"message":"bad request"}}' });
    const app = createApp(failoverConfig(), { logger: noopLogger });
    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
    expect(res.status).toBe(400);
    expect(backup.requests.length).toBe(0);
  });

  it('failover failing too → its error propagates, no cascade', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: '{"error":{"message":"rate limited"}}' });
    backup.respondWith({ kind: 'error', status: 500, body: 'boom' });
    const app = createApp(failoverConfig(), { logger: noopLogger });
    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
    expect(res.status).toBe(529); // normalized 5xx, from the backup
    expect(backup.requests.length).toBe(1);
  });

  it('validateConfig rejects a failover pointing to an unknown profile', () => {
    const config = testConfig(fake.url);
    config.profiles['main']!.failover = 'ghost';
    expect(() => validateConfig(config)).toThrow(/failover profile "ghost"/);
  });
});

describe('content-aware routing end-to-end (SPEC-PROVIDERS §4quater)', () => {
  it('thinking route fires, model overridden, routed marker in the log', async () => {
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    const config = testConfig(fake.url);
    config.profiles['main']!.routes = { thinking: { target: 'model-think' } };
    const app = createApp(config, { logger: (l) => lines.push(l) });
    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-5',
      thinking: { type: 'enabled', budget_tokens: 100 },
      messages: [],
    });
    expect(res.status).toBe(200);
    expect((fake.requests[0]?.body as { model: string }).model).toBe('model-think');
    expect(lines[0]?.routed).toBe('thinking');
    expect(lines[0]?.model).toBe('model-think');
  });

  it('no route configured → slot mapping untouched, no marker', async () => {
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    const app = createApp(testConfig(fake.url), { logger: (l) => lines.push(l) });
    await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });
    expect((fake.requests[0]?.body as { model: string }).model).toBe('model-mid');
    expect(lines[0]?.routed).toBeUndefined();
  });
});

describe('GET /v1/models (SPEC-PROVIDERS §4.2 — model picker)', () => {
  it('lists the resolved slot models of the active profile, deduped, in slot order', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    const res = await app.request('/v1/models', { headers: { 'x-api-key': LOCAL_TOKEN } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { type: string; id: string; display_name: string }[]; has_more: boolean };
    expect(body.has_more).toBe(false);
    // The model rows come first and in slot order; the profile-switch rows of
    // §4.3 follow them and are asserted in test/profile-switch.test.ts.
    expect(body.data.filter((m) => !m.id.includes('switch:')).map((m) => m.id)).toEqual([
      'claude-lupin-model-big',
      'claude-lupin-model-mid',
      'claude-lupin-model-small',
    ]);
    expect(body.data[0]).toEqual({ type: 'model', id: 'claude-lupin-model-big', display_name: 'model-big' });
  });

  // Verified on the client binary 2.1.219 (2026-07-24): gateway discovery keeps
  // only ids matching /^(claude|anthropic)/i, so bare provider names never reach
  // the picker. The prefix is what makes the endpoint usable at all.
  it('every published id survives the client-side gateway filter', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    const res = await app.request('/v1/models', { headers: { 'x-api-key': LOCAL_TOKEN } });
    const body = (await res.json()) as { data: { id: string; display_name: string }[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const m of body.data) {
      expect(/^(claude|anthropic)/i.test(m.id)).toBe(true);
    }
    // A model row shows the bare model name; a switch row says what it does.
    for (const m of body.data.filter((x) => !x.id.includes('switch:'))) {
      expect(m.display_name).toBe(m.id.replace('claude-lupin-', ''));
    }
  });

  // The round trip that matters: what the picker sends back must resolve to the
  // real model, direct-use, without touching the config.
  it('the published id, sent back as the request model, reaches the provider as the real name', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', { model: 'claude-lupin-model-small', messages: [] });
    expect((fake.requests[0]?.body as { model: string }).model).toBe('model-small');
  });

  it('dedupes when slots share a model', async () => {
    const config = testConfig(fake.url);
    config.profiles['main']!.slots = { opus: 'model-big', sonnet: 'model-big', haiku: 'model-small' };
    const app = createApp(config, { logger: noopLogger });
    const res = await app.request('/v1/models', { headers: { 'x-api-key': LOCAL_TOKEN } });
    const body = (await res.json()) as { data: { id: string }[] };
    expect(body.data.filter((m) => !m.id.includes('switch:')).map((m) => m.id)).toEqual([
      'claude-lupin-model-big',
      'claude-lupin-model-small',
    ]);
  });

  it('rejects a missing or wrong local token with 401', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    expect((await app.request('/v1/models')).status).toBe(401);
    expect((await app.request('/v1/models', { headers: { 'x-api-key': 'wrong' } })).status).toBe(401);
  });
});

describe('/health', () => {
  it('reports the active profile and the resolved slot models', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      activeProfile: 'main',
      slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
      health: { main: 'healthy' },
    });
  });

  it('a broken slot delegation never kills /health', async () => {
    const config = testConfig(fake.url);
    config.profiles['main']!.slots.haiku = { profile: 'ghost' }; // dangling delegation
    const app = createApp(config, { logger: noopLogger });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slots: Record<string, string> };
    expect(body.slots['opus']).toBe('model-big');
    expect(body.slots['haiku']).toBeUndefined();
  });
});

// The single biggest cost for a local model is re-processing the prompt: the
// Claude Code harness alone is ~46K tokens, and llama.cpp / LM Studio skip that
// work only while the request prefix stays byte-identical to the previous one.
// Passthrough is what local providers use (ADR-21), so a change here that
// reordered a key or normalised a field would make every turn pay full prefill
// again, silently and with no error to look at. The translate path has
// test/cache-stability.test.ts; this is its passthrough half.
describe('passthrough prefix stability (local KV cache reuse)', () => {
  const SYSTEM = [{ type: 'text', text: 'You are a coding assistant.', cache_control: { type: 'ephemeral' } }];
  const TOOLS = [
    {
      name: 'mcp__filesystem__list_directory_with_sizes',
      description: 'List a directory',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ];
  const turn = (text: string): Record<string, unknown> => ({
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    system: SYSTEM,
    tools: TOOLS,
    messages: [{ role: 'user', content: text }],
  });

  /** What the runtime hashes: everything before the last turn. */
  const prefixOf = (body: unknown): string => {
    const b = body as Record<string, unknown>;
    return JSON.stringify({ model: b['model'], system: b['system'], tools: b['tools'] });
  };

  it('forwards a byte-identical prefix when only the last turn changes', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', turn('what does this repo do?'));
    await post(app, '/v1/messages', turn('now add a test for it'));

    expect(fake.requests.length).toBe(2);
    expect(prefixOf(fake.requests[1]?.body)).toBe(prefixOf(fake.requests[0]?.body));
    // ...while the request as a whole did change, or the test proves nothing.
    expect(JSON.stringify(fake.requests[1]?.body)).not.toBe(JSON.stringify(fake.requests[0]?.body));
  });

  it('the same request twice is byte-identical on the wire', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', turn('hello'));
    await post(app, '/v1/messages', turn('hello'));
    expect(JSON.stringify(fake.requests[1]?.body)).toBe(JSON.stringify(fake.requests[0]?.body));
  });

  it('slot resolution rewrites the model without moving it ahead of the prefix', async () => {
    const app = createApp(testConfig(fake.url), { logger: noopLogger });
    await post(app, '/v1/messages', turn('hi'));
    const sent = fake.requests[0]?.body as Record<string, unknown>;
    expect(sent['model']).toBe('model-mid'); // resolved from the sonnet slot
    // Key order is what a byte-prefix match depends on.
    expect(Object.keys(sent)).toEqual(['model', 'max_tokens', 'system', 'tools', 'messages']);
  });
});

// Observed live 2026-07-19: LM Studio answered a doomed request with HTTP 200
// and an SSE stream whose only content was `event: error`. The log recorded a
// clean 200, so `lupin logs` showed success for a request that wholly failed.
describe('SSE streams that carry an error under HTTP 200', () => {
  const errorEvent =
    'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"exceeds the available context size"}}\n\n';

  it('the log gains a line naming the stream error', async () => {
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    fake.respondWith({ kind: 'sse', chunks: [errorEvent] });
    const app = createApp(testConfig(fake.url), { logger: (l) => lines.push(l) });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', stream: true, messages: [] });
    await res.text(); // the tap only sees what the client actually drains

    expect(lines.some((l) => l.streamError !== undefined)).toBe(true);
    expect(lines.find((l) => l.streamError !== undefined)?.streamError).toContain('api_error');
  });

  it('the forwarded bytes stay identical: the tap observes, never edits (ADR-7)', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start"}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"ciao ',
      'mondo è"}}\n\n',
      errorEvent,
    ];
    fake.respondWith({ kind: 'sse', chunks });
    const app = createApp(testConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', stream: true, messages: [] });
    expect(await res.text()).toBe(chunks.join(''));
  });

  it('a clean stream logs no stream error', async () => {
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    fake.respondWith({ kind: 'sse', chunks: ['event: message_stop\ndata: {"type":"message_stop"}\n\n'] });
    const app = createApp(testConfig(fake.url), { logger: (l) => lines.push(l) });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', stream: true, messages: [] });
    await res.text();

    expect(lines.every((l) => l.streamError === undefined)).toBe(true);
  });

  it('an error event split across chunks is still caught', async () => {
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    fake.respondWith({ kind: 'sse', chunks: ['event: er', 'ror\ndata: {"type":"error","error":{"type":"api_error"}}\n\n'] });
    const app = createApp(testConfig(fake.url), { logger: (l) => lines.push(l) });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', stream: true, messages: [] });
    await res.text();

    expect(lines.some((l) => l.streamError !== undefined)).toBe(true);
  });
});

describe('quota-aware durable switch (SPEC-PROVIDERS §4octies)', () => {
  let backup: FakeProvider;
  const lines: import('../src/server/log.js').RequestLogLine[] = [];
  const capture = (l: import('../src/server/log.js').RequestLogLine): void => {
    lines.push(l);
  };
  const switches: [string, string][] = [];

  // The message text is the one SEEN LIVE on the Kimi subscription 2026-07-29
  // (recorded in NEXT-STEPS the same day); the envelope is the standard
  // Anthropic error shape the endpoint speaks.
  const QUOTA_BODY = '{"type":"error","error":{"type":"rate_limit_error","message":"You’ve reached your usage limit for this billing cycle."}}';

  function quotaConfig(): LupinConfig {
    const config = testConfig(fake.url);
    config.profiles['main']!.provider = 'kimicode';
    config.profiles['main']!.failover = 'backup';
    config.profiles['backup'] = {
      provider: 'moonshot',
      mode: 'passthrough',
      baseUrl: backup.url,
      auth: { type: 'bearer', apiKeyRef: KEY_ENV },
      slots: { opus: 'backup-big', sonnet: 'backup-mid', haiku: 'backup-small' },
    };
    return config;
  }

  beforeAll(async () => {
    backup = await startFakeProvider();
  });
  afterAll(async () => {
    await backup.close();
  });
  beforeEach(() => {
    lines.length = 0;
    switches.length = 0;
    backup.requests.length = 0;
    backup.respondWith({ kind: 'json', body: { id: 'msg_backup', content: [] } });
  });

  it('a quota-exhausted 429 on the active profile moves it durably to the failover', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: QUOTA_BODY });
    const config = quotaConfig();
    const app = createApp(config, {
      logger: capture,
      persistActiveProfile: (from, to) => switches.push([from, to]),
    });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });

    expect(res.status).toBe(200);
    expect(config.activeProfile).toBe('backup'); // this daemon, immediately
    expect(switches).toEqual([['main', 'backup']]); // the config file write
    const line = lines.find((l) => l.quotaSwitch !== undefined);
    expect(line?.quotaSwitch).toBe('backup');
    expect(line?.failedOver).toBe('main');
  });

  it('a transient 429 fails over per-request but never moves the pointer', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: '{"type":"error","error":{"type":"rate_limit_error","message":"rate limited, slow down"}}' });
    const config = quotaConfig();
    const app = createApp(config, {
      logger: capture,
      persistActiveProfile: (from, to) => switches.push([from, to]),
    });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });

    expect(res.status).toBe(200); // §4ter still serves the request
    expect(config.activeProfile).toBe('main');
    expect(switches).toEqual([]);
    expect(lines.every((l) => l.quotaSwitch === undefined)).toBe(true);
  });

  it('the same message on a provider with no matcher stays transient', async () => {
    fake.respondWith({ kind: 'error', status: 429, body: QUOTA_BODY });
    const config = quotaConfig();
    config.profiles['main']!.provider = 'moonshot'; // pay-per-token: no matcher listed
    const app = createApp(config, {
      logger: capture,
      persistActiveProfile: (from, to) => switches.push([from, to]),
    });

    await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });

    expect(config.activeProfile).toBe('main');
    expect(switches).toEqual([]);
  });

  it('a failed request logs the provider message, scrubbed and truncated', async () => {
    fake.respondWith({ kind: 'error', status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"function \\"web_search\\" not found"}}' });
    const app = createApp(testConfig(fake.url), { logger: capture });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-5', messages: [] });

    expect(res.status).toBe(400);
    const line = lines.find((l) => l.errorMessage !== undefined);
    expect(line?.errorMessage).toContain('web_search');
  });
});
