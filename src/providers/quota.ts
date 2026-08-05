// Quota-exhausted answers, per provider (SPEC-PROVIDERS §4octies, ADR-33).
//
// A 429 can be a transient rate limit or a subscription cycle that is spent
// until it resets, and the status alone cannot tell them apart: only the
// message can. Same discipline as the quirk registry: one central table,
// entries only for answers SEEN LIVE, each with its verification date, and
// never an `if (provider === x)` anywhere else. What is not certain stays
// transient: a wrong "durable" verdict moves the user's active profile on a
// flake, which is worse than paying one more failed request.

import type { NormalizedError } from '../core/errors.js';

interface QuotaMatcher {
  status: number;
  /** Every pattern must match the provider's error message. */
  all: RegExp[];
  /** When this answer was seen live (the registry's verification-date rule). */
  verified: string;
}

const QUOTA_EXHAUSTED: Record<string, QuotaMatcher[]> = {
  // Seen live 2026-07-29 on the Kimi subscription: "You've reached your usage
  // limit for this billing cycle" as a 429, identical in status to the
  // per-minute rate limit the same endpoint also emits.
  kimicode: [{ status: 429, all: [/usage limit/i, /billing cycle/i], verified: '2026-07-29' }],
  // Deliberately absent: geminisub RESOURCE_EXHAUSTED (the Code Assist free
  // tier emits it per-minute too, so as a durable signal it would flap) and
  // every generic 429.
};

/** True only when this provider's answer is KNOWN to mean "spent until the cycle resets". */
export function quotaExhausted(providerId: string, err: NormalizedError): boolean {
  const message = err.body.error.message;
  return (QUOTA_EXHAUSTED[providerId] ?? []).some(
    (m) => m.status === err.status && m.all.every((re) => re.test(message)),
  );
}
