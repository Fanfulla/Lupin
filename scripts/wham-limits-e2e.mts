// The knobs WHAM refuses, enforced by the proxy, against the LIVE API.
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';
const config: LupinConfig = {
  activeProfile: 'sub', port: 0, localToken: 'l',
  profiles: { sub: { provider: 'openaisub', mode: 'responses',
    auth: { type: 'oauth', provider: 'openai' },
    slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.4-mini' } } },
};
const app = createApp(config);
const ask = async (label: string, body: Record<string, unknown>): Promise<void> => {
  const res = await app.request(new Request('http://127.0.0.1/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'l' },
    body: JSON.stringify({ model: 'claude-opus-5', ...body }),
  }));
  const m = await res.json() as Record<string, unknown>;
  const text = (m['content'] as Record<string, unknown>[] | undefined)?.map((b) => b['text']).join('') ?? '';
  console.log(`${label}\n  stop_reason=${String(m['stop_reason'])} stop_sequence=${JSON.stringify(m['stop_sequence'])}`);
  console.log(`  text=${JSON.stringify(text.slice(0, 90))}`);
};

await ask('A) max_tokens 5 on a long request', {
  max_tokens: 5, messages: [{ role: 'user', content: 'Count slowly from 1 to 40, comma separated.' }] });
await ask('B) no limit, same request', {
  max_tokens: 4000, messages: [{ role: 'user', content: 'Count slowly from 1 to 12, comma separated.' }] });
await ask('C) stop_sequence at "5"', {
  max_tokens: 4000, stop_sequences: ['5'], messages: [{ role: 'user', content: 'Count from 1 to 9, comma separated. Digits only.' }] });
