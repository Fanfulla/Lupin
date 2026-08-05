import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config/config.js';
import { DEFAULT_PROFILES } from '../src/providers/defaults.js';
import { PROVIDERS } from '../src/providers/registry.js';
import { mergeProfile } from '../src/cli/init.js';
import { runEnv } from '../src/cli/run.js';

describe('default profiles (SPEC-PROVIDERS §3bis)', () => {
  it('every default that carries its slots builds a valid config via mergeProfile', () => {
    for (const d of DEFAULT_PROFILES.filter((p) => p.slots !== undefined)) {
      const config = mergeProfile(d);
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.activeProfile).toBe(d.id);
    }
  });

  // A default with no slots is one whose model names may not live here (rule 5):
  // a local runtime's are picked at init from its own server (§3ter), and a
  // subscription whose catalogue is per account has them read at login (§3quater).
  it('a default without slots must be filled by discovery, never merged as is', () => {
    const discovered = DEFAULT_PROFILES.filter((p) => p.slots === undefined);
    expect(discovered.length).toBeGreaterThan(0);
    expect(discovered.every((p) => p.local === true || p.oauthOnly === true)).toBe(true);
    for (const d of discovered) {
      expect(() => mergeProfile(d)).toThrow(/slots/);
      const config = mergeProfile(d, undefined, { opus: 'big', sonnet: 'big', haiku: 'small' });
      expect(() => validateConfig(config)).not.toThrow();
      expect(config.profiles[d.id]?.auth).toEqual({ type: 'none' });
      expect(config.profiles[d.id]?.slots).toEqual({ opus: 'big', sonnet: 'big', haiku: 'small' });
    }
  });

  it('local defaults are keyless, slot-less and carry a start hint', () => {
    for (const d of DEFAULT_PROFILES.filter((p) => p.local === true)) {
      expect(d.auth).toBe('none');
      expect(d.apiKeyEnv).toBeUndefined();
      expect(d.slots).toBeUndefined();
      expect(d.startHint).toBeTruthy();
    }
  });

  it('every default references a registered provider with a matching mode', () => {
    for (const d of DEFAULT_PROFILES) {
      const def = PROVIDERS[d.provider];
      expect(def, `provider "${d.provider}" of default "${d.id}"`).toBeDefined();
      expect(def?.modes).toContain(d.mode);
    }
  });

  // Paths are built by concatenation (`baseUrl + '/chat/completions'`), so a
  // trailing slash silently produces a double slash. Google documents its
  // OpenAI-compat base WITH one, which is exactly how this would slip in.
  it('no registry base URL ends in a slash', () => {
    for (const [id, def] of Object.entries(PROVIDERS)) {
      expect(def.baseUrl.endsWith('/'), `provider "${id}" baseUrl ends in "/"`).toBe(false);
      if (def.translateBaseUrl !== undefined) {
        expect(def.translateBaseUrl.endsWith('/'), `provider "${id}" translateBaseUrl ends in "/"`).toBe(false);
      }
    }
  });

  it('every default carries a verification date', () => {
    for (const d of DEFAULT_PROFILES) {
      expect(d.verified).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });

  it('context windows, where present, name models the profile actually serves', () => {
    for (const d of DEFAULT_PROFILES) {
      if (d.contextWindows === undefined) continue;
      const served = new Set(Object.values(d.slots ?? {}));
      for (const [model, window] of Object.entries(d.contextWindows)) {
        expect(served.has(model), `${d.id}: contextWindows names "${model}", which no slot serves`).toBe(true);
        expect(window).toBeGreaterThan(0);
      }
    }
  });

  it('the economy preset builds a valid config and escalates on hard tasks', () => {
    const withEconomy = DEFAULT_PROFILES.filter((d) => d.economy !== undefined);
    expect(withEconomy.length).toBeGreaterThan(0);
    for (const d of withEconomy) {
      const config = mergeProfile(d, undefined, undefined, true);
      expect(() => validateConfig(config)).not.toThrow();
      const profile = config.profiles[d.id];
      // The daily driver gets cheaper, the frontier model stays reachable.
      expect(profile?.slots.sonnet).toBe(d.economy?.slots.sonnet);
      expect(profile?.slots.opus).toBe(d.economy?.slots.opus);
      expect(profile?.routes?.thinking?.target).toBe(d.economy?.slots.opus);
      // Standard stays untouched by the preset existing at all.
      expect(mergeProfile(d).profiles[d.id]?.routes).toBeUndefined();
      expect(mergeProfile(d).profiles[d.id]?.slots.sonnet).toBe(d.slots?.sonnet);
    }
  });

  it('an economy longContext route always has a window to derive its threshold from', () => {
    for (const d of DEFAULT_PROFILES) {
      if (d.economy?.routes.longContext === undefined) continue;
      const served = d.economy.slots.sonnet;
      expect(d.contextWindows?.[served], `${d.id}: no window for "${served}"`).toBeGreaterThan(0);
    }
  });

  it('context windows reach the written profile', () => {
    const kimi = DEFAULT_PROFILES.find((p) => p.id === 'kimi');
    if (kimi === undefined) throw new Error('kimi default missing');
    expect(mergeProfile(kimi).profiles['kimi']?.contextWindows).toEqual(kimi.contextWindows);
  });

  it('mergeProfile is idempotent and preserves other profiles', () => {
    const first = DEFAULT_PROFILES[0];
    const second = DEFAULT_PROFILES[1];
    if (first === undefined || second === undefined) throw new Error('need 2+ defaults');
    const config = mergeProfile(second, mergeProfile(first));
    expect(Object.keys(config.profiles)).toEqual([first.id, second.id]);
    expect(config.activeProfile).toBe(second.id);
    const again = mergeProfile(second, config);
    expect(Object.keys(again.profiles)).toEqual([first.id, second.id]);
  });
});

describe('runEnv (SPEC-CLI §1 run)', () => {
  it('points the process tree at Lupin and clears ANTHROPIC_API_KEY', () => {
    expect(runEnv(3456, 'tok', {})).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3456',
      ANTHROPIC_AUTH_TOKEN: 'tok',
      ANTHROPIC_API_KEY: '',
      // without it Claude Code never calls GET /v1/models (opt-in client-side)
      CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
    });
  });

  it('an explicit gateway-discovery value from the user wins, opt-out included', () => {
    expect(runEnv(3456, 'tok', { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '' })).not.toHaveProperty(
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    );
    expect(runEnv(3456, 'tok', { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' })).not.toHaveProperty(
      'CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY',
    );
  });

  // raiseStreamIdleTimeout (SPEC-PROVIDERS §5, ADR-35): ds4-server serializes
  // requests on one slot, so a queued request gets zero bytes until its turn;
  // the engine's own Claude Code wrapper raises the client idle timeout to
  // 600000 ms for exactly this.
  it('raiseStreamIdleTimeout fills CLAUDE_STREAM_IDLE_TIMEOUT_MS when unset', () => {
    expect(runEnv(3456, 'tok', {}, ['raiseStreamIdleTimeout'])).toHaveProperty(
      'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
      '600000',
    );
  });

  it('an explicit stream-idle-timeout value from the user wins, empty included', () => {
    expect(runEnv(3456, 'tok', { CLAUDE_STREAM_IDLE_TIMEOUT_MS: '30000' }, ['raiseStreamIdleTimeout'])).not.toHaveProperty(
      'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
    );
    expect(runEnv(3456, 'tok', { CLAUDE_STREAM_IDLE_TIMEOUT_MS: '' }, ['raiseStreamIdleTimeout'])).not.toHaveProperty(
      'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
    );
  });

  it('no raiseStreamIdleTimeout quirk means no timeout injection', () => {
    expect(runEnv(3456, 'tok', {})).not.toHaveProperty('CLAUDE_STREAM_IDLE_TIMEOUT_MS');
    expect(runEnv(3456, 'tok', {}, [])).not.toHaveProperty('CLAUDE_STREAM_IDLE_TIMEOUT_MS');
  });
});
