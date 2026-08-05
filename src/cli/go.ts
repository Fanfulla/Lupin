// `lupin go [profile] -- <command>` (DESIGN-OAUTH-PKCE-TUI §3): the common
// two-step (switch, then run) as one command. A profile before `--` is switched
// to first (same write path as `lupin use`); the command then runs through
// `lupin run`. With no profile it just runs.

import { useCommand } from './use.js';
import { runCommand } from './run.js';

export async function goCommand(args: string[]): Promise<number> {
  const sep = args.indexOf('--');
  const before = sep === -1 ? args : args.slice(0, sep);
  const cmd = sep === -1 ? [] : args.slice(sep + 1);

  // The usage check comes FIRST: a `lupin go b` with the `--` forgotten must
  // not switch the active profile as a side effect of a failed command
  // (audit 2026-07-29).
  if (cmd.length === 0) {
    console.error('usage: lupin go [profile] -- <command> [args…]   (the -- is required; see your profiles with: lupin list)');
    return 1;
  }

  const profile = before[0];
  if (profile !== undefined) {
    const code = useCommand([profile]);
    if (code !== 0) return code;
  }
  return runCommand(['--', ...cmd]);
}
