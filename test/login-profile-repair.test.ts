// A subscription profile written by an OLDER Lupin can point at the wrong
// provider and lane: `gemini-sub` was built from the pay-per-token `gemini`
// descriptor before the codeassist lane existed, so it says `mode: translate`
// and the OAuth token does not spend there at all. There is no config
// migration in this project, so `lupin login` is where it gets repaired.
//
// The slots are the delicate part: they may be the user's own choice, and
// overwriting a deliberate decision would be worse than the bug.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureOAuthProfile } from '../src/cli/login.js';
import { findOAuthProvider } from '../src/providers/oauth.js';
import type { LupinConfig } from '../src/config/config.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-repair-'));
let n = 0;
let logs: string[] = [];

// A valid config always has an existing activeProfile, so the fixture carries
// an unrelated one: the repair must never touch it.
const OTHER = {
  provider: 'kimi',
  mode: 'passthrough' as const,
  auth: { type: 'bearer' as const, apiKeyRef: 'K' },
  slots: { opus: 'k', sonnet: 'k', haiku: 'k' },
};

function freshConfig(profiles: LupinConfig['profiles']): string {
  n++;
  const path = join(dir, `config-${String(n)}.json`);
  process.env.LUPIN_CONFIG = path;
  const config: LupinConfig = {
    activeProfile: 'other',
    port: 3456,
    localToken: 'tok',
    profiles: { other: OTHER, ...profiles },
  };
  writeFileSync(path, JSON.stringify(config));
  return path;
}

const read = (path: string): LupinConfig => JSON.parse(readFileSync(path, 'utf8')) as LupinConfig;
const gemini = findOAuthProvider('gemini');

// The shape an older Lupin wrote: the pay-per-token provider and lane.
const STALE = {
  provider: 'gemini',
  mode: 'translate' as const,
  auth: { type: 'oauth' as const, provider: 'gemini' },
  slots: { opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-3.5-flash', haiku: 'gemini-3.1-flash-lite' },
};

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => logs.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.LUPIN_CONFIG;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a stale subscription profile is repaired at login', () => {
  it('untouched default slots are replaced along with the provider and the lane', () => {
    const path = freshConfig({ 'gemini-sub': STALE });
    ensureOAuthProfile(gemini!);

    const p = read(path).profiles['gemini-sub'];
    expect(p?.provider).toBe('geminisub');
    expect(p?.mode).toBe('codeassist');
    // gemini-3.5-flash is a 404 on Code Assist: leaving it would keep the
    // profile broken in a way the user cannot see.
    expect(p?.slots.sonnet).toBe('gemini-2.5-flash');
    expect(logs.join('\n')).toContain('repaired');
  });

  it("the user's own slots are NEVER overwritten, only reported", () => {
    const custom = { ...STALE, slots: { ...STALE.slots, sonnet: 'my-own-choice' } };
    const path = freshConfig({ 'gemini-sub': custom });
    ensureOAuthProfile(gemini!);

    const p = read(path).profiles['gemini-sub'];
    expect(p?.provider).toBe('geminisub'); // the lane is still fixed
    expect(p?.mode).toBe('codeassist');
    expect(p?.slots.sonnet).toBe('my-own-choice'); // the choice survives
    expect(logs.join('\n')).toContain('my-own-choice'); // and is named, not hidden
  });

  it('a profile already on the right lane is left completely alone', () => {
    const good = {
      provider: 'geminisub',
      mode: 'codeassist' as const,
      auth: { type: 'oauth' as const, provider: 'gemini' },
      slots: { opus: 'a', sonnet: 'b', haiku: 'c' },
    };
    const path = freshConfig({ 'gemini-sub': good });
    const before = readFileSync(path, 'utf8');
    ensureOAuthProfile(gemini!);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(logs.join('\n')).not.toContain('repaired');
  });

  it('a missing profile is still created, as before', () => {
    const path = freshConfig({});
    ensureOAuthProfile(gemini!);
    const p = read(path).profiles['gemini-sub'];
    expect(p?.provider).toBe('geminisub');
    expect(logs.join('\n')).toContain('created');
  });
});
