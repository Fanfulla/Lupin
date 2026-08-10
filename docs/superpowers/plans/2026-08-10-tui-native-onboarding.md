# TUI-native onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a new user add an API-key or OAuth provider from the Lupin TUI, including a cold start with no existing configuration.

**Architecture:** The Node daemon remains the sole writer of `config.json` and credentials. It exposes a small provider catalogue and setup routes over the existing token-guarded control API, reusing the CLI's verification and profile-creation logic. When `lupin` finds a TTY and the sidecar but no config, it starts a temporary zero-profile daemon and passes its identity to the TUI, which drives the new add-provider mode through the control API.

**Tech Stack:** TypeScript strict, Node >= 20, Hono, Vitest; Rust 2021, ratatui, crossterm, reqwest with rustls; cargo test.

## Global Constraints

- The specs are the source of truth. Update the applicable spec before code if a discovered requirement conflicts with it.
- Keep the core proxy pure. HTTP and filesystem work stay in `src/server/`; CLI modules orchestrate only.
- Use `DEFAULT_PROFILES` as the sole provider catalogue. Never hardcode provider or model names in Node or Rust source.
- API keys and OAuth tokens must never enter config files or logs. Save credentials only after successful verification.
- The config's zero-profile state is legal only with an absent or empty `activeProfile`; a non-empty profile set keeps current validation rules.
- The TUI remains optional: non-TTY and no-sidecar hub behavior stays unchanged.
- Do not add dependencies. Keep all code and documentation in English and use no em dash.
- Before every commit and push, run the project CI commands: `npm run lint`, `npm run typecheck`, `npm test`, and `cargo test --manifest-path tui/Cargo.toml`.
- Do not bump a version, tag, publish, or create a release without explicit user approval.

---

## File structure

| File | Responsibility |
|---|---|
| `src/config/config.ts` | Accept and validate the narrow empty-profile bootstrap config state. |
| `src/cli/login.ts` | Create OAuth profiles with an optional daemon identity rather than generating a replacement identity. |
| `src/cli/init.ts` | Expose a reusable key-profile persistence helper which preserves the CLI wizard's existing behavior. |
| `src/server/control.ts` | Serve the provider catalogue, key setup, and corrected OAuth job completion through authenticated control routes. |
| `src/server/start.ts` | Start the daemon from an explicit bootstrap config when no file exists, then transition to file-backed reloads after setup. |
| `src/server/daemon.ts` | Start an explicitly identified bootstrap daemon without requiring a config file. |
| `src/cli/hub.ts` | Select normal versus bootstrap startup and inject the bootstrap identity into the sidecar environment. |
| `test/config.test.ts` | Pin zero-profile schema acceptance and invalid variants. |
| `test/control.test.ts` | Pin catalogue, setup, OAuth verification/profile creation, and no-persist-on-failure contracts. |
| `test/hub.test.ts` | Exercise hub selection and bootstrap environment wiring without spawning real processes. |
| `tui/src/config.rs` | Read a valid empty config and resolve bootstrap identity from environment only when needed. |
| `tui/src/api.rs` | Fetch providers, start/poll OAuth jobs, and submit API keys through the control API. |
| `tui/src/main.rs` | Own the add-provider state machine and route its keys before dashboard shortcuts. |
| `tui/src/ui.rs` | Render provider picker, risk confirmation, masked key input, OAuth wait, success, and error overlays. |
| `tui/src/job.rs` | Remove obsolete `init` and `login` palette rows. |
| `docs/SPEC-CLI.md`, `docs/DECISIONS.md`, `docs/TESTING.md` | Record the new hub behavior, ADR, API-key/OAuth TUI path, and manual cold-start verification. |

## Task 1: Allow a persisted empty-profile bootstrap config

**Files:**
- Modify: `src/config/config.ts:59-137`
- Modify: `test/config.test.ts:28-81`

**Interfaces:**
- Produces: `validateConfig(value: unknown): LupinConfig` accepts `{ activeProfile: "", port, localToken, profiles: {} }`.
- Produces: `LupinConfig.activeProfile` remains a string so existing ingress consumers continue to compile.
- Consumes: Existing `ProfileConfig` and `validateAgents` validation.

- [ ] **Step 1: Write the failing schema tests**

Add the three state-matrix cases beside the existing `validateConfig` cases:

```ts
it('accepts an empty profile map with an empty activeProfile', () => {
  expect(validateConfig({ ...VALID, activeProfile: '', profiles: {} }).profiles).toEqual({});
});

it('rejects a non-empty activeProfile when profiles is empty', () => {
  expect(() => validateConfig({ ...VALID, activeProfile: 'ghost', profiles: {} })).toThrow(/ghost/);
});

it('still rejects an empty activeProfile when profiles exist', () => {
  expect(() => validateConfig({ ...VALID, activeProfile: '' })).toThrow(/activeProfile/);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run test/config.test.ts`

Expected: the first case fails because `activeProfile` is currently required to be non-empty.

- [ ] **Step 3: Implement the minimal conditional validation**

Read `profiles` before validating `activeProfile`. Use the map cardinality to keep the current invariant for configured installs:

```ts
const profiles = c['profiles'] as Record<string, unknown>;
const emptyProfiles = Object.keys(profiles).length === 0;
if (typeof c['activeProfile'] !== 'string' || (!emptyProfiles && c['activeProfile'] === '')) {
  throw new Error('config: "activeProfile" must be a non-empty string when profiles exist');
}
if (emptyProfiles && c['activeProfile'] !== '') {
  throw new Error(`config: activeProfile "${c['activeProfile']}" is not defined in profiles`);
}
```

Only perform membership validation when `profiles` is non-empty. Preserve validation of port, local token, profiles, routes, failover, and agents.

- [ ] **Step 4: Run focused validation tests**

Run: `npm test -- --run test/config.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the schema change**

```bash
git add src/config/config.ts test/config.test.ts
git commit -m "feat(config): allow empty bootstrap profiles"
```

## Task 2: Reuse verified profile setup behind control routes

**Files:**
- Modify: `src/cli/login.ts:359-438`
- Modify: `src/cli/init.ts:299-331`
- Modify: `src/server/control.ts:11-261`
- Modify: `test/control.test.ts:114-192`
- Modify: `test/login-profile-repair.test.ts:71-118`

**Interfaces:**
- Produces: `type BootstrapIdentity = Pick<LupinConfig, 'port' | 'localToken'>` exported from `src/cli/login.ts` or a focused shared type location.
- Produces: `ensureOAuthProfile(def, account?, discoveredModels?, bootstrapIdentity?): void`.
- Produces: `persistKeyProfile(def: DefaultProfileDef, key: string, bootstrapIdentity?: BootstrapIdentity): Promise<{ ok: true } | { ok: false; error: string }>` exported from `src/cli/init.ts`.
- Produces: `GET /v1/lupin/providers` returning `{ ok: true, providers: ProviderCatalogRow[] }`.
- Produces: `POST /v1/lupin/setup-key` taking `{ providerId, key }` and returning `{ ok: true }` or `{ ok: false, error }`.
- Consumes: `testProviderKey`, `setCredential`, `mergeProfile`, `verifyToken`, `setOAuthTokens`, `ensureOAuthProfile`, `DEFAULT_PROFILES`, and the existing local-token guard.

- [ ] **Step 1: Write failing control-route tests for the catalogue and key setup**

Use the sandboxed `LUPIN_DIR` harness already in `test/control.test.ts`. Cover these observable contracts:

```ts
it('lists non-local defaults with auth kind derived from the descriptor', async () => {
  const res = await appWithControl().request('/v1/lupin/providers', { headers: auth });
  const body = (await res.json()) as { providers: { id: string; authKind: string }[] };
  expect(res.status).toBe(200);
  expect(body.providers.some((p) => p.id === 'ollama')).toBe(false);
  expect(body.providers.find((p) => p.id === 'openai-sub')?.authKind).toBe('oauth');
  expect(body.providers.find((p) => p.id === 'gpt')?.authKind).toBe('key');
});

it('does not save a key or profile when key verification fails', async () => {
  // Inject a failing connectivity dependency through registerControlRoutes/createApp.
  const res = await app.request('/v1/lupin/setup-key', { method: 'POST', headers, body: JSON.stringify({ providerId: 'gpt', key: 'bad' }) });
  expect(res.status).toBe(400);
  expect(loadConfig().profiles).toEqual(baseConfig().profiles);
});
```

Also cover a successful key setup, unknown `providerId` (404), rejected local or OAuth-only id, and a bootstrap identity whose persisted config keeps the in-flight daemon's port and token.

- [ ] **Step 2: Write failing OAuth-job regression tests**

Extend the existing PKCE job test to assert that successful completion both verifies before writing and creates `openai-sub`. Add a fake verification failure case asserting no OAuth token and no subscription profile are persisted:

```ts
expect(getOAuthTokens('openai')).toBeUndefined();
expect(loadConfig().profiles['openai-sub']).toBeUndefined();
```

- [ ] **Step 3: Run the focused Node tests and verify failures**

Run: `npm test -- --run test/control.test.ts test/login-profile-repair.test.ts`

Expected: failures for missing route, missing setup helper, and login job saving before verification.

- [ ] **Step 4: Extract the minimal shared helpers without changing CLI behavior**

In `src/cli/login.ts`, add an optional identity argument. When there is no config file, construct the seed config from it when supplied and retain the current random `3456` path otherwise:

```ts
const seed: LupinConfig = bootstrapIdentity === undefined
  ? { activeProfile: profileName, port: 3456, localToken: cryptoToken(), profiles: {} }
  : { activeProfile: '', port: bootstrapIdentity.port, localToken: bootstrapIdentity.localToken, profiles: {} };
```

In `src/cli/init.ts`, extract the non-interactive portion of the API-key path. It must call `testProviderKey` first; on success call `setCredential`, `mergeProfile`, and `saveConfig`; on failure return the detail with no writes. Keep the wizard's "Save anyway?" branch in `initCommand` only.

- [ ] **Step 5: Add control API types, dependencies, and routes**

Add narrow control dependencies for `testProviderKey` and `verifyToken` so tests can force failures without changing global registries. Build the catalogue only from `DEFAULT_PROFILES.filter((d) => d.local !== true)`:

```ts
type ProviderCatalogRow = {
  id: string;
  description: string;
  authKind: 'key' | 'oauth';
  suspensionWarning?: string;
};

const providers = DEFAULT_PROFILES
  .filter((d) => d.local !== true)
  .map((d) => ({
    id: d.id,
    description: d.description,
    authKind: d.oauthOnly === true ? 'oauth' : 'key',
    ...(findOAuthProvider(d.provider)?.suspensionWarning !== undefined
      ? { suspensionWarning: findOAuthProvider(d.provider)!.suspensionWarning }
      : {}),
  }));
```

For `setup-key`, reject descriptors without `apiKeyEnv` and pass the daemon's `{ port, localToken }` as the bootstrap identity. In `runLoginJob`, call `verifyToken` before `setOAuthTokens`, then call `ensureOAuthProfile` with the same identity, and leave job status `error` on any failure.

- [ ] **Step 6: Run focused Node tests and inspect the persisted contract**

Run: `npm test -- --run test/control.test.ts test/login-profile-repair.test.ts test/config.test.ts`

Expected: PASS. Confirm the failed key/OAuth cases write neither credential nor profile, and bootstrap success persists the original port/token.

- [ ] **Step 7: Commit the control-plane implementation**

```bash
git add src/cli/login.ts src/cli/init.ts src/server/control.ts test/control.test.ts test/login-profile-repair.test.ts
git commit -m "feat(control): add provider setup routes"
```

## Task 3: Start the TUI against an unconfigured bootstrap daemon

**Files:**
- Modify: `src/server/start.ts:12-43`
- Modify: `src/server/daemon.ts:64-96`
- Modify: `src/cli/hub.ts:1-57`
- Create: `test/hub.test.ts`
- Modify: `test/daemon-watchdog.test.ts` if an extracted daemon bootstrap helper needs direct unit coverage

**Interfaces:**
- Produces: `BootstrapIdentity { port: number; localToken: string }` generated once by the hub and passed unchanged to daemon and sidecar.
- Produces: daemon start path accepting an empty in-memory `LupinConfig` before a config file exists.
- Consumes: Task 1's zero-profile validation and Task 2's control routes that persist the same identity after setup.

- [ ] **Step 1: Write a failing hub test using injected runtime dependencies**

Extract a testable `hubCommandWith(deps)` rather than spawning Node or the sidecar in-process. Assert the cold-start TTY + sidecar path starts bootstrap exactly once, launches the TUI with its identity, and does not write `config.json`:

```ts
expect(startBootstrap).toHaveBeenCalledOnce();
expect(spawnTui).toHaveBeenCalledWith(expect.objectContaining({
  LUPIN_BOOTSTRAP_PORT: expect.any(String),
  LUPIN_BOOTSTRAP_TOKEN: expect.any(String),
}));
expect(existsSync(defaultConfigPath())).toBe(false);
```

Also pin existing fallback behavior: missing config without a TTY or sidecar still prints the documented init guidance and does not start a daemon.

- [ ] **Step 2: Run the hub test and verify it fails**

Run: `npm test -- --run test/hub.test.ts`

Expected: FAIL because the hub exits before checking TTY/sidecar and there is no bootstrap helper.

- [ ] **Step 3: Add an explicit daemon bootstrap entry contract**

Make `start.ts` distinguish an environment-supplied bootstrap config from a normal file-backed daemon. The bootstrap config is:

```ts
{
  activeProfile: '',
  port: Number(process.env.LUPIN_BOOTSTRAP_PORT),
  localToken: process.env.LUPIN_BOOTSTRAP_TOKEN ?? '',
  profiles: {},
}
```

Validate it with `validateConfig`. Do not create or watch a config file until the first successful setup has saved one. Once the file exists, switch the watcher to normal `loadConfig(configPath)` reload behavior. Keep normal daemon startup unchanged.

- [ ] **Step 4: Add a daemon helper that launches bootstrap safely**

In `src/server/daemon.ts`, add a parameterized launch helper or a dedicated `ensureBootstrapDaemon(identity)` that supplies `LUPIN_BOOTSTRAP_PORT` and `LUPIN_BOOTSTRAP_TOKEN` only to the server process. Reuse existing detached process, logging, health polling, and watchdog behavior. Never put the token on argv or disk.

- [ ] **Step 5: Change the hub's cold-start branch**

Reorder `hubCommand`: determine sidecar availability only on a TTY; if config exists, preserve the current launch path. If config is missing and both conditions are true, generate `randomBytes(24).toString('hex')`, choose the bootstrap port using the established default/config-free convention, start the bootstrap daemon, and launch `lupin-tui` with inherited stdio plus:

```ts
{
  ...process.env,
  LUPIN_BOOTSTRAP_PORT: String(identity.port),
  LUPIN_BOOTSTRAP_TOKEN: identity.localToken,
}
```

The no-sidecar and non-TTY path remains the current `no config yet: run \`lupin init\` first` result.

- [ ] **Step 6: Run focused lifecycle tests**

Run: `npm test -- --run test/hub.test.ts test/daemon-watchdog.test.ts test/control.test.ts`

Expected: PASS. The test must prove no config exists before setup and the control route remains reachable with the passed local token.

- [ ] **Step 7: Commit bootstrap startup**

```bash
git add src/cli/hub.ts src/server/daemon.ts src/server/start.ts test/hub.test.ts test/daemon-watchdog.test.ts
git commit -m "feat(hub): bootstrap TUI without config"
```

## Task 4: Add Rust control-API clients and bootstrap identity fallback

**Files:**
- Modify: `tui/src/config.rs:31-90`
- Modify: `tui/src/api.rs:1-190`
- Modify: `tui/src/main.rs:30-96`

**Interfaces:**
- Produces: `BootstrapIdentity { port: u16, local_token: String }` resolved from `LUPIN_BOOTSTRAP_PORT` and `LUPIN_BOOTSTRAP_TOKEN`.
- Produces: `ProviderRow { id: String, description: String, auth_kind: AuthKind, suspension_warning: Option<String> }`.
- Produces: `fetch_providers(identity)`, `start_login(identity, provider, accept_risk)`, `poll_login(identity, job)`, and `setup_key(identity, provider_id, key)` returning `Result<..., String>`.
- Consumes: Node route shapes from Task 2 and a config file that may parse as `profiles: {}`.

- [ ] **Step 1: Write failing Rust parsing and API helper tests**

Add config parsing coverage for the persisted empty config and pure parser tests for control responses:

```rust
#[test]
fn an_empty_bootstrap_config_parses() {
    let c: LupinConfig = serde_json::from_str(r#"{"activeProfile":"","port":3456,"localToken":"tok","profiles":{}}"#).unwrap();
    assert!(c.profiles.is_empty());
}
```

Factor response interpretation into pure functions where practical and test provider auth-kind decoding, a pending login with URL, done login, route error text, and a successful key setup response.

- [ ] **Step 2: Run Rust tests to verify failure**

Run: `cargo test --manifest-path tui/Cargo.toml`

Expected: compile or test failure because the new control response types/helpers do not exist.

- [ ] **Step 3: Resolve a usable identity in `config.rs`**

Keep `default_config_path()` unchanged. Add `bootstrap_identity_from_env()` that returns `Some` only when both values are valid. Do not fall back to a guessed port or token. Adjust `LupinConfig.active_profile` handling only as needed to support `""` without implying an active profile.

- [ ] **Step 4: Make snapshots use config identity first, then bootstrap identity**

Change `api::snapshot` to accept `Option<&BootstrapIdentity>`. With a config it fetches health and profiles as today. Without a config but with bootstrap identity, it fetches `/health` using the bootstrap port, keeps `profile_names` empty, and still reads the local log tail. Without either it retains the honest no-config/no-daemon snapshot.

- [ ] **Step 5: Implement control API clients with existing error wording conventions**

Use the same 1500 ms blocking `reqwest` client pattern as `switch_profile` and always attach `Authorization: Bearer <token>`. The catalogue endpoint is GET; login and setup are JSON POSTs; login polling is GET. Parse the Node `{ ok, ... }` envelope and surface its `error` text, falling back to `daemon said HTTP <status>`.

- [ ] **Step 6: Thread the bootstrap identity from `main.rs`**

Remove the early exit that rejects a missing/unreadable config when a valid bootstrap identity exists. Pass `bootstrap_identity.as_ref()` into the first and refreshed snapshots. Keep the existing no-config exit when neither source exists.

- [ ] **Step 7: Run Rust tests**

Run: `cargo test --manifest-path tui/Cargo.toml`

Expected: PASS.

- [ ] **Step 8: Commit the Rust API layer**

```bash
git add tui/src/config.rs tui/src/api.rs tui/src/main.rs
git commit -m "feat(tui): add onboarding control client"
```

## Task 5: Implement the TUI add-provider mode

**Files:**
- Modify: `tui/src/main.rs:71-341`
- Modify: `tui/src/ui.rs:159-223,703-850`
- Modify: `tui/src/job.rs:200-255,295-310`

**Interfaces:**
- Consumes: `api::ProviderRow`, `fetch_providers`, `start_login`, `poll_login`, `setup_key`, `Snapshot`, and `BootstrapIdentity` from Task 4.
- Produces: an add-provider state machine entered automatically when `snap.config` is absent or has no profiles, and optionally from normal dashboard input if a discoverable add action is retained.
- Produces: a masked key field that is never displayed as typed and is cleared after submit/cancel.

- [ ] **Step 1: Write failing `TestBackend` rendering tests for every state**

Create a compact `AddProviderMode` test fixture and assert the screen text for:

```rust
assert!(out.contains("add provider"));
assert!(out.contains("(OAuth)"));
assert!(out.contains("(API key)"));
assert!(out.contains("API key: ********"));
assert!(out.contains("Open in your browser"));
assert!(out.contains("provider added"));
assert!(out.contains("invalid key"));
```

Include a suspension-warning state where the warning and confirm instruction render before any login starts. The key assertion must prove plaintext such as `secret-value` is absent from the TestBackend buffer.

- [ ] **Step 2: Update the palette contract test first**

Remove `init` and `login` palette rows from `PALETTE`, then update `every_row_either_runs_or_says_why_not` and key-uniqueness expectations. The palette must no longer claim those flows require a shell.

- [ ] **Step 3: Run Rust tests and verify failure**

Run: `cargo test --manifest-path tui/Cargo.toml`

Expected: rendering tests fail because no onboarding overlay/state exists.

- [ ] **Step 4: Define a focused state machine in `main.rs`**

Add an enum with only the required states, for example:

```rust
enum AddProviderMode {
    Loading,
    List { providers: Vec<ProviderRow>, cursor: usize },
    ConfirmRisk { provider: ProviderRow },
    KeyInput { provider: ProviderRow, value: String, submitting: bool },
    OAuthWaiting { provider: ProviderRow, job: String, url: Option<String> },
    Success(String),
    Error { message: String, return_to_list: bool },
}
```

Enter `Loading` before normal dashboard key matching when the config is missing or `profiles` is empty. Fetch the catalogue once on entry. Ensure `Esc` from a field/list gives a talking-line explanation or exits cleanly rather than falling through to profile switching.

- [ ] **Step 5: Implement key routing and polling**

Route the mode before palette, job, order, agents, and normal shortcuts. Required behavior:

- Up/down or `j`/`k` selects a catalogue row.
- Enter on OAuth opens `ConfirmRisk` only when `suspension_warning` exists; otherwise calls `start_login`.
- Enter in `ConfirmRisk` starts with `acceptRisk: true`; Esc returns to list.
- Enter on a key row opens `KeyInput`; typed characters append to the hidden value, Backspace removes one Unicode scalar, Enter calls `setup_key`.
- Refresh ticks call `poll_login` for `OAuthWaiting`; display the URL once received; transition to success when done or error/list when the job errors.
- After either successful setup, refresh the snapshot and leave add mode for the normal dashboard, which now has a profile.
- When the daemon stops answering, use the bootstrap-specific text `daemon not answering: restart with \`lupin\``.

- [ ] **Step 6: Render overlays in `ui.rs`**

Add `render_add_provider` and pass `Option<&AddProviderMode>` through `render`. Use the existing centered overlay, rounded block, dim hint, and reversed cursor conventions. Rows must derive labels from `ProviderRow`, not match on identifiers. Render `*` per input character or a fixed non-revealing marker, never any input bytes. Add the overlay after the dashboard and before no other unrelated restructuring.

- [ ] **Step 7: Update dashboard copy and palette**

For an empty profile config, replace the old dead-end `no config: run \`lupin init\` first` primary cue with `no providers yet: add one below` while preserving truthful fallback text outside bootstrap. Update key hints only where the new add-provider affordance is actually reachable. Do not add a duplicate CLI-child command for onboarding.

- [ ] **Step 8: Run all Rust tests**

Run: `cargo test --manifest-path tui/Cargo.toml`

Expected: PASS, including all new visual states and existing dashboard, order, agent, and palette tests.

- [ ] **Step 9: Commit the TUI workflow**

```bash
git add tui/src/main.rs tui/src/ui.rs tui/src/job.rs
git commit -m "feat(tui): add provider onboarding"
```

## Task 6: Update specifications, run full verification, and perform the cold-start pass

**Files:**
- Modify: `docs/SPEC-CLI.md`
- Modify: `docs/DECISIONS.md`
- Modify: `docs/TESTING.md`
- Modify: `docs/ROADMAP.md` only if the work-order deviation or completion status needs an explicit record

**Interfaces:**
- Consumes: completed Node and Rust implementation from Tasks 1-5.
- Produces: accurate user-facing behavior, ADR rationale, and a repeatable manual cold-start verification record.

- [ ] **Step 1: Update the CLI/TUI specification**

Document that bare `lupin` with a TTY and available sidecar bootstraps an empty in-memory daemon when no config exists, and that the add-provider screen lists hosted defaults with OAuth/API-key labels. Specify key verification-before-save, OAuth polling, risk confirmation, and the retained CLI-only save-anyway/local-runtime/multi-account behavior.

- [ ] **Step 2: Add an ADR entry**

Add the next sequential ADR to `docs/DECISIONS.md`. State that onboarding is TUI-native through the existing authenticated control API, that the bootstrap daemon identity must survive the first persisted profile, and that the TUI does not spawn `init` or `login` child commands. Explain the rejected alternatives: a web UI, duplicated setup logic, and forcing cold-start users back to CLI.

- [ ] **Step 3: Extend the manual TUI checklist**

In `docs/TESTING.md`, add a cold-start pass using a sandboxed empty `LUPIN_DIR`:

```text
1. Ensure config.json does not exist and lupin-tui is on PATH.
2. Run lupin in a real terminal and confirm the add-provider list appears.
3. Verify an OAuth row shows its browser URL and, after completion, returns to the dashboard.
4. Verify an invalid API key stays masked, saves nothing, and offers retry.
5. Confirm the resulting config keeps the bootstrap port/local token and the dashboard can switch or refresh.
6. Exit with q and confirm the terminal is restored.
```

Do not claim a live third-party credential test occurred until it has actually been performed.

- [ ] **Step 4: Run the complete project verification suite**

Run:

```bash
npm run lint
npm run typecheck
npm test
cargo test --manifest-path tui/Cargo.toml
```

Expected: all commands exit 0. If any fails, use `superpowers:systematic-debugging` before changing implementation.

- [ ] **Step 5: Perform the documented manual cold-start smoke test**

Use a temporary `LUPIN_DIR` with no config. Run the built sidecar from a real terminal, exercise the provider picker and at least one non-secret failure path, then exit. Stop only processes started by the test. Before and after stopping any background process, check the claude-mem worker health endpoint as required by global instructions.

- [ ] **Step 6: Commit documentation and verification artifacts**

```bash
git add docs/SPEC-CLI.md docs/DECISIONS.md docs/TESTING.md docs/ROADMAP.md
git commit -m "docs: specify TUI-native provider onboarding"
```

- [ ] **Step 7: Push the completed commits**

After the full verification suite passes, push the ordinary feature commits to `main` under the standing repository authorization. Do not create a version, tag, release, or publish.

## Self-review

- **Spec coverage:** Task 1 covers the zero-profile schema. Task 2 covers the provider catalogue, key setup, verified OAuth parity, and identity threading. Task 3 covers cold-start hub/daemon behavior. Task 4 covers Rust control clients and bootstrap fallback. Task 5 covers provider selection, masked keys, OAuth polling, risk confirmation, result states, and obsolete palette removal. Task 6 covers docs, complete test suites, and the required manual cold-start pass. Local discovery, multi-account, economy/failover offers, and CLI wizard removal are explicitly excluded.
- **Placeholder scan:** No unresolved placeholders, TODOs, or unspecified test assertions remain.
- **Type consistency:** Node bootstrap identity is `{ port, localToken }`; Rust converts it exactly to `{ port, local_token }`. The control routes consistently use `providerId` for key setup and `provider` for OAuth, matching the approved design.
