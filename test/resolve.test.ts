import { describe, expect, it } from 'vitest';
import type { LupinConfig, ProfileConfig } from '../src/config/config.js';
import {
  applyContentRoutes,
  gatewayModelId,
  resolveRequest,
  routeForContent,
  slotForModel,
} from '../src/providers/resolve.js';

function profile(overrides: Partial<ProfileConfig> = {}): ProfileConfig {
  return {
    provider: 'moonshot',
    mode: 'passthrough',
    auth: { type: 'bearer', apiKeyRef: 'K' },
    slots: { opus: 'model-big', sonnet: 'model-mid', haiku: 'model-small' },
    ...overrides,
  };
}

function config(profiles: Record<string, ProfileConfig>, active = 'main'): LupinConfig {
  return { activeProfile: active, port: 0, localToken: 't', profiles };
}

describe('slotForModel (SPEC-PROVIDERS §4)', () => {
  it('matches by substring: opus, haiku, default sonnet', () => {
    expect(slotForModel('claude-opus-9-20990101')).toBe('opus');
    expect(slotForModel('claude-haiku-9')).toBe('haiku');
    expect(slotForModel('claude-sonnet-9')).toBe('sonnet');
    expect(slotForModel('anything-else')).toBe('sonnet');
  });

  it('Claude 5 top tier (fable/mythos) lands on the opus slot', () => {
    expect(slotForModel('claude-fable-5')).toBe('opus');
    expect(slotForModel('claude-mythos-5')).toBe('opus');
  });
});

describe('[1m] suffix normalization (SPEC-PROVIDERS §4, Sonnet-5-era client)', () => {
  it('direct-use still matches when the model carries the [1m] suffix', () => {
    const r = resolveRequest(config({ main: profile() }), 'model-mid[1m]');
    expect(r.slot).toBe('direct');
    // upstream never sees the suffix
    expect(r.model).toBe('model-mid');
  });

  it('claude names with [1m] land on their slot', () => {
    const r = resolveRequest(config({ main: profile() }), 'claude-sonnet-5[1m]');
    expect(r.slot).toBe('sonnet');
    expect(r.model).toBe('model-mid');
  });

  it('the suffix is only stripped at the end of the id', () => {
    const r = resolveRequest(config({ main: profile() }), 'model-mid[1m]x');
    expect(r.slot).toBe('sonnet'); // no match: falls to slot mapping, not direct-use
  });
});

// The picker publishes prefixed ids (gatewayModelId) because Claude Code drops
// any id not starting with claude/anthropic; the prefix must vanish again here
// or every picked model would degrade onto the sonnet slot.
describe('gateway prefix normalization (SPEC-PROVIDERS §4.2)', () => {
  it('a picked model resolves direct-use, upstream sees the real name', () => {
    const r = resolveRequest(config({ main: profile() }), gatewayModelId('model-big'));
    expect(r.slot).toBe('direct');
    expect(r.model).toBe('model-big');
  });

  it('prefix and [1m] suffix are stripped together', () => {
    const r = resolveRequest(config({ main: profile() }), `${gatewayModelId('model-small')}[1m]`);
    expect(r.slot).toBe('direct');
    expect(r.model).toBe('model-small');
  });

  it('the prefix is only stripped at the start of the id', () => {
    const r = resolveRequest(config({ main: profile() }), `x${gatewayModelId('model-mid')}`);
    expect(r.slot).toBe('sonnet'); // no match: falls to slot mapping, not direct-use
  });

  it("a real claude-* name is untouched: it is not the picker's prefix", () => {
    const r = resolveRequest(config({ main: profile() }), 'claude-haiku-5');
    expect(r.slot).toBe('haiku');
    expect(r.model).toBe('model-small');
  });
});

describe('resolveRequest', () => {
  it('maps a claude-* name onto the slot model', () => {
    const r = resolveRequest(config({ main: profile() }), 'claude-opus-9');
    expect(r.model).toBe('model-big');
    expect(r.slot).toBe('opus');
    expect(r.profileName).toBe('main');
  });

  it('passes a real model name straight through', () => {
    const r = resolveRequest(config({ main: profile() }), 'model-small');
    expect(r.model).toBe('model-small');
    expect(r.slot).toBe('direct');
  });

  it('follows slot delegation to another profile', () => {
    const cfg = config({
      main: profile({ slots: { opus: 'model-big', sonnet: 'model-mid', haiku: { profile: 'bg' } } }),
      bg: profile({ provider: 'other', slots: { opus: 'x', sonnet: 'y', haiku: 'local-tiny' } }),
    });
    const r = resolveRequest(cfg, 'claude-haiku-9');
    expect(r.model).toBe('local-tiny');
    expect(r.profileName).toBe('bg');
  });

  it('throws on delegation to a missing profile', () => {
    const cfg = config({
      main: profile({ slots: { opus: 'a', sonnet: 'b', haiku: { profile: 'ghost' } } }),
    });
    expect(() => resolveRequest(cfg, 'claude-haiku-9')).toThrow(/ghost/);
  });

  it('throws on delegation cycles instead of looping forever', () => {
    const cfg = config({
      main: profile({ slots: { opus: 'a', sonnet: 'b', haiku: { profile: 'other' } } }),
      other: profile({ slots: { opus: 'a', sonnet: 'b', haiku: { profile: 'main' } } }),
    });
    expect(() => resolveRequest(cfg, 'claude-haiku-9')).toThrow(/cycle/);
  });

  it('throws when the active profile does not exist', () => {
    expect(() => resolveRequest(config({ main: profile() }, 'ghost'), 'claude-sonnet-9')).toThrow(/ghost/);
  });
});

describe('content-aware routing (SPEC-PROVIDERS §4quater)', () => {
  const routedProfile = (): ProfileConfig =>
    profile({
      routes: {
        longContext: { threshold: 1000, target: { profile: 'big' } },
        vision: { target: 'model-vision' },
        thinking: { target: 'model-think' },
      },
    });
  const cfg = (): LupinConfig =>
    config({
      main: routedProfile(),
      big: profile({ slots: { opus: 'huge', sonnet: 'huge', haiku: 'huge' } }),
    });

  const smallBody = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] };
  const bigBody = { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'x'.repeat(5000) }] };
  const visionBody = {
    model: 'claude-sonnet-5',
    messages: [{ role: 'user', content: [{ type: 'image', source: {} }] }],
  };
  const thinkingBody = { ...smallBody, thinking: { type: 'enabled', budget_tokens: 100 } };

  it('routeForContent: fixed priority longContext → vision → thinking', () => {
    const p = routedProfile();
    expect(routeForContent(p, smallBody)).toBeUndefined();
    expect(routeForContent(p, bigBody)).toBe('longContext');
    expect(routeForContent(p, { ...visionBody, thinking: { type: 'enabled' } })).toBe('vision');
    expect(routeForContent(p, thinkingBody)).toBe('thinking');
    expect(routeForContent(p, { ...smallBody, thinking: { type: 'disabled' } })).toBeUndefined();
  });

  it('applyContentRoutes: string target stays on the start profile, {profile} re-resolves', () => {
    const c = cfg();
    const base = resolveRequest(c, 'claude-sonnet-5');
    const think = applyContentRoutes(c, 'main', 'claude-sonnet-5', base, thinkingBody);
    expect(think.routed).toBe('thinking');
    expect(think.resolved.model).toBe('model-think');
    expect(think.resolved.profileName).toBe('main');
    const long = applyContentRoutes(c, 'main', 'claude-sonnet-5', base, bigBody);
    expect(long.routed).toBe('longContext');
    expect(long.resolved.model).toBe('huge');
    expect(long.resolved.profileName).toBe('big');
  });

  it('longContext dynamic threshold: 80% of the resolved model window, no explicit threshold', () => {
    // bigBody is about 1270 estimated tokens; a 1500 window gives a 1200 threshold, so it fires
    const c = config({
      main: profile({
        contextWindows: { 'model-mid': 1500 },
        routes: { longContext: { target: { profile: 'big' } } },
      }),
      big: profile({ slots: { opus: 'huge', sonnet: 'huge', haiku: 'huge' } }),
    });
    const base = resolveRequest(c, 'claude-sonnet-5');
    const out = applyContentRoutes(c, 'main', 'claude-sonnet-5', base, bigBody);
    expect(out.routed).toBe('longContext');
    expect(out.resolved.model).toBe('huge');
    expect(applyContentRoutes(c, 'main', 'claude-sonnet-5', base, smallBody).routed).toBeUndefined();
  });

  it('longContext dynamic: unknown window for the resolved model → route stays quiet', () => {
    const c = config({
      main: profile({
        contextWindows: { 'some-other-model': 100 },
        routes: { longContext: { target: { profile: 'big' } } },
      }),
      big: profile({ slots: { opus: 'huge', sonnet: 'huge', haiku: 'huge' } }),
    });
    const base = resolveRequest(c, 'claude-sonnet-5');
    expect(applyContentRoutes(c, 'main', 'claude-sonnet-5', base, bigBody).routed).toBeUndefined();
  });

  it('longContext dynamic: window read from the serving profile on delegated slots', () => {
    const c = config({
      main: profile({
        slots: { opus: 'model-big', sonnet: { profile: 'srv' }, haiku: 'model-small' },
        routes: { longContext: { target: 'model-big' } },
      }),
      srv: profile({
        slots: { opus: 'x', sonnet: 'served', haiku: 'z' },
        contextWindows: { served: 1500 },
      }),
    });
    const base = resolveRequest(c, 'claude-sonnet-5');
    expect(base.model).toBe('served');
    const out = applyContentRoutes(c, 'main', 'claude-sonnet-5', base, bigBody);
    expect(out.routed).toBe('longContext');
    expect(out.resolved.model).toBe('model-big');
    expect(out.resolved.profileName).toBe('main');
  });

  it('explicit threshold wins over the dynamic one', () => {
    // a huge window (the dynamic threshold is never reached) but an explicit low threshold, so it fires
    const c = config({
      main: profile({
        contextWindows: { 'model-mid': 10_000_000 },
        routes: { longContext: { threshold: 1000, target: { profile: 'big' } } },
      }),
      big: profile({ slots: { opus: 'huge', sonnet: 'huge', haiku: 'huge' } }),
    });
    const base = resolveRequest(c, 'claude-sonnet-5');
    expect(applyContentRoutes(c, 'main', 'claude-sonnet-5', base, bigBody).routed).toBe('longContext');
  });

  it('direct-use from the model picker is never rerouted', () => {
    const c = cfg();
    const direct = resolveRequest(c, 'model-mid'); // real model name → direct
    expect(direct.slot).toBe('direct');
    const out = applyContentRoutes(c, 'main', 'model-mid', direct, bigBody);
    expect(out.routed).toBeUndefined();
    expect(out.resolved.model).toBe('model-mid');
  });
});
