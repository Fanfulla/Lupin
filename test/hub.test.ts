import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfigPath, loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import { hubCommandWith, type HubDeps } from '../src/cli/hub.js';

let dir: string;
let previousDir: string | undefined;

function configured(): LupinConfig {
  return {
    activeProfile: 'test',
    port: 4567,
    localToken: 'configured-token',
    profiles: {
      test: {
        provider: 'moonshot',
        mode: 'passthrough',
        auth: { type: 'none' },
        slots: { opus: 'model', sonnet: 'model', haiku: 'model' },
      },
    },
  };
}

function runtime(overrides: Partial<HubDeps> = {}): HubDeps {
  return {
    isTTY: true,
    configExists: () => existsSync(defaultConfigPath()),
    loadConfig,
    tuiAvailable: async () => true,
    startBootstrap: async () => 'started',
    spawnTui: async () => 0,
    statusCommand: async () => 0,
    randomToken: () => 'bootstrap-token',
    env: { PATH: 'test-path' },
    error: () => undefined,
    ...overrides,
  };
}

beforeEach(() => {
  previousDir = process.env.LUPIN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'lupin-hub-'));
  process.env.LUPIN_DIR = dir;
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.LUPIN_DIR;
  else process.env.LUPIN_DIR = previousDir;
  rmSync(dir, { recursive: true, force: true });
});

describe('hub cold start', () => {
  it('starts one bootstrap daemon and gives its unchanged identity to the TUI without creating config', async () => {
    const startBootstrap = vi.fn<HubDeps['startBootstrap']>(async () => 'started');
    const spawnTui = vi.fn<HubDeps['spawnTui']>(async () => 0);

    const result = await hubCommandWith(runtime({ startBootstrap, spawnTui }));

    expect(result).toBe(0);
    expect(startBootstrap).toHaveBeenCalledOnce();
    expect(startBootstrap).toHaveBeenCalledWith({ port: 3456, localToken: 'bootstrap-token' });
    expect(spawnTui).toHaveBeenCalledWith({
      PATH: 'test-path',
      LUPIN_BOOTSTRAP_PORT: '3456',
      LUPIN_BOOTSTRAP_TOKEN: 'bootstrap-token',
    });
    expect(existsSync(defaultConfigPath())).toBe(false);
  });

  it('does not probe the sidecar or start a daemon without a TTY', async () => {
    const tuiAvailable = vi.fn<HubDeps['tuiAvailable']>(async () => true);
    const startBootstrap = vi.fn<HubDeps['startBootstrap']>(async () => 'started');
    const error = vi.fn<HubDeps['error']>();

    const result = await hubCommandWith(runtime({ isTTY: false, tuiAvailable, startBootstrap, error }));

    expect(result).toBe(1);
    expect(tuiAvailable).not.toHaveBeenCalled();
    expect(startBootstrap).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('no config yet: run `lupin init` first');
  });

  it('keeps the init guidance and does not start a daemon when the sidecar is absent', async () => {
    const startBootstrap = vi.fn<HubDeps['startBootstrap']>(async () => 'started');
    const error = vi.fn<HubDeps['error']>();

    const result = await hubCommandWith(runtime({ tuiAvailable: async () => false, startBootstrap, error }));

    expect(result).toBe(1);
    expect(startBootstrap).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('no config yet: run `lupin init` first');
  });
});

describe('configured hub', () => {
  it('launches the TUI without starting bootstrap when config already exists', async () => {
    saveConfig(configured());
    const startBootstrap = vi.fn<HubDeps['startBootstrap']>(async () => 'started');
    const spawnTui = vi.fn<HubDeps['spawnTui']>(async () => 0);

    const result = await hubCommandWith(runtime({ startBootstrap, spawnTui }));

    expect(result).toBe(0);
    expect(startBootstrap).not.toHaveBeenCalled();
    expect(spawnTui).toHaveBeenCalledWith({ PATH: 'test-path' });
  });

  it('keeps the text fallback and skips the sidecar probe without a TTY', async () => {
    saveConfig(configured());
    const tuiAvailable = vi.fn<HubDeps['tuiAvailable']>(async () => true);
    const statusCommand = vi.fn<HubDeps['statusCommand']>(async () => 0);

    const result = await hubCommandWith(runtime({ isTTY: false, tuiAvailable, statusCommand }));

    expect(result).toBe(0);
    expect(tuiAvailable).not.toHaveBeenCalled();
    expect(statusCommand).toHaveBeenCalledOnce();
  });
});
