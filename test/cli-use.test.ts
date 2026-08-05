import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import { backgroundReset, useCommand } from '../src/cli/use.js';
import { DEFAULT_PROFILES } from '../src/providers/defaults.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-use-'));
const configPath = join(dir, 'config.json');

function baseConfig(): LupinConfig {
  return {
    activeProfile: 'kimi',
    port: 3456,
    localToken: 'tok',
    profiles: {
      kimi: {
        provider: 'moonshot',
        mode: 'passthrough',
        auth: { type: 'bearer', apiKeyRef: 'K' },
        slots: { opus: 'a', sonnet: 'b', haiku: 'c' },
      },
      gpt: {
        provider: 'openai',
        mode: 'translate',
        auth: { type: 'bearer', apiKeyRef: 'G' },
        slots: { opus: 'x', sonnet: 'y', haiku: 'z' },
      },
    },
  };
}

beforeEach(() => {
  process.env.LUPIN_CONFIG = configPath;
  saveConfig(baseConfig(), configPath);
});

afterAll(() => {
  delete process.env.LUPIN_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe('lupin use (SPEC-CLI §1)', () => {
  it('switches the active profile', () => {
    expect(useCommand(['gpt'])).toBe(0);
    expect(loadConfig(configPath).activeProfile).toBe('gpt');
  });

  it('--bg delegates the haiku slot to another profile', () => {
    expect(useCommand(['gpt', '--bg', 'kimi'])).toBe(0);
    const config = loadConfig(configPath);
    expect(config.activeProfile).toBe('gpt');
    expect(config.profiles['gpt']?.slots.haiku).toEqual({ profile: 'kimi' });
  });

  it('unknown profile → exit 1, config untouched', () => {
    expect(useCommand(['nope'])).toBe(1);
    expect(loadConfig(configPath).activeProfile).toBe('kimi');
  });

  it('missing --bg value or profile name → exit 1', () => {
    expect(useCommand([])).toBe(1);
    expect(useCommand(['gpt', '--bg'])).toBe(1);
    expect(useCommand(['gpt', '--bg', 'nope'])).toBe(1);
  });
});

// `lupin login` has always printed `lupin use <profile> --opus <model>` as the
// way to aim a profile whose models came from the account. The flag did not
// exist, and `use` ignored it in silence: the switch succeeded, the slot did
// not move, and nothing said so (found live against Copilot, 2026-08-05).
describe('lupin use: aiming the slots (SPEC-CLI §1)', () => {
  it('--opus/--sonnet/--haiku write the slot they name', () => {
    expect(useCommand(['gpt', '--opus', 'big', '--sonnet', 'mid', '--haiku', 'small'])).toBe(0);
    const config = loadConfig(configPath);
    expect(config.activeProfile).toBe('gpt');
    expect(config.profiles['gpt']?.slots).toEqual({ opus: 'big', sonnet: 'mid', haiku: 'small' });
  });

  it('aims a slot without touching the others', () => {
    expect(useCommand(['gpt', '--opus', 'big'])).toBe(0);
    expect(loadConfig(configPath).profiles['gpt']?.slots).toEqual({ opus: 'big', sonnet: 'y', haiku: 'z' });
  });

  it('an unknown flag is refused instead of ignored, and nothing is written', () => {
    expect(useCommand(['gpt', '--opuss', 'big'])).toBe(1);
    const config = loadConfig(configPath);
    expect(config.activeProfile).toBe('kimi');
    expect(config.profiles['gpt']?.slots.opus).toBe('x');
  });

  it('a flag with no value is refused', () => {
    expect(useCommand(['gpt', '--opus'])).toBe(1);
    expect(loadConfig(configPath).activeProfile).toBe('kimi');
  });

  it('--bg and --haiku both aim the same slot, so asking for both is refused', () => {
    expect(useCommand(['gpt', '--bg', 'kimi', '--haiku', 'small'])).toBe(1);
    expect(loadConfig(configPath).activeProfile).toBe('kimi');
  });
});

// Audit 2026-07-22 gap `routes-unconfigurable-from-cli` (part 3): --bg wrote a
// delegation with no way back, so the only exit was hand-editing the JSON.
describe('lupin use --bg none (delegation reset)', () => {
  it('restores the haiku model from the profile default when there is one', () => {
    expect(useCommand(['kimi', '--bg', 'gpt'])).toBe(0);
    expect(loadConfig(configPath).profiles['kimi']?.slots.haiku).toEqual({ profile: 'gpt' });

    expect(useCommand(['kimi', '--bg', 'none'])).toBe(0);
    const restored = loadConfig(configPath).profiles['kimi']?.slots.haiku;
    const fromDefaults = DEFAULT_PROFILES.find((d) => d.id === 'kimi')?.slots?.haiku;
    expect(restored).toBe(fromDefaults);
  });

  it('falls back to the sonnet model for a profile with no default, saying so', () => {
    const cfg = baseConfig();
    cfg.profiles['local'] = {
      provider: 'ollama',
      mode: 'passthrough',
      auth: { type: 'none' },
      slots: { opus: 'big', sonnet: 'big', haiku: { profile: 'gpt' } },
    };
    saveConfig(cfg, configPath);
    expect(useCommand(['local', '--bg', 'none'])).toBe(0);
    expect(loadConfig(configPath).profiles['local']?.slots.haiku).toBe('big');
  });

  it('refuses instead of inventing a name when sonnet delegates too', () => {
    const cfg = baseConfig();
    cfg.profiles['local'] = {
      provider: 'ollama',
      mode: 'passthrough',
      auth: { type: 'none' },
      slots: { opus: 'big', sonnet: { profile: 'gpt' }, haiku: { profile: 'gpt' } },
    };
    saveConfig(cfg, configPath);
    expect(useCommand(['local', '--bg', 'none'])).toBe(1);
    expect(loadConfig(configPath).profiles['local']?.slots.haiku).toEqual({ profile: 'gpt' });
  });

  it('backgroundReset prefers the default over the sonnet fallback', () => {
    const profile = baseConfig().profiles['kimi'];
    if (profile === undefined) throw new Error('fixture');
    expect(backgroundReset('kimi', profile, [])).toEqual({ haiku: 'b', source: 'sonnet' });
    expect(
      backgroundReset('kimi', profile, [
        { id: 'kimi', provider: 'moonshot', mode: 'passthrough', description: '', auth: 'bearer', slots: { opus: 'o', sonnet: 's', haiku: 'h' }, verified: '2026-07-24' },
      ]),
    ).toEqual({ haiku: 'h', source: 'default' });
  });
});
