// `lupin agents` (SPEC-CLI §1, SPEC-PROVIDERS §4decies, ADR-47): the CLI
// surface of the agent routes. List prints the table and the exact id to
// paste; set/unset edit it through the same write path as `use` (load, mutate,
// save; the daemon hot-reloads).

import { AGENT_NAME_RE, loadConfig, saveConfig, type SlotTarget } from '../config/config.js';
import { agentRouteId } from '../providers/resolve.js';

const USAGE = `usage: lupin agents                                  list the agent routes
       lupin agents set <name> --profile <profile>   route the agent to a profile (its sonnet slot)
       lupin agents set <name> --model <model>       route the agent to a model of the serving profile
       lupin agents unset <name>                     remove the route`;

/** The conventional blanket route `lupin run` wires into CLAUDE_CODE_SUBAGENT_MODEL. */
export const SUBAGENTS_ROUTE = 'subagents';

export function targetLabel(target: SlotTarget): string {
  return typeof target === 'string' ? target : `->${target.profile}`;
}

export function parseAgentsArgs(
  args: string[],
): { kind: 'list' } | { kind: 'set'; name: string; target: SlotTarget } | { kind: 'unset'; name: string } | { error: string } {
  if (args.length === 0) return { kind: 'list' };
  const [verb, name, ...rest] = args;
  if (verb !== 'set' && verb !== 'unset') return { error: `unknown subcommand "${String(verb)}"` };
  if (name === undefined || name.startsWith('--')) return { error: `${verb} needs an agent name` };
  if (!AGENT_NAME_RE.test(name)) {
    return { error: `"${name}" is not a valid agent name (allowed: A-Z a-z 0-9 . _ -, max 32)` };
  }
  if (verb === 'unset') {
    if (rest.length > 0) return { error: `too many arguments: ${rest.join(', ')}` };
    return { kind: 'unset', name };
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
  return { kind: 'set', name, target: rest[0] === '--profile' ? { profile: value } : value };
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
    console.error('no config yet: run `lupin init` first');
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
  return 0;
}
