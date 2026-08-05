import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LupinConfig } from '../src/config/config.js';
import { createApp } from '../src/server/ingress.js';
import type { RequestLogLine } from '../src/server/log.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';

// Integration level (TESTING.md §3): the proxy is the only place that sees
// every request — subagents never reach the Claude Code transcript — so the
// token counts have to survive both transports without touching the bytes.

const LOCAL_TOKEN = 'local-secret';
const KEY_ENV = 'LUPIN_TEST_USAGE_KEY';

function testConfig(mode: 'passthrough' | 'translate', baseUrl: string): LupinConfig {
  return {
    activeProfile: 'main',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      main: {
        provider: 'moonshot',
        mode,
        baseUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
      },
    },
  };
}

const MSG = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };

let fake: FakeProvider;
let lines: RequestLogLine[];

async function run(mode: 'passthrough' | 'translate' = 'passthrough'): Promise<Response> {
  const app = createApp(testConfig(mode, fake.url), { logger: (l) => lines.push(l) });
  const res = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
    body: JSON.stringify(MSG),
  });
  await res.text(); // drain: the usage line is emitted when the body closes
  return res;
}

beforeAll(async () => {
  process.env[KEY_ENV] = 'test-key-123';
  fake = await startFakeProvider();
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.requests.length = 0;
  lines = [];
});

describe('usage logging (SPEC-TRANSLATION §9.1)', () => {
  it('reports the counts a non-streamed passthrough body carries', async () => {
    fake.respondWith({
      kind: 'json',
      body: {
        type: 'message',
        usage: { input_tokens: 1200, output_tokens: 45, cache_read_input_tokens: 30_000 },
      },
    });
    await run();

    const usage = lines.find((l) => l.usage !== undefined)?.usage;
    expect(usage).toEqual({ input: 1200, output: 45, cacheRead: 30_000 });
  });

  it('reads input from message_start and the final output from message_delta', async () => {
    fake.respondWith({
      kind: 'sse',
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":900,"output_tokens":1,"cache_read_input_tokens":223488,"cache_creation_input_tokens":0}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":312}}\n\n',
      ],
    });
    await run();

    const usage = lines.find((l) => l.usage !== undefined)?.usage;
    // output must be the final delta value, not the placeholder in message_start
    expect(usage).toEqual({ input: 900, output: 312, cacheRead: 223_488, cacheCreate: 0 });
  });

  // The whole point of the tap is that it observes without altering (ADR-7):
  // a proxy that rewrote the stream would break the provider's prompt cache.
  it('forwards the stream byte-identical', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"cittá àèìòù 日本語"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
    ];
    fake.respondWith({ kind: 'sse', chunks });

    const app = createApp(testConfig('passthrough', fake.url), { logger: () => undefined });
    const res = await app.request('/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
      body: JSON.stringify(MSG),
    });
    expect(await res.text()).toBe(chunks.join(''));
  });

  // A usage object split across transport chunks must still be read: the SSE
  // framing does not promise one event per chunk.
  it('reads usage across a chunk boundary', async () => {
    const full =
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":777,"output_tokens":1}}}\n\nevent: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\n\n';
    fake.respondWith({ kind: 'sse', chunks: [full.slice(0, 40), full.slice(40, 95), full.slice(95)] });
    await run();

    const usage = lines.find((l) => l.usage !== undefined)?.usage;
    expect(usage?.input).toBe(777);
    expect(usage?.output).toBe(9);
  });

  it('reports counts in translate mode too', async () => {
    fake.respondWith({
      kind: 'json',
      body: {
        id: 'x',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 640, completion_tokens: 12 },
      },
    });
    await run('translate');

    const usage = lines.find((l) => l.usage !== undefined)?.usage;
    expect(usage).toEqual({ input: 640, output: 12 });
  });

  it('logs no usage line when the provider reports none', async () => {
    fake.respondWith({ kind: 'json', body: { type: 'message', content: [] } });
    await run();

    expect(lines.filter((l) => l.usage !== undefined)).toHaveLength(0);
    expect(lines).toHaveLength(1); // the request line, and nothing invented
  });
});
