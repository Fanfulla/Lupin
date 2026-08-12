// `lupin list` (SPEC-CLI §1): profiles table, active one marked, failover
// health from the live daemon when it answers (SPEC-PROVIDERS §4sexies).

import { loadConfig, type SlotTarget } from '../config/config.js';
import { serverAlive } from '../server/daemon.js';

function slotLabel(t: SlotTarget): string {
  return typeof t === 'string' ? t : `→${t.profile}`;
}

interface HealthResponse {
  health?: Record<string, string>;
}

/** Failover health lives in the daemon's memory: read it live, tolerate it down. */
async function fetchHealth(port: number): Promise<Record<string, string>> {
  try {
    const res = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return {};
    const body = (await res.json()) as HealthResponse;
    return body.health ?? {};
  } catch {
    return {};
  }
}

export async function listCommand(): Promise<number> {
  let config;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet: add a provider from the hub (run: lupin)');
    return 1;
  }

  const daemonUp = await serverAlive(config.port);
  const health = daemonUp ? await fetchHealth(config.port) : {};

  const rows = Object.entries(config.profiles).map(([name, p]) => ({
    marker: name === config.activeProfile ? '*' : ' ',
    name,
    provider: p.provider,
    mode: p.mode,
    opus: slotLabel(p.slots.opus),
    sonnet: slotLabel(p.slots.sonnet),
    haiku: slotLabel(p.slots.haiku),
    failover: p.failover ?? '-',
    health: health[name] ?? '-',
    doctor: p.lastDoctor !== undefined ? `${String(p.lastDoctor.score)}/${String(p.lastDoctor.max)} (${p.lastDoctor.date})` : '-',
  }));

  const widths = {
    name: Math.max(7, ...rows.map((r) => r.name.length)),
    provider: Math.max(8, ...rows.map((r) => r.provider.length)),
    mode: Math.max(4, ...rows.map((r) => r.mode.length)),
    opus: Math.max(4, ...rows.map((r) => r.opus.length)),
    sonnet: Math.max(6, ...rows.map((r) => r.sonnet.length)),
  };

  const haikuW = Math.max(5, ...rows.map((r) => r.haiku.length));
  const failoverW = Math.max(8, ...rows.map((r) => r.failover.length));
  const healthW = Math.max(6, ...rows.map((r) => r.health.length));
  console.log(
    `  ${'profile'.padEnd(widths.name)}  ${'provider'.padEnd(widths.provider)}  ${'mode'.padEnd(widths.mode)}  ${'opus'.padEnd(widths.opus)}  ${'sonnet'.padEnd(widths.sonnet)}  ${'haiku'.padEnd(haikuW)}  ${'failover'.padEnd(failoverW)}  ${'health'.padEnd(healthW)}  doctor`,
  );
  for (const r of rows) {
    console.log(
      `${r.marker} ${r.name.padEnd(widths.name)}  ${r.provider.padEnd(widths.provider)}  ${r.mode.padEnd(widths.mode)}  ${r.opus.padEnd(widths.opus)}  ${r.sonnet.padEnd(widths.sonnet)}  ${r.haiku.padEnd(haikuW)}  ${r.failover.padEnd(failoverW)}  ${r.health.padEnd(healthW)}  ${r.doctor}`,
    );
  }
  console.log(`\n* = active. Switch with: lupin use <profile>`);
  if (!daemonUp) console.log('(daemon not running: health column shows live failover state only when it is up)');
  return 0;
}
