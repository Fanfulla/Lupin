// `lupin run -- <command>` (SPEC-CLI §1): start the daemon if needed, then run
// the command with the env pointed at Lupin. The WHOLE process tree inherits
// the vars: hooks, plugins (claude-mem) and SDK subagents included (DESIGN §7).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { loadConfig } from '../config/config.js';
import { agentRouteId } from '../providers/resolve.js';
import { ensureDaemon } from '../server/daemon.js';
import { SUBAGENTS_ROUTE } from './agents.js';

/** What `GET /health` says, reduced to what a startup announcement needs. */
export interface RunHealth {
  activeProfile?: string;
  slots?: Partial<Record<'opus' | 'sonnet' | 'haiku', string>>;
  tier?: { free?: boolean; upgrade?: string };
}

/**
 * The line Claude Code shows at startup: which profile answers, with which
 * model, and whether that model is free. Claude Code's own welcome box cannot
 * be changed, but it does display `companyAnnouncements`, so this is the one
 * place the routing truth can greet the user before the first prompt.
 *
 * Returns undefined when there is nothing certain to say. A free tier is only
 * claimed when the daemon actually knows it (the provider declared it, or the
 * model id says so), never guessed: an announcement that lies is worse than
 * no announcement.
 */
export function startupAnnouncement(health: RunHealth): string | undefined {
  const profile = health.activeProfile;
  if (profile === undefined || profile === '') return undefined;
  // opus first: Claude Code's default model is `claude-fable-5`, which resolves
  // to the OPUS slot (SPEC-PROVIDERS §4 rule 1, verified in a real session
  // 2026-07-19), so that is the model about to answer. Announcing the sonnet
  // slot instead named the wrong model on any profile whose slots differ
  // (found 2026-08-02 while making the statusline and this line agree).
  const model = health.slots?.opus ?? health.slots?.sonnet ?? health.slots?.haiku;
  const where = model === undefined ? profile : `${profile} → ${model}`;
  if (health.tier?.free !== true) return `Lupin: this session runs on ${where}.`;
  const upgrade = health.tier.upgrade;
  return (
    `Lupin: this session runs on ${where}, on a FREE tier, so the models are the free ones. ` +
    (upgrade === undefined ? '' : `A paid plan removes the limit: ${upgrade}`)
  ).trim();
}

/**
 * `--settings` takes inline JSON and overrides only the keys it names, for that
 * session alone, so nothing of the user's is touched (ADR-11 holds). It is a
 * recent flag: an older Claude Code would reject the whole invocation, so it is
 * only used when `--help` proves it exists. Any doubt means no announcement,
 * because a session that fails to start is far worse than a missing line.
 */
export function announcementArgs(
  head: string,
  userArgs: readonly string[],
  announcement: string | undefined,
  supportsSettings: (bin: string) => boolean,
): string[] {
  if (announcement === undefined) return [];
  // Only Claude Code has this flag; `lupin run -- <anything else>` is untouched.
  // The split is on BOTH separators on purpose: node's basename follows the
  // host, so on Linux it would not cut a Windows path at all, and the check
  // must not depend on where it runs (found by CI, green on Windows).
  const bin = (head.split(/[\\/]/).pop() ?? head).replace(/\.(cmd|exe|ps1)$/i, '');
  if (bin !== 'claude') return [];
  // The user's own --settings wins: never override an explicit choice.
  if (userArgs.some((a) => a === '--settings' || a.startsWith('--settings='))) return [];
  if (!supportsSettings(head)) return [];
  return ['--settings', JSON.stringify({ companyAnnouncements: [announcement] })];
}

/** True when the installed Claude Code documents `--settings` in its own help. */
function claudeSupportsSettings(head: string): boolean {
  try {
    const resolved = resolveHead(head);
    const res = spawnSync(resolved.viaShell ? `"${resolved.command}"` : resolved.command, ['--help'], {
      encoding: 'utf8',
      timeout: 5000,
      shell: resolved.viaShell,
    });
    return typeof res.stdout === 'string' && res.stdout.includes('--settings');
  } catch {
    return false;
  }
}

export function runEnv(
  port: number,
  localToken: string,
  current: Record<string, string | undefined> = process.env,
  quirks: readonly string[] = [],
  agentRoutes: Readonly<Record<string, unknown>> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${String(port)}`,
    ANTHROPIC_AUTH_TOKEN: localToken,
    ANTHROPIC_API_KEY: '', // emptied on purpose: a set key would win over the proxy (SPEC-CLI §1.2)
  };
  // Gateway model discovery is opt-in client-side, and a Lupin session is
  // exactly the case it exists for: without it Claude Code never calls
  // GET /v1/models and the /model picker cannot show the profile's models
  // (SPEC-CLI §1.2). An explicit value from the user always wins, opt-out
  // included: only an unset var is filled in.
  if (current['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] === undefined) {
    env['CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY'] = '1';
  }
  // raiseStreamIdleTimeout (SPEC-PROVIDERS §5, ADR-35): ds4-server serializes
  // requests on one slot, so a queued request can sit with zero bytes on the
  // wire far longer than the client's default idle timeout; the engine's own
  // Claude Code wrapper sets 600000 ms. Same fill-in rule as above. The quirks
  // are the launch-time profile's: a switch after launch cannot re-set the env.
  if (quirks.includes('raiseStreamIdleTimeout') && current['CLAUDE_STREAM_IDLE_TIMEOUT_MS'] === undefined) {
    env['CLAUDE_STREAM_IDLE_TIMEOUT_MS'] = '600000';
  }
  // Agent routes (§4decies, ADR-47): declaring the conventional `subagents`
  // route IS the opt-in, so every subagent request arrives on an id the table
  // can aim. Same fill-in rule as above (an explicit value wins, empty
  // included) and same launch-time limit as ADR-35: the env var is read at
  // launch, the table is hot-reloaded.
  if (agentRoutes[SUBAGENTS_ROUTE] !== undefined && current['CLAUDE_CODE_SUBAGENT_MODEL'] === undefined) {
    env['CLAUDE_CODE_SUBAGENT_MODEL'] = agentRouteId(SUBAGENTS_ROUTE);
  }
  return env;
}

/** What a command name resolves to, and whether a shell must carry it. */
export interface ResolvedHead {
  command: string;
  viaShell: boolean;
}

/**
 * Where `head` really lives, so the child can be spawned WITHOUT a shell when
 * possible. Until 2026-07-29 the Windows spawn used `shell: true`: node joins
 * the args into one cmd.exe line with no quoting, so any value with quotes or
 * spaces (the inline --settings JSON being the first lupin ever injects)
 * arrived mangled and claude refused to start (ADR-29). POSIX never had the
 * problem: no shell, the args go straight to execvp.
 *
 * On Windows a bare `claude` is resolved the way cmd resolves it: the current
 * directory first (unless NoDefaultCurrentDirectoryInExePath opts out, same as
 * cmd), then PATH, each with the PATHEXT extensions in order. The old
 * `shell: true` spawn had cmd doing exactly that search, so skipping the CWD
 * here would silently drop a claude that only lives in the invocation
 * directory (audit 2026-07-29). An .exe/.com spawns directly: CreateProcess
 * takes the argv as is, spaces in the path included. A .cmd/.bat CANNOT be
 * spawned without a shell (EINVAL since Node 20.12.2), so it keeps the shell
 * and nothing delicate may travel inline on that path (see
 * shellSafeSettingsArgs). A head that resolves nowhere comes back untouched:
 * spawn then fails with ENOENT, the same error path as before.
 */
export function resolveHead(
  head: string,
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
): ResolvedHead {
  if (platform !== 'win32') return { command: head, viaShell: false };
  const pathext = (env['PATHEXT'] ?? '.com;.exe;.bat;.cmd').split(';').filter((e) => e !== '');
  const candidates = extname(head) === '' ? pathext.map((ext) => head + ext) : [head];
  const dirs = /[\\/]/.test(head)
    ? ['']
    : [
        ...(env['NoDefaultCurrentDirectoryInExePath'] === undefined ? ['.'] : []),
        ...(env['PATH'] ?? '').split(';').filter((d) => d !== ''),
      ];
  for (const dir of dirs) {
    for (const candidate of candidates) {
      // '.' is the CWD leg of the search: made absolute so the spawn cannot
      // re-interpret it, '' is a head that already carries its own path.
      const full = dir === '' ? candidate : dir === '.' ? resolve(candidate) : join(dir, candidate);
      if (existsSync(full)) return { command: full, viaShell: /\.(cmd|bat)$/i.test(full) };
    }
  }
  return { command: head, viaShell: false };
}

/**
 * Settings for a child that sits behind cmd.exe (a .cmd/.bat shim): inline
 * JSON cannot survive the trip, but `--settings` also accepts a FILE, and a
 * quoted path carries no quotes at all, so cmd.exe passes it byte for byte,
 * spaces included (verified live 2026-07-29, ADR-29). The file holds only the
 * keys the inline JSON would have held, so the override scope is unchanged,
 * and it lives in Lupin's own dir (ADR-11 holds).
 */
export function shellSafeSettingsArgs(args: readonly string[], file: string): string[] {
  if (args.length === 0) return [];
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, args[1] ?? '{}', { mode: 0o600 });
  } catch {
    // The announcement degrades to silence, never to a failed session: the
    // same invariant announcementArgs documents (audit 2026-07-29).
    return [];
  }
  return ['--settings', `"${file}"`];
}

export async function runCommand(args: string[]): Promise<number> {
  const sep = args.indexOf('--');
  const cmd = sep === -1 ? args : args.slice(sep + 1);
  const head = cmd[0];
  if (head === undefined) {
    console.error('usage: lupin run -- <command> [args…]   (e.g. lupin run -- claude)');
    return 1;
  }

  let config;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet: add a provider from the hub (run: lupin)');
    return 1;
  }

  const state = await ensureDaemon(config.port);
  if (state === 'started') console.log(`[lupin] server started on 127.0.0.1:${String(config.port)}`);

  // The routing truth, greeted at startup. A daemon that cannot answer costs
  // the announcement and nothing else: the session starts either way.
  let health: RunHealth = {};
  try {
    const res = await fetch(`http://127.0.0.1:${String(config.port)}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) health = (await res.json()) as RunHealth;
  } catch {
    // no announcement, never a failed run
  }
  const userArgs = cmd.slice(1);
  const extra = announcementArgs(head, userArgs, startupAnnouncement(health), claudeSupportsSettings);
  const resolved = resolveHead(head);

  // A .cmd/.bat shim goes through cmd.exe, where inline settings JSON would
  // arrive mangled: the same settings travel as a file instead (ADR-29). The
  // user's own args keep their historical pass-through on that path.
  let childArgs = [...extra, ...userArgs];
  let settingsFile: string | undefined;
  if (resolved.viaShell && extra.length > 0) {
    const dir = process.env.LUPIN_DIR ?? join(homedir(), '.lupin');
    settingsFile = join(dir, `run-announcement-${String(process.pid)}.json`);
    childArgs = [...shellSafeSettingsArgs(extra, settingsFile), ...userArgs];
  }

  const child = spawn(resolved.viaShell ? `"${resolved.command}"` : resolved.command, childArgs, {
    stdio: 'inherit',
    env: { ...process.env, ...runEnv(config.port, config.localToken, process.env, config.profiles[config.activeProfile]?.quirks ?? [], config.agents ?? {}) },
    shell: resolved.viaShell,
  });
  return await new Promise<number>((resolve) => {
    const done = (code: number): void => {
      if (settingsFile !== undefined) {
        try {
          unlinkSync(settingsFile);
        } catch {
          // best effort: a leftover settings file costs nothing
        }
      }
      resolve(code);
    };
    child.on('error', (e) => {
      console.error(`failed to run "${head}": ${e.message}`);
      done(1);
    });
    child.on('exit', (code) => done(code ?? 1));
  });
}
