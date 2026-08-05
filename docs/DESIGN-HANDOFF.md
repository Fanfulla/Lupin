# DESIGN: the session handoff (backlog #16, scenario B)

> Written 2026-07-31 from a 6-agent research pass (codebase, real local transcripts, the four lanes, official Claude Code docs, router prior art, community reports). Every fact below carries its source. Scenario A (a session already running through Lupin) needs nothing: `lupin use` mid-session already switches the provider with the context intact, because the context lives client-side and every request is stateless.

## 1. The scenario

The user chats in a NATIVE Claude Code session, straight to Anthropic. Usage limits hit. They want to continue the same conversation on a third-party provider through Lupin, on any configured profile, without losing anything.

Claude Code reads `ANTHROPIC_BASE_URL` at process startup only, so no in-session gesture can retarget a running native session. The handoff is therefore: exit, then relaunch through Lupin with the conversation restored by `claude --continue`. The session is technically new; the conversation is the same, byte for byte, because the transcript lives in `~/.claude/projects/` and the client replays it.

Prior art does not cover this. claude-code-router and 9router switch providers inside a running proxied session; goodboy (akhayam99/goodboy, MIT, macOS app) rebuilds a summarized context per provider, which is lossy by construction. Nobody wraps the exit-and-relaunch pattern; the transcript replay makes it lossless, and it is the one approach that keeps the user inside Claude Code.

## 2. Verified facts the design rests on (2026-07-31)

### Mechanics that already work

- `lupin go <profile> -- claude --continue` reaches the claude binary with the flag intact today, on both Windows spawn paths: `run.ts` forwards user args generically, and `--continue` has no quotes or spaces, so the ADR-29 .cmd-shim limitation does not apply (src/cli/run.ts:208-227, src/cli/go.ts:9-28).
- `claude --continue` resumes the most recent session of the current directory; the full history, tool calls included, is restored. Env vars are read fresh because the relaunch is a new process (code.claude.com/docs/en/sessions, env-vars, fetched 2026-07-31).
- Resumed sessions keep the model saved in the transcript, but with a custom `ANTHROPIC_BASE_URL` Claude Code passes any model string through unchecked, and Lupin's slot mapping resolves `claude-*` names as always (code.claude.com/docs/en/model-config).
- A real local transcript (8.9 MB) already mixes `claude-opus-5` and `k3` turns in one session file: a de facto handoff has already happened on this machine and the transcript recorded it without breaking.

### Transcript structure (inspected locally, structure only)

- Sessions are keyed by a literal transform of the absolute cwd (`\` and `:` become `-`), one `<uuid>.jsonl` per session, most recent by mtime. The handoff must run from the same directory as the native session.
- The key transform is case-sensitive: the same project reached through a differently-cased path (WSL `/mnt/c/...` vs native) resolves to a different transcript directory. The command cannot fix this; the doc states it.
- Every thinking block in native transcripts carries `{type, thinking, signature}`. Measured across the whole cwd corpus 2026-07-31: all 1422 native blocks (claude-fable-5, claude-opus-4-8, claude-opus-5) store an EMPTY thinking text next to a full opaque signature (omitted-display); non-empty thinking text appears only on k3 turns. So what a replay actually sends for native turns is the empty-thinking-plus-signature pair.
- Long sessions on this machine reach roughly seven-figure estimated prefix tokens (8.9 MB transcript, ~1M rough-proxy tokens). The first request after a handoff re-pays that prefix at a cold cache, and it may simply not fit the target model's window.

### The one load-bearing risk: replayed thinking blocks

- The passthrough lane forwards `messages` byte for byte (src/server/ingress.ts:438-443, ADR-7). A passthrough target (Kimi) receives Anthropic-signed thinking blocks verbatim. Whether Moonshot ignores, strips, or rejects them with a 400 is UNKNOWN: no official doc, no community report, no prior-art issue tests this direction. Everything public tests the opposite direction (foreign history replayed INTO Anthropic), which reliably 400s with "Invalid signature in thinking block" (CLIProxyAPI #1584/#2172, 9router #885, opencode #11546, claude-code #21726, all fetched 2026-07-31).
- The translate, responses and codeassist lanes already DROP thinking blocks from assistant history by design (src/core/request.ts:161-166, src/core/responses/request.ts:31-56, src/core/codeassist/request.ts:141-194, each with tests). On those lanes this risk does not exist.
- Anthropic's own rule for switching between two models: "strip thinking and redacted_thinking blocks from prior assistant turns"; other models silently ignore them but they still cost input tokens (platform.claude.com/docs/en/build-with-claude/thinking).
- Known Kimi endpoint limits that can also 400 a replayed history, independent of signatures: `document` content blocks are not accepted (MoonshotAI/Kimi-K2.5 #27), and Tool Search `tool_reference` blocks break the session (cc-switch #2941). K2.6-era models can also 400 on multi-turn tool history lacking `reasoning_content` (Kimi-K2 #129).

### Scope boundary

ADR-18 literally excludes "Anthropic as a target provider" and "work dedicated to Claude models through Lupin". The handoff targets a third-party profile and never routes to Anthropic; Lupin only relaunches the native `claude` binary the user already runs. Reading a transcript file's size (stat, never content) stays within the zero-takeover posture: Lupin never writes into `~/.claude` and never parses prompts.

## 3. The design, in order

### 3.1 Probe first (fixture-first, CLAUDE.md rule 3)

`scripts/handoff-replay-probe.mts`: send a minimal Anthropic-shaped history containing one REAL signed thinking block (taken from a native session, redacted) to the Kimi endpoint, twice: signature intact, and thinking stripped. Record status and answer. This empirically answers the only open question before any code. Needs the Kimi quota cycle to be live. If Kimi rejects the intact replay, the same probe run against DeepSeek or Z.AI (when keys exist) tells whether the quirk generalizes.

**Outcome, run live 2026-07-31 through the real ingress (in-process createApp, profile kimicode/passthrough, slot k3)**: quota ping 200 (the cycle renewed since 2026-07-29); variant A, a replayed native history with the signed thinking block INTACT, answered 200; variant B, thinking dropped, answered 200. The replayed block was the realistic one: the corpus measurement above shows a native replay sends empty thinking plus a full signature, and that exact pair was accepted. Kimi also mints its own signatures on its answers (its 200s carry `thinking` blocks with a `signature`), so the endpoint treats the field as opaque rather than validating provenance. Verdict: no quirk needed, §3.3 stays unbuilt.

### 3.2 `lupin resume [<profile>]`

The one-gesture handoff. Spec in SPEC-CLI §1. It is a thin composition of what exists: optional `lupin use <profile>`, then the `lupin run` path spawning `claude --continue`. Anything after `--` is appended to the claude args (so `lupin resume kimi-sub -- --resume <id>` picks a specific session; when the user supplies their own `--resume`, `--continue` is not injected).

One honest advisory, not a rewrite: before spawning, stat the most recent transcript of the cwd (size only, content never read). Past 1 MB, print one line saying the first request re-pays the full prefix at a cold cache and may exceed the target window, and that compacting BEFORE exiting the native session is the lever (the client owns `/compact`; Lupin does not compress, see 3.4).

### 3.3 If the probe shows a 400: the `stripHistoryThinking` quirk

An opt-in quirk in the registry (ADR-7: centralized flags, never scattered ifs, never on by default) that drops thinking and redacted_thinking blocks from PRIOR assistant turns in the passthrough lane, which is exactly what Anthropic prescribes for model switches. Not built until the probe proves it is needed. If the probe shows Kimi ignores foreign signatures, this section stays unbuilt.

### 3.4 Rejected: context compression in the proxy

Confirmed rejected 2026-07-31 (it was already a ROADMAP deliberate no). Three reasons: rewriting history breaks byte fidelity, and even innocent JSON re-serialization invalidates thinking signatures (CLIProxyAPI #2172); understanding content to compress it conflicts with the privacy rule (the proxy never persists or parses prompts); the client already owns compaction (`/compact`, auto-compact) and does it with full knowledge of the conversation. Headroom and similar tools live client-side and already stack with Lupin unchanged.

### 3.5 Deferred: quota-aware durable switching

Backlog #16 point (b): recognizing quota-exhausted answers and moving the active profile once, with a cooldown. Deferred until the manual gesture is solid and live-verified.

## 4. Verification bar

1. ~~The probe has run against the live Kimi endpoint and its outcome is recorded here with the date.~~ DONE 2026-07-31, see §3.1: 200 with the signed block intact, no quirk needed.
2. ~~`lupin resume` spec'd in SPEC-CLI, implemented with tests pinning: profile switch happens before spawn; `--continue` injected exactly when the user did not pass their own session flag; the advisory prints on a large transcript and stays silent on a small one; usage errors before any state change (the `lupin go` lesson, ADR-30).~~ DONE 2026-07-31: 18 tests in `test/cli-resume.test.ts`, plus two usability findings fixed the same day (a one-line warning when the cwd never recorded a session, since claude's own failure there is cryptic; flags rejected in the profile position).
3. ~~One REAL end-to-end handoff: a native Anthropic session with thinking and tool use, exit, `lupin resume <profile>`, one request answered on the new provider with the old context demonstrably present.~~ DONE 2026-07-31, twice: a native `claude -p` session (code word PERISCOPIO) in a fresh directory was resumed with `lupin resume kimi-sub -- -p "..."`; k3 (passthrough) answered the code word from the replayed native context, with the proxy log as evidence (`kimi-sub, claude-opus-5 -> k3, 200, input 44195`). A SECOND resume of the now-mixed history (native Anthropic turns plus k3 turns, each with their own signatures) answered a transformation of the word correctly ("OIPACSIREP"), so the multi-hop replay holds too.
