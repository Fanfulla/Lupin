# NEXT STEPS: start here after a context reset

> Written 2026-07-29 as a cold-start handoff. Read this first, then `docs/ROADMAP.md` for the milestone history and `docs/DECISIONS.md` before reopening any choice. Everything below was verified on the day it was written; re-run the checks in §2 before trusting it.

## 1. Where the project is

Lupin is a local proxy that lets Claude Code run on any third-party provider. Four lanes now exist in the ingress:

| Lane | For | State |
|---|---|---|
| `passthrough` | providers that already speak Anthropic (Kimi, DeepSeek, Z.AI, Ollama, LM Studio, ds4) | working since M1 |
| `translate` | OpenAI-compatible providers (OpenAI platform, Gemini, OpenRouter, llama.cpp) | working since M2 |
| `responses` | the ChatGPT subscription over WHAM (M6a) | working, doctor 10/10 |
| **`codeassist`** | **the Gemini Code Assist subscription (M6b)** | **new, working, doctor 8/10 on a free tier** |

**666 Node tests + 29 Rust tests green, CI green on Linux, Windows and the TUI.** The last session built the whole `codeassist` lane and closed M6b, and made free tiers a cross-provider concept. On 2026-07-29 a full-command audit hardened the CLI (ADR-29/30) and the TUI became the v2 dashboard (ADR-31), both verified live on Windows PowerShell and in tmux on Linux (WSL).

### What works right now, end to end

- **Kimi subscription** (`lupin login kimi`, profile `kimi-sub`): OAuth device flow, passthrough.
- **ChatGPT subscription** (`lupin login openai`, profile `openai-sub`): OAuth PKCE, the `responses` lane. `lupin doctor openai-sub` = **10/10**.
- **Gemini Code Assist subscription** (`lupin login gemini --i-accept-the-risk`, profile `gemini-sub`): OAuth PKCE, the `codeassist` lane. `lupin doctor gemini-sub` = **8/10** on a FREE tier account.
- **API-key providers**: unchanged (`lupin init`).
- **The scenario-B handoff** (`lupin resume [profile]`, 2026-07-31): a native Anthropic session that hit its limits continues on any profile via `claude --continue` through the proxy. Live-verified twice against Kimi, including a mixed-history second hop (DESIGN-HANDOFF §4, ADR-32).
- **The TUI sidecar** (`tui/`, optional, Rust): the v2 dashboard (ADR-31): panels, the Lupin portrait, a talking status line, 1-9 switching through the control API. Driven live in tmux (Linux): a switch from the TUI shows up in `lupin list`, and a `lupin use` elsewhere shows up on screen within a second.

### Operational facts you will want immediately

- **The Kimi subscription quota renewed by 2026-07-31** (a live ping on k3 answered 200 during the handoff probe). It was out of quota on 2026-07-29; the cycle evidently reset in between. The active profile is `kimi-sub`.
- Profiles in the config: `kimi`, `kimi-sub`, `lmstudio`, `openai-sub`, `gemini-sub`.
- **The Google account is on the Code Assist FREE tier**: every pro model answers 429, roughly one call a minute gets through, and Google collects prompts, code and output there with human reviewers able to read them. Anything that captures or tests against it must back off.
- Credentials live in `~/.lupin/credentials.json` (600). **Never log, commit or push tokens, auth codes or keys.**
- The daemon runs on port 3456. `lupin status` tells you if it is up.
- **`lupin run` on Windows was broken by the startup announcement (fixed 2026-07-29, ADR-29)**: the spawn went through cmd.exe, which mangled the inline `--settings` JSON, and claude refused to start ("Invalid JSON provided to --settings"). Now an .exe spawns WITHOUT a shell, and a .cmd/.bat shim (which cannot spawn without one, EINVAL) gets the settings as a FILE under LUPIN_DIR, never inline. Regression tests: `test/run-spawn.test.ts`. Known limit left on purpose: through a .cmd shim the user's own args with quotes/spaces still pass raw.

## 2. How to verify the state before trusting it

Run these in order. The first three are exactly what CI runs, and **must** be run before any push (see §5).

```bash
npm run lint         # eslint .   (NOT a scoped variant: that is how CI broke once)
npm run typecheck    # tsc --noEmit
npm test             # vitest run  -> expect 666 passing
cargo test --manifest-path tui/Cargo.toml   # the optional Rust sidecar, 29 tests
cargo clippy --manifest-path tui/Cargo.toml -- -D warnings   # CI runs this too

# Live checks against the real ChatGPT subscription (needs the OAuth token):
node --import tsx scripts/wham-lane-e2e.mts     # non-streaming + streaming through the whole proxy
node --import tsx scripts/wham-vision-e2e.mts   # a generated red PNG must come back "Red"
node --import tsx scripts/wham-limits-e2e.mts   # max_tokens and stop_sequences enforcement

# Live checks against the real Gemini Code Assist subscription (free tier: slow, backs off on 429):
node --import tsx scripts/codeassist-lane-e2e.mts  # non-streaming + streaming + a real tool call

# The project's own bar (a real headless Claude Code session, spends subscription quota):
npm run lupin -- doctor openai-sub              # expect 10/10
npm run lupin -- doctor gemini-sub              # expect 8/10, ~16 min on the free tier
```

To re-record the fixtures (only if a protocol changes):

```bash
node --import tsx scripts/codeassist-capture.mts      # all three Code Assist captures, retries on 429
```


```bash
node --import tsx scripts/wham-capture.mts            # text stream
node --import tsx scripts/wham-capture-tool.mts       # tool call
node --import tsx scripts/wham-capture-toolresult.mts # tool result round trip
```

**Redact captures before committing**: they carry a `safety_identifier` (a user id) and a `prompt_cache_key`. The existing fixtures were scrubbed to `user-REDACTED` and a zeroed UUID.

## 2bis. Session 2026-08-02: what changed, and what it means for you

Six items closed in one session, all pushed to `main`, each with its ADR and its commit. The full record with links is the RESUME HERE block of `docs/ROADMAP.md`; this is the short version for someone continuing the work (or continuing it on another model through `lupin resume`).

| What | Where | State |
|---|---|---|
| ds4 re-verified at source, `raiseStreamIdleTimeout` | ADR-35, `c531c19` | source truth, no hardware to run it |
| statusline examples finished, EN, and the routing truth made consistent | ADR-none, `b1b7273` | done; fixed a real bug in `startupAnnouncement` |
| several accounts per provider | ADR-36, `460e09f` | done, no rotation code: it is the failover chain |
| switch profile from the `/model` picker | ADR-37, `4f7a2fc` | done, 10 tests; never driven with a real keyboard |
| GitHub Copilot as a device-flow provider | ADR-38, `370530d` | **verified live 2026-08-05** on a free plan, after two fixes (`832d09b`) |
| identity hint + cache-bust detector | ADR-39/40, `fd58971` | done; the hint **beat the real harness prompt**, measured A/B on 2026-08-05 |

**All three were proven live on 2026-08-05** against Claude Code 2.1.222. The full record is the RESUME HERE block of `docs/ROADMAP.md`; in one line each:

1. **The `/model` picker switch**: the client keeps the switch rows (verified in its own `cache/gateway-models.json`) and a picked row switches the profile once, on the change only.
2. **The identity hint**: measured A/B on the same question. With the quirk the model names the real model and provider; without it, it claims to be Claude Opus 5 from Anthropic.
3. **GitHub Copilot**: works end to end on a **free** account, up to a real tool call. Two bugs in the shared OAuth code had to be fixed first, and three UX defects around slot discovery are still open (ROADMAP, and SPEC-PROVIDERS §3quater.1).

**Do not repeat these traps** (all measured 2026-08-05):

- The Copilot account catalogue is **not** the list of usable models: 51 listed, 5 answered. `supported_endpoints` points the wrong way. Probe before believing.
- `lupin use --opus <model>` does not exist even though `lupin login` suggests it. Aim a discovered profile by editing the config until that is built.

## 3. What to do next, in order

### 3.1 M6b: the Google Code Assist translator (DONE 2026-07-29, doctor 8/10)

The Google OAuth token spends on the **Code Assist API**, not on the public Gemini endpoint. That is the mirror image of what M6a solved for OpenAI, and M6a was the template. **It is done**: what follows is the record of what was built and, more useful, what the live probes corrected (details in `docs/DESIGN-TRANSLATORS-DEDICATED.md` §2.2bis).

- **Done**: the post-login probe now targets `POST :loadCodeAssist` instead of the public Gemini endpoint. Before this, the verify failed after every browser consent and **no Google token was ever persisted**; there is now an `oauth/gemini` entry in the store.
- **Done**: the open question on the project id is closed. `:loadCodeAssist` returns `cloudaicompanionProject` for an already-onboarded account and nothing for a fresh one, so `:onboardUser` is a first-login-only long-running operation. Verified on two accounts.
- **Done**: the request envelope, the SSE frame shape, the acceptance of an honest `lupin/0.1.0` UA, and which models the free tier actually serves.
- **Done**: three REAL captures (`test/helpers/captures/codeassist-*.sse`) and the script that records them, `scripts/codeassist-capture.mts` (it backs off on 429, which the free tier hands out readily).
- **Done**: `src/core/codeassist/request.ts` (16 tests) and `src/core/codeassist/stream.ts` (16 tests), both fixture-first.
- **Done**: the ingress lane. Provider `geminisub`, `mode: 'codeassist'`, `server/codeassist-forward.ts` (7 lane tests), and `gemini-sub` derived through `defaultProfileId` so a login no longer builds it from the pay-per-token descriptor. **Verified live through `createApp`**: `claude-opus-5` -> `gemini-2.5-flash` answered from an injected tool result, and `claude-haiku-4-5` -> `gemini-3.1-flash-lite` chose to call a tool and streamed its arguments, with the full Anthropic event sequence. Replay it with `node --import tsx scripts/codeassist-lane-e2e.mts`.
- **Done**: `lupin doctor gemini-sub` scores **8/10** against a threshold of 7, so the milestone bar is met. 955s over 75 requests, 428k input tokens with 44% served from cache; Edit exact-match 3/3, edits in sequence 2/2, the MCP tool called. The two failed checks are the two that need a long answer carried through to the end, and the session itself ended on `429 No capacity available for model gemini-2.5-flash`: the free tier ran out of capacity mid-run. That is a tier limit, not a translation defect, and it is the honest ceiling of this profile until the account is upgraded.

**Free tiers are now a first-class, cross-provider concept** (`src/providers/tiers.ts`, 7 tests). A free model is not hidden and not refused: wherever Lupin names a model it says when that model is free and where the paid plan is. Two independent sources feed it, because providers publish the fact differently: DECLARED (Google answers with `currentTier`, so the lane reports it) and BY CONVENTION (OpenRouter suffixes `:free`, visible with no request at all). Surfaces: the model picker display name, `/health` (both shipped statuslines now render `(free)`), and the login notice.

On Code Assist specifically, a free tier account is SERVED on every slot rather than refused, and the substitution is logged as `tierDowngrade` with the model that really ran. Refusing was tried and measured first: Claude Code opens a session on the **opus** slot, so a hard block killed the very first request and `lupin doctor` never reached the model. That is the reason the code looks the way it does.

Two things still undecided, both recorded rather than guessed:

1. **The `thoughtSignature` round trip.** Google returns an opaque blob next to text and to `functionCall`, and clearly expects it back. Lupin drops it. Whether that degrades multi-turn tool use is untested.
2. **DECIDED 2026-07-29, the thinking budget**: `max_tokens` is forwarded as-is and no `thinkingConfig` is sent. Thinking tokens spend the same budget, so a *small* `max_tokens` can come back as `finishReason: MAX_TOKENS` with no content; Claude Code sends large ones, so the trap needs a deliberately tiny limit to appear. Capping the budget would have quietly cut the model's reasoning without the client knowing, which is worse than a documented limit.

Two facts to carry into the design, neither of them a detail:

1. **This runs on the free tier, not on a subscription.** Neither account has a paid Code Assist entitlement. The free tier answers **429 RESOURCE_EXHAUSTED** on every pro model and rate-limits two consecutive calls, so the doctor bar (a real Claude Code session) may not even be reachable on the models that matter. Decide what "M6b done" means before building against it.
2. **The free tier collects prompts and code, and says human reviewers may read them** (`privacyNotice`, up to 18 months of disconnected copies). CLAUDE.md rule 7 binds the proxy, not Google: this has to reach the user in the CLI, not only in a doc.

Verified facts gathered earlier (in `docs/DESIGN-TRANSLATORS-DEDICATED.md` §2.2), from the official `gemini-cli` source:

- Base `https://cloudcode-pa.googleapis.com`, version `v1internal`, methods as `:method` suffixes: `:generateContent`, `:streamGenerateContent`, `:countTokens`, plus `:loadCodeAssist` and `:onboardUser`.
- It wraps `generateContent` with extra fields: `userPromptId`, `projectId`, `sessionId`, `enabledCreditTypes`.
- Streaming is SSE with `alt=sse`.
- It needs a **project id** and an onboarding step the public API does not have. (That was the open question; it is answered above and in §2.2bis of the design doc.)

**Warning to carry forward**: Google suspends accounts for third-party OAuth (mass bans Feb-Mar 2026). The login is deliberately gated behind `--i-accept-the-risk`. The user accepted that risk for their own account; do not quietly widen it.

### 3.2 Smaller items, closed 2026-07-29

Everything in this list used to be an open point. What follows is what was done, so nobody reopens it by accident.

- **A stale subscription profile is repaired at login.** `gemini-sub` written before the codeassist lane existed claimed `provider: gemini` / `mode: translate`, and the OAuth token does not spend there at all. `ensureOAuthProfile` now repairs provider and lane, and replaces the slots ONLY when they still match some default profile's exactly; a custom slot survives and is named in the output. 4 tests.
- **`response.failed` is pinned by tests** (one error event, the stream closed to everything after, no `message_stop`). The frame is synthetic: a live occurrence still has never been seen, and cannot be forced.
- **The last Italian strings are gone** from `src/`, two of them user-facing in the init wizard.
- **`thoughtSignature`: measured, not assumed.** Same three-turn tool conversation twice against the live API, with and without the real signature reattached: identical status, both continued the tool chain. It stays dropped and the proxy stays stateless. Repeat with `scripts/codeassist-signature-probe.mts`.
- **The Rust TUI has tests and a CI job** (29 as of 2026-08-05) (`cargo test --manifest-path tui/Cargo.toml`): config path precedence, the log tail, and the screen drawn into ratatui's `TestBackend`, cramped layout included. Writing them found a real bug: `LUPIN_DIR` used to win over `LUPIN_CONFIG` here while Node has it the other way round, so with both set the TUI and the daemon read different files.
- **CI now runs on Windows too.** Development is on Windows, CI was Linux-only, and that let a platform bug reach main green for three commits. `fail-fast: false`, so one OS never hides the other.
- **npm**: version is `0.1.0-rc.1`, `npm publish --dry-run --tag next --access public` is clean (61 files, 122 kB, nothing personal). The publish itself needs `npm login` and stays the user's to run.

Still genuinely open:

- **The TUI's last mile**: a real keyboard in a real terminal. Five-point checklist in `docs/TESTING.md` §3bis, never run as of 2026-07-29.
- **The startup announcement** (`companyAnnouncements` via `--settings`) is verified as far as the argument construction; whether Claude Code renders it in the welcome box needs one real session.
- **ROADMAP backlog #15** (stolen from 9router, both M5): multi-provider OAuth PKCE beyond OpenAI (GitHub Copilot is the obvious next descriptor, the PKCE flow kind already exists), and multi-account round-robin. Not started.

## 4. Where the code lives (M6a, the newest part)

```
src/core/responses/request.ts   Anthropic -> WHAM request  (16 tests)
src/core/responses/stream.ts    WHAM SSE -> Anthropic events (7 tests)
src/core/responses/limits.ts    proxy-side max_tokens + stop_sequences (11 tests)
src/server/responses-forward.ts the lane: moves bytes, cancels upstream on a limit (7 tests)
test/helpers/captures/wham-*.sse  three REAL captures, redacted
```

The lane is selected by `mode: "responses"` on a profile; the provider `openaisub` in the registry carries the WHAM base URL; the `openai-sub` default profile is `oauthOnly`, so the init key wizard never offers it (there is no key to paste).

## 5. Rules that cost time to learn (do not relearn them)

1. **Verify with the project's own CI commands.** `npm run lint` is `eslint .`; a scoped `npx eslint src/ test/` once passed locally and broke CI, because committed debug scripts were never checked. Run lint, typecheck and test before every push.
2. **Fixture-first is not ceremony.** Every WHAM shape in the mapper came from a live rejection: role-dependent content types, `max_output_tokens`/`temperature`/`top_p`/`stop` all unsupported, flat tools, `client_version=1.0.0`. Guessing any of them would have shipped a silent bug.
3. **The doctor earns its keep.** It found the one bug no synthetic test could: Claude Code puts hook output into `messages` as `role:"system"`, which WHAM rejects outright. The ADR-23 guard correctly refused to invent a score rather than blame the model for a protocol bug.
4. **"The provider rejects the parameter" is not "the behaviour is unobtainable."** `max_tokens` and `stop_sequences` are refused by WHAM and are still honoured, enforced inside the stream. Do not write off a capability before asking what a proxy can do that a client cannot.
5. **Debug scaffolding either meets the repo's bar or does not get committed.** Its value is usually the facts it produced, which belong in the docs.
6. **Kill test processes at the end of a run** and check the claude-mem worker still answers afterwards.

## 6. Session log, 2026-07-29 (newest first)

```
efc1736 feat(m6a): enforce max_tokens and stop_sequences proxy-side
126751d fix(m6a): stop forwarding temperature and top_p, WHAM rejects both
ef1df18 chore(m6a): drop the one-off WHAM probes that broke CI lint
bdffb09 fix(m6a): carry images through to WHAM, vision was silently dropped
6fc883a docs(m6a): milestone bar met, doctor scores 10/10
60a8bbd fix(m6a): map a system-role message to developer, WHAM rejects system
2241801 docs(m6a): the responses lane is live
88aa68c feat(m6a): wire the responses lane into the ingress
5e84685 docs(roadmap): M6a translators done, wiring next
3eaadbe feat(m6a): Responses request mapper, verified end to end
```

Earlier the same day: the PKCE flow for OpenAI and Gemini, the control API, the Rust TUI sidecar, the CLI hub (`lupin`, `lupin go`, `ls`/`st`), the recommended-skills offer in `init`, and three OAuth bugs found by the first real logins (Kimi device headers leaking to Google, the wrong Google token host, `localhost` vs `127.0.0.1`).
