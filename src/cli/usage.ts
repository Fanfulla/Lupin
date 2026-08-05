// `lupin usage [--days N] [--json]` (SPEC-CLI §1): what the proxy actually
// served, read back from its own log. Offline and local: no network, no
// upload, nothing persisted that was not already on disk.
//
// The proxy log is the only place that sees 100% of the traffic: Claude Code
// subagents talk to it but write nothing into the transcript, so a
// transcript-based count misses them entirely (measured 2026-07-20: 332
// requests against 113 visible turns).

import { existsSync, readFileSync } from 'node:fs';
import { logfilePath } from '../server/daemon.js';
import { aggregateUsage, parseLogLines, type UsageBucket } from '../server/log.js';

/** Compact token counts: 1.2M reads better than 1234567 in a table. */
export function humanTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Share of served input that came from cache. Undefined when the provider
 * never reported reads: an absent receipt must not print as 0%.
 */
export function cacheShare(b: UsageBucket): number | undefined {
  if (b.cacheRead === undefined) return undefined;
  const served = (b.input ?? 0) + b.cacheRead + (b.cacheCreate ?? 0);
  return served === 0 ? 0 : Math.round((100 * b.cacheRead) / served);
}

export function renderUsage(buckets: readonly UsageBucket[]): string {
  const cell = (n: number | undefined): string => (n === undefined ? '-' : humanTokens(n));
  const rows = buckets.map((b) => ({
    profile: b.profile,
    model: b.model,
    requests: String(b.requests),
    input: cell(b.input),
    output: cell(b.output),
    cacheRead: cell(b.cacheRead),
    share: cacheShare(b) === undefined ? '-' : `${String(cacheShare(b))}%`,
  }));
  const sum = (pick: (b: UsageBucket) => number | undefined): number | undefined =>
    buckets.reduce<number | undefined>((acc, b) => {
      const v = pick(b);
      return v === undefined ? acc : (acc ?? 0) + v;
    }, undefined);
  rows.push({
    profile: 'total',
    model: '',
    requests: String(buckets.reduce((acc, b) => acc + b.requests, 0)),
    input: cell(sum((b) => b.input)),
    output: cell(sum((b) => b.output)),
    cacheRead: cell(sum((b) => b.cacheRead)),
    share: '',
  });

  const w = {
    profile: Math.max(7, ...rows.map((r) => r.profile.length)),
    model: Math.max(5, ...rows.map((r) => r.model.length)),
    requests: Math.max(3, ...rows.map((r) => r.requests.length)),
    input: Math.max(2, ...rows.map((r) => r.input.length)),
    output: Math.max(3, ...rows.map((r) => r.output.length)),
    cacheRead: Math.max(10, ...rows.map((r) => r.cacheRead.length)),
  };
  const line = (r: (typeof rows)[number]): string =>
    `  ${r.profile.padEnd(w.profile)}  ${r.model.padEnd(w.model)}  ${r.requests.padStart(w.requests)}  ${r.input.padStart(w.input)}  ${r.output.padStart(w.output)}  ${r.cacheRead.padStart(w.cacheRead)}  ${r.share}`;

  const header = `  ${'profile'.padEnd(w.profile)}  ${'model'.padEnd(w.model)}  ${'req'.padStart(w.requests)}  ${'in'.padStart(w.input)}  ${'out'.padStart(w.output)}  ${'cache read'.padStart(w.cacheRead)}  cache %`;
  return [header, ...rows.map(line)].join('\n');
}

export function usageCommand(args: string[]): number {
  const json = args.includes('--json');
  const daysIdx = args.indexOf('--days');
  let sinceMs: number | undefined;
  if (daysIdx !== -1) {
    const days = Number(args[daysIdx + 1]);
    if (!Number.isFinite(days) || days <= 0) {
      console.error('usage: lupin usage [--days <N>] [--json]');
      return 1;
    }
    sinceMs = Date.now() - days * 86_400_000;
  }

  const path = logfilePath();
  if (!existsSync(path)) {
    console.error(`no log yet at ${path}: run a session with \`lupin run -- claude\` first`);
    return 1;
  }
  const buckets = aggregateUsage(parseLogLines(readFileSync(path, 'utf8')), sinceMs);

  if (json) {
    console.log(JSON.stringify({ since: sinceMs, buckets }, null, 2));
    return 0;
  }
  if (buckets.length === 0) {
    console.log(`no traffic recorded${daysIdx === -1 ? '' : ' in that window'} (${path})`);
    return 0;
  }
  console.log(`Usage${daysIdx === -1 ? '' : ` (last ${String(args[daysIdx + 1])} days)`}, from ${path}\n`);
  console.log(renderUsage(buckets));
  console.log('\n  "-" = never measured: the provider did not report the field, or the log predates the usage tap.');
  console.log('  It is not a zero.');
  return 0;
}
