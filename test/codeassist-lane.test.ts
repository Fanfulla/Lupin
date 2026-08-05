// M6b lane wiring: a `mode: "codeassist"` profile must resolve the account
// project, reach :streamGenerateContent and come back as Anthropic, streaming
// or not. The fake provider replays the REAL captures, so the lane is exercised
// against the grammar the live API actually speaks.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/ingress.js';
import { resetCodeAssistProjectCache } from '../src/server/codeassist-forward.js';
import type { LupinConfig } from '../src/config/config.js';

const capture = (name: string): string => readFileSync(join(__dirname, 'helpers', 'captures', name), 'utf8');

const TOKEN = 'local-token';
const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

function config(): LupinConfig {
  return {
    activeProfile: 'sub',
    port: 0,
    localToken: TOKEN,
    profiles: {
      sub: {
        provider: 'geminisub',
        mode: 'codeassist',
        auth: { type: 'bearer', apiKeyRef: 'FAKE_KEY' },
        // Mirrors the real default: the slots say what each tier MEANS, and the
        // lane decides what the account can actually serve.
        slots: { opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-2.5-flash', haiku: 'gemini-3.1-flash-lite' },
      },
    },
  };
}

interface Seen {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** A fake Code Assist: answers :loadCodeAssist, then replays a captured stream. */
function fakeCodeAssist(fixture: string, opts: { project?: string | null; tier?: string } = {}) {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = String(input);
    seen.push({ url, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>, headers: new Headers(init?.headers) });
    if (url.endsWith(':loadCodeAssist')) {
      const project = opts.project === undefined ? 'proj-live' : opts.project;
      return Promise.resolve(
        new Response(JSON.stringify({ currentTier: { id: opts.tier ?? 'standard-tier' }, ...(project === null ? {} : { cloudaicompanionProject: project }) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(
      new Response(capture(fixture), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { seen, fetchImpl };
}

const ask = (body: unknown): Request =>
  new Request('http://127.0.0.1/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  resetCodeAssistProjectCache();
  process.env['FAKE_KEY'] = 'k';
});

describe('codeassist lane: request shaping', () => {
  it('resolves the project first, then posts the wrapped request with alt=sse', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    await app.request(ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));

    expect(seen).toHaveLength(2);
    expect(seen[0]?.url).toBe(`${BASE}:loadCodeAssist`);
    expect(seen[1]?.url).toBe(`${BASE}:streamGenerateContent?alt=sse`);

    const body = seen[1]?.body ?? {};
    expect(body['model']).toBe('gemini-3.1-pro-preview'); // the opus slot, resolved
    expect(body['project']).toBe('proj-live');
    expect(typeof body['user_prompt_id']).toBe('string');
    const request = body['request'] as Record<string, unknown>;
    expect(request['contents']).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
    expect(typeof request['session_id']).toBe('string');
    // The knobs this provider really honours travel (unlike the WHAM lane).
    expect(request['generationConfig']).toEqual({ maxOutputTokens: 100 });
  });

  it('the project is resolved once and cached, not on every request', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const body = { model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
    await app.request(ask(body));
    await app.request(ask(body));
    expect(seen.filter((s) => s.url.endsWith(':loadCodeAssist'))).toHaveLength(1);
    expect(seen.filter((s) => s.url.includes(':streamGenerateContent'))).toHaveLength(2);
  });

  it('an account with no project gets an actionable error, not a crash', async () => {
    const { fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', { project: null });
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(400);
    const err = (await res.json()) as { error: { message: string } };
    expect(err.error.message).toContain('never been onboarded');
  });
});

describe('codeassist lane: the free tier serves one slot', () => {
  const free = { tier: 'free-tier' as const };

  it('sonnet is served, because that is where Claude Code starts', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', free);
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-sonnet-4', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(seen.some((s) => s.url.includes(':streamGenerateContent'))).toBe(true);
  });

  it('opus is served by the free model instead of failing the session', async () => {
    // Refusing was tried and measured: Claude Code opens on the OPUS slot, so a
    // hard block killed the very first request and the session never started.
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', free);
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    const generated = seen.find((s) => s.url.includes(':streamGenerateContent'));
    // The sonnet slot's model answered, not the pro one the opus slot names.
    expect(generated?.body['model']).toBe('gemini-2.5-flash');
  });

  it('the substitution is logged, never silent', async () => {
    const lines: Record<string, unknown>[] = [];
    const { fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', free);
    const app = createApp(config(), { fetchImpl, logger: (l) => lines.push(l as unknown as Record<string, unknown>) });
    await app.request(ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));
    const line = lines.find((l) => l['tierDowngrade'] !== undefined);
    expect(line?.['tierDowngrade']).toBe('opus');
    expect(line?.['model']).toBe('gemini-2.5-flash'); // the model that really ran
  });

  it('haiku is served too, so background work does not break', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', free);
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(seen.find((s) => s.url.includes(':streamGenerateContent'))?.body['model']).toBe('gemini-2.5-flash');
  });

  it('a paid tier is not substituted at all: opus keeps its own model', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse', { tier: 'standard-tier' });
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(seen.find((s) => s.url.includes(':streamGenerateContent'))?.body['model']).toBe('gemini-3.1-pro-preview');
  });
});

describe('codeassist lane: non-streaming caller', () => {
  it('recomposes the stream into an Anthropic Message', async () => {
    const { fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['role']).toBe('assistant');
    expect(msg['model']).toBe('claude-opus-5'); // the name Claude Code asked for
    expect(msg['stop_reason']).toBe('end_turn');
    expect(msg['content']).toEqual([{ type: 'text', text: 'One\nTwo\nThree\nFour\nFive' }]);
    expect(msg['usage']).toMatchObject({ input_tokens: 18, output_tokens: 9 });
  });

  it('a tool call comes back as a tool_use block with parsed input', async () => {
    const { fetchImpl } = fakeCodeAssist('codeassist-stream-toolcall.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({
        model: 'claude-opus-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'weather in Rome?' }],
        tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
      }),
    );
    const msg = (await res.json()) as { stop_reason: string; content: Record<string, unknown>[] };
    expect(msg.stop_reason).toBe('tool_use');
    expect(msg.content[0]).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Rome' } });
  });
});

describe('codeassist lane: streaming caller', () => {
  it('re-emits the Anthropic event sequence', async () => {
    const { fetchImpl } = fakeCodeAssist('codeassist-stream-toolresult.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('event: message_stop');
    expect(body).toContain('The weather in Rome is clear');
  });
});

describe('codeassist lane: count_tokens', () => {
  it('answers locally without touching the provider', async () => {
    const { seen, fetchImpl } = fakeCodeAssist('codeassist-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      new Request('http://127.0.0.1/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { input_tokens: number }).toHaveProperty('input_tokens');
    expect(seen).toHaveLength(0);
  });
});
