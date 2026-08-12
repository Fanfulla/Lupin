// `lupin use <profile> [--bg <profile>]` (SPEC-CLI §1): switch the active
// profile by writing the config; the running server hot-reloads it, live
// Claude Code sessions pick it up on the next request.

import { loadConfig, saveConfig, type ProfileConfig } from '../config/config.js';
import { DEFAULT_PROFILES, type DefaultProfileDef } from '../providers/defaults.js';

/**
 * What `--bg none` writes back into the haiku slot (SPEC-CLI §1). The
 * delegation overwrote the model that was there, and nothing records it, so
 * the reset rebuilds it from the only honest sources: the profile's own
 * default (hosted profiles), or the sonnet model with a warning (a local
 * profile picked its models at init and they cannot be reconstructed).
 * Undefined when even sonnet delegates: there is no model name to write.
 */
export function backgroundReset(
  profileId: string,
  profile: ProfileConfig,
  defaults: DefaultProfileDef[] = DEFAULT_PROFILES,
): { haiku: string; source: 'default' | 'sonnet' } | undefined {
  const fromDefault = defaults.find((d) => d.id === profileId)?.slots?.haiku;
  if (fromDefault !== undefined) return { haiku: fromDefault, source: 'default' };
  const sonnet = profile.slots.sonnet;
  return typeof sonnet === 'string' ? { haiku: sonnet, source: 'sonnet' } : undefined;
}

const SLOTS = ['opus', 'sonnet', 'haiku'] as const;
type Slot = (typeof SLOTS)[number];

const USAGE =
  'usage: lupin use <profile> [--bg <profile>|none] [--opus <model>] [--sonnet <model>] [--haiku <model>]';

/**
 * Every flag this command takes, and nothing else. Unknown flags used to fall
 * through as if they had been accepted, so `lupin use p --opus m` switched the
 * profile, left the slot alone and said nothing about it. the OAuth login had been
 * printing exactly that command as the way to aim a discovered profile.
 */
export function parseUseArgs(
  args: string[],
): { name: string; bg?: string; slots: Partial<Record<Slot, string>> } | { error: string } {
  const positional: string[] = [];
  const slots: Partial<Record<Slot, string>> = {};
  let bg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const flag = arg.slice(2);
    const known = flag === 'bg' || (SLOTS as readonly string[]).includes(flag);
    if (!known) return { error: `unknown option "${arg}"` };
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) return { error: `"${arg}" needs a value` };
    i++;
    if (flag === 'bg') bg = value;
    else slots[flag as Slot] = value;
  }

  if (positional.length === 0) return { error: 'no profile named' };
  if (positional.length > 1) return { error: `too many arguments: ${positional.slice(1).join(', ')}` };
  // Both write the haiku slot, so honouring both would mean silently dropping
  // one of the two things the user asked for.
  if (bg !== undefined && slots.haiku !== undefined) {
    return { error: '--bg and --haiku both aim the haiku slot: pick one' };
  }
  return { name: positional[0] as string, ...(bg !== undefined ? { bg } : {}), slots };
}

export function useCommand(args: string[]): number {
  const parsed = parseUseArgs(args);
  if ('error' in parsed) {
    console.error(`${parsed.error}\n${USAGE}`);
    return 1;
  }
  const { name, bg, slots: aimed } = parsed;

  let config;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet: add a provider from the hub (run: lupin)');
    return 1;
  }

  const profile = config.profiles[name];
  if (profile === undefined) {
    console.error(`profile "${name}" not found. Available: ${Object.keys(config.profiles).join(', ')}`);
    return 1;
  }
  if (bg !== undefined && bg !== 'none' && config.profiles[bg] === undefined) {
    console.error(`--bg profile "${bg}" not found. Available: ${Object.keys(config.profiles).join(', ')}`);
    return 1;
  }

  let bgNote = '';
  if (bg === 'none') {
    const reset = backgroundReset(name, profile);
    if (reset === undefined) {
      console.error(`profile "${name}": the sonnet slot delegates too, so there is no model name to restore.`);
      console.error('  point --bg at a profile, or set the provider up again from the hub (run: lupin).');
      return 1;
    }
    profile.slots.haiku = reset.haiku;
    bgNote = ` (background/haiku → ${reset.haiku})`;
    if (reset.source === 'sonnet') {
      console.log(`i the original light model cannot be reconstructed: haiku falls back to "${reset.haiku}" (sonnet slot).`);
      console.log('  to assign a cheaper one again: set the profile up again from the hub.');
    }
  } else if (bg !== undefined) {
    profile.slots.haiku = { profile: bg };
    bgNote = ` (background/haiku → ${bg})`;
  }

  // Written, never checked: nothing here can know which model names the account
  // will accept, and inventing a validation would be worse than none (rule 5).
  const aimedNote: string[] = [];
  for (const slot of SLOTS) {
    const model = aimed[slot];
    if (model === undefined) continue;
    profile.slots[slot] = model;
    aimedNote.push(`${slot} → ${model}`);
  }

  config.activeProfile = name;
  saveConfig(config);

  console.log(`✓ active profile: ${name}${bgNote}`);
  if (aimedNote.length > 0) {
    console.log(`  slots aimed: ${aimedNote.join(', ')}`);
    console.log('  the names are written as given and NOT checked against the provider');
  }
  console.log('  live sessions switch on their next request: no restart needed');
  return 0;
}
