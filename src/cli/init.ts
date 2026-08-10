// `lupin init` (SPEC-CLI §1): a wizard that picks a provider, takes the key
// (never echoed), tests connectivity and writes the config. Idempotent:
// re-running it adds profiles instead of replacing them.

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import {
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type LupinConfig,
  type ProfileConfig,
  type RoutesConfig,
  type SlotName,
} from '../config/config.js';
import { credentialStoreLabel, setCredential } from '../config/credentials.js';
import { DEFAULT_PROFILES, type DefaultProfileDef } from '../providers/defaults.js';
import { PROVIDERS } from '../providers/registry.js';
import { mergeProbe, persistableWindow, probeLocalModels, type LocalModelInfo } from '../providers/local.js';
import { DOCTOR_MIN_CONTEXT, preflightContext } from '../doctor/plan.js';
import { testProviderKey } from '../server/connectivity.js';
import { banner } from './banner.js';
import { offerRecommendedSkills } from './skills-offer.js';
import type { BootstrapIdentity } from './login.js';

export async function initCommand(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error('lupin init is interactive: run it in a terminal');
    return 1;
  }
  const started = Date.now();
  console.log(banner());
  console.log('init: choose a provider\n');
  // Subscription-only profiles have no key to paste: they are reached through
  // `lupin login <provider>`, so the key wizard never offers them.
  const choices = DEFAULT_PROFILES.filter((d) => d.oauthOnly !== true);
  choices.forEach((d, i) => {
    console.log(`  ${String(i + 1)}. ${d.id.padEnd(12)} ${d.description}`);
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pickRaw = await rl.question(`\nProvider [1-${String(choices.length)}]: `);
  rl.close();
  const pick = choices[Number(pickRaw.trim()) - 1];
  if (pick === undefined) {
    console.error('invalid choice');
    return 1;
  }

  if (pick.local === true) return await initLocal(pick, started);
  if (pick.apiKeyEnv === undefined) {
    console.error(`profile "${pick.id}" has no apiKeyEnv in the defaults: registry bug`);
    return 1;
  }

  const key = await readSecret(`API key ${pick.id} (hidden input): `);
  if (key === '') {
    console.error('empty key, cancelled');
    return 1;
  }

  console.log('... connectivity test (1 token)');
  const test = await testProviderKey(pick, key);
  if (test.ok) {
    console.log(`✓ connected: ${test.detail}`);
  } else {
    console.error(`✗ the provider does not answer: ${test.detail}`);
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const anyway = await rl2.question('Save anyway? [y/N] ');
    rl2.close();
    if (anyway.trim().toLowerCase() !== 'y') return 1;
  }

  // The pattern users actually described is not "swap the strong model" but
  // "cheap by default, strong when the task earns it": offered here rather
  // than left to hand-written JSON.
  let economy = false;
  if (pick.economy !== undefined) {
    const rl3 = createInterface({ input: process.stdin, output: process.stdout });
    console.log('\nSpending profile:');
    console.log('  1. standard   everything on the top model');
    console.log(`  2. economy    ${pick.economy.description}`);
    const choice = await rl3.question('Choice [1]: ');
    rl3.close();
    economy = choice.trim() === '2';
  }

  setCredential(pick.apiKeyEnv, key);
  console.log(`  (key stored in: ${credentialStoreLabel()})`);
  const existing = existsSync(defaultConfigPath()) ? loadConfig() : undefined;
  const merged = mergeProfile(pick, existing, undefined, economy);
  const failoverPick = await offerFailover(existing, pick.id);
  if (failoverPick !== undefined) {
    const profile = merged.profiles[pick.id];
    if (profile !== undefined) profile.failover = failoverPick;
  }
  saveConfig(merged);

  console.log(`\n✓ profile "${pick.id}"${economy ? ' (economy)' : ''} is active, config: ${defaultConfigPath()}`);
  await offerRecommendedSkills();
  printNextSteps(pick.id, started);
  return 0;
}

/**
 * §4septies: never auto-activate. If another configured profile could back
 * this one up, OFFER it as a failover and let the user decide (default "no").
 * Returns the chosen failover profile, or undefined.
 */
async function offerFailover(existing: LupinConfig | undefined, newId: string): Promise<string | undefined> {
  const candidates = Object.keys(existing?.profiles ?? {}).filter((n) => n !== newId);
  if (candidates.length === 0) return undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(`\nFailover (optional): when "${newId}" fails on a rate limit or an overload, retry once`);
  console.log('through another profile instead of surfacing the error. Never on 4xx or auth, never cascading.');
  candidates.forEach((n, i) => console.log(`  ${String(i + 1)}. ${n}`));
  const ans = await rl.question('Backup profile [enter = none]: ');
  rl.close();
  const chosen = pickFailover(candidates, ans);
  if (chosen === undefined && ans.trim() !== '') console.log('invalid choice: no failover set');
  return chosen;
}

/** Pure selection, exported for tests: empty = none; N = by index; else by name. */
export function pickFailover(candidates: readonly string[], answer: string): string | undefined {
  const t = answer.trim();
  if (t === '') return undefined;
  const byIndex = candidates[Number(t) - 1];
  if (byIndex !== undefined) return byIndex;
  return candidates.includes(t) ? t : undefined;
}

/**
 * §4septies vision offer: only the models the runtime SAYS can read images are
 * candidates, and only if one of them is not already the main model (routing a
 * request to the model that would serve it anyway changes nothing).
 */
export function visionCandidates(models: readonly LocalModelInfo[], mainModel: string): string[] {
  return models.filter((m) => m.supportsVision === true && m.id !== mainModel).map((m) => m.id);
}

async function offerVisionRoute(models: readonly LocalModelInfo[], mainModel: string): Promise<string | undefined> {
  const candidates = visionCandidates(models, mainModel);
  if (candidates.length === 0) return undefined;
  console.log('\nVision route (optional): send the requests that carry images to a model');
  console.log(`that declares it can read them, instead of to "${mainModel}".`);
  candidates.forEach((n, i) => console.log(`  ${String(i + 1)}. ${n}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question('Model for images [enter = no route]: ');
  rl.close();
  const chosen = pickFailover(candidates, ans);
  if (chosen === undefined && ans.trim() !== '') console.log('invalid choice: no vision route set');
  return chosen;
}

/** Yes only on an explicit yes: the §4septies default is always "no". */
export function isYes(answer: string): boolean {
  return /^(s|si|sì|y|yes)$/i.test(answer.trim());
}

async function offerLongContext(big: string, small: string): Promise<boolean> {
  console.log('\nLong-context route (optional): when a request approaches the real window');
  console.log(`of the model that would serve it (80%, from the discovery), send it to "${big}" instead of "${small}".`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await rl.question('Enable it? [y/N]: ');
  rl.close();
  return isYes(ans);
}

function printNextSteps(profileId: string, started: number): void {
  console.log('\nNext steps:');
  console.log(`  lupin run -- claude      a Claude Code session on ${profileId}`);
  console.log('  lupin use <profile>      hot switch between profiles');
  console.log('\nOptional: the routing truth in the Claude Code statusline');
  console.log('(which model REALLY serves the session): see examples/ in the repo,');
  console.log('instructions in README §Statusline. Lupin never touches settings.json.');
  console.log(`\n(${String(Math.round((Date.now() - started) / 1000))}s)`);
}

/**
 * Local-provider flow (SPEC-PROVIDERS §3ter): no key, the live GET /models of
 * the local server doubles as connectivity test and slot picker.
 */
async function initLocal(d: DefaultProfileDef, started: number): Promise<number> {
  const def = PROVIDERS[d.provider];
  if (def === undefined) {
    console.error(`provider "${d.provider}" is not in the registry: defaults bug`);
    return 1;
  }
  // Model discovery always goes through the OpenAI-compat /v1/models surface,
  // even for passthrough locals (Anthropic-native servers keep it on the same port).
  const modelsUrl = `${def.translateBaseUrl ?? def.baseUrl}/models`;
  console.log(`... querying ${modelsUrl}`);
  let ids: string[];
  try {
    const res = await fetch(modelsUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    ids = (body.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === 'string' && !x.toLowerCase().includes('embed'));
  } catch {
    console.error(`✗ local server unreachable at ${modelsUrl}`);
    console.error(`  start it with:  ${d.startHint ?? '(see the provider documentation)'}  then run lupin init again`);
    return 1;
  }
  if (ids.length === 0) {
    console.error('the local server answers but has no models installed (embeddings excluded)');
    return 1;
  }

  // The native metadata API answers, before a single token is spent, the
  // question every competitor leaves to trial and error (SPEC-PROVIDERS §3ter).
  const probed = mergeProbe(ids, await probeLocalModels(def));
  const usable = probed.filter((m) => m.chat);
  const noTools = usable.filter((m) => m.supportsTools === false);
  // Same floor the doctor enforces: a window too small to hold the harness
  // makes every request fail before the model is even asked (verified live
  // 2026-07-19). Better said here than discovered mid-session.
  const tooSmall = usable.filter((m) => !preflightContext(m.contextWindow).ok);
  console.log('\nModels on the local server:');
  usable.forEach((m, i) => {
    // "max" means the model is not loaded yet: the served window can be far
    // smaller, and the long-context route derives its threshold from this.
    const suffix = m.contextWindowSource === 'max' ? ' max' : '';
    const ctx = m.contextWindow === undefined ? '' : `  ctx ${String(Math.round(m.contextWindow / 1024))}k${suffix}`;
    const tools = m.supportsTools === false ? '  ⚠ no tools' : '';
    const small = preflightContext(m.contextWindow).ok ? '' : '  ⚠ context too small';
    console.log(`  ${String(i + 1)}. ${m.id.padEnd(28)}${ctx}${tools}${small}`);
  });
  if (noTools.length > 0) {
    console.log('\n⚠ Models marked "no tools" do not declare tool support, and Claude Code');
    console.log('  cannot take a single step with them. Pick one without that mark.');
  }
  if (tooSmall.length > 0) {
    console.log(`\n⚠ "context too small" = a window under ${String(DOCTOR_MIN_CONTEXT)} tokens. The Claude Code`);
    console.log('  harness sent 46075 of them in a real test, so every request would fail');
    console.log('  before reaching the model. Raise the window in the runtime, then run init again.');
  }
  const ids2 = usable.map((m) => m.id);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const bigRaw = await rl.question(`\nMain model (opus and sonnet slots) [1-${String(ids2.length)}]: `);
  const smallRaw = await rl.question(`Light model (haiku slot) [1-${String(ids2.length)}, enter = the same one]: `);
  rl.close();
  const big = ids2[Number(bigRaw.trim()) - 1];
  if (big === undefined) {
    console.error('invalid choice');
    return 1;
  }
  const small = smallRaw.trim() === '' ? big : ids2[Number(smallRaw.trim()) - 1];
  if (small === undefined) {
    console.error('invalid choice');
    return 1;
  }

  // Real windows from the runtime: the longContext route derives its threshold
  // from these, so a local profile gets dynamic routing without a magic number.
  // Only what persistableWindow trusts gets written: an advertised 'max' is not
  // the served window (audit 2026-07-22, local-window-knowledge-poisoned).
  const windows: Record<string, number> = {};
  for (const m of usable) {
    if (m.id !== big && m.id !== small) continue;
    const w = persistableWindow(m, DOCTOR_MIN_CONTEXT);
    if (w !== undefined) windows[m.id] = w;
  }
  const existing = existsSync(defaultConfigPath()) ? loadConfig() : undefined;
  const config = mergeProfile(d, existing, { opus: big, sonnet: big, haiku: small });
  const profile = config.profiles[d.id];
  if (profile !== undefined && Object.keys(windows).length > 0) profile.contextWindows = windows;
  // §4septies: routing is never auto-activated, but init can OFFER what the
  // discovery/registry already knows, and the user decides (default "no").
  // Audit 2026-07-22 (`routes-unconfigurable-from-cli`): this used to ANNOUNCE
  // an active long-context threshold while writing no route at all, so the
  // announced routing could never fire. Now it is a question, and the answer
  // is what gets written.
  const routes: RoutesConfig = {};
  const visionTarget = await offerVisionRoute(usable, big);
  if (visionTarget !== undefined) routes.vision = { target: visionTarget };
  if (Object.keys(windows).length > 0 && small !== big && (await offerLongContext(big, small))) {
    routes.longContext = { target: big };
  }
  if (profile !== undefined && Object.keys(routes).length > 0) profile.routes = routes;
  const failoverPick = await offerFailover(existing, d.id);
  if (failoverPick !== undefined && profile !== undefined) profile.failover = failoverPick;
  saveConfig(config);
  console.log(`\n✓ profile "${d.id}" is active (${big}${small !== big ? ` + ${small}` : ''}), config: ${defaultConfigPath()}`);
  if (d.mode === 'translate') {
    console.log('Honest note: this provider goes through translate, for now without dialect');
    console.log('normalization (§5bis): expect friction on agentic tasks, lupin doctor measures it.');
  } else {
    console.log('Honest note: the local server native Anthropic API avoids translation,');
    console.log('but the Claude Code harness stays demanding: lupin doctor measures whether the model holds.');
  }
  await offerRecommendedSkills();
  printNextSteps(d.id, started);
  return 0;
}

/** Pure merge, exported for tests: adds/replaces the profile and activates it. */
export function mergeProfile(
  d: DefaultProfileDef,
  existing?: LupinConfig,
  slotsOverride?: Record<SlotName, string>,
  economy = false,
): LupinConfig {
  const preset = economy ? d.economy : undefined;
  const slots = slotsOverride ?? preset?.slots ?? d.slots;
  if (slots === undefined) {
    throw new Error(`profile "${d.id}": no slots (local profiles pick them at init, SPEC-PROVIDERS §3ter)`);
  }
  if (d.auth !== 'none' && d.apiKeyEnv === undefined) {
    throw new Error(`profile "${d.id}": auth "${d.auth}" requires apiKeyEnv in the defaults`);
  }
  const profile: ProfileConfig = {
    provider: d.provider,
    mode: d.mode,
    auth: d.auth === 'none' ? { type: 'none' } : { type: d.auth, apiKeyRef: d.apiKeyEnv ?? '' },
    slots: { ...slots },
    ...(d.contextWindows !== undefined ? { contextWindows: { ...d.contextWindows } } : {}),
    ...(preset !== undefined ? { routes: structuredClone(preset.routes) } : {}),
    ...(d.quirks !== undefined ? { quirks: [...d.quirks] } : {}),
  };
  const config: LupinConfig = existing ?? {
    activeProfile: d.id,
    port: 3456,
    localToken: randomBytes(24).toString('hex'),
    profiles: {},
  };
  config.profiles[d.id] = profile;
  config.activeProfile = d.id;
  return config;
}

/** Verifies and persists one hosted default without the interactive init choices. */
export async function persistKeyProfile(
  d: DefaultProfileDef,
  key: string,
  bootstrapIdentity?: BootstrapIdentity,
  testKey: typeof testProviderKey = testProviderKey,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const test = await testKey(d, key);
  if (!test.ok) return { ok: false, error: test.detail };
  if (d.apiKeyEnv === undefined) return { ok: false, error: `profile "${d.id}" has no API-key credential` };

  setCredential(d.apiKeyEnv, key);
  const existing = existsSync(defaultConfigPath())
    ? loadConfig()
    : bootstrapIdentity === undefined
      ? undefined
      : { activeProfile: '', port: bootstrapIdentity.port, localToken: bootstrapIdentity.localToken, profiles: {} };
  saveConfig(mergeProfile(d, existing));
  return { ok: true };
}

/** Raw-mode read: the key never echoes to the terminal (SPEC-CLI §1.2). */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf.trim());
          return;
        }
        if (ch === '\u0003') {
          // Ctrl+C
          stdin.setRawMode?.(false);
          process.stdout.write('\n');
          process.exit(1);
        }
        if (ch === '\b' || ch === '\u007f') buf = [...buf].slice(0, -1).join(''); // code POINTS: never cut a surrogate pair
        else buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}
