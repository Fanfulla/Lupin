// `lupin` with no arguments (DESIGN-OAUTH-PKCE-TUI §3): the hub. With a TTY and
// the optional Rust sidecar (lupin-tui) on the PATH it launches the TUI; every
// other case falls back to a compact status plus a hint, so the command is
// never a dead end and never depends on a native binary to be useful.

import { spawn } from 'node:child_process';
import { loadConfig } from '../config/config.js';
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

export async function hubCommand(): Promise<number> {
  // Ensure there is something to show at all.
  try {
    loadConfig();
  } catch {
    console.error('no config yet: run `lupin init` first');
    return 1;
  }

  if (process.stdout.isTTY && (await tuiAvailable())) {
    return await new Promise((resolve) => {
      const child = spawn(TUI_BIN, [], { stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('error', () => resolve(1));
      child.on('exit', (code) => resolve(code ?? 0));
    });
  }

  // Fallback: status plus the next moves, never a bare usage dump.
  await statusCommand();
  console.log('');
  console.log('next:  lupin go -- claude     (switch + run in one step)');
  console.log('       lupin top             (live console, no sidecar needed)');
  console.log('       lupin --help           (every command)');
  return 0;
}
