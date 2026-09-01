import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureOAuthProfile } from '../src/cli/login.js';
import { loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import { setOAuthTokens } from '../src/config/credentials.js';
import { OAUTH_PROVIDERS } from '../src/providers/oauth.js';
import { createApp } from '../src/server/ingress.js';

const TOKEN = 'local-token';
const capture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'helpers', 'captures', name), 'utf8');

let dir: string;
let previousDir: string | undefined;

beforeEach(() => {
  previousDir = process.env.LUPIN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'lupin-xai-'));
  process.env.LUPIN_DIR = dir;
});

afterEach(() => {
  delete process.env.XAI_API_KEY;
  if (previousDir === undefined) delete process.env.LUPIN_DIR;
  else process.env.LUPIN_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

const ask = (body: unknown) =>
  new Request('http://127.0.0.1/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify(body),
  });

function config(profile: LupinConfig['profiles'][string]): LupinConfig {
  return {
    activeProfile: 'grok',
    port: 0,
    localToken: TOKEN,
    profiles: { grok: profile },
  };
}

describe('xAI API-key profile', () => {
  it('uses the documented Chat Completions endpoint, Bearer key and resolved model', async () => {
    process.env.XAI_API_KEY = 'xai-api-fake';
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'chat-1',
            choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 1 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'translate',
        auth: { type: 'bearer', apiKeyRef: 'XAI_API_KEY' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer xai-api-fake');
    expect(seen[0]?.body['model']).toBe('grok-4.6');
  });
});

describe('xAI OAuth profile', () => {
  it('creates a separate Responses profile from the reviewed OAuth descriptor', () => {
    saveConfig({ activeProfile: '', port: 3456, localToken: TOKEN, profiles: {} });
    const def = OAUTH_PROVIDERS.xai;
    if (def === undefined) throw new Error('xAI OAuth descriptor missing');

    expect(ensureOAuthProfile(def)).toBe(true);

    expect(loadConfig().profiles['grok-sub']).toMatchObject({
      provider: 'xai',
      mode: 'responses',
      auth: { type: 'oauth', provider: 'xai' },
      slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
    });
  });

  it('sends the OAuth bearer through the shared Responses grammar', async () => {
    setOAuthTokens('xai', {
      accessToken: 'xai-oauth-fake',
      refreshToken: 'xai-refresh-fake',
      expiresAt: Date.now() + 3_600_000,
      lifetimeMs: 3_600_000,
      tokenType: 'Bearer',
    });
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(
        new Response(capture('wham-stream-simple.sse'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
      );
    };
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'responses',
        auth: { type: 'oauth', provider: 'xai' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(res.status).toBe(200);
    expect(seen[0]?.url).toBe('https://api.x.ai/v1/responses');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer xai-oauth-fake');
    expect(seen[0]?.body).toMatchObject({ model: 'grok-4.6', store: false, stream: true });
    const body = (await res.json()) as { content: { type: string; text: string }[] };
    expect(body.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('redacts an opaque OAuth token echoed by an inference error', async () => {
    const accessToken = 'opaque.access/provider-value';
    setOAuthTokens('xai', {
      accessToken,
      refreshToken: 'opaque.refresh/provider-value',
      expiresAt: Date.now() + 3_600_000,
      lifetimeMs: 3_600_000,
      tokenType: 'Bearer',
    });
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: `credential ${accessToken} rejected` } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'responses',
        auth: { type: 'oauth', provider: 'xai' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(accessToken);
  });

  it('redacts an opaque OAuth token echoed by an inference network error', async () => {
    const accessToken = 'opaque.access/network-value';
    setOAuthTokens('xai', {
      accessToken,
      refreshToken: 'opaque.refresh/network-value',
      expiresAt: Date.now() + 3_600_000,
      lifetimeMs: 3_600_000,
      tokenType: 'Bearer',
    });
    const fetchImpl: typeof fetch = () => Promise.reject(new Error(`socket closed for ${accessToken}`));
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'responses',
        auth: { type: 'oauth', provider: 'xai' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const text = await res.text();

    expect(res.status).toBe(529);
    expect(text).toContain('[redacted]');
    expect(text).not.toContain(accessToken);
  });

  it('redacts an opaque OAuth token echoed by a streaming reader failure', async () => {
    const accessToken = 'opaque.access/stream-value';
    setOAuthTokens('xai', {
      accessToken,
      refreshToken: 'opaque.refresh/stream-value',
      expiresAt: Date.now() + 3_600_000,
      lifetimeMs: 3_600_000,
      tokenType: 'Bearer',
    });
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error(`stream closed for ${accessToken}`));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'responses',
        auth: { type: 'oauth', provider: 'xai' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const text = await res.text();

    expect(text).toContain('[redacted]');
    expect(text).not.toContain(accessToken);
  });

  it('rejects an OAuth profile override outside the pinned xAI HTTPS origin before fetch', async () => {
    setOAuthTokens('xai', {
      accessToken: 'xai-oauth-fake',
      refreshToken: 'xai-refresh-fake',
      expiresAt: Date.now() + 3_600_000,
      lifetimeMs: 3_600_000,
      tokenType: 'Bearer',
    });
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    };
    const app = createApp(
      config({
        provider: 'xai',
        mode: 'responses',
        baseUrl: 'https://x.ai.evil.example/v1',
        auth: { type: 'oauth', provider: 'xai' },
        slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
      }),
      { fetchImpl },
    );

    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 20, messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(res.status).toBe(401);
    expect(calls).toBe(0);
    expect(await res.text()).toContain('refusing to send OAuth credential');
  });
});
