// `lupin` with no arguments (DESIGN-OAUTH-PKCE-TUI §3): the hub. With a TTY and
// the optional Rust sidecar (lupin-tui) on the PATH it launches the TUI; every
// other case falls back to a compact status plus a hint, so the command is
// never a dead end and never depends on a native binary to be useful.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { defaultConfigPath, loadConfig } from '../config/config.js';
import { ensureBootstrapDaemon, ensureDaemon } from '../server/daemon.js';
import type { BootstrapIdentity } from './login.js';
import { statusCommand } from './daemonctl.js';

const TUI_BIN = process.platform === 'win32' ? 'lupin-tui.exe' : 'lupin-tui';

/** True when the sidecar binary is resolvable on the PATH. */
async function tuiAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn(TUI_BIN, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' });
    // A sidecar that hangs on --version must not hang the hub with it: past
    // 3s the fallback screen is the better answer (audit 2026-07-29).
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

async function spawnTui(env: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise((resolve) => {
    const child = spawn(TUI_BIN, [], { env, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

export interface HubDeps {
  isTTY: boolean;
  configExists: () => boolean;
  loadConfig: () => { port: number };
  tuiAvailable: () => Promise<boolean>;
  startBootstrap: (identity: BootstrapIdentity) => Promise<'already-running' | 'started'>;
  /** The configured counterpart of startBootstrap: the daemon `lupin run` ensures. */
  startDaemon: (port: number) => Promise<'already-running' | 'started'>;
  spawnTui: (env: NodeJS.ProcessEnv) => Promise<number>;
  statusCommand: () => Promise<number>;
  randomToken: () => string;
  env: NodeJS.ProcessEnv;
  error: (message: string) => void;
}

const NO_CONFIG = 'no config yet: add a provider from the TUI (lupin, sidecar installed) or the control API (README §Headless setup)';

export async function hubCommandWith(deps: HubDeps): Promise<number> {
  let configured = deps.configExists();
  let config: { port: number } | undefined;
  if (configured) {
    try {
      config = deps.loadConfig();
    } catch {
      deps.error(NO_CONFIG);
      return 1;
    }
  }

  if (deps.isTTY) {
    const available = await deps.tuiAvailable();
    if (!configured && deps.configExists()) {
      try {
        config = deps.loadConfig();
        configured = true;
      } catch {
        deps.error(NO_CONFIG);
        return 1;
      }
    }
    if (available) {
      if (configured) {
        // The cold start opens the TUI on a live bootstrap daemon; a
        // configured start gets the same courtesy. A dashboard that opens on
        // "daemon DOWN" lets every gesture fail at its last step instead
        // (found driving the hub live, 2026-08-12).
        if (config !== undefined) await deps.startDaemon(config.port);
        return await deps.spawnTui(deps.env);
      }
      const identity: BootstrapIdentity = { port: 3456, localToken: deps.randomToken() };
      await deps.startBootstrap(identity);
      return await deps.spawnTui({
        ...deps.env,
        LUPIN_BOOTSTRAP_PORT: String(identity.port),
        LUPIN_BOOTSTRAP_TOKEN: identity.localToken,
      });
    }
  }

  if (!configured) {
    deps.error(NO_CONFIG);
    return 1;
  }

  // Fallback: status plus the next moves, never a bare usage dump.
  await deps.statusCommand();
  console.log('');
  console.log('next:  lupin go -- claude     (switch + run in one step)');
  console.log('       lupin top             (live console, no sidecar needed)');
  console.log('       lupin --help           (every command)');
  return 0;
}

export async function hubCommand(): Promise<number> {
  return await hubCommandWith({
    isTTY: process.stdout.isTTY === true,
    configExists: () => existsSync(defaultConfigPath()),
    loadConfig,
    tuiAvailable,
    startBootstrap: ensureBootstrapDaemon,
    startDaemon: ensureDaemon,
    spawnTui,
    statusCommand,
    randomToken: () => randomBytes(24).toString('hex'),
    env: process.env,
    error: console.error,
  });
}
