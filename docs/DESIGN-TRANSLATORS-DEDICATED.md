# DESIGN: dedicated translators for the OAuth subscription endpoints (Responses API, Code Assist API)

> Session 2026-07-29. Born from the first REAL OAuth logins against OpenAI and Google. The PKCE login works for both (the token is granted), but the token spends on a **dedicated endpoint with a proprietary protocol**, not on the public OpenAI-compatible API Lupin already translates (M2). This document captures the verified facts and scopes the translator project the user approved. Implementation is a dedicated milestone, not this session.

## 1. The discovery (verified live 2026-07-29)

| | OpenAI (ChatGPT) | Google (gemini-cli) |
|---|---|---|
| PKCE login | ✅ token granted | ✅ token granted (after fixing the token host and the redirect host, commits `6147db5`, `ebfde89`) |
| Public API verify | ❌ `api.openai.com/v1/models` → 403 `api.model.read` | ❌ `generativelanguage.googleapis.com/v1beta/models` → 403 `insufficient authentication scopes` |
| Where the token spends | `https://chatgpt.com/backend-api/wham` | `https://cloudcode-pa.googleapis.com/v1internal` |
| Protocol | OpenAI **Responses API** (with WHAM quirks) | Google **Code Assist API** (a wrapper over generateContent) |
| Lupin today | translate speaks **Chat Completions** | translate speaks **generativelanguage OpenAI-compat** |

The OAuth login itself is correct and stays: it is the credential source (ADR-17). What is missing is the protocol lane to spend those credentials. The verify-before-save guard (ADR-19) did its job both times: no unusable token was persisted.

## 2. The two target protocols (verified facts)

### 2.1 OpenAI Responses API over WHAM (source: 7shi/codex-oauth, PLUS live captures 2026-07-29)

- Base `https://chatgpt.com/backend-api/wham`, stateless: the FULL conversation history goes in the `input` array on every request.
- Quirks: content type must be `input_text` (`text` is rejected); `store=false` mandatory; `instructions` (the system prompt) required. Prompt caching wants a UUID v7 as both `prompt_cache_key` and the `session_id` header.
- `/models` is non-standard: key `models` (not `data`), identifier `slug` (not `id`), a `client_version` query param required, plus `base_instructions`/`model_messages` (server-managed system prompts).
- Streaming via SSE (the Responses API event stream).

**Verified live 2026-07-29 with a real ChatGPT account (fixtures in `test/helpers/captures/wham-*.sse`):**
- `/models` returns `{"models":[]}` for `client_version` `0.1.0`/`0.20.0`/`0.34.0`/`0.55.0`, and the real list only at `client_version=1.0.0`: slugs `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`. The OAuth verifyUrl must use `client_version=1.0.0`.
- **`stream: true` is MANDATORY**: a non-streaming request is rejected with `{"detail":"Stream must be set to true"}`. There is no non-streaming mode; the translator must always read the SSE and recompose for a non-streaming Anthropic caller.
- Model gating is per-account: `gpt-5`, `gpt-5-codex`, `gpt-5.1*` are rejected ("not supported when using Codex with a ChatGPT account"); the served slugs above work.
- **Event grammar (captured)**: `response.created` -> `response.in_progress` -> `response.output_item.added` -> `response.content_part.added` -> `response.output_text.delta`* -> `response.output_text.done` -> `response.content_part.done` -> `response.output_item.done` -> `response.completed`. A tool call replaces the text events with `response.output_item.added` (`item.type:"function_call"`, `call_id`, `name`) -> `response.function_call_arguments.delta`* -> `response.function_call_arguments.done` -> `response.output_item.done`. `usage` arrives on `response.completed`.
- **Request shape (verified while building the mapper, each one a rejection WHAM taught us):**
  - The message content type is **role-dependent**: `input_text` for user, `output_text` for assistant. An assistant `input_text` is rejected: *"Supported values are: 'output_text' and 'refusal'"*.
  - **`max_output_tokens` is unsupported**: `{"detail":"Unsupported parameter: max_output_tokens"}` (the same for `temperature`, `top_p` and `stop`). Nothing of the sort is forwarded; `max_tokens` and `stop_sequences` are instead enforced proxy-side inside the stream (§2.1bis).
  - Tools are **flat**: `{type:'function', name, description, parameters}`, not nested under `function` as in Chat Completions.
  - The tool round trip travels as two top-level input items: `{type:'function_call', call_id, name, arguments}` and `{type:'function_call_output', call_id, output}`. Verified end to end: the model answered from the injected tool result.
- **End-to-end proof (2026-07-29)**: a full Anthropic request (system + tool_use + tool_result + tools) built by `core/responses/request.ts`, accepted by live WHAM (200), decoded by `core/responses/stream.ts` into Anthropic events, yielding `"Rome: clear skies, 21C."` with `stop_reason: end_turn` and usage `{input:110, output:13}`.
- **A `role:"system"` message is rejected**: `{"detail":"System messages are not allowed"}`. This matters because **Claude Code puts hook output into the `messages` array with that role**, so any session with a SessionStart hook dies before reaching the model. `developer` is accepted and is the Responses API's channel for system-level guidance, so that is what the mapper emits for any non user/assistant role. Found by `lupin doctor`, not by any synthetic test.
- **Harness verdict (2026-07-29)**: `lupin doctor openai-sub` = **10/10**, all six checks green over a real headless session (118s, 16 requests). Cache receipt: 667k tokens read from cache, 45% of the served input.

### 2.1bis M6a compatibility: what is verified, and what the lane cannot do

Verified against the live API, not assumed:

| Works | Evidence |
|---|---|
| Text, streaming and non-streaming | doctor + e2e |
| Tool calls, single and **parallel** | two blocks decoded with the right indices and arguments |
| Tool result round trip | the model answers from the injected result |
| System prompt into `instructions` | e2e |
| Hook output (`role:"system"`) rewritten to `developer` | the bug the doctor caught |
| Images / vision (`input_image`, data URL) | a generated red PNG comes back "Red" |
| `tool_choice`: auto, required, none, named | all four accepted |
| Slot mapping, usage, prompt caching | doctor: 667k cached, 45% |
| A real Claude Code session | doctor 10/10 |
| **`max_tokens`**, enforced proxy-side | live: a 5-token budget cuts "1, 2," with `stop_reason: max_tokens` |
| **`stop_sequences`**, enforced proxy-side | live: `["5"]` yields "1,2,3,4," with `stop_reason: stop_sequence`, `stop_sequence: "5"` |

**"The provider rejects the parameter" is not "the behaviour is unobtainable."** WHAM refuses `max_tokens` and `stop` as request parameters, but a proxy sits *inside* the stream and can enforce them itself, which is the one thing a gateway can do that a plain client cannot. `core/responses/limits.ts` does exactly that, and the forwarder cancels the upstream read once a limit fires so the provider stops generating tokens nobody will see. Two details make it honest rather than approximate:

- **The cut is exact.** o200k_base counts WHAM's own text to the token: measured over three live responses, ours 43/87/19 against reported 47/91/23, a CONSTANT offset of 4, which is the per-message framing (the same `PER_MESSAGE_OVERHEAD` `core/tokens.ts` already knew about). Not a drift, an offset.
- **A stop sequence split across deltas is still caught**, through the hold-back rule the dialect engine already lives by (ADR-22): the tail that could still become a sequence is never emitted until it is ruled out.
- **Tool-call arguments are deliberately neither counted nor truncated**: half a JSON object is a broken tool call, which is worse than a slightly long answer.

Real limits that remain, each one a live rejection rather than a guess:

1. **`temperature` and `top_p` have no effect.** WHAM answers `{"detail":"Unsupported parameter: X}` and fails the WHOLE request, so they are dropped. Unlike length and stop sequences, sampling cannot be reproduced from outside the model. Claude Code does not send them, which is why the doctor passed, but a client that did would otherwise have broken every call.
2. **`thinking` blocks are dropped deliberately**: WHAM has no channel for Anthropic's reasoning record, and replaying it as prompt text would leak private reasoning into the prompt.
3. **`count_tokens` is a local estimate**, not WHAM's own count (the §7b strategy translate already uses).
4. **Mid-stream failures are handled, pinned by tests, but never observed live**: `response.failed` is mapped, and since 2026-07-29 three tests hold the branch (one error event, the stream closed to everything after it, and no `message_stop` so a truncated answer can never read as complete). The frame they feed is synthetic: no live occurrence has ever been seen, and that part cannot be forced.
5. **One account, two models.** Model availability is per-account: `gpt-5`, `gpt-5-codex` and `gpt-5.1*` are refused ("not supported when using Codex with a ChatGPT account"); the served slugs were `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4-mini`, `codex-auto-review`.
6. **`top_k` is not mapped** (the Responses API has no equivalent).

### 2.2 Google Code Assist API (source: gemini-cli `code_assist/server.ts`)

- Base `https://cloudcode-pa.googleapis.com`, version path `v1internal`, methods as `:method` suffixes: `:generateContent`, `:streamGenerateContent`, `:countTokens`, plus `:loadCodeAssist` and `:onboardUser` (project onboarding).
- It is a **wrapper over generateContent**, not the public schema: requests are converted with `toGenerateContentRequest(req, userPromptId, projectId, sessionId, ...)`, responses back with `fromGenerateContentResponse`. Extra fields: `userPromptId`, `projectId`, `sessionId`, `enabledCreditTypes`.
- Streaming via SSE with `alt=sse`, parsed line by line on `data: `.
- Needs a **project id** and an onboarding step (`loadCodeAssist`/`onboardUser`) the public API does not have.

#### 2.2bis What the live account actually answered (probed 2026-07-29)

Every line here is a real response from `cloudcode-pa.googleapis.com`, not a reading of the CLI source.

- **The project id question is answered, and the answer is "it depends on the account state".** `:loadCodeAssist` returns `cloudaicompanionProject` only for an account that has already been onboarded. Probed on two accounts: the onboarded one answered `currentTier: free-tier` plus the project id; the never-onboarded one answered no `currentTier` and no project at all, only `allowedTiers`. So `:onboardUser` (a long-running operation, polled to `done`) is a **first-login-only** step, and the id it mints is then discoverable forever after. The user supplies a project only on `standard-tier`, the one tier flagged `userDefinedCloudaicompanionProject: true`.
- **The request envelope is confirmed live**: `{model, project, user_prompt_id, request:{contents, systemInstruction?, tools?, session_id}}` answers 200 on `:generateContent`. Outer keys snake_case, inner ones camelCase, exactly as the converter said.
- **The SSE frame** is `data: {"response": <GenerateContentResponse>, "traceId": "...", "metadata": {...}}`: the payload is wrapped, not bare.
- **The honest UA passes.** `user-agent: lupin/0.1.0` is accepted; Code Assist does not gate on the gemini-cli identity (open question §5, now closed). No spoofing needed, which keeps ADR-18's line intact.
- **Model availability is per account, and the free tier is thin.** Live: `gemini-2.5-flash` and `gemini-3.1-flash-lite` answer 200; `gemini-3.1-pro-preview` and `gemini-2.5-pro` answer **429 RESOURCE_EXHAUSTED** ("you have exhausted your capacity on this model"); `gemini-3.5-flash` answers **404** (the CLI's own constant calls it mutable, resolved "based on backend access"). The rate limit is tight enough that two calls in a row can 429, so anything that captures or tests must back off.
- **Parts can carry a `thoughtSignature`** next to `text` or next to `functionCall` (seen live on both `gemini-3.1-flash-lite` and `gemini-2.5-flash`, the latter whenever tools are in play). It is an opaque blob with no Anthropic equivalent, and must not be replayed as prompt text (same reasoning as the `thinking` drop in §2.1). **MEASURED 2026-07-29, and the answer is no**: the same three-turn tool conversation was sent twice against the live API, once with the signature dropped (what Lupin does) and once with the real 328-char signature reattached to the `functionCall` part (what gemini-cli does). Identical HTTP status, and both continued the tool chain correctly with the next call. Dropping it costs nothing measurable, so it stays dropped rather than making the proxy keep state for it. Repeat with `node --import tsx scripts/codeassist-signature-probe.mts`.
- **`functionCall` has no id.** Google identifies a call by `name` only, while Anthropic requires `tool_use.id` and matches `tool_result.tool_use_id` against it. The translator therefore has to mint the ids itself and re-associate the results on the way back, by name and by position for parallel calls. This is a mapping the Chat Completions lane never needed, because OpenAI does send ids.
- **Unknown fields are a 400, everywhere, including inside tool schemas.** `{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"lupinNotARealField\" ... Cannot find field."}}`. This is why the lane reduces tool schemas with an ALLOW list rather than the shared `sanitizeJsonSchema` quirk, which is a deny list of three known offenders: correct for a provider that ignores what it does not know, wrong for one that refuses the whole request. Found by `lupin doctor`, which killed a real session on the `$schema` key Claude Code puts in its own tool definitions. The same rule forbids guessing any field name in this lane: every one of them was probed live first.
- **Privacy, and it is user-facing.** The free tier ships `privacyNotice.showNotice: true`, whose text states that Google collects prompts, related code, generated output and code edits to improve its products and models, that **human reviewers may read and annotate them**, and that disconnected copies are kept up to 18 months. Rule 7 of CLAUDE.md binds the proxy, not the provider, so this cannot be fixed in code: it has to be told to the user before they route a coding session through this lane.

## 3. Scope decision

Two NEW translators, behind the same orthogonal-axis rule as the rest (ADR-17): the credential source (OAuth) is done; these are protocol lanes, sibling to the Chat Completions translator, never `if provider ===` scattered (CLAUDE.md rule 4). Each is a `core/` mapper + SSE state machine, fixture-first from REAL captures (CLAUDE.md rule 3), exactly like M2.

**Explicitly NOT in scope**: faking the official CLIs' identity beyond the honest UA, and any Anthropic-side target (ADR-18). The API key stays the guaranteed floor for both providers (ADR-17): these translators serve the opt-in subscription path only.

## 4. Proposed milestone M6 (order follows risk)

1. **M6a, Responses API (OpenAI)**: `core/responses/` request/response/stream mappers Anthropic↔Responses, the WHAM quirks as registry flags, fixtures recorded from real WHAM output. The doctor already measures whether the result holds the harness.
2. **M6b, Code Assist API (Google)**: `core/codeassist/` mappers Anthropic↔generateContent-over-CodeAssist, the project onboarding (loadCodeAssist/onboardUser, project id), SSE. Bigger unknown (the internal schema), so second.
3. **M6c, wiring**: a `mode: 'responses' | 'codeassist'` (or a quirk-driven lane) on the profile, the OAuth verifyUrl pointed at the real endpoint, the doctor on the OAuth profile.

**Verification** (same bar as M2): the acceptance fixtures pass from real captures, and a real agentic task completes on the OAuth subscription with at least 2 MCP tools correctly called.

## 5. Open questions to resolve at M6 kickoff

- The exact Responses API tool-calling schema (function calls, their SSE events) from a real WHAM capture.
- Whether WHAM accepts an honest `lupin` UA or gates on the Codex one (the Kimi lesson: do not assume, test).
- ~~The Code Assist onboarding: is the project id discoverable automatically (loadCodeAssist) or does the user supply it.~~ **Answered live 2026-07-29, see §2.2bis**: discoverable once onboarded, minted by `:onboardUser` on the first login, user-supplied only on the paid `standard-tier`.
- Whether `base_instructions`/`model_messages` from WHAM must be forwarded or conflict with the Claude Code system prompt.
