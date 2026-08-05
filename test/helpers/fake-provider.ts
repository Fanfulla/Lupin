import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Fake provider per TESTING.md §3: lets CI exercise what real providers
// won't reproduce on demand (errors, SSE chunk splits, disconnections).

export interface CapturedRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export type FakeResponse =
  | { kind: 'json'; status?: number; body: unknown }
  | { kind: 'sse'; chunks: string[]; delayMs?: number }
  | { kind: 'error'; status: number; body: string; headers?: Record<string, string> };

export interface FakeProvider {
  url: string;
  requests: CapturedRequest[];
  respondWith(res: FakeResponse): void;
  /** One-shot responses consumed before the sticky respondWith one (for retry tests). */
  respondOnce(res: FakeResponse): void;
  close(): Promise<void>;
}

export async function startFakeProvider(): Promise<FakeProvider> {
  let nextResponse: FakeResponse = { kind: 'json', body: { ok: true } };
  const onceQueue: FakeResponse[] = [];
  const requests: CapturedRequest[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        // keep raw string
      }
      requests.push({ path: req.url ?? '', headers: req.headers, body });

      const r = onceQueue.shift() ?? nextResponse;
      if (r.kind === 'json') {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      } else if (r.kind === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (r.delayMs === undefined) {
          for (const chunk of r.chunks) res.write(chunk);
          res.end();
        } else {
          // slow provider simulation: one chunk per tick, for keep-alive ping tests
          const delayMs = r.delayMs;
          void (async () => {
            for (const chunk of r.chunks) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              res.write(chunk);
            }
            res.end();
          })();
        }
      } else {
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.headers ?? {}) });
        res.end(r.body);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    respondWith: (r) => {
      nextResponse = r;
    },
    respondOnce: (r) => {
      onceQueue.push(r);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
