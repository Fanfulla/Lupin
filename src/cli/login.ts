// `lupin login <provider>` / `lupin logout <provider>` (DESIGN-OAUTH §4.2):
// import from official CLI credentials when present, else RFC 8628 device flow.
// No server route involved; verification happens BEFORE anything is saved.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { defaultConfigPath, loadConfig, saveConfig, type LupinConfig, type ProfileConfig, type SlotName } from '../config/config.js';
import { credentialStoreLabel, deleteOAuthTokens, setOAuthTokens, type OAuthTokens } from '../config/credentials.js';
import { DEFAULT_PROFILES } from '../providers/defaults.js';
import { PROVIDERS, type ProviderDef } from '../providers/registry.js';
import { resolveCopilotToken } from '../server/copilot-token.js';
import { freeTierNotice } from '../providers/tiers.js';
import {
  accountKey,
  asDeviceFlow,
  findOAuthProvider,
  isValidAccountLabel,
  OAUTH_PROVIDERS,
  type OAuthProviderDef,
} from '../providers/oauth.js';
import { pollDeviceToken, startDeviceAuthorization } from '../server/oauth.js';
import { runPkceLogin } from '../server/oauth-pkce.js';
import { openBrowser } from './browser.js';

export type BootstrapIdentity = Pick<LupinConfig, 'port' | 'localToken'>;

/** The OAuth-capable providers, read from the registry: never a hardcoded name. */
function oauthProviderList(): string {
  return Object.values(OAUTH_PROVIDERS)
    .map((d) => d.aliases[0] ?? d.id)
    .join(', ');
}

/**
 * `--account <label>`: which account of the provider this login is for
 * (§4nonies). Returns `null` when the flag is present but the label is not
 * usable, so the caller refuses rather than writing a broken store key.
 */
export function parseAccountFlag(args: string[]): string | undefined | null {
  const i = args.indexOf('--account');
  if (i < 0) return undefined;
  const label = args[i + 1];
  if (label === undefined || !isValidAccountLabel(label)) return null;
  return label;
}

export async function loginCommand(args: string[]): Promise<number> {
  const account = parseAccountFlag(args);
  if (account === null) {
    console.error('--account wants a label of letters, digits, dot, dash or underscore (max 32), for example: --account work');
    return 1;
  }
  // The positional provider name is the first bare word, and `--account work`
  // puts a bare word right after a flag: skip it.
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--account');
  const name = positional[0];
  const autoImport = args.includes('--import');
  if (name === undefined) {
    console.error(`usage: lupin login <provider> [--account <label>]\nProviders with an OAuth flow: ${oauthProviderList()}`);
    return 1;
  }
  const def = findOAuthProvider(name);
  if (def === undefined) {
    console.error(`no OAuth flow for "${name}". Supported: ${oauthProviderList()} (other providers use API keys: lupin init)`);
    return 1;
  }

  let tokens = importOfficialCredentials(def);
  if (tokens !== undefined) {
    let doImport = autoImport;
    if (!doImport) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Credentials of the official Kimi CLI found: import them? [Y/n] ');
      rl.close();
      doImport = answer.trim().toLowerCase() !== 'n';
    }
    if (!doImport) tokens = undefined;
  }

  if (tokens === undefined) {
    if (def.flow.kind === 'device') {
      const ddef = asDeviceFlow(def);
      let auth;
      try {
        auth = await startDeviceAuthorization(ddef);
      } catch (e) {
        console.error(`✗ device authorization failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
      const url = auth.verificationUriComplete ?? auth.verificationUri;
      console.log(`\nOpen in your browser:  ${url}`);
      console.log(`Verification code:    ${auth.userCode}\n`);
      openBrowser(url);
      process.stdout.write('Waiting for confirmation in the browser ');
      try {
        tokens = await pollDeviceToken(ddef, auth, { onPending: () => process.stdout.write('.') });
        process.stdout.write('\n');
      } catch (e) {
        process.stdout.write('\n');
        console.error(`✗ login failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    } else {
      // PKCE (DESIGN-OAUTH-PKCE-TUI §1.3): a provider that suspends accounts
      // for third-party OAuth blocks on explicit acceptance BEFORE the browser.
      if (def.suspensionWarning !== undefined && !args.includes('--i-accept-the-risk')) {
        console.error(`WARNING: ${def.suspensionWarning}`);
        console.error(`Re-run with --i-accept-the-risk to continue, or use an API key instead: lupin init`);
        return 1;
      }
      try {
        tokens = await runPkceLogin(def, { openBrowser, onUrl: (url) => console.log(`\nOpen in your browser:  ${url}\n`) });
      } catch (e) {
        console.error(`✗ login failed: ${e instanceof Error ? e.message : String(e)}`);
        return 1;
      }
    }
  }

  // verify BEFORE saving (DESIGN-OAUTH §4.2 punto 3)
  const verdict = await verifyToken(def, tokens);
  if (!verdict.ok) {
    console.error(`✗ the token does not work against ${def.verifyUrl}: ${verdict.detail}`);
    return 1;
  }
  const storeKey = accountKey(def.id, account);
  setOAuthTokens(storeKey, tokens);
  console.log(`✓ login ${def.aliases[0] ?? def.id}${account === undefined ? '' : ` (account ${account})`} succeeded (${verdict.detail})`);
  console.log(`  (tokens stored in: ${credentialStoreLabel()})`);
  if (verdict.notice !== undefined) console.log(`\n${verdict.notice}`);

  ensureOAuthProfile(def, account, verdict.models);
  return 0;
}

export function logoutCommand(args: string[]): number {
  const account = parseAccountFlag(args);
  if (account === null) {
    console.error('--account wants a label of letters, digits, dot, dash or underscore (max 32)');
    return 1;
  }
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--account');
  const name = positional[0];
  if (name === undefined) {
    console.error(`usage: lupin logout <provider> [--account <label>]\nProviders with an OAuth flow: ${oauthProviderList()}`);
    return 1;
  }
  const def = findOAuthProvider(name);
  if (def === undefined) {
    console.error(`unknown OAuth provider "${name}". Supported: ${oauthProviderList()}`);
    return 1;
  }
  // Only the named account is forgotten: the other accounts of the same
  // provider keep their tokens, and so do their profiles (§4nonies).
  deleteOAuthTokens(accountKey(def.id, account));
  console.log(`✓ OAuth credentials "${accountKey(def.aliases[0] ?? def.id, account)}" removed`);
  return 0;
}

/** Reads the official CLI credential files (kimi-cli), tolerant on field names. */
export function importOfficialCredentials(def: OAuthProviderDef): OAuthTokens | undefined {
  for (const rel of def.importPaths) {
    const path = join(homedir(), rel);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      const access = raw['access_token'] ?? raw['accessToken'];
      if (typeof access !== 'string') continue;
      const refresh = raw['refresh_token'] ?? raw['refreshToken'];
      const expires = raw['expires_at'] ?? raw['expiresAt'];
      // heuristic: epoch seconds < 1e12 < epoch ms
      const expiresAt =
        typeof expires === 'number' ? (expires < 1e12 ? expires * 1000 : expires) : Date.now() + 300_000;
      return {
        accessToken: access,
        ...(typeof refresh === 'string' ? { refreshToken: refresh } : {}),
        expiresAt,
        tokenType: 'Bearer',
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * What the verification response says about the account, when it says anything
 * the user must know BEFORE their first session. Google Code Assist does: a
 * free tier serves only free models and collects prompts and code, and finding
 * either out later, mid-task, would be finding out too late. The wording of the
 * tier itself lives in providers/tiers so every surface says the same thing.
 */
function tierNotice(def: OAuthProviderDef, raw: string): string | undefined {
  let loaded: { currentTier?: { id?: string; upgradeSubscriptionUri?: string } | null };
  try {
    loaded = JSON.parse(raw) as typeof loaded;
  } catch {
    return undefined;
  }
  if (loaded.currentTier?.id !== 'free-tier') return undefined;
  const profile = DEFAULT_PROFILES.find((p) => p.id === def.defaultProfileId);
  return [
    freeTierNotice(profile?.provider ?? def.id, 'sonnet', loaded.currentTier.upgradeSubscriptionUri),
    '  Google also collects prompts, code and generated output on this tier, and its',
    '  notice says human reviewers may read them. Do not route confidential work here.',
  ].join('\n');
}

/**
 * Slots for a profile whose models can only come from the account (§3quater).
 * Every slot gets the first listed model: a working profile from the first
 * second, with the real catalogue printed next to it so the user can aim the
 * slots. Guessing which id is "the big one" from a name would be exactly the
 * invention rule 5 forbids.
 */
export function slotsFromDiscovery(models?: string[]): Record<SlotName, string> | undefined {
  const first = models?.[0];
  if (first === undefined || first === '') return undefined;
  return { opus: first, sonnet: first, haiku: first };
}

/**
 * The account's own catalogue, printed once at login, because it is the only
 * place it is ever visible: these names are not in the defaults (rule 5) and no
 * command lists them. Every slot starts on the first one, which live evidence
 * says is often not a model the plan can actually use, so the list and the
 * command to aim the slots are the difference between a working profile and a
 * silent 400 (SPEC-PROVIDERS §3quater.1).
 */
export function catalogueLines(profileName: string, models: string[] | undefined): string[] {
  if (models === undefined || models.length === 0) return [];
  const out = [`  models this account lists (${String(models.length)}), every slot starts on the first:`];
  for (let i = 0; i < models.length; i += 4) {
    out.push(`    ${models.slice(i, i + 4).join('  ')}`);
  }
  out.push(`  aim them with: lupin use ${profileName} --opus <model> --sonnet <model> --haiku <model>`);
  out.push('  being listed does not mean the plan can use it: if a request answers 400, try another.');
  return out;
}

function printDiscoveredCatalogue(profileName: string, models: string[] | undefined): void {
  for (const line of catalogueLines(profileName, models)) console.log(line);
}

/** The registry provider behind an OAuth descriptor, via its default profile. */
function registryProviderFor(def: OAuthProviderDef): ProviderDef | undefined {
  const defaults =
    def.defaultProfileId !== undefined
      ? DEFAULT_PROFILES.find((p) => p.id === def.defaultProfileId)
      : DEFAULT_PROFILES.find((p) => p.provider === def.id);
  return defaults === undefined ? undefined : PROVIDERS[defaults.provider];
}

/**
 * §3quater: for a provider whose OAuth token has to be exchanged, verifying
 * means proving the account can buy the second token AND that it is entitled to
 * models. The list that comes back is also what fills the profile's slots,
 * because none of its model names may be written into the defaults (rule 5).
 */
async function verifyThroughExchange(
  def: OAuthProviderDef,
  tokens: OAuthTokens,
): Promise<{ ok: boolean; detail: string; models?: string[] }> {
  let bought;
  try {
    bought = await resolveCopilotToken({
      storeKey: def.id,
      url: def.tokenExchange ?? '',
      githubToken: tokens.accessToken,
    });
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const url = `${bought.apiBaseUrl}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${bought.token}`,
        accept: 'application/json',
        ...(registryProviderFor(def)?.requiredHeaders ?? {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { ok: false, detail: `the exchange worked but GET /models answered ${String(res.status)}` };
    }
    // Shape confirmed live 2026-08-05 against a real account: OpenAI-style
    // `{data:[{id, capabilities:{type}}]}`, 51 rows on a free plan.
    const body = (await res.json()) as { data?: { id?: unknown; capabilities?: { type?: unknown } }[] };
    const models = (body.data ?? [])
      // An embedder can never serve a Claude Code turn, and the list contains
      // them. `supported_endpoints` is deliberately NOT used to filter further:
      // live, every model declaring `/chat/completions` answered 400 while the
      // five that worked declared nothing (SPEC-PROVIDERS §3quater.1).
      .filter((m) => m.capabilities?.type === undefined || m.capabilities.type === 'chat')
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id !== '');
    if (models.length === 0) return { ok: false, detail: 'the account lists no model: nothing to serve' };
    return { ok: true, detail: `token exchanged, ${String(models.length)} models listed`, models };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export async function verifyToken(
  def: OAuthProviderDef,
  tokens: OAuthTokens,
): Promise<{ ok: boolean; detail: string; notice?: string; models?: string[] }> {
  if (def.tokenExchange !== undefined) return await verifyThroughExchange(def, tokens);
  const method = def.verifyBody === undefined ? 'GET' : 'POST';
  try {
    const res = await fetch(def.verifyUrl, {
      method,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        ...(def.verifyBody === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(def.verifyBody === undefined ? {} : { body: JSON.stringify(def.verifyBody) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      return {
        ok: true,
        detail: `${method} ${new URL(def.verifyUrl).pathname} → 200`,
        ...(def.verifyBody === undefined ? {} : { notice: tierNotice(def, await res.text()) }),
      };
    }
    return { ok: false, detail: `HTTP ${String(res.status)}: ${(await res.text()).slice(0, 200)}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * True when these slots are still some default profile's, so the user has
 * never chosen them. Only then may a repair replace them: an explicit choice
 * of the user's is worth more than our idea of the right model.
 */
function slotsAreUntouchedDefaults(slots: ProfileConfig['slots']): boolean {
  return DEFAULT_PROFILES.some((d) => {
    if (d.slots === undefined) return false;
    return (['opus', 'sonnet', 'haiku'] as const).every((s) => d.slots?.[s] === slots[s]);
  });
}

/**
 * Creates the subscription profile if missing (DESIGN-OAUTH §3.4), REPAIRS it
 * when an older Lupin wrote the wrong provider or lane, and prints how to use
 * it.
 *
 * The repair exists because a profile is written once and then trusted
 * forever: `gemini-sub` was built from the pay-per-token `gemini` descriptor
 * before the codeassist lane existed, so it claims `mode: translate` and the
 * OAuth token does not spend there at all. This project has no config
 * migration, so login is the one moment where the mistake can be met.
 */
export function ensureOAuthProfile(
  def: OAuthProviderDef,
  account?: string,
  discoveredModels?: string[],
  bootstrapIdentity?: BootstrapIdentity,
): boolean {
  // The profile name is derived, not hardcoded: kimi-sub, openai-sub, gemini-sub.
  // A second account gets its own profile, `kimi-sub@work`, because a profile
  // is exactly "one credential plus its slots" (§4nonies): chaining them with
  // `failover` is what rotates accounts, and no new concept is needed.
  const base = `${def.aliases[0] ?? def.id}-sub`;
  const profileName = account === undefined ? base : `${base}@${account}`;
  let config: LupinConfig;
  if (existsSync(defaultConfigPath())) {
    config = loadConfig();
  } else {
    config =
      bootstrapIdentity === undefined
        ? { activeProfile: profileName, port: 3456, localToken: cryptoToken(), profiles: {} }
        : { activeProfile: '', port: bootstrapIdentity.port, localToken: bootstrapIdentity.localToken, profiles: {} };
  }
  // A subscription can use a different provider and lane than the
  // pay-per-token one (OpenAI: openaisub + responses), so the descriptor may
  // name its default profile explicitly; otherwise match on the provider id.
  const defaults =
    def.defaultProfileId !== undefined
      ? DEFAULT_PROFILES.find((p) => p.id === def.defaultProfileId)
      : DEFAULT_PROFILES.find((p) => p.provider === def.id);
  if (defaults === undefined) {
    console.error(`no hosted default profile for provider "${def.id}": add it to providers/defaults.ts`);
    return false;
  }
  // A profile with no slots in the defaults is one whose model names may not be
  // written there (rule 5): they come from the account itself, discovered at
  // login. The first listed model fills every slot so the profile works at
  // once, and the list is printed so the user can aim the slots properly.
  const slots = defaults.slots ?? slotsFromDiscovery(discoveredModels);
  if (slots === undefined) {
    console.error(`no models could be read from the account, so profile "${profileName}" was not created`);
    return false;
  }
  const existing = config.profiles[profileName];
  if (existing === undefined) {
    config.profiles[profileName] = {
      provider: defaults.provider,
      mode: defaults.mode,
      // The credential store key stays the OAuth provider id (oauth/openai),
      // which is not the registry provider id (openaisub) for a subscription,
      // plus the account suffix when this profile is a second account.
      auth: { type: 'oauth', provider: accountKey(def.id, account) },
      slots: { ...slots }, // never invented here: defaults.ts (rule 5) or the account itself
    };
    if (!(config.activeProfile in config.profiles)) config.activeProfile = profileName;
    saveConfig(config);
    console.log(`✓ profile "${profileName}" created (subscription through OAuth)`);
    printDiscoveredCatalogue(profileName, defaults.slots === undefined ? discoveredModels : undefined);
  } else if (existing.provider !== defaults.provider || existing.mode !== defaults.mode) {
    const was = `${existing.provider}/${existing.mode}`;
    existing.provider = defaults.provider;
    existing.mode = defaults.mode;
    const stock = slotsAreUntouchedDefaults(existing.slots);
    if (stock) existing.slots = { ...slots };
    saveConfig(config);
    console.log(`✓ profile "${profileName}" repaired: ${was} → ${defaults.provider}/${defaults.mode}`);
    if (stock) {
      console.log('  (its models were the previous provider\'s defaults, so they moved with it)');
    } else {
      // Kept on purpose. Saying which ones is the difference between a warning
      // and a shrug: these are the names that will fail if they are wrong.
      const kept = (['opus', 'sonnet', 'haiku'] as const)
        .map((s) => `${s}=${typeof existing.slots[s] === 'string' ? String(existing.slots[s]) : 'delegated'}`)
        .join(', ');
      console.log(`  Your own models were kept and NOT checked against the new provider: ${kept}`);
      console.log(`  Change them with: lupin use ${profileName} --opus <model> (see lupin list)`);
    }
  }
  console.log(`\nNext step:  lupin use ${profileName}   then   lupin run -- claude`);
  console.log('Optional: a statusline with the routing truth, see examples/ and README §Statusline.');
  return true;
}

function cryptoToken(): string {
  return randomBytes(24).toString('hex');
}
