// Capture the tool-RESULT round trip: feed a prior function_call plus its
// output back in `input` and see whether WHAM accepts the shape.
import { writeFileSync } from 'node:fs';
import { getOAuthTokens } from '../src/config/credentials.js';
const t = getOAuthTokens('openai');
if (!t) { console.error('no openai token'); process.exit(1); }
const auth = { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' };
const body = {
  model: 'gpt-5.6-terra',
  instructions: 'You are a terse assistant.',
  input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Rome? Use the tool.' }] },
    { type: 'function_call', call_id: 'call_TEST123', name: 'get_weather', arguments: '{"city":"Rome"}' },
    { type: 'function_call_output', call_id: 'call_TEST123', output: '{"temp_c":21,"sky":"clear"}' },
  ],
  tools: [{ type: 'function', name: 'get_weather', description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false } }],
  store: false, stream: true,
};
const res = await fetch('https://chatgpt.com/backend-api/wham/responses', { method: 'POST', headers: auth, body: JSON.stringify(body) });
console.log('status', res.status);
const txt = await res.text();
if (res.status !== 200) { console.log(txt.slice(0, 500)); process.exit(1); }
writeFileSync('test/helpers/captures/wham-stream-toolresult.sse', txt);
console.log('captured', txt.length, 'bytes');
for (const l of txt.split('\n')) if (l.includes('output_text.delta')) console.log(l.slice(0, 200));
