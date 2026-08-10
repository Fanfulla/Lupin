import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfigPath, loadConfig, validateConfig } from '../src/config/config.js';
import { deviceIdPath } from '../src/config/credentials.js';

const VALID = {
  activeProfile: 'main',
  port: 3456,
  localToken: 'tok',
  profiles: {
    main: {
      provider: 'moonshot',
      mode: 'passthrough',
      auth: { type: 'bearer', apiKeyRef: 'K' },
      slots: { opus: 'a', sonnet: 'b', haiku: { profile: 'bg' } },
    },
    bg: {
      provider: 'other',
      mode: 'passthrough',
      auth: { type: 'x-api-key', apiKeyRef: 'K2' },
      slots: { opus: 'x', sonnet: 'y', haiku: 'z' },
    },
  },
};

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(validateConfig(VALID).activeProfile).toBe('main');
  });

  it('rejects an activeProfile missing from profiles', () => {
    expect(() => validateConfig({ ...VALID, activeProfile: 'ghost' })).toThrow(/ghost/);
  });

  it('accepts an empty profile map with an empty activeProfile', () => {
    expect(validateConfig({ ...VALID, activeProfile: '', profiles: {} }).profiles).toEqual({});
  });

  it('rejects a non-empty activeProfile when profiles is empty', () => {
    expect(() => validateConfig({ ...VALID, activeProfile: 'ghost', profiles: {} })).toThrow(/ghost/);
  });

  it('still rejects an empty activeProfile when profiles exist', () => {
    expect(() => validateConfig({ ...VALID, activeProfile: '' })).toThrow(/activeProfile/);
  });

  it('rejects a profile without apiKeyRef (keys never live in the config)', () => {
    const bad = structuredClone(VALID) as Record<string, unknown>;
    ((bad['profiles'] as Record<string, Record<string, unknown>>)['main'] as Record<string, unknown>)['auth'] = {
      type: 'bearer',
      apiKeyRef: '',
    };
    expect(() => validateConfig(bad)).toThrow(/apiKeyRef/);
  });

  it('accepts a keyless local profile (auth none, SPEC-PROVIDERS §3ter)', () => {
    const cfg = structuredClone(VALID) as typeof VALID;
    (cfg.profiles.main as Record<string, unknown>)['auth'] = { type: 'none' };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects an unknown auth type', () => {
    const bad = structuredClone(VALID) as typeof VALID;
    (bad.profiles.main as Record<string, unknown>)['auth'] = { type: 'basic' };
    expect(() => validateConfig(bad)).toThrow(/"none"/);
  });

  it('rejects a slot that is neither model nor delegation', () => {
    const bad = structuredClone(VALID) as typeof VALID;
    (bad.profiles.main.slots as Record<string, unknown>)['haiku'] = 5;
    expect(() => validateConfig(bad)).toThrow(/haiku/);
  });

  it('routes.longContext without threshold requires contextWindows (§4quater)', () => {
    const cfg = structuredClone(VALID) as typeof VALID;
    (cfg.profiles.main as Record<string, unknown>)['routes'] = { longContext: { target: 'big-model' } };
    expect(() => validateConfig(cfg)).toThrow(/contextWindows/);
    (cfg.profiles.main as Record<string, unknown>)['contextWindows'] = { 'big-model': 200000 };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects non-positive contextWindows values', () => {
    const bad = structuredClone(VALID) as typeof VALID;
    (bad.profiles.main as Record<string, unknown>)['contextWindows'] = { m: 0 };
    expect(() => validateConfig(bad)).toThrow(/contextWindows\.m/);
  });

  it('rejects a missing localToken', () => {
    expect(() => validateConfig({ ...VALID, localToken: '' })).toThrow(/localToken/);
  });
});

describe('loadConfig', () => {
  // Every temp workspace is removed: without this each run left two behind
  // (101 had piled up in %TEMP% by 2026-07-19).
  const dirs: string[] = [];
  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'lupin-test-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('loads and validates from disk', () => {
    const file = join(workspace(), 'config.json');
    writeFileSync(file, JSON.stringify(VALID));
    expect(loadConfig(file).port).toBe(3456);
  });

  it('fails with a clear message on invalid JSON', () => {
    const file = join(workspace(), 'config.json');
    writeFileSync(file, '{broken');
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });
});

// Found live by the 2026-07-24 npm-pack smoke: LUPIN_DIR moved pidfile and log
// but NOT the config, so a sandboxed run booted a daemon on the user's real
// profile. The whole home moves together.
describe('defaultConfigPath honors LUPIN_DIR (split-brain fix)', () => {
  const saved = { dir: process.env.LUPIN_DIR, cfg: process.env.LUPIN_CONFIG };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = saved.dir;
    if (saved.cfg === undefined) delete process.env.LUPIN_CONFIG;
    else process.env.LUPIN_CONFIG = saved.cfg;
  });

  it('LUPIN_DIR moves the config with the rest of the home', () => {
    delete process.env.LUPIN_CONFIG;
    process.env.LUPIN_DIR = join('X:', 'somewhere');
    expect(defaultConfigPath()).toBe(join('X:', 'somewhere', 'config.json'));
  });

  it('LUPIN_CONFIG stays the file-level override, above LUPIN_DIR', () => {
    process.env.LUPIN_DIR = join('X:', 'somewhere');
    process.env.LUPIN_CONFIG = join('Y:', 'exact', 'file.json');
    expect(defaultConfigPath()).toBe(join('Y:', 'exact', 'file.json'));
  });
});

describe('deviceIdPath honors LUPIN_DIR (residual split-brain, review 2026-07-24)', () => {
  const saved = { dir: process.env.LUPIN_DIR, dev: process.env.LUPIN_DEVICE_ID };
  afterEach(() => {
    if (saved.dir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = saved.dir;
    if (saved.dev === undefined) delete process.env.LUPIN_DEVICE_ID;
    else process.env.LUPIN_DEVICE_ID = saved.dev;
  });

  it('the device identity moves with the home', () => {
    delete process.env.LUPIN_DEVICE_ID;
    process.env.LUPIN_DIR = join('X:', 'sandbox');
    expect(deviceIdPath()).toBe(join('X:', 'sandbox', 'device_id'));
  });

  it('LUPIN_DEVICE_ID stays the file-level override', () => {
    process.env.LUPIN_DIR = join('X:', 'sandbox');
    process.env.LUPIN_DEVICE_ID = join('Y:', 'id');
    expect(deviceIdPath()).toBe(join('Y:', 'id'));
  });
});
