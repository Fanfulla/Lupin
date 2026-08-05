// Does a passthrough target accept Anthropic-signed thinking blocks in
// replayed history? (DESIGN-HANDOFF §3.1)
//
// The scenario-B handoff replays a native Claude Code transcript to a
// third-party provider through `claude --continue`. On the passthrough lane
// the history travels byte for byte, so the provider receives thinking blocks
// whose `signature` only Anthropic could have produced. Every public report
// tests the opposite direction (foreign history INTO Anthropic, which 400s);
// this measures OUR direction, live, through the real ingress.
//
// Steps: (0) one tiny request to learn whether the subscription quota cycle
// is live at all; (A) a replayed history with a REAL signed thinking block,
// taken at runtime from a local native transcript (never committed, never
// printed, only its lengths); (B) the same history with the thinking block
// dropped (what the translate-family lanes do by design); (C) only if A
// fails: the same block with the signature removed, to tell "the field" from
// "the block type" apart.
//
// Run: node --import tsx scripts/handoff-replay-probe.mts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';

const config: LupinConfig = {
  activeProfile: 'sub',
  port: 0,
  localToken: 'probe-token',
  profiles: {
    sub: {
      provider: 'kimicode',
      mode: 'passthrough',
      auth: { type: 'oauth' },
      slots: { opus: 'k3', sonnet: 'k3', haiku: 'kimi-for-coding' },
    },
  },
};

const app = createApp(config);

interface Outcome {
  status: number;
  excerpt: string;
}

async function ask(body: Record<string, unknown>): Promise<Outcome> {
  const res = await app.request(
    new Request('http://127.0.0.1/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'probe-token' },
      body: JSON.stringify(body),
    }),
  );
  const raw = await res.text();
  return { status: res.status, excerpt: raw.slice(0, 300) };
}

// 0) Is the quota cycle live? One tiny request on the model the handoff
// would actually use (the opus slot: Claude Code opens sessions there).
console.log('step 0: quota ping on the opus slot (k3)');
const ping = await ask({
  model: 'claude-opus-5',
  max_tokens: 16,
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
});
console.log(`  status ${String(ping.status)}: ${ping.excerpt.replace(/\s+/g, ' ').slice(0, 160)}`);
if (ping.status !== 200) {
  console.error('\nThe quota cycle is not live (or the lane failed): the probe cannot measure.');
  console.error('Re-run when the ping answers 200.');
  process.exit(1);
}

// A REAL signed thinking block, extracted at runtime from the most recent
// native transcript of this cwd. Signatures cannot be invented (a made-up one
// would measure nothing), and nothing of the block is printed or persisted.
// Measured on this corpus 2026-07-31: EVERY native block (1422 across
// claude-fable-5/opus-4-8/opus-5) stores an EMPTY thinking text next to a
// full signature (omitted-display), so that pair IS what a replay sends.
interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

function findNativeThinkingBlock(): ThinkingBlock | undefined {
  const key = process.cwd().replaceAll('\\', '-').replaceAll(':', '-');
  const dir = join(homedir(), '.claude', 'projects', key);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"thinking"') || !line.includes('"signature"')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const p = parsed as {
        message?: { model?: string; content?: { type?: string; thinking?: string; signature?: string }[] };
      };
      if (typeof p.message?.model !== 'string' || !p.message.model.startsWith('claude-')) continue;
      const block = p.message.content?.find((b) => b.type === 'thinking');
      if (typeof block?.thinking === 'string' && typeof block.signature === 'string' && block.signature.length > 100) {
        return { type: 'thinking', thinking: block.thinking, signature: block.signature };
      }
    }
  }
  return undefined;
}

const real = findNativeThinkingBlock();
if (real === undefined) {
  console.error('no native signed thinking block found in the local transcripts of this cwd');
  process.exit(1);
}
console.log(
  `\nusing a real native thinking block: thinking ${String(real.thinking.length)} chars, signature ${String(real.signature.length)} chars`,
);

/** The same replayed history; only the assistant thinking block varies. */
function replay(thinking: ThinkingBlock | undefined): Record<string, unknown> {
  const content: Record<string, unknown>[] = [];
  if (thinking !== undefined) content.push({ ...thinking });
  content.push({ type: 'text', text: 'Understood. I will keep answers short.' });
  return {
    model: 'claude-opus-5',
    max_tokens: 32,
    messages: [
      { role: 'user', content: 'Please keep your answers short in this conversation.' },
      { role: 'assistant', content },
      { role: 'user', content: 'Reply with exactly: OK' },
    ],
  };
}

console.log('\nvariant A: signed thinking block replayed INTACT (what passthrough does today)');
const a = await ask(replay(real));
console.log(`  status ${String(a.status)}: ${a.excerpt.replace(/\s+/g, ' ').slice(0, 200)}`);

console.log('\nvariant B: thinking block DROPPED (what the translate-family lanes do)');
const b = await ask(replay(undefined));
console.log(`  status ${String(b.status)}: ${b.excerpt.replace(/\s+/g, ' ').slice(0, 200)}`);

let c: Outcome | undefined;
if (a.status !== 200) {
  console.log('\nvariant C (diagnosis): thinking kept, signature REMOVED');
  c = await ask(replay({ ...real, signature: '' }));
  console.log(`  status ${String(c.status)}: ${c.excerpt.replace(/\s+/g, ' ').slice(0, 200)}`);
}

console.log('\n--- verdict ---');
console.log(`A (intact):  ${String(a.status)}`);
console.log(`B (dropped): ${String(b.status)}`);
if (c !== undefined) console.log(`C (no sig):  ${String(c.status)}`);
if (a.status === 200 && b.status === 200) {
  console.log('The provider accepts foreign-signed thinking in history: no quirk needed (DESIGN-HANDOFF §3.3 stays unbuilt).');
} else if (a.status !== 200 && b.status === 200) {
  console.log('The provider rejects the replayed thinking block: the stripHistoryThinking quirk is needed.');
} else {
  console.log('Unexpected shape: record both bodies in DESIGN-HANDOFF before concluding anything.');
}
