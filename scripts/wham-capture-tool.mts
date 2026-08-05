import { writeFileSync } from 'node:fs';
import { getOAuthTokens } from '../src/config/credentials.js';
const t = getOAuthTokens('openai');
if (!t) { console.error('no openai token'); process.exit(1); }
const auth = { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' };
const body = {
  model: 'gpt-5.6-terra',
  instructions: 'You are a terse assistant. Always use the tool when asked for the weather.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What is the weather in Rome? Use the tool.' }] }],
  tools: [{
    type: 'function',
    name: 'get_weather',
    description: 'Get the weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  }],
  store: false, stream: true,
};
const res = await fetch('https://chatgpt.com/backend-api/wham/responses', { method: 'POST', headers: auth, body: JSON.stringify(body) });
if (res.status !== 200) { console.error('status', res.status, await res.text()); process.exit(1); }
const txt = await res.text();
writeFileSync('test/helpers/captures/wham-stream-toolcall.sse', txt);
console.log('captured', txt.length, 'bytes');
// Print the tool-call events only
for (const line of txt.split('\n')) {
  if (line.includes('function_call') || line.includes('output_item')) console.log(line.slice(0, 300));
}
