// Daemon lifecycle (SPEC-CLI §1): detached server process, pidfile in
// ~/.lupin/, stale-pidfile recovery, health polling. CLI commands orchestrate
// these helpers; the server itself lives in start.ts.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, validateConfig, type LupinConfig } from '../config/config.js';

type DaemonIdentity = Pick<LupinConfig, 'port' | 'localToken'>;
type DaemonResult = 'already-running' | 'started';
type ReadinessProbe = (port: number) => Promise<boolean>;

export interface BootstrapDaemonDeps {
  serverAlive: ReadinessProbe;
  identityAlive: (identity: DaemonIdentity) => Promise<boolean>;
  startDaemon: (port: number, serverEnv: Record<string, string>, readiness: ReadinessProbe) => Promise<DaemonResult>;
  ensureWatchdog: (port: number) => unknown;
}

export interface DaemonConfigLifecycle {
  current: () => LupinConfig;
  conflict: () => string | undefined;
  awaitingPersistedConfig: () => boolean;
  adopt: (config: LupinConfig) => void;
}

export function createDaemonConfigLifecycle(initial: {
  config: LupinConfig;
  bootstrap: boolean;
}): DaemonConfigLifecycle {
  let current = initial.config;
  let conflict: string | undefined;
  let awaitingPersistedConfig = initial.bootstrap;
  const bound = initial.bootstrap ? { port: current.port, localToken: current.localToken } : undefined;
  return {
    current: () => current,
    conflict: () => conflict,
    awaitingPersistedConfig: () => awaitingPersistedConfig,
    adopt: (config) => {
      if (conflict !== undefined) throw new Error(conflict);
      if (bound !== undefined && (config.port !== bound.port || config.localToken !== bound.localToken)) {
        awaitingPersistedConfig = false;
        conflict = `persisted config identity conflicts with bootstrap listener on port ${String(bound.port)}`;
        throw new Error(conflict);
      }
      current = config;
      awaitingPersistedConfig = false;
    },
  };
}

export function observeBootstrapConfigBeforeReload(
  startObservation: () => void,
  reload: () => void,
): void {
  startObservation();
  reload();
}

export async function fetchWithDaemonConfigLifecycle(
  request: Request,
  lifecycle: DaemonConfigLifecycle,
  fetchApp: (request: Request) => Response | Promise<Response>,
  reconcile?: () => void,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  let reconciliationError: string | undefined;
  if (path === '/v1/lupin/providers' && lifecycle.awaitingPersistedConfig() && reconcile !== undefined) {
    try {
      reconcile();
    } catch (e) {
      reconciliationError = e instanceof Error ? e.message : String(e);
    }
  }
  const failure = lifecycle.conflict() ?? reconciliationError;
  if (failure !== undefined && path !== '/health') {
    return new Response(JSON.stringify({ ok: false, error: failure }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  }
  return await fetchApp(request);
}

export function bootstrapDaemonEnv(identity: DaemonIdentity): Record<string, string> {
  return {
    LUPIN_BOOTSTRAP_PORT: String(identity.port),
    LUPIN_BOOTSTRAP_TOKEN: identity.localToken,
  };
}

export function initialDaemonConfig(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
  load: (path: string) => LupinConfig = loadConfig,
): { config: LupinConfig; bootstrap: boolean } {
  const port = env.LUPIN_BOOTSTRAP_PORT;
  const localToken = env.LUPIN_BOOTSTRAP_TOKEN;
  if (port === undefined && localToken === undefined) return { config: load(configPath), bootstrap: false };
  return {
    bootstrap: true,
    config: validateConfig({
      activeProfile: '',
      port: Number(port),
      localToken: localToken ?? '',
      profiles: {},
    }),
  };
}

export function lupinDir(): string {
  return process.env.LUPIN_DIR ?? join(homedir(), '.lupin');
}

/**
 * Dev runs from src/*.ts and needs the tsx loader; an installed dist runs the
 * compiled .js straight in node (tsx is a devDependency and does not exist
 * there). The module's own extension is the truth about which world this is:
 * no env flag to forget, no path to hardcode (packaging blocker, audit §7.2).
 */
export function entrypointArgs(moduleUrl: string, relEntryTs: string): string[] {
  const isTs = moduleUrl.endsWith('.ts');
  const rel = isTs ? relEntryTs : relEntryTs.replace(/\.ts$/, '.js');
  const entry = fileURLToPath(new URL(rel, moduleUrl));
  return isTs ? ['--import', 'tsx', entry] : [entry];
}

export function pidfilePath(): string {
  return join(lupinDir(), 'lupin.pid');
}

export function watchdogPidfilePath(): string {
  return join(lupinDir(), 'watchdog.pid');
}

export function logfilePath(): string {
  return join(lupinDir(), 'lupin.log');
}

export async function serverAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

export function readPidfile(): number | undefined {
  if (!existsSync(pidfilePath())) return undefined;
  const pid = Number(readFileSync(pidfilePath(), 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the server detached if not already answering. Returns how it ended up alive. */
export async function ensureDaemon(port: number): Promise<'already-running' | 'started'> {
  return await ensureDaemonWith(port);
}

export async function serverHasIdentity(identity: DaemonIdentity): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(identity.port)}/v1/lupin/providers`, {
      headers: { authorization: `Bearer ${identity.localToken}` },
      signal: AbortSignal.timeout(1000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureBootstrapDaemon(identity: DaemonIdentity): Promise<'already-running' | 'started'> {
  return await ensureBootstrapDaemonWith(identity, {
    serverAlive,
    identityAlive: serverHasIdentity,
    startDaemon: async (port, serverEnv, readiness) =>
      await ensureDaemonWith(port, serverEnv, readiness, serverAlive),
    ensureWatchdog,
  });
}

export async function ensureBootstrapDaemonWith(
  identity: DaemonIdentity,
  deps: BootstrapDaemonDeps,
): Promise<DaemonResult> {
  if (await deps.serverAlive(identity.port)) {
    if (!(await deps.identityAlive(identity))) throw daemonIdentityConflict(identity.port);
    deps.ensureWatchdog(identity.port);
    return 'already-running';
  }
  return await deps.startDaemon(
    identity.port,
    bootstrapDaemonEnv(identity),
    async () => await deps.identityAlive(identity),
  );
}

async function ensureDaemonWith(
  port: number,
  serverEnv?: Record<string, string>,
  readiness: ReadinessProbe = serverAlive,
  occupied: ReadinessProbe = readiness,
): Promise<DaemonResult> {
  if (await readiness(port)) {
    // §6.4 respawn gap (audit 2026-07-22): a watchdog that died while the
    // daemon lived was never replaced: every run verifies it, not just the
    // one that started the daemon.
    ensureWatchdog(port);
    return 'already-running';
  }
  if (occupied !== readiness && (await occupied(port))) throw daemonIdentityConflict(port);

  const stale = readPidfile();
  if (stale !== undefined && !pidRunning(stale)) rmSync(pidfilePath(), { force: true }); // SPEC-CLI §6.4

  mkdirSync(lupinDir(), { recursive: true, mode: 0o700 });
  const pkgRoot = fileURLToPath(new URL('../..', import.meta.url)); // dev: resolves tsx from our node_modules
  const out = openSync(logfilePath(), 'a');
  const child = spawn(process.execPath, entrypointArgs(import.meta.url, './start.ts'), {
    cwd: pkgRoot,
    detached: true,
    stdio: ['ignore', out, out],
    ...(serverEnv === undefined ? {} : { env: { ...process.env, ...serverEnv } }),
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(pidfilePath(), String(child.pid));

  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await readiness(port)) {
      ensureWatchdog(port); // §6.4: cover a mid-session kill from now on
      return 'started';
    }
    if (occupied !== readiness && (await occupied(port))) throw daemonIdentityConflict(port);
  }
  throw new Error(`server did not come up on port ${String(port)}: check ${logfilePath()}`);
}

function daemonIdentityConflict(port: number): Error {
  return new Error(`different daemon is already running on port ${String(port)}; stop it or use its existing config`);
}

/**
 * Spawn the watchdog only when the recorded one is gone (§6.4). The pid lives
 * in watchdog.pid so ANY later run can verify liveness: before, only the run
 * that started the daemon knew a watchdog existed, and one that died mid-way
 * left every later session unprotected. `spawnFn` is injectable for tests.
 */
export function ensureWatchdog(
  port: number,
  spawnFn: (port: number) => number | undefined = spawnWatchdog,
): 'already-running' | 'spawned' | 'disabled' {
  if (process.env.LUPIN_NO_WATCHDOG === '1') return 'disabled'; // tests + doctor ephemeral servers
  const recorded = readWatchdogPid();
  if (recorded !== undefined && pidRunning(recorded)) return 'already-running';
  mkdirSync(lupinDir(), { recursive: true, mode: 0o700 });
  const pid = spawnFn(port);
  if (pid !== undefined) writeFileSync(watchdogPidfilePath(), String(pid));
  return 'spawned';
}

function readWatchdogPid(): number | undefined {
  if (!existsSync(watchdogPidfilePath())) return undefined;
  const pid = Number(readFileSync(watchdogPidfilePath(), 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function stopDaemon(): 'stopped' | 'not-running' {
  const pid = readPidfile();
  rmSync(pidfilePath(), { force: true });
  if (pid === undefined || !pidRunning(pid)) return 'not-running';
  process.kill(pid);
  return 'stopped';
}

/**
 * Spawn the detached watchdog (SPEC-CLI §6.4). It owns nothing until the
 * daemon dies; then it holds the port with a well-formed Anthropic 529 and
 * clears the stale pidfile so the next `lupin run` starts clean. Idempotent:
 * a live daemon means an older watchdog is redundant, so we only spawn when
 * we just started the daemon ourselves. Returns the watchdog pid (tests).
 */
export function spawnWatchdog(port: number): number | undefined {
  if (process.env.LUPIN_NO_WATCHDOG === '1') return undefined; // tests + doctor ephemeral servers
  const pkgRoot = fileURLToPath(new URL('../..', import.meta.url));
  const out = openSync(logfilePath(), 'a');
  const child = spawn(process.execPath, [...entrypointArgs(import.meta.url, './watchdog.ts'), String(port)], {
    cwd: pkgRoot,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}
