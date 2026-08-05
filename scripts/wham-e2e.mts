// End-to-end: build the request with the REAL mapper, send it to the REAL
// WHAM endpoint, decode with the REAL stream translator. Proves the two
// halves agree with the live protocol, not just with each other.
import { getOAuthTokens } from '../src/config/credentials.js';
import { mapAnthropicToResponses } from '../src/core/responses/request.js';
import { ResponsesStreamTranslator } from '../src/core/responses/stream.js';
import type { AnthropicRequest } from '../src/core/request.js';

const t = getOAuthTokens('openai');
if (!t) { console.error('no token'); process.exit(1); }

const anthropic: AnthropicRequest = {
  model: 'claude-opus-5',
  max_tokens: 256,
  system: 'You are terse. Always use the tool when asked about weather.',
  messages: [
    { role: 'user', content: 'What is the weather in Rome? Use the tool.' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_x1', name: 'get_weather', input: { city: 'Rome' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x1', content: '{"temp_c":21,"sky":"clear"}' }] },
  ],
  tools: [{ name: 'get_weather', description: 'Get the weather for a city',
    input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
};

const body = mapAnthropicToResponses(anthropic, { model: 'gpt-5.6-terra' });
const res = await fetch('https://chatgpt.com/backend-api/wham/responses', {
  method: 'POST',
  headers: { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' },
  body: JSON.stringify(body),
});
console.log('WHAM status:', res.status);
if (res.status !== 200) { console.log((await res.text()).slice(0, 400)); process.exit(1); }

const tr = new ResponsesStreamTranslator({ requestedModel: 'claude-opus-5' });
const events = [...tr.push(await res.text()), ...tr.finish()];
const text = events
  .filter((e) => e.event === 'content_block_delta')
  .map((e) => ((e.data['delta'] as { text?: string }).text ?? ''))
  .join('');
const md = events.find((e) => e.event === 'message_delta');
console.log('events:', events.map((e) => e.event).join(','));
console.log('decoded text:', JSON.stringify(text));
console.log('stop_reason:', (md?.data['delta'] as Record<string, unknown>)['stop_reason']);
console.log('usage:', JSON.stringify(md?.data['usage']));
