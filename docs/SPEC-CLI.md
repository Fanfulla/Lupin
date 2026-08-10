# SPEC: CLI and UX

Measurable goal: from zero to a working Claude Code on a third-party provider in **less than a minute**, without ever opening a JSON file.

## 1. Commands

### `lupin init`
Interactive wizard: (1) pick a provider from the list, each with an honest description ("Kimi K3: passthrough, reliable" vs "Ollama: experimental, depends on the model"); (2) paste the API key, stored in the OS keychain (see §4), never echoed on screen; (3) an immediate connectivity test (one real 1-token request); (4) write `~/.lupin/config.json` with the profile and the local token; (5) print the two next commands (`lupin run -- claude` or `lupin use`). Idempotent: running it again adds profiles, it does not destroy them.

### Bare `lupin`: TUI-native onboarding

With a TTY and an available `lupin-tui` sidecar, bare `lupin` opens the hub. When no config exists, the hub starts an empty in-memory daemon and passes its loopback port and generated local token to the TUI. No config or credentials are persisted until a provider has been successfully verified; normal daemon lifecycle files such as the pidfile, log and watchdog pidfile may be written at startup. The first saved profile must keep that bootstrap port and local token so the running TUI and daemon stay authenticated after the config appears.

The add-provider screen reads the hosted defaults from the existing authenticated control API and labels each row `(OAuth)` or `(API key)`. API-key input stays masked; the daemon performs the same one-token connectivity check as `lupin init`, and a failed key saves neither the key nor a profile. OAuth starts as an in-memory daemon job, shows the browser URL when it is available, and is polled by the TUI until completion or failure. A provider carrying a suspension warning requires an explicit confirmation before the browser flow starts. Success refreshes the dashboard instead of spawning another command.

This surface deliberately covers only hosted defaults and one account per OAuth provider. `lupin init` remains the CLI path for local-runtime discovery, model selection, routes, economy/failover offers, and the explicit save-anyway choice after a failed API-key check. `lupin login <provider> --account <label>` remains the path for multiple OAuth accounts. The TUI never spawns `lupin init` or `lupin login`; both front ends reuse the same verification and persistence functions behind the authenticated control API.

### `lupin use <profile> [--bg <profile>|none] [--opus <model>] [--sonnet <model>] [--haiku <model>]`
Switches the active profile by writing the config; the server, when running, hot-reloads it (file watch or SIGHUP). No Claude Code restart is needed: the next request already uses the new profile. `--bg` overwrites the haiku slot with another profile (for example background traffic on Ollama).

`--bg none` undoes the delegation (audit 2026-07-22: `--bg` was one-way). The delegation overwrote the model that was there and nothing records it, so the reset rebuilds it from the only honest sources: the profile's own default (`DEFAULT_PROFILES`, hosted profiles), otherwise the sonnet slot model **while saying so on screen** (a local profile picked its models at `init` and they cannot be reconstructed), suggesting `lupin init` to assign a cheaper one again. If sonnet delegates too, the command fails with an actionable message instead of inventing a name.

**Aiming the slots** (2026-08-05): `--opus`, `--sonnet` and `--haiku` write a model name straight into the named slot of that profile. It exists for the profiles whose model names can only come from the account (SPEC-PROVIDERS §3quater, where every slot starts on the first model the account lists), and `lupin login` had been printing this exact command as the way to fix such a profile for three days before it existed. The names are written **as given and never checked**: nothing local can know which ids a plan will accept, and a validation invented here would be worse than none (rule 5). The command says so on screen. `--bg` and `--haiku` both aim the haiku slot, so asking for both is refused rather than silently dropping one.

**Unknown options are refused.** `use` used to ignore anything it did not recognise, so a typo, or the flag above before it existed, switched the profile, did nothing else, and reported success. Every flag now has to be one of the five, with a value, and there can be exactly one positional argument.

### `lupin agents [set <name> (--profile <p> | --model <m>) | unset <name>]` (2026-08-09, ADR-47, SPEC-PROVIDERS §4decies)

Per-subagent routing, the "mix subagents" control surface:

- **`lupin agents`** lists the table: one row per configured agent route with its target, plus, for each name, the exact id to paste (`claude-lupin-agent:<name>`) and where it goes (an agent's frontmatter `model:`, the Agent tool `model` parameter, or `CLAUDE_CODE_SUBAGENT_MODEL`). The listing states the client-side precedence rule out loud: `CLAUDE_CODE_SUBAGENT_MODEL` overrides frontmatter, so the blanket `subagents` route and per-agent frontmatter routing do not compose client-side.
- **`lupin agents set <name> --profile <p>`** writes the delegation `{"profile": p}` (the profile must exist); **`--model <m>`** writes the model string as given and never checked, same rule and same on-screen notice as `use --opus`. Exactly one of the two flags, unknown flags refused (the ADR-42 lesson).
- **`lupin agents unset <name>`** removes the route.
- Names are validated `[A-Za-z0-9._-]{1,32}` and refused otherwise, never sanitized (the §4nonies argument).
- Same write path as `use`: load, mutate, save; the daemon hot-reloads. No restart anywhere.

**`--wire` (2026-08-09, ADR-48): Lupin writes the frontmatter line for you.** `set <name> ... --wire` finds the agent definition (`.claude/agents/*.md` in the current project first, then in the user home; matched on the frontmatter `name:` field, falling back to the filename) and sets its `model:` to `claude-lupin-agent:<name>`; `unset <name> --wire` sets it back to `inherit`, the documented client default. This is the ONE place Lupin writes into the user's harness, and it is bounded on purpose: only on the explicit flag, only that one field, old value printed next to the new one, everything else in the file byte-identical, and a file with no frontmatter block is refused rather than restructured. Built-in agents (Explore, Plan, general-purpose) have no definition file, so `--wire` cannot reach them and says so: for those the blanket `subagents` route is the lever. When the file is not found the route is STILL saved (the config write happened first and stays useful); the command prints where it looked, prints the line to paste by hand, and exits 1 so a script can tell.

### `lupin run -- <command>` (typically `lupin run -- claude`)
1. Starts the server if it is not running (daemon with a pidfile in `~/.lupin/`).
2. Exports into the child process environment: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `ANTHROPIC_AUTH_TOKEN=<localToken>`, `ANTHROPIC_API_KEY=` (empty, to avoid conflicts), `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (only when the user has not set it already: an explicit value always wins, opt-out included).

   When the config declares the `subagents` agent route (SPEC-PROVIDERS §4decies) and the user has not set `CLAUDE_CODE_SUBAGENT_MODEL` (an explicit value always wins, empty included), `lupin run` also fills `CLAUDE_CODE_SUBAGENT_MODEL=claude-lupin-agent:subagents`, so every subagent request arrives on an id the proxy can aim. Launch-env limit, same as ADR-35: the variable is read at launch, but the TABLE is hot-reloaded, so where the route points can change mid-session.

   That fourth variable is what makes the model picker exist: discovery is opt-in client-side and without it Claude Code never calls `GET /v1/models` (SPEC-PROVIDERS §4.2, verified on the client binary 2.1.219 on 2026-07-24). Client-side conditions, from the same verification: `ANTHROPIC_BASE_URL` set and different from `api.anthropic.com`, none of the `CLAUDE_CODE_USE_*` variables (Bedrock/Vertex/Foundry and friends) active, a credential present (`ANTHROPIC_AUTH_TOKEN` as Bearer, otherwise the key as `x-api-key`). **`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` disables discovery**: whoever sets it gives up the picker, and that is not a Lupin bug.
3. Runs the command; the WHOLE process tree inherits the env, so hooks, plugins (claude-mem) and SDK subagents go through Lupin too (DESIGN §7 requirement). That is why `lupin run` exists instead of telling the user to set the variables by hand.
4. On exit the server stays up (other sessions can use it).

### `lupin login <provider>` / `lupin logout <provider>`
OAuth login for subscription providers (first one: Kimi Code, RFC 8628 device flow, see `docs/DESIGN-OAUTH.md`). `login`: automatic import from the official CLI credentials when present (with confirmation, or `--import`), otherwise it prints the code and the verification URL, opens the browser best-effort and polls; the token is verified with a real request BEFORE being saved; it creates the `kimi-sub` profile when missing. `logout`: removes the record from the store. Tokens live only in `~/.lupin/credentials.json` (600), never in the config.

### `lupin doctor [<profile>] [--json] [--submit]`
The most important command (see §3). `--submit` generates the pre-filled scoreboard issue (§3.3): no upload, the user sees what is being published first.

### `lupin update` (2026-08-09, ADR-49)

One command from "there is a newer Lupin" to "everything on this machine runs it", sidecar included:

1. **The check**: `GET https://registry.npmjs.org/lupin-code/latest`, compared with the running version. This is the ONLY network call Lupin ever makes that is not the user's own traffic, and it happens exclusively when this command is invoked: no startup check, no phone-home, consistent with the no-telemetry rule (§4.3). Already latest means saying so and exiting 0.
2. **The package**: `npm i -g lupin-code@latest`, spawned with inherited stdio so npm's own output (progress, permission errors) reaches the user unfiltered.
3. **The sidecar, rebuilt to match**: the tarball ships the TUI sources (`tui/`), so when a `lupin-tui` is already on the PATH and a Rust toolchain exists, the command rebuilds it from the just-installed package (`CARGO_TARGET_DIR` under the system temp dir, so `node_modules` stays clean and the cache survives across updates) and copies the binary over the one on the PATH only on build success. No sidecar on the PATH means no offer (the user never opted into it); no cargo means the manual command is printed instead of a failure. A copy refused because the TUI is running says to close it and rerun. **A stale sidecar is fixed even when the package is already latest** (2026-08-09, found on a real machine): the bootstrap `npm i -g` of an install predating this command, or a rebuild that failed last time, leaves `lupin-tui --version` behind the package; when that version is known and different, the rebuild runs anyway. An unreadable sidecar version is left alone: a guess could rebuild a healthy binary forever.

Every step reports its outcome in words; a failed step never claims the ones after it. The decision of what to do is a pure, tested function of the observed state (versions, sidecar presence, toolchain presence); the executor only carries it out.

### `lupin list`
A table: profiles, provider, mode, model per slot, last doctor score with its date, active profile highlighted.

### `lupin status` / `lupin stop` / `lupin logs [-f]`
Daemon status; stop; tail of the structured logs.

### `lupin top` (implemented 2026-07-25, backlog #8)

The console of truth in the terminal, refreshed every second: profiles with their slots, health and last doctor score; the models the daemon is REALLY serving right now (from `GET /health`, so the answer does not come from the model); and the recent requests from the log tail, each carrying its routing markers (`routed`, `failedOver`, `cooldown`, `retryAfterMs`, `dialect`, `editHint`, `streamError`), the same set and the same wording on both front ends: `lupin top` in Node and the Rust sidecar print one log line identically, and a test on each side pins it. Keys: `q` quits, `1` to `9` switch the active profile.

Deliberately plain: ANSI escapes plus polling, no ink, no React, no dependency at all, so it works over SSH and in Windows Terminal (the "no heavy dependencies" constraint of backlog #8). The whole screen is a pure function of a snapshot, which is what makes the layout testable without a terminal, and with a non-TTY stdout it prints one frame and exits instead of repainting into a pipe.

Truth boundaries it keeps: a daemon that does not answer prints "serving now: unknown", never a guess; a profile with no doctor run prints `-`, never a zero.

### `lupin usage [--days N] [--json]` (implemented 2026-07-25, backlog #14)
What the proxy actually served, aggregated from its own log: requests, input and output tokens, cache reads and the share of served input they cover, grouped by profile and model, heaviest first. Offline and local: it reads `~/.lupin/lupin.log`, sends nothing anywhere, and persists nothing new.

Why the proxy log and not the Claude Code transcript: **the proxy is the only place that sees 100% of the traffic**. Subagents talk to it but write nothing into the transcript, so a transcript-based count misses them (measured 2026-07-20: 332 requests against 113 visible turns).

The absent-vs-zero rule holds per field, as in the doctor's cache receipt: a field nobody measured prints `-`, never `0`. That is not theoretical, it was found on a real log: one written before the usage tap existed (2026-07-20) has requests and no counts, and a `0` there would read as "this profile spent nothing" instead of "nobody measured".

### `lupin resume [<profile>] [-- <claude args>]` (spec'd 2026-07-31, backlog #16 scenario B; see `docs/DESIGN-HANDOFF.md`)

The one-gesture handoff for a NATIVE Claude Code session that hit its usage limits: switch to a third-party profile and reopen the same conversation through the proxy. `lupin resume kimi-sub` is `lupin use kimi-sub` followed by the `lupin run` path spawning `claude --continue`; with no profile it keeps the active one. Anything after `--` is appended to the claude args; when the user supplies their own `--resume`/`--continue` there, Lupin injects nothing.

Rules it must keep:

1. **Usage errors before any state change**: an invalid invocation must not have switched the profile (the `lupin go` lesson, ADR-30). A profile never starts with a dash, so `resume -h` and a forgotten `--` are usage errors, never profile lookups.
2. **Same directory, said out loud**: sessions are keyed to the cwd, so the command works from the directory the native session ran in. It does not scan other directories. When the cwd has no recorded transcript it WARNS with the cwd rule and still proceeds (measured live 2026-07-31: claude's own failure there is cryptic, and the key transform is best-effort, so a miss must never block a resume that would have worked).
3. **The cold-prefix advisory**: before spawning, stat the most recent transcript of the cwd (`~/.claude/projects/<key>/*.jsonl`, size only, content NEVER read, nothing ever written into `~/.claude`). Past 1 MB (the sampled real sessions run 8+ MB for roughly a million estimated prefix tokens) it prints one line: the first request re-pays the full prefix at a cold cache and may exceed the target window; compacting before exiting the native session is the client-side lever. Lupin never compresses (DESIGN-HANDOFF §3.4).
4. **Known limit, not hidden**: a replayed native history carries Anthropic-signed thinking blocks; on a passthrough target their acceptance is provider-dependent until the probe in DESIGN-HANDOFF §3.1 records the live answer. Translate, responses and codeassist lanes drop history thinking by design, so they are unaffected.

## 2. Env and precedence

Claude Code reads `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from the environment or from `settings.json` (`env`), with shell variables taking precedence. Lupin uses ONLY the process environment (through `lupin run`) and never writes into `~/.claude/settings.json`: we do not touch the user's config, and removing Lupin means simply not using `lupin run`. The README documents the manual alternative (exporting the two variables) for anyone who does not want the wrapper.

## 3. `lupin doctor`: specification

It runs a real Claude Code session in headless mode (`claude -p "<task>" --output-format json`, temporary working directory) against the given profile. The task covers the operations that break non-Claude models:

| # | Check | What it verifies | Points |
|---|---|---|---|
| 1 | Basic answer | streaming and response format | 1 |
| 2 | Read + comprehension | simple tool use | 1 |
| 3 | **Edit exact-match** | editing a file with Edit (the killer of third-party models) | 3 |
| 4 | Multiple edits in sequence | an agentic loop that does not stall | 2 |
| 5 | Test MCP tool | an MCP server fixture shipped in the repo (an `echo` tool with the long name `mcp__lupin_doctor__echo_test`) | 2 |
| 6 | Multi-step task with verification | write a script, run it, fix the planted error | 1 |

Output: score out of 10, per-check detail (pass/fail plus an error excerpt), average latency, tokens spent and estimated cost. Persisted on the profile (`lastDoctor`). Exit code 0 only with a score at or above the threshold (default 7), so it is usable in CI. A `--json` format for the scoreboard.

**Cache receipt** (2026-07-24, backlog #11a, approved in MARKET-2026-07 §2): among the tap metrics the doctor accumulates `cache_read_input_tokens` and `cache_creation_input_tokens` as the provider reported them across the whole session. The doctor session is itself the measurement: every request after the first re-sends the grown prefix, so on a caching provider reads MUST show up if the proxy preserves prefixes. A provider that does not report the fields means no receipt, never an invented zero; the rule holds PER FIELD at print time too (writes reported but reads never: the line says "never reported", not "0 read"). `--json` carries the raw counts (`cacheReadTokens`/`cacheCreationTokens`, next to `inputTokens`, from which the scoreboard derives the percentage); the human line also prints the share of served input. Transparency is proven, not declared. The live run against a real provider is still to be done (it needs a key, like every live criterion).

Honesty constraint: the doctor must have NO hidden retries. It measures the bare behaviour of the model, because its purpose is to predict the real user experience. (When the behavioural adapters land in M5, the doctor will report both scores: bare and adapted.)

### 3.1 No score without a session (verified live 2026-07-19)

A score only means something if the model was really asked. Two cases, both found on the first real run against LM Studio, where the doctor was lying:

1. **Context window preflight.** The Claude Code harness sent **46075 tokens** for this task (system prompt + 5 allowed tools + the MCP fixture). The model was loaded at 8192: every request failed before reaching it, and the doctor printed 1/10 as if that were a judgement on the model. The profile already knows the window (`contextWindows`, §4quater), so the doctor checks it BEFORE starting anything: under `DOCTOR_MIN_CONTEXT` (50000, that is the measured 46075 plus headroom for the output) it refuses in zero seconds, explaining both numbers. A window that was never declared is not a small window: silence means proceed. The slot with the lowest value is checked, not just `sonnet`: Claude Code opens the session on the `opus` slot.
2. **Honest reading of the headless result.** Claude Code answers `subtype: "success"` whenever ITS loop ends cleanly, even when every single request to the provider failed: the observed run was `{"subtype":"success","is_error":true,"num_turns":1,"terminal_reason":"api_error"}`. Stopping at `subtype` awarded the point of check 1 ("session completed") to a dead session. The truth is in `is_error` and `terminal_reason`. The three fields are read in the reverse of the order they read in: a transport `terminal_reason` (`api_error`, `auth_error`) voids the run on its own, then `is_error`, and `subtype` is consulted last. The observed capture carried all three, so reading `subtype` first survived it by luck; a line that sets only the field naming the outcome must void the run just the same.

### 3.2 Session time budget

The session budget **must** be larger than the per-request ceiling (`PROVIDER_TIMEOUT_MS`, 600s). They used to be the same number: one slow answer could eat the entire session, and the report could no longer tell "the provider hung once" from "the model got nowhere", which are exactly the two verdicts this tool exists to separate, given that the task has 6 steps and Claude Code spends 15 to 25 requests on it.

The value is **derived** from the provider timeout (times 3), not written beside it: raising one cannot silently invalidate the other, and a test keeps them tied. `LUPIN_DOCTOR_TIMEOUT_MS` overrides it for slow local hardware, where a single 46K-token prefill can run for minutes; an invalid value (zero, negative, non numeric) falls back to the default instead of disabling the timeout.

Two facts that read alike and are not: the quirks **configured** on the profile, and the dialect normalizations that **fired**. The report prints both, and only the second one is a warning. A configured quirk is true on every run of that profile, so an alarm on it would fire always and would stop being read, while a normalization that fired means the model produced something Claude Code could not use and the proxy repaired it (§5bis rule 3). The configured list is printed anyway, without a glyph, because some request quirks (`noParallelToolCalls`, `singleSystemMessage`, `identityHint`) change what the model was asked, and a score earned under them is not comparable with a bare one. `--json` carries both, `quirks` (configured) next to `dialects` (fired), each always present so the shape does not depend on the profile, and on a voided run too: the quirks were active whether or not a score came out.

The distinction that matters: a transport `terminal_reason` (`api_error`, `auth_error`) voids the verdict. The `notRun` field replaces the score, the exit code is 1 and **`lastDoctor` is not written** (a 0 nobody earned would poison the history). A model too weak to finish the task is instead a legitimate result and keeps its score.

### 3.3 `--submit`: a pre-filled issue, not an upload (implemented 2026-07-24)

`lupin doctor --submit` **sends nothing to anyone**. It builds a pre-filled GitHub issue locally on the `provider-report.md` template (label `provider-compat`), prints the URL and tries to open the browser: the submission exists only if the user presses submit. No backend, no telemetry, consistent with §4.3.

What travels: provider, model, mode, auth type, date, Lupin version and runtime, active quirks, score with the check table, duration, requests, average latency, tokens in/out, cache receipt, `cache_control` probe outcome, dialect normalizations that fired. A voided run (§3.1) travels as its **cause**, never as a score: "this provider never even let the session start" is exactly the kind of fact the scoreboard exists for.

What never travels: credentials and the name of the key's env var, the profile `baseUrl` (a local or private endpoint is none of the scoreboard's business), prompts, responses, log lines. The body is capped at 6000 characters: past that it is visibly truncated, so the URL stays valid.

The public scoreboard generated from the submissions stays M5: `--submit` is its client, and the channel (the issue template) already exists in the repo.

## 4. Security

1. API keys in the OS keychain (implemented 2026-07-22 with @napi-rs/keyring, ADR-26; keytar is archived); fallback: the file `~/.lupin/credentials` with 600 permissions. Never in the config, never in the logs. When a secret moves from the file into the keychain, the file copy is replaced by a non-secret marker (ADR-43) so a file-only install on the same machine reports where the credential lives instead of advising a pointless re-login.
2. The server binds to `127.0.0.1` only; it refuses requests without the `localToken`.
3. No telemetry. The scoreboard receives explicit submissions only (`lupin doctor --submit`, opt-in).

## 5. Distribution

`npx lupin-code@latest init` as the main path (zero install); `npm i -g lupin-code` for stable use; scoped mirror `@fanfulla/lupin`. The installed command stays `lupin` (the `bin` field). The npm name `lupin` is taken by an abandoned 2022 package, see DECISIONS #15. Node >= 20. No mandatory native dependency (the keychain module is optional, with a file fallback).

**Publication readiness, checked 2026-07-25** (`npm publish --dry-run`):

- The tarball is `dist/`, `fixtures/mcp-echo`, `examples/`, plus the README and the LICENSE that npm always includes. No Node sources, no tests, no internal docs. Since 0.2.2 it also ships the **TUI sources** (`tui/` without its build artifacts): they are what lets `lupin update` rebuild an installed sidecar to the matching version (ADR-49). They are sources to build FROM, never code the Node runtime loads: ADR-27's "no native dependency" holds unchanged.
- `prepack` runs the build, so the published `dist/` can never lag behind the sources.
- `dist/cli.js` keeps its `#!/usr/bin/env node` shebang, which is what makes the `lupin` bin executable after a global install.
- `repository`, `homepage`, `bugs` and `keywords` are set: without `repository` the relative links in the README break on the npm page, and the package has no repo link at all.
- Both names are free on the registry (`lupin-code` and `@fanfulla/lupin`, checked 2026-07-25).

What is left is the user's: `npm login`, the actual `npm publish` (the scoped mirror needs `--access public`), and the pre-publication step of removing the internal `.md` files from the remote (ROADMAP).

## 6. UX acceptance criteria

1. New user, Kimi provider: from `npx lupin init` to the first answer in Claude Code in under 60 seconds (timed, provider account signup excluded).
2. Profile switch with a Claude Code session open: the next request uses the new model, zero restarts.
3. `lupin doctor` on an unsuitable model produces a clear, actionable verdict, not a stack trace.
4. Killing the daemon mid-session: Claude Code shows an understandable error (Anthropic format, SPEC-TRANSLATION §6), and the next `lupin run` starts clean (stale pidfile handled). **VERIFIED live 2026-07-25** on a sandboxed `LUPIN_DIR`: the daemon was killed with `taskkill /F`, and from then on requests received `HTTP 529` with the body `{"type":"error","error":{"type":"overloaded_error","message":"provider unreachable: lupin daemon stopped mid-session: run \`lupin run -- claude\` again (this fallback is only holding the port)"}}`; the next `ensureDaemon` (what `lupin run` calls) started a fresh daemon with a new pid and answered `/health` 200, and the port was free again after the stop.

   **Measured caveat, worth stating**: the watchdog takes over in **around 0.6s** (it polls the pidfile every 500ms, then binds). Requests that land in that window get a raw connection error, not an Anthropic body. Claude Code retries network failures, so in practice the session survives, but "instant" would be a lie: the honest claim is "one lost request at most, then a well-formed error".
