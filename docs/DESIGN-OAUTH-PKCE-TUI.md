# DESIGN: OAuth PKCE (OpenAI, Gemini) + TUI hub + CLI simplification

> Session 2026-07-28. Builds on DESIGN-OAUTH.md (Kimi device flow). Three tracks locked by the user:
>
> 1. **OAuth for subscriptions**: OpenAI (sanctioned), Gemini (banned by Google, **user accepts the risk**, explicit warning), Z.AI (**no public OAuth**: stays API key), Kimi (hardening of the existing device flow).
> 2. **TUI hub**: a `lupin` command with no arguments opens a terminal hub: providers, OAuth login, routing, doctor, log tail. **Rust ratatui sidecar binary**, user decision, overriding the default no-native-dependency posture (the TUI is an OPTIONAL add-on: the core proxy stays pure Node, zero native deps).
> 3. **CLI simplification**: short aliases, sensible defaults, config editable from the TUI.

Every external fact has a verification date and a source. Anything not verifiable is marked.

## 1. OAuth: the provider matrix (verified 2026-07-28)

| Provider | OAuth subscription | Flow | Status / risk |
|---|---|---|---|
| **OpenAI** (ChatGPT Plus/Pro via Codex) | ✅ **Sanctioned** ("Sign in with ChatGPT") | Authorization Code + **PKCE**, loopback redirect | Implementable. The only major provider still allowing third-party OAuth to a subscription in 2026. |
| **Google** (Gemini Code Assist via gemini-cli) | ❌ **Banned**: mass suspensions of paying subscribers (Feb-Mar 2026) | Authorization Code + PKCE, loopback redirect | **User accepts the risk.** Implemented behind an explicit, unavoidable warning at login and in the docs. Never the default suggestion. |
| **Z.AI** (GLM coding plan) | ❌ **No public OAuth** (docs show API key only) | n/a | Stays API key. Nothing to build. |
| **Kimi/Moonshot** | ✅ done (DESIGN-OAUTH) | Device Authorization Grant (RFC 8628) | Hardening only (§4). |

Sources: [opencode issue #3281 (OpenAI Codex OAuth)](https://github.com/anomalyco/opencode/issues/3281), [subscription-access approaches 2026](https://yepanywhere.com/subscription-access-approaches), [7shi/codex-oauth](https://github.com/7shi/codex-oauth), [opencode issue #8035 (Gemini CLI OAuth)](https://github.com/anomalyco/opencode/issues/8035), [Z.AI devpack docs](https://docs.z.ai/devpack/overview), and [openai/codex](https://github.com/openai/codex) (Apache-2.0) `codex-rs/login`: confirms the PKCE flow kind (`mod pkce`), a `CLIENT_ID` constant, a local login server (`run_login_server`) and refresh with endpoint overrides. Lupin implements the same public-client flow from scratch; no codex code is copied (Apache-2.0 is compatible, but the flow is small enough to re-derive).

### 1.1 Verified endpoint facts

**OpenAI** (from opencode's `openai-codex.ts` and codex-oauth):
- Client ID: `app_EMoamEEZ73f0CkXaXp7hrann` (public Codex client, no secret).
- Authorize: `https://auth.openai.com/oauth/authorize`
- Token: `https://auth.openai.com/oauth/token` (exchange + refresh, `grant_type` discriminates).
- Redirect: `http://localhost:1455/auth/callback`
- Scope: `openid profile email offline_access`
- Token refresh: automatic when within ~5 minutes of expiry.

**Google** (captured 2026-07-28 from the official gemini-cli source, `packages/core/src/code_assist/oauth2.ts`):
- Client ID: `681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com` (public installed-app client).
- Client secret: `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` — public, ships in the official CLI; Google's token endpoint demands it even with PKCE, so `OAuthProviderDef` carries an optional `clientSecret` sent on exchange and refresh (omitted for bare public clients like OpenAI).
- Redirect: `http://127.0.0.1:<ephemeral>/oauth2callback` — a DYNAMIC port, not a fixed one, and the `/oauth2callback` path. Lupin's listener already reads the bound port back after `listen(0)`.
- Scopes: `cloud-platform`, `userinfo.email`, `userinfo.profile` (NOT `openid profile email`).
- Token: `https://accounts.google.com/oauth2/token`.

### 1.2 Architecture: a second flow kind

`OAuthProviderDef` (`src/providers/oauth.ts`) gains a discriminated `flow` field:

```ts
export type OAuthFlow =
  | { kind: 'device'; deviceAuthorizationPath: string; pollIntervalMs: number }   // Kimi (existing)
  | { kind: 'pkce'; authorizePath: string; redirectPort: number; redirectPath: string; scope: string };

export interface OAuthProviderDef {
  id: string;
  aliases: string[];
  host: string;                 // auth host (https://auth.openai.com)
  clientId: string;
  flow: OAuthFlow;
  tokenPath: string;            // exchange + refresh (shared by both flows)
  verifyUrl: string;            // GET with the Bearer to verify end to end
  importPaths: string[];
}
```

- The **device flow** (Kimi) is untouched: `startDeviceAuthorization` + `pollDeviceToken` keep working.
- New `src/server/oauth-pkce.ts`: PKCE generation (`code_verifier`/`code_challenge` S256, `node:crypto`), a **loopback-only ephemeral HTTP listener** for the callback, `state` CSRF validation, authorization-code exchange, then the SAME `OAuthTokens` shape and the SAME `refreshOAuthTokens`/`resolveOAuthAccessToken` runtime (both flows converge on `tokenPath` with `grant_type=refresh_token`).
- **No new server route in the daemon**: the PKCE listener is a short-lived standalone server bound to 127.0.0.1 during login only, exactly like the device flow needs no callback route. Lupin's long-lived HTTP surface stays unchanged.
- **Credential storage unchanged**: `oauth/<provider>` keys in the 600 store, same `OAuthTokens` record, same tombstone-on-`invalid_grant`.

### 1.3 Gemini: the warning is part of the feature

Because Google suspends accounts for third-party OAuth, the warning is not a doc footnote: it is a blocking step in `lupin login gemini` that requires an explicit `--i-accept-the-risk` (or an interactive `yes` retype) before the browser even opens, plus a permanent note in SPEC-PROVIDERS and the README. The API-key path stays the recommended default for Gemini. The doctor reports the OAuth path as "subscription path, not guaranteed" (ADR-17), and here also "provider-banned: account suspension risk".

## 2. TUI hub: Rust ratatui sidecar

### 2.1 Why a sidecar, and the boundary

The user chose Rust + ratatui over a Node zero-dep TUI. The core proxy (the translation core, the ingress, the daemon) **stays pure Node, zero native dependencies** (ARCHITECTURE.md). The TUI is a **separate, optional binary** that the user can build with cargo; `lupin` falls back to the current text output (`status`/`list`/`top` one-frame) when the sidecar is absent. Nothing in the request path depends on it.

### 2.2 Communication: loopback control API, not IPC sockets

The TUI talks to the running daemon over the same loopback HTTP it already uses, plus a small set of **control endpoints** the daemon does not yet have. This avoids a second IPC mechanism (named pipes / unix sockets) and reuses the existing auth (`localToken`) and the existing 127.0.0.1 binding.

New control surface (all 127.0.0.1, all requiring the `localToken`, none touching `/v1/messages`):

```
GET  /v1/lupin/state          -> profiles, slots resolved, health, cooldown, lastDoctor (superset of /health)
POST /v1/lupin/use            -> { profile } switch the active profile (hot reload already watches the file)
POST /v1/lupin/login          -> { provider } start an OAuth flow, returns the URL/code to display
GET  /v1/lupin/login/:id      -> poll login progress (pending | done | error)
POST /v1/lupin/logout         -> { provider }
POST /v1/lupin/doctor         -> { profile } enqueue a doctor run (async; doctor is heavy)
GET  /v1/lupin/doctor/:id     -> poll doctor progress / result
```

Rationale: the OAuth device flow and the doctor are both **long-running and async**, so the control API is job-based (POST returns a job id, GET polls). The TUI stays responsive; the daemon owns the work. `POST /v1/lupin/use` writes the config file, which the existing hot-reload watch already picks up, so there is one write path, not two.

Security: every control endpoint requires the `localToken` header exactly like `/v1/messages` does. Bound to 127.0.0.1 only. No body content ever crosses (privacy rule): state, not prompts.

### 2.3 TUI crate layout

```
tui/                     # separate cargo crate, NOT part of the npm package's runtime
  Cargo.toml             # ratatui, crossterm, serde, reqwest (rustls), tokio
  src/main.rs            # event loop, views, keybindings
```

Views (mirroring what `top.ts` already renders, so the layout logic is proven): profiles+slots+health+lastDoctor, "serving now" resolved slots, recent requests from the log tail, plus hub actions (login, logout, switch, doctor, usage). The TUI reads the log file directly (it is local) and calls the control API for everything that changes state.

## 3. CLI simplification

- `lupin` (no args): if a TTY and the sidecar is present, launch the TUI hub; else print `status` + a hint. Today no-args prints the usage banner.
- `lupin go -- claude`: alias for `use` (when a profile arg is given) + `run`. The common two-step becomes one.
- Short aliases stay thin: `lupin ls` = `list`, `lupin st` = `status`. Verbose commands remain canonical.
- Config edits from the TUI go through `POST /v1/lupin/use` (and future setters), never by the TUI writing the config file directly: one writer, the hot-reload path stays the only reload trigger.

## 4. Kimi hardening (scope)

- Refresh token is rotated on **every** refresh (verified 2026-07-19): already saved each time; add a regression note.
- Clearer `invalid_grant`/tombstone message surfaced in the doctor and the TUI ("run `lupin login kimi`"), not only in the proxy log.
- Guided re-login: doctor failure on an OAuth profile prints the exact re-login command.

## 5. Decision records to write (DECISIONS.md)

- **ADR-27**: Rust ratatui sidecar for the TUI; the core proxy stays pure Node; the sidecar is optional and the text fallback stays.
- **ADR-28**: OAuth PKCE flow kind alongside the device flow; OpenAI sanctioned, Gemini behind an explicit accepted-risk warning, Z.AI stays API key.

## 6. Out of scope (unchanged)

Anthropic as a target (ADR-18). A web UI. Persisting prompts/responses. Multi-account OAuth UX (the `provider?` hook stays for later). Cross-process OAuth refresh lock (v2).

## 7. 9router: assessed, not integrated (decided 2026-07-28)

[9router](https://github.com/decolua/9router) (MIT) is a direct competitor: an AI router in front of 40+ providers, exposing an OpenAI-compatible API on `localhost:20128/v1`, with its own OAuth PKCE, 3-tier fallback and multi-account round-robin. Considered as an optional downstream provider, then **rejected**: pointing Lupin at it is a double translation (Claude Code speaks Anthropic, Lupin translates to OpenAI, 9router translates again) and two routers in series means two cooldowns, two retries, two owners of failover. Its headline OAuth covers Claude Code / Codex / Copilot subscriptions, which is ADR-18 territory and stays out of scope.

The decision is to **steal, not integrate** (ROADMAP backlog): their multi-provider OAuth PKCE (Codex, Copilot) and their multi-account round-robin are worth having as first-class Lupin features. If a provider 9router covers better ever matters, it is added as a direct provider, not through a second proxy.
