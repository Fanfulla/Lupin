import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
// undici's own fetch, not Node's built-in: only this one honours `dispatcher`.
import { Agent, fetch as undiciFetch, getGlobalDispatcher } from 'undici';
import {
  DISPATCHER_OPTIONS,
  installKeepAlive,
  KEEP_ALIVE_MS,
  PROVIDER_TIMEOUT_MS,
} from '../src/server/dispatcher.js';

describe('outbound dispatcher', () => {
  it('installs a pooled agent and stays idempotent', () => {
    const before = getGlobalDispatcher();
    installKeepAlive();
    const after = getGlobalDispatcher();
    expect(after).not.toBe(before);
    installKeepAlive();
    expect(getGlobalDispatcher()).toBe(after);
  });

  it('keeps connections alive well past a user think-pause', () => {
    // The point of the change: Node's 4s default expires between turns.
    expect(KEEP_ALIVE_MS).toBeGreaterThan(4_000);
  });

  // Regression: undici defaults headersTimeout and bodyTimeout to 300s, which
  // silently halved the 600s the proxy advertises. A slow provider then failed
  // as a network error, which the ingress maps to a retryable 529 — so the
  // expensive request was paid for twice.
  it('lets the provider take the full advertised timeout, not undici default', () => {
    expect(DISPATCHER_OPTIONS.headersTimeout).toBe(PROVIDER_TIMEOUT_MS);
    expect(DISPATCHER_OPTIONS.bodyTimeout).toBe(PROVIDER_TIMEOUT_MS);
    expect(PROVIDER_TIMEOUT_MS).toBeGreaterThan(300_000); // undici's default
  });
});

// Proves the option really governs the behaviour above, rather than trusting
// that it does: same slow server, two agents, opposite outcomes.
describe('headersTimeout actually controls how long a slow provider may take', () => {
  // Above undici's FastTimer granularity (~1s): a sub-second headersTimeout
  // rounds up to the next tick and would make this test lie.
  const HEADER_DELAY_MS = 3_000;
  const server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, HEADER_DELAY_MS);
  });
  const listening = new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  afterAll(() => {
    server.close();
  });

  it('a headersTimeout below the delay kills the request', async () => {
    const port = await listening;
    const agent = new Agent({ headersTimeout: 1_000 });
    // fetch reports every transport failure as a bare "fetch failed"; the
    // actual reason, and the thing worth pinning, lives on the cause.
    const err = await undiciFetch(`http://127.0.0.1:${String(port)}/`, { dispatcher: agent }).then(
      () => undefined,
      (e: { cause?: { code?: string } }) => e,
    );
    expect(err?.cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');
    await agent.close();
  }, 15_000);

  it('a headersTimeout above the delay lets it through', async () => {
    const port = await listening;
    const agent = new Agent({ headersTimeout: HEADER_DELAY_MS * 10 });
    const res = await undiciFetch(`http://127.0.0.1:${String(port)}/`, { dispatcher: agent });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    await agent.close();
  });
});
