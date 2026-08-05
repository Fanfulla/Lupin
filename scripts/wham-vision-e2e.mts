// A real vision request through the whole proxy, with a PNG built here so it
// is guaranteed valid (a hand-typed base64 is not).
import { deflateSync } from 'node:zlib';
import { createApp } from '../src/server/ingress.js';
import type { LupinConfig } from '../src/config/config.js';

function crc32(buf: Buffer): number {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]!) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A solid-colour WxH RGB PNG. */
function png(w: number, h: number, rgb: [number, number, number]): string {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolour RGB
  const raw = Buffer.concat(Array.from({ length: h }, () =>
    Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from(rgb)))])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const config: LupinConfig = {
  activeProfile: 'sub', port: 0, localToken: 'v',
  profiles: { sub: { provider: 'openaisub', mode: 'responses',
    auth: { type: 'oauth', provider: 'openai' },
    slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.4-mini' } } },
};
const app = createApp(config);
const data = png(64, 64, [220, 20, 20]); // solid red
const res = await app.request(new Request('http://127.0.0.1/v1/messages', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'v' },
  body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 60, messages: [{ role: 'user', content: [
    { type: 'text', text: 'What single colour fills this image? One word.' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
  ] }] }),
}));
console.log('status', res.status);
const msg = await res.json() as Record<string, unknown>;
console.log('answer:', JSON.stringify((msg['content'] as Record<string, unknown>[])?.map(b => b['text']).join('')));
