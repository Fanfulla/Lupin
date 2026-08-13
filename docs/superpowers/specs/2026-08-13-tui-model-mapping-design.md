# TUI model mapping: catalogue-assisted slots and agent routes

Date: 2026-08-13. Status: approved (user session 2026-08-13).

## Problem

Three gaps between the TUI and the model-mapping surface the config already supports:

1. The slot editor (`m`) is a blind 3-field text box: no catalogue, no search, paste works only as an incidental burst of key events (bracketed paste never enabled).
2. OpenRouter has no assisted path at all: trying a model means knowing the exact `vendor/model` slug and typing it blind into the generic editor.
3. The agents mode (`a`) covers half the schema: it can delegate an existing route to a profile, but cannot create a new route name and cannot aim a route at a bare model id. Both require the CLI, and the wire gesture (ADR-48) is CLI-only.

## Decisions (user session 2026-08-13)

- **Live catalogue** for hosted providers that publish one, OpenRouter first. Real existence data beats no data; ADR-42 rejected *invented* validation, not information.
- **Quick-model gesture**: a new overlay applies one pasted or picked id to all three slots by default, with per-slot exclusion.
- **Full agents parity** in the TUI: new route names, model targets, delegation, unset.
- **Wire offered from the TUI** through a new control endpoint, explicit confirm, default no. Amends ADR-48 (the sanctioned frontmatter write becomes reachable from both surfaces, same bounds).
- **Autocomplete** when searching a model: type-to-filter over the fetched catalogue.

## 1. Provider catalogue (server)

- `ProviderDef` gains `catalogApi?: { url: string }` (registry data, rule 4: capability flag, never `if (provider === x)`). OpenRouter: `https://openrouter.ai/api/v1/models` (public, verified live 2026-08-13; no credential is ever sent).
- New module `src/providers/catalog.ts`: fetch, normalize, cache.
  - Normalized row: `{ id, name?, contextWindow?, supportsTools?, promptPrice?, completionPrice? }`.
  - OpenRouter mapping (response shape verified live 2026-08-13): `data[].id`, `name`, `context_length`, `supported_parameters` includes `"tools"`, `pricing.prompt`/`pricing.completion` (USD per token, strings).
  - In-memory cache per provider, TTL 10 minutes. The daemon owns the cache; the TUI stays stateless.
- New control endpoint `POST /v1/lupin/discover-catalog { providerId }`:
  - 404 for a provider whose registry entry has no `catalogApi`.
  - 502 with the fetch error when the catalogue is unreachable; the TUI degrades to plain input.
  - 200 `{ ok: true, models: [...] }` otherwise.

The catalogue **informs, never gates**: an id outside the list is still accepted everywhere (a brand-new model may not be listed yet; the catalogue may be down). ADR-42's principle stands: the write is never blocked on a check nothing local can guarantee.

## 2. Assisted model input (TUI widget)

One reusable widget wherever a model id is typed:

- Free text; typing filters the catalogue live (case-insensitive substring on id and name), matches rendered with context window, tools flag and pricing.
- Up/Down move in the filtered list, Tab/Enter accept the highlighted row, Enter with no selection keeps the typed text verbatim.
- Bracketed paste: `EnableBracketedPaste` at startup, `Event::Paste` appended atomically to the focused field. Applies to every text input in the TUI, onboarding included.
- No catalogue for the provider, or fetch failed: the widget is a plain text field, no error state, one status-line note.
- An applied id not present in a loaded catalogue: advisory note in the status line, never a refusal.

## 3. Quick-model overlay (key `t`)

On the selected profile:

- Opens the assisted input. Enter applies the id to **all three slots**; before Enter, `o`/`s`/`h` toggle individual slots off (shown as included/excluded).
- Applies via `POST /v1/lupin/slots`. The status line narrates old -> new per slot; returning is another `t`.
- When the id comes from the catalogue and carries a context window, the same call persists it (see 4).

## 4. Slots endpoint extension

`POST /v1/lupin/slots` accepts optional `contextWindows: { [model]: tokens }`, merged into the profile's `contextWindows` (positive integers, validated). Rationale: the catalogue's `context_length` is served truth the §4quater dynamic threshold and the doctor preflight can use; writing it in the same atomic call keeps one write per gesture.

## 5. Slot editor `m`

Unchanged flow, each of the three fields becomes the assisted widget.

## 6. Agents parity (key `a`)

- `n`: create a route: name input (validated against `AGENT_NAME_RE` client-side, server revalidates), then target input (assisted widget for a model id, or digit 1-9 for a profile delegation).
- `m` on a row: aim the route at a model id (assisted widget).
- `1-9` delegation and `x` unset stay as they are.
- Enter applies the whole table atomically via `POST /v1/lupin/agents` (existing endpoint, unchanged).

## 7. Wire from the TUI

- New control endpoint `POST /v1/lupin/agents/wire { name, unset? }`:
  - Reuses the CLI's find-and-edit logic (`findAgentFile` + `wireFrontmatterModel`), refactored to return structured results instead of printing.
  - Writes `model: claude-lupin-agent:<name>` (or `inherit` on unset), returns `{ ok, file, previous?, value }`; a missing file or frontmatter block returns the same honest errors the CLI prints, as data.
  - ADR-48 bounds hold: one field, every other byte preserved, old value returned.
- TUI: after applying a table that set a **named** route (not `subagents`), offer the wire step: file, old -> new, `y/n`, default **no**. Declining shows the id to paste by hand, same as the CLI.

## Out of scope

- Catalogues for other hosted providers (the registry field is ready; each needs its own verified entry).
- A dedicated undo, bulk multi-profile editing, renaming agent routes.
- Publishing agent ids in `/v1/models` (rejected in ADR-47).

## Testing

- TS (vitest): catalog normalization from a recorded OpenRouter fixture; discover-catalog (mocked fetch: ok, 502, no-catalogApi 404, cache TTL); slots contextWindows merge and validation errors; agents/wire (found, missing file, no frontmatter, unset).
- Rust: widget filtering and selection as unit tests; TestBackend renders for the quick-model overlay, the upgraded agents mode, and the wire prompt; paste event handling.

## Spec updates carried by this design

- SPEC-PROVIDERS: `catalogApi` in §2, `discover-catalog` beside `discover-local`, slots `contextWindows` extension, §4decies gains the TUI parity and the wire endpoint.
- SPEC-CLI / TUI.md: new keys (`t`, `n`, `m` in agents mode), paste behaviour.
- DECISIONS.md: ADR-52 (live catalogue capability + TUI agents parity + wire via control API, amending ADR-48).
