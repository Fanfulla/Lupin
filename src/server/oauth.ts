// OAuth HTTP client (DESIGN-OAUTH §4): Device Authorization Grant (RFC 8628)
// + refresh, pure fetch wrappers over the descriptor data. No new routes in the
// server: the device flow needs no callback.

import {
  deleteOAuthTokens,
  getDeviceId,
  getOAuthTokens,
  movedToKeychainAt,
  oauthNeedsRefresh,
  setOAuthTokens,
  type OAuthTokens,
} from '../config/credentials.js';
import { keychainLabel } from '../config/keychain.js';
import type { DeviceOAuthProviderDef, OAuthProviderDef } from '../providers/oauth.js';
import { splitAccountKey, tokenUrl } from '../providers/oauth.js';
import { CLIENT_NAME, CLIENT_VERSION } from '../providers/identity.js';
import { arch, hostname, platform, release } from 'node:os';

// Device identity headers (DESIGN-OAUTH §4.1/§6): the provider console lists
// authorized devices and derives the human name from these. Without them the
// device shows as "unknown". Sent on the OAuth calls only: the chat endpoint
// keys off the Bearer, not these. Honest attribution, never the official CLIs'.

/** ASCII-only header values: a stray `#`/accent in an OS string has broken requests upstream. */
function ascii(v: string): string {
  return v.replace(/[^\x20-\x7e]/g, '').trim();
}

function deviceHeaders(): Record<string, string> {
  return {
    'X-Msh-Platform': 'lupin',
    'X-Msh-Version': CLIENT_VERSION,
    'X-Msh-Device-Name': `${CLIENT_NAME}@${hostname()}`,
    'X-Msh-Device-Model': ascii(`${platform()} ${arch()}`),
    'X-Msh-Os-Version': ascii(release()),
    'X-Msh-Device-Id': getDeviceId(),
  };
}

export class OAuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
  intervalSec: number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

/**
 * form-urlencoded POST with tolerant error mapping (shared by the device and
 * PKCE flows). The Kimi `X-Msh-*` device headers go ONLY on the Kimi device
 * flow (they identify the device to the Kimi console): sending them to Google
 * or OpenAI makes those token endpoints answer 400, so they are opt-in.
 */
export async function postOAuthForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  opts: { kimiDeviceHeaders?: boolean } = {},
): Promise<TokenResponse & Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // RFC 6749 says the answer is JSON, GitHub disagrees unless asked: its
        // OAuth endpoints default to form-urlencoded, which the parser below
        // rejects as `bad_response` (found by the first real Copilot login,
        // 2026-08-05). Harmless everywhere else, so it is sent unconditionally.
        accept: 'application/json',
        ...(opts.kimiDeviceHeaders === true ? deviceHeaders() : {}),
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? ` (${e.cause.message})` : '';
    throw new OAuthError('network', `${msg}${cause}: POST ${url}`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text) as TokenResponse & Record<string, unknown>;
  } catch {
    throw new OAuthError('bad_response', `non-JSON response (HTTP ${String(res.status)}): ${text.slice(0, 200)}`);
  }
}

export function tokensFromResponse(r: TokenResponse, now: number = Date.now()): OAuthTokens {
  if (r.access_token === undefined) {
    throw new OAuthError(r.error ?? 'invalid_response', r.error_description ?? 'token response without access_token');
  }
  const lifetimeMs = (r.expires_in ?? 3600) * 1000;
  return {
    accessToken: r.access_token,
    ...(r.refresh_token !== undefined ? { refreshToken: r.refresh_token } : {}),
    expiresAt: now + lifetimeMs,
    lifetimeMs,
    ...(r.scope !== undefined ? { scope: r.scope } : {}),
    tokenType: r.token_type ?? 'Bearer',
  };
}

export async function startDeviceAuthorization(
  def: DeviceOAuthProviderDef,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceAuthorization> {
  const r = await postOAuthForm(
    def.host + def.flow.deviceAuthorizationPath,
    { client_id: def.clientId },
    fetchImpl,
    { kimiDeviceHeaders: def.flow.deviceIdentityHeaders === true },
  );
  const deviceCode = r['device_code'];
  const userCode = r['user_code'];
  const verificationUri = r['verification_uri'];
  if (typeof deviceCode !== 'string' || typeof userCode !== 'string' || typeof verificationUri !== 'string') {
    throw new OAuthError('bad_response', `device_authorization response incomplete: ${JSON.stringify(r).slice(0, 200)}`);
  }
  const complete = r['verification_uri_complete'];
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === 'string' ? { verificationUriComplete: complete } : {}),
    expiresInSec: typeof r['expires_in'] === 'number' ? r['expires_in'] : 900,
    intervalSec: typeof r['interval'] === 'number' ? r['interval'] : def.flow.pollIntervalMs / 1000,
  };
}

export interface PollOptions {
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  onPending?: () => void;
}

/** Polls the token endpoint per RFC 8628 until granted, denied or expired. */
export async function pollDeviceToken(
  def: OAuthProviderDef,
  auth: DeviceAuthorization,
  opts: PollOptions = {},
): Promise<OAuthTokens> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  let intervalMs = auth.intervalSec * 1000;
  const deadline = Date.now() + auth.expiresInSec * 1000;

  for (;;) {
    await sleep(intervalMs);
    if (Date.now() > deadline) throw new OAuthError('expired_token', 'device code expired: restart lupin login');
    let r;
    try {
      r = await postOAuthForm(
        tokenUrl(def),
        {
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          client_id: def.clientId,
          device_code: auth.deviceCode,
        },
        fetchImpl,
        { kimiDeviceHeaders: def.flow.kind === 'device' && def.flow.deviceIdentityHeaders === true },
      );
    } catch (e) {
      // transient blip (network error or gateway garbage) must not kill the login
      // while the user is authorizing in the browser: keep polling to the deadline
      if (e instanceof OAuthError && (e.code === 'network' || e.code === 'bad_response')) {
        opts.onPending?.();
        continue;
      }
      throw e;
    }
    if (r.access_token !== undefined) return tokensFromResponse(r);
    switch (r.error) {
      case 'authorization_pending':
        opts.onPending?.();
        continue;
      case 'slow_down':
        intervalMs += 5000; // RFC 8628 §3.5
        continue;
      case 'expired_token':
        throw new OAuthError('expired_token', 'device code expired: restart lupin login');
      case 'access_denied':
        throw new OAuthError('access_denied', 'login denied by the user');
      default:
        throw new OAuthError(r.error ?? 'unknown', r.error_description ?? 'unexpected token endpoint error');
    }
  }
}

export async function refreshOAuthTokens(
  def: OAuthProviderDef,
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  if (tokens.refreshToken === undefined) {
    throw new OAuthError('invalid_grant', 'no refresh token stored');
  }
  // Google demands the public client_secret on refresh too; bare public
  // clients (OpenAI, Kimi) have none and omit it.
  const form: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: def.clientId,
    refresh_token: tokens.refreshToken,
  };
  if (def.clientSecret !== undefined) form['client_secret'] = def.clientSecret;
  // The X-Msh-* device headers belong to the descriptor that asks for them
  // (ADR-28): the refresh is shared with the PKCE providers, which reject them
  // with 400, and with the other device providers, which never wanted them.
  const r = await postOAuthForm(tokenUrl(def), form, fetchImpl, {
    kimiDeviceHeaders: def.flow.kind === 'device' && def.flow.deviceIdentityHeaders === true,
  });
  if (r.access_token === undefined) {
    throw new OAuthError(r.error ?? 'invalid_grant', r.error_description ?? 'refresh rejected');
  }
  const next = tokensFromResponse(r);
  // the server MAY rotate the refresh token: always keep the newest, else keep the old one
  if (next.refreshToken === undefined && tokens.refreshToken !== undefined) next.refreshToken = tokens.refreshToken;
  return next;
}

// Single-flight per provider (DESIGN-OAUTH §4.3): one refresh even under
// concurrent requests. Cross-process file lock is deferred to v2.
const inflight = new Map<string, Promise<OAuthTokens>>();

export interface ResolveOAuthOptions {
  fetchImpl?: typeof fetch;
  /** Skip the expiry check and refresh now (reactive 401 path). */
  force?: boolean;
  /**
   * Credential-store key, `<provider>#<account>` when the profile names a
   * second account (§4nonies). Defaults to the descriptor id, which is what
   * every single-account profile has always used.
   */
  storeKey?: string;
}

/**
 * Store → proactive refresh (half-life rule) → rotated tokens saved atomically.
 * invalid_grant tombstones the record: the caller gets a clear "login again".
 */
export async function resolveOAuthAccessToken(def: OAuthProviderDef, opts: ResolveOAuthOptions = {}): Promise<string> {
  // Every store touch and the single-flight lock key off the STORE key, not the
  // descriptor id: two accounts of one provider refresh independently (§4nonies).
  const key = opts.storeKey ?? def.id;
  const { account } = splitAccountKey(key);
  const relogin = `lupin login ${def.aliases[0] ?? def.id}${account === undefined ? '' : ` --account ${account}`}`;
  const stored = getOAuthTokens(key);
  if (stored === undefined) {
    // ADR-43: a marker means the credential is intact in the OS keychain and
    // THIS install is the one that cannot read it. Advising a re-login there
    // would be wrong twice: pointless work, and a lie about what happened.
    const movedAt = movedToKeychainAt(`oauth/${key}`);
    if (movedAt !== undefined) {
      throw new OAuthError(
        'not_logged_in',
        `credentials for "${key}" live in the OS keychain (${keychainLabel()}, moved ${movedAt.slice(0, 10)}) and this install cannot read them: install the optional module (npm i @napi-rs/keyring) here, or run: ${relogin}`,
      );
    }
    throw new OAuthError('not_logged_in', `no OAuth credentials for "${key}": run: ${relogin}`);
  }
  // A token with no expiry and no refresh token (GitHub): refreshing it would
  // fail and tombstone a credential that is still perfectly good.
  if (def.nonExpiringToken === true) return stored.accessToken;
  if (opts.force !== true && !oauthNeedsRefresh(stored)) return stored.accessToken;

  let flight = inflight.get(key);
  if (flight === undefined) {
    flight = refreshOAuthTokens(def, stored, opts.fetchImpl ?? fetch)
      .then((next) => {
        setOAuthTokens(key, next);
        return next;
      })
      .catch((e: unknown) => {
        if (e instanceof OAuthError && (e.code === 'invalid_grant' || e.code === 'expired_token')) {
          deleteOAuthTokens(key); // tombstone: never reuse rejected refresh tokens
          throw new OAuthError(e.code, `OAuth token for "${key}" expired or revoked: run: ${relogin}`);
        }
        throw e;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, flight);
  }
  return (await flight).accessToken;
}
