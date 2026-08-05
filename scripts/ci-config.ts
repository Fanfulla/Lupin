// Writes a throwaway Lupin config for the weekly doctor workflow.
//
// Built from the same DEFAULT_PROFILES the wizard uses, so CI can never score a
// setup that differs from what a user gets. Exists as a file rather than an
// inline `tsx -e` because eval mode does not take ESM imports.
//
// Usage: LUPIN_CI_PROFILE=kimi npx tsx scripts/ci-config.ts [outputPath]

import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mergeProfile } from '../src/cli/init.js';
import { DEFAULT_PROFILES } from '../src/providers/defaults.js';

const name = process.env['LUPIN_CI_PROFILE'] ?? 'kimi';
const out = process.argv[2] ?? join(homedir(), '.lupin', 'config.json');

const def = DEFAULT_PROFILES.find((p) => p.id === name);
if (def === undefined) {
  const known = DEFAULT_PROFILES.map((p) => p.id).join(', ');
  throw new Error(`no default profile "${name}". Known: ${known}`);
}
if (def.local === true) {
  throw new Error(`profile "${name}" is a local runtime: CI has no model server to point it at`);
}

const config = mergeProfile(def);
config.localToken = randomBytes(24).toString('hex');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`config for "${name}" written to ${out}`);
