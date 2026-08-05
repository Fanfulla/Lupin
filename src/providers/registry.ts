// Declarative provider registry (SPEC-PROVIDERS §2). Data only: no logic here.
// `verified` = last check against official docs. No model names in sources
// (CLAUDE.md rule 5): models live in config profiles only.

import { CLIENT_NAME, CLIENT_URL } from './identity.js';

export type ProviderMode = 'passthrough' | 'translate' | 'responses' | 'codeassist';
export type AuthScheme = 'x-api-key' | 'bearer';

/** Native metadata API of a local runtime: richer than OpenAI's /v1/models. */
export type LocalApiKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'ds4';

export interface ProviderDef {
  id: string;
  /** Supported modes, preferred first (passthrough when available: DECISIONS #5). */
  modes: ProviderMode[];
  baseUrl: string;
  /** Base for translate egress when it differs from baseUrl (dual-mode providers). */
  translateBaseUrl?: string;
  auth: AuthScheme;
  /** Local runtimes only: dialect of the metadata API and where it lives. */
  localApi?: { kind: LocalApiKind; baseUrl: string };
  /**
   * Static headers that let the provider dashboard attribute traffic to Lupin
   * (SPEC-PROVIDERS §5bis). Sent on every request: attribution is per-call, not
   * a one-time registration. Never auth-bearing: dropping them costs the
   * label, never the request. Only providers with a documented mechanism.
   */
  attribution?: Record<string, string>;
  /**
   * Headers the provider REQUIRES on every inference call. Unlike `attribution`
   * these are not cosmetic: dropping them costs the request, not a label.
   * Copilot answers 400 "missing Editor-Version header" without them, the most
   * reported integration bug of every proxy that fronts it.
   */
  requiredHeaders?: Record<string, string>;
  verified: string;
}

export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    id: 'anthropic',
    modes: ['passthrough'],
    baseUrl: 'https://api.anthropic.com',
    auth: 'x-api-key',
    verified: '2026-07-18',
  },
  moonshot: {
    id: 'moonshot',
    modes: ['passthrough'],
    baseUrl: 'https://api.moonshot.ai/anthropic',
    auth: 'bearer',
    verified: '2026-07-18',
  },
  // Kimi Code subscription: distinct host and credential from the Moonshot
  // platform (console key, up to 5 per account, SPEC-PROVIDERS §3bis).
  kimicode: {
    id: 'kimicode',
    modes: ['passthrough'],
    baseUrl: 'https://api.kimi.com/coding',
    auth: 'bearer',
    verified: '2026-07-18',
  },
  deepseek: {
    id: 'deepseek',
    modes: ['passthrough'],
    baseUrl: 'https://api.deepseek.com/anthropic',
    auth: 'bearer',
    verified: '2026-07-18',
  },
  zai: {
    id: 'zai',
    modes: ['passthrough'],
    baseUrl: 'https://api.z.ai/api/anthropic',
    auth: 'bearer',
    verified: '2026-07-18',
  },
  // Anthropic-skin passthrough works for Anthropic-family models only
  // (official OpenRouter docs, 2026-07-18); other models need translate (M2).
  openrouter: {
    id: 'openrouter',
    modes: ['passthrough', 'translate'],
    baseUrl: 'https://openrouter.ai/api',
    translateBaseUrl: 'https://openrouter.ai/api/v1',
    auth: 'bearer',
    // openrouter.ai/docs/app-attribution (verified 2026-07-20): HTTP-Referer is
    // the identity key and the app's unique id. Without it no app page exists
    // and the title is ignored. X-Title is the legacy spelling of the title
    // header; X-OpenRouter-Title is the current one.
    attribution: {
      'HTTP-Referer': CLIENT_URL,
      'X-OpenRouter-Title': CLIENT_NAME,
      'X-OpenRouter-Categories': 'cli-agent',
    },
    verified: '2026-07-18',
  },
  openai: {
    id: 'openai',
    modes: ['translate'],
    baseUrl: 'https://api.openai.com/v1',
    auth: 'bearer',
    verified: '2026-07-18',
  },
  // The ChatGPT subscription backend (M6a). A Codex/ChatGPT OAuth token does
  // NOT spend on api.openai.com (403 api.model.read): it spends here, on the
  // Responses API, which is why this is its own provider and its own lane.
  // Served slugs (2026-07-29): gpt-5.6-terra, gpt-5.6-luna, gpt-5.5,
  // gpt-5.4-mini, codex-auto-review.
  openaisub: {
    id: 'openaisub',
    modes: ['responses'],
    baseUrl: 'https://chatgpt.com/backend-api/wham',
    auth: 'bearer',
    verified: '2026-07-29 (live: /responses 200 end to end, /models at client_version=1.0.0)',
  },
  // The Gemini Code Assist backend (M6b). A Google OAuth token does NOT spend
  // on generativelanguage.googleapis.com: it spends here, on the Code Assist
  // wrapper over generateContent, which is why this is its own provider and its
  // own lane. The base URL carries no trailing slash: the API's methods are
  // `:suffixes` on it (`:loadCodeAssist`, `:streamGenerateContent`).
  // Models served to a FREE tier account (2026-07-29): gemini-2.5-flash and
  // gemini-3.1-flash-lite answer 200; every pro model answers 429.
  geminisub: {
    id: 'geminisub',
    modes: ['codeassist'],
    baseUrl: 'https://cloudcode-pa.googleapis.com/v1internal',
    auth: 'bearer',
    verified: '2026-07-29 (live: :loadCodeAssist, :generateContent and :streamGenerateContent all 200)',
  },
  // Google's own OpenAI-compatibility layer (DECISIONS #9: no native adapter
  // until its limits actually bite). The docs call it beta "while we extend
  // feature support", but tool calling and streaming (the two this proxy
  // cannot do without) are both documented with working examples.
  gemini: {
    id: 'gemini',
    modes: ['translate'],
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'bearer',
    verified: '2026-07-19 (official doc ai.google.dev/gemini-api/docs/openai, updated 2026-06-22)',
  },
  // Local providers (SPEC-PROVIDERS §3ter): no credential, models chosen at
  // init from the live /v1/models of the local server. Ollama and LM Studio
  // serve a native Anthropic /v1/messages: passthrough-first, translate kept
  // as fallback (same port, /v1 OpenAI-compat surface).
  ollama: {
    id: 'ollama',
    modes: ['passthrough', 'translate'],
    baseUrl: 'http://127.0.0.1:11434',
    translateBaseUrl: 'http://127.0.0.1:11434/v1',
    auth: 'bearer',
    localApi: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
    verified: '2026-07-19 (live 0.21.0: /v1/messages with thinking/usage, count_tokens 404 → estimate §8)',
  },
  lmstudio: {
    id: 'lmstudio',
    modes: ['passthrough', 'translate'],
    baseUrl: 'http://127.0.0.1:1234',
    translateBaseUrl: 'http://127.0.0.1:1234/v1',
    auth: 'bearer',
    localApi: { kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234' },
    verified: '2026-07-19 (live: /v1/messages answers with an Anthropic-style error, /v1/models fine)',
  },
  // DwarfStar (ds4-server): serves a native Anthropic /v1/messages plus the
  // OpenAI-compat surface on the same port, so passthrough-first like the other
  // Anthropic-native locals. Its /v1/models carries the SERVED window (the
  // --ctx the server was started with), which is exactly the number the
  // discovery wants. No credential: the server checks no Authorization header,
  // the placeholder token in its docs is there only because clients demand one.
  ds4: {
    id: 'ds4',
    modes: ['passthrough', 'translate'],
    baseUrl: 'http://127.0.0.1:8000',
    translateBaseUrl: 'http://127.0.0.1:8000/v1',
    auth: 'bearer',
    localApi: { kind: 'ds4', baseUrl: 'http://127.0.0.1:8000' },
    verified: '2026-08-02 (docs + ds4_server.c source at HEAD 54b36ed: Anthropic /v1/messages, /v1/models, default host/port 127.0.0.1:8000; endpoints unchanged since 2026-07-24)',
  },
  // GitHub Copilot (2026-08-02, never live-verified). The OAuth token buys a
  // short-lived token at exchange time, and THAT answer names the API host, so
  // the base here is only the documented fallback (§3quater). Translate lane:
  // the backend does expose an Anthropic-shaped /v1/messages, but nobody has
  // shown it answering a plain exchanged token, and the one mature third-party
  // implementation goes through /chat/completions for every model, Claude
  // included. Passthrough stays unclaimed until someone proves it (ADR-38).
  copilot: {
    id: 'copilot',
    modes: ['translate'],
    baseUrl: 'https://api.githubcopilot.com',
    auth: 'bearer',
    // Read from the official client bundle and confirmed by an independent
    // implementation (2026-08-02). Honest identity where the protocol allows
    // it: the integration id and the editor pair name the client Copilot
    // expects, and Lupin does not claim to be a human's editor beyond that.
    requiredHeaders: {
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot-chat/0.35.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'X-GitHub-Api-Version': '2025-10-01',
      'openai-intent': 'conversation-panel',
    },
    verified: '2026-08-02 (official @github/copilot-language-server bundle plus an independent implementation; device-code endpoint observed live. NO live inference call has ever been made)',
  },
  llamacpp: {
    id: 'llamacpp',
    modes: ['translate'],
    baseUrl: 'http://127.0.0.1:8080/v1',
    auth: 'bearer',
    localApi: { kind: 'llamacpp', baseUrl: 'http://127.0.0.1:8080' },
    verified: '2026-07-19 (default llama-server, never tested live)',
  },
};
