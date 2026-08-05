// The quota matcher registry (SPEC-PROVIDERS §4octies, ADR-33): entries only
// for answers seen live, and everything uncertain stays transient. The
// deliberate exclusions are pinned as hard as the match: a wrong "durable"
// verdict moves the user's active profile on a flake.

import { describe, expect, it } from 'vitest';
import { quotaExhausted } from '../src/providers/quota.js';
import type { NormalizedError } from '../src/core/errors.js';

const err = (status: number, message: string): NormalizedError => ({
  status,
  body: { type: 'error', error: { type: 'rate_limit_error', message } },
});

describe('quotaExhausted', () => {
  it('matches the Kimi billing-cycle answer seen live 2026-07-29', () => {
    expect(quotaExhausted('kimicode', err(429, "You've reached your usage limit for this billing cycle."))).toBe(true);
  });

  it('a transient rate limit on the same provider stays transient', () => {
    expect(quotaExhausted('kimicode', err(429, 'rate limited, retry in a moment'))).toBe(false);
  });

  it('the status must match too: the same words on a 529 mean overload, not quota', () => {
    expect(quotaExhausted('kimicode', err(529, 'usage limit for this billing cycle'))).toBe(false);
  });

  it('Code Assist RESOURCE_EXHAUSTED is deliberately NOT durable: the free tier emits it per-minute', () => {
    expect(quotaExhausted('geminisub', err(429, 'RESOURCE_EXHAUSTED: you have exhausted your capacity on this model'))).toBe(false);
  });

  it('an unlisted provider never matches', () => {
    expect(quotaExhausted('moonshot', err(429, 'usage limit for this billing cycle'))).toBe(false);
  });
});
