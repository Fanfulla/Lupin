// OS keychain backend (design docs/superpowers/specs/2026-07-22-keychain-design.md).

import { describe, expect, it } from 'vitest';
import { CHUNK_THRESHOLD_UTF16, KEYCHAIN_SERVICE, createKeychainStore, keychainLabel, loadKeyringModule, probeKeychain } from '../src/config/keychain.js';
import { WINDOWS_BLOB_LIMIT_UTF16, brokenKeyring, fakeKeyring, windowsKeyring } from './helpers/fake-keyring.js';

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
    const big = 'x'.repeat(CHUNK_THRESHOLD_UTF16 * 3) + '€fine'; // multibyte tail on purpose
    store.set('oauth/kimi', big);
    expect(mod.raw.size).toBeGreaterThan(2); // header + at least 2 chunks
    expect(store.get('oauth/kimi')).toBe(big);
  });

  it('rewriting a chunked value with a short one leaves no stale chunks', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_UTF16 * 2));
    store.set('k', 'short');
    expect(store.get('k')).toBe('short');
    expect(mod.raw.size).toBe(1);
  });

  it('delete removes header and every chunk', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_UTF16 * 2));
    store.delete('k');
    expect(store.get('k')).toBeUndefined();
    expect(mod.raw.size).toBe(0);
  });

  it('a torn write (missing chunk) reads as absent, never as invented data', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'y'.repeat(CHUNK_THRESHOLD_UTF16 * 2));
    mod.raw.delete('lupin/k#1');
    expect(store.get('k')).toBeUndefined();
  });

  it('missing ref reads as undefined', () => {
    expect(createKeychainStore(fakeKeyring()).get('nope')).toBeUndefined();
  });

  it('a value that looks like a chunk header round-trips instead of vanishing', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('weird', '{"__chunks":3}');
    expect(store.get('weird')).toBe('{"__chunks":3}');
  });

  it('a value exactly at the threshold stays a single entry', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'a'.repeat(CHUNK_THRESHOLD_UTF16));
    expect(mod.raw.size).toBe(1);
    expect(store.get('k')).toBe('a'.repeat(CHUNK_THRESHOLD_UTF16));
  });

  it('one byte over the threshold chunks', () => {
    const mod = fakeKeyring();
    const store = createKeychainStore(mod);
    store.set('k', 'a'.repeat(CHUNK_THRESHOLD_UTF16 + 1));
    expect(mod.raw.size).toBeGreaterThan(1);
    expect(store.get('k')).toBe('a'.repeat(CHUNK_THRESHOLD_UTF16 + 1));
  });
});

// Every test above ran against a fake that accepts any length, so the chunking
// was sized in UTF-8 bytes and nobody noticed that Windows counts UTF-16. Live
// consequence (2026-08-05): a stored Kimi token of 1393 characters took the
// PLAIN path (1393 UTF-8 bytes, under the old 2048 threshold) and threw at
// 2786 UTF-16 bytes, so `lupin doctor` answered 401 and no subscription worked
// on Windows whenever the keychain backend was active.
describe('the Windows blob limit (measured live 2026-08-05)', () => {
  const oauthSized = (n: number): string => JSON.stringify({ accessToken: 'e'.repeat(n), tokenType: 'Bearer' });

  it('round-trips a token far past the limit', () => {
    const store = createKeychainStore(windowsKeyring());
    const value = oauthSized(4000);
    store.set('oauth/openai', value);
    expect(store.get('oauth/openai')).toBe(value);
  });

  it('round-trips the sizes that actually broke: Kimi 1393 and OpenAI 2079 characters', () => {
    for (const n of [1393, 2079]) {
      const store = createKeychainStore(windowsKeyring());
      const value = 'k'.repeat(n);
      store.set('oauth/x', value);
      expect(store.get('oauth/x')).toBe(value);
    }
  });

  it('never writes a single entry past the limit, chunks included', () => {
    const mod = windowsKeyring();
    createKeychainStore(mod).set('oauth/big', oauthSized(9000));
    for (const [key, written] of mod.raw) {
      expect(written.length, `${key} is ${String(written.length)} UTF-16 units`).toBeLessThanOrEqual(
        WINDOWS_BLOB_LIMIT_UTF16,
      );
    }
  });

  it('counts UTF-16 units, so multibyte text is measured the way the platform measures it', () => {
    const store = createKeychainStore(windowsKeyring());
    const value = '€'.repeat(1200); // 1200 UTF-16 units, 3600 UTF-8 bytes
    store.set('k', value);
    expect(store.get('k')).toBe(value);
  });
});
