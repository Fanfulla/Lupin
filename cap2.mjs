import { writeFileSync } from 'node:fs';
const body = {
  model: 'google/gemma-4-12b-qat', max_tokens: 250, stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: 'user', content: 'Think step by step: what is 17 * 23? Reply with just the number.' }],
};
const res = await fetch('http://127.0.0.1:1234/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const text = await res.text();
writeFileSync('test/helpers/captures/lmstudio-gemma4-reasoning.sse', text);
const frames = text.split('\n\n').filter((f) => f.startsWith('data:'));
const keys = new Set();
for (const f of frames) { const p = f.slice(5).trim(); if (p === '[DONE]') continue; const d = JSON.parse(p).choices?.[0]?.delta ?? {}; for (const k of Object.keys(d)) keys.add(k); }
console.log('frames:', frames.length, '| delta keys:', [...keys].join(', '));
