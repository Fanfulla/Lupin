// M6a: capture a REAL WHAM Responses API stream to a fixture file (API output,
// no secrets). Used to build the translator fixture-first (CLAUDE.md rule 3).
import { writeFileSync } from 'node:fs';
import { getOAuthTokens } from '../src/config/credentials.js';
const t = getOAuthTokens('openai');
if (!t) { console.error('no openai token'); process.exit(1); }
const auth = { authorization: `Bearer ${t.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' };
const body = {
  model: 'gpt-5.6-terra',
  instructions: 'You are a terse assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say the word ok and nothing else.' }] }],
  store: false, stream: true,
};
const res = await fetch('https://chatgpt.com/backend-api/wham/responses', { method: 'POST', headers: auth, body: JSON.stringify(body) });
if (res.status !== 200) { console.error('status', res.status, await res.text()); process.exit(1); }
const txt = await res.text();
writeFileSync('test/helpers/captures/wham-stream-simple.sse', txt);
console.log('captured', txt.length, 'bytes to test/helpers/captures/wham-stream-simple.sse');
