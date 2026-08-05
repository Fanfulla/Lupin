// `lupin doctor --submit` (SPEC-CLI §3.3): the submission is a pre-filled
// GitHub issue URL, built locally. These tests pin what travels and, above
// all, what must never travel.

import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../src/config/config.js';
import type { DoctorRunResult } from '../src/doctor/run.js';
import { submissionBody, submissionTitle, submissionUrl, type SubmissionInput } from '../src/doctor/submit.js';

const profile: ProfileConfig = {
  provider: 'moonshot',
  mode: 'passthrough',
  baseUrl: 'https://private-gateway.internal.example/anthropic',
  auth: { type: 'bearer', apiKeyRef: 'MOONSHOT_API_KEY' },
  slots: { opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k2.6' },
  quirks: ['clientErrorsWrappedIn500'],
};

function input(overrides: Partial<DoctorRunResult> = {}): SubmissionInput {
  const result: DoctorRunResult = {
    profileName: 'kimi',
    model: 'kimi-k3',
    durationMs: 92_000,
    dialects: [],
    report: {
      score: 9,
      max: 10,
      passed: true,
      checks: [
        { id: 1, name: 'file created', points: 2, max: 2, detail: 'ok' },
        { id: 2, name: 'edit applied', points: 1, max: 2, detail: 'rewritten\non two lines | with a pipe' },
      ],
    },
    metrics: { requests: 21, avgLatencyMs: 1800, inputTokens: 51_000, outputTokens: 3200, cacheReadTokens: 40_000 },
    ...overrides,
  };
  return { result, profile, profileName: 'kimi', version: '0.1.0', runtime: 'win32, node v24.4.0', date: '2026-07-24' };
}

describe('submissionBody: what travels', () => {
  it('carries provider, model, mode, auth type, score and per-check breakdown', () => {
    const body = submissionBody(input());
    expect(body).toContain('`moonshot`');
    expect(body).toContain('`kimi-k3`');
    expect(body).toContain('passthrough');
    expect(body).toContain('**9/10**');
    expect(body).toContain('| 1 | file created | 2/2 | ok |');
  });

  it('carries the measured metrics and the cache receipt', () => {
    const body = submissionBody(input());
    expect(body).toContain('Requests: 21');
    expect(body).toContain('average latency 1800ms');
    expect(body).toMatch(/cache/i);
  });

  it('says when the score was helped by a dialect repair', () => {
    const body = submissionBody(input({ dialects: ['parseTextToolCalls'] }));
    expect(body).toContain('parseTextToolCalls');
  });

  it('reports a voided run as its cause, never as a score', () => {
    const body = submissionBody(input({ report: undefined, notRun: 'context window too small' }));
    expect(body).toContain('Doctor did NOT run: context window too small');
    expect(body).not.toContain('**0/');
  });

  it('keeps multi-line details inside their table cell', () => {
    const body = submissionBody(input());
    const row = body.split('\n').find((l) => l.startsWith('| 2 |'));
    expect(row).toBe('| 2 | edit applied | 1/2 | rewritten on two lines \\| with a pipe |');
  });
});

describe('submissionBody: what must never travel', () => {
  it('never carries the credential reference, the key env name or the baseUrl', () => {
    const body = submissionBody(input());
    expect(body).not.toContain('MOONSHOT_API_KEY');
    expect(body).not.toContain('private-gateway.internal.example');
  });

  it('stays bounded so the URL cannot be rejected for length', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      name: `check ${String(i)}`,
      points: 1,
      max: 1,
      detail: 'x'.repeat(200),
    }));
    const body = submissionBody(input({ report: { score: 1, max: 1, passed: true, checks: many } }));
    expect(body.length).toBeLessThanOrEqual(6100);
    expect(body.endsWith('<!-- truncated -->')).toBe(true);
  });
});

describe('submissionUrl', () => {
  it('targets the repo issue form with the compat label and template', () => {
    const url = new URL(submissionUrl(input(), 'https://github.com/acme/repo'));
    expect(url.origin + url.pathname).toBe('https://github.com/acme/repo/issues/new');
    expect(url.searchParams.get('template')).toBe('provider-report.md');
    expect(url.searchParams.get('labels')).toBe('provider-compat');
    expect(url.searchParams.get('title')).toBe(submissionTitle(input()));
    expect(url.searchParams.get('body')).toBe(submissionBody(input()));
  });

  it('titles the issue by provider and model', () => {
    expect(submissionTitle(input())).toBe('[compat] moonshot / kimi-k3');
  });
});
