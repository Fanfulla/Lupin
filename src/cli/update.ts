// `lupin update` (SPEC-CLI §1, ADR-49): explicit self-update. One registry
// check, npm doing the install with its own output visible, and the sidecar
// rebuilt to the matching version when one is on the PATH and a Rust toolchain
// exists. The registry call happens exclusively on this command: no startup
// check, no phone-home (§4.3).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CLIENT_VERSION } from '../providers/identity.js';

export const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/lupin-code/latest';

/** x.y.z, digits only. Prerelease or anything fancier is not comparable here. */
export function parseVersion(v: string): number[] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1, 0, 1, or undefined when either side does not parse. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 | undefined {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === undefined || pb === undefined) return undefined;
  for (let i = 0; i < 3; i++) {
    const x = pa[i] as number;
    const y = pb[i] as number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

export interface UpdateState {
  current: string;
  latest: string;
  /** Full path of the `lupin-tui` on the PATH, when one exists. */
  sidecarPath?: string;
  /** What that sidecar answers to --version, when it answers at all. */
  sidecarVersion?: string;
  cargoAvailable: boolean;
}

export type UpdatePlan =
  /** One of the two package versions does not parse: decide nothing, say both. */
  | { kind: 'incomparable' }
  | { kind: 'upToDate'; rebuildSidecar: boolean; sidecarHint: boolean }
  | { kind: 'update'; rebuildSidecar: boolean; sidecarHint: boolean };

/**
 * What this update should do, from the observed state alone (ADR-49): the
 * executor below only carries it out. A sidecar is rebuilt only when the user
 * already built one AND the toolchain is there; a sidecar with no toolchain
 * earns the manual hint; no sidecar earns silence (never install a surface the
 * user did not choose). A package already at the latest can still carry a
 * STALE sidecar (the bootstrap `npm i -g` of an install predating this
 * command, or a rebuild that failed last time): a known-different sidecar
 * version is rebuilt then too, an unknown one is left alone (a guess could
 * rebuild a healthy binary forever).
 */
export function planUpdate(state: UpdateState): UpdatePlan {
  const cmp = compareVersions(state.current, state.latest);
  if (cmp === undefined) return { kind: 'incomparable' };
  const hasSidecar = state.sidecarPath !== undefined;
  if (cmp >= 0) {
    const stale = hasSidecar && state.sidecarVersion !== undefined && state.sidecarVersion !== state.latest;
    return { kind: 'upToDate', rebuildSidecar: stale && state.cargoAvailable, sidecarHint: stale && !state.cargoAvailable };
  }
  return {
    kind: 'update',
    rebuildSidecar: hasSidecar && state.cargoAvailable,
    sidecarHint: hasSidecar && !state.cargoAvailable,
  };
}

/** The latest published version, from the registry's own `latest` dist-tag. */
export async function fetchLatestVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`registry answered HTTP ${String(res.status)}`);
  const body = (await res.json()) as { version?: unknown };
  if (typeof body.version !== 'string' || body.version === '') {
    throw new Error('registry answer carries no version field');
  }
  return body.version;
}

/**
 * Where `name` lives on the PATH, cross-platform (resolveHead in run.ts is the
 * Windows spawn rule and deliberately does not search POSIX PATHs; here the
 * full path is the point, since the rebuilt binary is copied over it).
 */
export function findOnPath(
  name: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const exts = platform === 'win32' ? (env['PATHEXT'] ?? '.com;.exe;.bat;.cmd').split(';').filter((e) => e !== '') : [''];
  for (const dir of (env['PATH'] ?? '').split(delimiter).filter((d) => d !== '')) {
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

const MANUAL_INSTALL = 'npm i -g lupin-code@latest';
const MANUAL_TUI = 'cargo build --release --manifest-path <package>/tui/Cargo.toml';

/** What the sidecar answers to --version ("lupin-tui 0.2.2"), or undefined. */
function readSidecarVersion(sidecarPath: string): string | undefined {
  const res = spawnSync(sidecarPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (res.status !== 0 || typeof res.stdout !== 'string') return undefined;
  const m = /lupin-tui\s+(\S+)/.exec(res.stdout);
  return m === null ? undefined : m[1];
}

export async function updateCommand(fetchImpl: typeof fetch = fetch): Promise<number> {
  let latest: string;
  try {
    latest = await fetchLatestVersion(fetchImpl);
  } catch (e) {
    console.error(`could not read the npm registry: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`  check the connection, or update by hand: ${MANUAL_INSTALL}`);
    return 1;
  }

  const sidecarPath = findOnPath('lupin-tui');
  const sidecarVersion = sidecarPath === undefined ? undefined : readSidecarVersion(sidecarPath);
  const cargoAvailable = findOnPath('cargo') !== undefined;
  const plan = planUpdate({
    current: CLIENT_VERSION,
    latest,
    ...(sidecarPath !== undefined ? { sidecarPath } : {}),
    ...(sidecarVersion !== undefined ? { sidecarVersion } : {}),
    cargoAvailable,
  });

  if (plan.kind === 'upToDate') {
    console.log(`the package is already the latest: ${CLIENT_VERSION} (registry says ${latest})`);
    if (plan.sidecarHint) {
      console.log(`the lupin-tui sidecar is behind (${String(sidecarVersion)}) and no cargo was found to rebuild it:`);
      console.log(`  ${MANUAL_TUI}`);
      return 0;
    }
    if (!plan.rebuildSidecar) return 0;
    console.log(`the lupin-tui sidecar is behind (${String(sidecarVersion)})`);
    return rebuildSidecar(sidecarPath as string, latest);
  }
  if (plan.kind === 'incomparable') {
    console.error(`cannot compare versions: running ${CLIENT_VERSION}, registry says ${latest}`);
    console.error(`  decide yourself: ${MANUAL_INSTALL}`);
    return 1;
  }

  console.log(`updating lupin-code ${CLIENT_VERSION} -> ${latest} (global npm install)`);
  // Fixed args only on this shell: nothing user-controlled travels through it
  // (the ADR-29 rule; npm is a .cmd shim on Windows, so the shell is required).
  const install = spawnSync('npm', ['i', '-g', 'lupin-code@latest'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (install.status !== 0) {
    console.error(`npm exited with ${String(install.status ?? 'a signal')}: the update did not happen`);
    return 1;
  }
  console.log(`✓ lupin-code ${latest} installed`);

  if (plan.sidecarHint) {
    console.log('the lupin-tui sidecar on your PATH is source-built and no cargo was found to rebuild it:');
    console.log(`  ${MANUAL_TUI}`);
    return 0;
  }
  if (!plan.rebuildSidecar) return 0;
  return rebuildSidecar(sidecarPath as string, latest);
}

/**
 * Rebuild the sidecar from the sources the tarball ships (ADR-49) and replace
 * the binary on the PATH, only on build success. The target dir lives under
 * the system temp dir: node_modules stays clean and the cargo cache survives
 * across updates.
 */
function rebuildSidecar(sidecarPath: string, latest: string): number {
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const rootDir = root.status === 0 ? root.stdout.trim() : '';
  const manifest = join(rootDir, 'lupin-code', 'tui', 'Cargo.toml');
  if (rootDir === '' || !existsSync(manifest)) {
    console.error('the installed package carries no tui/ sources (pre-0.2.2 tarball?): rebuild from a clone:');
    console.error(`  ${MANUAL_TUI}`);
    return 1;
  }
  console.log(`rebuilding the lupin-tui sidecar to ${latest} (this is a cargo release build)`);
  const targetDir = join(tmpdir(), 'lupin-tui-build');
  const build = spawnSync('cargo', ['build', '--release', '--manifest-path', manifest], {
    stdio: 'inherit',
    env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  });
  if (build.status !== 0) {
    console.error('the sidecar build failed: the binary on your PATH was NOT touched');
    return 1;
  }
  const built = join(targetDir, 'release', process.platform === 'win32' ? 'lupin-tui.exe' : 'lupin-tui');
  try {
    copyFileSync(built, sidecarPath);
  } catch (e) {
    console.error(`built, but could not replace ${sidecarPath}: ${e instanceof Error ? e.message : String(e)}`);
    console.error('  close the running TUI and run `lupin update` again, or copy it yourself:');
    console.error(`  ${built}`);
    return 1;
  }
  console.log(`✓ lupin-tui ${latest} in place: ${sidecarPath}`);
  return 0;
}
