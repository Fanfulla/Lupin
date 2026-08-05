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

/**
 * The Windows Credential Manager shape: it stores the value as UTF-16 and
 * refuses anything over CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes), which is
 * 1280 UTF-16 code units. Measured against the real backend on 2026-08-05:
 * 1280 characters write and read back, 1281 throws this exact message.
 *
 * The plain in-memory fake accepts any length, which is why a chunking bug
 * sized in UTF-8 bytes passed every test and then broke a real login.
 */
export const WINDOWS_BLOB_LIMIT_UTF16 = 1280;

export function windowsKeyring(
  store: Map<string, string> = new Map(),
): KeyringModule & { raw: Map<string, string> } {
  class WindowsEntry implements KeyringEntry {
    private readonly key: string;
    constructor(service: string, name: string) {
      this.key = `${service}/${name}`;
    }
    getPassword(): string | null {
      return store.get(this.key) ?? null;
    }
    setPassword(password: string): void {
      // `String.length` IS the UTF-16 code unit count, which is what the
      // platform counts. Not the UTF-8 byte length.
      if (password.length > WINDOWS_BLOB_LIMIT_UTF16) {
        throw new Error("Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars");
      }
      store.set(this.key, password);
    }
    deletePassword(): boolean {
      return store.delete(this.key);
    }
  }
  return { Entry: WindowsEntry, raw: store };
}
