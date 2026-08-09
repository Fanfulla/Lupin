// `lupin top` (SPEC-CLI §1, backlog #8): the console of truth in the terminal.
// It answers, live, the question a proxy user cannot otherwise answer: which
// model is REALLY serving this session, is the profile healthy, and what has
// just gone through.
//
// Deliberately plain: ANSI escapes plus polling, no ink, no React, no
// dependency at all. It works over SSH and in Windows Terminal, and the whole
// screen is a pure function of a snapshot, so the layout is testable without a
// terminal (the doctor's split, applied to a UI).

import { statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { loadConfig, saveConfig, type LupinConfig } from '../config/config.js';
import { logfilePath } from '../server/daemon.js';
import { parseLogLines, type RequestLogLine } from '../server/log.js';
import { bannerLine } from './banner.js';

const REFRESH_MS = 1000;
const TAIL_BYTES = 64 * 1024; // enough for a few hundred lines, bounded on purpose
const TAIL_ROWS = 12;

export interface HealthSnapshot {
  activeProfile: string;
  slots: Partial<Record<'opus' | 'sonnet' | 'haiku', string>>;
  health: Record<string, string>;
}

export interface TopSnapshot {
  config: LupinConfig;
  /** Absent when the daemon does not answer: the screen says so instead of guessing. */
  health?: HealthSnapshot;
  recent: RequestLogLine[];
}

/** Reads only the tail of the log: a session's log grows without bound. */
export function readLogTail(path: string, maxBytes = TAIL_BYTES): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line is garbage: drop it rather than parse half a record.
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    closeSync(fd);
  }
}

/** The request lines worth watching, newest last, bounded to what fits. */
export function recentRequests(lines: readonly RequestLogLine[], rows = TAIL_ROWS): RequestLogLine[] {
  return lines.filter((l) => l.path === '/v1/messages' && l.usage === undefined).slice(-rows);
}

function markers(line: RequestLogLine): string {
  const parts: string[] = [];
  if (line.routed !== undefined) parts.push(`routed:${line.routed}`);
  if (line.agentRoute !== undefined) parts.push(`agent:${line.agentRoute}`);
  if (line.failedOver !== undefined) parts.push(`failover<-${line.failedOver}`);
  if (line.cooldown !== undefined) parts.push(`cooldown:${line.cooldown}`);
  if (line.retryAfterMs !== undefined) parts.push(`waited:${String(line.retryAfterMs)}ms`);
  if (line.dialect !== undefined && line.dialect.length > 0) parts.push(`dialect:${line.dialect.join('+')}`);
  // No value to print: the field is either there or absent (§5quater).
  if (line.editHint === true) parts.push('editHint');
  if (line.streamError !== undefined) parts.push(`streamError:${line.streamError}`);
  return parts.join(' ');
}

/** The whole screen as lines of text: pure, so the layout has tests. */
export function renderTop(snap: TopSnapshot, now = new Date()): string[] {
  const out: string[] = [];
  const daemon = snap.health === undefined ? 'daemon DOWN' : `daemon up, port ${String(snap.config.port)}`;
  out.push(bannerLine());
  out.push(`  ${daemon}   active: ${snap.config.activeProfile}   ${now.toTimeString().slice(0, 8)}`);
  out.push('');

  const slot = (t: unknown): string => (typeof t === 'string' ? t : `->${(t as { profile: string }).profile}`);
  const rows = Object.entries(snap.config.profiles).map(([name, p]) => ({
    active: name === snap.config.activeProfile ? '*' : ' ',
    name,
    mode: p.mode,
    slots: `${slot(p.slots.opus)}/${slot(p.slots.sonnet)}/${slot(p.slots.haiku)}`,
    health: snap.health?.health[name] ?? '-',
    doctor:
      p.lastDoctor === undefined ? '-' : `${String(p.lastDoctor.score)}/${String(p.lastDoctor.max)} ${p.lastDoctor.date}`,
  }));
  // Widths follow the content: local model names are long enough to push every
  // later column out of line if the table assumes a size.
  const w = {
    name: Math.max(7, ...rows.map((r) => r.name.length)),
    mode: Math.max(4, ...rows.map((r) => r.mode.length)),
    slots: Math.max(17, ...rows.map((r) => r.slots.length)),
    health: Math.max(6, ...rows.map((r) => r.health.length)),
  };
  out.push(
    `  ${'profile'.padEnd(w.name)}  ${'mode'.padEnd(w.mode)}  ${'opus/sonnet/haiku'.padEnd(w.slots)}  ${'health'.padEnd(w.health)}  doctor`,
  );
  for (const r of rows) {
    out.push(
      `${r.active} ${r.name.padEnd(w.name)}  ${r.mode.padEnd(w.mode)}  ${r.slots.padEnd(w.slots)}  ${r.health.padEnd(w.health)}  ${r.doctor}`,
    );
  }
  out.push('');

  // What the active profile REALLY resolves to, straight from the daemon.
  if (snap.health !== undefined) {
    const s = snap.health.slots;
    out.push(`  serving now: opus=${s.opus ?? '-'}  sonnet=${s.sonnet ?? '-'}  haiku=${s.haiku ?? '-'}`);
  } else {
    out.push('  serving now: unknown (the daemon is not answering: `lupin run -- claude` starts it)');
  }
  out.push('');

  out.push('  recent requests');
  if (snap.recent.length === 0) {
    out.push('    (nothing yet)');
  }
  for (const line of snap.recent) {
    const when = line.ts.slice(11, 19);
    const status = String(line.status).padStart(3);
    const latency = `${String(line.latencyMs)}ms`.padStart(7);
    out.push(`    ${when} ${status} ${latency}  ${line.profile}/${line.model}  ${markers(line)}`.trimEnd());
  }
  out.push('');
  out.push('  q quit    1-9 switch active profile    (the view refreshes every second)');
  return out;
}

async function fetchHealth(port: number): Promise<HealthSnapshot | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(800) });
    if (!res.ok) return undefined;
    // The shape is checked, not just asserted: whatever answers on this port
    // (an older daemon, another program entirely) must degrade to "daemon
    // DOWN", never crash a screen that holds the terminal in raw mode
    // (audit 2026-07-29).
    const body = (await res.json()) as Partial<HealthSnapshot>;
    if (typeof body.health !== 'object' || body.health === null) return undefined;
    if (typeof body.slots !== 'object' || body.slots === null) return undefined;
    return body as HealthSnapshot;
  } catch {
    return undefined;
  }
}

function snapshot(config: LupinConfig, health: HealthSnapshot | undefined): TopSnapshot {
  const lines = parseLogLines(readLogTail(logfilePath()));
  return { config, ...(health !== undefined ? { health } : {}), recent: recentRequests(lines) };
}

export async function topCommand(): Promise<number> {
  let config: LupinConfig;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet: run `lupin init` first');
    return 1;
  }
  if (!process.stdout.isTTY) {
    // Piped or redirected: print one frame and leave. A repainting screen in a
    // pipe is noise, and a command that hangs there is worse.
    console.log(renderTop(snapshot(config, await fetchHealth(config.port))).join('\n'));
    return 0;
  }

  const stdin = process.stdin;
  const restore = (): void => {
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
    process.stdout.write('\u001b[?25h'); // cursor back on
  };
  // stdout can be a TTY while stdin is not (`lupin top < file`): only a TTY
  // stdin has setRawMode at all (audit 2026-07-29).
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  process.stdout.write('\u001b[?25l'); // hide the cursor: it flickers on repaint

  let stop = false;
  stdin.on('data', (key: string) => {
    if (key === 'q' || key === '') {
      // ctrl-c must be handled by hand: raw mode means the terminal no longer
      // turns it into a signal for us.
      stop = true;
      return;
    }
    // 1-9: switch the active profile, the one action worth having here (the
    // whole point of the screen is seeing where traffic goes, and moving it).
    const index = Number(key) - 1;
    const names = Object.keys(config.profiles);
    const picked = Number.isInteger(index) ? names[index] : undefined;
    if (picked !== undefined) {
      config.activeProfile = picked;
      try {
        saveConfig(config);
      } catch {
        // a read-only config is not a reason to kill the view
      }
    }
  });

  // The finally is the guarantee: whatever throws mid-frame, the terminal
  // gets its raw mode off and its cursor back (audit 2026-07-29).
  try {
    while (!stop) {
      const health = await fetchHealth(config.port);
      try {
        config = loadConfig(); // pick up `lupin use` from another terminal
      } catch {
        // keep the last good config rather than blanking the screen
      }
      const frame = renderTop(snapshot(config, health)).join('\n');
      process.stdout.write(`\u001b[H\u001b[2J${frame}\n`);
      await new Promise((r) => setTimeout(r, REFRESH_MS));
    }
  } finally {
    restore();
  }
  return 0;
}
