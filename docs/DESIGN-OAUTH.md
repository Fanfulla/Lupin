# DESIGN: universal authentication and Kimi OAuth

> How Lupin becomes "universal" on the credential front too: any LLM through an **API key or a native OAuth login**, with **Kimi/Moonshot as the first OAuth provider**. A design document: at the time of writing not a line of code existed. External facts verified on 2026-07-18 (sources in §10); anything not verifiable is marked explicitly.

## 0. Context and scope

This document comes from two inputs: the complete codebase analysis (session 2026-07-18) and research into Kimi's real OAuth flow. The scope is deliberately **Kimi only** as the first concrete OAuth flow: the architecture is general, but every other provider (OpenAI, Google and so on) is a follow-up with its own verification.

Two initial assumptions **disproved** by the research, for an honest record:

1. ~~"Kimi OAuth = Authorization Code + PKCE with a localhost callback"~~: it is a **Device Authorization Grant (RFC 8628)**, so no redirect and no callback route in the server. The design comes out simpler.
2. ~~"opencode has a kimi-for-coding OAuth provider"~~: opencode uses API keys only (through models.dev). Kimi OAuth exists only in the code of the official CLIs (`kimi-cli` in Python, `kimi-code` in Node) and in third-party reimplementations (pi-kimi-coder).

## 1. Current state of authentication

- **Inbound** (Claude Code to Lupin): a static `localToken` compared against `x-api-key` or `Authorization: Bearer` (`src/server/ingress.ts:57`, `ingress.ts:135-140`). An independent axis: **it does not change**.
- **Outbound** (Lupin to the provider): `AuthConfig { type: 'bearer' | 'x-api-key', apiKeyRef }` (`src/config/config.ts:9-13`); `apiKeyRef` is the name of an env var, resolved by `resolveApiKey` (`config.ts:102-104`, **synchronous, env only**); the header choice is binary in `ingress.ts:95-102`.
- **Limits**: no keychain or credential store, no config saving, no OAuth, no notion of expiry or refresh. `validateProfile` is hardcoded to the two types (`config.ts:82-88`).

The extension seams coincide with what ROADMAP next-step 8 already prescribes (`docs/ROADMAP.md:46`): `AuthConfig.type`, `resolveApiKey`, `validateProfile`, and header emission in the ingress.

## 2. Target architecture: two orthogonal axes

It takes ADR-17 (`docs/DECISIONS.md:23`) and makes it concrete:

```
Protocol (translation core, M2)       Credential source (auth layer, M3+)
  passthrough                            api key through the env   <- today
  translate                        x     api key in the keychain   <- SPEC-CLI §4
                                         oauth (subscription)      <- this document
```

- The two axes are **decoupled**: the translation core does not know, and must never know, where the token came from. No change to `src/core/`.
- OAuth and subscriptions apply **only to non-Claude providers** (ADR-16/17/18): no bypassing the Anthropic subscription.
- The **API key stays the guaranteed floor**: it is the only path on which the doctor can hold the promise "I stand behind it". OAuth is opt-in per provider and admittedly more fragile (a semi-private API, provider policy, revocation risk), and for Kimi that goes double, see §4.4.

## 3. Proposed data model

### 3.1 `AuthConfig` becomes a discriminated union (backwards compatible)

```ts
// src/config/config.ts, evolving config.ts:9-13
export type AuthConfig =
  | { type: 'bearer' | 'x-api-key'; apiKeyRef: string }  // today, unchanged
  | { type: 'oauth'; provider?: string };                 // default: the profile's provider
```

Existing configs keep validating as they are. The `provider?` field in the oauth branch is only needed if one day there are several accounts for the same provider (multi-account, open question in §9).

### 3.2 Credential store

The file `~/.lupin/credentials.json` (600 permissions, atomic tmp plus rename writes, the same pattern as kimi-cli). It is the fallback SPEC-CLI §4 already plans (`docs/SPEC-CLI.md:51`); the OS keychain (optional keytar at the time) stays a future alternative backend behind the same interface.

```ts
interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;   // epoch ms, computed from expires_in at grant time
  scope?: string;
  tokenType: string;   // "Bearer"
}
// keys in the file: "oauth/<provider>"  (for example "oauth/moonshot")
```

### 3.3 OAuth provider descriptor (declarative)

Consistent with the rule "`providers/` is data, not logic" (`docs/ARCHITECTURE.md:30`):

```ts
// src/providers/oauth.ts (new), data only
interface OAuthProviderDef {
  id: string;                        // for example "moonshot"
  host: string;                      // https://auth.kimi.com
  clientId: string;
  deviceAuthorizationPath: string;   // /api/oauth/device_authorization
  tokenPath: string;                 // /api/oauth/token (polling plus refresh)
  headers?: Record<string, string>;  // for example X-Msh-Platform (see §4.1)
  pollIntervalMs: number;            // default 5000, overridden by the response
  verificationTimeoutMs: number;
}
```

### 3.4 Profile example

```json
"kimi-sub": {
  "provider": "moonshot",
  "mode": "passthrough",
  "baseUrl": "https://api.kimi.com/coding",
  "auth": { "type": "oauth" },
  "slots": { "opus": "k3", "sonnet": "k3", "haiku": "k3" },
  "quirks": []
}
```

No token in the config: only the kind of source. The existing security invariants (keys never in the file) extend to OAuth tokens.

## 4. The Kimi OAuth flow end to end

### 4.1 Verified facts (sources in §10)

**Device Authorization Grant (RFC 8628)**, a public client, no secret:

- OAuth host: `https://auth.kimi.com`; `client_id`: `17e5f671-d194-4dfb-9706-5516cb48c098` (identical in every implementation).
- `POST /api/oauth/device_authorization` (form-urlencoded body: `client_id` only) returns `{ user_code, device_code, verification_uri, verification_uri_complete, expires_in, interval }`.
- `POST /api/oauth/token` for polling: `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `client_id`, `device_code`. Expected errors: `authorization_pending` / `slow_down` (keep going), `expired_token` (restart), `access_denied` (denied).
- `POST /api/oauth/token` for refresh: `grant_type=refresh_token`, `client_id`, `refresh_token`. The same endpoint, no separate one; the server **can rotate** the refresh token (always save the new one).
- Token response: `{ access_token, refresh_token, expires_in, scope ("kimi-code"), token_type ("Bearer") }`. The access token format (JWT or opaque) was **not verified** at that point.
- The "device" headers `X-Msh-Platform`, `X-Msh-Version`, `X-Msh-Device-Name`, `X-Msh-Device-Model`, `X-Msh-Os-Version`, `X-Msh-Device-Id`: the official design doc (KLIP-14) calls them required, but pi-kimi-coder does not send them and works, so **whether they are mandatory is uncertain**. Lupin will send them anyway (with its own `device_id`, see §6).
- No scope is sent by the client (the scope arrives in the response); no PKCE, no redirect.

**The Coding API** (where the token is spent):

- Base `https://api.kimi.com/coding/`, with a **dual protocol**: Anthropic Messages (`/v1/messages`) and OpenAI (`/coding/v1/chat/completions`). Per ADR-5 we use **passthrough** on the Anthropic endpoint: zero translation risk.
- Endpoint details observed in the official CLI: it is served through the beta Messages API (`/v1/messages?beta=true`) and accepts only `adaptive` thinking. To be confirmed outside the official CLI (§9).
- Auxiliary endpoints with the same Bearer: `GET /models`, `GET /usages`.
- **User-Agent gating**: a UA not recognized as a "coding agent" gets a 403. The official documentation explicitly forbids faking the client identity, see §4.4, which is the delicate point.
- Distinct from the Moonshot Open Platform (`api.moonshot.ai`, pay-per-token): that one stays **API key only**, outside OAuth (a declared non-goal in KLIP-14).
- **The official alternative to OAuth**: the Kimi Code Console allows up to 5 API keys for third-party tools, and that is the guaranteeable path (see §4.4).

**Storage used by the official CLIs** (reusable):

- Python kimi-cli: `~/.kimi/credentials/kimi-code.json` (600, atomic writes). Node kimi-code: `~/.kimi-code/credentials/<name>.json`.
- Reuse by third-party tools is **verified**: pi-kimi-coder reads and rewrites the Python CLI's file, keeping a bidirectional sync.

### 4.2 Login sequence (`lupin login kimi`)

1. If credentials from the official CLIs exist (`~/.kimi/credentials/kimi-code.json`, then `~/.kimi-code/credentials/`), it offers to **import** them (read, normalize into `OAuthTokens`, save into the Lupin store). With `--import` it does so without asking.
2. Otherwise the **device flow**: POST `device_authorization`, print the `user_code` and `verification_uri_complete` (opening the browser best-effort), poll while honouring `interval` and `expires_in`, then save into the store.
3. **Immediate verification**: `GET https://api.kimi.com/coding/v1/models` with the token, analogous to the connectivity test of `lupin init` (SPEC-CLI §1). A failure means a clear error and nothing saved.
4. `lupin logout kimi` deletes the record from the store.

The flow needs **no new route in the server** (no callback): Lupin's HTTP surface stays unchanged.

### 4.3 Runtime use

- `resolveApiKey` (synchronous, `config.ts:102`) is replaced by an **asynchronous resolver** `resolveCredential(auth): Promise<{ header: string; value: string }>`:
  - the `bearer`/`x-api-key` branches keep today's behaviour (env), returned as `{header, value}`, so the emission in `ingress.ts:101-102` generalizes accordingly;
  - the `oauth` branch reads the store, and when `expiresAt` is near (the kimi-cli strategy: refresh when the remaining lifetime is under `max(300s, expires_in × 0.5)`) it POSTs a refresh, saves atomically and returns the access token.
- **Single-flight** in process on the refresh (one refresh request per provider even under concurrent requests); a cross-process file lock (the kimi-cli `.lock` pattern) is deferred to v2.
- **Reactive 401**: if the provider answers 401 with an OAuth token, exactly one refresh plus one retry of the request. This is not a "hidden retry" in the doctor's sense (ADR-6): it concerns auth, not model behaviour.
- `invalid_grant` or `expired_token` on refresh means a tombstone on the record and a 401 `authentication_error` towards Claude Code with an explicit message: *"the Kimi OAuth token expired or was revoked, run `lupin login kimi` again"*. Never silent loops.

### 4.4 The delicate point: User-Agent and Kimi policy

The Coding API answers 403 to unrecognized User-Agents, and the official documentation declares faking the client identity a violation that can lead to suspension. For Lupin, which acts as a proxy and therefore replaces Claude Code's UA with its own, the options are:

1. **An API key from the Kimi Code Console** (official, no UA games): the recommended, guaranteeable path. In the config it is an ordinary `bearer` profile towards `https://api.kimi.com/coding`, and it works **already today** with no new code.
2. **OAuth with an honest UA** `lupin-code/<version>`: a 403 risk, acceptable only if Kimi does not block it, or after contact or allowlisting.
3. **Forwarding Claude Code's UA**: technically trivial (forward the header), but a policy grey area, to be assessed, not to be done by default.

The decision was deferred to the implementation phase with a real account (§9). In any case the OAuth path **does not carry the doctor's promise** (ADR-17): the doctor verifies it, but the guarantee stays on the API key.

**Endpoint quirk**: if it is confirmed that `/coding/v1/messages` requires `?beta=true` and `adaptive` thinking, two things are needed: (a) support for appending a query in the forward (today it is a bare `baseUrl + path`, `ingress.ts:106`); (b) a new centralized quirk (for example `kimiCodingBeta`) to rewrite the thinking parameter. Both to be confirmed with real requests.

## 5. Impact map on the code

| File | Change |
|---|---|
| `src/config/config.ts` | `AuthConfig` becomes a union (§3.1); `validateProfile` extended to the `oauth` type (`config.ts:82-88`); `resolveApiKey` deprecated in favour of the resolver |
| `src/config/credentials.ts` | **New**: an atomic load/save store (600), get/set/delete of records, the expiry decision (with an injected clock for tests) |
| `src/providers/oauth.ts` | **New**: `OAuthProviderDef` plus the `moonshot` descriptor (data only, §3.3) |
| `src/server/oauth.ts` | **New**: the HTTP client for the device flow plus refresh (pure HTTP wrappers on native fetch, no new dependency) |
| `src/server/ingress.ts` | `await resolveCredential(...)` in place of `resolveApiKey` (`ingress.ts:90`); generalized header emission (`ingress.ts:95-102`); retry-once on 401 for oauth profiles; possibly the query append (§4.4) |
| `src/cli/` (M3) | `login <provider>` / `logout <provider>`: orchestration only (print the code, poll, import), with the logic staying in `server/oauth.ts` plus `config/credentials.ts` (the `docs/ARCHITECTURE.md:32` rule) |
| `test/helpers/fake-oauth.ts` | **New**: a fake OAuth server (device_authorization, token with pending/success, refresh, rotation, invalid_grant), the sibling of `fake-provider.ts` |

**What does NOT change**: the whole of `src/core/` (orthogonality, §2); `src/providers/resolve.ts` and the slot mapping; the local auth (`localToken`); the existing routes (no OAuth callback); `package.json` (fetch and fs are enough; keytar stays a future option).

## 6. Security and privacy

- A store with 600 permissions and a 700 `~/.lupin` directory; atomic tmp plus rename writes (like kimi-cli).
- Never tokens in the logs: `RequestLogLine` (`src/server/log.ts`) contains no bodies or headers by construction; when `LUPIN_DEBUG=1` arrives (SPEC-TRANSLATION §9), body dumps must redact `authorization`, `x-api-key` and the `X-Msh-*` headers.
- `device_id`: if the `X-Msh-*` headers are sent, Lupin generates its **own** stable UUID in `~/.lupin/device_id` (600). Never reuse the official CLIs' one: an honest identity (§4.4).
- A config with no secrets: the profile declares only `{ "type": "oauth" }`; the tokens live only in the store.
- An unchanged server surface: no callback route (device flow), always bound to 127.0.0.1 only.
- Revocation and expiry: logout deletes the record; a failed refresh means a tombstone plus a request to log in again (rejected refresh tokens are never reused).

## 7. Test strategy

- **Unit**: `validateProfile` with the `oauth` type (accepting and rejecting the right fields); the store (a round trip in a tmpdir, permissions, atomicity, a corrupted file); the expiry decision with an injected clock (refresh or not as the remaining lifetime varies).
- **Integration**: `fake-oauth.ts` plus the full server through `createApp`: an oauth profile produces an `Authorization: Bearer <token>` header towards the fake provider; a token near expiry triggers a proactive refresh before the call; a 401 from the provider triggers exactly one refresh plus retry; `invalid_grant` produces a 401 `authentication_error` with a `lupin login` message.
- **Manual E2E** (outside CI, as per `docs/TESTING.md` §3): a real `lupin login kimi`, then `GET /models`, then a Claude Code session on the profile. It needs a real account.
- No secrets in CI: the current pipeline (`.github/workflows/ci.yml`) has no notion of credentials and stays that way.

## 8. Suggested implementation sequence

Independent of the translate wiring (M2), which stays on its own track.

- **Phase A, the credential-source abstraction** (a pure refactor): the `AuthConfig` union plus `credentials.ts` plus the async resolver plus an updated ingress. Criterion: the 53 existing tests stay green with no changes to bearer/x-api-key profiles; new unit tests on the store.
- **Phase B, the Kimi device flow**: the descriptor plus `server/oauth.ts` plus `lupin login/logout kimi` with import from the official CLIs. Criterion: on a real account, an end-to-end login plus `GET /models` at 200 (manual e2e); integration against fake-oauth in CI.
- **Phase C, runtime hardening**: proactive refresh, single-flight, retry-once on 401, tombstone, redaction under `LUPIN_DEBUG`. Criterion: the dedicated integration tests green.
- **Phase D, documentation and verification**: ADR-19 in DECISIONS.md (the credential source plus Kimi OAuth: the choice, the reasons, the rejected alternatives), an OAuth row in SPEC-PROVIDERS (with a verification date), the login and logout commands in SPEC-CLI, and a README update. Then the doctor on the OAuth profile (with the score reported as "subscription path, not guaranteed").

## 9. Open questions: verdicts from the real e2e (2026-07-19)

A complete e2e on a real account: device flow, grant, `GET /models` 200, passthrough non-stream and SSE through the proxy, a forced refresh. One real gap was found and fixed: polling died on the first transient network error (`fetch failed`) while the user was authorizing in the browser. Now network and gateway blips retry until the device code deadline (RFC 8628).

1. ✅ **User-Agent: no gating observed on the Anthropic endpoint.** With undici's default UA (no custom UA): `GET /coding/v1/models` returned 200, `POST /coding/v1/messages` returned 200 (non-stream and SSE). No 403, no spoofing needed. The OpenAI endpoint `/coding/v1/chat/completions` stays untested (we do not need it: Anthropic passthrough).
2. ✅ **The `X-Msh-*` headers are NOT mandatory**: they were never sent, and the device flow and the Coding API work.
3. ✅ **No `?beta=true`, no `kimiCodingBeta` quirk**: a plain `/coding/v1/messages` accepts thinking as `enabled+budget_tokens`, `adaptive` and `disabled` (all 200). Note: **without** a thinking parameter the server turns it on by default (K3 emits the `thinking` block spontaneously, and with a low `max_tokens` it burns everything in thinking and returns `stop_reason: max_tokens` with no text). Claude Code always sends an explicit thinking config, so this is not a problem in real use.
4. ✅ **Access token: a JWT with a 900s (15 minute) lifetime**; scope `kimi-code`. **The refresh token is rotated on EVERY refresh** (verified with a forced refresh, around 1s): always saving the new one is mandatory, not defensive. The refresh token's lifetime is still unknown (it needs long observation).
5. ✅ The real `verification_uri`: `https://www.kimi.com/code/authorize_device` (with `verification_uri_complete` carrying `?user_code=XXXX-XXXX`).
6. The exact credentials file name of the Node CLI (`~/.kimi-code/credentials/`) is still open (the import from the Python CLI's `~/.kimi/credentials/kimi-code.json` is confirmed to exist in the field).
7. Multi-account (several Kimi accounts on the same profile): the `provider?` field in `AuthConfig` is the hook, but the UX has to be designed.
8. Live bidirectional sync with the official CLIs' files (pi-kimi-coder style) against a one-off import: v2, since it needs the cross-process lock.

## 10. Sources (verified 2026-07-18)

Implementations of the flow:

- [kimi-cli (Python) `src/kimi_cli/auth/oauth.py`](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/src/kimi_cli/auth/oauth.py): the complete Python reference (device flow, refresh, lock, expiry strategy)
- [kimi-code (Node/TS) `packages/oauth/src/`](https://github.com/moonshotai/kimi-code/tree/main/packages/oauth/src): the TypeScript reference: `constants.ts`, `oauth.ts`, `storage.ts`, `identity.ts`, `managed-kimi-code.ts`, `managed-usage.ts`
- [KLIP-14, the official OAuth design doc (in Chinese)](https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/klips/klip-14-kimi-code-oauth-login.md): it declares the Device Grant, the `X-Msh-*` headers, and the Moonshot Open Platform as a non-goal
- [pi-kimi-coder `extensions/index.ts`](https://raw.githubusercontent.com/picassio/pi-kimi-coder/main/extensions/index.ts): a third-party reimplementation in around 200 lines, with bidirectional credential sync
- [kimi-code `login-flow.ts`](https://raw.githubusercontent.com/moonshotai/kimi-code/main/apps/kimi-code/src/cli/sub/login-flow.ts): the login UX of the official CLI

Documentation and endpoints:

- [Kimi Code, official documentation](https://www.kimi.com/code/docs/en/): the Coding API's dual protocol, UA gating, the anti-spoofing policy
- [Using in Third-Party Coding Agents](https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents.html): the config `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`, API keys from the console (up to 5)
- [models.dev `api.json`](https://models.dev/api.json): the `kimi-for-coding` entry (proof that opencode uses an API key, not OAuth)
