// `lupin usage` (backlog #14): the aggregate must agree with the doctor's
// collector on what counts as a request, and must keep the absent-vs-zero rule
// the whole project rests on.

import { describe, expect, it } from 'vitest';
import { aggregateUsage, parseLogLines, type RequestLogLine } from '../src/server/log.js';
import { cacheShare, humanTokens, renderUsage } from '../src/cli/usage.js';

function requestLine(over: Partial<RequestLogLine> = {}): RequestLogLine {
  return {
    ts: '2026-07-24T10:00:00.000Z',
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

describe('aggregateUsage', () => {
  it('counts requests from request lines and tokens from usage lines', () => {
    const [bucket] = aggregateUsage([
      requestLine(),
      requestLine({ usage: { input: 100, output: 20 } }),
      requestLine(),
      requestLine({ usage: { input: 50, output: 10 } }),
    ]);
    expect(bucket).toEqual({ profile: 'kimi', model: 'kimi-k3', requests: 2, input: 150, output: 30 });
  });

  it('ignores anything that is not model traffic', () => {
    expect(
      aggregateUsage([
        requestLine({ path: '/v1/messages/count_tokens' }),
        requestLine({ path: '/health' }),
        requestLine({ streamError: 'overloaded_error' }),
      ]),
    ).toEqual([{ profile: 'kimi', model: 'kimi-k3', requests: 0 }]);
  });

  it('splits per profile and model, heaviest first', () => {
    const buckets = aggregateUsage([
      requestLine({ profile: 'kimi', model: 'kimi-k3', usage: { input: 10, output: 1 } }),
      requestLine({ profile: 'glm', model: 'glm-5.2', usage: { input: 900, output: 90 } }),
      requestLine({ profile: 'kimi', model: 'kimi-k2.6', usage: { input: 5, output: 1 } }),
    ]);
    expect(buckets.map((b) => `${b.profile}/${b.model}`)).toEqual(['glm/glm-5.2', 'kimi/kimi-k3', 'kimi/kimi-k2.6']);
  });

  // The rule the whole cache story rests on: a field the provider never
  // reported must stay absent, never surface as a zero.
  it('keeps cache fields absent when no line reported them', () => {
    const [bucket] = aggregateUsage([requestLine({ usage: { input: 10, output: 2 } })]);
    expect(bucket).not.toHaveProperty('cacheRead');
    expect(bucket).not.toHaveProperty('cacheCreate');
  });

  it('sums cache fields per field, so one reported side does not invent the other', () => {
    const [bucket] = aggregateUsage([
      requestLine({ usage: { input: 10, output: 2, cacheRead: 400 } }),
      requestLine({ usage: { input: 10, output: 2, cacheRead: 600 } }),
    ]);
    expect(bucket?.cacheRead).toBe(1000);
    expect(bucket).not.toHaveProperty('cacheCreate');
  });

  // Found on the real log (2026-07-25): it predates the usage tap, so it has
  // requests and no counts. Printing 0 there would read as "this profile spent
  // nothing" instead of "nobody measured".
  it('leaves the token counts absent when no usage line exists at all', () => {
    const [bucket] = aggregateUsage([requestLine(), requestLine()]);
    expect(bucket?.requests).toBe(2);
    expect(bucket).not.toHaveProperty('input');
    expect(bucket).not.toHaveProperty('output');
    expect(renderUsage([bucket as never])).not.toMatch(/\s0\s/);
  });

  it('filters by timestamp when a window is given', () => {
    const since = Date.parse('2026-07-24T00:00:00.000Z');
    const buckets = aggregateUsage(
      [
        requestLine({ ts: '2026-07-20T10:00:00.000Z', usage: { input: 999, output: 1 } }),
        requestLine({ ts: '2026-07-24T10:00:00.000Z', usage: { input: 10, output: 1 } }),
      ],
      since,
    );
    expect(buckets[0]?.input).toBe(10);
  });
});

describe('parseLogLines', () => {
  it('keeps our lines and survives foreign or truncated ones', () => {
    const text = [
      JSON.stringify(requestLine()),
      '{"ts":"2026-07-24T10:00:01.000Z","source":"watchdog","event":"fallback-bound"}',
      '{"truncated":',
      '',
      JSON.stringify(requestLine({ usage: { input: 1, output: 1 } })),
    ].join('\n');
    const lines = parseLogLines(text);
    expect(lines.length).toBe(2);
    expect(lines.every((l) => l.path === '/v1/messages')).toBe(true);
  });
});

describe('rendering', () => {
  it('formats tokens compactly', () => {
    expect(humanTokens(999)).toBe('999');
    expect(humanTokens(1500)).toBe('1.5k');
    expect(humanTokens(1_200_000)).toBe('1.2M');
  });

  it('reports the cache share only when reads were reported', () => {
    expect(cacheShare({ profile: 'p', model: 'm', requests: 1, input: 250, output: 10, cacheRead: 750 })).toBe(75);
    expect(cacheShare({ profile: 'p', model: 'm', requests: 1, input: 250, output: 10 })).toBeUndefined();
  });

  it('prints a dash, never a zero, for a field the provider never reported', () => {
    const out = renderUsage([{ profile: 'kimi', model: 'kimi-k3', requests: 3, input: 1000, output: 100 }]);
    expect(out).toContain('kimi-k3');
    expect(out).toMatch(/-\s*$/m);
    expect(out).not.toMatch(/\b0%/);
  });
});
