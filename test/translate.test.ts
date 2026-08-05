import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LupinConfig } from '../src/config/config.js';
import { sanitizeToolName } from '../src/core/request.js';
import { createApp } from '../src/server/ingress.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';

// Integration level (TESTING.md §3): translate-mode wiring against the fake provider.
// Core mapping behavior is covered by fixtures; here we verify the composition:
// ingress → core mappers → provider endpoint → Anthropic-shaped output.

const LOCAL_TOKEN = 'local-secret';
const KEY_ENV = 'LUPIN_TEST_KEY';
const KEY_VALUE = 'test-key-123';

const LONG_TOOL_NAME = 'mcp__super-long-server-name__extremely_long_tool_name_that_overflows_sixty_four_chars';
const SANITIZED = sanitizeToolName(LONG_TOOL_NAME);

function translateConfig(baseUrl: string): LupinConfig {
  return {
    activeProfile: 'gpt',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      gpt: {
        provider: 'openai',
        mode: 'translate',
        baseUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
      },
    },
  };
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
    body: JSON.stringify(body),
  });
}

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((f) => f !== '')
    .map((frame) => {
      const lines = frame.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice('event: '.length) ?? '';
      const data = lines.find((l) => l.startsWith('data: '))?.slice('data: '.length) ?? '{}';
      return { event, data: JSON.parse(data) as Record<string, unknown> };
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
});

describe('translate /v1/messages (non-streaming)', () => {
  it('maps request to /chat/completions and response back to Anthropic shape', async () => {
    fake.respondWith({
      kind: 'json',
      body: {
        id: 'chatcmpl-42',
        model: 'model-mid',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ciao mondo' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      },
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-9',
      max_tokens: 100,
      system: 'sys prompt',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({
      id: 'msg_chatcmpl-42',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-9', // echoes the requested model, not the real one (§4)
      content: [{ type: 'text', text: 'ciao mondo' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 11, output_tokens: 3 },
    });

    const seen = fake.requests[0];
    expect(seen?.path).toBe('/chat/completions');
    expect(seen?.headers['authorization']).toBe(`Bearer ${KEY_VALUE}`);
    expect(seen?.headers['anthropic-version']).toBeUndefined();
    const pb = seen?.body as Record<string, unknown>;
    expect(pb['model']).toBe('model-mid');
    expect(pb['max_tokens']).toBe(100);
    expect(pb['n']).toBe(1);
    expect(pb['messages']).toEqual([
      { role: 'system', content: 'sys prompt' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('sanitizes long MCP tool names outbound and restores them inbound', async () => {
    expect(SANITIZED).not.toBe(LONG_TOOL_NAME); // guard: the case really exercises the rewrite
    fake.respondWith({
      kind: 'json',
      body: {
        id: 'chatcmpl-7',
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_1', type: 'function', function: { name: SANITIZED, arguments: '{"x":1}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-9',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: LONG_TOOL_NAME, description: 'd', input_schema: { type: 'object' } }],
    });

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['content']).toEqual([{ type: 'tool_use', id: 'call_1', name: LONG_TOOL_NAME, input: { x: 1 } }]);
    expect(body['stop_reason']).toBe('tool_use');
    const pb = fake.requests[0]?.body as { tools: { function: { name: string } }[] };
    expect(pb.tools[0]?.function.name).toBe(SANITIZED);
  });

  it('malformed tool arguments JSON → 500 api_error naming the tool (§3)', async () => {
    fake.respondWith({
      kind: 'json',
      body: {
        id: 'chatcmpl-8',
        choices: [
          {
            message: { role: 'assistant', tool_calls: [{ id: 'c', function: { name: 'mytool', arguments: '{broken' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', max_tokens: 10, messages: [] });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toContain('[lupin]');
    expect(body.error.message).toContain('mytool');
  });

  it('provider 401 → authentication_error (shared normalization path)', async () => {
    fake.respondWith({ kind: 'error', status: 401, body: '{"error":{"message":"bad key"}}' });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', { model: 'claude-sonnet-9', max_tokens: 10, messages: [] });

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe('authentication_error');
    expect(body.error.message).toContain('bad key');
  });

  it('count_tokens on a translate profile → local estimate, provider never called (§7)', async () => {
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages/count_tokens', {
      model: 'claude-sonnet-9',
      system: 'You are a coding agent.',
      messages: [{ role: 'user', content: 'Fix the bug in the auth middleware.' }],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { input_tokens: number };
    expect(body.input_tokens).toBeGreaterThan(0);
    expect(fake.requests.length).toBe(0);
  });
});

describe('translate /v1/messages (streaming)', () => {
  it('translates OpenAI SSE to Anthropic events, [DONE] never leaks out', async () => {
    fake.respondWith({
      kind: 'sse',
      chunks: [
        'data: {"id":"chatcmpl-9","model":"model-mid","choices":[{"delta":{"role":"assistant","content":"ci"}}]}\n\n',
        // merged frames in one transport chunk (observed quirk f)
        'data: {"choices":[{"delta":{"content":"ao"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        // usage arrives after finish_reason (observed quirk h)
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-9',
      max_tokens: 10,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const text = await res.text();
    expect(text).not.toContain('[DONE]');

    const events = parseSse(text);
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const message = events[0]?.data['message'] as Record<string, unknown>;
    expect(message['model']).toBe('claude-sonnet-9');
    const deltas = events.filter((e) => e.event === 'content_block_delta').map((e) => e.data['delta']);
    expect(deltas).toEqual([
      { type: 'text_delta', text: 'ci' },
      { type: 'text_delta', text: 'ao' },
    ]);
    const messageDelta = events[5]?.data as { delta: { stop_reason: string }; usage: Record<string, number> };
    expect(messageDelta.delta.stop_reason).toBe('end_turn');
    expect(messageDelta.usage).toEqual({ input_tokens: 5, output_tokens: 2 });

    // provider got a streaming request with usage reporting on (§1)
    const pb = fake.requests[0]?.body as Record<string, unknown>;
    expect(pb['stream']).toBe(true);
    expect(pb['stream_options']).toEqual({ include_usage: true });
  });

  it('streams tool calls with split arguments and restores the original name', async () => {
    fake.respondWith({
      kind: 'sse',
      chunks: [
        `data: {"id":"chatcmpl-t","choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"${SANITIZED}","arguments":""}}]}}]}\n\n`,
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"x\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: [DONE]\n\n',
      ],
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger });

    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-9',
      max_tokens: 10,
      stream: true,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: LONG_TOOL_NAME, description: 'd', input_schema: { type: 'object' } }],
    });

    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const block = events[1]?.data['content_block'] as Record<string, unknown>;
    expect(block['type']).toBe('tool_use');
    expect(block['id']).toBe('call_9');
    expect(block['name']).toBe(LONG_TOOL_NAME);
    const partials = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data['delta'] as Record<string, unknown>)['partial_json']);
    expect(partials.join('')).toBe('{"path":"x"}');
    const messageDelta = events[5]?.data as { delta: { stop_reason: string } };
    expect(messageDelta.delta.stop_reason).toBe('tool_use');
  });

  it('emits keep-alive pings toward Claude Code while the provider is slow (§9.3)', async () => {
    fake.respondWith({
      kind: 'sse',
      delayMs: 40,
      chunks: [
        'data: {"id":"chatcmpl-s","choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ],
    });
    const app = createApp(translateConfig(fake.url), { logger: noopLogger, pingIntervalMs: 10 });

    const res = await post(app, '/v1/messages', {
      model: 'claude-sonnet-9',
      max_tokens: 10,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const events = parseSse(await res.text());
    expect(events.some((e) => e.event === 'ping')).toBe(true);
    expect(events.at(-1)?.event).toBe('message_stop');
    const nonPing = events.filter((e) => e.event !== 'ping').map((e) => e.event);
    expect(nonPing).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });
});
