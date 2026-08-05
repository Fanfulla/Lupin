# TESTING: fixtures and verification levels

Working rule 3 (CLAUDE.md): every behaviour of the translation core is born from a fixture. This document defines how.

## 1. Fixture format

A fixture is one JSON file in `test/fixtures/<area>/<name>.json`:

```json
{
  "name": "tool-call-mcp-long-name",
  "spec": "SPEC-TRANSLATION §3",
  "direction": "request",            // request | response | stream | dialect
  "quirks": [],
  "input": { ... },
  "expected": { ... }
}
```

- `direction: "request"`: input is an Anthropic body, expected is an OpenAI-compat body.
- `direction: "response"`: input is a provider response body, expected is an Anthropic response body.
- `direction: "stream"`: input is an array of raw SSE chunks (strings, EXACTLY as they arrive from the provider, splits included); expected is an array of Anthropic events `{event, data}` in the exact order.
- `direction: "dialect"`: input is the raw model content, expected is the normalized content plus any synthetic `tool_use` blocks extracted from it.

The runner (vitest) loads each file and deep-equals it. A new behaviour means the fixture file first (red), then the code (green).

## 2. Where fixtures come from: record, do not invent

Response, stream and dialect fixtures must come from REAL provider output, never written by hand from memory: real dialects are stranger than you would guess. Procedure: `LUPIN_DEBUG=1` captures the raw bodies in `~/.lupin/debug/`, the interesting case is copied into `test/fixtures/`, the content is anonymized and the `expected` is written. The raw captures the fixtures rest on are versioned in `test/helpers/captures/` (for streams: a JSON array of chunks with the EXACT transport boundaries, recorded with a reader that saves every `read()` separately, since curl does not preserve them). Every fixture names in its `spec` field the spec section it covers; every new spec section needs at least one fixture (bidirectional where that makes sense).

The 10 mandatory fixtures of SPEC-TRANSLATION §10 are the minimum acceptance set for M2.

## 3. Levels

| Level | What | When it runs |
|---|---|---|
| Unit (fixture) | pure `core/`, deep-equal against fixtures | always, CI |
| Integration | the full server against a local **fake provider** (`test/helpers/fake-provider.ts`) that replays stream fixtures and simulates errors, latency and disconnections | always, CI |
| E2E | `lupin doctor` against real providers (needs an API key) | manual plus a weekly scheduled CI run |

The fake provider is essential: it lets CI exercise the cases real providers will not reproduce on demand (a 429 mid-stream, a disconnection, a split UTF-8 chunk).

## 3bis. The Rust TUI, and the one mile that stays manual

The optional sidecar (`tui/`) is tested with `cargo test --manifest-path tui/Cargo.toml`, run by the `tui` job in CI. Three things are covered without a terminal: the config path precedence (LUPIN_CONFIG over LUPIN_DIR, matching the Node side, which was WRONG here until 2026-07-29), the log tail (the same rules `test/top.test.ts` pins on the Node side), and the screen itself, drawn into ratatui's `TestBackend` buffer and read back as text.

What cannot be automated is a real keyboard in a real terminal. That is a short manual pass, and the only honest way to close it:

1. `cargo build --release --manifest-path tui/Cargo.toml`, then run `lupin` with the binary on the PATH.
2. The header must say `daemon up` with the right port, and turn red with `daemon DOWN` when the daemon is stopped.
3. The number keys 1-9 must switch the active profile, and the change must be visible in `lupin status` from another shell (the daemon writes the config; the TUI never does).
4. `q` must leave the terminal usable: no leftover raw mode, no swallowed cursor.
5. Resize the window narrow and short: nothing may panic (the cramped-layout case is pinned by a test, this confirms it on a real terminal).

Record the date of the last manual pass here when it is done. As of 2026-07-29 it has never been run.

## 4. What NOT to test

No tests for: trivial CLI wiring, formatting of human output, internal details not observable from the contract (CLAUDE.md rule 2: no speculative work). The testable contract is: body in, body or events out.
