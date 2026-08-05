// Daemon watchdog (SPEC-CLI §6.4): a detached helper that answers for the
// daemon when the daemon cannot. A killed process cannot respond HTTP, so a
// mid-session kill would otherwise surface in Claude Code as a raw TCP
// connection-refused: not the "comprensible Anthropic error" the criterion
// asks for. This process watches the pidfile; the moment the daemon dies it
// re-binds the port and serves a well-formed Anthropic 529 until the daemon
// comes back, then it clears the stale pidfile (so the next `lupin run`
// starts clean) and exits.

import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { appendFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logfilePath, pidfilePath, watchdogPidfilePath } from './daemon.js';
import { networkError } from '../core/errors.js';

export const DAEMON_DOWN_MESSAGE =
  'lupin daemon stopped mid-session: run `lupin run -- claude` again (this fallback is only holding the port)';

function pidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonPid(): number | undefined {
  if (!existsSync(pidfilePath())) return undefined;
  const pid = Number(readFileSync(pidfilePath(), 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function daemonAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function logLine(obj: Record<string, unknown>): void {
  try {
    appendFileSync(logfilePath(), `${JSON.stringify({ ts: new Date().toISOString(), source: 'watchdog', ...obj })}\n`);
  } catch {
    // logging must never kill the watchdog
  }
}

/** True while the recorded daemon pid is alive and answering. */
async function daemonUp(port: number): Promise<boolean> {
  const pid = readDaemonPid();
  if (pid === undefined || !pidRunning(pid)) return false;
  return await daemonAlive(port);
}

/**
 * Serves the 529 fallback while the daemon is down. Outcomes:
 * - 'recovered': the real daemon answers again (fresh `lupin run` restarted it)
 * - 'yielded': a LIVE pid appeared in the pidfile, so a daemon is STARTING and
 *   needs this port; holding on would deadlock it against our own bind until
 *   the deadline (audit 2026-07-22, watchdog-respawn-gap adjacent bug)
 * - 'gave-up': deadline passed with no recovery
 * The port is released before resolving in every case.
 */
export async function holdPortDown(
  port: number,
  giveUpMs: number,
  pollMs = 300,
): Promise<'recovered' | 'yielded' | 'gave-up'> {
  const app = new Hono();
  app.all('*', (c) => {
    const err = networkError(DAEMON_DOWN_MESSAGE);
    logLine({ event: 'daemon-down-response', path: c.req.path, status: err.status });
    return new Response(JSON.stringify(err.body), {
      status: err.status,
      headers: { 'content-type': 'application/json' },
    });
  });
  const server: ServerType = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
  logLine({ event: 'fallback-bound', port });
  const deadline = Date.now() + giveUpMs;
  try {
    for (;;) {
      await new Promise((r) => setTimeout(r, pollMs));
      // Recover only when the REAL daemon answers: check the pid too, so we
      // do not mistake our own fallback for the daemon coming back.
      if (await daemonUp(port)) return 'recovered';
      const pid = readDaemonPid();
      if (pid !== undefined && pidRunning(pid)) {
        logLine({ event: 'fallback-yield', port, pid });
        return 'yielded';
      }
      if (Date.now() > deadline) return 'gave-up';
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  const port = Number(process.argv[2]);
  if (!Number.isInteger(port) || port <= 0) {
    console.error('watchdog: expected a port as argv[2]');
    process.exit(1);
  }
  logLine({ event: 'watchdog-start', port, pid: process.pid });

  // Watch: while the daemon pid is alive and healthy, stay resident and idle.
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    if (await daemonUp(port)) continue;
    // Daemon is down (killed mid-session, or crashed): answer in its place.
    const outcome = await holdPortDown(port, 5 * 60_000).catch(() => 'gave-up' as const);
    if (outcome === 'gave-up') break;
    if (outcome === 'yielded') {
      // A daemon is starting on our port: stand back and give it the same
      // window ensureDaemon polls for. If it makes it, resume watching; if it
      // dies, the next loop iteration holds the port again.
      const graceDeadline = Date.now() + 12_000;
      while (Date.now() < graceDeadline && !(await daemonUp(port))) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // 'recovered' (or a successful yield): loop resumes watching.
  }

  // Clear a stale pidfile so the next `lupin run` does not trust a dead pid,
  // and our own record so the next run knows no watchdog is resident.
  const pid = readDaemonPid();
  if (pid !== undefined && !pidRunning(pid)) rmSync(pidfilePath(), { force: true });
  rmSync(watchdogPidfilePath(), { force: true });
  logLine({ event: 'watchdog-exit', port });
}

// Import-safe (tests import holdPortDown): main runs only when executed as a script.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
