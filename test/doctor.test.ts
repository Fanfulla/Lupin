import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cacheReceiptLine, createMetricsCollector, runDoctor, safeRemove, sessionTimeoutMs } from '../src/doctor/run.js';
import { validateConfig } from '../src/config/config.js';
import { PROVIDER_TIMEOUT_MS } from '../src/server/dispatcher.js';
import {
  DOCTOR_FILES,
  DOCTOR_MIN_CONTEXT,
  classifyCacheControl,
  MAGIC_TOKEN,
  doctorPrompt,
  interpretHeadlessResult,
  preflightContext,
  scoreDoctor,
  type DoctorObservations,
} from '../src/doctor/plan.js';

const capture = JSON.parse(
  readFileSync(new URL('./helpers/captures/lmstudio-context-overflow.json', import.meta.url), 'utf8'),
) as { claudeCodeResult: Record<string, unknown> };

function perfectRun(): DoctorObservations {
  return {
    sessionCompleted: true,
    resultText: 'FATTO',
    foundTxt: `${MAGIC_TOKEN}\n`,
    greetJs: 'function greet(name) {\n  return "Ciao, " + name + "!";\n}\nconsole.log(greet("world"));\n',
    greetRun: { code: 0, stdout: 'Ciao, world!\n' },
    counterJs: 'const START = 10;\nconst STEP = 5;\n',
    echoTxt: 'echo:doctor-ping\n',
    brokenRun: { code: 0, stdout: 'A\nB\nC\n' },
  };
}

describe('lupin doctor scoring (SPEC-CLI §3)', () => {
  it('perfect run scores 10/10 and passes', () => {
    const r = scoreDoctor(perfectRun());
    expect(r.score).toBe(10);
    expect(r.max).toBe(10);
    expect(r.passed).toBe(true);
  });

  it('Edit failure costs 3 points, the killer check', () => {
    const obs = perfectRun();
    obs.greetJs = DOCTOR_FILES['greet.js'];
    obs.greetRun = { code: 0, stdout: 'Hello, world!\n' };
    const r = scoreDoctor(obs);
    expect(r.score).toBe(7);
    expect(r.checks[2]?.points).toBe(0);
    expect(r.passed).toBe(true); // 7 = threshold
  });

  it('modified but broken greet.js earns partial credit only', () => {
    const obs = perfectRun();
    obs.greetJs = 'function greet(name) {\n  return "Ciao, " + name + !;\n}\n'; // syntax error
    obs.greetRun = { code: 1, stdout: 'SyntaxError' };
    const r = scoreDoctor(obs);
    expect(r.checks[2]?.points).toBe(1);
  });

  it('sequential edit half-done earns 1 of 2', () => {
    const obs = perfectRun();
    obs.counterJs = 'const START = 10;\nconst STEP = 1;\n';
    expect(scoreDoctor(obs).checks[3]?.points).toBe(1);
  });

  it('MCP tool never called → 0 of 2, score under threshold with Edit also failing', () => {
    const obs = perfectRun();
    obs.echoTxt = undefined as unknown as string;
    delete (obs as Partial<DoctorObservations>).echoTxt;
    obs.greetJs = DOCTOR_FILES['greet.js'];
    obs.greetRun = { code: 0, stdout: 'Hello, world!\n' };
    const r = scoreDoctor(obs);
    expect(r.score).toBe(5);
    expect(r.passed).toBe(false);
  });

  it('session that never completed still scores artifacts honestly', () => {
    const obs = perfectRun();
    obs.sessionCompleted = false;
    obs.resultText = '';
    const r = scoreDoctor(obs);
    expect(r.checks[0]?.points).toBe(0);
    expect(r.score).toBe(9);
  });

  it('workspace files and prompt stay aligned on the magic token and tool name', () => {
    expect(DOCTOR_FILES['notes.txt']).toContain(MAGIC_TOKEN);
    expect(doctorPrompt()).toContain('mcp__lupin_doctor__echo_test');
    expect(doctorPrompt()).toContain('broken.js');
  });
});

// Regression: the first live run against LM Studio scored a session in which
// EVERY request failed as "sessione completata" (1/10 read as a model verdict).
// Claude Code says subtype "success" when its own loop ended cleanly; only
// is_error and terminal_reason say whether the task ever ran.
describe('headless session result, honestly read', () => {
  it('a session killed by api errors is not a completed session', () => {
    const r = interpretHeadlessResult(capture.claudeCodeResult);
    expect(r.ok).toBe(false);
    expect(r.failure).toContain('api_error');
  });

  it('subtype success with is_error still fails, whatever the result text says', () => {
    const r = interpretHeadlessResult({ subtype: 'success', is_error: true, result: 'FATTO' });
    expect(r.ok).toBe(false);
  });

  it('a genuine success stays a success and keeps text and cost', () => {
    const r = interpretHeadlessResult({ subtype: 'success', is_error: false, result: 'FATTO', total_cost_usd: 0.01 });
    expect(r.ok).toBe(true);
    expect(r.resultText).toBe('FATTO');
    expect(r.costUsd).toBe(0.01);
    expect(r.failure).toBeUndefined();
  });

  it('a non-success subtype fails and reports the subtype', () => {
    const r = interpretHeadlessResult({ subtype: 'error_max_turns', result: 'giro a vuoto' });
    expect(r.ok).toBe(false);
    expect(r.failure).toContain('error_max_turns');
  });

  // The recorded capture happened to carry is_error alongside terminal_reason,
  // so reading subtype first survived it by luck. terminal_reason alone already
  // says the session died on the transport, and it decides on its own: without
  // this, ADR-23 walks back in through a line that claims success everywhere
  // except in the one field that states the outcome.
  it('a transport terminal_reason voids the run even when nothing else complains', () => {
    const r = interpretHeadlessResult({
      subtype: 'success',
      is_error: false,
      terminal_reason: 'api_error',
      result: '',
    });
    expect(r.ok).toBe(false);
    expect(r.neverRan).toBe(true);
    expect(r.failure).toContain('api_error');
  });
});

// The profile already carries the window; running a doomed session and calling
// the result a model score is the dishonest part (M4: "verdetto spiegato").
describe('context window preflight', () => {
  it('refuses a window that cannot hold the harness, naming both numbers', () => {
    const r = preflightContext(8192);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('8192');
    expect(r.detail).toContain(String(DOCTOR_MIN_CONTEXT));
  });

  it('accepts a window at the floor and above', () => {
    expect(preflightContext(DOCTOR_MIN_CONTEXT).ok).toBe(true);
    expect(preflightContext(65_536).ok).toBe(true);
  });

  it('an unknown window is not a refusal: silence is not a small window', () => {
    expect(preflightContext(undefined).ok).toBe(true);
  });

  it('the floor is above the 46075 tokens measured live, with room for output', () => {
    expect(DOCTOR_MIN_CONTEXT).toBeGreaterThan(46_075);
  });
});

// Regression: on the first timed-out run the workspace cleanup threw EBUSY
// (Windows, the killed session still held the directory) and took the whole
// report down with it — an unhandled stack trace instead of the verdict. The
// scoring is already done by then: cleanup must never be able to lose it.
describe('workspace cleanup never loses the report', () => {
  it('removes a normal workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lupin-cleanup-'));
    writeFileSync(join(dir, 'a.txt'), 'x');
    safeRemove(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('swallows a removal that keeps failing, as EBUSY did', () => {
    let calls = 0;
    const alwaysBusy = (): never => {
      calls++;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    expect(() => safeRemove('/whatever', alwaysBusy)).not.toThrow();
    expect(calls).toBe(2); // one retry: the handle is often released a moment later
  });

  it('a removal that succeeds on the retry is not retried further', () => {
    let calls = 0;
    const busyOnce = (): void => {
      calls++;
      if (calls === 1) throw new Error('EBUSY');
    };
    safeRemove('/whatever', busyOnce);
    expect(calls).toBe(2);
  });

  it('a path that does not exist is not an error', () => {
    expect(() => safeRemove(join(tmpdir(), 'lupin-cleanup-does-not-exist-12345'))).not.toThrow();
  });
});

// "Did not answer" is not "refused". The probe used to report accepted:false
// on a network timeout, i.e. accuse the provider of rejecting cache_control
// when it had simply been slow — guaranteed on local models — and to report
// accepted:true on a 5xx it described in the same breath as inconclusive.
describe('cache_control probe verdict', () => {
  it('a 200 means the provider really took the field', () => {
    expect(classifyCacheControl({ status: 200, body: '' }).outcome).toBe('accepted');
  });

  it('a 4xx is the provider refusing it, and keeps the reason', () => {
    const r = classifyCacheControl({ status: 400, body: 'unknown field cache_control' });
    expect(r.outcome).toBe('rejected');
    expect(r.detail).toContain('cache_control');
  });

  it('a 5xx proves nothing either way', () => {
    expect(classifyCacheControl({ status: 500, body: 'boom' }).outcome).toBe('inconclusive');
  });

  it('a timeout proves nothing either way, and never reads as refusal', () => {
    const r = classifyCacheControl({ networkError: 'headers timeout' });
    expect(r.outcome).toBe('inconclusive');
    expect(r.outcome).not.toBe('rejected');
  });
});

// The session has to hold 15-25 requests. When its budget equalled the
// per-request ceiling, one slow answer could consume the whole run, and the
// report could not separate "the provider hung once" from "the model never got
// anywhere" — the two verdicts this tool exists to tell apart.
describe('doctor session budget', () => {
  const KEY = 'LUPIN_DOCTOR_TIMEOUT_MS';
  afterEach(() => {
    delete process.env[KEY];
  });

  it('leaves room for many turns beyond a single slow request', () => {
    expect(sessionTimeoutMs()).toBeGreaterThan(PROVIDER_TIMEOUT_MS);
  });

  it('an explicit override wins, for slow local hardware', () => {
    process.env[KEY] = '5400000';
    expect(sessionTimeoutMs()).toBe(5_400_000);
  });

  it('a nonsense override falls back instead of disabling the timeout', () => {
    for (const bad of ['0', '-1', 'soon', '']) {
      process.env[KEY] = bad;
      expect(sessionTimeoutMs(), `override "${bad}"`).toBeGreaterThan(PROVIDER_TIMEOUT_MS);
    }
  });
});

// Audit 2026-07-22 gap `doctor-metrics-and-json-leak` (verdict: missing).
// (a) ADR-23 discarded "score 0 with a side note", yet --json serialized
// report.score=0 on notRun runs — a CI consumer read exactly the fake score
// the human renderer refuses to print.
describe('notRun replaces the score everywhere (ADR-23)', () => {
  it('a preflight-refused run carries NO report: --json cannot leak a score', async () => {
    const config = validateConfig({
      activeProfile: 'local',
      port: 0,
      localToken: 't',
      profiles: {
        local: {
          provider: 'openai',
          mode: 'translate',
          baseUrl: 'http://127.0.0.1:9', // never contacted: the preflight refuses first
          auth: { type: 'bearer', apiKeyRef: 'LUPIN_DOCTOR_TEST_KEY' },
          slots: { opus: 'm-big', sonnet: 'm-mid', haiku: 'm-small' },
          contextWindows: { 'm-big': 8192, 'm-mid': 8192, 'm-small': 8192 },
        },
      },
    });
    const result = await runDoctor(config, 'local');
    expect(result.notRun).toBeDefined();
    expect('report' in result).toBe(false);
    expect(JSON.stringify(result)).not.toContain('"score"');
  });
});

// (b) SPEC-CLI §3 promises average latency and token counts; the proxy tap
// already produces both on its log lines, the doctor just never read them.
describe('doctor metrics from the proxy tap (SPEC-CLI §3)', () => {
  const base = { ts: 't', profile: 'p', requestedModel: 'r', model: 'm', mode: 'passthrough' };

  it('aggregates request count, average latency and token totals from log lines', () => {
    const m = createMetricsCollector();
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 100 });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 300 });
    // second lines (usage / streamError) must not inflate the request count
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 999, usage: { input: 40, output: 2 } });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 999, usage: { input: 10, output: 5 } });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 50, streamError: 'overloaded_error' });
    // non-model traffic is not a doctor metric
    m.add({ ...base, path: '/health', status: 200, latencyMs: 1 });
    expect(m.snapshot()).toEqual({ requests: 2, avgLatencyMs: 200, inputTokens: 50, outputTokens: 7 });
  });

  it('no traffic yields an all-zero snapshot', () => {
    expect(createMetricsCollector().snapshot()).toEqual({
      requests: 0,
      avgLatencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  // Cache receipt (backlog #11a, MARKET §2.1a): prove the proxy preserves the
  // provider cache instead of claiming it. Read/creation totals come from the
  // same usage lines; "never reported" must stay distinguishable from "0".
  it('accumulates cache read/creation tokens into the receipt', () => {
    const m = createMetricsCollector();
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 100 });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 1, usage: { input: 900, output: 1, cacheRead: 0, cacheCreate: 45_000 } });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 100 });
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 1, usage: { input: 50, output: 20, cacheRead: 45_000 } });
    expect(m.snapshot()).toEqual({
      requests: 2,
      avgLatencyMs: 100,
      inputTokens: 950,
      outputTokens: 21,
      cacheReadTokens: 45_000,
      cacheCreationTokens: 45_000,
    });
  });

  it('a provider that never reports cache fields leaves the receipt absent, not zero', () => {
    const m = createMetricsCollector();
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 1, usage: { input: 10, output: 5 } });
    const snap = m.snapshot();
    expect('cacheReadTokens' in snap).toBe(false);
    expect('cacheCreationTokens' in snap).toBe(false);
  });

  it('a reported zero IS a receipt: field present at 0', () => {
    const m = createMetricsCollector();
    m.add({ ...base, path: '/v1/messages', status: 200, latencyMs: 1, usage: { input: 10, output: 5, cacheRead: 0 } });
    expect(m.snapshot().cacheReadTokens).toBe(0);
  });
});

// The printed receipt must keep the absent-vs-zero rule per FIELD: a session
// where writes were reported but reads never were must not display "0 letti"
// (finding of the 2026-07-24 adversarial review).
describe('cacheReceiptLine (doctor cache receipt, print side)', () => {
  const metrics = { requests: 2, avgLatencyMs: 100, inputTokens: 1000, outputTokens: 50 };

  it('no cache field ever reported: no receipt line at all', () => {
    expect(cacheReceiptLine(metrics)).toBeUndefined();
  });

  it('both sides reported: counts plus the share of served input', () => {
    const line = cacheReceiptLine({ ...metrics, cacheReadTokens: 8000, cacheCreationTokens: 1000 });
    expect(line).toBe(
      'Cache receipt: 8000 tokens read from cache (80% of the served input), 1000 written to cache',
    );
  });

  it('writes reported but reads never: says so instead of printing a zero', () => {
    const line = cacheReceiptLine({ ...metrics, cacheCreationTokens: 45_000 });
    expect(line).toContain('cache reads never reported by the provider');
    expect(line).toContain('45000 written to cache');
    expect(line).not.toContain('0 tokens read');
  });

  it('reads reported but writes never: the missing side stays honest too', () => {
    const line = cacheReceiptLine({ ...metrics, cacheReadTokens: 0 });
    expect(line).toContain('0 tokens read from cache (0% of the served input)');
    expect(line).toContain('cache writes never reported');
  });
});
