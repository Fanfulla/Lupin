import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCredential } from '../src/server/credential.js';

describe('resolveCredential (SPEC-PROVIDERS §3ter)', () => {
  it('auth none resolves to the constant local bearer, no store lookup', async () => {
    const cred = await resolveCredential({
      provider: 'ollama',
      mode: 'translate',
      auth: { type: 'none' },
      slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
    });
    expect(cred).toEqual({ header: 'authorization', value: 'Bearer lupin-local' });
  });
});

describe('api-key miss with a keychain marker (ADR-43)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lupin-cred-marker-'));
  const savedEnv = process.env.LUPIN_CREDENTIALS;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LUPIN_CREDENTIALS;
    else process.env.LUPIN_CREDENTIALS = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('the error names the keychain, never a missing key', async () => {
    const p = join(dir, 'credentials.json');
    process.env.LUPIN_CREDENTIALS = p;
    writeFileSync(p, JSON.stringify({ MOONSHOT_KEY_E2E: { __inKeychain: true, movedAt: '2026-08-06T00:00:00.000Z' } }));
    const profile = {
      provider: 'moonshot',
      mode: 'passthrough' as const,
      auth: { type: 'bearer' as const, apiKeyRef: 'MOONSHOT_KEY_E2E' },
      slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
    };
    await expect(resolveCredential(profile)).rejects.toThrow(/keychain/i);
    await expect(resolveCredential(profile)).rejects.toThrow(/@napi-rs\/keyring/);
  });
});
