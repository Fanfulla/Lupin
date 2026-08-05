// lupin doctor, runner (SPEC-CLI §3): a real headless Claude Code session
// against a DEDICATED Lupin server on an ephemeral port. Zero side effects:
// the user's daemon, active config and workspace are never touched. The test
// workspace is a throwaway temporary directory.

import { serve } from '@hono/node-server';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHead } from '../cli/run.js';
import type { LupinConfig } from '../config/config.js';
import type { RequestLogLine } from '../server/log.js';
import { createApp } from '../server/ingress.js';
import { installKeepAlive, PROVIDER_TIMEOUT_MS } from '../server/dispatcher.js';
import {
  DOCTOR_FILES,
  doctorPrompt,
  classifyCacheControl,
  interpretHeadlessResult,
  preflightContext,
  scoreDoctor,
  type CacheControlProbe,
  type ContextPreflight,
  type DoctorObservations,
  type DoctorReport,
  type HeadlessResult,
} from './plan.js';

/** Aggregates over the ephemeral proxy's log lines (SPEC-CLI §3 metrics). */
export interface DoctorMetrics {
  requests: number;
  avgLatencyMs: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cache receipt (backlog #11a): cache tokens as the provider reported them
   * across the session's requests. Every request after the first re-sends the
   * grown prefix, so a caching provider MUST show reads here if the proxy
   * preserves prefixes. Absent when the provider never reported the fields:
   * "not reported" and "0" are different verdicts.
   */
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Feeds on the same RequestLogLine stream the daemon logs. Second lines
 * (usage/streamError) carry token counts but are not requests; only real model
 * traffic (/v1/messages) counts.
 */
export function createMetricsCollector(): { add: (line: RequestLogLine) => void; snapshot: () => DoctorMetrics } {
  let requests = 0;
  let latencySum = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  return {
    add(line: RequestLogLine): void {
      if (line.path !== '/v1/messages') return;
      if (line.usage !== undefined) {
        inputTokens += line.usage.input;
        outputTokens += line.usage.output;
        if (line.usage.cacheRead !== undefined) cacheReadTokens = (cacheReadTokens ?? 0) + line.usage.cacheRead;
        if (line.usage.cacheCreate !== undefined) {
          cacheCreationTokens = (cacheCreationTokens ?? 0) + line.usage.cacheCreate;
        }
        return;
      }
      if (line.streamError !== undefined) return;
      requests += 1;
      latencySum += line.latencyMs;
    },
    snapshot(): DoctorMetrics {
      return {
        requests,
        avgLatencyMs: requests === 0 ? 0 : Math.round(latencySum / requests),
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      };
    },
  };
}

/**
 * The printable cache receipt, one honest line. Each side (reads, writes) is
 * rendered ONLY from what the provider reported: a session where writes were
 * reported but reads never were must say so, not display a zero the provider
 * never gave (the absent-vs-zero rule of DoctorMetrics, kept at print time).
 * The percentage is the share of served input that came from cache, computable
 * only when reads were reported. Undefined when no cache field ever appeared.
 */
export function cacheReceiptLine(m: DoctorMetrics): string | undefined {
  if (m.cacheReadTokens === undefined && m.cacheCreationTokens === undefined) return undefined;
  const read =
    m.cacheReadTokens !== undefined
      ? `${String(m.cacheReadTokens)} tokens read from cache (${String(cacheReadShare(m))}% of the served input)`
      : 'cache reads never reported by the provider';
  const created =
    m.cacheCreationTokens !== undefined
      ? `${String(m.cacheCreationTokens)} written to cache`
      : 'cache writes never reported';
  return `Cache receipt: ${read}, ${created}`;
}

function cacheReadShare(m: DoctorMetrics): number {
  const read = m.cacheReadTokens ?? 0;
  const served = m.inputTokens + read + (m.cacheCreationTokens ?? 0);
  return served === 0 ? 0 : Math.round((100 * read) / served);
}

export interface DoctorRunResult {
  /**
   * Absent when the run was voided (`notRun`): ADR-23 discarded "score 0 with
   * a side note", and a report here would leak exactly that through --json.
   */
  report?: DoctorReport;
  /** Traffic seen by the ephemeral proxy during the session (SPEC-CLI §3). */
  metrics?: DoctorMetrics;
  profileName: string;
  model: string;
  durationMs: number;
  costUsd?: number;
  sessionError?: string;
  /**
   * Dialect normalizations the session needed (SPEC-TRANSLATION §5bis rule 3).
   * A 10/10 earned with parseTextToolCalls is a different verdict from a plain
   * 10/10, and the score alone cannot tell them apart.
   */
  dialects: string[];
  /** Passthrough only: does the provider accept cache_control (§5ter)? */
  cacheControl?: CacheControlProbe;
  /**
   * Set when the run was refused before spending a token, or when the session
   * died without ever reaching the model. The score is meaningless in that
   * case and the caller must report the cause instead of a verdict.
   */
  notRun?: string;
}

/**
 * How long the whole doctor session may take.
 *
 * It MUST leave room for many turns: the task is 6 steps and Claude Code
 * spends 15-25 requests on it. Sharing the per-request ceiling (600s) meant a
 * single slow answer could eat the entire session, and the report could not
 * tell "the provider hung once" from "the model never got anywhere": the two
 * verdicts this tool exists to separate.
 *
 * Derived from the provider timeout rather than written beside it, so raising
 * one cannot silently invalidate the other. `LUPIN_DOCTOR_TIMEOUT_MS`
 * overrides it for slow local hardware, where a single 46K-token prefill can
 * run for minutes (measured 2026-07-19).
 */
const SESSION_TURN_HEADROOM = 3;

export function sessionTimeoutMs(): number {
  const raw = process.env['LUPIN_DOCTOR_TIMEOUT_MS'];
  if (raw !== undefined) {
    const parsed = Number(raw);
    // A bad value must not silently become "no timeout" or "instant timeout".
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return PROVIDER_TIMEOUT_MS * SESSION_TURN_HEADROOM;
}

/** The session could not be started at all: nothing to score, not even zero. */
class DoctorSetupError extends Error {}

/**
 * Best-effort workspace removal. By the time this runs the score is already
 * computed, so a failure here must never surface: on Windows a killed session
 * can still hold the directory for a moment (observed live 2026-07-19, EBUSY
 * on a timed-out run took the whole report down with a stack trace). One
 * retry covers the handle being released late; after that the OS reaps the
 * temp dir on its own schedule, which is not worth a lost verdict.
 */
export function safeRemove(dir: string, remove: (d: string) => void = hardRemove): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      remove(dir);
      return;
    } catch {
      // fall through to the retry, then give up silently
    }
  }
}

function hardRemove(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/**
 * Kills the whole process tree. `child.kill()` is not enough on Windows: with
 * `shell: true` the direct child is the shell, so claude and its MCP server
 * survived the timeout as orphans still holding the workspace (observed live
 * 2026-07-19).
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { timeout: 10_000 });
    } catch {
      // fall back to the direct kill below
    }
  }
  try {
    child.kill();
  } catch {
    // already gone
  }
}

function tryRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function runNode(cwd: string, file: string): { code: number; stdout: string } | undefined {
  try {
    const r = spawnSync(process.execPath, [file], { cwd, encoding: 'utf8', timeout: 10_000 });
    return { code: r.status ?? 1, stdout: (r.stdout ?? '') + (r.stderr ?? '') };
  } catch {
    return undefined;
  }
}

/** Starts the dedicated server on the first free port and returns server+port. */
function startDoctorServer(
  config: LupinConfig,
  onDialect: (applied: string[]) => void,
  onLine?: (line: RequestLogLine) => void,
): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    // Same outbound transport as the daemon, or the doctor would measure a
    // different stack than the one the user actually runs.
    installKeepAlive();
    const app = createApp(config, {
      logger: (line) => {
        if (line.dialect !== undefined) onDialect(line.dialect);
        onLine?.(line);
      },
    });
    const server = serve({ fetch: (req) => app.fetch(req), port: 0, hostname: '127.0.0.1' }, (info) => {
      resolve({ port: info.port, close: () => server.close() });
    });
  });
}

/**
 * One real request carrying `cache_control`, straight through the proxy
 * (SPEC-TRANSLATION §5ter). Claude Code injects that field on every request, so
 * a provider that rejects it would break the session outright: better to find
 * out here, for one token, than mid-task. Only meaningful in passthrough: in
 * translate the field is dropped before egress by design.
 */
async function probeCacheControl(port: number, token: string): Promise<CacheControlProbe> {
  const body = {
    model: 'claude-sonnet-5',
    max_tokens: 1,
    system: [{ type: 'text', text: 'ping', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'ping' }],
  };
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      // The same ceiling as any other request: a stricter one here would only
      // manufacture timeouts on slow local models and call them refusals.
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    return classifyCacheControl({ status: res.status, body: res.ok ? '' : await res.text() });
  } catch (e) {
    return classifyCacheControl({ networkError: e instanceof Error ? e.message : String(e) });
  }
}

function slotModel(config: LupinConfig, profileName: string): string {
  const slot = config.profiles[profileName]?.slots.sonnet;
  return typeof slot === 'string' ? slot : 'delegato';
}

function mcpFixturePath(): string {
  // repo layout: src/doctor/run.ts -> ../../fixtures/mcp-echo/server.mjs
  return fileURLToPath(new URL('../../fixtures/mcp-echo/server.mjs', import.meta.url));
}

/**
 * Smallest declared window among the models this profile can actually serve.
 * Claude Code drives every slot, so one slot too small is enough to kill a run
 * (observed live: the harness opened on the opus slot, not sonnet).
 */
export function preflightProfile(config: LupinConfig, profileName: string): ContextPreflight {
  return preflightContext(smallestDeclaredWindow(config, profileName));
}

function smallestDeclaredWindow(config: LupinConfig, profileName: string): number | undefined {
  const profile = config.profiles[profileName];
  if (profile?.contextWindows === undefined) return undefined;
  const windows: number[] = [];
  for (const slot of Object.values(profile.slots)) {
    // A delegated slot resolves in another profile: not this preflight's job.
    if (typeof slot !== 'string') continue;
    const w = profile.contextWindows[slot];
    if (w !== undefined) windows.push(w);
  }
  return windows.length === 0 ? undefined : Math.min(...windows);
}

export async function runDoctor(userConfig: LupinConfig, profileName: string): Promise<DoctorRunResult> {
  const doctorConfig: LupinConfig = { ...userConfig, activeProfile: profileName };
  const dialects = new Set<string>();
  const metrics = createMetricsCollector();

  const { port, close } = await startDoctorServer(
    doctorConfig,
    (applied) => {
      for (const q of applied) dialects.add(q);
    },
    metrics.add,
  );

  // Cheaper to learn here than mid-task, and worth learning even when the
  // session cannot run: this is a two-token request with nothing to do with the
  // context window, so a failed preflight must not discard a signal the user
  // would otherwise have to reconfigure the runtime to obtain. It is also the
  // only part of the doctor that needs no credentials on a local provider.
  const cacheControl =
    doctorConfig.profiles[profileName]?.mode === 'passthrough'
      ? await probeCacheControl(port, doctorConfig.localToken)
      : undefined;

  // The config already knows the window, so a doomed run must not be dressed
  // up as a score (M4: verdict explained).
  const preflight = preflightProfile(doctorConfig, profileName);
  if (!preflight.ok) {
    close();
    // No report on purpose (ADR-23): a notRun run has no score to serialize.
    return {
      profileName,
      model: slotModel(doctorConfig, profileName),
      durationMs: 0,
      dialects: [],
      ...(cacheControl !== undefined ? { cacheControl } : {}),
      notRun: preflight.detail,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'lupin-doctor-'));
  for (const [name, content] of Object.entries(DOCTOR_FILES)) writeFileSync(join(dir, name), content);
  const mcpConfigPath = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfigPath,
    JSON.stringify({ mcpServers: { lupin_doctor: { command: process.execPath, args: [mcpFixturePath()] } } }),
  );

  const started = Date.now();
  let sessionCompleted = false;
  let resultText = '';
  let costUsd: number | undefined;
  let sessionError: string | undefined;
  // A session that never reached the model has no verdict to give: the score
  // would measure the transport, not the model.
  let notRun: string | undefined;

  try {
    const out = await runHeadlessClaude(dir, port, doctorConfig.localToken, mcpConfigPath);
    if (out.parseError !== undefined) {
      sessionError = out.parseError;
      notRun = out.parseError;
    } else {
      sessionCompleted = out.ok;
      resultText = out.resultText;
      costUsd = out.costUsd;
      if (out.failure !== undefined) {
        sessionError = `${out.failure}: ${out.resultText.slice(0, 300)}`;
        // Only a transport death voids the verdict: a model too weak to finish
        // is itself a result, and keeps its score.
        if (out.neverRan === true) notRun = sessionError;
      }
    }
  } catch (e) {
    sessionError = e instanceof Error ? e.message : String(e);
    // A session that could never START has nothing to measure. A session that
    // started and ran out of time is a different story: the artifacts on disk
    // are real evidence, and a model too slow to finish IS a verdict on the
    // harness. Voiding the score there would throw away what it earned.
    if (e instanceof DoctorSetupError) notRun = sessionError;
  }

  const obs: DoctorObservations = {
    sessionCompleted,
    resultText,
    ...(tryRead(join(dir, 'found.txt')) !== undefined ? { foundTxt: tryRead(join(dir, 'found.txt')) } : {}),
    ...(tryRead(join(dir, 'greet.js')) !== undefined ? { greetJs: tryRead(join(dir, 'greet.js')) } : {}),
    ...(tryRead(join(dir, 'counter.js')) !== undefined ? { counterJs: tryRead(join(dir, 'counter.js')) } : {}),
    ...(tryRead(join(dir, 'echo.txt')) !== undefined ? { echoTxt: tryRead(join(dir, 'echo.txt')) } : {}),
  };
  const greetRun = runNode(dir, 'greet.js');
  if (greetRun !== undefined) obs.greetRun = greetRun;
  const brokenRun = runNode(dir, 'broken.js');
  if (brokenRun !== undefined) obs.brokenRun = brokenRun;

  const report = scoreDoctor(obs);
  // Evidence beats classification: if the run left real artifacts on disk, the
  // model did work, whatever the transcript said about how the session ended.
  // Voiding the verdict there would discard exactly what the doctor measures.
  if (notRun !== undefined && report.score > 0) notRun = undefined;
  const model = slotModel(doctorConfig, profileName);

  close();
  safeRemove(dir);

  const m = metrics.snapshot();
  return {
    // Mutually exclusive by construction (ADR-23): a voided run has no score,
    // not a zero: and --json serializes exactly what is here.
    ...(notRun !== undefined ? { notRun } : { report }),
    ...(m.requests > 0 ? { metrics: m } : {}),
    profileName,
    model,
    durationMs: Date.now() - started,
    dialects: [...dialects],
    ...(cacheControl !== undefined ? { cacheControl } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(sessionError !== undefined ? { sessionError } : {}),
  };
}

interface HeadlessOutput extends HeadlessResult {
  parseError?: string;
}

function runHeadlessClaude(
  cwd: string,
  port: number,
  localToken: string,
  mcpConfigPath: string,
): Promise<HeadlessOutput> {
  return new Promise((resolve, reject) => {
    // The prompt travels via STDIN: multiline as an argument + a shell on
    // Windows = mangled quoting (mutilated instructions, lost flags).
    // Observed live on the first real run, 2026-07-19. The spawn goes through
    // resolveHead (ADR-29): no shell at all for a real claude.exe, and on the
    // one path cmd.exe still carries (.cmd shims) the mcp config path is
    // quoted, so a tmpdir with spaces survives the trip.
    const resolved = resolveHead('claude');
    const args = [
      '-p',
      '--output-format',
      'json',
      '--mcp-config',
      resolved.viaShell ? `"${mcpConfigPath}"` : mcpConfigPath,
      '--allowedTools',
      'Read,Edit,Write,Bash,mcp__lupin_doctor__echo_test',
      '--max-turns',
      '40',
    ];
    const child = spawn(resolved.viaShell ? `"${resolved.command}"` : resolved.command, args, {
      cwd,
      shell: resolved.viaShell,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
        ANTHROPIC_AUTH_TOKEN: localToken,
        ANTHROPIC_API_KEY: '',
      },
    });
    child.stdin.write(doctorPrompt());
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const budgetMs = sessionTimeoutMs();
    const timer = setTimeout(() => {
      killTree(child);
      reject(
        new Error(
          `doctor session past its timeout (${String(Math.round(budgetMs / 1000))}s; ` +
            'raise it with LUPIN_DOCTOR_TIMEOUT_MS if the model is slow but still working)',
        ),
      );
    }, budgetMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new DoctorSetupError(`cannot launch claude: ${e.message}`));
    });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        resolve(interpretHeadlessResult(parsed));
      } catch {
        resolve({
          ok: false,
          resultText: '',
          parseError: `non-JSON output: ${(stdout + stderr).slice(0, 300)}`,
        });
      }
    });
  });
}
