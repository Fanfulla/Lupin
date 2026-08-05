// M6b: capture REAL Google Code Assist SSE streams to fixture files (API output,
// no secrets). The translator is built from these, fixture-first (CLAUDE.md
// rule 3). The free tier rate-limits hard, so every call retries on 429.
//
// Run: node --import tsx scripts/codeassist-capture.mts
import { writeFileSync } from 'node:fs';
import { findOAuthProvider } from '../src/providers/oauth.js';
import { resolveOAuthAccessToken } from '../src/server/oauth.js';

const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const MODEL = 'gemini-2.5-flash'; // served on the free tier; pro answers 429 there
const PROMPT_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';

const def = findOAuthProvider('gemini');
if (def === undefined) {
  console.error('no gemini OAuth descriptor');
  process.exit(1);
}
const token = await resolveOAuthAccessToken(def);
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

const load = await fetch(`${BASE}:loadCodeAssist`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
  }),
});
const project = ((await load.json()) as { cloudaicompanionProject?: string }).cloudaicompanionProject;
if (project === undefined) {
  console.error('this account is not onboarded: no cloudaicompanionProject. Run :onboardUser first.');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function capture(file: string, request: unknown): Promise<void> {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(`${BASE}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { ...auth, accept: 'text/event-stream', 'user-agent': 'lupin/0.1.0' },
      body: JSON.stringify({ model: MODEL, project, user_prompt_id: PROMPT_ID, request }),
    });
    const txt = await res.text();
    if (res.status === 200) {
      writeFileSync(`test/helpers/captures/${file}`, txt);
      console.log(`captured ${String(txt.length)} bytes to test/helpers/captures/${file}`);
      return;
    }
    if (res.status !== 429) {
      console.error(`${file}: status ${String(res.status)} ${txt.slice(0, 300)}`);
      process.exit(1);
    }
    console.log(`${file}: 429, retry ${String(attempt)}/6 in 30s`);
    await sleep(30_000);
  }
  console.error(`${file}: still rate limited after 6 attempts`);
  process.exit(1);
}

const WEATHER_TOOL = {
  functionDeclarations: [
    {
      name: 'get_weather',
      description: 'Get the current weather for a city',
      parameters: {
        type: 'OBJECT',
        properties: { city: { type: 'STRING', description: 'City name' } },
        required: ['city'],
      },
    },
  ],
};

// 1. plain text, long enough to arrive in several chunks
await capture('codeassist-stream-simple.sse', {
  contents: [{ role: 'user', parts: [{ text: 'Count from one to five in words, one per line.' }] }],
  systemInstruction: { parts: [{ text: 'You are a terse assistant.' }] },
  session_id: SESSION_ID,
});

// 2. a tool call
await capture('codeassist-stream-toolcall.sse', {
  contents: [{ role: 'user', parts: [{ text: 'What is the weather in Rome? Use the tool.' }] }],
  tools: [WEATHER_TOOL],
  session_id: SESSION_ID,
});

// 3. the tool result fed back: model must answer from functionResponse
await capture('codeassist-stream-toolresult.sse', {
  contents: [
    { role: 'user', parts: [{ text: 'What is the weather in Rome? Use the tool.' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }] },
    {
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { temperature: '31C', sky: 'clear' } } }],
    },
  ],
  tools: [WEATHER_TOOL],
  session_id: SESSION_ID,
});
