# TUI Model Mapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catalogue-assisted model mapping from the TUI: quick-model gesture, assisted slot editor, full agents parity with an offered wire step.

**Architecture:** The daemon grows a provider-catalogue capability (registry flag + fetch/cache module + one control endpoint) and two control extensions (slots contextWindows, agents/wire). The Rust TUI grows one reusable assisted-input widget and three flows built on it (quick-model `t`, slots `m`, agents `a`), all through the existing control API. Single-writer rule untouched: the TUI never writes files.

**Tech Stack:** TypeScript strict + vitest (server), Rust ratatui/crossterm (TUI, TestBackend tests).

**Spec:** `docs/superpowers/specs/2026-08-13-tui-model-mapping-design.md`

## Global Constraints

- Everything in English, no em-dashes (CLAUDE.md rule 8).
- No model names in sources (rule 5): catalogue data is fetched, fixture files are recorded data.
- No `if (provider === x)` outside the registry (rule 4): the capability is `catalogApi` on `ProviderDef`.
- The catalogue informs, never gates: no write is ever blocked on it (ADR-42).
- Verify with `npm run lint`, `npm run typecheck`, `npm run test`, and `cargo test` in `tui/` before every push.

---

### Task 1: Catalog module + registry field

**Files:**
- Modify: `src/providers/registry.ts` (add `catalogApi?: { url: string }` to `ProviderDef`; add it to the `openrouter` entry with `https://openrouter.ai/api/v1/models`, verified 2026-08-13)
- Create: `src/providers/catalog.ts`
- Create: `test/catalog.test.ts`
- Create: `test/fixtures/catalog/openrouter-models.json` (recorded from the live API 2026-08-13, truncated to a handful of rows)

**Interfaces:**
- Produces:
  - `interface CatalogModel { id: string; name?: string; contextWindow?: number; supportsTools?: boolean; promptPrice?: number; completionPrice?: number }`
  - `type CatalogResult = { ok: true; models: CatalogModel[] } | { ok: false; error: string }`
  - `async function fetchCatalog(def: ProviderDef, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number; now?: number }): Promise<CatalogResult>` with a module-level per-provider cache, TTL 10 minutes (`now` is the test seam).
  - `function clearCatalogCache(): void` (test seam).
- Normalization from the OpenRouter shape: `data[].id` (string, required), `name`, `context_length` -> `contextWindow`, `supported_parameters` contains `"tools"` -> `supportsTools`, `pricing.prompt`/`pricing.completion` (numeric strings, USD per token) -> `promptPrice`/`completionPrice` via `Number(...)`, dropped when not finite. Rows without a string id are dropped. No credential header is ever sent.

- [ ] Write `test/catalog.test.ts`: normalization from the fixture (ids, window, tools flag, prices as numbers), missing-field tolerance, cache hit within TTL (fetch called once), cache expiry after TTL, unreachable fetch -> `{ ok: false }`, provider without `catalogApi` -> `{ ok: false }`.
- [ ] Run: `npx vitest run test/catalog.test.ts` -> FAIL (module missing).
- [ ] Implement `src/providers/catalog.ts` + registry change.
- [ ] Run: `npx vitest run test/catalog.test.ts` -> PASS.
- [ ] Commit: `feat(providers): catalogApi capability and the OpenRouter catalogue fetch`

### Task 2: discover-catalog endpoint

**Files:**
- Modify: `src/server/control.ts` (new route after `discover-local`)
- Modify: `test/control.test.ts` (extend the `appWithControl()` harness)

**Interfaces:**
- Consumes: `fetchCatalog` from Task 1; `ControlDeps` gains `fetchCatalog?: typeof fetchCatalog` as the test seam (same pattern as `fetchLocal`).
- Produces: `POST /v1/lupin/discover-catalog { providerId }` -> 200 `{ ok: true, models: CatalogModel[] }`; 400 malformed body; 404 unknown provider or no `catalogApi`; 502 `{ ok: false, error }` fetch failure; 401 without token.

- [ ] Tests first in `test/control.test.ts` (mocked seam): 200 happy path, 404 for a provider without catalogApi, 502 on failure, 401 unauthenticated.
- [ ] Run -> FAIL, implement the route, run -> PASS.
- [ ] Commit: `feat(control): discover-catalog endpoint`

### Task 3: slots contextWindows extension

**Files:**
- Modify: `src/server/control.ts:322-357` (`/v1/lupin/slots`)
- Modify: `test/control.test.ts`

**Interfaces:**
- Produces: body gains optional `contextWindows: Record<string, number>`; entries must be finite positive numbers (else 400); merged into `profile.contextWindows` (spread over the existing map) in the same `saveConfig` write. Response unchanged.

- [ ] Tests: merge happy path (existing windows preserved), invalid number -> 400 and nothing written, contextWindows alone without any slot still 400 (`name at least one slot to aim` rule stays).
- [ ] Run -> FAIL, implement, run -> PASS.
- [ ] Commit: `feat(control): slots write can carry the model's context window`

### Task 4: wire refactor + /agents/wire endpoint

**Files:**
- Modify: `src/cli/agents.ts` (refactor `wireAgentFile` into a pure exported `wireAgent(name, value): WireResult` that returns structured data; the CLI keeps its exact printed lines by rendering the result)
- Modify: `src/server/control.ts` (new route)
- Modify: `test/control.test.ts`, `test/agents-wire.test.ts` (existing wire tests keep passing)

**Interfaces:**
- Produces:
  - `type WireResult = { ok: true; file: string; previous?: string; value: string } | { ok: false; error: string; hint: string }` where `hint` is the `model: <value>` line to paste by hand.
  - `POST /v1/lupin/agents/wire { name, unset? }`: value is `agentRouteId(name)` or `inherit` when `unset: true`; validates `AGENT_NAME_RE` (400); 404 when no agent file is found (error carries the searched dirs); 422 when the file has no frontmatter block; 200 `{ ok: true, file, previous?, value }`.
- Consumes: `findAgentFile`, `wireFrontmatterModel`, `agentRouteId` (all existing exports).

- [ ] Tests: temp-dir agent file wired (previous captured, other bytes identical), unset writes `inherit`, missing file 404, frontmatterless file 422, bad name 400. CLI behaviour tests unchanged and green.
- [ ] Run -> FAIL, implement, run full suite -> PASS.
- [ ] Commit: `feat(control): the ADR-48 wire gesture over the control API`

### Task 5: TUI bracketed paste + assisted input widget

**Files:**
- Modify: `tui/src/main.rs` (terminal setup/teardown: `EnableBracketedPaste`/`DisableBracketedPaste`; handle `Event::Paste` in every text-input mode)
- Create: `tui/src/model_input.rs` (widget state + filtering)
- Modify: `tui/src/ui.rs` (render helper for the widget: input line + filtered rows with context/tools/price columns + advisory line)
- Modify: `tui/src/api.rs` (`discover_catalog(provider_id) -> Result<Vec<CatalogModel>, String>` + `CatalogModel` struct mirroring the endpoint)

**Interfaces:**
- Produces (Rust):
  - `struct CatalogModel { id: String, name: Option<String>, context_window: Option<u64>, supports_tools: Option<bool>, prompt_price: Option<f64>, completion_price: Option<f64> }`
  - `struct ModelInput { text: String, catalog: Option<Vec<CatalogModel>>, cursor: usize /* index into filtered(), 0 = the typed text itself */ }`
  - `impl ModelInput`: `new(catalog: Option<Vec<CatalogModel>>) -> Self`, `type_char(&mut self, c: char)`, `backspace(&mut self)`, `paste(&mut self, s: &str)` (control chars stripped), `up/down`, `filtered(&self) -> Vec<&CatalogModel>` (case-insensitive substring on id and name, capped at 8 rows), `accept(&self) -> String` (highlighted row's id, or the typed text when the cursor sits on the text row), `advisory(&self) -> Option<String>` (Some when a catalogue is loaded and the accepted text is not in it).
- Filtering is pure and unit-tested; rendering goes through TestBackend.

- [ ] Unit tests in `model_input.rs`: filter narrows by substring on id and name, cap at 8, accept returns typed text with no selection, accept returns row id when selected, paste appends atomically and strips `\n`, advisory Some/None.
- [ ] `cargo test` -> FAIL, implement, `cargo test` -> PASS.
- [ ] Wire `EnableBracketedPaste` into the same `execute!` calls as the existing alternate-screen setup, `Disable` in the teardown (and the panic hook path if one exists).
- [ ] Commit: `feat(tui): bracketed paste and the assisted model input`

### Task 6: quick-model overlay (`t`)

**Files:**
- Modify: `tui/src/main.rs` (new mode struct `QuickModel { input: ModelInput, exclude: [bool; 3], profile: String }`, key dispatch before slots mode; on entry, spawn the catalogue fetch through the existing job/refresh pattern or fetch inline with the 20s reqwest client and a loading frame)
- Modify: `tui/src/ui.rs` (render: profile name, three slot lines with include/exclude markers and current values, the widget below)

**Interfaces:**
- Consumes: `ModelInput`, `api::discover_catalog`, `api::set_slots` (extended: `set_slots(profile, aims: &[(SlotName, &str)], context_windows: Option<(&str, u64)>)` sends the Task 3 body).
- Behaviour: `t` on the selected profile opens the overlay; `o`/`s`/`h` toggle exclusion; Enter applies the accepted id to every included slot via one `POST /v1/lupin/slots`; when the id came from a catalogue row with a window, the same body carries `contextWindows: { id: window }`; the status line narrates `slot: old -> new` per changed slot plus the advisory when off-catalogue; Esc cancels. Catalogue fetch failure = plain input plus one status note, never an error state.

- [ ] TestBackend test: overlay renders profile, markers, widget rows; toggle flips a marker; Enter with all slots included produces the expected api call shape (through a recorded-call test double if the suite has one, else assert on the built request body via a pure helper `quick_model_body()` extracted for the purpose).
- [ ] `cargo test` -> PASS.
- [ ] Commit: `feat(tui): quick-model gesture aims a pasted id at the whole profile`

### Task 7: slots editor `m` assisted

**Files:**
- Modify: `tui/src/main.rs` (`handle_slots_key`, `slots_edit_for`: each field's editing goes through a `ModelInput` seeded with the same catalogue; field navigation unchanged)
- Modify: `tui/src/ui.rs` (`render_slots`: the focused field renders the widget's filtered rows under it; caption gains the advisory language, keeps the never-checked sentence)

**Interfaces:**
- Consumes: `ModelInput`, catalogue fetched once on entering the mode (shared with Task 6's fetch path, cached daemon-side anyway).

- [ ] TestBackend test: focused field shows filtered rows while typing; accept fills the field; apply sends only changed non-empty fields exactly as before (existing tests keep passing).
- [ ] `cargo test` -> PASS.
- [ ] Commit: `feat(tui): the slot editor searches the catalogue while you type`

### Task 8: agents parity + wire offer

**Files:**
- Modify: `tui/src/main.rs` (agents mode: `n` opens a name prompt validated against the `AGENT_NAME_RE` charset client-side; `m` on a row opens `ModelInput` for a model target; new-row targets land in the table draft; after a successful apply that SET a named non-`subagents` route, push the wire offer state `WireOffer { name, file_hint }`)
- Modify: `tui/src/ui.rs` (agents overlay: new keys in the footer, name prompt, model widget, wire prompt rendering: file, old -> new, `y/n`, default no)
- Modify: `tui/src/api.rs` (`wire_agent(name, unset) -> Result<WireOutcome, String>` where `WireOutcome { file: String, previous: Option<String>, value: String }`)

**Interfaces:**
- Consumes: `POST /v1/lupin/agents` (unchanged), `POST /v1/lupin/agents/wire` (Task 4), `ModelInput` (Task 5).
- Behaviour: `n` -> name prompt -> on Enter the row appears selected with no target; digits/`m` assign the target; Enter applies the whole table as today; wire offer only for named routes whose target was set in this apply; `y` calls `wire_agent`, outcome narrated in the status line; `n`/Esc declines and prints the id to paste. Declined or failed wire never blocks: the route is already saved (same contract as the CLI).

- [ ] TestBackend tests: `n` prompt renders and rejects an invalid charset name; a created row with a model target survives into the applied table body; wire prompt renders file and default-no; decline path shows the paste-by-hand id.
- [ ] `cargo test` -> PASS.
- [ ] Commit: `feat(tui): agents mode reaches parity, wire offered with an explicit yes`

### Task 9: spec + docs + ADR-52

**Files:**
- Modify: `docs/SPEC-PROVIDERS.md` (§2 registry: `catalogApi`; discovery section: `discover-catalog` beside `discover-local`; slots endpoint body; §4decies: TUI parity + wire endpoint)
- Modify: `docs/SPEC-CLI.md` (hub key list)
- Modify: `docs/TUI.md` (keys `t`, agents `n`/`m`, paste, catalogue behaviour and its honesty language)
- Modify: `docs/DECISIONS.md` (ADR-52: live catalogue capability, TUI agents parity, wire via control API amending ADR-48; rejected alternatives: blocking validation, per-provider code paths, TUI-side file writes)
- Modify: `CHANGELOG.md` (unreleased entries)

- [ ] Write all doc changes, re-read for em-dashes and English.
- [ ] Commit: `docs(spec): the catalogue capability, the TUI parity and ADR-52`

### Task 10: full verify + adversarial review + push

- [ ] `npm run lint && npm run typecheck && npm run test` green.
- [ ] `cd tui && cargo test && cargo build --release` green (build proves the binary still links).
- [ ] Adversarial review workflow over `git diff main-start..HEAD` (multi-agent: correctness, TUI state-machine regressions, spec drift); fix every confirmed finding, re-verify.
- [ ] Push. No version bump (release cuts are the user's call).
