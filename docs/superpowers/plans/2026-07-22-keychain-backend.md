# OS Keychain Credential Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Credentials (API keys + OAuth tokens) live in the OS keychain by default, with the existing file-600 store as automatic visible fallback — closing the last M3 item per SPEC-CLI §4 and `docs/superpowers/specs/2026-07-22-keychain-design.md`.

**Architecture:** `src/config/credentials.ts` keeps every exported function with the same signature; internally a cached per-process selection picks the backend (explicit path/`LUPIN_CREDENTIALS` → file; `LUPIN_CREDSTORE=file` → file; runtime-probed keychain → keychain; else file). A new `src/config/keychain.ts` owns module loading (`createRequire`, sync), the probe, and a chunking store for Windows' ~2560-byte blob cap. Lazy promotion moves file secrets into the keychain with read-back verification.

**Tech Stack:** TypeScript strict ESM, Node ≥20, vitest. New dependency: `@napi-rs/keyring` ^1.3.0 in `optionalDependencies` (prebuilt napi binaries; sync `Entry` API: `getPassword(): string | null`, `setPassword(p): void`, `deletePassword(): boolean` — verified on the published `index.d.ts` 2026-07-22).

## Global Constraints

- **No mandatory native dependency** (CLAUDE.md rule 6, SPEC-CLI §75): `@napi-rs/keyring` goes in `optionalDependencies`; every path must work when it is absent.
- **Same exported signatures** in `credentials.ts` (design §Architettura): `credentialsPath, loadCredentials, getCredential, setCredential, getOAuthTokens, setOAuthTokens, deleteOAuthTokens, oauthNeedsRefresh, getDeviceId, deviceIdPath` all keep working for existing callers.
- **Explicit path = explicit file** (design §Selezione 1): a `path` argument or `LUPIN_CREDENTIALS` set always means the file store — this is what keeps all existing tests green untouched.
- **Keys never in config or logs** (CLAUDE.md rule 7). The store label may be logged; values never.
- **No silent mid-process downgrade** (design §Errori): a keychain error after a successful probe propagates; only the probe itself selects the fallback.
- **`device_id` stays on file** (design; DESIGN-OAUTH §6).
- **Push after every commit** (user rule 2026-07-22): every commit step ends with `git push origin main`.
- All tests green + `npx tsc --noEmit` + `npx eslint src test` clean before each commit.

## File Structure

- `src/config/keychain.ts` (new): keyring module types + sync loader, probe, chunking `KeychainStore`, per-OS label. No imports from the rest of Lupin — leaf module.
- `src/config/credentials.ts` (modify): backend selection (cached), routing of every public function, lazy promotion, `credentialStoreLabel()` + `configureCredentialStore()` exports.
- `test/helpers/fake-keyring.ts` (new): in-memory `KeyringModule` for tests.
- `test/keychain.test.ts` (new): loader/probe/chunking unit tests.
- `test/credentials-store.test.ts` (new): selection rules + contract suite on both backends + promotion.
- `vitest.config.ts` (new): forces `LUPIN_CREDSTORE=file` for the whole suite so no test can ever touch the real OS keychain by accident; keychain tests opt out explicitly.
- `src/cli/daemonctl.ts`, `src/cli/init.ts`, `src/cli/login.ts`, `src/server/start.ts` (modify): one visibility line each.
- `package.json` (modify): `optionalDependencies`.
- Docs (modify): `docs/DECISIONS.md` (ADR-26), `docs/ARCHITECTURE.md`, `docs/SPEC-CLI.md` §4 note, `docs/ROADMAP.md` resume point.

---

### Task 1: Keyring module loader, probe, fake — `src/config/keychain.ts`

**Files:**
- Create: `src/config/keychain.ts`
- Create: `test/helpers/fake-keyring.ts`
- Create: `test/keychain.test.ts`
- Create: `vitest.config.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `KeyringEntry`, `KeyringModule`, `KEYCHAIN_SERVICE = 'lupin'`, `loadKeyringModule(): KeyringModule | undefined`, `probeKeychain(mod: KeyringModule): boolean`, `keychainLabel(platform?: NodeJS.Platform): string`; test helper `fakeKeyring(store?: Map<string, string>): KeyringModule`.

- [ ] **Step 1: Add the optional dependency and the vitest guard**

In `package.json`, after `"dependencies"`, add:

```json
  "optionalDependencies": {
    "@napi-rs/keyring": "^1.3.0"
  }
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // No test may ever touch the real OS keychain by accident: file mode is
    // the suite-wide default, keychain tests opt out explicitly (and inject a
    // fake module anyway).
    env: { LUPIN_CREDSTORE: 'file' },
  },
});
```

Run: `npm install`
Expected: exit 0; `node -e "console.log(require('@napi-rs/keyring').Entry !== undefined)"` prints `true` (prebuilt present on this machine).

- [ ] **Step 2: Write the failing tests**

Create `test/helpers/fake-keyring.ts`:

```ts
// In-memory KeyringModule for tests: same contract as @napi-rs/keyring's sync
// Entry (getPassword null on miss, deletePassword boolean), zero OS access.

import type { KeyringEntry, KeyringModule } from '../../src/config/keychain.js';

export function fakeKeyring(store: Map<string, string> = new Map()): KeyringModule & { raw: Map<string, string> } {
  class FakeEntry implements KeyringEntry {
    private readonly key: string;
    constructor(service: string, name: string) {
      this.key = `${service}/${name}`;
    }
    getPassword(): string | null {
      return store.get(this.key) ?? null;
    }
    setPassword(password: string): void {
      store.set(this.key, password);
    }
    deletePassword(): boolean {
      return store.delete(this.key);
    }
  }
  return { Entry: FakeEntry, raw: store };
}

/** A module whose every operation throws: the Linux-without-Secret-Service shape. */
export function brokenKeyring(): KeyringModule {
  class BrokenEntry implements KeyringEntry {
    constructor(_service: string, _name: string) {}
    getPassword(): string | null {
      throw new Error('no secret service');
    }
    setPassword(_password: string): void {
      throw new Error('no secret service');
    }
    deletePassword(): boolean {
      throw new Error('no secret service');
    }
  }
  return { Entry: BrokenEntry };
}
```

Create `test/keychain.test.ts`:

```ts
// OS keychain backend (design docs/superpowers/specs/2026-07-22-keychain-design.md).

import { describe, expect, it } from 'vitest';
import { KEYCHAIN_SERVICE, keychainLabel, loadKeyringModule, probeKeychain } from '../src/config/keychain.js';
import { brokenKeyring, fakeKeyring } from './helpers/fake-keyring.js';

describe('keyring module loader', () => {
  it('loads the optional module on this machine (sync, createRequire)', () => {
    // On dev machines the optionalDependency is installed; on a platform
    // without a prebuilt this returns undefined and the file store takes over.
    const mod = loadKeyringModule();
    expect(mod === undefined || typeof mod.Entry === 'function').toBe(true);
  });
});

describe('probeKeychain (a loaded module is not a working backend)', () => {
  it('a write/read/delete round-trip on a working module passes', () => {
    const mod = fakeKeyring();
    expect(probeKeychain(mod)).toBe(true);
  });

  it('the probe leaves nothing behind', () => {
    const mod = fakeKeyring();
    probeKeychain(mod);
    expect(mod.raw.size).toBe(0);
  });

  it('a module that throws at runtime fails the probe instead of crashing', () => {
    expect(probeKeychain(brokenKeyring())).toBe(false);
  });

  it('service name is the documented constant', () => {
    expect(KEYCHAIN_SERVICE).toBe('lupin');
  });
});

describe('keychainLabel', () => {
  it('names the real backend per OS', () => {
    expect(keychainLabel('win32')).toBe('Windows Credential Manager');
    expect(keychainLabel('darwin')).toBe('macOS Keychain');
    expect(keychainLabel('linux')).toBe('Secret Service (libsecret)');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run test/keychain.test.ts`
Expected: FAIL — `Cannot find module '../src/config/keychain.js'`.

- [ ] **Step 4: Write the implementation**

Create `src/config/keychain.ts`:

```ts
// OS keychain backend (SPEC-CLI §4; design docs/superpowers/specs/
// 2026-07-22-keychain-design.md). @napi-rs/keyring is an OPTIONAL native
// dependency: when the prebuilt is missing, loadKeyringModule returns
// undefined and the caller falls back to the file-600 store. Leaf module:
// imports nothing from the rest of Lupin.

import { createRequire } from 'node:module';

/** The sync Entry surface of @napi-rs/keyring (verified on index.d.ts 1.3.0). */
export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface KeyringModule {
  Entry: new (service: string, username: string) => KeyringEntry;
}

export const KEYCHAIN_SERVICE = 'lupin';

/** Sync load: the whole credential API is sync, so no dynamic import() here. */
export function loadKeyringModule(): KeyringModule | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require('@napi-rs/keyring') as KeyringModule;
  } catch {
    return undefined;
  }
}

/**
 * A loaded module is not a working backend: on Linux without a Secret Service
 * the import succeeds and every operation throws. One write/read/delete
 * round-trip proves it — and cleans up after itself.
 */
export function probeKeychain(mod: KeyringModule): boolean {
  try {
    const entry = new mod.Entry(KEYCHAIN_SERVICE, '__probe__');
    entry.setPassword('probe');
    const ok = entry.getPassword() === 'probe';
    entry.deletePassword();
    return ok;
  } catch {
    return false;
  }
}

/** Honest per-OS name, for status lines and logs — never for decisions. */
export function keychainLabel(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows Credential Manager';
    case 'darwin':
      return 'macOS Keychain';
    default:
      return 'Secret Service (libsecret)';
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/keychain.test.ts`
Expected: PASS (6 tests). Then `npx tsc --noEmit` and `npx eslint src test` clean.

- [ ] **Step 6: Commit and push**

```bash
git add src/config/keychain.ts test/helpers/fake-keyring.ts test/keychain.test.ts vitest.config.ts package.json package-lock.json
git commit -m "feat(keychain): optional @napi-rs/keyring loader, probe and per-OS label

SPEC-CLI §4 first brick (design 2026-07-22): sync createRequire load of
the optional native module (undefined = fall back to file 600), a
write/read/delete probe because a loaded module is not a working backend
(Linux without Secret Service imports fine and throws at runtime), and
the honest per-OS label for status lines. vitest now forces
LUPIN_CREDSTORE=file suite-wide so no test can touch the real keychain."
git push origin main
```

---

### Task 2: Chunking store — Windows blob cap

**Files:**
- Modify: `src/config/keychain.ts`
- Modify: `test/keychain.test.ts`

**Interfaces:**
- Consumes: `KeyringModule`, `KEYCHAIN_SERVICE` (Task 1).
- Produces: `KeychainStore { get(ref: string): string | undefined; set(ref: string, value: string): void; delete(ref: string): void }`, `createKeychainStore(mod: KeyringModule): KeychainStore`, `CHUNK_THRESHOLD_BYTES = 2048`.

- [ ] **Step 1: Write the failing tests**

Append to `test/keychain.test.ts`:

```ts
import { CHUNK_THRESHOLD_BYTES, createKeychainStore } from '../src/config/keychain.js';

// Windows Credential Manager truncates blobs at ~2560 bytes: values above the
// 2048-byte threshold are split into base64 chunks `ref#0..N-1` with a header
// `{"__chunks":N}` in the main entry. Same behavior on every OS: one code path.
describe('KeychainStore chunking', () => {
  it('small values round-trip as a single entry', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('moonshot', 'sk-abc123');
    expect(store.get('moonshot')).toBe('sk-abc123');
    expect(mod.raw.size).toBe(1);
  });

  it('a value over the threshold splits into chunks and reassembles byte-identical', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    const big = 'x'.repeat(CHUNK_THRESHOLD_BYTES * 3) + '€fine'; // multibyte tail on purpose
    store.set('oauth/kimi', big);
    expect(mod.raw.size).toBeGreaterThan(2); // header + at least 2 chunks
    expect(store.get('oauth/kimi')).toBe(big);
  });

  it('rewriting a chunked value with a short one leaves no stale chunks', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_BYTES * 2));
    store.set('k', 'short');
    expect(store.get('k')).toBe('short');
    expect(mod.raw.size).toBe(1);
  });

  it('delete removes header and every chunk', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_BYTES * 2));
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
    expect(mod.raw.size).toBe(0);
  });

  it('a torn write (missing chunk) reads as absent, never as invented data', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_BYTES * 2));
    mod.raw.delete('lupin/k#1');
    expect(store.get('k')).toBeUndefined();
  });

  it('missing ref reads as undefined', () => {
    expect(createKeychainStore(fakeKeyring()).get('nope')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/keychain.test.ts`
Expected: FAIL — `createKeychainStore` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/config/keychain.ts`:

```ts
/**
 * Windows Credential Manager truncates blobs at ~2560 bytes
 * (CRED_MAX_CREDENTIAL_BLOB_SIZE). Above this conservative threshold a value
 * is stored as base64 chunks `ref#0..N-1` plus a `{"__chunks":N}` header in
 * the main entry — one behavior on every OS, so the code path is single.
 */
export const CHUNK_THRESHOLD_BYTES = 2048;
const CHUNK_CHARS = 2000; // base64 is ASCII: chars == bytes, safely under the cap

export interface KeychainStore {
  get(ref: string): string | undefined;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}

function parseChunkHeader(v: string): number | undefined {
  if (!v.startsWith('{"__chunks":')) return undefined;
  try {
    const h = JSON.parse(v) as Record<string, unknown>;
    const n = h['__chunks'];
    return typeof n === 'number' && Number.isInteger(n) && n > 0 && Object.keys(h).length === 1 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function createKeychainStore(mod: KeyringModule): KeychainStore {
  const entry = (name: string): KeyringEntry => new mod.Entry(KEYCHAIN_SERVICE, name);
  const deleteChunks = (ref: string): void => {
    // deletePassword returns false on the first missing chunk: natural stop.
    for (let i = 0; ; i++) {
      if (!entry(`${ref}#${String(i)}`).deletePassword()) break;
    }
  };
  return {
    get(ref: string): string | undefined {
      const raw = entry(ref).getPassword();
      if (raw === null) return undefined;
      const n = parseChunkHeader(raw);
      if (n === undefined) return raw;
      let b64 = '';
      for (let i = 0; i < n; i++) {
        const part = entry(`${ref}#${String(i)}`).getPassword();
        if (part === null) return undefined; // torn write: absent beats invented
        b64 += part;
      }
      return Buffer.from(b64, 'base64').toString('utf8');
    },
    set(ref: string, value: string): void {
      deleteChunks(ref); // stale chunks from a longer previous value must not survive
      if (Buffer.byteLength(value, 'utf8') <= CHUNK_THRESHOLD_BYTES) {
        entry(ref).setPassword(value);
        return;
      }
      const b64 = Buffer.from(value, 'utf8').toString('base64');
      const n = Math.ceil(b64.length / CHUNK_CHARS);
      for (let i = 0; i < n; i++) {
        entry(`${ref}#${String(i)}`).setPassword(b64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS));
      }
      entry(ref).setPassword(JSON.stringify({ __chunks: n }));
    },
    delete(ref: string): void {
      entry(ref).deletePassword();
      deleteChunks(ref);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/keychain.test.ts`
Expected: PASS (12 tests). Then `npx tsc --noEmit` and `npx eslint src test` clean.

- [ ] **Step 5: Commit and push**

```bash
git add src/config/keychain.ts test/keychain.test.ts
git commit -m "feat(keychain): chunking store for the Windows blob cap

Values above 2048 UTF-8 bytes split into base64 chunks ref#0..N-1 with a
strict {\"__chunks\":N} header — same path on every OS. Rewrites clear
stale chunks first; a torn write reads as absent, never as invented
data. OAuth token JSON with long JWTs is the real customer here."
git push origin main
```

---

### Task 3: Backend selection in `credentials.ts`

**Files:**
- Modify: `src/config/credentials.ts`
- Create: `test/credentials-store.test.ts`

**Interfaces:**
- Consumes: `loadKeyringModule`, `probeKeychain`, `createKeychainStore`, `keychainLabel`, `KeychainStore`, `KeyringModule` (Tasks 1-2).
- Produces: `configureCredentialStore(opts?: { keyring?: KeyringModule | null }): void` (test/composition seam: `null` = force absent, omitted key = real loader; always resets the cache), `credentialStoreLabel(): string`, internal `activeStore()`. `credentialsPath()` now honors `LUPIN_DIR` (same relocation semantics daemon.ts got in commit 079918d).

- [ ] **Step 1: Write the failing tests**

Create `test/credentials-store.test.ts`:

```ts
// Backend selection (design §Selezione): explicit path/LUPIN_CREDENTIALS →
// file; LUPIN_CREDSTORE=file → file; probed keychain → keychain; else file.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureCredentialStore,
  credentialStoreLabel,
  credentialsPath,
  getCredential,
  setCredential,
} from '../src/config/credentials.js';
import { keychainLabel } from '../src/config/keychain.js';
import { brokenKeyring, fakeKeyring } from './helpers/fake-keyring.js';

let dir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lupin-credstore-'));
  for (const k of ['LUPIN_CREDENTIALS', 'LUPIN_CREDSTORE', 'LUPIN_DIR']) savedEnv[k] = process.env[k];
  // Keychain-eligible baseline: no file-forcing vars, relocated home.
  delete process.env.LUPIN_CREDENTIALS;
  delete process.env.LUPIN_CREDSTORE;
  process.env.LUPIN_DIR = dir;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  configureCredentialStore(); // back to the real loader + fresh cache
  rmSync(dir, { recursive: true, force: true });
});

describe('credentialsPath honors LUPIN_DIR', () => {
  it('relocates the default file without forcing file mode', () => {
    expect(credentialsPath()).toBe(join(dir, 'credentials.json'));
  });
});

describe('backend selection', () => {
  it('keychain wins when the probe passes', () => {
    configureCredentialStore({ keyring: fakeKeyring() });
    expect(credentialStoreLabel()).toBe(keychainLabel());
  });

  it('LUPIN_CREDSTORE=file forces the file store even with a working keychain', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore({ keyring: fakeKeyring() });
    expect(credentialStoreLabel()).toContain('file 600');
  });

  it('LUPIN_CREDENTIALS forces the file store at that path', () => {
    process.env.LUPIN_CREDENTIALS = join(dir, 'explicit.json');
    configureCredentialStore({ keyring: fakeKeyring() });
    expect(credentialStoreLabel()).toContain('explicit.json');
  });

  it('a failed probe falls back to file, without error', () => {
    configureCredentialStore({ keyring: brokenKeyring() });
    expect(credentialStoreLabel()).toContain('file 600');
  });

  it('module absent (no prebuilt) falls back to file', () => {
    configureCredentialStore({ keyring: null });
    expect(credentialStoreLabel()).toContain('file 600');
  });

  it('an explicit path argument bypasses the keychain entirely', () => {
    configureCredentialStore({ keyring: fakeKeyring() });
    const p = join(dir, 'byarg.json');
    setCredential('k', 'v-file', p);
    expect(getCredential('k', p)).toBe('v-file');
    // The keychain never saw it:
    const mod = fakeKeyring();
    configureCredentialStore({ keyring: mod });
    expect(mod.raw.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/credentials-store.test.ts`
Expected: FAIL — `configureCredentialStore` / `credentialStoreLabel` not exported.

- [ ] **Step 3: Write the implementation**

In `src/config/credentials.ts`:

1. Add imports at the top:

```ts
import {
  createKeychainStore,
  keychainLabel,
  loadKeyringModule,
  probeKeychain,
  type KeychainStore,
  type KeyringModule,
} from './keychain.js';
```

2. Replace `credentialsPath` with (LUPIN_DIR relocates, LUPIN_CREDENTIALS forces):

```ts
export function credentialsPath(): string {
  return (
    process.env.LUPIN_CREDENTIALS ?? join(process.env.LUPIN_DIR ?? join(homedir(), '.lupin'), 'credentials.json')
  );
}
```

3. Add the selection block (after `saveRaw`):

```ts
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
  // means file — this is also what keeps every pre-keychain test untouched.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/credentials-store.test.ts test/credentials.test.ts`
Expected: PASS — new selection tests green, existing `credentials.test.ts` untouched and green (its explicit paths hit the file store by rule 1). Note the explicit-path test still passes because `getCredential/setCredential` with a `path` argument already go straight to the file functions — routing of the no-path case lands in Task 4.

- [ ] **Step 5: Commit and push**

```bash
git add src/config/credentials.ts test/credentials-store.test.ts
git commit -m "feat(credentials): cached backend selection — keychain-first, file fallback

Design §Selezione: explicit path or LUPIN_CREDENTIALS → file;
LUPIN_CREDSTORE=file → file (also the vitest suite-wide default);
probed keychain → keychain; failed probe or missing prebuilt → file,
visibly (credentialStoreLabel). configureCredentialStore is the
composition seam: inject a module, null for absent, no args = real
loader + fresh cache. credentialsPath honors LUPIN_DIR like daemon.ts."
git push origin main
```

---

### Task 4: Route every credential function through the selected store

**Files:**
- Modify: `src/config/credentials.ts`
- Modify: `test/credentials-store.test.ts`

**Interfaces:**
- Consumes: `activeStore()` (Task 3), `KeychainStore` (Task 2).
- Produces: `getCredential/setCredential/getOAuthTokens/setOAuthTokens/deleteOAuthTokens` working against BOTH backends with unchanged signatures (`path?: string`). Contract: OAuth tokens serialize as JSON strings under `oauth/<provider>`; `deleteOAuthTokens` in keychain mode also clears any file copy (tombstone must kill every copy or a dead refresh token would be re-promoted).

- [ ] **Step 1: Write the failing contract tests**

Append to `test/credentials-store.test.ts`:

```ts
import { deleteOAuthTokens, getOAuthTokens, setOAuthTokens, type OAuthTokens } from '../src/config/credentials.js';
import { CHUNK_THRESHOLD_BYTES } from '../src/config/keychain.js';

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_000_000, tokenType: 'Bearer', ...overrides };
}

// One contract, two backends (the invariant, like streaming==non-streaming):
// each entry activates a backend and runs the same assertions through the
// PUBLIC api with no path argument.
const BACKENDS: [string, () => void][] = [
  ['file', () => { process.env.LUPIN_CREDSTORE = 'file'; configureCredentialStore(); }],
  ['keychain', () => { configureCredentialStore({ keyring: fakeKeyring() }); }],
];

describe.each(BACKENDS)('credential contract on %s backend', (_name, activate) => {
  beforeEach(activate);

  it('api key set/get round-trip', () => {
    setCredential('moonshot', 'sk-live-1');
    expect(getCredential('moonshot')).toBe('sk-live-1');
    expect(getCredential('missing')).toBeUndefined();
  });

  it('oauth tokens round-trip with full shape', () => {
    setOAuthTokens('kimi', tokens());
    expect(getOAuthTokens('kimi')).toEqual(tokens());
  });

  it('oauth tokens above the chunk threshold survive (long JWTs)', () => {
    const t = tokens({ accessToken: 'a'.repeat(CHUNK_THRESHOLD_BYTES * 2) });
    setOAuthTokens('kimi', t);
    expect(getOAuthTokens('kimi')).toEqual(t);
  });

  it('tombstone: deleted tokens stay deleted', () => {
    setOAuthTokens('kimi', tokens());
    deleteOAuthTokens('kimi');
    expect(getOAuthTokens('kimi')).toBeUndefined();
  });

  it('rotation overwrites in place', () => {
    setOAuthTokens('kimi', tokens());
    setOAuthTokens('kimi', tokens({ accessToken: 'at-2', refreshToken: 'rt-2' }));
    expect(getOAuthTokens('kimi')?.accessToken).toBe('at-2');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/credentials-store.test.ts`
Expected: the keychain-backend contract block FAILS (values written to the file today, fake keyring never consulted → round-trips read undefined or file leakage assertions break). The file-backend block passes.

- [ ] **Step 3: Route the public functions**

In `src/config/credentials.ts`, replace the five public functions:

```ts
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
  return s.store.get(ref);
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
  if (raw === undefined) return undefined;
  try {
    return parseOAuth(JSON.parse(raw));
  } catch {
    return undefined;
  }
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
```

(The old bodies of `getCredential/setCredential/getOAuthTokens/setOAuthTokens/deleteOAuthTokens` and the inline oauth-shape check they contained are replaced by the above; `parseOAuth` centralizes the shape check both backends share.)

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: ALL green — contract on both backends, existing `credentials.test.ts` and `oauth`/`login` tests untouched (explicit paths and the suite-wide `LUPIN_CREDSTORE=file` keep them on the file path). Then `npx tsc --noEmit` and `npx eslint src test` clean.

- [ ] **Step 5: Commit and push**

```bash
git add src/config/credentials.ts test/credentials-store.test.ts
git commit -m "feat(credentials): every function routes through the selected backend

One contract, two backends, verified by the same suite run against both
(the credential-store invariant, like streaming==non-streaming for
dialects): api-key and OAuth round-trips, chunked long-JWT tokens,
rotation, tombstone. In keychain mode deleteOAuthTokens also clears any
file copy: a tombstone that leaves a copy behind is not a tombstone."
git push origin main
```

---

### Task 5: Lazy promotion with read-back verification

**Files:**
- Modify: `src/config/credentials.ts`
- Modify: `test/credentials-store.test.ts`

**Interfaces:**
- Consumes: `activeStore()`, `removeFileKey` (Task 4).
- Produces: promotion inside `getCredential`/`getOAuthTokens` keychain paths. Contract: keychain miss + file hit → value returned, written to keychain, VERIFIED by read-back, then removed from the file; failed verification leaves the file untouched.

- [ ] **Step 1: Write the failing tests**

Append to `test/credentials-store.test.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs';

// Lazy promotion (design §Visibilità): keychain active + secret only in the
// file → the read finds it, moves it into the keychain, verifies by reading
// it back, and only then removes it from the file. Steady state: zero secrets
// on disk. No migration command: there is no install base.
describe('lazy promotion from file to keychain', () => {
  it('promotes an api key on first read and empties the file copy', () => {
    // Seed the file the way a LUPIN_CREDSTORE=file period would have:
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setCredential('moonshot', 'sk-old');
    delete process.env.LUPIN_CREDSTORE;
    const mod = fakeKeyring();
    configureCredentialStore({ keyring: mod });

    expect(getCredential('moonshot')).toBe('sk-old'); // found via promotion
    expect(mod.raw.get('lupin/moonshot')).toBe('sk-old'); // now in the keychain
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('sk-old'); // gone from disk
    expect(getCredential('moonshot')).toBe('sk-old'); // steady state: straight from keychain
  });

  it('promotes oauth tokens the same way', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setOAuthTokens('kimi', tokens());
    delete process.env.LUPIN_CREDSTORE;
    configureCredentialStore({ keyring: fakeKeyring() });

    expect(getOAuthTokens('kimi')).toEqual(tokens());
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('at-1');
  });

  it('a failed keychain write-back leaves the file untouched', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setCredential('moonshot', 'sk-old');
    delete process.env.LUPIN_CREDSTORE;
    // A keyring that accepts the probe, then loses every later write:
    const mod = fakeKeyring();
    const flaky: typeof mod = {
      Entry: class {
        private readonly inner: InstanceType<typeof mod.Entry>;
        constructor(service: string, name: string) {
          this.inner = new mod.Entry(service, name);
        }
        getPassword(): string | null {
          return this.inner.getPassword();
        }
        setPassword(p: string): void {
          if (!p.startsWith('probe')) return; // silently drop real writes
          this.inner.setPassword(p);
        }
        deletePassword(): boolean {
          return this.inner.deletePassword();
        }
      },
      raw: mod.raw,
    };
    configureCredentialStore({ keyring: flaky });

    expect(getCredential('moonshot')).toBe('sk-old'); // still served from the file
    expect(readFileSync(credentialsPath(), 'utf8')).toContain('sk-old'); // NOT deleted
  });

  it('a corrupt file entry is not promoted and not destroyed', () => {
    writeFileSync(credentialsPath(), JSON.stringify({ 'oauth/kimi': { not: 'tokens' } }));
    configureCredentialStore({ keyring: fakeKeyring() });
    expect(getOAuthTokens('kimi')).toBeUndefined();
    expect(readFileSync(credentialsPath(), 'utf8')).toContain('not'); // untouched
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/credentials-store.test.ts`
Expected: FAIL — promotion tests read `undefined` from the keychain path (no fallback to file yet).

- [ ] **Step 3: Implement promotion**

In `src/config/credentials.ts`, add after `removeFileKey`:

```ts
/**
 * Lazy promotion (design §Visibilità): keychain active but the secret lives
 * only in the file (e.g. a LUPIN_CREDSTORE=file period). The read serves it,
 * copies it into the keychain, VERIFIES it by reading it back, and only after
 * that verification removes it from the file — a flaky keychain must never
 * cost the only copy. Steady state: zero secrets on disk.
 */
function promote(store: KeychainStore, ref: string, value: string): void {
  store.set(ref, value);
  if (store.get(ref) === value) removeFileKey(ref);
}
```

Then extend the two keychain read paths:

In `getCredential`, replace `return s.store.get(ref);` with:

```ts
  const hit = s.store.get(ref);
  if (hit !== undefined) return hit;
  const fromFile = loadRaw(credentialsPath())[ref];
  if (typeof fromFile !== 'string') return undefined;
  promote(s.store, ref, fromFile);
  return fromFile;
```

In `getOAuthTokens`, replace the keychain branch after the `undefined` check with:

```ts
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
```

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run`
Expected: ALL green. Then `npx tsc --noEmit` and `npx eslint src test` clean.

- [ ] **Step 5: Commit and push**

```bash
git add src/config/credentials.ts test/credentials-store.test.ts
git commit -m "feat(credentials): lazy promotion file→keychain, verified before the file forgets

A keychain miss falls back to the file; a hit there is copied into the
keychain, read back, and only a VERIFIED copy removes the file entry —
a keychain that drops writes must never cost the only copy of a secret.
Corrupt file entries are neither promoted nor destroyed. Steady state
with the keychain active: zero secrets on disk, no migration command."
git push origin main
```

---

### Task 6: Visibility — status, init, login, daemon boot

**Files:**
- Modify: `src/cli/daemonctl.ts` (statusCommand, after the running/not-running line)
- Modify: `src/cli/init.ts` (after `setCredential(pick.apiKeyEnv, key)`)
- Modify: `src/cli/login.ts` (after `setOAuthTokens(def.id, tokens)`)
- Modify: `src/server/start.ts` (boot log)

**Interfaces:**
- Consumes: `credentialStoreLabel()` (Task 3).
- Produces: user-visible truth about where secrets live. No test file: these are single print lines in CLI glue (the label logic itself is unit-tested in Task 3); verification is the smoke test in Task 7.

- [ ] **Step 1: statusCommand** — in `src/cli/daemonctl.ts`, import `credentialStoreLabel` from `'../config/credentials.js'` and add as the last line before `return 0;`:

```ts
  console.log(`credentials: ${credentialStoreLabel()}`);
```

- [ ] **Step 2: init** — in `src/cli/init.ts`, right after `setCredential(pick.apiKeyEnv, key);` add:

```ts
  console.log(`  (key salvata in: ${credentialStoreLabel()})`);
```

(import `credentialStoreLabel` alongside the existing `setCredential` import).

- [ ] **Step 3: login** — in `src/cli/login.ts`, right after the `✓ login ... riuscito` line add:

```ts
  console.log(`  (token salvati in: ${credentialStoreLabel()})`);
```

(extend the existing `../config/credentials.js` import).

- [ ] **Step 4: daemon boot** — in `src/server/start.ts`, inside the `serve(...)` callback after the listening line add:

```ts
  console.log(`[lupin] credentials: ${credentialStoreLabel()}`);
```

(import from `'../config/credentials.js'`).

- [ ] **Step 5: Full suite + typecheck + lint**

Run: `npx vitest run && npx tsc --noEmit && npx eslint src test`
Expected: all green/clean (no behavior change, prints only).

- [ ] **Step 6: Commit and push**

```bash
git add src/cli/daemonctl.ts src/cli/init.ts src/cli/login.ts src/server/start.ts
git commit -m "feat(cli): say where secrets live — status, init, login, daemon boot

SPEC-CLI §4 visibility: the fallback is silent but never invisible. One
line each: lupin status and the daemon boot log report the active store,
init and login confirm the destination at the moment a secret is saved."
git push origin main
```

---

### Task 7: Docs, live smoke on this machine, roadmap tick

**Files:**
- Modify: `docs/DECISIONS.md` (append ADR-26)
- Modify: `docs/ARCHITECTURE.md` (dependency list: keytar → @napi-rs/keyring)
- Modify: `docs/SPEC-CLI.md` (§4 line 69: implementation note)
- Modify: `docs/ROADMAP.md` (resume point: keychain done)

- [ ] **Step 1: ADR-26** — append to the table in `docs/DECISIONS.md`:

```markdown
| 26 | 2026-07-22 | The OS keychain becomes the default through `@napi-rs/keyring` in `optionalDependencies` (keytar has been archived since 2023), selected once per process: an explicit path or `LUPIN_CREDENTIALS` means the file; `LUPIN_CREDSTORE=file` means the file; a successful write/read/delete probe means the keychain; otherwise the 600 file, and `lupin status` says which. Values above the blob cap are stored as base64 chunks (Windows caps a credential blob). Promotion from file to keychain is lazy and reads the value back before deleting the file copy. Never a mid-process downgrade to file after a probe has succeeded | SPEC-CLI §4 prescribes a keychain first with a file fallback; there was no installed base to migrate (user decision, 2026-07-22); a module that loads is not a backend that works (Linux without a Secret Service imports fine and then throws on every call); and a tombstone that leaves a copy on disk is not a tombstone | Shelling out to the OS tools (secrets in a subprocess argv or stdin: a security regression); a three-layer cross-keychain architecture (the middle layer covers an almost empty set); assisted migration; a silent per-operation downgrade (split-brain writes) |
```

- [ ] **Step 2: ARCHITECTURE + SPEC-CLI** — in `docs/ARCHITECTURE.md` replace `keytar (optional, file 600 fallback)` with `@napi-rs/keyring (optional, file 600 fallback, ADR-26)`. In `docs/SPEC-CLI.md` line 69 replace `(keytar or equivalent)` with `(implemented 2026-07-22 with @napi-rs/keyring, ADR-26; keytar is archived)`.

- [ ] **Step 3: Live smoke on Windows (manual, this machine)**

```bash
npx tsx src/cli.ts status
```
Expected: `credentials: Windows Credential Manager`.

Then re-run a real `lupin login kimi` (or `lupin init`) and verify:
1. the confirmation line names the Credential Manager;
2. `rundll32.exe keymgr.dll,KRShowKeyMgr` (or Pannello di controllo → Gestione credenziali → Credenziali generiche) shows entries under service `lupin`;
3. `%USERPROFILE%\.lupin\credentials.json` is absent or contains no secret values (promotion emptied it);
4. `lupin run -- claude` completes a real session (credential resolved from the keychain).

Record the outcomes in the ROADMAP resume point. If any check fails, STOP and fix before the docs commit.

- [ ] **Step 4: ROADMAP** — update the resume point at the top of `docs/ROADMAP.md`: mark queue item 2 (keychain) done with the smoke results and the commit range; the M3 line `optional OS keychain` becomes done with date 2026-07-22.

- [ ] **Step 5: Commit and push**

```bash
git add docs/DECISIONS.md docs/ARCHITECTURE.md docs/SPEC-CLI.md docs/ROADMAP.md
git commit -m "docs(keychain): ADR-26, spec note, roadmap — M3 keychain closed

Live smoke on Windows recorded: store label in status, entries under
service 'lupin' in Credential Manager, credentials.json emptied by
promotion, real session served from the keychain."
git push origin main
```

---

## Self-Review (done at plan time)

- **Spec coverage:** selection rules (T3), chunking (T2), promotion+verify (T5), tombstone both copies (T4), visibility 4 points (T6), no-downgrade (T3 probe-only selection; per-op errors propagate naturally since no catch wraps store ops), device_id untouched (no task touches it), contract-on-both-backends (T4), docs+ADR (T7). Gap check: `oauthNeedsRefresh`/`getDeviceId` are pure/file-only and intentionally untouched.
- **Placeholder scan:** none — every step carries code or exact commands.
- **Type consistency:** `KeyringEntry/KeyringModule/KeychainStore` defined in T1/T2 and consumed with the same names in T3-T5; `configureCredentialStore({ keyring })` used identically in T3-T5 tests; `tokens()` helper defined in T4 and reused in T5.
