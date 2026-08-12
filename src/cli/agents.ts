// `lupin agents` (SPEC-CLI §1, SPEC-PROVIDERS §4decies, ADR-47): the CLI
// surface of the agent routes. List prints the table and the exact id to
// paste; set/unset edit it through the same write path as `use` (load, mutate,
// save; the daemon hot-reloads). `--wire` (ADR-48) additionally writes the
// agent definition's frontmatter `model:` field, the one sanctioned write into
// the user's harness: explicit flag, that single field, old value printed.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGENT_NAME_RE, loadConfig, saveConfig, type SlotTarget } from '../config/config.js';
import { agentRouteId } from '../providers/resolve.js';

const USAGE = `usage: lupin agents                                  list the agent routes
       lupin agents set <name> --profile <profile>   route the agent to a profile (its sonnet slot)
       lupin agents set <name> --model <model>       route the agent to a model of the serving profile
       lupin agents unset <name>                     remove the route
       ... --wire                                    also write the agent file's frontmatter model:
                                                     (set aims it at the route, unset restores inherit)`;

/** The conventional blanket route `lupin run` wires into CLAUDE_CODE_SUBAGENT_MODEL. */
export const SUBAGENTS_ROUTE = 'subagents';

export function targetLabel(target: SlotTarget): string {
  return typeof target === 'string' ? target : `->${target.profile}`;
}

export function parseAgentsArgs(
  args: string[],
):
  | { kind: 'list' }
  | { kind: 'set'; name: string; target: SlotTarget; wire: boolean }
  | { kind: 'unset'; name: string; wire: boolean }
  | { error: string } {
  if (args.length === 0) return { kind: 'list' };
  const [verb, name, ...tail] = args;
  if (verb !== 'set' && verb !== 'unset') return { error: `unknown subcommand "${String(verb)}"` };
  if (name === undefined || name.startsWith('--')) return { error: `${verb} needs an agent name` };
  if (!AGENT_NAME_RE.test(name)) {
    return { error: `"${name}" is not a valid agent name (allowed: A-Z a-z 0-9 . _ -, max 32)` };
  }
  // --wire is a trailing switch on both verbs (ADR-48), taken off before the
  // per-verb shape check so the two rules stay independent.
  const wire = tail.at(-1) === '--wire';
  const rest = wire ? tail.slice(0, -1) : tail;
  if (verb === 'unset') {
    if (rest.length > 0) return { error: `too many arguments: ${rest.join(', ')}` };
    return { kind: 'unset', name, wire };
  }
  // set: exactly one of --profile / --model, refusing anything else (ADR-42:
  // a flag that is ignored in silence makes the tool lie about itself).
  if (rest.length !== 2 || (rest[0] !== '--profile' && rest[0] !== '--model')) {
    return { error: 'set needs exactly one of --profile <profile> or --model <model>' };
  }
  const value = rest[1];
  if (value === undefined || value === '' || value.startsWith('--')) {
    return { error: `"${rest[0]}" needs a value` };
  }
  return { kind: 'set', name, target: rest[0] === '--profile' ? { profile: value } : value, wire };
}

// --- The --wire half (ADR-48): the frontmatter edit and the file it lands on.

/** The frontmatter block of an agent file: its inner text and where it sits. */
function frontmatterBlock(content: string): { start: number; end: number; block: string } | undefined {
  const open = /^---\r?\n/.exec(content);
  if (open === null) return undefined;
  const closeRe = /\r?\n---[^\S\r\n]*(\r?\n|$)/g;
  closeRe.lastIndex = open[0].length;
  const close = closeRe.exec(content);
  if (close === null) return undefined;
  return { start: open[0].length, end: close.index, block: content.slice(open[0].length, close.index) };
}

/** A field's value inside the frontmatter, or undefined. */
export function frontmatterField(content: string, field: string): string | undefined {
  const fm = frontmatterBlock(content);
  if (fm === undefined) return undefined;
  const m = new RegExp(`^${field}:[^\\S\\r\\n]*(.*)$`, 'm').exec(fm.block);
  return m === null ? undefined : (m[1] as string).trim();
}

/**
 * Sets the frontmatter `model:` field to `value`, replacing the existing line
 * or inserting one at the end of the block. Everything outside that one line
 * is byte-identical; a file with no frontmatter block is refused rather than
 * restructured (ADR-48).
 */
export function wireFrontmatterModel(
  content: string,
  value: string,
): { content: string; previous?: string } | { error: string } {
  const fm = frontmatterBlock(content);
  if (fm === undefined) return { error: 'the file has no frontmatter block to edit' };
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const modelRe = /^model:[^\S\r\n]*(.*)$/m;
  const existing = modelRe.exec(fm.block);
  const newBlock =
    existing === null ? `${fm.block}${eol}model: ${value}` : fm.block.replace(modelRe, `model: ${value}`);
  return {
    content: content.slice(0, fm.start) + newBlock + content.slice(fm.end),
    ...(existing === null ? {} : { previous: (existing[1] as string).trim() }),
  };
}

/** Where agent definitions live: the project first, then the user home. */
export function agentDirs(cwd: string = process.cwd(), home: string = homedir()): string[] {
  return [join(cwd, '.claude', 'agents'), join(home, '.claude', 'agents')];
}

/**
 * The definition file of agent `name`: per directory, a frontmatter `name:`
 * match wins over a `<name>.md` filename match, and the project directory wins
 * over the user one. Nothing fuzzier: a wrong match would edit the wrong file.
 */
export function findAgentFile(name: string, dirs: string[] = agentDirs()): string | undefined {
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
    } catch {
      continue; // no such directory: not an error, just not here
    }
    let byFilename: string | undefined;
    for (const entry of entries) {
      const path = join(dir, entry);
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      if (frontmatterField(content, 'name') === name) return path;
      if (entry === `${name}.md`) byFilename = path;
    }
    if (byFilename !== undefined) return byFilename;
  }
  return undefined;
}

/**
 * The --wire gesture: sets the found agent file's `model:` to `value` and says
 * exactly what changed. Returns the exit code; the route itself was already
 * saved by the caller, and every failure path says so.
 */
function wireAgentFile(name: string, value: string): number {
  const dirs = agentDirs();
  const file = findAgentFile(name, dirs);
  if (file === undefined) {
    console.error(`--wire: no agent definition found for "${name}" (looked in ${dirs.join(', ')})`);
    console.error('  the route itself is saved. Built-in agents have no file: for those, use the');
    console.error(`  "${SUBAGENTS_ROUTE}" blanket route. For a custom agent, add the line yourself:`);
    console.error(`  model: ${value}`);
    return 1;
  }
  const wired = wireFrontmatterModel(readFileSync(file, 'utf8'), value);
  if ('error' in wired) {
    console.error(`--wire: ${file}: ${wired.error}`);
    console.error(`  the route itself is saved. Add the line yourself: model: ${value}`);
    return 1;
  }
  writeFileSync(file, wired.content);
  console.log(`✓ wired ${file}`);
  console.log(`  model: ${wired.previous ?? '(absent)'} -> ${value}`);
  return 0;
}

export function agentsCommand(args: string[]): number {
  const parsed = parseAgentsArgs(args);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 1;
  }

  let config;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet: add a provider from the hub (run: lupin)');
    return 1;
  }

  if (parsed.kind === 'list') {
    const table = config.agents ?? {};
    const names = Object.keys(table);
    if (names.length === 0) {
      console.log('no agent routes configured. First one:');
      console.log(`  lupin agents set ${SUBAGENTS_ROUTE} --profile <profile>`);
    } else {
      for (const name of names) {
        const target = table[name] as SlotTarget;
        console.log(`${name.padEnd(20)} ${targetLabel(target).padEnd(24)} ${agentRouteId(name)}`);
      }
    }
    console.log('');
    console.log('the id goes where Claude Code accepts a model id: an agent\'s frontmatter');
    console.log('`model:`, the Agent tool `model` parameter, or CLAUDE_CODE_SUBAGENT_MODEL.');
    console.log(`the "${SUBAGENTS_ROUTE}" route is special only in \`lupin run\`: when declared, it fills`);
    console.log(`CLAUDE_CODE_SUBAGENT_MODEL=${agentRouteId(SUBAGENTS_ROUTE)} unless you set the variable yourself.`);
    console.log('client precedence: CLAUDE_CODE_SUBAGENT_MODEL overrides frontmatter, so the');
    console.log(`blanket "${SUBAGENTS_ROUTE}" route and per-agent frontmatter ids do not compose.`);
    return 0;
  }

  if (parsed.kind === 'unset') {
    if (config.agents?.[parsed.name] === undefined) {
      console.error(`no agent route "${parsed.name}". Configured: ${Object.keys(config.agents ?? {}).join(', ') || '(none)'}`);
      return 1;
    }
    delete config.agents[parsed.name];
    if (Object.keys(config.agents).length === 0) delete config.agents;
    saveConfig(config);
    console.log(`✓ agent route removed: ${parsed.name}`);
    // `inherit` is the documented client default, stated rather than a guess:
    // Lupin never recorded what the field held before the wire (ADR-48).
    if (parsed.wire) return wireAgentFile(parsed.name, 'inherit');
    return 0;
  }

  const target = parsed.target;
  if (typeof target !== 'string' && config.profiles[target.profile] === undefined) {
    console.error(`profile "${target.profile}" not found. Available: ${Object.keys(config.profiles).join(', ')}`);
    return 1;
  }
  config.agents = { ...config.agents, [parsed.name]: target };
  saveConfig(config);
  console.log(`✓ agent route: ${parsed.name} ${targetLabel(target)}`);
  console.log(`  id to use in the agent definition: ${agentRouteId(parsed.name)}`);
  if (typeof target === 'string') {
    console.log('  the model name is written as given and NOT checked against the provider');
  } else {
    console.log(`  requests land on ${target.profile}'s sonnet slot (an agent id names no tier)`);
  }
  console.log('  live sessions switch on their next request: no restart needed');
  if (parsed.wire) return wireAgentFile(parsed.name, agentRouteId(parsed.name));
  return 0;
}
