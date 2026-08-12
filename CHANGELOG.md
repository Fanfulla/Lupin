# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries record what a user can observe. The full engineering record, with the
evidence behind each claim, lives in `docs/ROADMAP.md` and `docs/DECISIONS.md`.

## [Unreleased]

### Fixed

- **A machine with npm only (no Rust sidecar, or no TTY) had no first run in
  0.3.0**: the wizard was removed, the guided screen needs the sidecar, and
  `lupin run` refuses without a config. Bare `lupin` now starts the setup
  daemon in that situation and prints the authenticated `curl` calls ready to
  paste; the first verified provider persists the config exactly as the TUI
  path does.

## [0.3.0] - 2026-08-12

Setup moved into the TUI, whole. This is the breaking release that removes the
CLI setup verbs (ADR-51): if you scripted `lupin init` or `lupin login`, read
the Removed section and README §Headless setup.

### Removed

- **`lupin init`, `lupin login` and `lupin logout` are gone.** Setup lives in
  the hub: bare `lupin` opens the TUI, which now covers everything the wizards
  did. The removed verbs answer with where setup went instead of "unknown
  command". Headless machines (SSH, CI, no sidecar) use the daemon's control
  API directly; README §Headless setup documents the calls, curl included.
- The post-init recommended-skills offer went with the wizard; the docs cover
  the same ground.

### Added

- **Local runtimes are set up from the TUI.** Picking an Ollama, LM Studio,
  llama.cpp or ds4 row runs the live discovery: every chat model with its real
  window (a `max` marker when only the theoretical figure is known), tool
  support, and a "context too small" verdict against the measured Claude Code
  harness floor. Then the main and light picks, and the vision and
  long-context routes strictly on request. A server that is down answers with
  its own start command and a retry key.
- **The economy preset, save-anyway, the official-CLI credential import and
  OAuth account labels moved into the TUI** with the CLI's guarantees intact:
  verification before storage, every choice explicit, nothing silent.
- **Aim a profile's slots from the dashboard** with `m`: opus, sonnet and
  haiku edited in sequence, the last enter applies only what changed, and the
  names are written as given and never checked (the `use --opus` rule). Made
  for the profiles whose models only the account knows (Copilot).
- Catalogue rows that already have a profile say `configured`, and the
  failover question is asked after a setup succeeded, never before the
  provider has answered.

### Fixed

- **A start right after a stop could fail to come up at all**: the daemon
  child died on its first `EADDRINUSE` while the watchdog still held the port,
  so the hold was never yielded. The child now retries the bind inside a
  bounded window.
- **Bare `lupin` with a config but no running daemon opened a dead
  dashboard** where every gesture failed at its last step. The hub now ensures
  the daemon before opening the TUI, exactly as the cold start always did.
- **A control-plane OAuth login whose profile could not be created silently
  kept the token.** It is rolled back and the login job reports the error.

## [0.2.5] - 2026-08-10

### Fixed

- **`lupin update` no longer fails with `EBUSY` while replacing a global
  Windows install.** Before npm runs, Lupin now stops its recorded watchdog
  and daemon in that order, waits for both to exit, and restores a daemon that
  was running before the update. Installed background processes also use the
  Lupin state directory as their working directory instead of anchoring the
  package inside `node_modules`. Only PIDs carrying the exact Lupin entrypoint
  and the random ownership token recorded when they were spawned are stopped.
- **A locally newer package no longer makes a matching sidecar look stale.**
  Sidecar freshness is compared with the installed package, not an older npm
  registry tag, and any rebuild on the already-installed path targets that
  installed version.

Upgrading from 0.2.4 after `EBUSY` may require one Windows reboot because the
old updater cannot run the fix before replacing itself. Close active Lupin and
Claude Code sessions, reboot, and install 0.2.5 before starting Lupin again.
The README includes a PowerShell command that also bypasses a damaged global
npm shim.

## [0.2.4] - 2026-08-10

### Added

- **Provider onboarding now stays inside the optional Rust TUI.** On a machine
  with no Lupin config, bare `lupin` starts a temporary empty daemon and opens
  the hosted-provider catalogue with clear OAuth and API-key labels. API keys
  remain masked and are tested before storage; OAuth rows show the browser URL,
  poll in place, and require an explicit confirmation when the provider carries
  an account-risk warning. A successful setup returns to the dashboard.

### Fixed

- **Cold-start daemon identity now survives the first saved profile.** The
  profile keeps the bootstrap port and local token, conflicting identities are
  refused, and an empty bootstrap config is normalized consistently while the
  first provider is being created.
- **Provider onboarding remains recoverable across retries and refreshes.** The
  catalogue and selection survive key failures, OAuth cancellation and risk
  cancellation; OAuth catalogue rows resolve to the correct flow; delayed
  success refreshes no longer prevent `q` from restoring and leaving the
  terminal.

## [0.2.3] - 2026-08-09

### Fixed

- **`lupin update` also fixes a stale sidecar when the package is already
  latest.** Found on the first real machine to need it: `npm i -g` from a
  version predating `lupin update` leaves the sidecar behind, and 0.2.2's
  command would then say "already the latest" and exit without touching it.
  Now a sidecar whose `--version` is known and different from the package gets
  rebuilt on that path too; one whose version cannot be read is left alone,
  because a guess could rebuild a healthy binary forever.

## [0.2.2] - 2026-08-09

### Added

- **`lupin update` (ADR-49).** One command from "there is a newer Lupin" to
  "everything on this machine runs it": a registry check (only when you invoke
  it, never a startup phone-home), `npm i -g lupin-code@latest` with npm's own
  output visible, and, when a `lupin-tui` sidecar is on your PATH and a Rust
  toolchain exists, a rebuild of the sidecar to the matching version from the
  TUI sources the package now ships, replacing the binary only on build
  success. No sidecar means no offer; no cargo means the manual command is
  printed instead of a failure.
- **`lupin agents ... --wire` (ADR-48).** The last manual step of agent routing
  gone: `set <name> --profile <p> --wire` finds the agent's definition file
  (project `.claude/agents` first, then your home; matched on the frontmatter
  `name:`, falling back to the filename) and writes `model:
  claude-lupin-agent:<name>` into it; `unset <name> --wire` restores `inherit`,
  the documented client default. This is the one deliberate exception to
  "Lupin never touches your harness": explicit flag per invocation, that single
  field, old value printed next to the new one, every other byte of the file
  untouched, and a file without a frontmatter block refused rather than
  restructured. Built-in agents have no file, and the command says so: for
  those the blanket `subagents` route is the lever.

## [0.2.1] - 2026-08-09

### Added

- **Agent routes: mix subagents with total control (ADR-47, SPEC-PROVIDERS
  §4decies).** A global `agents` table in the config maps a name to a model of
  the serving profile or to another profile, and the id
  `claude-lupin-agent:<name>` resolves through it. Put the id where Claude Code
  already accepts a model id (an agent's frontmatter `model:`, the Agent tool
  `model` parameter, or `CLAUDE_CODE_SUBAGENT_MODEL`) and that agent type runs
  on the target you aimed, hot-reloaded, without touching the rest of the
  session. Declare the conventional `subagents` route and `lupin run` fills
  `CLAUDE_CODE_SUBAGENT_MODEL` for you, so every subagent is routed with zero
  frontmatter editing (your own value always wins, and the client applies that
  variable over frontmatter: the blanket route and per-agent ids do not compose
  client-side). Edit the table with `lupin agents` (list/set/unset), from the
  TUI (`a` opens agents mode: pick a route, aim it at a profile, Enter applies
  atomically), or through `POST /v1/lupin/agents`. Requests served by a route
  log `agentRoute`, printed as `agent:<name>` by `lupin top` and the sidecar;
  an id naming a route the config does not have is served on the normal path
  and logged as `agent:unknown:<name>`, never an error. Off unless the table
  exists; content routes never reroute an agent-routed request; nothing is
  published in the model picker. This was the launch thread's most asked
  feature, and the one honest wire fact shaped it: no header or metadata
  identifies a subagent, so the model id is the only channel a proxy can route
  on (verified 2026-08-09 against the official docs and issue tracker).

## [0.2.0]

### Added

- **`editRetryHint`, the first behavioural adapter (ADR-45, opt-in).** Edits are
  applied by exact match, and a model that returns the right content with the
  wrong bytes (re-indented, tabs for spaces, trailing newline dropped) gets its
  edit refused, then often resends the same `old_string` for several turns. With
  this quirk enabled on a profile, the turn right after a rejected edit carries
  one extra system block naming the exact-match rule and telling the model to
  copy the bytes rather than retype them. It repairs nothing on the model's
  behalf: the proxy never rewrites `old_string`, because it has neither the file
  nor a way to know which occurrence was meant, and a wrong guess would corrupt
  a source file. Off by default, never applied to `count_tokens`, and the report
  now says on how many turns it fired, because an adapter nobody can see cannot
  be judged. **Enable it knowing that it is unproven**: the first live
  measurement (2026-08-07) confirmed it fires exactly when it should, and did
  not show it helping, on a model that turned out not to have the defect it
  targets. The numbers and what they do not license are in ROADMAP M5.

### Changed

- **The Rust sidecar shows the same request markers as `lupin top`.** It was
  reading four of them and dropping three, so `retryAfterMs` and `dialect` were
  documented but invisible there, and the new `editHint` would have been too. All
  three now print, in the wording the Node side has always used (`waited:1500ms`,
  `dialect:a+b`, `editHint`), with a test on each side: one log line reads the
  same whichever front end is watching it. An empty `dialect` list prints
  nothing rather than a marker with no name.
- **`lupin doctor` now names the quirks active on the profile.** The report
  printed the dialect normalizations that fired but never the quirks configured
  on the profile, which the `--submit` body has always carried: the person
  reading their own terminal knew less than a stranger reading the scoreboard.
  The new line carries no warning glyph, because a configured quirk is true on
  every run and an alarm that always fires stops being read. It is printed
  because some request quirks (`noParallelToolCalls`, `singleSystemMessage`,
  `identityHint`) change what the model was asked, so a score earned under them
  is not comparable with a bare one. `--json` carries the same information as a
  `quirks` array next to `dialects`, always present, so a machine consumer of
  the payload alone can tell the two apart without reading the config.

### Fixed

- **`lupin doctor` no longer scores a session that died on the transport
  (ADR-23).** The headless result was still read starting from `subtype`, whose
  name promises a verdict and only reports how Claude Code's own loop exited. A
  run whose `terminal_reason` is `api_error` or `auth_error` is now voided on
  that field alone, without waiting for `is_error` to agree, so a provider that
  never answered can no longer earn the "session completed" point and a score
  that reads as a judgement on the model.

- **A truncated stream is no longer reported as a finished turn (ADR-44, issue
  #1).** A provider that answered 200, streamed part of the answer and then
  dropped reached Claude Code as a short but well formed turn with
  `stop_reason: end_turn`. On the translated lanes the proxy now ends that
  stream with an error event instead of a synthesized clean close, and a tool
  call rescued from the cut text is no longer delivered. In passthrough the
  bytes are still forwarded untouched, but the request log gains
  `streamError: truncated` and the provider no longer earns the success that
  clears its failover cooldown. A stream that did send its `stop_reason` is
  unaffected, even if the connection ends before `message_stop`.

## [0.1.2]

### Fixed

- **The credential split-brain now tells the truth (ADR-43).** The 0.1.1 known
  limitation is resolved: when a secret moves from the 600 file into the OS
  keychain (lazy promotion, or a keychain-mode overwrite of a stale file copy),
  the file copy is replaced by a non-secret marker instead of being deleted. A
  file-only install that misses the credential now says it lives in the OS
  keychain this install cannot read, names the move date, and gives the real
  fix (`npm i @napi-rs/keyring`, or a re-login) instead of claiming there are
  no credentials. Deleting a credential removes the marker too, and a
  pure-keychain write still never creates the file.
- **A keychain that refuses a value no longer breaks the read that already has
  it.** Lazy promotion moves a secret from the 600 file into the OS keychain on
  first read; when the backend threw (the Windows blob-limit shape seen on
  2026-08-05), the exception propagated and turned a servable read into a
  failure. Promotion now swallows the backend error, serves the file value, and
  leaves the file copy in place for the next attempt.

## [0.1.1]

### Known limitations

- **Two installations on one machine can disagree about where a credential
  lives.** The store promotes a secret from the 600 file into the OS keychain on
  first read and then deletes the file copy, which is the documented steady
  state (zero secrets on disk). But whether an installation HAS a keychain
  depends on an optional native module and, on Linux, on a Secret Service being
  present. So a keychain-capable install can promote a credential that a
  file-only install on the same machine then cannot see, and the second one
  reports `no OAuth credentials for "<provider>"` and tells the user to log in
  again, which is the wrong advice: the credential is fine, it is simply
  somewhere this install cannot read. Seen for real on 2026-08-05 between a
  global install and a repository checkout without the optional dependency.
  Workaround: install the optional dependency everywhere, or set
  `LUPIN_CREDSTORE=file`.

### Fixed

- **OAuth subscriptions were unusable on Windows whenever the OS keychain was
  the active backend.** The credential store chunks long values to stay under
  Windows Credential Manager's blob limit, but it sized the chunks in UTF-8
  bytes while the platform stores the value as UTF-16 and counts those. Measured
  against the live backend: 1280 characters write and read back, 1281 throws. So
  a 1393-character Kimi token measured "under the limit", took the unchunked
  path, and threw at 2786 UTF-16 bytes; the request came back as
  `401 [lupin] Value of 'password encoded as UTF-16' is longer than the platform
  limit of 2560 chars`. Every test passed throughout, because the in-memory fake
  keyring accepted any length. It now enforces the measured limit.
- The TUI announced **"daemon up" while the daemon was down**. When it dies, the
  watchdog re-binds the port and answers 529 to every path, and that body parsed
  into an empty `Health` because no field of it is required. The dashboard now
  checks the status before parsing, so a watchdog reads as DOWN.
- TUI secondary text (panel titles, timestamps, the whole key legend) was
  `DarkGray`, which is ANSI bright-black and invisible against most dark
  terminal themes.

## [0.1.0]

### Added

- **GitHub Copilot** as a provider (`lupin login copilot --i-accept-the-risk`),
  through the RFC 8628 device flow and a second token bought at exchange time.
  Verified end to end on a Copilot Free plan, up to a real tool call.
- **Profile switching from inside Claude Code**: the `/model` picker lists
  `switch Lupin profile: <name>` rows, and picking one moves the active profile
  without leaving the session. Verified on Claude Code 2.1.222.
- **`identityHint`**, an opt-in quirk that makes the model name the model and
  provider that really answer. Measured against the real harness prompt: with
  the quirk the answer is the truth, without it the model claims to be Claude.
- **Several accounts per provider**: `lupin login <provider> --account <label>`.
  Not available for Copilot, deliberately.
- A cache-bust detector that reads the provider's own token counters, so it
  diagnoses a broken prompt prefix while holding no prompt bytes at all.

### Fixed

- **The OAuth device flow now asks for JSON.** GitHub's endpoints answer
  form-urlencoded unless told otherwise, which made `lupin login copilot` fail
  outright, and would have made a successful browser authorization poll for the
  full fifteen minutes before reporting an expired code.
- **The Kimi device identity headers no longer reach other providers.** They are
  opt-in per descriptor now, the way they were already kept away from the PKCE
  flows.
- The identity hint is no longer appended twice when a request fails over to a
  second profile, which used to tell the model two different things about itself
  in one prompt.
- A refused Copilot bearer is no longer retried unchanged.
- **`lupin use` no longer ignores the flags it does not know.** It now takes
  `--opus`, `--sonnet` and `--haiku` to aim a profile's slots, which `lupin
  login` had been suggesting before they existed, and refuses an unknown option
  instead of reporting success and doing nothing.
- `lupin login` prints the account's catalogue, not just how many models it
  found, and leaves embedding models out of the slots they could never serve.

### Known limitations

- **A Copilot account's `/models` list is not the set of models that account can
  use**: on a free plan, 51 were listed and 5 answered, and the field that looks
  like it would tell you (`supported_endpoints`) points the wrong way. Slots
  still start on the first model listed, which may well be one of the 46. The
  catalogue is printed at login and `lupin use --opus <model>` aims the slots,
  so the way out is one command, but nothing probes the models for you yet.
- No doctor score for Copilot: a full run would spend most of a free plan's
  monthly allowance in one go.

## [0.1.0-rc.1]

The release candidate that preceded 0.1.0. What works, verified with a real headless Claude
Code session scored on disk artefacts (`lupin doctor`):

- **Four lanes**: `passthrough` (providers that already speak Anthropic),
  `translate` (OpenAI-compatible), `responses` (the ChatGPT subscription over
  WHAM), `codeassist` (the Gemini Code Assist subscription).
- **Subscriptions**: Kimi Code 10/10, ChatGPT 10/10, Gemini Code Assist 8/10 on
  a free tier.
- **Local runtimes with no key at all**: Ollama, LM Studio, llama.cpp,
  ds4-server, with the real context window read from the running server.
- **Dialect normalization** for eight model families, verified against the
  official chat templates rather than guessed.
- **CLI**: `init`, `login`, `use`, `go`, `run`, `resume`, `doctor`, `list`,
  `status`, `logs`, `top`, `usage`, plus an optional Rust TUI dashboard.
- **Routing**: content-aware routes with a threshold derived from the window of
  the model really serving, tier-equivalent failover, and a quota-aware durable
  switch.
