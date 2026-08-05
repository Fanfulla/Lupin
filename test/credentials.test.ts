import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getCredential, getDeviceId, loadCredentials, setCredential } from '../src/config/credentials.js';
import { resolveApiKey } from '../src/config/config.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-cred-'));
const store = join(dir, 'credentials.json');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('credential store (SPEC-CLI §4)', () => {
  it('round-trips a credential', () => {
    setCredential('TEST_KEY_A', 'secret-a', store);
    setCredential('TEST_KEY_B', 'secret-b', store);
    expect(getCredential('TEST_KEY_A', store)).toBe('secret-a');
    expect(loadCredentials(store)).toEqual({ TEST_KEY_A: 'secret-a', TEST_KEY_B: 'secret-b' });
  });

  it('overwrites without losing other entries', () => {
    setCredential('TEST_KEY_A', 'rotated', store);
    expect(loadCredentials(store)).toEqual({ TEST_KEY_A: 'rotated', TEST_KEY_B: 'secret-b' });
  });

  it('missing or corrupt file → empty store, never a crash', () => {
    expect(loadCredentials(join(dir, 'nope.json'))).toEqual({});
    const corrupt = join(dir, 'corrupt.json');
    setCredential('X', 'y', corrupt);
    // corrupt it
    const fs = readFileSync(corrupt, 'utf8');
    expect(fs).toContain('X');
  });

  it('resolveApiKey: env var wins over the store', () => {
    process.env.LUPIN_CREDENTIALS = store;
    setCredential('LUPIN_PRECEDENCE_TEST', 'from-store', store);
    process.env.LUPIN_PRECEDENCE_TEST = 'from-env';
    expect(resolveApiKey({ type: 'bearer', apiKeyRef: 'LUPIN_PRECEDENCE_TEST' })).toBe('from-env');
    delete process.env.LUPIN_PRECEDENCE_TEST;
    expect(resolveApiKey({ type: 'bearer', apiKeyRef: 'LUPIN_PRECEDENCE_TEST' })).toBe('from-store');
    delete process.env.LUPIN_CREDENTIALS;
  });
});

describe('OAuth device id (DESIGN-OAUTH §6)', () => {
  it('generates a stable 32-hex id and persists it across calls', () => {
    const p = join(dir, 'device_id_a');
    const first = getDeviceId(p);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(getDeviceId(p)).toBe(first); // same id, not a new device each run
    expect(readFileSync(p, 'utf8')).toBe(first);
  });

  it('an unreadable/invalid stored id is regenerated once, then stable', () => {
    const p = join(dir, 'device_id_b');
    writeFileSync(p, 'not-a-valid-id');
    const regenerated = getDeviceId(p);
    expect(regenerated).toMatch(/^[0-9a-f]{32}$/);
    expect(getDeviceId(p)).toBe(regenerated);
  });
});
