import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialDestinationAllowed, resolveCredential } from '../src/server/credential.js';
import { OAUTH_PROVIDERS } from '../src/providers/oauth.js';

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

  it('carries the OAuth descriptor host pin without exposing credential-store metadata', async () => {
    const profile = {
      provider: 'xai',
      mode: 'responses' as const,
      auth: { type: 'oauth' as const, provider: 'xai' },
      slots: { opus: 'grok-4.6', sonnet: 'grok-4.6', haiku: 'grok-4.6' },
    };
    const credential = await resolveCredential(profile, {
      oauthDefs: OAUTH_PROVIDERS,
      resolveToken: async () => 'oauth-access-fake',
    });
    expect(credential).toEqual({
      header: 'authorization',
      value: 'Bearer oauth-access-fake',
      allowedHosts: ['x.ai'],
    });
  });
});

describe('OAuth credential destination pin', () => {
  it('accepts HTTPS on the exact xAI host or a real subdomain only', () => {
    expect(credentialDestinationAllowed('https://api.x.ai/v1', ['x.ai'])).toBe(true);
    expect(credentialDestinationAllowed('https://region.x.ai/v1', ['x.ai'])).toBe(true);
    expect(credentialDestinationAllowed('http://api.x.ai/v1', ['x.ai'])).toBe(false);
    expect(credentialDestinationAllowed('https://x.ai.evil.example/v1', ['x.ai'])).toBe(false);
    expect(credentialDestinationAllowed('not a URL', ['x.ai'])).toBe(false);
  });

  it('does not restrict credentials whose descriptor declares no host pin', () => {
    expect(credentialDestinationAllowed('http://127.0.0.1:9999/v1', undefined)).toBe(true);
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
