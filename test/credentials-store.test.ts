// Backend selection (design §Selezione): explicit path/LUPIN_CREDENTIALS →
// file; LUPIN_CREDSTORE=file → file; probed keychain → keychain; else file.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureCredentialStore,
  credentialStoreLabel,
  credentialsPath,
  deleteOAuthTokens,
  getCredential,
  getOAuthTokens,
  setCredential,
  setOAuthTokens,
  type OAuthTokens,
} from '../src/config/credentials.js';
import { CHUNK_THRESHOLD_UTF16, keychainLabel } from '../src/config/keychain.js';
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

function tokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 1_000_000, tokenType: 'Bearer', ...overrides };
}

// One contract, two backends (the invariant, like streaming==non-streaming):
// each entry activates a backend and runs the same assertions through the
// PUBLIC api with no path argument.
let activeKeyring: ReturnType<typeof fakeKeyring> | undefined;
const BACKENDS: [string, () => void][] = [
  ['file', () => { activeKeyring = undefined; process.env.LUPIN_CREDSTORE = 'file'; configureCredentialStore(); }],
  ['keychain', () => { activeKeyring = fakeKeyring(); configureCredentialStore({ keyring: activeKeyring }); }],
];

// Discriminates the contract: file mode already proves itself via the
// round-trip through the real file, but keychain mode could silently
// degrade to file underneath the same public API — so on that backend we
// inspect the fake's raw map directly and prove the file was never touched.
function expectStoredInActiveBackend(ref: string): void {
  if (activeKeyring === undefined) return; // file mode: the round-trip already proves the file
  expect([...activeKeyring.raw.keys()].some((k) => k === `lupin/${ref}` || k.startsWith(`lupin/${ref}#`))).toBe(true);
  expect(existsSync(credentialsPath())).toBe(false); // keychain mode: nothing may touch the file
}

describe.each(BACKENDS)('credential contract on %s backend', (_name, activate) => {
  beforeEach(activate);

  it('api key set/get round-trip', () => {
    setCredential('moonshot', 'sk-live-1');
    expect(getCredential('moonshot')).toBe('sk-live-1');
    expect(getCredential('missing')).toBeUndefined();
    expectStoredInActiveBackend('moonshot');
  });

  it('oauth tokens round-trip with full shape', () => {
    setOAuthTokens('kimi', tokens());
    expect(getOAuthTokens('kimi')).toEqual(tokens());
    expectStoredInActiveBackend('oauth/kimi');
    if (activeKeyring !== undefined) {
      const raw = activeKeyring.raw.get('lupin/oauth/kimi');
      expect(typeof raw).toBe('string');
      expect(() => JSON.parse(raw as string)).not.toThrow();
    }
  });

  it('oauth tokens above the chunk threshold survive (long JWTs)', () => {
    const t = tokens({ accessToken: 'a'.repeat(CHUNK_THRESHOLD_UTF16 * 2) });
    setOAuthTokens('kimi', t);
    expect(getOAuthTokens('kimi')).toEqual(t);
    expectStoredInActiveBackend('oauth/kimi');
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

describe('tombstone clears every copy (keychain mode)', () => {
  it('a stale file copy of the tokens dies with the keychain copy', () => {
    writeFileSync(credentialsPath(), JSON.stringify({ 'oauth/kimi': tokens() }));
    configureCredentialStore({ keyring: fakeKeyring() });
    setOAuthTokens('kimi', tokens({ accessToken: 'at-new' }));
    deleteOAuthTokens('kimi');
    expect(getOAuthTokens('kimi')).toBeUndefined();
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('accessToken');
  });

  it('garbage stored under oauth/<provider> in the keychain reads as undefined', () => {
    const mod = fakeKeyring();
    configureCredentialStore({ keyring: mod });
    mod.raw.set('lupin/oauth/kimi', 'not json at all');
    expect(getOAuthTokens('kimi')).toBeUndefined();
  });
});

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

  it('a keychain write that throws mid-promotion still serves the file value', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setCredential('moonshot', 'sk-old');
    setOAuthTokens('kimi', tokens());
    delete process.env.LUPIN_CREDSTORE;
    // A keyring that accepts the probe, then THROWS on every later write:
    // the Windows Credential Manager shape when it refuses a value. Seen
    // live on 2026-08-05 as a 401 on every request of a kimi-sub session.
    const mod = fakeKeyring();
    const throwing: typeof mod = {
      Entry: class {
        private readonly inner: InstanceType<typeof mod.Entry>;
        constructor(service: string, name: string) {
          this.inner = new mod.Entry(service, name);
        }
        getPassword(): string | null {
          return this.inner.getPassword();
        }
        setPassword(p: string): void {
          if (!p.startsWith('probe')) {
            throw new Error("Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars");
          }
          this.inner.setPassword(p);
        }
        deletePassword(): boolean {
          return this.inner.deletePassword();
        }
      },
      raw: mod.raw,
    };
    configureCredentialStore({ keyring: throwing });

    expect(getCredential('moonshot')).toBe('sk-old'); // the read must not throw
    expect(getOAuthTokens('kimi')).toEqual(tokens()); // oauth path identical
    expect(readFileSync(credentialsPath(), 'utf8')).toContain('sk-old'); // NOT deleted
  });

  it('a corrupt file entry is not promoted and not destroyed', () => {
    writeFileSync(credentialsPath(), JSON.stringify({ 'oauth/kimi': { not: 'tokens' } }));
    configureCredentialStore({ keyring: fakeKeyring() });
    expect(getOAuthTokens('kimi')).toBeUndefined();
    expect(readFileSync(credentialsPath(), 'utf8')).toContain('not'); // untouched
  });

  it('a keychain-mode set buries any stale file copy of the same ref', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setCredential('moonshot', 'sk-old');
    delete process.env.LUPIN_CREDSTORE;
    configureCredentialStore({ keyring: fakeKeyring() });
    setCredential('moonshot', 'sk-new'); // rotation via re-init, no read first
    expect(getCredential('moonshot')).toBe('sk-new');
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('sk-old');
  });

  it('a keychain-mode oauth set buries the stale file tokens', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    setOAuthTokens('kimi', tokens());
    delete process.env.LUPIN_CREDSTORE;
    configureCredentialStore({ keyring: fakeKeyring() });
    setOAuthTokens('kimi', tokens({ accessToken: 'at-fresh', refreshToken: 'rt-fresh' }));
    expect(getOAuthTokens('kimi')?.accessToken).toBe('at-fresh');
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('at-1');
  });

  it('promotes a chunk-sized token through the chunking store, verified', () => {
    process.env.LUPIN_CREDSTORE = 'file';
    configureCredentialStore();
    const big = tokens({ accessToken: 'a'.repeat(CHUNK_THRESHOLD_UTF16 * 2) });
    setOAuthTokens('kimi', big);
    delete process.env.LUPIN_CREDSTORE;
    const mod = fakeKeyring();
    configureCredentialStore({ keyring: mod });
    expect(getOAuthTokens('kimi')).toEqual(big);
    expect([...mod.raw.keys()].some((k) => k.startsWith('lupin/oauth/kimi#'))).toBe(true); // chunked in the keychain
    expect(readFileSync(credentialsPath(), 'utf8')).not.toContain('accessToken'); // file cleared after verify
  });
});
