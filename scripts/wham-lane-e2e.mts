// The whole proxy, live: an Anthropic request enters createApp, the responses
// lane resolves the real OAuth credential and calls the real WHAM, and an
// Anthropic Message comes back. Nothing faked.
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';

const config: LupinConfig = {
  activeProfile: 'sub',
  port: 0,
  localToken: 'e2e-token',
  profiles: {
    sub: {
      provider: 'openaisub',
      mode: 'responses',
      auth: { type: 'oauth', provider: 'openai' },
      slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.4-mini' },
    },
  },
};

const app = createApp(config);
const req = (body: unknown) => new Request('http://127.0.0.1/v1/messages', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-api-key': 'e2e-token' },
  body: JSON.stringify(body),
});

// 1) non-streaming, with a tool round trip in the history
const res = await app.request(req({
  model: 'claude-opus-5',
  max_tokens: 200,
  system: 'You are terse.',
  messages: [
    { role: 'user', content: 'What is the weather in Rome? Use the tool.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_e1', name: 'get_weather', input: { city: 'Rome' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_e1', content: '{"temp_c":21,"sky":"clear"}' }] },
  ],
  tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
}));
console.log('non-stream status:', res.status);
const msg = await res.json() as Record<string, unknown>;
console.log('  model echoed:', msg['model'], '| stop:', msg['stop_reason'], '| usage:', JSON.stringify(msg['usage']));
console.log('  text:', JSON.stringify((msg['content'] as Record<string, unknown>[])?.map(b => b['text']).join('')));

// 2) streaming
const res2 = await app.request(req({
  model: 'claude-haiku-4-5', max_tokens: 100, stream: true,
  messages: [{ role: 'user', content: 'Say the word ok and nothing else.' }],
}));
console.log('stream status:', res2.status, '| ct:', res2.headers.get('content-type'));
const sse = await res2.text();
const names = [...sse.matchAll(/^event: (\S+)$/gm)].map(m => m[1]);
const deltas = [...sse.matchAll(/"text_delta","text":"([^"]*)"/g)].map(m => m[1]).join('');
console.log('  events:', [...new Set(names)].join(','));
console.log('  streamed text:', JSON.stringify(deltas));
