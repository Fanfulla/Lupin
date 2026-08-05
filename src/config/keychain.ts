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
 * round-trip proves it: and cleans up after itself.
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

/** Honest per-OS name, for status lines and logs: never for decisions. */
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

/**
 * Windows Credential Manager refuses blobs over CRED_MAX_CREDENTIAL_BLOB_SIZE
 * (2560 bytes) and stores the value as UTF-16, so the real budget is **1280
 * UTF-16 code units**, not 2560 of anything. Measured against the live backend
 * on 2026-08-05: 1280 characters write and read back, 1281 throws.
 *
 * This constant used to be 2048 UTF-8 BYTES with 2000-character chunks, on the
 * reasoning that "base64 is ASCII, so chars == bytes". True for UTF-8 and
 * irrelevant: the platform counts UTF-16. The consequence was live and total,
 * since a 1393-character Kimi token measured 1393 UTF-8 bytes, took the plain
 * path under the old threshold, and threw at 2786 UTF-16 bytes.
 *
 * Above the threshold a value is stored as base64 chunks `ref#0..N-1` plus a
 * `{"__chunks":N}` header in the main entry: one behaviour on every OS, so the
 * code path stays single. `String.length` IS the UTF-16 count, so it is the
 * measure used throughout.
 */
export const CHUNK_THRESHOLD_UTF16 = 1000;
const CHUNK_CHARS = 1000; // base64 is ASCII, so 1000 chars == 1000 UTF-16 units

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
      // A plain value must never be mistakable for a header on read: a value
      // byte-identical to {"__chunks":N} takes the chunked path to ensure
      // get() always reassembles it, not misinterprets it as a chunk header.
      if (value.length <= CHUNK_THRESHOLD_UTF16 && parseChunkHeader(value) === undefined) {
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
