// OAuth provider descriptors (DESIGN-OAUTH §3.3, DESIGN-OAUTH-PKCE-TUI §1.2).
// Data only, like the rest of providers/. Kimi facts verified 2026-07-18
// against the official CLIs; OpenAI facts verified 2026-07-28 against
// opencode's openai-codex.ts and 7shi/codex-oauth (see DESIGN-OAUTH-PKCE-TUI
// §1.1). Gemini facts pending a live read of the gemini-cli distribution:
// the client_id is NEVER invented, it is captured from the official source.

export type OAuthFlow =
  | {
      /** RFC 8628 Device Authorization Grant (Kimi). No redirect, no callback. */
      kind: 'device';
      deviceAuthorizationPath: string;
      pollIntervalMs: number;
      /**
       * Send the Kimi `X-Msh-*` device identity headers on this provider's OAuth
       * calls, so its console can name the device (DESIGN-OAUTH §6). Opt-in per
       * descriptor: until Copilot arrived, "device flow" and "Kimi" were the same
       * thing and the call sites sent them to every device provider.
       */
      deviceIdentityHeaders?: true;
    }
  | {
      /** Authorization Code + PKCE with a loopback redirect (OpenAI, Google). */
      kind: 'pkce';
      authorizePath: string;
      /** Loopback port the provider's redirect_uri is registered for (0 = ephemeral). */
      redirectPort: number;
      redirectPath: string;
      scope: string;
      /**
       * The host the provider's redirect_uri is registered for. Google's
       * installed-app client wants the literal `127.0.0.1` (gemini-cli); a
       * `localhost` here makes its token endpoint answer 400. OpenAI registers
       * `localhost`. Default `127.0.0.1`.
       */
      redirectHost?: string;
    };

export interface OAuthProviderDef {
  id: string;
  /** Short names accepted by the login surfaces (control API body, catalogue rows). */
  aliases: string[];
  host: string;
  clientId: string;
  /**
   * Public client secret for installed-app loopback flows (Google). Google's
   * token endpoint demands it even with PKCE; it is not confidential (it ships
   * in the official CLI). Absent for providers that use a bare public client
   * (OpenAI) or the device grant (Kimi).
   */
  clientSecret?: string;
  flow: OAuthFlow;
  /**
   * Host for the token endpoint when it differs from `host` (the authorize
   * host). Google authorizes on accounts.google.com but exchanges on
   * oauth2.googleapis.com; posting the exchange to the authorize host returns
   * an HTML 400 (found live 2026-07-29). Default: `host`.
   */
  tokenHost?: string;
  /** Token endpoint path: exchange AND refresh (grant_type discriminates). */
  tokenPath: string;
  /** Probed with the fresh Bearer to verify the token end-to-end after login. */
  verifyUrl: string;
  /**
   * When set, the probe is a POST carrying this JSON body instead of a GET.
   * Google Code Assist exposes no list-models GET: its entry point is
   * `:loadCodeAssist`, a POST, and that is also where the project id comes from.
   */
  verifyBody?: Record<string, unknown>;
  /** Official CLI credential files to offer import from (first match wins). */
  importPaths: string[];
  /**
   * `DEFAULT_PROFILES` id the subscription profile is built from. Needed when
   * the subscription uses a different provider and lane than the pay-per-token
   * one (OpenAI: `openaisub` + responses, not `openai` + translate). Falls back
   * to matching on the provider id when absent (Kimi).
   */
  defaultProfileId?: string;
  /**
   * Set when the provider suspends accounts for third-party OAuth (Google).
   * The login UX blocks on an explicit acceptance before opening the browser.
   */
  suspensionWarning?: string;
  /**
   * The OAuth token does not pay for inference: it must be exchanged for a
   * short-lived API token at this URL, which also names the API host for this
   * account (SPEC-PROVIDERS §3quater). One central implementation in
   * `server/copilot-token.ts`, flagged from here (CLAUDE.md rule 4).
   */
  tokenExchange?: string;
  /**
   * The access token has no expiry and the flow issues no refresh token, so a
   * refresh attempt would fail and tombstone a perfectly good credential.
   * GitHub OAuth apps are like this unless they opt into expiring tokens.
   */
  nonExpiringToken?: true;
}

export const OAUTH_PROVIDERS: Record<string, OAuthProviderDef> = {
  kimicode: {
    id: 'kimicode',
    aliases: ['kimi', 'kimi-code', 'kimicode'],
    host: 'https://auth.kimi.com',
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098', // public client, identical in every implementation
    flow: {
      kind: 'device',
      deviceAuthorizationPath: '/api/oauth/device_authorization',
      pollIntervalMs: 5000,
      deviceIdentityHeaders: true,
    },
    tokenPath: '/api/oauth/token',
    verifyUrl: 'https://api.kimi.com/coding/v1/models',
    importPaths: ['.kimi/credentials/kimi-code.json'],
  },
  openai: {
    id: 'openai',
    aliases: ['openai', 'chatgpt', 'codex', 'gpt'],
    host: 'https://auth.openai.com',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', // public Codex client (verified 2026-07-28)
    flow: {
      kind: 'pkce',
      authorizePath: '/oauth/authorize',
      redirectPort: 1455,
      redirectPath: '/auth/callback',
      redirectHost: 'localhost', // OpenAI registers localhost:1455 (verified 2026-07-28)
      scope: 'openid profile email offline_access',
    },
    tokenPath: '/oauth/token',
    // The Codex/ChatGPT token does NOT spend on the public api.openai.com
    // (403 api.model.read, found live 2026-07-29): it spends on the WHAM
    // backend. Verify against its /models (which wants a client_version query
    // param, codex-oauth). M6a builds the Responses-API lane that uses it.
    // client_version=1.0.0 is the one that actually lists the served models
    // (0.1.0/0.20.0/0.34.0/0.55.0 all answer 200 with an EMPTY list, so they
    // would verify a token while telling us nothing, verified 2026-07-29).
    verifyUrl: 'https://chatgpt.com/backend-api/wham/models?client_version=1.0.0',
    importPaths: ['.codex/auth.json'],
    defaultProfileId: 'openai-sub', // the responses lane, not the pay-per-token translate one
  },
  gemini: {
    id: 'gemini',
    aliases: ['gemini', 'google'],
    host: 'https://accounts.google.com',
    // Captured 2026-07-28 from the official gemini-cli source
    // (packages/core/src/code_assist/oauth2.ts): a public installed-app client.
    // Google's token endpoint demands the (public, non-confidential) secret
    // even with PKCE. The loopback uses an EPHEMERAL port (redirectPort 0) and
    // the /oauth2callback path, exactly like gemini-cli.
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: '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',
    flow: {
      kind: 'pkce',
      authorizePath: '/o/oauth2/v2/auth',
      redirectPort: 0, // ephemeral: the bound port is read back after listen()
      redirectPath: '/oauth2callback',
      scope:
        'https://www.googleapis.com/auth/cloud-platform ' +
        'https://www.googleapis.com/auth/userinfo.email ' +
        'https://www.googleapis.com/auth/userinfo.profile',
    },
    tokenHost: 'https://oauth2.googleapis.com',
    tokenPath: '/token',
    // The Google OAuth token does NOT spend on the public generativelanguage
    // endpoint: it spends on Code Assist (the M6b lane). Verifying against the
    // public one made every login fail after the browser step, so no token was
    // ever persisted. `:loadCodeAssist` is the real entry point and answers with
    // the account tier plus, when it exists, the cloudaicompanionProject id.
    // Field names and enum values captured 2026-07-29 from the official
    // gemini-cli source (packages/core/src/code_assist/{types,setup}.ts).
    verifyUrl: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
    verifyBody: {
      metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
    },
    importPaths: ['.gemini/oauth_creds.json'],
    defaultProfileId: 'gemini-sub', // the codeassist lane, not the pay-per-token translate one
    suspensionWarning:
      'Google SUSPENDS paying accounts for third-party OAuth (mass bans Feb-Mar 2026). ' +
      'The API-key path is the safe default. Continue only if you accept the risk.',
  },
  // GitHub Copilot (2026-08-02). NOT PKCE: every official client (the Copilot
  // CLI per GitHub's own docs, and the shared `@github/copilot-language-server`
  // every editor plugin vendors) uses the RFC 8628 device grant, so this rides
  // the same flow as the first OAuth provider Lupin implemented. The client id
  // is the public device-flow client read from that shipped bundle and
  // independently matched by the `copilot-api` project; the device-code
  // endpoint was observed answering live on 2026-08-02. The HMAC secrets that
  // sit next to it in the bundle are DELIBERATELY not used: they are gated to
  // internal build channels, and sending them would forge an authenticity
  // signature rather than reuse a public client (ADR-38).
  copilot: {
    id: 'copilot',
    aliases: ['copilot', 'github', 'githubcopilot'],
    host: 'https://github.com',
    clientId: 'Iv1.b507a08c87ecfe98',
    flow: {
      kind: 'device',
      deviceAuthorizationPath: '/login/device/code',
      pollIntervalMs: 5000,
    },
    tokenPath: '/login/oauth/access_token',
    nonExpiringToken: true,
    tokenExchange: 'https://api.github.com/copilot_internal/v2/token',
    // Verifying means proving the account can actually buy a Copilot token:
    // the exchange IS the probe, and the models list behind it is the proof.
    verifyUrl: 'https://api.github.com/copilot_internal/v2/token',
    importPaths: [],
    defaultProfileId: 'copilot-sub',
    suspensionWarning:
      'GitHub suspends Copilot access for traffic its abuse detection reads as an unsupported client, ' +
      'reported as permanent and tied to your main GitHub identity. No published term forbids third-party ' +
      'clients outright, and no takedown of such a proxy is on record, but the enforcement pattern is real. ' +
      'Using SEVERAL accounts to stretch the quota is the pattern most associated with those suspensions: ' +
      'do not chain Copilot accounts with the failover order. Continue only if you accept the risk.',
  },
};

export function findOAuthProvider(name: string): OAuthProviderDef | undefined {
  return Object.values(OAUTH_PROVIDERS).find(
    (d) => d.id === name || d.defaultProfileId === name || d.aliases.includes(name),
  );
}

// --- Multiple accounts on one provider (SPEC-PROVIDERS §4nonies, ADR-36) ----
// A second account is a second credential-store key, `<provider>#<account>`,
// and therefore a second profile. Nothing else changes: the descriptor, the
// flow and the refresh runtime are the provider's, not the account's.

/** Account labels allowed in a store key: no `#`, no `/`, no spaces, no surprises. */
const ACCOUNT_LABEL = /^[A-Za-z0-9._-]{1,32}$/;

export function isValidAccountLabel(label: string): boolean {
  return ACCOUNT_LABEL.test(label);
}

/** `kimicode` + `work` -> `kimicode#work`. No account keeps the bare provider key. */
export function accountKey(provider: string, account?: string): string {
  return account === undefined || account === '' ? provider : `${provider}#${account}`;
}

/** Inverse of accountKey: splits a store key into its provider and account halves. */
export function splitAccountKey(key: string): { provider: string; account?: string } {
  const i = key.indexOf('#');
  if (i < 0) return { provider: key };
  return { provider: key.slice(0, i), account: key.slice(i + 1) };
}

/** The token endpoint URL (exchange + refresh): tokenHost when set, else host. */
export function tokenUrl(def: OAuthProviderDef): string {
  return (def.tokenHost ?? def.host) + def.tokenPath;
}

/** A descriptor narrowed to the device flow (Kimi): the only caller of the RFC 8628 helpers. */
export type DeviceOAuthProviderDef = OAuthProviderDef & {
  flow: { kind: 'device'; deviceAuthorizationPath: string; pollIntervalMs: number };
};

/** Narrow a descriptor to the device flow, or throw (a pkce descriptor here is a programming error). */
export function asDeviceFlow(def: OAuthProviderDef): DeviceOAuthProviderDef {
  if (def.flow.kind !== 'device') {
    throw new Error(`provider "${def.id}" is not a device-flow OAuth provider`);
  }
  return def as DeviceOAuthProviderDef;
}
