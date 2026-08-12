// Unified credential resolver (DESIGN-OAUTH §4.3): profile → outgoing auth
// header. The translation core never sees where the token comes from (ADR-17).

import { resolveApiKey, type ProfileConfig } from '../config/config.js';
import { movedToKeychainAt } from '../config/credentials.js';
import { keychainLabel } from '../config/keychain.js';
import { OAUTH_PROVIDERS, splitAccountKey, type OAuthProviderDef } from '../providers/oauth.js';
import { resolveOAuthAccessToken } from './oauth.js';
import { clearCopilotTokenCache, resolveCopilotToken } from './copilot-token.js';

export interface ResolvedCredential {
  header: 'authorization' | 'x-api-key';
  value: string;
  /**
   * Base URL this credential is bound to, when the provider names it at
   * exchange time (§3quater). It wins over the registry default, and never
   * over an explicit `baseUrl` on the profile: the user's override stays king.
   */
  baseUrl?: string;
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialError';
  }
}

export interface ResolveCredentialOptions {
  fetchImpl?: typeof fetch;
  /** Force an OAuth refresh (reactive 401 path). */
  forceOAuthRefresh?: boolean;
  /** Test seam: overrides the OAuth descriptor registry. */
  oauthDefs?: Record<string, OAuthProviderDef>;
  /** Test seam: the token resolver itself (the real one touches the store). */
  resolveToken?: typeof resolveOAuthAccessToken;
}

/**
 * The descriptor behind a profile's OAuth key. The key may carry an account
 * suffix (`kimicode#work`, §4nonies): the account picks the stored token, the
 * PROVIDER half picks the descriptor, so both accounts share one flow.
 */
export function oauthDefForProfile(
  profile: ProfileConfig,
  defs: Record<string, OAuthProviderDef> = OAUTH_PROVIDERS,
): OAuthProviderDef | undefined {
  if (profile.auth.type !== 'oauth') return undefined;
  const { provider: name } = splitAccountKey(profile.auth.provider ?? profile.provider);
  return defs[name] ?? Object.values(defs).find((d) => d.aliases.includes(name));
}

export async function resolveCredential(
  profile: ProfileConfig,
  opts: ResolveCredentialOptions = {},
): Promise<ResolvedCredential> {
  const auth = profile.auth;
  if (auth.type === 'none') {
    // local providers (SPEC-PROVIDERS §3ter): some OpenAI-compat servers
    // reject requests without ANY bearer, so a constant one goes out
    return { header: 'authorization', value: 'Bearer lupin-local' };
  }
  if (auth.type === 'oauth') {
    const def = oauthDefForProfile(profile, opts.oauthDefs);
    if (def === undefined) {
      throw new CredentialError(`no OAuth support for provider "${auth.provider ?? profile.provider}"`);
    }
    // The WHOLE key (account suffix included) selects the token; the descriptor
    // is the provider's. Absent for a single-account profile, so the store key
    // stays `oauth/<provider>` and no existing login has to migrate.
    const storeKey = auth.provider ?? profile.provider;
    const resolveToken = opts.resolveToken ?? resolveOAuthAccessToken;
    const accessToken = await resolveToken(def, {
      ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.forceOAuthRefresh === true ? { force: true } : {}),
      storeKey,
    }).catch((e: unknown) => {
      throw new CredentialError(e instanceof Error ? e.message : String(e));
    });
    // §3quater: for a provider whose OAuth token does not pay for inference,
    // the Bearer is the SHORT-LIVED token bought with it, and the same answer
    // names the API host this account is served from.
    if (def.tokenExchange !== undefined) {
      // The reactive-401 path (DESIGN-OAUTH §4.3) means "the credential we sent
      // was refused". For an exchanged provider the refused credential is the
      // BOUGHT token, not the OAuth one, and for a non-expiring OAuth token the
      // forced refresh above is a no-op: without dropping the bought one the
      // retry would send the very same rejected Bearer.
      if (opts.forceOAuthRefresh === true) clearCopilotTokenCache(storeKey);
      const bought = await resolveCopilotToken({
        storeKey,
        url: def.tokenExchange,
        githubToken: accessToken,
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      }).catch((e: unknown) => {
        throw new CredentialError(e instanceof Error ? e.message : String(e));
      });
      return { header: 'authorization', value: `Bearer ${bought.token}`, baseUrl: bought.apiBaseUrl };
    }
    return { header: 'authorization', value: `Bearer ${accessToken}` };
  }

  const apiKey = resolveApiKey(auth);
  if (apiKey === undefined || apiKey === '') {
    // ADR-43: a marker means the key is intact in the OS keychain and this
    // install is the one that cannot read it: say that, not "not found".
    const movedAt = movedToKeychainAt(auth.apiKeyRef);
    if (movedAt !== undefined) {
      throw new CredentialError(
        `API key "${auth.apiKeyRef}" lives in the OS keychain (${keychainLabel()}, moved ${movedAt.slice(0, 10)}) and this install cannot read it: install the optional module (npm i @napi-rs/keyring) here, or add the provider again from the hub (run: lupin)`,
      );
    }
    throw new CredentialError(`API key "${auth.apiKeyRef}" not found (env var or credential store): add the provider from the hub (run: lupin)`);
  }
  return auth.type === 'x-api-key'
    ? { header: 'x-api-key', value: apiKey }
    : { header: 'authorization', value: `Bearer ${apiKey}` };
}
