// M6a lane wiring: a `mode: "responses"` profile must reach the WHAM
// Responses endpoint and come back as Anthropic, both streaming and not.
// The fake provider replays the REAL captures, so the lane is exercised
// against the grammar the live API actually speaks.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';

const capture = (name: string): string => readFileSync(join(__dirname, 'helpers', 'captures', name), 'utf8');

const TOKEN = 'local-token';

function config(): LupinConfig {
  return {
    activeProfile: 'sub',
    port: 0,
    localToken: TOKEN,
    profiles: {
      sub: {
        provider: 'openaisub',
        mode: 'responses',
        auth: { type: 'bearer', apiKeyRef: 'FAKE_KEY' },
        slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.4-mini' },
      },
    },
  };
}

/** A fake WHAM: records the outgoing request, replays a captured stream. */
function fakeWham(fixture: string) {
  const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    seen.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return Promise.resolve(
      new Response(capture(fixture), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
  };
  return { seen, fetchImpl };
}

const ask = (body: unknown) =>
  new Request('http://127.0.0.1/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': TOKEN },
    body: JSON.stringify(body),
  });

describe('responses lane: request shaping', () => {
  it('posts to /responses with the WHAM-mandatory fields and the resolved model', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { seen, fetchImpl } = fakeWham('wham-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    await app.request(ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }));

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://chatgpt.com/backend-api/wham/responses');
    const body = seen[0]?.body ?? {};
    expect(body['model']).toBe('gpt-5.6-terra'); // the opus slot, resolved
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(body['max_output_tokens']).toBeUndefined(); // WHAM rejects it
    delete process.env['FAKE_KEY'];
  });
});

describe('responses lane: non-streaming caller', () => {
  it('recomposes the WHAM stream into an Anthropic Message', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { fetchImpl } = fakeWham('wham-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['role']).toBe('assistant');
    expect(msg['model']).toBe('claude-opus-5'); // the name Claude Code asked for
    expect(msg['stop_reason']).toBe('end_turn');
    const content = msg['content'] as Record<string, unknown>[];
    expect(content[0]).toEqual({ type: 'text', text: 'ok' });
    expect(msg['usage']).toMatchObject({ input_tokens: 24, output_tokens: 5 });
    delete process.env['FAKE_KEY'];
  });

  it('recomposes a tool call, with the arguments parsed back into input', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { fetchImpl } = fakeWham('wham-stream-toolcall.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, messages: [{ role: 'user', content: 'weather?' }] }),
    );
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['stop_reason']).toBe('tool_use');
    const tool = (msg['content'] as Record<string, unknown>[]).find((b) => b['type'] === 'tool_use');
    expect(tool).toMatchObject({ type: 'tool_use', name: 'get_weather', input: { city: 'Rome' } });
    delete process.env['FAKE_KEY'];
  });
});

describe('responses lane: limits WHAM refuses to accept', () => {
  it('never sends max_tokens or stop_sequences upstream, but enforces them here', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { seen, fetchImpl } = fakeWham('wham-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({
        model: 'claude-opus-5',
        max_tokens: 1,
        stop_sequences: ['zzz'],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    // Nothing that WHAM rejects leaves the proxy.
    const body = seen[0]?.body ?? {};
    for (const k of ['max_output_tokens', 'max_tokens', 'stop', 'stop_sequences', 'temperature', 'top_p']) {
      expect(body[k]).toBeUndefined();
    }
    // The capture says "ok"; a 1-token budget still yields a valid Message.
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['role']).toBe('assistant');
    delete process.env['FAKE_KEY'];
  });

  it('reports stop_reason max_tokens when the budget cuts the answer', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { fetchImpl } = fakeWham('wham-stream-toolresult.sse'); // a longer answer
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 2, messages: [{ role: 'user', content: 'hi' }] }),
    );
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['stop_reason']).toBe('max_tokens');
    delete process.env['FAKE_KEY'];
  });

  it('reports stop_reason stop_sequence and which one matched', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { fetchImpl } = fakeWham('wham-stream-toolresult.sse'); // answer contains "Rome"
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({
        model: 'claude-opus-5',
        max_tokens: 1000,
        stop_sequences: ['clear'],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    );
    const msg = (await res.json()) as Record<string, unknown>;
    expect(msg['stop_reason']).toBe('stop_sequence');
    expect(msg['stop_sequence']).toBe('clear');
    const text = (msg['content'] as Record<string, unknown>[]).map((b) => b['text']).join('');
    expect(text).not.toContain('clear');
    delete process.env['FAKE_KEY'];
  });
});

describe('responses lane: streaming caller', () => {
  it('streams Anthropic SSE events out of the WHAM stream', async () => {
    process.env['FAKE_KEY'] = 'k';
    const { fetchImpl } = fakeWham('wham-stream-simple.sse');
    const app = createApp(config(), { fetchImpl });
    const res = await app.request(
      ask({ model: 'claude-opus-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('event: message_stop');
    delete process.env['FAKE_KEY'];
  });
});
