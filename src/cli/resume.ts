// `lupin resume [profile] [-- <claude args>]` (SPEC-CLI §1, DESIGN-HANDOFF
// §3.2): the scenario-B handoff as one gesture. A native session that hit its
// limits continues on a third-party profile: optional switch (same path as
// `lupin use`), then `lupin run` relaunching `claude --continue`, which
// replays the cwd's own transcript. Lupin never reads that transcript's
// content: the only look it takes is a file SIZE, for the advisory.

import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { useCommand } from './use.js';
import { runCommand } from './run.js';

/** Session-picking flags claude owns; when the user passes one, we inject nothing. */
const SESSION_FLAGS = new Set(['-c', '--continue', '-r', '--resume', '--from-pr']);

export function resumeClaudeArgs(userArgs: readonly string[]): string[] {
  const picked = userArgs.some(
    (a) => SESSION_FLAGS.has(a) || a.startsWith('--continue=') || a.startsWith('--resume=') || a.startsWith('--from-pr='),
  );
  return picked ? [...userArgs] : ['--continue', ...userArgs];
}

/**
 * The transcript directory key for a cwd, as observed on disk (2026-07-31):
 * every path separator and colon becomes a dash. Anything unexpected in the
 * path degrades to a key that matches nothing, and the advisory stays silent:
 * it is an advisory, never a gate.
 */
export function transcriptKey(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-');
}

const ADVISORY_BYTES = 1024 * 1024;

const NO_SESSION_WARNING =
  '[lupin] no Claude Code session is recorded for this directory: sessions are per-directory, ' +
  'so run `lupin resume` from the directory the session ran in (claude may refuse to continue here).';

/**
 * One honest line before the handoff (SPEC-CLI §1 rules 2 and 3), from the
 * transcript's SIZE alone (content never read, nothing written): a missing
 * per-directory transcript gets the cwd-rule warning (claude's own failure
 * here is cryptic, observed live 2026-07-31), a large one gets the cold-cache
 * advisory. Both are printed lines, never a gate: the key transform is
 * best-effort, so a miss must not block a resume that would have worked.
 */
export function transcriptAdvisory(cwd: string, home: string = homedir()): string | undefined {
  const dir = join(home, '.claude', 'projects', transcriptKey(cwd));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return NO_SESSION_WARNING; // the directory does not even exist
  }
  try {
    let latest: { mtime: number; size: number } | undefined;
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const s = statSync(join(dir, name));
      if (latest === undefined || s.mtimeMs > latest.mtime) latest = { mtime: s.mtimeMs, size: s.size };
    }
    if (latest === undefined) return NO_SESSION_WARNING;
    if (latest.size < ADVISORY_BYTES) return undefined;
    const mb = (latest.size / (1024 * 1024)).toFixed(1);
    return (
      `[lupin] the session being resumed is ${mb} MB of transcript: the new provider starts with a cold cache, ` +
      `so the first request re-pays the whole prefix (and a small context window may not fit it). ` +
      `Next time, /compact before leaving the native session shrinks the bill.`
    );
  } catch {
    return undefined; // a half-readable directory: silence, never a failed handoff
  }
}

export async function resumeCommand(
  args: string[],
  advise: (cwd: string) => string | undefined = transcriptAdvisory,
): Promise<number> {
  const sep = args.indexOf('--');
  const before = sep === -1 ? args : args.slice(0, sep);
  const extra = sep === -1 ? [] : args.slice(sep + 1);

  // The usage check comes FIRST: a bad invocation must not have switched the
  // profile as a side effect (the `lupin go` lesson, audit 2026-07-29). A
  // profile never starts with a dash, so `resume -h` or a forgotten `--`
  // both land here instead of becoming a profile lookup.
  if (before.length > 1 || before.some((a) => a.startsWith('-'))) {
    console.error('usage: lupin resume [profile] [-- <claude args…>]   (see your profiles with: lupin list)');
    return 1;
  }

  const profile = before[0];
  if (profile !== undefined) {
    const code = useCommand([profile]);
    if (code !== 0) return code;
  }

  const advisory = advise(process.cwd());
  if (advisory !== undefined) console.log(advisory);

  return runCommand(['--', 'claude', ...resumeClaudeArgs(extra)]);
}
