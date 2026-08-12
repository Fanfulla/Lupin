// Default profiles for `lupin init` (SPEC-PROVIDERS §3bis). Data only: the
// ONE sanctioned place for model names in the tree (CLAUDE.md rule 5), every
// entry carries its verification date. Slot philosophy: opus=frontier,
// sonnet=daily driver, haiku=cheap/fast for subagents and background calls.

import type { RoutesConfig, SlotName } from '../config/config.js';

export interface DefaultProfileDef {
  /** Suggested profile name (also the wizard's choice id). */
  id: string;
  provider: string;
  mode: 'passthrough' | 'translate' | 'responses' | 'codeassist';
  /** Honest one-liner shown in the wizard. */
  description: string;
  /** Env var the credential is stored under. Absent for local providers (auth "none"). */
  apiKeyEnv?: string;
  auth: 'bearer' | 'x-api-key' | 'none';
  /**
   * Absent for local providers: their model names cannot live in defaults
   * (every machine has its own), the wizard picks them from the live
   * GET /v1/models (SPEC-PROVIDERS §3ter).
   */
  slots?: Record<SlotName, string>;
  /**
   * Model → context window in tokens, for the dynamic longContext threshold
   * (SPEC-PROVIDERS §4quater). Only entries whose official docs state the exact
   * figure, or state the K/M factor explicitly, belong here: an invented number
   * routes worse than no number at all, so an unverified model simply has none.
   */
  contextWindows?: Record<string, number>;
  /**
   * Opt-in "economy overflow" variant. The behaviour users actually described
   * is not "replace the strong model" but "cheap by default, strong when the
   * task earns it": the bulk of a session lands on the sonnet slot, so pointing
   * that at the cheaper model and adding routes that escalate on thinking or
   * long context buys most of the saving without losing the hard cases.
   * Built entirely from slots and routes we already have.
   */
  economy?: { slots: Record<SlotName, string>; routes: RoutesConfig; description: string };
  quirks?: string[];
  /** Marks the init local flow: no key prompt, slots from the live server. */
  local?: true;
  /**
   * Subscription-only profile: reachable through `lupin login`, never through
   * the init key wizard (there is no API key to paste). Filtered out of the
   * init picker; `lupin login` builds the profile from it.
   */
  oauthOnly?: true;
  /** Hint printed when the local server is down. */
  startHint?: string;
  verified: string;
}

export const DEFAULT_PROFILES: DefaultProfileDef[] = [
  {
    id: 'kimi',
    provider: 'moonshot',
    mode: 'passthrough',
    description: 'Kimi K3 (Moonshot platform, pay-per-token): native passthrough, reliable',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    auth: 'bearer',
    slots: { opus: 'kimi-k3', sonnet: 'kimi-k3', haiku: 'kimi-k2.6' },
    // Moonshot is the one provider whose docs state the K factor outright
    // (256K written = 262144 confirmed in prose), so these convert safely.
    contextWindows: { 'kimi-k3': 1_048_576, 'kimi-k2.6': 262_144 },
    economy: {
      slots: { opus: 'kimi-k3', sonnet: 'kimi-k2.6', haiku: 'kimi-k2.6' },
      routes: { thinking: { target: 'kimi-k3' }, longContext: { target: 'kimi-k3' } },
      description: 'daily work on K2.6, K3 when the task calls for reasoning or a long context',
    },
    verified: '2026-07-18 (context windows 2026-07-19)',
  },
  {
    id: 'kimi-code',
    provider: 'kimicode',
    mode: 'passthrough',
    description: 'Kimi Code (flat subscription): passthrough, key from the Kimi Code console',
    apiKeyEnv: 'KIMI_CODE_API_KEY',
    auth: 'bearer',
    slots: { opus: 'k3', sonnet: 'k3', haiku: 'kimi-for-coding' },
    // Same models as the platform endpoint but different literal ids: the
    // subscription endpoint spells them k3 / kimi-for-coding.
    contextWindows: { k3: 1_048_576, 'kimi-for-coding': 262_144 },
    economy: {
      slots: { opus: 'k3', sonnet: 'kimi-for-coding', haiku: 'kimi-for-coding' },
      routes: { thinking: { target: 'k3' }, longContext: { target: 'k3' } },
      description: 'daily work on kimi-for-coding, k3 for reasoning or a long context',
    },
    verified: '2026-07-18 (context windows 2026-07-19)',
  },
  {
    id: 'deepseek',
    provider: 'deepseek',
    mode: 'passthrough',
    description: 'DeepSeek V4 (pay-per-token): native passthrough, cheap',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    auth: 'bearer',
    slots: { opus: 'deepseek-v4-pro', sonnet: 'deepseek-v4-pro', haiku: 'deepseek-v4-flash' },
    verified: '2026-07-18',
  },
  {
    id: 'glm',
    provider: 'zai',
    mode: 'passthrough',
    description: 'GLM-5.2 (Z.AI flat coding plan): native passthrough',
    apiKeyEnv: 'ZAI_API_KEY',
    auth: 'bearer',
    slots: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5-turbo' },
    // Only 5.2 carries the 1M window: plain glm-5 stays at 200K, so the family
    // number cannot be generalized. glm-5-turbo has no published figure.
    contextWindows: { 'glm-5.2': 1_000_000 },
    economy: {
      slots: { opus: 'glm-5.2', sonnet: 'glm-5-turbo', haiku: 'glm-5-turbo' },
      // No longContext route here: glm-5-turbo publishes no window, and a route
      // without one would never fire (§4quater).
      routes: { thinking: { target: 'glm-5.2' } },
      description: 'daily work on glm-5-turbo, glm-5.2 when the task calls for reasoning',
    },
    verified: '2026-07-18 (context windows 2026-07-19)',
  },
  {
    id: 'openrouter',
    provider: 'openrouter',
    mode: 'translate',
    description: 'OpenRouter (300+ models, a single key): translate, the universal fallback',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    auth: 'bearer',
    slots: {
      opus: 'moonshotai/kimi-k3',
      sonnet: 'deepseek/deepseek-v4-pro',
      haiku: 'deepseek/deepseek-v4-flash',
    },
    verified: '2026-08-12 (slugs re-verified live against GET /api/v1/models, all with tools plus tool_choice)',
  },
  {
    id: 'gpt',
    provider: 'openai',
    mode: 'translate',
    description: 'GPT-5.6 (OpenAI, pay-per-token): translate, sol/terra/luna on the slots',
    apiKeyEnv: 'OPENAI_API_KEY',
    auth: 'bearer',
    slots: { opus: 'gpt-5.6-sol', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.6-luna' },
    // Each model page states the figure in full digits, not K/M shorthand, so
    // there is nothing to infer: "1,050,000 context window" (verified on all
    // three pages separately, 2026-07-19).
    contextWindows: { 'gpt-5.6-sol': 1_050_000, 'gpt-5.6-terra': 1_050_000, 'gpt-5.6-luna': 1_050_000 },
    quirks: ['maxCompletionTokens', 'noTemperatureOnReasoning'],
    verified: '2026-07-18 (context windows 2026-07-19)',
  },
  // ChatGPT subscription through OAuth (M6a): the Responses API over WHAM, not
  // the pay-per-token platform. Slugs read from the live /models on 2026-07-29
  // (client_version=1.0.0), which is the only place they are published.
  {
    id: 'openai-sub',
    provider: 'openaisub',
    mode: 'responses',
    description: 'ChatGPT subscription (Sign in with ChatGPT): the Responses API, no API key',
    auth: 'none', // the credential is the OAuth token, not a key: see lupin login openai
    oauthOnly: true,
    slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.6-terra', haiku: 'gpt-5.4-mini' },
    economy: {
      slots: { opus: 'gpt-5.6-terra', sonnet: 'gpt-5.4-mini', haiku: 'gpt-5.4-mini' },
      routes: { thinking: { target: 'gpt-5.6-terra' } },
      description: 'daily work on gpt-5.4-mini, terra when the task calls for reasoning',
    },
    verified: '2026-07-29 (live /models, and /responses 200 end to end)',
  },
  // The Gemini subscription (M6b), built like openai-sub: the OAuth token
  // spends on Code Assist, never on the public endpoint, so it needs its own
  // provider and lane rather than a mode flag on the pay-per-token profile.
  // The slots say what each tier MEANS, and the lane refuses what the account
  // cannot serve. On a free tier account (verified 2026-07-29) every pro model
  // answers 429 RESOURCE_EXHAUSTED, so only `sonnet` is served there and the
  // other slots come back with an explanation instead of a misleading quota
  // error. `sonnet` is deliberately the served one: it is the slot Claude Code
  // starts on, so a free account works without touching /model.
  {
    id: 'gemini-sub',
    provider: 'geminisub',
    mode: 'codeassist',
    description: 'Gemini Code Assist subscription (Sign in with Google): no API key',
    auth: 'none', // the credential is the OAuth token: see lupin login gemini
    oauthOnly: true,
    slots: { opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-2.5-flash', haiku: 'gemini-3.1-flash-lite' },
    verified: '2026-07-29 (live: :streamGenerateContent 200, text and tool call; pro models 429 on the free tier)',
  },
  {
    id: 'gemini',
    provider: 'gemini',
    mode: 'translate',
    description: 'Gemini (Google, pay-per-token): translate through the official OpenAI-compat endpoint',
    apiKeyEnv: 'GEMINI_API_KEY',
    auth: 'bearer',
    slots: { opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-3.5-flash', haiku: 'gemini-3.1-flash-lite' },
    // 1048576 = 2^20 and 65536 = 2^16 are written out in full in each model's
    // spec table, so no K/M ambiguity to resolve (verified 2026-07-19).
    contextWindows: {
      'gemini-3.1-pro-preview': 1_048_576,
      'gemini-3.5-flash': 1_048_576,
      'gemini-3.1-flash-lite': 1_048_576,
    },
    economy: {
      slots: { opus: 'gemini-3.1-pro-preview', sonnet: 'gemini-3.1-flash-lite', haiku: 'gemini-3.1-flash-lite' },
      routes: { thinking: { target: 'gemini-3.1-pro-preview' } },
      description: 'daily work on flash-lite, pro when the task calls for reasoning',
    },
    verified: '2026-07-19',
  },
  // Local providers (SPEC-PROVIDERS §3ter): no key, slots picked at init from
  // the live /v1/models. Ollama and LM Studio ship a native Anthropic
  // /v1/messages (verified live 2026-07-19): passthrough, no translation risk.
  // llama.cpp stays translate: expect mid-low doctor scores until §5bis
  // dialect normalization lands: the honest verdict, not a bug.
  {
    id: 'ollama',
    provider: 'ollama',
    mode: 'passthrough',
    description: 'Ollama, local (native passthrough): models come from your server, no keys',
    auth: 'none',
    local: true,
    startHint: 'ollama serve',
    verified: '2026-07-19',
  },
  {
    id: 'lmstudio',
    provider: 'lmstudio',
    mode: 'passthrough',
    description: 'LM Studio, local (native passthrough): models come from your server, no keys',
    auth: 'none',
    local: true,
    startHint: 'lms server start',
    // Verified live 2026-07-19: a context overflow came back as HTTP 500
    // wrapping the engine's permanent 400, which the default mapping would
    // turn into a retryable 529 (four useless retries, misleading message).
    quirks: ['clientErrorsWrappedIn500'],
    verified: '2026-07-19',
  },
  // ds4-server (DwarfStar): Anthropic-native like Ollama and LM Studio, but the
  // models are fixed by the GGUF loaded at startup, so the slots still come
  // from the live /v1/models (which here also states the served window).
  {
    id: 'ds4',
    provider: 'ds4',
    mode: 'passthrough',
    description: 'ds4-server, local (native Anthropic passthrough): DeepSeek V4 / GLM 5.2 on your own hardware',
    auth: 'none',
    local: true,
    startHint: './ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192',
    // The server runs one request at a time and a queued one gets zero bytes
    // until its turn (SPEC-PROVIDERS §3ter fact 9, ADR-35).
    quirks: ['raiseStreamIdleTimeout'],
    verified: '2026-08-02 (source re-verified at HEAD 54b36ed, ds4_server.c unchanged since 2026-07-24; still no live verification: minimum hardware not available)',
  },
  // GitHub Copilot (2026-08-02). NO slots on purpose: the catalogue changes
  // often and not one of its model ids has been verified against a live
  // account, so writing names here would break rule 5 in the worst way, by
  // inventing them. `lupin login copilot` reads the real list from the
  // account's own /models and fills the slots with what it finds, exactly as
  // the local runtimes do at init (SPEC-PROVIDERS §3quater).
  {
    id: 'copilot-sub',
    provider: 'copilot',
    mode: 'translate',
    description: 'GitHub Copilot subscription (device-flow login): models read live from your account',
    auth: 'none', // the credential is the OAuth token, not a key: see lupin login copilot
    oauthOnly: true,
    verified: '2026-08-02 (auth and endpoints from the official client bundle; NO live inference call ever made)',
  },
  {
    id: 'llamacpp',
    provider: 'llamacpp',
    mode: 'translate',
    description: 'llama.cpp server, local (translate): the OpenAI-compat endpoint of llama-server',
    auth: 'none',
    local: true,
    startHint: 'llama-server -m <modello.gguf>',
    verified: '2026-07-19',
  },
];
