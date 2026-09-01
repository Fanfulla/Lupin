import { describe, expect, it } from 'vitest';
import type { ProfileConfig } from '../src/config/config.js';
import { testConfiguredProfileKey } from '../src/server/connectivity.js';

const translateProfile = (overrides: Partial<ProfileConfig> = {}): ProfileConfig => ({
  provider: 'openrouter',
  mode: 'translate',
  baseUrl: 'https://configured.example/v1',
  auth: { type: 'bearer', apiKeyRef: 'ROUTER_KEY' },
  slots: { opus: 'large', sonnet: 'daily', haiku: 'small' },
  quirks: ['maxCompletionTokens'],
  ...overrides,
});

describe('configured-profile API-key connectivity', () => {
  it('probes the configured translate endpoint, auth scheme, direct model and quirks', async () => {
    const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      seen.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
    };

    const result = await testConfiguredProfileKey('custom', translateProfile(), 'candidate-key', fetchImpl);

    expect(result).toEqual({ ok: true, detail: 'daily answers' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://configured.example/v1/chat/completions');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer candidate-key');
    expect(seen[0]?.body['model']).toBe('daily');
    expect(seen[0]?.body['max_completion_tokens']).toBe(1);
    expect(seen[0]?.body['max_tokens']).toBeUndefined();
  });

  it('uses x-api-key in passthrough and removes the submitted key from provider errors', async () => {
    const secret = 'unusual.secret/value';
    let seenUrl = '';
    let seenKey: string | null = null;
    const fetchImpl: typeof fetch = (input, init) => {
      seenUrl = String(input);
      seenKey = new Headers(init?.headers).get('x-api-key');
      return Promise.resolve(
        new Response(JSON.stringify({ error: { message: `credential ${secret} rejected` } }), { status: 401 }),
      );
    };
    const profile = translateProfile({
      provider: 'anthropic',
      mode: 'passthrough',
      baseUrl: 'https://native.example',
      auth: { type: 'x-api-key', apiKeyRef: 'NATIVE_KEY' },
      quirks: undefined,
    });

    const result = await testConfiguredProfileKey('native', profile, secret, fetchImpl);

    expect(seenUrl).toBe('https://native.example/v1/messages');
    expect(seenKey).toBe(secret);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('[redacted]');
    expect(result.detail).not.toContain(secret);
  });

  it('redacts a long submitted key before truncating provider detail', async () => {
    const secret = `unusual-${'z'.repeat(300)}`;
    const fetchImpl: typeof fetch = () =>
      Promise.resolve(new Response(`credential ${secret} rejected`, { status: 401 }));

    const result = await testConfiguredProfileKey('custom', translateProfile(), secret, fetchImpl);

    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain(`unusual-${'z'.repeat(20)}`);
    expect(result.detail.length).toBeLessThanOrEqual(200);
  });

  it('refuses a profile with only delegated slots without making a request', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response('{}'));
    };
    const profile = translateProfile({
      slots: { opus: { profile: 'other' }, sonnet: { profile: 'other' }, haiku: { profile: 'other' } },
    });

    const result = await testConfiguredProfileKey('delegated', profile, 'candidate-key', fetchImpl);

    expect(result).toEqual({ ok: false, detail: 'profile "delegated" has no direct model to test' });
    expect(calls).toBe(0);
  });

  it('refuses a key-backed profile on a lane the connectivity probe does not implement', async () => {
    const profile = translateProfile({ mode: 'responses' });
    const result = await testConfiguredProfileKey('subscription-shape', profile, 'candidate-key');
    expect(result).toEqual({ ok: false, detail: 'profile "subscription-shape" uses unsupported mode "responses"' });
  });
});
