// Does dropping Google's `thoughtSignature` cost anything?
//
// Google returns an opaque signature next to a part, and gemini-cli sends it
// back in the history. Lupin drops it, because Anthropic has no block for it
// and nothing can carry it through Claude Code. The doctor's 75 agentic
// requests never showed a problem, but that is indirect evidence, so this
// measures it directly: the SAME three-turn tool conversation, once without
// the signature (what Lupin does today) and once with it reattached.
//
// The free tier rate-limits to roughly one call a minute, so every call backs
// off on 429 exactly like scripts/codeassist-capture.mts.
//
// Run: node --import tsx scripts/codeassist-signature-probe.mts
import { findOAuthProvider } from '../src/providers/oauth.js';
import { resolveOAuthAccessToken } from '../src/server/oauth.js';

const BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const MODEL = 'gemini-2.5-flash';
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
  console.error('this account is not onboarded: no cloudaicompanionProject');
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Reply {
  status: number;
  text: string;
  functionCall?: { name?: string; args?: unknown };
  signature?: string;
  error?: string;
}

async function ask(label: string, request: Record<string, unknown>): Promise<Reply> {
  for (let attempt = 1; attempt <= 8; attempt++) {
    const res = await fetch(`${BASE}:generateContent`, {
      method: 'POST',
      headers: { ...auth, 'user-agent': 'lupin/0.1.0' },
      body: JSON.stringify({ model: MODEL, project, user_prompt_id: PROMPT_ID, request }),
    });
    const raw = await res.text();
    if (res.status === 429) {
      console.log(`  ${label}: 429, retry ${String(attempt)}/8 in 35s`);
      await sleep(35_000);
      continue;
    }
    if (res.status !== 200) return { status: res.status, text: '', error: raw.slice(0, 300) };
    const body = JSON.parse(raw) as {
      response?: { candidates?: { content?: { parts?: Record<string, unknown>[] } }[] };
    };
    const parts = body.response?.candidates?.[0]?.content?.parts ?? [];
    return {
      status: 200,
      text: parts.map((p) => (typeof p['text'] === 'string' ? p['text'] : '')).join(''),
      ...(parts.find((p) => p['functionCall'] !== undefined) !== undefined
        ? { functionCall: parts.find((p) => p['functionCall'] !== undefined)?.['functionCall'] as { name?: string } }
        : {}),
      ...(typeof parts[0]?.['thoughtSignature'] === 'string'
        ? { signature: parts[0]['thoughtSignature'] }
        : {}),
    };
  }
  return { status: 429, text: '', error: 'still rate limited after 8 tries' };
}

const TOOL = {
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

// Turn 1: let the model decide to call the tool, and keep whatever signature
// it attaches. This is the only way to obtain a REAL signature: they cannot be
// invented, and a made-up one would measure nothing.
console.log('turn 1: provoking a real tool call, to capture its signature');
const first = await ask('turn1', {
  contents: [{ role: 'user', parts: [{ text: 'What is the weather in Rome? Use the tool.' }] }],
  tools: [TOOL],
  session_id: SESSION_ID,
});
console.log(`  status ${String(first.status)}, tool=${first.functionCall?.name ?? '(none)'}, signature=${first.signature === undefined ? 'ABSENT' : `${String(first.signature.length)} chars`}`);
if (first.status !== 200 || first.functionCall === undefined) {
  console.error('  no tool call to work from: cannot measure. Re-run when the tier allows it.');
  process.exit(1);
}

/** The same history both ways: the only difference is the signature on the model turn. */
function history(withSignature: boolean): Record<string, unknown> {
  const callPart: Record<string, unknown> = { functionCall: first.functionCall };
  if (withSignature && first.signature !== undefined) callPart['thoughtSignature'] = first.signature;
  return {
    contents: [
      { role: 'user', parts: [{ text: 'What is the weather in Rome? Use the tool.' }] },
      { role: 'model', parts: [callPart] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'get_weather', response: { temperature: '31C', sky: 'clear' } } }],
      },
      { role: 'user', parts: [{ text: 'Now call the tool again for Milan.' }] },
    ],
    tools: [TOOL],
    session_id: SESSION_ID,
  };
}

console.log('\nturn 2, WITHOUT the signature (what Lupin does today)');
const without = await ask('without', history(false));
console.log(`  status ${String(without.status)}${without.error === undefined ? '' : ` error=${without.error}`}`);
console.log(`  next tool call: ${without.functionCall === undefined ? '(none)' : JSON.stringify(without.functionCall)}`);
console.log(`  text: ${JSON.stringify(without.text.slice(0, 120))}`);

console.log('\nturn 2, WITH the signature reattached (what gemini-cli does)');
const withSig = await ask('with', history(true));
console.log(`  status ${String(withSig.status)}${withSig.error === undefined ? '' : ` error=${withSig.error}`}`);
console.log(`  next tool call: ${withSig.functionCall === undefined ? '(none)' : JSON.stringify(withSig.functionCall)}`);
console.log(`  text: ${JSON.stringify(withSig.text.slice(0, 120))}`);

console.log('\n--- verdict ---');
console.log(`same HTTP status:        ${String(without.status === withSig.status)}`);
console.log(`both continued the tool: ${String((without.functionCall !== undefined) === (withSig.functionCall !== undefined))}`);
console.log(
  'If both lines say true, dropping the signature costs nothing measurable and the drop stays.',
);
