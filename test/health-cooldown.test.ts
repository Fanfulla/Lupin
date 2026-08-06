// Failover cooldown (SPEC-PROVIDERS §4sexies). Unit level on the tracker,
// integration level through the server against the fake provider.

import { describe, expect, it, beforeEach } from 'vitest';
import { createHealthTracker, FAILOVER_COOLDOWN_THRESHOLD } from '../src/server/health.js';
import { createApp } from '../src/server/ingress.js';
import { validateConfig, type LupinConfig } from '../src/config/config.js';
import { startFakeProvider, type FakeProvider } from './helpers/fake-provider.js';
import { afterAll, beforeAll } from 'vitest';

describe('health tracker (unit, §4sexies)', () => {
  it('starts healthy; a success keeps it healthy', () => {
    const h = createHealthTracker();
    expect(h.status('a')).toBe('healthy');
    h.recordSuccess('a');
    expect(h.status('a')).toBe('healthy');
  });

  it('trips into cooldown after THRESHOLD consecutive failures', () => {
    const h = createHealthTracker({ threshold: 3, cooldownMs: 60_000 });
    h.recordFailure('a', 1000);
    h.recordFailure('a', 1000);
    expect(h.inCooldown('a', 1000)).toBe(false);
    h.recordFailure('a', 1000);
    expect(h.inCooldown('a', 1000)).toBe(true);
    expect(h.cooldownRemainingSec('a', 1000)).toBe(60);
  });

  it('a success clears the counter and the cooldown', () => {
    const h = createHealthTracker({ threshold: 2, cooldownMs: 60_000 });
    h.recordFailure('a', 0);
    h.recordFailure('a', 0);
    expect(h.inCooldown('a', 0)).toBe(true);
    h.recordSuccess('a');
    expect(h.inCooldown('a', 0)).toBe(false);
    expect(h.status('a')).toBe('healthy');
  });

  it('cooldown expires after cooldownMs, then the primary is retried', () => {
    const h = createHealthTracker({ threshold: 1, cooldownMs: 1000 });
    h.recordFailure('a', 5000);
    expect(h.inCooldown('a', 5500)).toBe(true);
    expect(h.inCooldown('a', 6001)).toBe(false);
  });

  it('tracks profiles independently', () => {
    const h = createHealthTracker({ threshold: 1, cooldownMs: 1000 });
    h.recordFailure('a', 0);
    expect(h.inCooldown('a', 0)).toBe(true);
    expect(h.inCooldown('b', 0)).toBe(false);
  });

  it('the exported threshold is the documented 3', () => {
    expect(FAILOVER_COOLDOWN_THRESHOLD).toBe(3);
  });
});

// --- Integration: the cooldown skip end to end ----------------------------

const LOCAL_TOKEN = 'local-secret';
const KEY_ENV = 'LUPIN_COOLDOWN_KEY';

function twoProfileConfig(primaryUrl: string, backupUrl: string): LupinConfig {
  return validateConfig({
    activeProfile: 'main',
    port: 0,
    localToken: LOCAL_TOKEN,
    profiles: {
      main: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: primaryUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
        failover: 'backup',
      },
      backup: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: backupUrl,
        auth: { type: 'bearer', apiKeyRef: KEY_ENV },
        slots: { opus: 'backup-big', sonnet: 'backup-mid', haiku: 'backup-small' },
      },
    },
  });
}

let primary: FakeProvider;
let backup: FakeProvider;
const noopLogger = (): void => undefined;

beforeAll(async () => {
  process.env[KEY_ENV] = 'k';
  primary = await startFakeProvider();
  backup = await startFakeProvider();
});

afterAll(async () => {
  await primary.close();
  await backup.close();
});

beforeEach(() => {
  primary.requests.length = 0;
  backup.requests.length = 0;
});

async function post(app: ReturnType<typeof createApp>): Promise<Response> {
  return await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
    body: JSON.stringify({ model: 'claude-sonnet-9-9', max_tokens: 10, messages: [] }),
  });
}

describe('failover cooldown end to end (§4sexies)', () => {
  it('after THRESHOLD primary failures, requests skip it and go straight to the failover', async () => {
    // Primary always 529s, backup always answers.
    primary.respondWith({ kind: 'json', body: { error: { message: 'busy' } }, status: 500 });
    backup.respondWith({ kind: 'json', body: { id: 'msg_b', type: 'message', role: 'assistant', content: [] } });
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger });

    const primaryHitsBefore = (): number => primary.requests.length;

    // Drive the primary into cooldown: each request tries primary (1 hit) then backup.
    for (let i = 0; i < FAILOVER_COOLDOWN_THRESHOLD; i++) {
      const res = await post(app);
      expect(res.status).toBe(200); // backup served it
    }
    const hitsDuringRamp = primaryHitsBefore();
    expect(hitsDuringRamp).toBe(FAILOVER_COOLDOWN_THRESHOLD);

    // Now in cooldown: the next request must NOT touch the primary at all.
    const res = await post(app);
    expect(res.status).toBe(200);
    expect(primaryHitsBefore()).toBe(hitsDuringRamp); // unchanged: primary skipped
  });

  // Audit 2026-07-22 gap `midstream-failures-invisible-to-health`: recordSuccess
  // fired at response-header time, so a provider that reliably answers 200 and
  // then dies mid-stream (the observed LM Studio mode, ADR-24) reset its own
  // failure counter on every request and could never reach cooldown.
  it('a provider that always 200s then errors mid-stream still trips the cooldown', async () => {
    primary.respondWith({
      kind: 'sse',
      chunks: [
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"engine gave up"}}\n\n',
      ],
    });
    backup.respondWith({ kind: 'json', body: { id: 'msg_b', type: 'message', role: 'assistant', content: [] } });
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger });

    for (let i = 0; i < FAILOVER_COOLDOWN_THRESHOLD; i++) {
      const res = await post(app);
      expect(res.status).toBe(200);
      await res.text(); // consume: the tap only sees what actually streams
    }
    const hitsDuringRamp = primary.requests.length;
    expect(hitsDuringRamp).toBe(FAILOVER_COOLDOWN_THRESHOLD);

    // In cooldown now: the next request must go straight to the failover.
    const res = await post(app);
    expect(res.status).toBe(200);
    await res.text();
    expect(primary.requests.length).toBe(hitsDuringRamp);
  });

  // Issue #1: a stream that stops mid answer is not a success either. Crediting
  // one clears the failure counter of a provider that is dying on every request,
  // which is exactly how it stays out of cooldown forever.
  it('a truncated stream does not clear the failure counter', async () => {
    const fail = { kind: 'json' as const, body: { error: { message: 'busy' } }, status: 500 };
    const truncated = {
      kind: 'sse' as const,
      chunks: ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n'],
    };
    primary.respondOnce(fail);
    primary.respondOnce(fail);
    primary.respondOnce(truncated); // 200, but half an answer: no credit
    primary.respondOnce(fail); // third failure in a row: cooldown
    primary.respondWith({ kind: 'json', body: { id: 'msg_p', type: 'message', role: 'assistant', content: [] } });
    backup.respondWith({ kind: 'json', body: { id: 'msg_b', type: 'message', role: 'assistant', content: [] } });
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger });

    for (let i = 0; i < 4; i++) {
      const res = await post(app);
      await res.text(); // the tap only reports once the body is drained
    }
    expect(primary.requests.length).toBe(4);

    const res = await post(app);
    await res.text();
    expect(primary.requests.length).toBe(4); // in cooldown: the primary is skipped
  });

  it('a clean SSE stream still counts as success and clears the counter', async () => {
    primary.respondWith({
      kind: 'sse',
      chunks: [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ],
    });
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger });
    const res = await post(app);
    expect(res.status).toBe(200);
    await res.text();
    const second = await post(app);
    expect(second.status).toBe(200);
    await second.text();
    expect(primary.requests.length).toBe(2); // never skipped: stream ends clean
  });

  // Audit 2026-07-22 gap `cooldown-blind-spots` (blind spot 1): failures are
  // recorded under the RESOLVED profile (post-delegation), but the skip only
  // checked activeProfile — so with `--bg`-style slot delegation the §4sexies
  // cooldown never fired for exactly the profile that was failing.
  it('a delegated slot in cooldown is skipped, keyed on the resolved profile', async () => {
    const cheap = await startFakeProvider();
    try {
      cheap.respondWith({ kind: 'json', body: { error: { message: 'busy' } }, status: 500 });
      backup.respondWith({ kind: 'json', body: { id: 'msg_b', type: 'message', role: 'assistant', content: [] } });
      const cfg = validateConfig({
        activeProfile: 'main',
        port: 0,
        localToken: LOCAL_TOKEN,
        profiles: {
          main: {
            provider: 'moonshot',
            mode: 'passthrough',
            baseUrl: primary.url,
            auth: { type: 'bearer', apiKeyRef: KEY_ENV },
            slots: { opus: 'model-big', sonnet: 'model-mid', haiku: { profile: 'cheap' } },
            failover: 'backup',
          },
          cheap: {
            provider: 'moonshot',
            mode: 'passthrough',
            baseUrl: cheap.url,
            auth: { type: 'bearer', apiKeyRef: KEY_ENV },
            slots: { opus: 'c-big', sonnet: 'c-mid', haiku: 'c-small' },
          },
          backup: {
            provider: 'moonshot',
            mode: 'passthrough',
            baseUrl: backup.url,
            auth: { type: 'bearer', apiKeyRef: KEY_ENV },
            slots: { opus: 'backup-big', sonnet: 'backup-mid', haiku: 'backup-small' },
          },
        },
      });
      const app = createApp(cfg, { logger: noopLogger });
      const postHaiku = async (): Promise<Response> =>
        await app.request('/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': LOCAL_TOKEN },
          body: JSON.stringify({ model: 'claude-haiku-9-9', max_tokens: 10, messages: [] }),
        });

      for (let i = 0; i < FAILOVER_COOLDOWN_THRESHOLD; i++) {
        const res = await postHaiku();
        expect(res.status).toBe(200); // backup served it
      }
      const hitsDuringRamp = cheap.requests.length;
      expect(hitsDuringRamp).toBe(FAILOVER_COOLDOWN_THRESHOLD);

      // 'cheap' is in cooldown now: the next haiku request must not touch it.
      const res = await postHaiku();
      expect(res.status).toBe(200);
      expect(cheap.requests.length).toBe(hitsDuringRamp);
    } finally {
      await cheap.close();
    }
  });

  // Audit 2026-07-22 `cooldown-blind-spots` blind spot 2: the daemon's hot
  // reload rebuilt the app with a FRESH tracker on every config touch (500ms
  // poll), wiping state ADR-25 only allows resetting on restart. start.ts now
  // creates one tracker and hands it to every createApp; this pins that
  // contract: a rebuilt app sharing the tracker keeps the cooldown.
  it('a config reload (new app, shared tracker) keeps the primary in cooldown', async () => {
    primary.respondWith({ kind: 'json', body: { error: { message: 'busy' } }, status: 500 });
    backup.respondWith({ kind: 'json', body: { id: 'msg_b', type: 'message', role: 'assistant', content: [] } });
    const shared = createHealthTracker();
    const app1 = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger, health: shared });
    for (let i = 0; i < FAILOVER_COOLDOWN_THRESHOLD; i++) {
      expect((await post(app1)).status).toBe(200);
    }
    const hits = primary.requests.length;

    // Reload: config re-validated from disk, brand-new app, same tracker.
    const app2 = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger, health: shared });
    expect((await post(app2)).status).toBe(200);
    expect(primary.requests.length).toBe(hits); // still skipped after reload
  });

  it('without a failover the primary is retried every time (no cooldown bypass)', async () => {
    const cfg = twoProfileConfig(primary.url, backup.url);
    delete cfg.profiles['main']?.failover;
    primary.respondWith({ kind: 'json', body: { error: { message: 'busy' } }, status: 500 });
    const app = createApp(cfg, { logger: noopLogger });

    for (let i = 0; i < FAILOVER_COOLDOWN_THRESHOLD + 2; i++) {
      const res = await post(app);
      expect(res.status).toBe(529); // honest error, primary retried each time
    }
    expect(primary.requests.length).toBe(FAILOVER_COOLDOWN_THRESHOLD + 2);
  });
});

// Audit 2026-07-22 gap `retry-policy-single-hop`: a 429 that says "come back in
// 2s" burned the single failover hop on a flake that had already told us when it
// would pass. §4ter now spends one extra attempt on the SAME profile first, but
// only on a hint short enough to be worth waiting for.
describe('Retry-After honoured before the failover (§4ter)', () => {
  const rateLimited = (retryAfter: string): { kind: 'error'; status: number; body: string; headers: Record<string, string> } => ({
    kind: 'error',
    status: 429,
    body: JSON.stringify({ error: { message: 'slow down' } }),
    headers: { 'retry-after': retryAfter },
  });
  const served = { kind: 'json' as const, body: { id: 'msg_p', type: 'message', role: 'assistant', content: [] } };

  it('waits the hinted delay, retries the same profile, and never touches the failover', async () => {
    primary.respondOnce(rateLimited('1'));
    primary.respondWith(served);
    backup.respondWith(served);
    const waits: number[] = [];
    const lines: import('../src/server/log.js').RequestLogLine[] = [];
    const app = createApp(twoProfileConfig(primary.url, backup.url), {
      logger: (l) => lines.push(l),
      sleep: async (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });

    const res = await post(app);
    expect(res.status).toBe(200);
    expect(waits).toEqual([1000]);
    expect(primary.requests.length).toBe(2); // same profile, twice
    expect(backup.requests.length).toBe(0);
    expect(lines.at(-1)?.retryAfterMs).toBe(1000);
    expect(lines.at(-1)?.failedOver).toBeUndefined();
  });

  it('a delay beyond the cap is not waited on: straight to the failover', async () => {
    primary.respondWith(rateLimited('60'));
    backup.respondWith(served);
    const waits: number[] = [];
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger, sleep: async (ms) => {
      waits.push(ms);
      return Promise.resolve();
    } });

    expect((await post(app)).status).toBe(200);
    expect(waits).toEqual([]);
    expect(primary.requests.length).toBe(1);
    expect(backup.requests.length).toBe(1);
  });

  it('no hint, no wait: the failover keeps its old immediate behaviour', async () => {
    primary.respondWith({ kind: 'error', status: 429, body: JSON.stringify({ error: { message: 'slow down' } }) });
    backup.respondWith(served);
    const waits: number[] = [];
    const app = createApp(twoProfileConfig(primary.url, backup.url), { logger: noopLogger, sleep: async (ms) => {
      waits.push(ms);
      return Promise.resolve();
    } });

    expect((await post(app)).status).toBe(200);
    expect(waits).toEqual([]);
    expect(primary.requests.length).toBe(1);
    expect(backup.requests.length).toBe(1);
  });

  it('still rate-limited after the wait: one failover hop, no cascade', async () => {
    primary.respondWith(rateLimited('2'));
    backup.respondWith(served);
    const app = createApp(twoProfileConfig(primary.url, backup.url), {
      logger: noopLogger,
      sleep: async () => Promise.resolve(),
    });

    expect((await post(app)).status).toBe(200);
    expect(primary.requests.length).toBe(2); // first + one Retry-After retry
    expect(backup.requests.length).toBe(1); // then exactly one failover attempt
  });
});
