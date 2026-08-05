import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LupinConfig } from '../src/config/config.js';
import { createApp } from '../src/server/ingress.js';
import { CLIENT_NAME, CLIENT_URL } from '../src/providers/identity.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';

// Integration level (TESTING.md §3): client attribution headers reach the
// provider on every request, in both modes, and only where documented.

const LOCAL_TOKEN = 'local-secret';
const KEY_ENV = 'LUPIN_TEST_ATTRIBUTION_KEY';

function testConfig(provider: string, mode: 'passthrough' | 'translate', baseUrl: string): LupinConfig {
  return {
    activeProfile: 'main',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      main: {
        provider,
        mode,
        baseUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
      },
    },
  };
}

async function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
    body: JSON.stringify(body),
  });
}

const MSG = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

let fake: FakeProvider;
const noopLogger = (): void => undefined;

beforeAll(async () => {
  process.env[KEY_ENV] = 'test-key-123';
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.respondWith({ kind: 'json', body: { ok: true } });
});

describe('client identity (SPEC-PROVIDERS §5bis)', () => {
  it('CLIENT_VERSION comes from package.json, never a hand copy (audit §7.2)', async () => {
    const { CLIENT_VERSION } = await import('../src/providers/identity.js');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});

describe('provider client attribution (SPEC-PROVIDERS §5bis)', () => {
  it('sends the OpenRouter attribution headers in passthrough', async () => {
    const app = createApp(testConfig('openrouter', 'passthrough', fake.url), { logger: noopLogger });
    await post(app, MSG);

    const h = fake.requests[0]?.headers ?? {};
    expect(h['http-referer']).toBe(CLIENT_URL);
    expect(h['x-openrouter-title']).toBe(CLIENT_NAME);
    expect(h['x-openrouter-categories']).toBe('cli-agent');
  });

  it('sends the OpenRouter attribution headers in translate', async () => {
    const app = createApp(testConfig('openrouter', 'translate', fake.url), { logger: noopLogger });
    fake.respondWith({
      kind: 'json',
      body: {
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    });
    await post(app, MSG);

    const h = fake.requests[0]?.headers ?? {};
    expect(h['http-referer']).toBe(CLIENT_URL);
    expect(h['x-openrouter-title']).toBe(CLIENT_NAME);
  });

  // Attribution is opt-in per provider data: a provider with no documented
  // mechanism must not receive invented headers (CLAUDE.md rule 4).
  it('sends nothing to a provider without a documented mechanism', async () => {
    const app = createApp(testConfig('moonshot', 'passthrough', fake.url), { logger: noopLogger });
    await post(app, MSG);

    const h = fake.requests[0]?.headers ?? {};
    expect(h['http-referer']).toBeUndefined();
    expect(h['x-openrouter-title']).toBeUndefined();
  });

  // Attribution is per-request, not a one-time registration (openrouter.ai
  // /docs/app-attribution): a second call must carry them too.
  it('repeats the headers on every request', async () => {
    const app = createApp(testConfig('openrouter', 'passthrough', fake.url), { logger: noopLogger });
    await post(app, MSG);
    await post(app, MSG);

    expect(fake.requests).toHaveLength(2);
    for (const req of fake.requests) expect(req.headers['http-referer']).toBe(CLIENT_URL);
  });
});
