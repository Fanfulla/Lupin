// Cache-bust detector (backlog #11c, ADR-40). It answers one question from two
// integers: did this profile's provider cache go from warm to cold while the
// prompt did not get smaller? Everything else must stay silent, because a
// diagnostic that cries wolf is worse than no diagnostic.

import { beforeEach, describe, expect, it } from 'vitest';
import { observeCacheUsage, resetCacheWatch } from '../src/server/cache-watch.js';

beforeEach(() => resetCacheWatch());

const P = 'a-profile';

describe('what it reports', () => {
  it('warm then cold, with a prompt that did not shrink, is a bust', () => {
    expect(observeCacheUsage(P, { input: 100, cacheRead: 40000, cacheCreate: 0 })).toBeUndefined();
    expect(observeCacheUsage(P, { input: 41000, cacheRead: 0, cacheCreate: 41000 })).toBe(true);
  });

  it('a cache that stays warm says nothing', () => {
    observeCacheUsage(P, { input: 100, cacheRead: 40000 });
    expect(observeCacheUsage(P, { input: 200, cacheRead: 41000 })).toBeUndefined();
  });

  it('the first request of all says nothing: there is nothing to compare', () => {
    expect(observeCacheUsage(P, { input: 40000, cacheRead: 0, cacheCreate: 40000 })).toBeUndefined();
  });

  // The false positive that would make this useless: opening a NEW conversation
  // legitimately starts cold. It is also small, and that is what tells them
  // apart, with no invented threshold.
  it('a new, smaller conversation is not a bust', () => {
    observeCacheUsage(P, { input: 100, cacheRead: 40000 });
    expect(observeCacheUsage(P, { input: 900, cacheRead: 0, cacheCreate: 900 })).toBeUndefined();
  });

  it('a provider that reports no cache fields is never judged (absent is not zero)', () => {
    observeCacheUsage(P, { input: 100, cacheRead: 40000 });
    expect(observeCacheUsage(P, { input: 99000 })).toBeUndefined();
    // and its history is dropped, so the next warm provider is not compared
    // against numbers from a provider that never had a cache
    expect(observeCacheUsage(P, { input: 99000, cacheRead: 0, cacheCreate: 99000 })).toBeUndefined();
  });
});

describe('per profile', () => {
  it('one profile going cold does not accuse another', () => {
    observeCacheUsage('one', { input: 100, cacheRead: 40000 });
    observeCacheUsage('two', { input: 100, cacheRead: 50000 });
    expect(observeCacheUsage('two', { input: 51000, cacheRead: 0, cacheCreate: 51000 })).toBe(true);
    expect(observeCacheUsage('one', { input: 200, cacheRead: 41000 })).toBeUndefined();
  });
});

describe('what it keeps', () => {
  // The privacy rule (ADR-12) is why this exists in this shape: the backlog
  // idea was to hold prefixes in memory and diff them.
  it('keeps only counts: the same numbers drive it whatever the prompt was', () => {
    observeCacheUsage(P, { input: 1, cacheRead: 10, cacheCreate: 0 });
    expect(observeCacheUsage(P, { input: 11, cacheRead: 0, cacheCreate: 11 })).toBe(true);
  });
});
