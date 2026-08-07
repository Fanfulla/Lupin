# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

Entries record what a user can observe. The full engineering record, with the
evidence behind each claim, lives in `docs/ROADMAP.md` and `docs/DECISIONS.md`.

## [Unreleased]

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
  a source file. Off by default, never applied to `count_tokens`, and its
  efficacy on a real model is not yet measured (see ROADMAP M5).

### Changed

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
