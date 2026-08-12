// UX criterion SPEC-CLI §6.4: a mid-session daemon kill must surface a
// comprehensible Anthropic error, and the next `lupin run` must start clean
// (stale pidfile handled). The watchdog (src/server/watchdog.ts) is what
// answers when the dead daemon cannot.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { spawn, type ChildProcess } from 'node:child_process';
import type { ServerType } from '@hono/node-server';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LupinConfig } from '../src/config/config.js';
import { networkError } from '../src/core/errors.js';
import {
  bootstrapDaemonEnv,
  createDaemonConfigLifecycle,
  daemonWorkingDirectory,
  ensureBootstrapDaemonWith,
  ensureDaemonWith,
  ensureWatchdog,
  entrypointArgs,
  fetchWithDaemonConfigLifecycle,
  initialDaemonConfig,
  lifecycleLockPath,
  observeBootstrapConfigBeforeReload,
  pidfilePath,
  serverAlive,
  serverHasIdentity,
  quiesceDaemonForUpdate,
  watchdogPidfilePath,
} from '../src/server/daemon.js';
import { DAEMON_DOWN_MESSAGE, holdPortDown } from '../src/server/watchdog.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-watchdog-'));
const fixtureChildren: ChildProcess[] = [];

async function stopFixtureChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  await exited;
}

afterEach(async () => {
  await Promise.all(fixtureChildren.splice(0).map(stopFixtureChild));
  rmSync(dir, { recursive: true, force: true });
});

describe('stale pidfile handling (SPEC-CLI §6.4)', () => {
  it('a pidfile pointing at a dead pid is treated as stale, not trusted', () => {
    const pidfile = join(dir, 'lupin.pid');
    writeFileSync(pidfile, '999999'); // a pid that cannot exist
    const pid = Number(readFileSync(pidfile, 'utf8').trim());
    let running = true;
    try {
      process.kill(pid, 0);
    } catch {
      running = false;
    }
    expect(running).toBe(false); // → ensureDaemon removes it and starts fresh
    expect(existsSync(pidfile)).toBe(true); // until the daemon path clears it
  });
});

describe('fallback error shape (Anthropic format, SPEC-TRANSLATION §6)', () => {
  it('the down-message is a well-formed retryable 529, never "at capacity"', () => {
    const err = networkError(DAEMON_DOWN_MESSAGE);
    expect(err.status).toBe(529);
    expect(err.body.type).toBe('error');
    expect(err.body.error.type).toBe('overloaded_error');
    expect(err.body.error.message).toContain('lupin run');
    expect(err.body.error.message).not.toContain('at capacity');
  });
});

// Audit 2026-07-22 gap `watchdog-respawn-gap` (verdict: missing). Two halves:
// (a) the watchdog was only spawned on the fresh-start branch of ensureDaemon,
// so a watchdog that died while the daemon lived was never replaced; (b) while
// holding the port, a fresh `lupin run` spawned a daemon that could not bind —
// the watchdog only released on health-OK, which needs the bind: a deadlock
// until the 5-minute deadline.

describe('ensureWatchdog (respawn gap, §6.4)', () => {
  let restoreDir: string | undefined;
  beforeEach(() => {
    restoreDir = process.env.LUPIN_DIR;
    process.env.LUPIN_DIR = dir;
    mkdirSync(dir, { recursive: true }); // the module-level afterEach removes it between tests
  });
  afterEach(() => {
    if (restoreDir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = restoreDir;
  });

  it('spawns and records a watchdog when none is alive', () => {
    let spawnedPort: number | undefined;
    const out = ensureWatchdog(4114, () => {
      spawnedPort = 4114;
      return 12345;
    });
    expect(out).toBe('spawned');
    expect(spawnedPort).toBe(4114);
    expect(JSON.parse(readFileSync(watchdogPidfilePath(), 'utf8'))).toMatchObject({ pid: 12345 });
  });

  it('does not spawn a second watchdog while the recorded one is alive', () => {
    writeFileSync(watchdogPidfilePath(), JSON.stringify({ pid: process.pid, ownerToken: 'existing-owner' }));
    let called = false;
    const out = ensureWatchdog(4114, () => {
      called = true;
      return 99999;
    });
    expect(out).toBe('already-running');
    expect(called).toBe(false);
  });

  it('replaces a watchdog whose recorded pid is dead', () => {
    writeFileSync(watchdogPidfilePath(), JSON.stringify({ pid: 999999, ownerToken: 'dead-owner' }));
    const out = ensureWatchdog(4114, () => 22222);
    expect(out).toBe('spawned');
    expect(JSON.parse(readFileSync(watchdogPidfilePath(), 'utf8'))).toMatchObject({ pid: 22222 });
  });
});

describe('holdPortDown yields the port to a starting daemon (§6.4)', () => {
  let restoreDir: string | undefined;
  beforeEach(() => {
    restoreDir = process.env.LUPIN_DIR;
    process.env.LUPIN_DIR = dir;
    mkdirSync(dir, { recursive: true }); // the module-level afterEach removes it between tests
  });
  afterEach(() => {
    if (restoreDir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = restoreDir;
  });

  async function freePort(): Promise<number> {
    const probe: ServerType = serve({ fetch: () => new Response('ok'), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => probe.once('listening', resolve));
    const addr = probe.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
  }

  it('serves the 529 while holding, then yields when a LIVE pid appears in the pidfile', async () => {
    const port = await freePort();
    writeFileSync(pidfilePath(), '999999'); // the dead daemon that triggered the hold
    const hold = holdPortDown(port, 30_000, 50);

    // While held: any request answers the well-formed 529.
    await new Promise((r) => setTimeout(r, 200));
    const res = await fetch(`http://127.0.0.1:${String(port)}/v1/messages`, { method: 'POST' });
    expect(res.status).toBe(529);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('lupin run');

    // A fresh `lupin run` writes its new daemon pid (alive) before binding:
    // the watchdog must step aside instead of deadlocking it.
    writeFileSync(pidfilePath(), String(process.pid));
    const outcome = await hold;
    expect(outcome).toBe('yielded');

    // The port is actually free again: a new bind must succeed.
    const rebind: ServerType = serve({ fetch: () => new Response('ok'), port, hostname: '127.0.0.1' });
    await new Promise<void>((resolve, reject) => {
      rebind.once('listening', resolve);
      rebind.once('error', reject);
    });
    await new Promise<void>((resolve) => rebind.close(() => resolve()));
  });

  it('gives up after the deadline when nothing comes back', async () => {
    const port = await freePort();
    writeFileSync(pidfilePath(), '999999');
    const outcome = await holdPortDown(port, 300, 50);
    expect(outcome).toBe('gave-up');
  });
});

describe('fallback responder (live bind)', () => {
  it('serves a 529 Anthropic error on any path while the daemon is down', async () => {
    const app = new Hono();
    app.all('*', () => {
      const err = networkError(DAEMON_DOWN_MESSAGE);
      return new Response(JSON.stringify(err.body), {
        status: err.status,
        headers: { 'content-type': 'application/json' },
      });
    });
    const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    try {
      for (const path of ['/v1/messages', '/v1/messages/count_tokens', '/health']) {
        const res = await fetch(`http://127.0.0.1:${String(port)}${path}`, { method: 'POST' });
        expect(res.status).toBe(529);
        const body = (await res.json()) as { type: string; error: { type: string; message: string } };
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('overloaded_error');
        expect(body.error.message).toContain('lupin run');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Packaging (audit §7.2): an npm-installed Lupin has no tsx and no .ts files.
// The spawn arguments must follow the world the module itself lives in.
describe('entrypointArgs (dev vs dist spawn)', () => {
  it('a .ts module spawns its entry through the tsx loader', () => {
    const args = entrypointArgs('file:///C:/repo/src/server/daemon.ts', './start.ts');
    expect(args.slice(0, 2)).toEqual(['--import', 'tsx']);
    expect(args[2]).toMatch(/start\.ts$/);
  });

  it('a compiled .js module spawns the sibling .js directly, no loader', () => {
    const args = entrypointArgs('file:///C:/pkg/dist/server/daemon.js', './start.ts');
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/start\.js$/);
  });

  it('extra entry args survive the dist rewrite (watchdog port)', () => {
    const args = [...entrypointArgs('file:///C:/pkg/dist/server/daemon.js', './watchdog.ts'), '4100'];
    expect(args[0]).toMatch(/watchdog\.js$/);
    expect(args[1]).toBe('4100');
  });

  it('installed background processes run from the state directory, not the npm package', () => {
    expect(daemonWorkingDirectory('file:///C:/pkg/dist/server/daemon.js', 'C:\\state')).toBe('C:\\state');
    expect(daemonWorkingDirectory('file:///C:/repo/src/server/daemon.ts', 'C:\\state')).toMatch(/repo[\\/]*$/);
  });
});

describe('update lifecycle quiescence', () => {
  let restoreDir: string | undefined;
  let restoreNoWatchdog: string | undefined;

  beforeEach(() => {
    restoreDir = process.env.LUPIN_DIR;
    restoreNoWatchdog = process.env.LUPIN_NO_WATCHDOG;
    process.env.LUPIN_DIR = dir;
    process.env.LUPIN_NO_WATCHDOG = '1';
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    if (restoreDir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = restoreDir;
    if (restoreNoWatchdog === undefined) delete process.env.LUPIN_NO_WATCHDOG;
    else process.env.LUPIN_NO_WATCHDOG = restoreNoWatchdog;
  });

  async function waitUntil(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('test process did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it('stops the watchdog before the daemon so no fallback takes the port during npm install', async () => {
    const daemonEntry = fileURLToPath(new URL('../src/server/start.ts', import.meta.url));
    const watchdogEntry = fileURLToPath(new URL('../src/server/watchdog.ts', import.meta.url));
    const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', daemonEntry], { stdio: 'ignore' });
    fixtureChildren.push(daemon);
    if (daemon.pid === undefined) throw new Error('daemon fixture did not start');

    const ready = join(dir, 'watchdog-ready');
    const fallback = join(dir, 'fallback-started');
    const watcherScript = [
      "const fs = require('node:fs')",
      'const daemonPid = Number(process.argv[1])',
      'const ready = process.argv[2]',
      'const fallback = process.argv[3]',
      "fs.writeFileSync(ready, 'ready')",
      "setInterval(() => { try { process.kill(daemonPid, 0) } catch { fs.writeFileSync(fallback, 'started') } }, 5)",
    ].join(';');
    const watchdog = spawn(
      process.execPath,
      ['-e', watcherScript, String(daemon.pid), ready, fallback, watchdogEntry],
      { stdio: 'ignore' },
    );
    fixtureChildren.push(watchdog);
    if (watchdog.pid === undefined) throw new Error('watchdog fixture did not start');

    await waitUntil(() => existsSync(ready));
    writeFileSync(pidfilePath(), JSON.stringify({ pid: daemon.pid, ownerToken: 'daemon-owner' }));
    writeFileSync(watchdogPidfilePath(), JSON.stringify({ pid: watchdog.pid, ownerToken: 'watchdog-owner' }));

    const quiescence = await quiesceDaemonForUpdate((pid) =>
      pid === watchdog.pid
        ? `node ${watchdogEntry} --lupin-owner=watchdog-owner`
        : `node ${daemonEntry} --lupin-owner=daemon-owner`,
    );
    expect(quiescence.daemonWasRunning).toBe(true);
    expect(existsSync(lifecycleLockPath())).toBe(true);
    expect(existsSync(fallback)).toBe(false);
    expect(existsSync(pidfilePath())).toBe(false);
    expect(existsSync(watchdogPidfilePath())).toBe(false);
    quiescence.release();
    expect(existsSync(lifecycleLockPath())).toBe(false);
  });

  it('refuses a reused pid carrying the same entrypoint but a different lifecycle token', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fixtureChildren.push(unrelated);
    if (unrelated.pid === undefined) throw new Error('unrelated fixture did not start');
    writeFileSync(pidfilePath(), JSON.stringify({ pid: unrelated.pid, ownerToken: 'recorded-owner' }));
    const daemonEntry = fileURLToPath(new URL('../src/server/start.ts', import.meta.url));

    await expect(quiesceDaemonForUpdate(() => `node ${daemonEntry} --lupin-owner=different-owner`)).rejects.toThrow(
      /does not run the expected Lupin daemon entrypoint/,
    );
    expect(() => process.kill(unrelated.pid as number, 0)).not.toThrow();
  });

  it('makes a concurrent daemon start wait for the lifecycle lock', async () => {
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
    fixtureChildren.push(owner);
    if (owner.pid === undefined) throw new Error('lock owner fixture did not start');
    writeFileSync(lifecycleLockPath(), String(owner.pid));
    setTimeout(() => rmSync(lifecycleLockPath(), { force: true }), 250);

    const startedAt = Date.now();
    expect(await ensureDaemonWith(4567, undefined, async () => true)).toBe('already-running');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });

  it('never deletes a stale lifecycle lock behind another waiter', async () => {
    writeFileSync(lifecycleLockPath(), '999999');
    await expect(ensureDaemonWith(4567, undefined, async () => true)).rejects.toThrow(/stale lifecycle lock/);
    expect(readFileSync(lifecycleLockPath(), 'utf8').trim()).toBe('999999');
  });

  it('holds the bootstrap already-running fast path behind the lifecycle lock', async () => {
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });
    fixtureChildren.push(owner);
    if (owner.pid === undefined) throw new Error('bootstrap lock owner fixture did not start');
    writeFileSync(lifecycleLockPath(), String(owner.pid));
    setTimeout(() => rmSync(lifecycleLockPath(), { force: true }), 250);
    const startedAt = Date.now();

    expect(
      await ensureBootstrapDaemonWith(
        { port: 4567, localToken: 'token' },
        {
          serverAlive: async () => true,
          identityAlive: async () => true,
          startDaemon: async () => 'started',
          ensureWatchdog: () => undefined,
        },
      ),
    ).toBe('already-running');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
  });
});

describe('bootstrap daemon entry contract', () => {
  let restoreDir: string | undefined;
  beforeEach(() => {
    restoreDir = process.env.LUPIN_DIR;
    process.env.LUPIN_DIR = dir;
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    if (restoreDir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = restoreDir;
  });

  const bootstrapConfig = (localToken: string): LupinConfig => ({
    activeProfile: '',
    port: 4567,
    localToken,
    profiles: {},
  });

  it('passes the bootstrap identity only through child environment variables', () => {
    expect(bootstrapDaemonEnv({ port: 4567, localToken: 'ephemeral-token' })).toEqual({
      LUPIN_BOOTSTRAP_PORT: '4567',
      LUPIN_BOOTSTRAP_TOKEN: 'ephemeral-token',
    });
  });

  it('validates an environment-supplied zero-profile config instead of reading a missing file', () => {
    const load = () => {
      throw new Error('must not read config');
    };
    expect(
      initialDaemonConfig('missing.json', {
        LUPIN_BOOTSTRAP_PORT: '4567',
        LUPIN_BOOTSTRAP_TOKEN: 'ephemeral-token',
      }, load),
    ).toEqual({
      bootstrap: true,
      config: { activeProfile: '', port: 4567, localToken: 'ephemeral-token', profiles: {} },
    });
  });

  it('keeps normal startup file-backed when no bootstrap environment is supplied', () => {
    const loaded = {
      activeProfile: 'test',
      port: 4567,
      localToken: 'configured-token',
      profiles: {},
    };
    expect(initialDaemonConfig('config.json', {}, (path) => ({ ...loaded, activeProfile: path }))).toEqual({
      bootstrap: false,
      config: { ...loaded, activeProfile: 'config.json' },
    });
  });

  it('checks the requested token on a protected endpoint instead of accepting public health', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/v1/lupin/providers', (c) =>
      c.req.header('authorization') === 'Bearer expected-token'
        ? c.json({ ok: true, providers: [] })
        : c.json({ ok: false }, 401),
    );
    const server: ServerType = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      expect(await serverHasIdentity({ port, localToken: 'expected-token' })).toBe(true);
      expect(await serverHasIdentity({ port, localToken: 'different-token' })).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('reuses an overlapping bootstrap only when it has the requested identity', async () => {
    const startDaemon = vi.fn(async () => 'started' as const);
    const ensureWatchdog = vi.fn();
    const result = await ensureBootstrapDaemonWith(
      { port: 4567, localToken: 'expected-token' },
      {
        serverAlive: async () => true,
        identityAlive: async () => true,
        startDaemon,
        ensureWatchdog,
      },
    );

    expect(result).toBe('already-running');
    expect(startDaemon).not.toHaveBeenCalled();
    expect(ensureWatchdog).toHaveBeenCalledWith(4567);
  });

  it('refuses an identity-mismatched daemon without starting or replacing it', async () => {
    const startDaemon = vi.fn(async () => 'started' as const);
    const ensureWatchdog = vi.fn();
    await expect(
      ensureBootstrapDaemonWith(
        { port: 4567, localToken: 'expected-token' },
        {
          serverAlive: async () => true,
          identityAlive: async () => false,
          startDaemon,
          ensureWatchdog,
        },
      ),
    ).rejects.toThrow(/different daemon is already running on port 4567/);

    expect(startDaemon).not.toHaveBeenCalled();
    expect(ensureWatchdog).not.toHaveBeenCalled();
  });

  it('keeps the bound identity and fails authenticated readiness after a persisted identity conflict', async () => {
    const bound = bootstrapConfig('bound-token');
    const lifecycle = createDaemonConfigLifecycle({ config: bound, bootstrap: true });
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/v1/lupin/providers', (c) =>
      c.req.header('authorization') === 'Bearer bound-token'
        ? c.json({ ok: true, providers: [] })
        : c.json({ ok: false }, 401),
    );
    const server: ServerType = serve({
      fetch: (request) => fetchWithDaemonConfigLifecycle(request, lifecycle, app.fetch),
      port: 0,
      hostname: '127.0.0.1',
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      expect(await serverHasIdentity({ port, localToken: 'bound-token' })).toBe(true);
      expect(() => lifecycle.adopt(bootstrapConfig('persisted-token'))).toThrow(
        /persisted config identity conflicts with bootstrap listener on port 4567/,
      );
      expect(lifecycle.current()).toEqual(bound);
      expect(lifecycle.conflict()).toMatch(/persisted config identity conflicts/);
      expect(await serverAlive(port)).toBe(true);
      expect(await serverHasIdentity({ port, localToken: 'bound-token' })).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('adopts the first persisted config when it keeps the bootstrap identity', () => {
    const bound = bootstrapConfig('bound-token');
    const persisted = bootstrapConfig('bound-token');
    persisted.activeProfile = 'test';
    persisted.profiles['test'] = {
      provider: 'moonshot',
      mode: 'passthrough',
      auth: { type: 'none' },
      slots: { opus: 'model', sonnet: 'model', haiku: 'model' },
    };
    const lifecycle = createDaemonConfigLifecycle({ config: bound, bootstrap: true });

    lifecycle.adopt(persisted);

    expect(lifecycle.current()).toBe(persisted);
    expect(lifecycle.conflict()).toBeUndefined();
  });

  it('adopts revision B when it is written while bootstrap observation is established', () => {
    const persisted = (name: string): LupinConfig => ({
      activeProfile: name,
      port: 4567,
      localToken: 'bound-token',
      profiles: {
        [name]: {
          provider: 'moonshot',
          mode: 'passthrough',
          auth: { type: 'none' },
          slots: { opus: 'model', sonnet: 'model', haiku: 'model' },
        },
      },
    });
    const revisionA = persisted('revision-a');
    const revisionB = persisted('revision-b');
    let onDisk = revisionA;
    const lifecycle = createDaemonConfigLifecycle({ config: bootstrapConfig('bound-token'), bootstrap: true });

    observeBootstrapConfigBeforeReload(
      () => {
        onDisk = revisionB;
      },
      () => lifecycle.adopt(onDisk),
    );

    expect(lifecycle.current()).toBe(revisionB);
  });

  it('reconciles a persisted identity before returning authenticated readiness', async () => {
    const bound = bootstrapConfig('bound-token');
    const lifecycle = createDaemonConfigLifecycle({ config: bound, bootstrap: true });
    const app = new Hono();
    app.get('/health', (c) => c.json({ ok: true }));
    app.get('/v1/lupin/providers', (c) =>
      c.req.header('authorization') === 'Bearer bound-token'
        ? c.json({ ok: true, providers: [] })
        : c.json({ ok: false }, 401),
    );
    const reconcile = vi.fn(() => lifecycle.adopt(bootstrapConfig('persisted-token')));
    const server: ServerType = serve({
      fetch: (request) => fetchWithDaemonConfigLifecycle(request, lifecycle, app.fetch, reconcile),
      port: 0,
      hostname: '127.0.0.1',
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      expect(await serverHasIdentity({ port, localToken: 'bound-token' })).toBe(false);
      expect(reconcile).toHaveBeenCalledOnce();
      expect(lifecycle.current()).toEqual(bound);
      expect(lifecycle.conflict()).toMatch(/persisted config identity conflicts/);
      expect(await serverAlive(port)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Found live 2026-08-12 (WSL, stop then start inside the watchdog hold): the
// child reached its bind BEFORE the watchdog's 300ms poll saw the pidfile,
// died on EADDRINUSE, and the yield never happened. The child now retries
// inside a bounded window, so briefly-held ports resolve instead of racing.
describe('daemon bind retry during a watchdog yield', () => {
  it('comes up when the port is released shortly after the child started', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'lupin-bind-retry-'));
    const app = new Hono();
    app.all('*', (c) => c.text('held', 503));
    let bound: ServerType | undefined;
    const port = await new Promise<number>((resolve) => {
      bound = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port));
    });
    const holder = bound;
    if (holder === undefined) throw new Error('holder never bound');
    const config: LupinConfig = {
      activeProfile: 'a',
      port,
      localToken: 'bind-retry-token',
      profiles: {
        a: {
          provider: 'moonshot',
          mode: 'passthrough',
          baseUrl: 'http://127.0.0.1:1',
          auth: { type: 'bearer', apiKeyRef: 'X' },
          slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
        },
      },
    };
    writeFileSync(join(sandbox, 'config.json'), JSON.stringify(config));
    const entry = fileURLToPath(new URL('../src/server/start.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', entry], {
      env: { ...process.env, LUPIN_DIR: sandbox },
      stdio: 'ignore',
    });
    fixtureChildren.push(child);
    try {
      // Long enough that, without the retry, the child has already died on
      // its first EADDRINUSE; then the port frees, as a yield frees it.
      await new Promise((r) => setTimeout(r, 700));
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      let up = false;
      const deadline = Date.now() + 8000;
      while (!up && Date.now() < deadline) {
        try {
          const res = await fetch(`http://127.0.0.1:${String(port)}/health`, {
            signal: AbortSignal.timeout(500),
          });
          up = res.status === 200;
        } catch {
          // not up yet
        }
        if (!up) await new Promise((r) => setTimeout(r, 200));
      }
      expect(up).toBe(true);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }, 15000);
});
