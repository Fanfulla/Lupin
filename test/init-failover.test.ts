import { describe, expect, it } from 'vitest';
import { isYes, pickFailover, visionCandidates } from '../src/cli/init.js';
import { validateConfig } from '../src/config/config.js';
import type { LocalModelInfo } from '../src/providers/local.js';

describe('pickFailover (§4septies): the user decides, never auto-activated', () => {
  const candidates = ['kimi', 'glm', 'gpt'];

  it('empty answer = no failover (the default is always "no")', () => {
    expect(pickFailover(candidates, '')).toBeUndefined();
    expect(pickFailover(candidates, '   ')).toBeUndefined();
  });

  it('a number picks by index', () => {
    expect(pickFailover(candidates, '1')).toBe('kimi');
    expect(pickFailover(candidates, '3')).toBe('gpt');
  });

  it('a name picks by exact match', () => {
    expect(pickFailover(candidates, 'glm')).toBe('glm');
  });

  it('an out-of-range index or unknown name = none', () => {
    expect(pickFailover(candidates, '9')).toBeUndefined();
    expect(pickFailover(candidates, 'deepseek')).toBeUndefined();
  });
});

// Audit 2026-07-22 gap `routes-unconfigurable-from-cli`: the vision route was
// validated and routable but unreachable without hand-editing JSON, and the
// discovery threw away the very capability that makes the offer sensible.
describe('visionCandidates (§4septies vision offer)', () => {
  const models: LocalModelInfo[] = [
    { id: 'big', chat: true, supportsVision: false },
    { id: 'eyes', chat: true, supportsVision: true },
    { id: 'silent', chat: true }, // runtime says nothing: never a candidate
  ];

  it('offers only the models that declare image support', () => {
    expect(visionCandidates(models, 'big')).toEqual(['eyes']);
  });

  it('never offers the model that would serve the request anyway', () => {
    expect(visionCandidates(models, 'eyes')).toEqual([]);
  });

  it('no declared vision model, no offer at all', () => {
    expect(visionCandidates([{ id: 'a', chat: true }], 'a')).toEqual([]);
  });
});

describe('isYes: the §4septies default is always no', () => {
  it('accepts only an explicit yes', () => {
    for (const yes of ['s', 'S', 'si', 'sì', 'y', 'YES']) expect(isYes(yes)).toBe(true);
    for (const no of ['', ' ', 'n', 'no', 'boh', 'sicuro']) expect(isYes(no)).toBe(false);
  });
});

// The offers must produce a config the validator accepts: a dynamic
// longContext threshold requires contextWindows on the same profile.
describe('what the local offers write', () => {
  it('vision + dynamic longContext validate together', () => {
    expect(() =>
      validateConfig({
        activeProfile: 'local',
        port: 3456,
        localToken: 't',
        profiles: {
          local: {
            provider: 'ollama',
            mode: 'passthrough',
            auth: { type: 'none' },
            slots: { opus: 'big', sonnet: 'big', haiku: 'small' },
            contextWindows: { big: 65_536, small: 8192 },
            routes: { vision: { target: 'eyes' }, longContext: { target: 'big' } },
          },
        },
      }),
    ).not.toThrow();
  });
});
