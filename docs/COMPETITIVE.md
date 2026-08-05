# Competitive analysis: Lupin among the Claude Code routers

> A sweep on 2026-07-18 with 4 research agents (headroom, claude-code-router, the cluster of lightweight proxies, generic gateways). Data verified against the official repos and docs. The condensed version lives in [DESIGN.md](../DESIGN.md) (prior art) and [ROADMAP.md](ROADMAP.md) (the steal-candidate backlog); this file is the full strategic argument.

## The shape of the landscape

The space is **forking**: on one side the cloud enterprise gateways (LiteLLM 54k★, Portkey 12.5k★, Bifrost 6.6k★), on the other the claude-code-router mega-app (36k★, now Electron plus SQLite plus a UI). In between, the cluster of lightweight translate proxies **is emptying out**: y-router, CCProxy, anthropic-proxy and TensorZero are archived; Helicone is in maintenance after the Mintlify acquisition.

What stays uncovered is exactly the niche we aim at: **local-first, correctness, per-model honesty**. And headroom, despite the name showing up among "Claude Code tools", is not a competitor: it does context compression (token economy), an orthogonal problem. It lives in the same architectural slot (a local proxy on `/v1/messages`) but it is **stackable** with Lupin, not an alternative.

## What we already do better, and the white space (nobody has it)

1. **`lupin doctor`, the jewel.** None of the roughly 15 analysed projects runs a pre-flight agentic test that scores whether a model survives the Claude Code harness. Routers score cost and quality; nobody scores "it breaks under the system prompt plus tool schemas". And this is not theory: claude-code-router users open issues (#1531, #1495) asking for exactly this. Unmet demand, empty space.
2. **A public compatibility scoreboard**: nobody publishes measured provider by feature results. There is even an academic paper (RouterArena, arXiv 2510.00202) validating the concept.
3. **A centralized quirk registry**: validated by contrast, since CCR has around 850 open issues, largely "model X does not work with config Y", and every incompatibility becomes a new transformer (20+). Our flag-with-a-single-implementation is the structural inverse of their sprawl.
4. **The OAuth device flow**: everyone else uses static keys. We already shipped it (Kimi).
5. **Spec-driven correctness**: a fixture-backed SSE machine, `count_tokens` with a local estimate. A notable fact: only LiteLLM has a real `count_tokens`; every lightweight proxy omits it. Our choice was right.
6. **Runtime behavioural adapters** (M5): CCR has `enhancetool`/`tooluse` but those are static schema normalization; nobody repairs failed Edits or malformed tool calls at runtime.

## What is worth stealing (in order of value)

1. **Content-aware routing** (CCProxy plus CCR): auto-switch to a long-context model past a token threshold, plus dedicated routes for thinking, images and web search. Our slot mapping is a static big/small; this is the dynamic superset. High value, fits the scope.
2. **ReAct/XML tool-call fallback** (UniClaudeProxy): it unlocks models with no native function calling by injecting an XML schema into the prompt. Already planned as the `parseTextToolCalls` quirk, so it only needs to be raised in priority as a doctor dimension and as the first M5 adapter.
3. **Tier-equivalent failover** (Requesty/Portkey): a rate-limited provider falls back to an equivalent model in the same slot. Cross-profile delegation already exists; the automatic trigger is what is missing.
4. **Errors with scrubbed credentials** (CCProxy): remove keys, tokens and emails from the provider message before propagating it. A quick win, aligned with privacy, in `core/errors.ts`.
5. **Holdout methodology plus confidence intervals** (headroom): to make the scoring credible, as in "it holds the harness: 82% (95% CI)" instead of an arbitrary number.
6. **Round-tripping thinking blocks and the Gemini thoughtSignature** (UniClaudeProxy): translate correctness for multi-turn reasoning models.

## Deliberate noes (divergences, not gaps)

- **Semantic cache** (Bifrost/Portkey/headroom): it persists prompts and responses, against our privacy rule. Skip.
- **TLS interception** (rayline): rejected. A MITM, a security surface, a ToS grey area, and it would not even bring back Remote Control.
- **An Electron GUI, multi-tenancy, enterprise budgets** (CCR v3 / LiteLLM): out of scope, we are CLI-first and single-user.

## The strategic line

The message that comes out sharp: **do not compete on the protocol** (CCR and LiteLLM have years of advantage there) but **on honesty**. Everyone translates formats; nobody tells you, and stands behind, whether the model really holds. `doctor` plus the scoreboard plus the adapters is real white space, with demand documented in other people's issues. Steals 1 and 2 (dynamic routing, the XML fallback) reinforce the core; number 4 (scrubbing) is an immediate quick win.

The natural next step: the quick win is credential scrubbing in errors; the strategic move is starting M4 (`doctor`), the real moat.

---

# Sweep 2026-07-19: CCR issue mining, the native-endpoint threat, user sentiment

> 3 research agents (a CCR deep dive over 382 real issues through the gh api; a complete map of the alternatives; sentiment from Reddit, HN and GitHub). It confirms the line of 07-18 and adds three new facts that change priorities.

## New fact 1: translate mode is being commoditized from below

Ollama (>=0.14, January 2026) and LM Studio (>=0.4.1) expose a **native Anthropic Messages API** on `/v1/messages` (verified live 2026-07-19, ADR-21). OpenRouter has the official Claude Code integration (the "Anthropic skin") that **caused y-router to be archived** (11 January 2026, its README points at OpenRouter). Kimi, DeepSeek, Z.AI and MiniMax have official Anthropic endpoints. The translate perimeter that is really necessary shrinks to: **OpenAI, Gemini, Azure, raw vLLM/llama.cpp**. Consequence for Lupin: passthrough-first on local runtimes too (done, ADR-21); the value moves from the protocol to the orchestration (doctor, failover, routing, the quirk matrix), which confirms "do not compete on the protocol".

## New fact 2: CCR is collapsing under its own scope (the numbers)

A sample of 382 issues (October 2025 to July 2026): **around 15% closed** (30% lifetime, and getting worse), **39% of the open ones with zero comments**, **0 labels out of 382** (no triage), 1 external PR merged out of 4, and issue #7 open for 14 months. Themes by frequency: routing and subagents 13%, provider 4xx/5xx errors 11%, cross-provider reasoning and thinking 5.5%, config 5.8%, Gemini 5.2%, GLM 4.5%. The dominant class is **systemic in the translation core** (reasoning, thought_signature, streaming usage, tool calls), re-fixed provider by provider, which is exactly the anti-pattern our quirk registry prevents. In the v3 "control plane" pivot (Electron, SQLite, Weixin/Slack/Discord relay bots, browser automation, PNG dashboards) the UI produced a **real secret leak**: the editor resolves `${ENV_VAR}` placeholders and writes the keys in clear text into the config on save (#1373, #1197); plus OOM crashes from analytics queries (#1534). The documentation is felt to be inadequate by Chinese users too (#1465, #1559). Users are asking to be able to *turn the UI off* (#1192, #1173).

## New fact 3: what users actually want (sentiment)

Motivations in order: cost and quota (dominant), the 5-hour limits, avoiding lock-in, company constraints, privacy and local models, access from China. The dominant pattern is a **hybrid "economic overflow"**: Claude for the hard 10% plus GLM or Kimi for the rest, around $30 per month in total; not an outright replacement. Pain points: broken tool calling with non-Claude models (first), silent corruption of tool calls while streaming ("worse than a crash: it undermines trust"), breakage on every update, two-level config, debugging across three layers, keys in clear text. Orphan requests (Anthropic closed BYOK as "invalid" and self-hosted as "not planned"): automatic multi-provider failover, a **benchmark answering "does this model hold Claude Code?"** (that is the doctor, an explicit and never-served demand), a statusline with the real model, an OS keychain. Windows is a second-class citizen everywhere.

## The resulting priority updates

1. **The doctor is promoted to an onboarding feature**, not a debugging command: the most cited failure is "traffic that silently goes back to Anthropic and bills you", so routing truth is our central claim (the statusline is already shipped, the doctor v0 is already shipped: communicate them as a pair).
2. **A dated public quirk and compatibility matrix** (README or Pages): nobody maintains one, and it is the documentary moat no fork copies for free.
3. **The "economic overflow" profile as a first-class preset** at init (Claude directly for the hard 10% is out of ADR-18 scope, but the slots plus routes plus contextWindows combination that serves the pattern is not).
4. **A Windows beachhead**: we already dogfood natively; the OS keychain (Credential Manager) rises in value.
5. **Scope discipline as a selling argument**: against CCR's "control plane" pivot, staying a pure proxy with a CLI-first posture is differentiation, not renunciation.

---

# Full insights: a reasoned archive (sweeps 2026-07-18 and 2026-07-19)

This section keeps the detail behind the decisions taken: a conclusion without its evidence is not verifiable and does not survive the first doubt.

## A. claude-code-router: the exact numbers

Sample: 382 non-PR issues through `gh api repos/musistudio/claude-code-router/issues?state=all` (6 pages), covering October 2025 to July 2026. Repo: 35,901 stars, 2,970 forks, created February 2025.

**Project health**, and these numbers are the real message:

| Metric | Value |
|---|---|
| Open / closed issues (lifetime) | 853 / 369 (around 30%) |
| Closed in the recent sample | 57 / 382 (around 15%, getting worse) |
| Open issues with zero comments | 128 / 325 (39%) |
| Labels applied in the sample | **0 out of 382** (9 labels defined, never used) |
| PRs merged / closed in total | 47 / 187 (one in four) |
| Oldest open issue with no answer | #7, 1 May 2025 (over 14 months) |
| Release cadence | almost daily (v3.0.12 to v3.0.14 in 3 days) |

Reading: hyperactive development driven by the maintainer, with a community backlog growing faster than it is drained. It is not abandonment, it is saturation.

**Complaint themes by frequency** (themes overlap):

| # | Theme | Occurrences | Example issues |
|---|---|---|---|
| 1 | Routing / subagents | 50 (13%) | #1564 the subagent marker is read only from `body.system[]` while Claude Code sends it in `body.messages[]`; #1535; #1513; #1321 an init race; #1259 |
| 2 | 4xx/5xx errors from providers | 41 (11%) | #1329 `content:""` with tool_calls gives a 400 on Bedrock; #1427 `input_text` instead of `text` gives a 400 on vLLM; #1378 DeepSeek plus thinking plus tools gives a 400 with no workaround; #1458 the `reasoning` field is unsupported by Groq |
| 3 | Incompatible reasoning/thinking | 21 (5.5%) | #1410 the transformer always emits `reasoning` and breaks Kimi on NIM and Qwen3-Coder; **#1397 streaming the reasoning corrupts the tool-call argument deltas**; #1202 token counts 30 to 60% low; #1041 |
| 4 | Confusing config | 22 (5.8%) | **#1373 the UI rewrites env var references with the keys in clear text**; #1197 the same bug in the JSON editor; #1137 `ccr code` does not pass the config to the subprocess |
| 5 | Gemini | 20 (5.2%) | #1431 a missing `thought_signature`; #1315 a missing `?alt=sse`; #1255 double billing |
| 6 | GLM / Zhipu | 17 (4.5%) | #1474 schemas with anyOf/$ref need flattening; #981 an infinite loop; #971 inverted ports in the templates |
| 7 | UI / web | 16 (4.2%) | #1534 a server OOM from analytics queries; #1203 UI and CLI diverging; #1484 |
| 8 | Auth / credentials | 16 (4.2%) | #1562 a plugin injects `Bearer public` overwriting the key; #1003 a 401 on Windows |
| 9-10 | OpenAI / OpenRouter | 15 + 15 | #1066 duplicate tool names; #1159 HTML instead of JSON |
| 14 | Broken streaming | 9 (2.4%) | #1422 usage at zero because the final chunk is not handled; #1506 a crash on abort |
| 15 | Local providers | 8 (2.1%) | #1379 provider `undefined` with Ollama; #1046 "does not support thinking" |

**The reading that matters**: the first three categories, over 29% of the total, are the same structural defect, the translation core re-fixed provider by provider instead of once. It is the anti-pattern our quirk registry prevents by construction, and the reason `core/dialect.ts` is a single engine shared by both paths.

**The credential leak** (#1373, #1197) deserves its own line: it is not a third-party bug, it is their UI resolving `${ENV_VAR}` placeholders and writing the keys in clear text into the config file on save. A tool that promises centralized key management and exposes them from its own save flow.

## B. The complete landscape, and what is dying

| Tool | Stars | State |
|---|---|---|
| LiteLLM | ~54k | Active, enterprise, advanced features behind a license |
| new-api (a one-api fork) | ~38.7k | Active; the original one-api has been still since February 2025 |
| claude-code-router | ~35.9k | Hyperactive but saturated (see above) |
| Portkey Gateway | ~12.5k | Active, open-core with a strong upsell push |
| 1rgs/claude-code-proxy | 3.7k | Low maintenance, an ecosystem of forks |
| fuergaosi233/claude-code-proxy | 2.7k | Active, zero tagged releases |
| **y-router** | 381 | **ARCHIVED on 11 January 2026**: the README points at OpenRouter |

The y-router case is the most important lesson in the landscape: a dedicated translation tool made obsolete in a few months by the official integration of the upstream provider.

## C. Market gaps: what nobody does

1. **No public, dated quirk or compatibility registry.** Everyone treats quirks as ad-hoc fixes inside issues; nobody maintains a verified matrix with dates.
2. **No credible privacy story.** Enterprise gateways log bodies by construction (that is their product); lightweight proxies keep keys in a plaintext `.env`. The two extremes leave the same segment uncovered.
3. **No sharp passthrough/translate separation.** Almost everyone applies the same code path even to providers that have a native endpoint, paying avoidable translation bugs.
4. **Windows is a second-class citizen everywhere.** ccproxy requires a rootless WireGuard namespace (with an open, unresolved Windows issue), and the others assume bash, Docker or WSL.
5. **No evidence-based doctor.** The most cited failure is "traffic silently goes back to Anthropic and bills you": nobody gives the user a way to *verify* that the routing is real.

## D. User sentiment: why they switch models and why they quit

**Motivations, in order**: cost and unexpected bills (dominant); the 5-hour limits; avoiding lock-in; company constraints (Azure credit already spent); privacy and local models; geographic access from China; technical curiosity.

**Pain points, in order**: broken tool calling with non-Claude models; **silent corruption of tool calls while streaming**, cited as worse than a crash because it undermines trust in the result; breakage on every update; two-level config; debugging across three layers (Claude Code, the proxy, the provider); keys in clear text; the slowness of local models; provider instability after hype launches.

**What makes people quit a tool**: recurring breakage on every update; silent bugs being worse than crashes; a debugging overhead that cancels the cost saving; security concerns on shared machines; speed that is unacceptable for interactive work.

**Explicit requests never served**: Anthropic closed BYOK as "invalid" (#68840) and self-hosted as "not planned" (#7178):

| Request | State elsewhere |
|---|---|
| Automatic multi-provider failover | Only in third-party solutions, never native |
| **A benchmark answering "does this model hold Claude Code?"** | Does not exist in a standard form |
| A statusline with the model really in use | Only CCR, since v1.0.40 |
| Hot cross-provider switching that keeps the context | Partial |
| Secure credential storage (an OS keychain) | Requested in #68840, not implemented by the main routers |

**The real economic pattern**: not replacement but a hybrid. Claude for the hard 10% plus a GLM or Kimi plan for the daily 80 to 90%, at around $30 per month in total. It is the direct reason for the economy preset at `init`.

## E. What we did as a result (traceability)

| Insight | Implemented response |
|---|---|
| Translation core bugs re-fixed provider by provider | A single dialect engine, with the streaming == non-streaming invariant (ADR-22) |
| Silent corruption of tool calls while streaming | Marker hold-back plus a character-by-character test |
| Lost or dropped reasoning | `reasoning_content` becomes a `thinking` block |
| "Does this model hold Claude Code?" | `lupin doctor` plus the `tools` capability read at init on local runtimes |
| Traffic silently going back to Anthropic | A statusline with the routing truth plus the `dialect` field in the logs |
| Keys in clear text | The keychain or a 600 file, never in the config (rule 7) |
| The hybrid economic pattern | The economy preset at `init` (slots plus routes) |
| Native endpoints making translate obsolete | Passthrough-first on local runtimes too (ADR-21) |
| Complexity suffocating CCR | Disciplined scope: no Electron UI, no relay bots, no dashboards |
| "Worse than a crash: it undermines trust" (sentiment §D) applied **to the tool itself** | Session 2026-07-19: the doctor gave 1/10 to sessions that never reached the model, the `cache_control` probe called a timeout a "refusal", and a failed stream logged 200 OK. Three silent lies inside the tool that sells honesty. Fixed with explicit state verdicts (`notRun`, `inconclusive`, `streamError`) and ADR-23/24 |
| "Windows a second-class citizen" (sentiment §D) | Two Windows-only bugs fixed live: `child.kill()` does not kill the tree with `shell:true` (orphans holding the workspace), and the resulting EBUSY crashed the report. It is ground the competitors do not look at |
| Fragile local providers (CCR #1379) | A measured context floor (46075 tokens) enforced at `init` and in `doctor`; prefix stability pinned in passthrough, which is what local KV cache reuse depends on |
