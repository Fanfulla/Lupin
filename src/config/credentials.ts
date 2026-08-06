// Credential store (SPEC-CLI §4, DESIGN-OAUTH §3.2): ~/.lupin/credentials.json,
// 600, atomic tmp+rename writes. Holds plain API keys (string values) and OAuth
// tokens (objects under "oauth/<provider>" keys). Keys never live in config or
// logs. The OS keychain (@napi-rs/keyring) IS the default backend when its
// probe passes (ADR-26); this file keeps the file-600 store as fallback and
// routes every public function through the selected backend.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createKeychainStore,
  keychainLabel,
  loadKeyringModule,
  probeKeychain,
  type KeychainStore,
  type KeyringModule,
} from './keychain.js';

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms, computed from expires_in at grant time */
  expiresAt: number;
  /** original token lifetime in ms (drives the kimi-cli half-life refresh rule) */
  lifetimeMs?: number;
  scope?: string;
  tokenType: string;
}

const REFRESH_FLOOR_MS = 300_000; // 5 min (DESIGN-OAUTH §4.3)

export function credentialsPath(): string {
  return (
    process.env.LUPIN_CREDENTIALS ?? join(process.env.LUPIN_DIR ?? join(homedir(), '.lupin'), 'credentials.json')
  );
}

function loadRaw(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function saveRaw(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600); // best effort (no-op semantics on Windows ACLs)
  } catch {
    // never fatal: the file is already user-profile scoped
  }
}

// --- Backend selection (design §Selezione, cached once per process) --------

type ActiveStore = { kind: 'keychain'; store: KeychainStore } | { kind: 'file' };

let cachedStore: ActiveStore | undefined;
/** undefined = use the real loader; null = force "module absent"; module = injected. */
let injectedKeyring: KeyringModule | null | undefined;

/**
 * Composition/test seam: inject a keyring module (or its absence) and reset
 * the per-process selection cache. Call with no args to restore the real
 * loader. Selection is cached because the probe writes a real entry.
 */
export function configureCredentialStore(opts?: { keyring?: KeyringModule | null }): void {
  injectedKeyring = opts?.keyring;
  cachedStore = undefined;
}

function activeStore(): ActiveStore {
  if (cachedStore !== undefined) return cachedStore;
  // Rule 1-2 (design): an explicit file location or an explicit opt-out always
  // means file: this is also what keeps every pre-keychain test untouched.
  if (process.env.LUPIN_CREDENTIALS !== undefined || process.env.LUPIN_CREDSTORE === 'file') {
    cachedStore = { kind: 'file' };
    return cachedStore;
  }
  const mod = injectedKeyring === undefined ? loadKeyringModule() : (injectedKeyring ?? undefined);
  cachedStore =
    mod !== undefined && probeKeychain(mod) ? { kind: 'keychain', store: createKeychainStore(mod) } : { kind: 'file' };
  return cachedStore;
}

/** Where secrets live, for status lines and logs (SPEC-CLI §4 visibility). */
export function credentialStoreLabel(): string {
  return activeStore().kind === 'keychain' ? keychainLabel() : `file 600 (${credentialsPath()})`;
}

/** Plain API keys only (string values). File view: enumeration never hits the keychain. */
export function loadCredentials(path: string = credentialsPath()): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(loadRaw(path))) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

export function getCredential(ref: string, path?: string): string | undefined {
  const s = path === undefined ? activeStore() : undefined;
  if (s === undefined || s.kind === 'file') return loadCredentials(path ?? credentialsPath())[ref];
  const hit = s.store.get(ref);
  if (hit !== undefined) return hit;
  const fromFile = loadRaw(credentialsPath())[ref];
  if (typeof fromFile !== 'string') return undefined;
  promote(s.store, ref, fromFile);
  return fromFile;
}

export function setCredential(ref: string, value: string, path?: string): void {
  const s = path === undefined ? activeStore() : undefined;
  if (s === undefined || s.kind === 'file') {
    const p = path ?? credentialsPath();
    const all = loadRaw(p);
    all[ref] = value;
    saveRaw(p, all);
    return;
  }
  s.store.set(ref, value);
  // A set without a prior read never triggers lazy promotion, so a file-era
  // copy of a superseded secret would survive on disk forever and could be
  // resurrected if the keychain entry later disappears: the tombstone
  // already does this for deletes: a set is a supersession and must bury
  // the old copy the same way. Buried under the marker, not erased (ADR-43).
  buryFileKey(ref);
}

function oauthKey(provider: string): string {
  return `oauth/${provider}`;
}

function parseOAuth(raw: unknown): OAuthTokens | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const t = raw as Record<string, unknown>;
  if (typeof t['accessToken'] !== 'string' || typeof t['expiresAt'] !== 'number') return undefined;
  return raw as unknown as OAuthTokens;
}

export function getOAuthTokens(provider: string, path?: string): OAuthTokens | undefined {
  const s = path === undefined ? activeStore() : undefined;
  if (s === undefined || s.kind === 'file') return parseOAuth(loadRaw(path ?? credentialsPath())[oauthKey(provider)]);
  const raw = s.store.get(oauthKey(provider));
  if (raw !== undefined) {
    try {
      return parseOAuth(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }
  const fromFile = parseOAuth(loadRaw(credentialsPath())[oauthKey(provider)]);
  if (fromFile === undefined) return undefined;
  promote(s.store, oauthKey(provider), JSON.stringify(fromFile));
  return fromFile;
}

export function setOAuthTokens(provider: string, tokens: OAuthTokens, path?: string): void {
  const s = path === undefined ? activeStore() : undefined;
  if (s === undefined || s.kind === 'file') {
    const p = path ?? credentialsPath();
    const all = loadRaw(p);
    all[oauthKey(provider)] = tokens;
    saveRaw(p, all);
    return;
  }
  s.store.set(oauthKey(provider), JSON.stringify(tokens));
  // Same rationale as setCredential: a set without a prior read never
  // triggers lazy promotion, so the stale file copy must be buried here too.
  buryFileKey(oauthKey(provider));
}

/** Tombstone (DESIGN-OAUTH §4.3): rejected refresh tokens are never reused.
 *  In keychain mode the FILE copy dies too, or promotion would resurrect it. */
export function deleteOAuthTokens(provider: string, path?: string): void {
  const s = path === undefined ? activeStore() : undefined;
  if (s !== undefined && s.kind === 'keychain') {
    s.store.delete(oauthKey(provider));
    removeFileKey(oauthKey(provider));
    return;
  }
  const p = path ?? credentialsPath();
  const all = loadRaw(p);
  if (oauthKey(provider) in all) {
    delete all[oauthKey(provider)];
    saveRaw(p, all);
  }
}

/** Removes one key from the default file, only touching it if the key exists. */
function removeFileKey(ref: string): void {
  const p = credentialsPath();
  const all = loadRaw(p);
  if (ref in all) {
    delete all[ref];
    saveRaw(p, all);
  }
}

// --- The keychain marker (ADR-43) ---------------------------------------
//
// Whether an install HAS a keychain depends on an optional native module, so
// a keychain-capable install can move a secret that a file-only install on
// the same machine then cannot see (split-brain, seen live 2026-08-05). The
// marker is the non-secret trace left in the file when that happens: the
// file-only side can then say where the credential went instead of advising
// a pointless re-login. It is an object whose only string field is a date,
// so loadCredentials (strings only) and parseOAuth (needs accessToken) both
// treat it as absence: only the miss-path error messages consult it.

const KEYCHAIN_MARKER_KEY = '__inKeychain';

function parseKeychainMarker(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  return m[KEYCHAIN_MARKER_KEY] === true && typeof m['movedAt'] === 'string' ? m['movedAt'] : undefined;
}

/**
 * The honest hint for a file-only install: "this credential lives in the OS
 * keychain, moved there on <date>". Undefined when there is no marker, and
 * always undefined when the keychain is active here: this install reads the
 * real entry, so a marker with no keychain entry means the credential is
 * gone, not hidden.
 */
export function movedToKeychainAt(ref: string): string | undefined {
  if (activeStore().kind === 'keychain') return undefined;
  return parseKeychainMarker(loadRaw(credentialsPath())[ref]);
}

/**
 * Replaces a file copy with the marker; a no-op when the file never had the
 * key, so a pure-keychain write still never creates credentials.json (the
 * 2026-07-22 design rule).
 */
function buryFileKey(ref: string): void {
  const p = credentialsPath();
  const all = loadRaw(p);
  if (ref in all) {
    all[ref] = { [KEYCHAIN_MARKER_KEY]: true, movedAt: new Date().toISOString() };
    saveRaw(p, all);
  }
}

/**
 * Lazy promotion (design §Visibilità): keychain active but the secret lives
 * only in the file (e.g. a LUPIN_CREDSTORE=file period). The read serves it,
 * copies it into the keychain, VERIFIES it by reading it back, and only after
 * that verification buries the file copy under the non-secret marker
 * (ADR-43): a flaky keychain must never cost the only copy. Steady state:
 * zero secrets on disk.
 */
function promote(store: KeychainStore, ref: string, value: string): void {
  try {
    store.set(ref, value);
    if (store.get(ref) === value) buryFileKey(ref);
  } catch {
    // Promotion is opportunistic: a backend that refuses the value (seen live
    // 2026-08-05, Windows blob limit) must not break the read that already
    // holds it. The file copy stays, and the next read tries again.
  }
}

/** kimi-cli strategy: refresh when remaining < max(5 min, half the token lifetime). */
export function oauthNeedsRefresh(tokens: OAuthTokens, now: number = Date.now()): boolean {
  const threshold = Math.max(REFRESH_FLOOR_MS, (tokens.lifetimeMs ?? 0) / 2);
  return tokens.expiresAt - now < threshold;
}

/**
 * Stable OAuth device id (DESIGN-OAUTH §6): a fresh id each run would register
 * a NEW device in the provider console every time, so it is generated once and
 * persisted (0600) like kimi-cli does. Never the official CLIs' own id -
 * Lupin's identity is honest and its own.
 */
export function getDeviceId(path: string = deviceIdPath()): string {
  if (existsSync(path)) {
    const id = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  }
  const id = randomBytes(16).toString('hex'); // uuid4().hex form, 32 hex chars
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, id, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort on Windows ACLs
  }
  return id;
}

export function deviceIdPath(): string {
  // Same rule as config and credentials: LUPIN_DIR moves the WHOLE home. A
  // sandboxed run must never read or mint the real user's device identity
  // (residual split-brain found by the 2026-07-24 adversarial review).
  const dir = process.env.LUPIN_DIR ?? join(homedir(), '.lupin');
  return process.env.LUPIN_DEVICE_ID ?? join(dir, 'device_id');
}
