import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import { agentsCommand, parseAgentsArgs } from '../src/cli/agents.js';

const dir = mkdtempSync(join(tmpdir(), 'lupin-agents-cli-'));
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
      local: {
        provider: 'ollama',
        mode: 'passthrough',
        auth: { type: 'none' },
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

describe('parseAgentsArgs', () => {
  it('no args is the listing', () => {
    expect(parseAgentsArgs([])).toEqual({ kind: 'list' });
  });

  it('set requires exactly one of --profile / --model', () => {
    expect(parseAgentsArgs(['set', 'a', '--profile', 'p'])).toEqual({ kind: 'set', name: 'a', target: { profile: 'p' } });
    expect(parseAgentsArgs(['set', 'a', '--model', 'm'])).toEqual({ kind: 'set', name: 'a', target: 'm' });
    expect(parseAgentsArgs(['set', 'a'])).toHaveProperty('error');
    expect(parseAgentsArgs(['set', 'a', '--profile', 'p', '--model', 'm'])).toHaveProperty('error');
  });

  // ADR-42: a flag ignored in silence makes the tool lie about itself.
  it('refuses unknown subcommands and bad names', () => {
    expect(parseAgentsArgs(['frob'])).toHaveProperty('error');
    expect(parseAgentsArgs(['set', 'bad:name', '--model', 'm'])).toHaveProperty('error');
    expect(parseAgentsArgs(['unset', 'a', 'extra'])).toHaveProperty('error');
  });
});

describe('lupin agents (SPEC-CLI §1, §4decies)', () => {
  it('set --profile writes the delegation and set --model the string', () => {
    expect(agentsCommand(['set', 'explore', '--profile', 'local'])).toBe(0);
    expect(agentsCommand(['set', 'planner', '--model', 'big-model'])).toBe(0);
    const config = loadConfig(configPath);
    expect(config.agents).toEqual({ explore: { profile: 'local' }, planner: 'big-model' });
  });

  it('set --profile refuses an unknown profile', () => {
    expect(agentsCommand(['set', 'explore', '--profile', 'ghost'])).toBe(1);
    expect(loadConfig(configPath).agents).toBeUndefined();
  });

  it('unset removes the route, and the emptied table removes the key', () => {
    expect(agentsCommand(['set', 'explore', '--profile', 'local'])).toBe(0);
    expect(agentsCommand(['unset', 'explore'])).toBe(0);
    expect(loadConfig(configPath).agents).toBeUndefined();
  });

  it('unset on a missing route is exit 1', () => {
    expect(agentsCommand(['unset', 'ghost'])).toBe(1);
  });

  it('list works with and without routes', () => {
    expect(agentsCommand([])).toBe(0);
    expect(agentsCommand(['set', 'explore', '--profile', 'local'])).toBe(0);
    expect(agentsCommand([])).toBe(0);
  });
});
