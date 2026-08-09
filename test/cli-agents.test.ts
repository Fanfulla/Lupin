import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type LupinConfig } from '../src/config/config.js';
import {
  agentsCommand,
  findAgentFile,
  frontmatterField,
  parseAgentsArgs,
  wireFrontmatterModel,
} from '../src/cli/agents.js';
import { agentRouteId } from '../src/providers/resolve.js';

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
    expect(parseAgentsArgs(['set', 'a', '--profile', 'p'])).toEqual({
      kind: 'set',
      name: 'a',
      target: { profile: 'p' },
      wire: false,
    });
    expect(parseAgentsArgs(['set', 'a', '--model', 'm'])).toEqual({ kind: 'set', name: 'a', target: 'm', wire: false });
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

describe('--wire parsing (ADR-48)', () => {
  it('is a trailing switch on both verbs', () => {
    expect(parseAgentsArgs(['set', 'a', '--profile', 'p', '--wire'])).toEqual({
      kind: 'set',
      name: 'a',
      target: { profile: 'p' },
      wire: true,
    });
    expect(parseAgentsArgs(['unset', 'a', '--wire'])).toEqual({ kind: 'unset', name: 'a', wire: true });
    expect(parseAgentsArgs(['set', 'a', '--model', 'm'])).toMatchObject({ wire: false });
  });

  it('does not excuse a malformed set', () => {
    expect(parseAgentsArgs(['set', 'a', '--wire'])).toHaveProperty('error');
    expect(parseAgentsArgs(['set', 'a', '--profile', 'p', '--model', 'm', '--wire'])).toHaveProperty('error');
  });
});

describe('wireFrontmatterModel (ADR-48)', () => {
  const file = (fm: string, body = 'You are an agent.\n'): string => `---\n${fm}\n---\n\n${body}`;

  it('replaces an existing model line and reports the old value', () => {
    const out = wireFrontmatterModel(file('name: explore\nmodel: sonnet\ntools: Read'), 'X');
    if ('error' in out) throw new Error(out.error);
    expect(out.previous).toBe('sonnet');
    expect(out.content).toBe(file('name: explore\nmodel: X\ntools: Read'));
  });

  it('inserts the line when absent, touching nothing else', () => {
    const out = wireFrontmatterModel(file('name: explore'), 'X');
    if ('error' in out) throw new Error(out.error);
    expect(out.previous).toBeUndefined();
    expect(out.content).toBe(file('name: explore\nmodel: X'));
  });

  it('keeps CRLF files CRLF', () => {
    const crlf = '---\r\nname: a\r\n---\r\n\r\nbody\r\n';
    const out = wireFrontmatterModel(crlf, 'X');
    if ('error' in out) throw new Error(out.error);
    expect(out.content).toBe('---\r\nname: a\r\nmodel: X\r\n---\r\n\r\nbody\r\n');
  });

  it('refuses a file with no frontmatter instead of restructuring it', () => {
    expect(wireFrontmatterModel('just prose\n', 'X')).toHaveProperty('error');
    expect(wireFrontmatterModel('---\nnever closed\n', 'X')).toHaveProperty('error');
  });

  it('a model: line in the BODY is not the frontmatter field', () => {
    const content = file('name: a', 'the body says\nmodel: not-this-one\n');
    const out = wireFrontmatterModel(content, 'X');
    if ('error' in out) throw new Error(out.error);
    expect(out.content).toContain('model: not-this-one');
    expect(frontmatterField(out.content, 'model')).toBe('X');
  });
});

describe('findAgentFile', () => {
  const root = mkdtempSync(join(tmpdir(), 'lupin-agent-files-'));
  const projectDir = join(root, 'project', '.claude', 'agents');
  const homeDir = join(root, 'home', '.claude', 'agents');

  it('frontmatter name beats filename, project beats home, no fuzzier match', () => {
    mkdirSync(projectDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    // In the project dir the agent "explore" lives in a file NOT named after it.
    writeFileSync(join(projectDir, 'scout.md'), '---\nname: explore\n---\nbody\n');
    writeFileSync(join(projectDir, 'planner.md'), '---\ndescription: no name field\n---\nbody\n');
    writeFileSync(join(homeDir, 'explore.md'), '---\nname: explore\n---\nhome copy\n');

    expect(findAgentFile('explore', [projectDir, homeDir])).toBe(join(projectDir, 'scout.md'));
    expect(findAgentFile('planner', [projectDir, homeDir])).toBe(join(projectDir, 'planner.md'));
    expect(findAgentFile('ghost', [projectDir, homeDir])).toBeUndefined();
    // A missing directory is "not here", never a throw.
    expect(findAgentFile('explore', [join(root, 'nope'), homeDir])).toBe(join(homeDir, 'explore.md'));
    rmSync(root, { recursive: true, force: true });
  });
});

describe('agents set/unset --wire end to end (ADR-48)', () => {
  const cwd = process.cwd();
  const roots: string[] = [];
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'lupin-wire-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.claude', 'agents'), { recursive: true });
    process.chdir(projectRoot);
  });

  afterAll(() => {
    process.chdir(cwd);
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  it('set --wire writes the id into the frontmatter, unset --wire restores inherit', () => {
    const agentFile = join(projectRoot, '.claude', 'agents', 'explore.md');
    writeFileSync(agentFile, '---\nname: explore\nmodel: sonnet\n---\nYou explore.\n');

    expect(agentsCommand(['set', 'explore', '--profile', 'local', '--wire'])).toBe(0);
    expect(frontmatterField(readFileSync(agentFile, 'utf8'), 'model')).toBe(agentRouteId('explore'));
    expect(loadConfig(configPath).agents).toEqual({ explore: { profile: 'local' } });

    expect(agentsCommand(['unset', 'explore', '--wire'])).toBe(0);
    expect(frontmatterField(readFileSync(agentFile, 'utf8'), 'model')).toBe('inherit');
    expect(loadConfig(configPath).agents).toBeUndefined();
  });

  it('a missing file keeps the route, says so, and exits 1', () => {
    expect(agentsCommand(['set', 'zz-lupin-test-ghost', '--profile', 'local', '--wire'])).toBe(1);
    expect(loadConfig(configPath).agents).toEqual({ 'zz-lupin-test-ghost': { profile: 'local' } });
  });
});
