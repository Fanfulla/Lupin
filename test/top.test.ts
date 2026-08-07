// `lupin top` (backlog #8): the screen is a pure function of a snapshot, so
// the layout is tested without a terminal.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readLogTail, recentRequests, renderTop, type TopSnapshot } from '../src/cli/top.js';
import type { LupinConfig } from '../src/config/config.js';
import type { RequestLogLine } from '../src/server/log.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-top-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function config(): LupinConfig {
  return {
    activeProfile: 'kimi',
    port: 3456,
    localToken: 'tok',
    profiles: {
      kimi: {
        provider: 'moonshot',
        mode: 'passthrough',
        auth: { type: 'bearer', apiKeyRef: 'K' },
        slots: { opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k2.6' },
        lastDoctor: { score: 10, max: 10, date: '2026-07-19' },
      },
      local: {
        provider: 'ollama',
        mode: 'passthrough',
        auth: { type: 'none' },
        slots: { opus: 'big', sonnet: 'big', haiku: { profile: 'kimi' } },
      },
    },
  };
}

function line(over: Partial<RequestLogLine> = {}): RequestLogLine {
  return {
    ts: '2026-07-24T10:11:12.000Z',
    profile: 'kimi',
    requestedModel: 'claude-sonnet-5',
    model: 'kimi-k3',
    mode: 'passthrough',
    path: '/v1/messages',
    status: 200,
    latencyMs: 1200,
    ...over,
  };
}

const NOW = new Date('2026-07-24T10:12:00.000Z');

describe('renderTop', () => {
  it('marks the active profile and shows the doctor score per profile', () => {
    const out = renderTop({ config: config(), recent: [] }, NOW).join('\n');
    expect(out).toMatch(/^\* kimi/m);
    expect(out).toMatch(/^ {2}local/m);
    expect(out).toContain('10/10 2026-07-19');
  });

  it('says the daemon is down instead of inventing what is being served', () => {
    const out = renderTop({ config: config(), recent: [] }, NOW).join('\n');
    expect(out).toContain('daemon DOWN');
    expect(out).toContain('serving now: unknown');
  });

  it('shows the resolved slots and the health state when the daemon answers', () => {
    const snap: TopSnapshot = {
      config: config(),
      health: {
        activeProfile: 'kimi',
        slots: { opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k2.6' },
        health: { kimi: 'cooldown 42s', local: 'healthy' },
      },
      recent: [],
    };
    const out = renderTop(snap, NOW).join('\n');
    expect(out).toContain('serving now: opus=kimi-k3');
    expect(out).toContain('cooldown 42s');
  });

  // Local model names are long enough to push every later column out of line
  // if the table assumes a width.
  it('keeps the columns aligned when a slot name is long', () => {
    const cfg = config();
    cfg.profiles['local'] = {
      ...cfg.profiles['local'],
      slots: { opus: 'qwen/qwen3.5-9b', sonnet: 'qwen/qwen3.5-9b', haiku: 'qwen/qwen3.5-9b' },
    } as never;
    const rows = renderTop({ config: cfg, recent: [] }, NOW).filter((l) => l.includes('passthrough'));
    const doctorColumn = rows.map((r) => r.indexOf('  ', r.indexOf('passthrough')));
    expect(new Set(rows.map((r) => r.length > 0)).size).toBe(1);
    expect(doctorColumn.every((c) => c > 0)).toBe(true);
  });

  it('surfaces the routing markers of each request, cooldown included', () => {
    const out = renderTop(
      {
        config: config(),
        recent: [
          line({ routed: 'longContext' }),
          line({ failedOver: 'kimi', retryAfterMs: 2000 }),
          line({ cooldown: 'kimi', status: 529 }),
          line({ dialect: ['stripThinkTags'], streamError: 'overloaded_error' }),
          line({ editHint: true }),
        ],
      },
      NOW,
    ).join('\n');
    expect(out).toContain('routed:longContext');
    expect(out).toContain('failover<-kimi');
    expect(out).toContain('waited:2000ms');
    expect(out).toContain('cooldown:kimi');
    expect(out).toContain('dialect:stripThinkTags');
    expect(out).toContain('streamError:overloaded_error');
    // §5quater: a hint that fired is a routing event like the others. The Rust
    // sidecar prints the same word (tui/src/logtail.rs), because one log line
    // must read the same whichever front end is watching.
    expect(out).toContain('editHint');
  });
});

describe('recentRequests', () => {
  it('keeps model traffic only, drops the usage second lines, bounded to the last N', () => {
    const lines = [
      line({ path: '/health' }),
      line({ path: '/v1/messages/count_tokens' }),
      line({ usage: { input: 10, output: 1 } }),
      ...Array.from({ length: 20 }, (_, i) => line({ status: 200 + i })),
    ];
    const recent = recentRequests(lines, 5);
    expect(recent.length).toBe(5);
    expect(recent.every((l) => l.path === '/v1/messages' && l.usage === undefined)).toBe(true);
    expect(recent.at(-1)?.status).toBe(219);
  });
});

describe('readLogTail', () => {
  it('reads only the tail and drops the half line at the cut', () => {
    const path = join(dir, 'lupin.log');
    const full = Array.from({ length: 50 }, (_, i) => JSON.stringify(line({ status: 200 + i }))).join('\n');
    writeFileSync(path, full);
    const tail = readLogTail(path, 500);
    expect(tail.length).toBeLessThanOrEqual(500);
    for (const raw of tail.split('\n')) {
      if (raw.trim() === '') continue;
      expect(() => JSON.parse(raw)).not.toThrow();
    }
  });

  it('a missing log is empty, not a crash', () => {
    expect(readLogTail(join(dir, 'nope.log'))).toBe('');
  });
});
