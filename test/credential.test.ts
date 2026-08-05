import { describe, expect, it } from 'vitest';
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
