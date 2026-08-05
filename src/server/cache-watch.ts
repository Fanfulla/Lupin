// Cache-bust detector (ROADMAP backlog #11c, SPEC-PROVIDERS §3ter, ADR-40).
//
// The dominant cost of a Claude Code turn is re-processing the prompt, and the
// provider only skips it while the prefix stays byte-identical. When something
// breaks that, nothing fails: the session just gets slower and dearer, with no
// error to look at. This is the diagnosis the community performs with a MITM
// proxy, done from numbers the provider already sends us.
//
// PRIVACY: the original idea in backlog #11c was to keep prefixes in memory and
// compare them. This keeps NO prompt bytes at all, not even hashed: two integers
// per profile, taken from `usage`. The privacy rule (ADR-12) is not stretched,
// and there is nothing in a heap dump that was not already a token count.

interface Seen {
  /** Tokens this profile's previous request was served from the cache. */
  cacheRead: number;
  /** Everything that request sent up: fresh input plus whatever the cache held. */
  totalInput: number;
}

const lastByProfile = new Map<string, Seen>();

/** Test seam, and what a config reload should call: forget the observed history. */
export function resetCacheWatch(): void {
  lastByProfile.clear();
}

export interface CacheUsage {
  input: number;
  cacheRead?: number;
  cacheCreate?: number;
}

/**
 * Records this request's usage and answers whether the provider's cache went
 * from warm to cold while the prompt did NOT get smaller.
 *
 * The size condition is what separates a broken cache from an ordinary new
 * conversation: a fresh conversation starts cold AND small, while a busted
 * prefix re-sends everything it sent before, or more, and gets nothing back.
 * No threshold is invented for it; the comparison is against what this same
 * profile actually sent last time.
 *
 * Returns undefined when there is nothing to say: no previous request, a
 * provider that does not report cache fields at all (absent is not zero), or a
 * cache that is simply still warm.
 */
export function observeCacheUsage(profile: string, usage: CacheUsage): true | undefined {
  const reportsCache = usage.cacheRead !== undefined || usage.cacheCreate !== undefined;
  if (!reportsCache) {
    // A provider with no cache accounting can never be judged on it. Its
    // history is dropped too, so a later provider switch cannot compare
    // against numbers that never existed.
    lastByProfile.delete(profile);
    return undefined;
  }
  const cacheRead = usage.cacheRead ?? 0;
  const totalInput = usage.input + cacheRead + (usage.cacheCreate ?? 0);
  const previous = lastByProfile.get(profile);
  lastByProfile.set(profile, { cacheRead, totalInput });
  if (previous === undefined) return undefined;
  const wentCold = previous.cacheRead > 0 && cacheRead === 0;
  return wentCold && totalInput >= previous.totalInput ? true : undefined;
}
