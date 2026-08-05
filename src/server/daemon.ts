// Daemon lifecycle (SPEC-CLI §1): detached server process, pidfile in
// ~/.lupin/, stale-pidfile recovery, health polling. CLI commands orchestrate
// these helpers; the server itself lives in start.ts.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  if (await serverAlive(port)) {
    // §6.4 respawn gap (audit 2026-07-22): a watchdog that died while the
    // daemon lived was never replaced: every run verifies it, not just the
    // one that started the daemon.
    ensureWatchdog(port);
    return 'already-running';
  }

  const stale = readPidfile();
  if (stale !== undefined && !pidRunning(stale)) rmSync(pidfilePath(), { force: true }); // SPEC-CLI §6.4

  mkdirSync(lupinDir(), { recursive: true, mode: 0o700 });
  const pkgRoot = fileURLToPath(new URL('../..', import.meta.url)); // dev: resolves tsx from our node_modules
  const out = openSync(logfilePath(), 'a');
  const child = spawn(process.execPath, entrypointArgs(import.meta.url, './start.ts'), {
    cwd: pkgRoot,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  if (child.pid !== undefined) writeFileSync(pidfilePath(), String(child.pid));

  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (await serverAlive(port)) {
      ensureWatchdog(port); // §6.4: cover a mid-session kill from now on
      return 'started';
    }
  }
  throw new Error(`server did not come up on port ${String(port)}: check ${logfilePath()}`);
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
