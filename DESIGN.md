# Lupin: design document

> Use Claude Code (with all its MCP servers, skills, hooks and settings) on any LLM provider, losing nothing. A local proxy that borrows the Claude Code harness and lends it to other models.

**Project documentation**: this file (vision and architecture) · [docs/SPEC-TRANSLATION.md](docs/SPEC-TRANSLATION.md) (translation core) · [docs/SPEC-PROVIDERS.md](docs/SPEC-PROVIDERS.md) (providers and profiles) · [docs/SPEC-CLI.md](docs/SPEC-CLI.md) (CLI, doctor, UX) · [docs/ROADMAP.md](docs/ROADMAP.md) (milestones and verification criteria) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (repo layout and dependencies) · [docs/TESTING.md](docs/TESTING.md) (fixtures and test levels) · [docs/DECISIONS.md](docs/DECISIONS.md) (decision log) · [docs/DESIGN-OAUTH.md](docs/DESIGN-OAUTH.md) (authentication/OAuth design). The working rules for Claude Code sessions live in [CLAUDE.md](CLAUDE.md).

## 1. The problem

Work on MCP servers, skills and configuration is centred on Claude Code. Testing a new model today means starting "vanilla" with another tool and losing the whole accumulated setup. What is needed is a way to change the model only, keeping the environment intact.

## 2. The architectural insight

MCP, skills, hooks, CLAUDE.md and slash commands live **client-side**, inside Claude Code: they do not depend on the model. Claude Code talks to the backend exclusively through the **Anthropic Messages API** (`POST /v1/messages`). Therefore:

- No Claude Code functionality has to be replicated.
- A local proxy is enough: it receives requests in Anthropic format and forwards them, translated or not, to the chosen provider.
- Claude Code is pointed at the proxy with `ANTHROPIC_BASE_URL=http://localhost:<port>`.

## 3. Prior art (why build it anyway)

| Project | What it does | Limit |
|---|---|---|
| [claude-code-router](https://github.com/musistudio/claude-code-router) (~26k ⭐) | Proxy plus per-provider transformers, routing by context | Complex config, power-user UX, 1200+ open issues |
| [LiteLLM proxy](https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models) | Universal gateway with `/v1/messages` | Generic enterprise tool, heavy for local use |
| [UniClaudeProxy](https://github.com/vibheksoni/UniClaudeProxy), [y-router](https://github.com/luohy15/y-router), [CCProxy](https://ccproxy.orchestre.dev/) | Anthropic to OpenAI proxies | Partial provider coverage, little care for edge cases |
| Native Anthropic endpoints (DeepSeek, Moonshot/Kimi, Z.AI/GLM, OpenRouter) | No proxy needed | Only for those providers; no unified switching UX |
| [rayline](https://github.com/rayline-ai/rayline) (Rust, ~15 ⭐, analysed 2026-07-18) | Local plus cloud router for Claude Code/Codex; hybrid sessions (main on the cloud, subagents on a local model); a `rayline claude` wrapper that launches the harness already configured | TLS interception with a local CA (`--via proxy`): invasive, a ToS grey area, a huge security surface. Focused on routing topology, not on translation quality or per-model verification. A very young project |

### Competitive sweep (2026-07-18, 4 research agents)

| Project | What it does | What we take / where we win |
|---|---|---|
| [claude-code-router](https://github.com/musistudio/claude-code-router) (~36k ⭐, v3 = Electron + SQLite + UI) | The leader. Per-provider transformers, routing by context (`longContext`/`think`/`webSearch`/`image`), in-session `/model`, subagent routing, cost dashboard | **Steal**: content-aware routing, `/model`, subagent routing, the `CUSTOM_ROUTER_PATH` escape hatch. **We do better**: around 850 open issues, largely "model X does not work with config Y", where every incompatibility means a new transformer (20+); our centralized quirk registry is the structural inverse. **Uncontested**: its users are asking, in open issues (#1531/#1495), for exactly `doctor`, a scoreboard and runtime repair |
| [LiteLLM](https://github.com/BerriAI/litellm) (~54k ⭐) | Enterprise gateway, 100+ providers, passthrough plus translate, **the only one with a real `count_tokens`** | Orthogonal (enterprise, multi-tenant, cloud). It confirms our local estimate as the right choice: every lightweight proxy omits the endpoint |
| [headroom](https://github.com/headroomlabs-ai/headroom) (~60k ⭐) | **Orthogonal**: context compression (token economy), NOT provider access. Same architectural slot, different problem, stackable with Lupin | **Steal**: holdout plus confidence intervals for doctor scoring; a `learn` step that mines failures into corrective notes (a cousin of the adapters); the `wrap <agent>` UX. **Diverges**: its reversible cache persists content, against our privacy rule |
| [UniClaudeProxy](https://github.com/vibheksoni/UniClaudeProxy) (56 ⭐), [CCProxy](https://github.com/orchestre-dev/ccproxy) (archived), [fuergaosi233](https://github.com/fuergaosi233/claude-code-proxy), [claude-bridge](https://github.com/badlogic/lemmy), raine/claude-proxy | A cluster of lightweight translate proxies (nearly all under 400 ⭐, many archived) | **Steal**: ReAct/XML tool-call fallback for models without function calling (UniClaude); routing by token count, background and thinking (CCProxy); errors with scrubbed credentials (CCProxy); round-tripping thinking blocks and the Gemini thoughtSignature. **We do better**: spec-driven correctness (fixture-backed SSE), OAuth device flow (all of them use static keys) |
| Generic gateways: [Portkey](https://github.com/Portkey-AI/gateway) (12.5k ⭐), [Bifrost](https://github.com/maximhq/bifrost) (6.6k ⭐), Requesty, Cloudflare AI Gateway | Cloud gateways with guardrails, load balancing, failover, semantic cache | **Steal (fits our scope, local version)**: tier-equivalent failover across slots, load balancing over several keys, a local budget cap, a metadata-only dashboard. **Diverges**: semantic cache (persists content), multi-tenant governance (out of scope) |

**Consolidation signals**: y-router, CCProxy, anthropic-proxy and TensorZero are archived; Helicone is in maintenance after the Mintlify acquisition. The middle ground of lightweight OSS proxies is thinning: the space is forking into enterprise gateways (LiteLLM) and the CCR mega-app, leaving the **local-first, correctness, per-model honesty** niche uncovered.

Lupin differentiates on: **UX** (a model switch in one command, a setup wizard, zero JSON editing), **complete coverage** (native passthrough plus translation, same flow), and, looking ahead, **per-model reliability** (behavioural adapters, see §8).

### Positioning: a competitor, but on a different plane

Strategic honesty: on the "a proxy that translates the protocol" plane Lupin competes directly with claude-code-router and loses on day one: 26k stars, years of edge cases solved, a community. But every existing project stops at the protocol. They translate formats, expose configuration knobs, and leave the user to discover on their own whether the model really holds up under the Claude Code harness (the 1200+ open CCR issues are largely "model X does not work with config Y"). Lupin's positioning sits downstream of that layer:

1. **Verification instead of configuration**: `lupin doctor` as a real agentic pre-flight test (read, edit, verify, MCP tool) with an honest verdict before work starts. No existing proxy does this.
2. **Verified profiles instead of knobs**: curated presets per model ("Kimi K3: passthrough, this slot mapping, tested on day X, doctor score 9/10"), zero decisions for the user. That is curated knowledge, not code: the piece the ecosystem is missing.
3. **A compatibility scoreboard**: if the doctor produces reproducible scores, Lupin can publish and maintain the ranking of "which models really work with Claude Code, today". Nobody maintains it, and every new model release makes it relevant again. It is the community moat, more than any feature.
4. **Behavioural adapters** (see §8, M5): runtime repair of malformed edits and tool calls. The hardest one; it comes after the first three.
5. **Guaranteed coverage of the whole process tree**: hooks, plugins (claude-mem), SDK subagents, not merely supported (see §7) but verified by the doctor and stated as an explicit promise.

The public message is not "one more router" but: *"I tell you what works with Claude Code, and I stand behind it"*. The proxy written from scratch stays the foundation (and the learning goal of the project), not the product.

## 4. Architecture

```
Claude Code ──ANTHROPIC_BASE_URL──▶ Lupin (localhost)
                                      │
                        ┌─────────────┼──────────────┐
                        ▼             ▼              ▼
                  [passthrough]  [translate]    [translate]
                   Kimi K3        OpenAI-compat  native Gemini
                   DeepSeek       (OpenAI, OpenRouter,
                   GLM / Z.AI      Ollama, LM Studio, ...)
                   Anthropic
```

### Two modes per provider

1. **Passthrough**: the provider already exposes the Anthropic Messages format (Kimi/Moonshot, DeepSeek, Z.AI/GLM, the OpenRouter "Anthropic skin", Anthropic itself). Lupin rewrites the base URL, the auth header and the model name, nothing else. Zero translation risk.
2. **Translate**: the provider speaks OpenAI Chat Completions (OpenAI, Ollama, LM Studio and nearly everyone else) or native Gemini. Lupin translates request and response, streaming included.

Note: Gemini also exposes an OpenAI-compatible endpoint. In v1 that is what we use; a native Gemini adapter is a later optimization.

### Components

- **HTTP ingress**: `POST /v1/messages` (SSE streaming and not), `POST /v1/messages/count_tokens`, `GET /v1/models` (which feeds the Claude Code model picker).
- **Translation core**: Anthropic to OpenAI and back, the technical heart (see §5).
- **Provider registry**: provider profiles (base URL, auth, mode, model mapping) in a single config file.
- **Slot mapping**: Claude Code uses three "slots" (opus/sonnet/haiku for main and background tasks). Every profile maps the slots onto real models, for example haiku onto a cheap model for background work.
- **CLI**: `lupin use kimi-k3`, `lupin list`, `lupin doctor` (see §7).

## 5. The translation core: the hard parts

The request/response mapping is well known but full of edge cases. In order of importance:

1. **Tool calling**: `tools[].input_schema` to `functions[].parameters`; `tool_use`/`tool_result` blocks to `tool_calls` and `role:tool` messages. Anthropic `tool_result` blocks can carry arrays of blocks (text plus images) while OpenAI only accepts strings, so a lossy serialization has to be handled.
2. **SSE streaming**: Anthropic emits structured events (`message_start`, `content_block_start/delta/stop`, `message_delta`); OpenAI emits flat delta chunks. The state machine has to be rebuilt, including partial JSON of tool calls while streaming.
3. **System prompt**: in Anthropic it is a separate field, an array of blocks with `cache_control`; it has to be flattened into a `system` message and the cache markers removed (or mapped onto the provider's caching, when it exists).
4. **Thinking blocks**: Anthropic extended thinking vs `reasoning_content` (DeepSeek) vs nothing. In translate mode: a safe strip in v1, a mapping in v2.
5. **Stop reason and usage**: `end_turn`/`tool_use`/`max_tokens` to `stop`/`tool_calls`/`length`; token counts with different names and semantics.
6. **Images**: base64 `image` blocks to `image_url` data URIs.
7. **count_tokens**: Claude Code calls it; for providers with no equivalent a local estimate is needed (an approximate tokenizer is fine).

## 6. The main risk (worth stating up front)

The protocol is about 20% of the problem. The other 80%: **Claude Code is optimized for Claude**. Its internal tools (above all Edit, which needs an exact string match) and its system prompts assume Claude's behaviour. Third-party models can produce malformed edits, ignore tool calls or stall the agentic loop. OpenRouter explicitly documents that Claude Code "is only guaranteed with the Anthropic provider". Consequences:

- The large models (GPT, Gemini Pro, Kimi K3, DeepSeek, GLM) work reasonably; small local models will struggle a lot. That expectation must be communicated to the user (`lupin doctor` can test it, see §7).
- This risk is also the opportunity: no existing proxy takes it seriously (see §8).

## 7. UX: the differentiator

Goal: from zero to Claude Code on Kimi K3 in under a minute, with no JSON editing.

```
npx lupin init          # wizard: pick a provider, paste the API key, automatic test
lupin use kimi-k3       # instant switch
lupin use gpt --bg ollama/qwen3   # main slot on GPT, background local
lupin run -- claude     # launches claude already configured (sets the env vars)
lupin doctor            # smoke test: tool call, file edit, streaming on the active model
lupin list              # configured providers and the active model
```

`lupin doctor` is the most important piece of UX: it runs a real mini agentic task (read a file, edit it, verify) and says right away whether the model holds up under the Claude Code harness, instead of leaving the user to find out halfway through a session.

### Env inheritance for hooks and child processes (requirement)

Memories (`~/.claude`, CLAUDE.md) and plugins such as claude-mem are client-side: Claude Code injects them into the prompt or runs them through lifecycle hooks, so they work with any backend without translation. But some plugins (for example the claude-mem compression worker) make their own LLM calls through the Claude Agent SDK, which by default go to Anthropic. Since the SDK honours `ANTHROPIC_BASE_URL`, `lupin run` MUST export the env vars to the whole child process tree: that way the internal calls of hooks and plugins go through Lupin too and use the chosen provider.

## 8. Roadmap

- **M1, foundations**: pure passthrough proxy towards Anthropic (verification: a Claude Code session identical to normal, MCP and skills working). Then passthrough towards Kimi K3 / DeepSeek / GLM with auth and model rewriting. Verification: a file-editing task completed on Kimi K3.
- **M2, translate**: the Anthropic to OpenAI core with streaming and tool calling. Target: OpenRouter and OpenAI. Verification: the same task on GPT through translate mode.
- **M3, UX**: the full CLI (`init`, `use`, `run`, `doctor`, `list`), `GET /v1/models`, slot mapping. Verification: a new user setting up from scratch in under a minute.
- **M4, local runtimes plus Gemini**: Ollama/LM Studio, the Gemini OpenAI-compat endpoint. Verification: `lupin doctor` on a local model with an honest outcome.
- **M5, reliability (the moat)**: per-model behavioural adapters: retry on failed edits, normalization of malformed tool calls, prompt hints for known weaknesses. Possibly a benchmark harness ("same task, N models, cost/success comparison").

## 9. Proposed stack

**TypeScript + Node** (server: Hono or Fastify). Reasons: distribution through `npx` with no install, the same ecosystem as Claude Code, excellent SSE support. A single package, no database, config in `~/.lupin/config.json` managed only by the CLI.

## 10. Open decisions

1. Name of the CLI command: `lupin` (assumed yes).
2. Thinking handling in translate mode: strip (simple, v1) or best-effort mapping.
3. The M5 benchmark harness: part of this project or a separate repo.
