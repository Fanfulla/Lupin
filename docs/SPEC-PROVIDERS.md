# SPEC: providers and profiles

The registry of supported providers, with modes, verified endpoints and known quirks. This is the "curated knowledge" that differentiates Lupin (see DESIGN, positioning): it must be kept current and every row must have been verified with `lupin doctor`.

> Endpoints verified against the official documentation in July 2026. Every PR that touches this file must state its verification date.

## 1. Modes

- **passthrough**: the provider exposes the Anthropic Messages format. Rewrite URL, auth and model, then pipe the body. Translation risk: zero.
- **translate**: the provider exposes OpenAI Chat Completions. It goes through the translation core (SPEC-TRANSLATION).

For the same provider, ALWAYS prefer passthrough when available.

## 2. Provider table

| Provider | Mode | Base URL | Auth | Notes and quirks |
|---|---|---|---|---|
| Anthropic | passthrough | `https://api.anthropic.com` | `x-api-key` | Baseline. Used for M1 and as the reference in A/B tests. |
| Moonshot (Kimi) | passthrough | `https://api.moonshot.ai/anthropic` (China: `api.moonshot.cn/anthropic`) | `Authorization: Bearer` | **Documented quirk**: the temperature is rescaled internally (`real = request × 0.6`). Models: the `kimi-k*` family (for K3 check the exact name on the platform: `platform.kimi.ai`). |
| DeepSeek | passthrough | `https://api.deepseek.com/anthropic` | `Authorization: Bearer` | Officially recommended mapping: opus to `deepseek-v4-pro` (or reasoner), sonnet and haiku to flash. `reasoning_content` exists only through the OpenAI API, so it needs no handling in passthrough. |
| Z.AI (GLM) | passthrough | `https://api.z.ai/api/anthropic` | `Authorization: Bearer` | `glm-*` models. Dedicated "coding" plans with flat pricing. |
| OpenRouter | passthrough (**Anthropic models only**) plus translate | `https://openrouter.ai/api` | `Authorization: Bearer` | Verified 2026-07-18 (official docs): the Anthropic-compat endpoint "is only guaranteed with the first-party Anthropic provider", so non-Anthropic models do NOT go through the skin. The other 200+ models use translate (M2) on the OpenAI-compat endpoint: it stays the universal fallback, but in translate. Model names are `vendor/model`. **The `.io` doubt is SETTLED** (2026-07-18): `openrouter.io` is a parked domain (a squat), the base is ONLY `openrouter.ai`, confirmed by the official OpenAPI spec. Live probe: the Anthropic skin `/api/v1/messages` exists but has NO `count_tokens` (404, so the local estimate of §8 kicks in) and closes the stream with a non-Anthropic `[DONE]` sentinel (a candidate quirk, see §5). See DECISIONS #16. |
| OpenAI | translate | `https://api.openai.com/v1` | `Authorization: Bearer` | `max_completion_tokens` is mandatory on recent models; reasoning models do not support `temperature`, so it is dropped through a quirk. |
| Gemini | translate | `https://generativelanguage.googleapis.com/v1beta/openai` | `Authorization: Bearer` | Google's official OpenAI-compat endpoint: it saves writing the native Gemini adapter in v1 (DECISIONS #9). **Verified 2026-07-19** against the official documentation (updated 2026-06-22): function calling is **supported** with `tools` plus `tool_choice` examples, streaming is **supported**. The "partial tool_choice" note in this table was a first-draft guess and has been disproved. Declared limit: the whole compat layer is "still in beta while we extend feature support"; the Batch API does not support upload/download. No trailing slash in the base URL: paths are built by concatenation. |
| Ollama | **passthrough** (translate as a fallback) | `http://127.0.0.1:11434` (translate: `/v1`) | none | Local, native Anthropic API verified live (ADR-21). Tool calling depends on the model and the template; expectations are low under 30B, and the doctor says so plainly. **The loaded window matters more than the declared maximum**: under about 50K tokens the Claude Code harness does not even fit (§3ter, SPEC-CLI §3.1). |
| LM Studio | **passthrough** (translate as a fallback) | `http://127.0.0.1:1234` (translate: `/v1`) | none | Like Ollama. The `clientErrorsWrappedIn500` quirk is on by default (§5). Discovery through `/api/v0/models`, which reports `loaded_context_length` besides `max_context_length`. |
| ds4-server (DwarfStar) | **passthrough** (translate as a fallback) | `http://127.0.0.1:8000` (translate: `/v1`) | none | antirez's C inference engine for DeepSeek V4 Flash/PRO and GLM 5.2. `POST /v1/messages` is Anthropic-native (system, messages, tools, tool_choice, stream, thinking; `tool_use` in Anthropic shape, SSE). One model per instance: the ids of `/v1/models` are aliases of the GGUF loaded with `-m`. `context_length` is the SERVED window (`--ctx`, default 32768), hence `loaded` provenance in the discovery. No auth header is verified server-side: the token in its examples exists only because clients demand one. Verified against docs plus source 2026-07-24, **no live verification** (§3ter). |

## 3. Profile schema (config)

A profile is one provider plus a slot mapping plus quirks. In `~/.lupin/config.json`:

```json
{
  "activeProfile": "kimi",
  "port": 3456,
  "localToken": "<generated by lupin init>",
  "profiles": {
    "kimi": {
      "provider": "moonshot",
      "mode": "passthrough",
      "baseUrl": "https://api.moonshot.ai/anthropic",
      "auth": {"type": "bearer", "apiKeyRef": "MOONSHOT_API_KEY"},
      "slots": {
        "opus": "kimi-k3",
        "sonnet": "kimi-k3",
        "haiku": "kimi-k3"
      },
      "quirks": [],
      "limits": {"maxOutputTokens": 16384}
    },
    "gpt-with-local-bg": {
      "provider": "openai",
      "mode": "translate",
      "baseUrl": "https://api.openai.com/v1",
      "auth": {"type": "bearer", "apiKeyRef": "OPENAI_API_KEY"},
      "slots": {"opus": "gpt-5.6-sol", "sonnet": "gpt-5.6-terra", "haiku": {"profile": "ollama-qwen"}},
      "quirks": ["maxCompletionTokens", "noTemperatureOnReasoning"]
    }
  }
}
```

Rules: (1) API keys are NOT in the file: `apiKeyRef` points at an env var or at the OS keychain (see SPEC-CLI, security); (2) a slot can delegate to another profile (`{"profile": ...}`), which is how "main on GPT, background on Ollama" is done; (3) `quirks` are boolean flags with a centralized implementation in the translation core, NEVER ifs scattered through the code.

## 3bis. Recommended default profiles (verified 2026-07-18)

Slot philosophy, which is where "the best possible configuration" is really played: **opus** = maximum capability (planning, deep tasks, explicit user requests); **sonnet** = the agentic daily driver (90% of the traffic); **haiku** = subagents, background tasks and Claude Code service calls, high volume, needs to be fast and cheap, does not need to be frontier. A well-chosen haiku cuts cost without touching perceived quality (it is the same intuition as rayline's "hybrid sessions", obtained for free from the slot mapping).

| Provider | opus | sonnet | haiku | quirks | Notes (source/verification) |
|---|---|---|---|---|---|
| Moonshot (passthrough) | `kimi-k3` | `kimi-k3` | `kimi-k2.6` | (none) | Fact-checked 2026-07-18 on platform.kimi.ai: `kimi-k3` exact, no variants. The Anthropic endpoint officially supports `kimi-k3`, `kimi-k2.7-code` (thinking must be enabled), `kimi-k2.6` (thinking optional, an ideal haiku: $0.95/M input against $3 for K3), `kimi-k2.7-code-highspeed`. **Dead, never use them**: `kimi-k2-turbo-preview`, `kimi-latest`, `kimi-k2-thinking*` (2026-05); `moonshot-v1-*` sunset on 2026-08-31. Official docs: with Claude Code set `ENABLE_TOOL_SEARCH=false` |
| Kimi Code subscription (passthrough) | `k3` | `k3` | `kimi-for-coding` | (none) | A provider DISTINCT from the Moonshot platform: base `https://api.kimi.com/coding/`, the subscription key (console: 5 keys max), ids `k3` (Moderato tier and above), `kimi-for-coding` (K2.7, all tiers), `kimi-for-coding-highspeed` (Allegretto and above). Documented gotcha: a wrong highspeed id falls back silently to `kimi-for-coding`. Live check of `GET /coding/v1/models` on 2026-07-19 (OAuth token): the display name of `kimi-for-coding` is "K2.7 Coding" (the alias IS 2.7), context 262k; `k3` has a 1M context with `think_efforts` low/high/max (default max); all of them carry `supports_thinking_type: "only"`, so thinking is always on server-side (consistent with the e2e, see DESIGN-OAUTH §9.3). See docs/DESIGN-OAUTH.md |
| DeepSeek (passthrough) | `deepseek-v4-pro` | `deepseek-v4-pro` | `deepseek-v4-flash` | (none) | api-docs.deepseek.com: v4-pro 1.6T with 49B active, v4-flash 284B with 13B. **`deepseek-chat`/`deepseek-reasoner` were retired on 2026-07-24: never use them in profiles** |
| Z.AI (passthrough) | `glm-5.2` | `glm-5.2` | `glm-5-turbo` | (none) | z.ai/subscribe: a flat coding plan with GLM-5.2 (flagship, 2026-06-13), GLM-5-Turbo, GLM-4.7 |
| OpenAI (translate) | `gpt-5.6-sol` | `gpt-5.6-terra` | `gpt-5.6-luna` | `maxCompletionTokens`, `noTemperatureOnReasoning` | Fact-checked 2026-07-18 (official changelog): exact ids, all on Chat Completions. `max_tokens` is rejected and `temperature` is unsupported, so both quirks are mandatory. **`gpt-5.3-codex` excluded**: Responses API only AND deprecated. Reported (medium confidence): tools plus `reasoning_effort` on Claude Code can return 400 on sol |
| OpenRouter (translate, the universal fallback) | `moonshotai/kimi-k3` | `deepseek/deepseek-v4-pro` | `deepseek/deepseek-v4-flash` | (none) | Slugs verified 2026-07-18 against `GET /api/v1/models` (live), all with `tools` plus `tool_choice`. GLM: `z-ai/glm-5.2`, `z-ai/glm-5-turbo` (vendor `z-ai`, not `zhipu`) |

Rules: every row carries a verification date; the doctor (M4) stays the final gate before a profile is promoted to "guaranteed" (the names here are verified against catalogues, not yet with authenticated requests). These defaults live in `lupin init` (M3) and ONLY there: never in the sources (CLAUDE.md rule 5).

### 3quater. GitHub Copilot: a token that has to be exchanged (2026-08-02, backlog #15a, ADR-38)

**Live-verified end to end on 2026-08-05**, on a **Copilot Free** account: device flow, token exchange, per-account host, and a real headless Claude Code session that called a tool and wrote a file (`gpt-4.1`). Everything not marked live below was read on 2026-08-02 from the official `@github/copilot-language-server` bundle that every Copilot editor plugin vendors, cross-checked against an independent third-party implementation that agrees with it, plus GitHub's own OAuth documentation. No doctor score yet: on a free plan a full doctor run would spend most of the monthly allowance in one go. The model catalogue is still never written down here (rule 5); §3quater.1 records what the *shape* of the catalogue turned out to mean.

Two things the roadmap assumed turned out to be wrong, and both change the design:

1. **It is the device flow, not PKCE.** Backlog #15a assumed Authorization Code + PKCE because 9router advertises Copilot next to Codex. GitHub's own Copilot CLI documentation and the shared client bundle both use the RFC 8628 device grant against `POST https://github.com/login/device/code`, token at `POST https://github.com/login/oauth/access_token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`. So Copilot rides the flow Lupin implemented FIRST, not the newer one.
2. **GitHub Models is not an alternative: it is retired.** The sanctioned PAT-based inference API (`models.github.ai`) was blocked to new customers on 2026-06-16 and fully retired on **2026-07-30**, three days before this research. There is no ToS-clean substitute to prefer.

What is specific to this provider:

- **The OAuth token does not pay for inference.** It buys a short-lived token at `GET https://api.github.com/copilot_internal/v2/token` (sent as `Authorization: token <t>`, GitHub's scheme for this endpoint), whose answer carries the token, `refresh_in` seconds, and an `endpoints.api` host. **That host is authoritative**: the well-known `api.githubcopilot.com` is a fallback only, because the served host is per account. One central implementation, `src/server/copilot-token.ts`, flagged from the descriptor with `tokenExchange`, so the request path never grows a provider check (rule 4). The exchange happens 60 seconds before the declared deadline, single-flight per store key, and a token bought with a superseded GitHub token is dropped.
- **A credential can name its own host.** `ResolvedCredential.baseUrl` is honoured by the ingress ABOVE the registry default and BELOW an explicit `baseUrl` on the profile: the user's override stays king.
- **The access token neither expires nor refreshes.** GitHub OAuth apps issue non-expiring tokens unless they opt in, and the device grant returns no refresh token, so the descriptor carries `nonExpiringToken` and the refresh runtime skips it entirely. Without that flag the half-life rule would try to refresh, fail, and tombstone a perfectly good credential.
- **Required headers, not attribution.** `Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`, `X-GitHub-Api-Version` and `openai-intent` are mandatory: a missing `Editor-Version` answers 400, and it is the single most reported integration bug of every proxy that fronts Copilot. They live in `ProviderDef.requiredHeaders`, a field distinct from `attribution` precisely because dropping one costs the request rather than a label.
- **Translate, not passthrough.** The backend does expose an Anthropic-shaped `/v1/messages`, and each model declares which endpoint shapes it supports. But nobody has shown that endpoint answering a plain exchanged token, and the one mature third-party implementation routes every model, Claude included, through `/chat/completions` and translates both ways itself. Passthrough stays unclaimed until someone proves it live; that is the first thing to test with a real account.
- **The model catalogue is never written here.** It changes often, it is per account, and not one id has been verified. `lupin login copilot` reads the account's own `GET {endpoints.api}/models`, and that IS the verification: no models listed means no profile is created. Every discovered slot starts on the first listed model, because guessing which id is "the strong one" from its name would be exactly the invention rule 5 forbids. **Both halves were missing until 2026-08-05, and the first live login made that expensive**: only the count was printed, and `lupin use --opus <model>`, which `lupin login` printed as the way to aim the slots, did not exist (`use` took only `--bg` and ignored unknown flags in silence, so it reported success and did nothing). Both are built now: the catalogue is printed at login, wrapped four names to a line, with the aiming command and the warning that being listed does not mean the plan can use it; and `use` takes `--opus/--sonnet/--haiku` and refuses anything it does not recognise (SPEC-CLI §1). What is still true is the caveat: per §3quater.1 the first listed model is often one that cannot serve a request, so the printed list is the user's only way through.
- **The HMAC secrets in the bundle are deliberately unused.** They sit next to the client id, but static analysis shows them gated to internal build channels alongside a staff-request header. Reusing a public device-flow client id is what that id is for; forging an authenticity signature for an internal channel is a different act, and Lupin does not do it.
- **Two bugs the first real login found, both in code shared with Kimi** (fixed 2026-08-05, `test/oauth.test.ts`). (a) **GitHub's OAuth endpoints answer `application/x-www-form-urlencoded` unless the caller sends `Accept: application/json`**, and the shared `postOAuthForm` never sent it, so the device authorization died on `non-JSON response (HTTP 200)`. Worse than a clean failure: the token poll treats a `bad_response` as a transient blip, so a user who authorized in the browser would have watched it poll for the full 15 minutes and then be told the code expired. The header is now sent unconditionally (RFC 6749 says the answer is JSON anyway). (b) **The Kimi `X-Msh-*` device identity headers were sent to every device provider**, GitHub included: until Copilot arrived, "the device flow" and "Kimi" were the same thing, and neither call site had a reason to distinguish them. They are now opt-in per descriptor (`flow.deviceIdentityHeaders`), the same way they were already kept away from the PKCE providers.

### 3quater.1. What the account catalogue really means (live, 2026-08-05, Copilot Free)

**The account's `/models` list is not a list of models the account can use.** On a Copilot Free plan it returned **51 rows**, and of those exactly five answered `POST /chat/completions`: the `gpt-4o` / `gpt-4.1` family (`gpt-4o`, `gpt-4o-mini`, `gpt-4.1`, plus the two dated ids). Every other row answered `400 model_not_supported`. So a login that fills the slots from the list can, and did, produce a profile that cannot serve one request.

The fields that do exist, and what each one is worth:

| Field | What it says | Worth |
|---|---|---|
| `capabilities.type` | `chat`, `completion` or `embeddings` | reliable as an exclusion: an embedder must never fill a slot |
| `supported_endpoints` | `/chat/completions`, `/responses`, `/v1/messages`, `ws:/responses` | **misleading**: every model that declared `/chat/completions` answered 400, while the five that work declare **no endpoints at all** |
| `billing.restricted_to` | the plans entitled to it (`free`, `pro`, `enterprise` ...) | close, but not sufficient: models listing `free`, and models with no restriction at all, still answered 400 |
| `policy.state` | `enabled` / `disabled` | a real gate, but not the one that failed here |
| `billing.is_premium`, `billing.multiplier` | what a request costs against the plan allowance | the honest input for a "this will cost you" notice |

**The gate that actually decides was not found in the catalogue.** The working set matches the models a Free plan is documented to include, so the plan is the likeliest cause, but the `Copilot-Integration-Id` we send (`vscode-chat`) is an equally plausible filter and the two cannot be separated from one account. **The only sound verification is a probe**: a one-token request per candidate, which is what the account's own answer costs when it is a 400.

**`/v1/messages` is declared, and still unproven.** Some rows (the Claude ones) list the Anthropic-shaped endpoint in `supported_endpoints`, which is what a passthrough lane would need. None of them is usable on this plan, so passthrough through Copilot stays unclaimed exactly as before: now for a measured reason rather than an untested assumption.

**The host is per account, confirmed.** The exchange answered `https://api.individual.githubcopilot.com`, not the well-known `api.githubcopilot.com` the fallback would have used. The `endpoints.api` field is authoritative, as the design assumed.

- **The risk gate, worded honestly.** The login is blocked behind `--i-accept-the-risk`, like Google's. The reason is NOT a term forbidding third-party clients: none was found in the Copilot Product Specific Terms or the Generative AI Services Terms, and no takedown of such a proxy is on record. The reason is the enforcement pattern that does exist: suspensions of Copilot access reported as permanent and tied to the user's main GitHub identity. **Using several accounts to stretch the quota is the pattern most associated with those suspensions**, so §4nonies multi-account and this provider must not be combined; the warning says so before the browser opens.

### 3ter. Local providers: Ollama, LM Studio, llama.cpp server, ds4-server (2026-07-19, ds4 added 2026-07-24)

| Provider | mode | baseUrl (passthrough) | translateBaseUrl | Verification |
|---|---|---|---|---|
| Ollama | **passthrough** (translate fallback) | `http://127.0.0.1:11434` | `http://127.0.0.1:11434/v1` | live 2026-07-19 on 0.21.0: `POST /v1/messages` answers Anthropic-native (thinking block, usage, stop_reason); `count_tokens` returns 404 |
| LM Studio | **passthrough** (translate fallback) | `http://127.0.0.1:1234` | `http://127.0.0.1:1234/v1` | live 2026-07-19: `/v1/messages` answers with an Anthropic-style error (the endpoint is active), `GET /v1/models` is fine; official docs at `lmstudio.ai/docs/developer/anthropic-compat` |
| llama.cpp server | translate | (none) | `http://127.0.0.1:8080/v1` | the documented default endpoint (`llama-server`), to be re-verified at the first live install |
| ds4-server (DwarfStar) | **passthrough** (translate fallback) | `http://127.0.0.1:8000` | `http://127.0.0.1:8000/v1` | docs plus the `ds4_server.c` source, 2026-07-24: `/v1/messages` Anthropic-native, `GET /v1/models`, default host and port `127.0.0.1:8000`. Live: not verifiable without adequate hardware (below) |

**The optimization that really matters on local runtimes: prefix stability.** The dominant cost is not generation, it is **re-processing the prompt**: the Claude Code harness alone is around 46K tokens, and on modest hardware that prefill dominates every turn. llama.cpp and LM Studio skip that work **only while the request prefix stays byte-identical** to the previous one. So anything Lupin does to the body (reordering a key, normalizing a field, adding a value that changes on every request) makes the whole prefill be paid again every turn, **silently and with no error to look at**. In passthrough the body is forwarded with only the model rewritten, which preserves the original key position; `test/passthrough.test.ts` verifies it (the passthrough half of `test/cache-stability.test.ts`, which covers translate). This is not a micro-optimization: it is the difference between a turn measured in seconds and one measured in minutes.

**Passthrough-first (decided 2026-07-19, see DECISIONS ADR-21)**: Ollama (>=0.14) and LM Studio (>=0.4.1) expose a native Anthropic Messages API on `/v1/messages`. Passthrough removes the entire translation risk (the most reported bug class in competitors); the local runtime handles the model's own dialects itself. Translate stays as a fallback (same port, the OpenAI-compat surface on `/v1`) and as the only mode for llama.cpp.

Rules specific to local runtimes:

1. **Auth `none`** (a new type in `AuthConfig`): no credential required and none stored. The proxy still sends a constant `Authorization: Bearer lupin-local`, because some OpenAI-compat servers reject requests without any Bearer.
2. **Slots filled at `init`, never in the defaults**: rule 5 (model names only in the dated defaults) does not apply to local runtimes, since every machine has its own models. The wizard queries `GET <translateBaseUrl>/models` live (the OpenAI-compat surface, same port even in passthrough), excludes embedders, and asks for two picks: the main model (opus and sonnet slots) and the light model (haiku, with enter reusing the main one).
3. **Connectivity**: for local runtimes the test is that same `GET /models` (no 1-token request: it is already needed to pick the slots). Server down means an actionable error with the provider's start command, never a stack trace.
4. **`count_tokens` missing in passthrough** (Ollama: 404 verified live): covered by the general fallback of §8, a local estimate on 404/405, no dedicated quirk.
5. **Native discovery at `init` (2026-07-19, `providers/local.ts`)**: `/v1/models` on its own is a list of ids. The native APIs of the runtimes say what really decides whether a session will work, and they cost one request:

   | Runtime | Endpoint | Fields used | Verification |
   |---|---|---|---|
   | Ollama | `GET /api/tags` plus `POST /api/show` | `model_info["<arch>.context_length"]` (a key namespaced by architecture: it is found by suffix, never by model name, rule 5), `capabilities[]` (`tools`, `vision`) | live 2026-07-19 on 0.21.0: qwen3.5 with ctx 262144, capabilities `completion,vision,tools,thinking` |
   | LM Studio | `GET /api/v0/models` | `loaded_context_length` (preferred) or `max_context_length`, `capabilities[]`, `type` (`llm`/`vlm`/`embeddings`, where `vlm` means vision) | live 2026-07-19: 7 models, the embedder excluded through `type`; gemma-4-12b **declares 262144 but runs at 8192** |
   | llama.cpp | `GET /props` | `default_generation_settings.n_ctx`, `model_path` | the server was down during the test: the function returns an empty list, no crash |
   | ds4-server | `GET /v1/models` | `context_length` (= the server's `ctx_size`, that is `--ctx`: the **served** window, `loaded` provenance), `supported_parameters[]` (which contains `tools`) | docs plus the `ds4_server.c` source (`send_models` / `append_model_json_values`), 2026-07-24 |

   How it is used: (a) **`capabilities` without `tools` is a hard warning in the wizard**, because without tools Claude Code cannot take a single step, and saying so up front costs nothing while finding out later costs a whole session. No competitor answers this question; (b) the windows populate the profile's `contextWindows`, so the `longContext` route (§4quater) gets a real dynamic threshold instead of a magic number. **Loaded window vs declared maximum (verified live 2026-07-19)**: the distinction is not a detail. `google/gemma-4-12b-qat` declares `max_context_length: 262144` but runs with `loaded_context_length: 8192`, a factor of 32. Using the declared maximum would put the `longContext` threshold around 209k on a model that overflows at 8k: the route would never fire and the model would hit the wall. Rules: (a) the loaded window always wins when the runtime exposes it (LM Studio `loaded_context_length`, llama.cpp `n_ctx`); (b) `contextWindowSource` distinguishes `loaded` from `max`, and the wizard prints a `max` suffix when the number is only theoretical; (c) Ollama exposes only the model's maximum (`num_ctx` depends on load time), so those are marked `max`.
6. **Dialects (translate only, today llama.cpp)**: this needs the normalizations of SPEC-TRANSLATION §5bis (think-tag stripping, textual tool calls). Until they exist, expect medium to low doctor scores: that is the honest expected behaviour, not a bug.

**ds4-server: what differs from the other local runtimes (2026-07-24, re-verified on source 2026-08-02).**

- **One model per instance.** The server loads the GGUF passed with `-m` and the ids of `/v1/models` are aliases of it: `deepseek-v4-flash` / `deepseek-v4-pro`, or `glm-5.2` / `glm-5.2-chat` / `glm-5.2-reasoner` (plus `zai/` synonyms) when the GGUF is GLM. The wizard shows several rows describing the same model: picking any of them is equivalent for the weights, BUT the alias controls thinking (`deepseek-chat` and `glm-5.2-chat` force it off, `glm-5.2-reasoner` forces it on) unless the request sets `thinking` explicitly. Two models need two instances on different ports (`--port`) and two profiles. The `model` in a POST body is not validated at all: any string is accepted.
- **The window is the one you started with.** `context_length` reports `--ctx`, default **32768**, which is under the harness floor (46075 tokens measured, SPEC-CLI §3.1). Init says so before a single token is spent, and the window is persisted because it is served, not declared. Start it with `--ctx 100000` or more. Overflow is a hard 400 BEFORE generation (with `n_prompt_tokens`/`n_ctx` in the error body), never truncation; the HTTP body cap is 64 MiB.
- **No credential.** The server checks no authorization header (grep for auth/Bearer in `ds4_server.c`: zero hits): rule 1 for local runtimes applies (a constant Bearer, `auth: "none"`).
- **Prefix stability, multiplied.** The general rule for local runtimes holds, plus the disk KV cache (`--kv-disk-dir`): the harness prefill survives a session switch and a server restart. Passthrough preserves the prefix byte per byte, so the cache stays valid. The server even replays each tool call's exact sampled bytes (keyed by `tool_use_id`) instead of re-rendering the client's JSON, so echoed tool history stays cache-hot; this is invisible to the client.
- **Platforms and hardware.** Documented builds: macOS Metal, Linux CUDA, ROCm. No Windows build (2026-08-02: zero `_WIN32`/mingw/MSVC hits in the whole tree, POSIX-only sockets and pthreads, `uname -s` Makefile): from Windows the server has to run in WSL2 with CUDA or be reached on another host (the endpoint is plain HTTP anyway, only `baseUrl` changes in the registry). The supported models ask for a class of RAM that is not a common workstation (Flash q2-imatrix: 96/128GB).
- **Verification status.** Registry, discovery and the default profile come from documentation and source (`ds4_server.c`), not from a real session: **no live verification**, no doctor score. The row stays marked that way until it runs on adequate hardware (ROADMAP #13). Re-verified on source at HEAD `54b36ed` (2026-07-28): 27 commits since 2026-07-24, none touching `ds4_server.c`, so the API surface below is the one already in the registry.

**ds4-server, facts from the 2026-08-02 source pass** (three-agent read of `ds4_server.c`, `ds4_kvstore.c`, `ds4_agent.c`, README, MODEL_CARD; line references in the analysis notes of that date). Claude Code is a first-class upstream target: the release QA gates the Anthropic endpoint (`QA_BEFORE_RELEASES.md` §12) and the README ships a `claude-ds4` wrapper. What a proxy must know, none of it a translate-lane quirk (passthrough forwards bodies untouched):

1. **Usage reports the KV cache.** `usage` carries `cache_read_input_tokens`/`cache_creation_input_tokens` from the server's own prefix-cache accounting (pinned by the inline test `test_anthropic_usage_reports_cache_details`). This answers ROADMAP #13's open question: the doctor's cache receipt will work against ds4.
2. **`count_tokens` does not exist** (no route; unknown paths answer 404): the §8 local-estimate fallback covers it, same as Ollama, no quirk.
3. **`image` blocks are dropped silently** (the content-block parser extracts only `text`/`thinking`/`tool_use`/`tool_result`): no vision, no error. A Claude Code screenshot paste reaches the model as if it were never sent.
4. **Forced `tool_choice` is not honored.** Only `{"type":"none"}` disables tools; `{"type":"tool","name":...}` is parsed for its `type` and the name is skipped, so the model stays free to call anything or nothing.
5. **`stop_sequence` is never attributed.** The response field is hardcoded `null` and no `stop_sequence` stop_reason exists; `stop_sequences` is accepted in the request, but whether it is enforced is unverified.
6. **A mid-decode failure is invisible.** Errors after decoding starts do not produce an HTTP or SSE error: the stream ends normally and the Anthropic `stop_reason` falls back to `end_turn` on a 200. Truncated content is the only symptom; neither the proxy nor the client can detect it from the envelope.
7. **409 continuation edge.** A `tool_result` whose `tool_use_id` is known only to the server's live KV state (not replayed in the request history) can answer 409 "retry by replaying the full messages history". Claude Code always replays full history, so this path should never fire through Lupin; it is listed because a 409 from ds4 means exactly that, and the request is retryable as-is.
8. **One request at a time by default.** Without `--batched-session N` the server fully serializes requests, and only ONE live KV checkpoint exists in memory: a second concurrent conversation (a subagent, a background haiku call) queues behind the current one AND evicts the live checkpoint of the main session, which then re-pays the prefill from disk (if `--kv-disk-dir` is on) or from zero. The startHint keeps the disk cache on; users running subagent-heavy sessions want `--batched-session 2` or more (each slot costs a full resident KV at `--ctx`). Upstream's own wrapper also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` for the same reason; Lupin documents it and does not set it (it changes client behavior beyond keeping the stream alive).
9. **Silence on the wire while queued.** During prefill the server emits an SSE comment `: prefill` every 5s (Lupin's passthrough tap forwards bytes before observing them, so the comment reaches the client), but a request WAITING for the single slot gets nothing. Upstream's wrapper raises the client idle timeout to 600000 ms; the `raiseStreamIdleTimeout` quirk (§5) does the same from `lupin run`.
10. **Thinking is native Anthropic.** Thinking arrives as `thinking` content blocks with `thinking_delta`/`signature_delta` stream events; the `signature` is cosmetic (the message id, not a cryptographic signature) and nothing validates signatures on replay, so a `lupin resume` handoff INTO ds4 does not need `stripHistoryThinking`. Disable with `thinking: {"type":"disabled"}` or a non-thinking alias. No `ping` events are ever emitted, and every response closes its connection (`Connection: close`).
11. **Sampling defaults are DeepSeek's**: `temperature=1, top_p=1, min_p=0.05`; an explicit client value always wins. Tool-call structural tokens are force-decoded greedily server-side, and a malformed tool call is retried by injecting a model-visible tool error, never surfaced as an API error.

## 4. Slot mapping: how Claude Code picks the models

Claude Code sends `claude-*` names in the body, resolved from its internal aliases (opus/sonnet/haiku). The proxy intercepts and resolves them:

0. Normalizing the `[1m]` suffix (2026-07-24, backlog #12): the Sonnet-5-era client lets the user suffix any model id with `[1m]` (the 1M-context variant, through `/model` or settings.json). The suffix is client-side routing information: it must be stripped from the end of the id BEFORE any match, so that `kimi-k3[1m]` hits the direct-use case of point 2 instead of silently degrading onto the sonnet slot, and the upstream never receives a name it does not know. Source: code.claude.com/docs/en/model-config.
1. Name match: an id containing `opus`, `fable` or `mythos` (the Claude 5 tier above Opus, verified 2026-07-19 in a real session: `claude-fable-5` is the default of Claude Code 2.1 and later) goes to the opus slot; `haiku` goes to the haiku slot; everything else goes to sonnet.
2. If the user picks from the model picker a model exposed by `GET /v1/models` (the profile's real names), it is used directly, with no mapping.

**The `GET /v1/models` endpoint** (2026-07-19, prefixed ids since 2026-07-24): authenticated with the `localToken` like `/v1/messages`; it answers in Anthropic list format, `{"data":[{"type":"model","id":"claude-lupin-<model>","display_name":"<model>"}],"has_more":false}`, with the resolved slot models of the active profile (delegations included, deduplicated, in opus, sonnet, haiku order). A slot with a broken delegation is simply absent from the list, never an error.

**Client facts that shape this endpoint** (verified 2026-08-02 against the official docs, `llm-gateway-protocol` and `model-config`, plus the client-binary observations already recorded here):

- The client calls `GET /v1/models?limit=1000` **once per session, at startup**, with a 3 second timeout, and caches the answer in `~/.claude/cache/gateway-models.json`. It does NOT re-fetch when the picker is opened. Any redirect counts as a failure. So the list a session sees is frozen at launch, and Lupin must answer fast and never redirect.
- Discovery does not run at all when `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set **to any value, `0` included** (issue #61112, closed "not planned"): a user who copies that variable from another tool's wrapper loses the picker silently. This is why `lupin run` does not set it (SPEC-PROVIDERS §3ter fact 8).
- Only `id` and `display_name` are read. Ids not matching `/^(claude|anthropic)/i` are dropped, which is what the `claude-lupin-` prefix buys.
- A pick confirmed with Enter is **written into the user's GLOBAL `~/.claude/settings.json`** as the default model for new sessions (`s` picks for the session only). Lupin never writes there (ADR-11) but its ids can end up there through the client, so every id Lupin publishes has to stay meaningful, or at least harmless, when it comes back from a future session or from a different config.

### 4.3. Switching profile from inside Claude Code (2026-08-02, backlog #16a, ADR-37)

The model picker is the one client surface Lupin controls, so it also carries the gesture `lupin use <profile>` for a user who never leaves the session:

- **One extra row per profile**, appended AFTER the model rows: id `claude-lupin-switch:<profile>`, display name `switch Lupin profile: <profile>`. The rows are inert until picked.
- **Every profile is listed, the active one included.** The list is frozen for the whole session (see above), so omitting the active profile would make the switch a one-way trip: there would be no row to go back with.
- **A pick is a gesture, not a pin.** The client re-sends the picked id on every later turn, so the ingress acts only when the target CHANGES (per daemon, in memory). Otherwise the next request would silently undo a `lupin use` made meanwhile from the CLI or the TUI, and the config would stop being the single source of truth (ADR-27).
- **The switch is the same write `lupin use` performs** (in memory immediately, then the config file with hot reload), and the request that carried the gesture is then served, never bounced: the user asked a question and must get an answer. It is served like the client's default model, which lands on the **opus** slot (§4 rule 1).
- **An unknown profile serves the session instead of breaking it.** A pick outlives the profile it names, because the client saves it globally: it can arrive after a rename or from another machine's config. The request is served on the active profile and the log carries `profileSwitch: "unknown:<name>"`, so the cause is visible without a dead session.
- **Visible, never silent**: a switch that happened logs `profileSwitch: "<profile>"`, next to `quotaSwitch` (§4octies) which records the automatic one.

**The honest limit of reading it as a gesture.** Because only a CHANGE acts, re-picking the row that is already selected does nothing. So this sequence has a dead end: pick `switch:B` from the picker (active becomes B), switch to A from the TUI or the CLI, then try to come back to B **from the picker**. The client is still holding `switch:B`, so re-picking it sends the same id and no gesture is seen. The way back is any other surface (`lupin use B`, the TUI, or picking a different row first). This is the price of the config staying the single writer (ADR-27), and it is preferred to the alternative, where every turn of an old session would drag the active profile back and no other surface could hold a switch.

**Why the `claude-lupin-` prefix (verified on the client binary 2.1.219, 2026-07-24).** With `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` (set by `lupin run`, SPEC-CLI §1) Claude Code calls `GET <base>/v1/models?limit=1000` at startup, with a single credential header (`Authorization: Bearer` when `ANTHROPIC_AUTH_TOKEN` is present, otherwise `x-api-key`), `anthropic-version: 2023-06-01`, a 3s timeout and redirects forbidden (a redirect means a silent failure). From the body it reads `data[].id` and the optional `display_name`, and **discards every id that does not start with `claude` or `anthropic`** (`/^(claude|anthropic)/i`): with the real ids (`kimi-k3`, `glm-5.2`) the list arrived empty at the picker and mid-session switching did not work, contrary to what this section claimed before the verification. So: the published id carries the prefix, the `display_name` carries the real name (that is what the picker shows), and the proxy strips the prefix in `normalizeModelId` before matching, exactly as it does for the `[1m]` suffix. The selection then lands in the direct-use branch of point 2. The results are cached by the client in `<config dir>/cache/gateway-models.json` per `baseUrl`, and labelled "From gateway" in the picker.

Client-side conditions that disable all of it (same verification): `ANTHROPIC_BASE_URL` absent or equal to `api.anthropic.com`, any `CLAUDE_CODE_USE_*` variable (Bedrock/Vertex/Foundry and so on) active, no credential at all, or `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set.

The mapping happens IN THE PROXY, not through `ANTHROPIC_MODEL`/`ANTHROPIC_DEFAULT_*_MODEL`: that way the Claude Code UI stays coherent and a profile switch needs no Claude Code restart (`lupin use` is enough).

### 4ter. Tier-equivalent failover (2026-07-19, from COMPETITIVE steal #3)

Opt-in per profile, declarative:

```json
"kimi": { ..., "failover": "kimi-sub" }
```

Semantics:
- Triggered ONLY by "retryable" failures: **429, 5xx, network errors**. Never on request 4xx (an identical request would fail identically) and never on 401/403 (a credential problem must be seen, not masked).
- **One retry only**: the request is re-resolved against the failover profile's slots (same `requestedModel`) and tried once. The failover of the failover is NOT followed: no cascades.
- The field lives on the **active profile** (the entry point), whatever delegated profile actually failed.
- **Streaming**: failover only when the failure arrives before the bytes start piping (the status line); an error mid-stream propagates honestly (the ADR-6 spirit: no hidden retries that falsify the experience).
- **Visible in the logs**: the failover attempt line carries `failedOver: "<primary-profile>"`. Never silent.
- Validation: the referenced profile must exist (`validateConfig` fails otherwise).

**Retry-After honoured before the failover (2026-07-24, audit gap `retry-policy-single-hop`).** A 429 with `Retry-After: 2` is not a broken provider: it is a provider telling us when it will answer again. Burning the single failover hop on that information throws it away. The semantics extend the "one retry only" rule without contradicting it:

- If the first attempt fails retryably **and** the provider sent a parseable `Retry-After` (delta-seconds or an HTTP-date, RFC 9110 §10.2.3) with a wait **greater than 0 and at most 5s**, Lupin waits exactly that long and retries **the same profile** once.
- Beyond 5s it does not wait: the request would hang with nothing to show, while the failover (or Claude Code's own retry on the surfaced 429) answers sooner. No parseable hint means unchanged behaviour.
- The second failure does not lengthen the chain: the failover follows as always, one hop, no cascades.
- **Visible**: the log line carries `retryAfterMs: <ms waited>`. A wait nobody sees is indistinguishable from a slow provider.
- The health counter (§4sexies) records **both** failures: they are two provider calls that really failed, and pretending otherwise would delay the cooldown of a profile that is genuinely drowning.

### 4sexies. Failover with cooldown (health tracking, 2026-07-20)

The failover of §4ter is one-shot: a dead primary is retried on every request before failing over. Observed live 2026-07-20: a profile with no failover received three consecutive 529s (latencies of 12 to 18 ms, a saturated upstream) that reached the user raw as "at capacity"; with a declared failover and a cooldown, those turns go straight to the alternative without retrying the dead one.

Semantics (extending §4ter, not changing it):

- **A per-profile counter**: every retryable failure (429, 5xx, network) on a profile increments an in-memory counter (never persisted: this is short-term health, not history). A success resets it.
- **Cooldown**: at `FAILOVER_COOLDOWN_THRESHOLD` (3) consecutive failures the profile enters a cooldown of `FAILOVER_COOLDOWN_MS` (60s). While it lasts, requests skip the primary and go **straight** to the failover, without retrying the dead one first. Once it expires the primary is retried (a `Recovering` state: one success re-enables it, one failure reopens the cooldown).
- **Only when a failover exists**: with no declared `failover` the behaviour stays that of §4ter (one retry, then an honest error). The cooldown does not invent alternatives.
- **Visible, never silent**: the log line of a request that skips the primary carries `cooldown: "<profile>"`; `lupin list` shows the state (`healthy` / `cooldown 34s`) next to the doctor score. The state lives in daemon memory: it resets on every restart, which is the correct behaviour (a restart is already a recovery signal).
- **Daemon-local scope**: the tracking lives in the server process, not in the config. No files, no cross-process locks.

### 4octies. Quota-aware durable switch (2026-07-31, backlog #16b, ADR-33)

A 429 can mean two different things, and the status alone cannot tell them apart: a transient rate limit passes on its own, while a spent subscription cycle fails every request until the cycle resets. §4ter treats both as transient, so an exhausted subscription pays a doomed request plus a failover hop on every turn. This section adds the durable half:

- **A central quota matcher registry** (`src/providers/quota.ts`, same discipline as the quirk registry §5: per provider, verification date, never scattered ifs). An entry matches only answers SEEN LIVE meaning "the cycle is spent". Today: `kimicode`, 429 with a message containing "usage limit" and "billing cycle" (observed live 2026-07-29). Deliberately absent: Code Assist `RESOURCE_EXHAUSTED` (the free tier emits it per-minute too, so as a durable signal it would flap) and every generic 429. What is not certain stays transient.
- **The durable switch**: when the ACTIVE profile itself fails with a quota-exhausted answer AND it declares a `failover`, the active profile moves to the failover once, in the config (the same write path as `lupin use`, hot-reload included), and the request continues through the failover as §4ter already did. The switch keys on the exhausted answer, not on the failover's luck with this one request: the primary stays spent either way.
- **Opt-in stays `failover`**: no new config. Declaring a failover already diverts traffic there per-request; the durable switch only stops re-paying a doomed request each turn (user decision 2026-07-31).
- **Never back automatically**: the cycle reset time is not knowable from outside (Kimi's renewed unannounced between 2026-07-29 and 07-31). Switching back is the user's gesture, visible in every surface that reads the config.
- **Visible, never silent**: the failover line carries `quotaSwitch: "<new active>"`; failed requests log `errorMessage` (provider diagnostics, scrubbed by the §-normalizer and truncated to 200 chars, never user content), which is also how the NEXT provider's quota shape gets recorded for this registry. A delegated profile's quota failure never moves the active pointer: only the active profile's own exhaustion does.

### 4nonies. Several accounts on one provider (2026-08-02, backlog #15b, ADR-36)

Two accounts of the same provider (a personal plan and a work plan, two subscriptions bought to double a quota) differ in exactly one thing: which token pays. Everything else, the descriptor, the OAuth flow, the refresh runtime, the lane, belongs to the provider. So an account is **a credential-store key, and therefore a profile**, and nothing else is added:

- **The store key gains an optional account suffix**: `oauth/<provider>` becomes `oauth/<provider>#<account>`. A login with no `--account` still writes the bare key, so no existing credential migrates.
- **`lupin login <provider> --account <label>`** (same flag on `logout`, which forgets ONLY that account). The label is `[A-Za-z0-9._-]{1,32}`: a `#` or a `/` inside it would make the key ambiguous, and a label with spaces would make the profile name unusable, so both are refused at the door rather than sanitized.
- **The profile is derived, not invented**: the default subscription profile `<provider>-sub` becomes `<provider>-sub@<label>`, with `auth.provider` holding the full store key. `oauthDefForProfile` splits the key and looks the descriptor up by its provider half, so both accounts share one flow and one refresh implementation.
- **Independent refresh**: the single-flight lock and the tombstone-on-`invalid_grant` key off the STORE key, not the descriptor id. One account's expired refresh token never disturbs the other's.
- **Rotation is the chain that already exists.** Two accounts are two profiles, so `failover` (§4ter, per request) and the quota-aware durable switch (§4octies, over time) already move traffic from one to the next, in the order the user set from the TUI (ADR-34). No round-robin loop is added: ADR-34 rejected a cyclic chain on purpose, because when every account is spent a loop ping-pongs forever instead of surfacing the exhaustion.
- **Where it shows**: the account is part of the profile name, so every surface that already names the profile (`lupin list`, `/health`, the statusline, the TUI, the log) names the account too, with no new field anywhere.

### 4septies. `init` offers routes and failover, the user decides (2026-07-20)

Routes (§4quater) and failover (§4ter) stay **opt-in and declarative**: Lupin never activates routing silently (ADR-7, confirmed by the user on 2026-07-20: "never auto-activate"). But discovery (§3ter) and the registry already know the data that makes a route sensible, so `lupin init` **offers** what it can infer and the user explicitly accepts or refuses:

- **The `vision` route** (implemented 2026-07-24): when discovery reports a model that declares `vision` **and it is not already the main model**, init offers to map the vision route onto it. A model the runtime says nothing about is never a candidate: silence is not a yes.
- **The `longContext` route** (fixed 2026-07-24): until that day init **announced** an active dynamic threshold while writing no route at all, so the announced routing could never fire (audit `routes-unconfigurable-from-cli`). Now it is a question like the others, offered only when it can change something (real windows known from discovery, and a light model distinct from the main one), and what gets written is the answer. The threshold stays dynamic (80% of the real window of the model serving the request): that part is not asked, it is how the route computes its boundary.
- **Failover**: when another configured profile is already tier-equivalent (same provider or same model tier), init offers to declare it as the failover.

Nothing is written without an explicit `yes`: the default answer is "no". The resulting config is identical to what the user would have written by hand. Lupin only makes the offer; the decision stays human.

### 4quater. Content-aware routing (2026-07-19, from COMPETITIVE steal #1)

Opt-in per profile, declarative. It extends the static slot mapping with overrides based on the CONTENT of the request:

```json
"contextWindows": { "k3": 262144, "k3-mini": 131072 },
"routes": {
  "longContext": { "target": {"profile": "kimi-sub"} },
  "vision":      { "target": "k3" },
  "thinking":    { "target": "k3" }
}
```

Semantics:
- **A fixed evaluation order, one route applied** (the first that matches): `longContext`, then `vision`, then `thinking`. Reason: a context overflow is a hard constraint, vision is a capability constraint, thinking is a preference.
- `longContext`: matches when the estimated input tokens reach the threshold. The estimate is the **cheap heuristic** `chars(serialized body)/4`, because this is routing, not billing: it runs on every request and cannot afford BPE (which stays for `count_tokens`, §7).
- **A dynamic per-model threshold (2026-07-19, user request)**: an explicit `threshold` always wins; when absent, the threshold is `floor(0.8 × the window of the pre-routing resolved model)`, read from `contextWindows` (a model to token map): first in the profile serving the resolved model, then as a fallback in the starting profile. An unknown window for that model means the route does not fire for that request (no invented threshold). The 0.8 margin absorbs the error of the chars/4 heuristic.
- `contextWindows`: values verified with a date. In the defaults for hosted providers (the same rule as model names, §3bis), populated at `init`; for local runtimes they come from the native discovery (§3ter point 5).

### 4quinquies. Verified context windows (2026-07-19)

Rule: **an invented number routes worse than an absent one**. Only what the official documentation states as an exact figure, or where it explicitly declares the K/M factor, enters here; otherwise the model has no window and the `longContext` route simply does not fire.

| Profile | Model | Window | Why it is trustworthy |
|---|---|---|---|
| `kimi` | `kimi-k3` | 1,048,576 | Moonshot states the 1024 factor in its own docs (256K written as 262,144 in prose) |
| `kimi` | `kimi-k2.6` | 262,144 | same |
| `kimi-code` | `k3` | 1,048,576 | same models, different literal ids on the subscription endpoint |
| `kimi-code` | `kimi-for-coding` | 262,144 | same |
| `glm` | `glm-5.2` | 1,000,000 | published as 1M on that specific model |
| `gpt` | `gpt-5.6-sol` / `-terra` / `-luna` | 1,050,000 | every model page writes "1,050,000 context window" in full digits, no shorthand (verified on all three pages separately, 2026-07-19) |
| `gemini` | `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3.1-flash-lite` | 1,048,576 | the "Token limits" table of each model writes "1,048,576" and "65,536" in full digits, that is 2^20 and 2^16: no K/M ambiguity to resolve (2026-07-19) |

**Deliberately excluded**: DeepSeek publishes only "1M"/"384K" as a string, with no digits and no factor. The difference between ×1000 and ×1024 is too large to guess, and none of the official pages (pricing, the V4 news post, the token guide, the API reference) resolves the shorthand. `glm-5-turbo` has no published figure.

*(Gemini and GPT were on this excluded list until 2026-07-19: the research found that both publish full digits, so they moved into the table. DeepSeek stays out.)*

Operational caveats gathered in the same research:

1. **Same provider, different ids per endpoint** (Moonshot): the pay-per-token platform uses `kimi-k3`/`kimi-k2.7-code`, the subscription endpoint uses `k3`/`kimi-for-coding`. A registry that assumes the same id on both endpoints breaks silently. Our defaults already keep them separate (`kimi` vs `kimi-code`).
2. **`glm-5` is not `glm-5.2`**: 200K against 1M. Generalizing "GLM 5.x = 1M" is a silent mistake.
3. **DeepSeek**: `deepseek-chat`/`deepseek-reasoner` deprecated on 2026-07-24. Our defaults already use `deepseek-v4-pro`/`deepseek-v4-flash`, so this does not hit us, but the date is worth watching.
4. **OpenRouter, read at runtime**: `GET /api/v1/models` exposes both `context_length` (declared by the model) and `top_provider.context_length` (the real limit of the provider routed at that moment), and the second **can be smaller**. For a proxy the second is what counts.
5. **DeepSeek: input and output share the budget**: the 384K of output are carved inside the 1M, they do not add up.

Back to route semantics:

- `vision`: matches when the messages contain at least one `image` block.
- `thinking`: matches when `thinking.type` is `enabled` or `adaptive` (not `disabled`, not absent).
- `target`: **the same format as a slot**, a real model name (same profile) or `{"profile": "x"}` (the `requestedModel` is re-resolved against the slots of x, standard delegation).
- **Direct use bypasses the routes**: a model explicitly chosen in the picker is never redirected.
- Routes belong to the starting profile of the attempt (a failover attempt uses the routes of the failover profile).
- **Visible in the logs**: the line carries `routed: "longContext"|"vision"|"thinking"` when a route fires. Never silent.
- Validation: `threshold` is optional and, when present, a positive integer; `longContext` without a `threshold` requires at least one entry in the profile's `contextWindows` (fail fast at load, no runtime surprises); `contextWindows` maps a string to a positive number; `target` must be valid; a referenced profile must exist.

## 5. Quirk registry (extensible)

| Quirk | Effect |
|---|---|
| `maxCompletionTokens` | use `max_completion_tokens` instead of `max_tokens` |
| `noTemperatureOnReasoning` | drop `temperature` and `top_p` |
| `strictToolCallIds` | rewrite `toolu_*` ids to `call_*` (see SPEC-TRANSLATION §2) |
| `sanitizeJsonSchema` | remove `format`, `$ref` and `additionalProperties` from tool schemas |
| `noParallelToolCalls` | set `parallel_tool_calls:false` |
| `singleSystemMessage` | merge multiple system messages into one |
| `stripThinkTags` | remove `<think>...</think>` from the content (see SPEC-TRANSLATION §5bis) |
| `harmonyChannels` | GPT-OSS: keep the `final` channel only |
| `parseTextToolCalls` | convert textual tool calls (`<tool_call>`, Hermes XML, bare JSON) into structured `tool_use` blocks |
| `stripSpecialTokens` | remove leaked special tokens (`<\|im_end\|>` and friends) |
| `looseJsonArguments` | a tolerant JSON parser on the arguments, as a fallback only |
| `clientErrorsWrappedIn500` | the runtime answers HTTP 500 while wrapping the engine's real 4xx in the message: the nested status is read and mapped to a permanent 400 instead of a retryable 529 |
| `stripDoneSentinel` | passthrough: filter the trailing `data: [DONE]` frame from the stream (the OpenRouter Anthropic skin emits it, the Anthropic protocol does not; to be confirmed with an authenticated request before implementing) |
| `raiseStreamIdleTimeout` | `lupin run` launch env: fill `CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000` when the variable is unset (an explicit user value always wins, empty included) |

**`clientErrorsWrappedIn500`** (verified live on LM Studio 2026-07-19, on by default for the `lmstudio` profile): a context overflow arrived as `HTTP 500 {"error":{"message":"Engine ... returned 400: {\"code\":400,\"type\":\"exceed_context_size_error\"}"}}`. The general rule `status >= 500 -> 529 overloaded_error` made it retryable: Claude Code repeated four times a request that could not succeed, and then showed "the API is at capacity", hiding the real cause. The nested status is recognized from `returned <4xx>` in the message or from a 4xx `code` in the wrapped JSON; a genuine 500 (no nested 4xx) stays 529. Not verified on Ollama and llama.cpp: the flag is per profile, not per family.

**`raiseStreamIdleTimeout`** (on by default for the `ds4` profile, 2026-08-02, ADR-35): ds4-server serializes requests on one slot by default, so a request queued behind another gets zero bytes until its turn, and a long prefill on modest hardware is minutes, not seconds. The engine's own reference wrapper for Claude Code sets `CLAUDE_STREAM_IDLE_TIMEOUT_MS=600000` for exactly this; the quirk makes `lupin run` fill the same value when the variable is unset. It is not a mapping quirk: its single implementation lives in `runEnv` (`src/cli/run.ts`), reading the quirks of the profile active at launch. Honest limit: a profile switch AFTER launch cannot re-set the client's env; a session started on a remote profile and switched to ds4 keeps the client default.

Adding a quirk means adding an entry here plus a fixture test. A new model is almost always supported by composing existing quirks: if ad-hoc code seems necessary, first ask whether it can be generalized.

### 5ter. `identityHint`: letting the session say who is really answering (2026-08-02, backlog #9, ADR-39)

Through a proxy the model reads the Claude Code system prompt and introduces itself as Claude, because the prompt says that is what it is. Asking it "who are you?" therefore proves nothing (README §Statusline says the same, which is why `/health` exists). This quirk gives the session an honest answer without a second surface:

- **Opt-in per profile, never on by default** (ADR-7): it edits the request body, and a normalization that fires by itself is exactly what the quirk registry exists to prevent.
- **Appended LAST, always.** One `text` block after the client's own, so every earlier byte is unchanged and the provider's cached prefix, `cache_control` breakpoints included, survives. Prepending would re-prefill the whole harness on every turn, trading a two-line answer for minutes of prefill (§3ter).
- **The text is built at runtime** from the model and provider that really resolved, so no name is written into the sources (rule 5). The client's requested name (`claude-fable-5` and friends) never appears in it.
- **Shapes**: a block array gains a block, a string gains a paragraph, an absent system becomes the hint alone, and an unrecognized shape is left untouched rather than corrupted to add a note.
- **`count_tokens` is never touched**: it is a measurement, and inflating it would make the client budget against a prompt it is not sending.
- **Still untested against the real harness**: whether the Claude Code system prompt argues with the hint (it insists on the assistant's identity in several places) needs a live session. The quirk exists; the claim that it wins does not.

### 5quater. `editRetryHint`: answering a rejected edit once (2026-08-07, ADR-45, the first M5 adapter)

Edits are applied by exact match. Models that are not Claude routinely return content that is right in meaning and wrong in bytes (re-indented, tabs turned into spaces, the trailing newline dropped), the tool refuses, and the expensive part is not the refusal: it is the model resending the same `old_string` for three turns. This quirk says what the rule is once, on the turn where it can still be acted on.

- **Opt-in per profile, never on by default** (ADR-7), same as §5ter: it edits the request body.
- **It repairs nothing.** The proxy does not rewrite `old_string`, and must not: it has neither the file (it sees the conversation, not the workspace) nor any way to know which occurrence was meant, and a fuzzy match that picks the wrong one corrupts a source file. It would also launder the model's own defect, so the doctor would stop measuring the model (§5bis rule 3 exists for that reason).
- **Fires on the last turn only, and only for an edit-shaped call.** The trigger is a `tool_result` with `is_error: true` in the incoming turn whose `tool_use` carried an `old_string` (MultiEdit's `edits[]` included). A `Bash` that exits 1 is a failure this hint has nothing to say about, and a failure five turns back is already answered: repeating it would nag and be paid for every turn.
- **Appended LAST, after the identity block.** §5ter's block is constant for the session while this one comes and goes, so it goes after: every earlier block keeps its index and the cached prefix boundary does not move the first time an edit fails (§3ter).
- **`count_tokens` is never touched**, same reason as §5ter.
- **The mechanism is verified, the efficacy is not.** Fixtures pin when it fires, where it goes and that it is off by default (`test/edit-retry-hint.test.ts`). Whether it actually raises the doctor score on a weak model is the M5 A/B criterion, and it is unmeasured until that run exists.

**The cache-bust detector** (backlog #11c, ADR-40, `src/server/cache-watch.ts`): the same §3ter prefix rule, watched from the numbers the provider already reports. Per profile, in memory, the previous request's `cache_read` and total input are kept. When the cache goes from warm (`cache_read > 0`) to cold (`cache_read == 0`) while the prompt did NOT get smaller, the request logs `cacheBust: true`. That size comparison is what separates a broken prefix from an ordinary new conversation, which also starts cold but starts small, and it needs no invented threshold: the comparison is against what that same profile really sent last time. A provider that reports no cache fields is never judged (absent is not zero, §8) and its history is dropped. **No prompt bytes are held, not even hashed**: the backlog idea was to keep prefixes in memory and diff them, and two integers answer the same question without stretching ADR-12.

## 5bis. The client's identity towards the provider

Lupin presents itself as **`Lupin-porting-CC`**, never as one of the official CLIs. The identity lives in one place (`providers/identity.ts`: name, version, repo URL) and feeds two distinct mechanisms that must not be confused:

| Mechanism | Where | When |
|---|---|---|
| Device identity (`X-Msh-*`) | the OAuth flow (device grant plus refresh) | only on the three OAuth calls: the Kimi console derives the device name from them. Chat calls authenticate with the Bearer and do not want them |
| Attribution headers (`attribution` in the registry) | every request towards the provider, in **both** modes | attribution is per call, not a one-time registration |

Rules:

1. **Documented mechanisms only.** A provider enters the table with a source and a date; headers are not invented in the hope that someone reads them. Verified as **having no** mechanism (2026-07-20): OpenAI (the `user` parameter has been replaced by `safety_identifier`, which is anti-abuse, not a dashboard label), Gemini, DeepSeek, Z.AI.
2. **Never auth-bearing.** If an attribution header disappeared, the dashboard label is lost, never the answer. No error, no retry.
3. **They do not touch the body.** The byte-faithful passthrough invariant (ADR-7) is about the request body: adding transport headers does not violate it and does not move the cache prefix.

**OpenRouter** (source: `openrouter.ai/docs/app-attribution`, verified 2026-07-20):

| Header | Value | Notes |
|---|---|---|
| `HTTP-Referer` | the repo URL | **mandatory**: it is the app's unique id. Without it no app page exists and the title is ignored |
| `X-OpenRouter-Title` | `Lupin-porting-CC` | the displayed name. `X-Title` is the legacy spelling, still accepted |
| `X-OpenRouter-Categories` | `cli-agent` | at most 2 categories per request; unrecognized values are silently discarded |

## 6. Doctor score per profile

Every profile stores the last doctor result (`lastDoctor: {date, score, details}`) and `lupin list` shows it. The public scoreboard (DESIGN, positioning) is the aggregation of these results across the repo's default profiles.
