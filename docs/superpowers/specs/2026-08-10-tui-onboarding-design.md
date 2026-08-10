# TUI-native onboarding: add a provider without leaving the dashboard (2026-08-10)

Origin: a user tried to configure GPT via ChatGPT OAuth. `lupin init` only offers the API-key path (`oauthOnly` profiles are filtered out of its picker by design, `init.ts:34-36`), so `openai-sub` never showed up. They found the right command only because an agent went spelunking through the provider registry. Direct feedback: the onboarding UX is bad, and it should be possible to do all of this from the TUI instead of hunting for the right CLI incantation.

## The problem

Two gaps, not one:

1. **Discoverability.** `lupin init`'s picker hides every `oauthOnly` profile with no pointer to `lupin login`. A user who wants "GPT" has no way to learn OAuth exists as an alternative to pasting a key.
2. **Reach.** Even once you know the right command, the TUI cannot host it. `lupin` (bare, `hub.ts:34-40`) refuses to even launch the TUI when no config exists yet ("no config yet: run `lupin init` first"), and the TUI's own command palette (`tui/src/job.rs`) explicitly excludes `init` and `login` from the commands it can run, by design: "`init` reads hidden input, `login` opens a browser and waits for the user to come back... say so beats a row that hangs." That decision assumed the only way to host a command is spawning the CLI as a child process and reading its stdout — a model that genuinely cannot do hidden input or a multi-minute browser wait cleanly.

## What already exists and gets reused

- `POST /v1/lupin/login` + `GET /v1/lupin/login/:id` (`src/server/control.ts`): an async job, built for exactly this (the file's own header says the control API is "the loopback surface the TUI and the simplified CLI drive"). It starts an OAuth flow and lets the caller poll instead of blocking a terminal — the TUI does not need `job.rs`'s child-process model to host login at all, it can talk to this endpoint directly the same way `tui/src/api.rs` already talks to `/v1/lupin/use` and `/v1/lupin/agents`.
- `verifyToken` and `ensureOAuthProfile` (`src/cli/login.ts`, both exported): the exact verify-then-save-then-create-profile logic the CLI path uses. Reused as-is, not reimplemented.
- `testProviderKey` and `mergeProfile` (used by `src/cli/init.ts`'s key path): the exact verify-then-save logic for API keys. Reused as-is.
- Two bugs found in the process, fixed as part of this work regardless of who calls them: `runLoginJob` in `control.ts` currently saves the OAuth token **without verifying it first** (the CLI path always verifies before saving) and **never calls `ensureOAuthProfile`**, so a login through the control API today would succeed and create nothing. Both get brought to parity with the CLI path.

## Design

### 1. Config schema: zero profiles becomes a legal state

`config.ts` currently requires `activeProfile` to be a non-empty string that names a real profile, unconditionally (`config.ts:105-134`). A cold-start bootstrap needs to represent "the daemon is up, nothing is configured yet." The validator changes to: when `profiles` is empty, `activeProfile` must be absent or `""`; when `profiles` is non-empty, today's rule holds unchanged (non-empty, must exist in `profiles`). No other state becomes legal — a non-empty `activeProfile` pointing at nothing in an empty-profiles config is still rejected.

### 2. `GET /v1/lupin/providers` (new, control API)

Returns the catalog the picker needs: one row per `DEFAULT_PROFILES` entry with `local !== true` (runtime discovery stays out of scope, see below), shaped as `{ id, description, authKind: 'key' | 'oauth', suspensionWarning? }`. `authKind` comes from whether the entry is `oauthOnly` or carries `apiKeyEnv`. This is the single source of truth Rust reads instead of hardcoding provider names client-side (rule 5) — today nothing exposes this catalog outside the Node process at all.

### 3. `POST /v1/lupin/login` fixed, `POST /v1/lupin/setup-key` (new)

`runLoginJob` gains the missing `verifyToken` call before `setOAuthTokens`, and calls `ensureOAuthProfile` after success, matching `loginCommand` exactly.

`setup-key` takes `{ providerId, key }`. Unlike login this is a single ~1-token request, not long-running, so it is synchronous: test connectivity, and only on success `setCredential` + `mergeProfile` + `saveConfig`. A failed test returns `{ ok: false, error }` and saves nothing — the CLI's interactive "save anyway? [y/N]" escape hatch stays CLI-only (a rare path, not worth an HTTP round-trip protocol for v1).

### 4. Bootstrap identity continuity

Both `ensureOAuthProfile` and `setup-key`'s save path, when no config exists yet, currently invent a fresh `port`/`localToken` (`login.ts:370-375`, hardcoded `port: 3456`). That is correct for the CLI, a one-shot process with no daemon to consult. It is wrong when the caller IS the already-running bootstrap daemon (see next section): the freshly persisted config must carry the SAME port/token the daemon is already bound to and the TUI is already talking to, or the connection breaks the instant the first profile is saved. Both functions gain an optional bootstrap-identity override, supplied only by the control-API call sites, that is the running daemon's own `{ port, localToken }` instead of inventing new ones.

### 5. `hub.ts` bootstrap-on-missing-config

Today: `loadConfig()` fails → print "run `lupin init` first" → exit 1, TUI never launches. New behaviour: when a TTY and the sidecar are available (the existing gate, `hub.ts:42`) but `loadConfig()` fails, generate an ephemeral `{ port, localToken }` in memory, start the daemon bound to it with an empty in-memory profile set (nothing written to disk yet), pass the pair to the `lupin-tui` child through env vars, and launch the TUI as normal. The TUI's `config::load` already returns `Option<LupinConfig>` and the snapshot already tolerates `None` (`api.rs:44-58`) — it gains a fallback to the env-supplied bootstrap pair so it can still reach the control API with zero profiles on screen, and `ui.rs` renders the add-provider screen directly instead of today's dead end.

Spot-checked, not just assumed: `ingress.ts` already reads the active profile as `config.profiles[config.activeProfile]?.provider ?? ''` (`ingress.ts:111`, and twice more for failover), so an empty `profiles` map with `activeProfile: ""` degrades to "no provider configured" rather than a crash. No `/v1/messages` traffic is expected during this narrow bootstrap window anyway. A full sweep of every config consumer for the new zero-profile state is a planning-phase task, not asserted as complete here.

### 6. The Rust "add provider" screen

A new mode in `ui.rs`, same shape as order-mode/agents-mode (an `Option<Mode>` checked before the normal key match, per the existing pattern noted in job.rs's own comments). List fetched from `/v1/lupin/providers`, one row per provider tagged `(OAuth)` or `(API key)` — this is the direct fix for the discoverability bug that started this. `Enter` on an OAuth row calls `POST /v1/lupin/login`, then polls `GET /v1/lupin/login/:id` on every tick, showing the URL and a spinner; a `suspensionWarning` provider shows the warning and requires a confirm keypress before the job starts (the endpoint already supports `acceptRisk`, `control.ts:199-201`). `Enter` on a key row opens a masked input field, `Enter` again POSTs to `/v1/lupin/setup-key` and shows the result inline. On success either path returns to the normal dashboard, which now has a profile to show.

## What this deliberately does not do

- **No local-runtime discovery** (Ollama/LM Studio) in the new screen. That path queries `GET /models` live, excludes embedders, and asks for two model picks — a self-contained flow with nothing to do with either bug reported here. Stays on `lupin init`, `local: true` entries excluded from `/v1/lupin/providers`.
- **No multi-account** (`--account <label>`) support. The screen creates the bare default profile only; a second account of a provider stays a CLI gesture.
- **No economy-tier, failover, vision, or long-context offers** during add-provider. The profile is created with its plain defaults; every one of those is already reachable afterward through its own surface (`lupin use --bg`, the TUI's existing `o` order mode, `lupin use --opus/--sonnet/--haiku`).
- **The CLI wizard is not removed.** `lupin init`/`lupin login` stay for scripting, SSH, non-TTY, and the deferred features above. Both surfaces call the same underlying functions, so they cannot diverge (the project rule against duplicated logic).
- **Non-TTY / no sidecar behaviour is unchanged.** Only the "config missing AND sidecar available AND TTY" branch of `hub.ts` gains bootstrap; every other fallback stays as documented in `docs/TUI.md`.

## Error handling

- Daemon stops answering mid-poll (login or key setup): same wording `api.rs` already uses for a dead daemon on switch/agents, reworded for the bootstrap case since `lupin run -- claude` does not apply yet ("restart with `lupin`").
- Invalid/expired key: `setup-key` returns the same `testProviderKey` detail text the CLI prints; nothing is saved, the field stays open to retry.
- OAuth failure (denied, timeout, network): the job's `error` field carries the message; the screen shows it and returns to the list, no partial state (no token saved, no profile created) — this was already true for a genuine failure and stays true now that verification is added.
- `profiles: {}` with a non-empty `activeProfile` is still a hard validation error; only `profiles: {}` + absent/empty `activeProfile` becomes legal.
- `job.rs`'s `init`/`login` palette rows are removed rather than left as permanently-unhosted stubs: the reasons they were excluded (hidden input, blocking browser wait) are resolved by the new screen bypassing the child-process job model entirely, so a stale "run it in a shell" row would now be actively misleading.

## Test plan

**Node**: schema tests for the three `activeProfile`/`profiles` combinations (empty/empty legal, empty/non-empty rejected, non-empty enforces membership as today); `runLoginJob` regression tests asserting verify-before-save and profile creation on success, and NO token saved when verification fails (the exact bug found here); route tests for `GET /v1/lupin/providers` (shape, `local` entries excluded, `authKind` correct) and `POST /v1/lupin/setup-key` (happy path, failed connectivity, unknown `providerId`, bootstrap-identity threading when no config exists); a `hub.ts` test for the new bootstrap branch (daemon started, TUI spawned with the ephemeral pair, nothing written to disk yet).

**Rust**: `api.rs` unit tests for the three new client calls (`fetch_providers`, `start_login`/`poll_login`, `setup_key`) following the existing error-string pattern `set_agents`/`switch_profile` use; `ui.rs` `TestBackend` render tests for each screen state (provider list, masked key input, OAuth waiting/URL shown, success, error) matching the existing order-mode/agents-mode overlay tests; `job.rs`'s `every_row_either_runs_or_says_why_not` test updated for the `init`/`login` rows' removal.

**Manual**: a full cold start on a machine with no `~/.lupin` at all, since this is precisely the path that had no automated coverage and is where the reported bug lived.
