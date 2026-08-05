// The whole proxy, live: an Anthropic request enters createApp, the codeassist
// lane resolves the real OAuth credential, asks Code Assist for the account
// project and calls the real :streamGenerateContent. Nothing faked.
//
// The FREE tier rate-limits consecutive calls, so each step retries on 429.
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';

const config: LupinConfig = {
  activeProfile: 'sub',
  port: 0,
  localToken: 'e2e-token',
  profiles: {
    sub: {
      provider: 'geminisub',
      mode: 'codeassist',
      auth: { type: 'oauth', provider: 'gemini' },
      slots: { opus: 'gemini-2.5-flash', sonnet: 'gemini-2.5-flash', haiku: 'gemini-3.1-flash-lite' },
    },
  },
};

const app = createApp(config);
const req = (body: unknown): Request =>
  new Request('http://127.0.0.1/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'e2e-token' },
    body: JSON.stringify(body),
  });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ask(body: unknown): Promise<Response> {
  for (let i = 1; i <= 8; i++) {
    const res = await app.request(req(body));
    if (res.status !== 429) return res;
    console.log(`  429, retry ${String(i)}/8 in 35s`);
    await sleep(35_000);
  }
  throw new Error('still rate limited after 8 tries');
}

// 1) non-streaming, with a tool round trip in the history
const res = await ask({
  model: 'claude-opus-5',
  max_tokens: 200,
  system: 'You are terse.',
  messages: [
    { role: 'user', content: 'What is the weather in Rome? Use the tool.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_e1', name: 'get_weather', input: { city: 'Rome' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_e1', content: '{"temp_c":21,"sky":"clear"}' }] },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'weather',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  ],
});
console.log('non-stream status:', res.status);
const msg = (await res.json()) as Record<string, unknown>;
console.log('  model echoed:', msg['model'], '| stop:', msg['stop_reason'], '| usage:', JSON.stringify(msg['usage']));
console.log(
  '  text:',
  JSON.stringify(
    (msg['content'] as Record<string, unknown>[] | undefined)?.map((b) => b['text'] ?? '').join('') ?? '',
  ),
);

// 2) streaming, and a tool call the model must decide to make on its own
const res2 = await ask({
  model: 'claude-haiku-4-5',
  max_tokens: 200,
  stream: true,
  messages: [{ role: 'user', content: 'What is the weather in Rome? Use the tool.' }],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  ],
});
console.log('stream status:', res2.status, '| ct:', res2.headers.get('content-type'));
const sse = await res2.text();
const names = [...sse.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
const deltas = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map((m) => m[1]).join('');
const toolJson = [...sse.matchAll(/"input_json_delta","partial_json":"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => m[1])
  .join('');
console.log('  events:', [...new Set(names)].join(','));
console.log('  streamed text:', JSON.stringify(deltas));
console.log('  tool arguments:', toolJson === '' ? '(none)' : JSON.parse(`"${toolJson}"`));
