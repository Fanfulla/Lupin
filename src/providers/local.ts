// Local runtime discovery (SPEC-PROVIDERS §3ter).
//
// OpenAI's /v1/models is a bare id list. The native APIs of the local runtimes
// carry what actually decides whether a session will work: the model's context
// window, and (on Ollama) whether it declares tool support at all. Asking
// them costs one request at `init` and answers, for free, the question every
// competitor leaves to trial and error: "will this model survive Claude Code?"
//
// The per-runtime dialects are dispatched here and nowhere else; the registry
// carries the flag (CLAUDE.md rule 4).

import type { ProviderDef } from './registry.js';

export interface LocalModelInfo {
  id: string;
  /** Usable context in tokens: the loaded window when the runtime reports one. */
  contextWindow?: number;
  /**
   * `loaded` = the window the model is actually running with. `max` = the
   * model's theoretical maximum, which the load parameters can cut by a lot
   * (observed 2026-07-19: gemma-4-12b advertises 262144, loaded at 8192).
   */
  contextWindowSource?: 'loaded' | 'max';
  /**
   * Declared tool support. `false` is a hard warning at init: without tools
   * Claude Code cannot run a single step. `undefined` = runtime does not say.
   */
  supportsTools?: boolean;
  /**
   * Declared image support. Feeds the §4septies vision-route offer at init:
   * without a model that can read images, offering the route would be routing
   * pictures at a blind model. `undefined` = runtime does not say.
   */
  supportsVision?: boolean;
  /** Runtime says the model is an embedder or otherwise not a chat model. */
  chat: boolean;
}

export interface ProbeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Which window `init` may persist into the profile's `contextWindows`
 * (§4quinquies principle: a made-up window routes worse than an absent one).
 * A 'loaded' window is the served truth. A 'max' window is an upper bound:
 * persisting it would arm the longContext threshold and the doctor preflight
 * with a number up to 32x the served window (observed live 2026-07-19,
 * gemma-4-12b: advertised 262144, loaded 8192). It is persisted ONLY when even
 * the bound cannot hold the harness (`floor`): proof of refusal is
 * trustworthy, proof of fitness is not. No provenance = treated like 'max'.
 */
export function persistableWindow(m: LocalModelInfo, floor: number): number | undefined {
  if (m.contextWindow === undefined) return undefined;
  if (m.contextWindowSource === 'loaded') return m.contextWindow;
  return m.contextWindow < floor ? m.contextWindow : undefined;
}

/** Never throws: an unreachable or unknown runtime yields an empty list. */
export async function probeLocalModels(def: ProviderDef, opts: ProbeOptions = {}): Promise<LocalModelInfo[]> {
  const local = def.localApi;
  if (local === undefined) return [];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    switch (local.kind) {
      case 'ollama':
        return await probeOllama(local.baseUrl, fetchImpl, timeoutMs);
      case 'lmstudio':
        return await probeLmStudio(local.baseUrl, fetchImpl, timeoutMs);
      case 'llamacpp':
        return await probeLlamaCpp(local.baseUrl, fetchImpl, timeoutMs);
      case 'ds4':
        return await probeDs4(local.baseUrl, fetchImpl, timeoutMs);
    }
  } catch {
    return [];
  }
}

async function getJson(url: string, fetchImpl: typeof fetch, timeoutMs: number, body?: unknown): Promise<unknown> {
  const init: RequestInit = { signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetchImpl(url, init);
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  return await res.json();
}

/**
 * Ollama: /api/tags lists models, /api/show details one. The context length key
 * is namespaced by architecture (`qwen35.context_length`), so it is found by
 * suffix, never by a hardcoded model name (rule 5). Verified live on 0.21.0.
 */
async function probeOllama(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalModelInfo[]> {
  const tags = (await getJson(`${baseUrl}/api/tags`, fetchImpl, timeoutMs)) as { models?: { name?: unknown }[] };
  const names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => typeof n === 'string');
  const infos = await Promise.all(
    names.map(async (id): Promise<LocalModelInfo> => {
      try {
        const show = (await getJson(`${baseUrl}/api/show`, fetchImpl, timeoutMs, { model: id })) as {
          model_info?: Record<string, unknown>;
          capabilities?: unknown;
        };
        const caps = Array.isArray(show.capabilities) ? show.capabilities.filter((c) => typeof c === 'string') : [];
        const ctxEntry = Object.entries(show.model_info ?? {}).find(([k]) => k.endsWith('.context_length'));
        const ctx = typeof ctxEntry?.[1] === 'number' ? ctxEntry[1] : undefined;
        return {
          id,
          // /api/show reports the model's own maximum; the served window
          // depends on num_ctx at load time.
          ...(ctx !== undefined ? { contextWindow: ctx, contextWindowSource: 'max' as const } : {}),
          supportsTools: caps.includes('tools'),
          ...(caps.length > 0 ? { supportsVision: caps.includes('vision') } : {}),
          chat: caps.length === 0 || caps.includes('completion'),
        };
      } catch {
        return { id, chat: true }; // /api/show failed: keep the model, say nothing about it
      }
    }),
  );
  return infos;
}

/**
 * LM Studio: one call to the native /api/v0/models returns everything. A loaded
 * model additionally reports `loaded_context_length` and `capabilities`, and the
 * loaded window is the one that matters: verified live 2026-07-19, where
 * gemma-4-12b advertised 262144 while running with 8192.
 */
async function probeLmStudio(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalModelInfo[]> {
  interface LmModel {
    id: string;
    type?: unknown;
    max_context_length?: unknown;
    loaded_context_length?: unknown;
    capabilities?: unknown;
  }
  const body = (await getJson(`${baseUrl}/api/v0/models`, fetchImpl, timeoutMs)) as { data?: LmModel[] };
  return (body.data ?? [])
    .filter((m): m is LmModel => typeof m.id === 'string')
    .map((m) => {
      const loaded = typeof m.loaded_context_length === 'number' ? m.loaded_context_length : undefined;
      const max = typeof m.max_context_length === 'number' ? m.max_context_length : undefined;
      const window = loaded ?? max;
      const caps = Array.isArray(m.capabilities) ? m.capabilities.filter((c) => typeof c === 'string') : undefined;
      return {
        id: m.id,
        ...(window !== undefined ? { contextWindow: window, contextWindowSource: loaded !== undefined ? ('loaded' as const) : ('max' as const) } : {}),
        // Only a loaded model reports capabilities; silence stays silence.
        ...(caps !== undefined ? { supportsTools: caps.includes('tool_use') } : {}),
        // `vlm` is LM Studio's own word for a vision model, and it is reported
        // whether or not the model is loaded (unlike capabilities).
        ...(typeof m.type === 'string' ? { supportsVision: m.type === 'vlm' } : {}),
        chat: m.type !== 'embeddings',
      };
    });
}

/** llama.cpp serves a single model; /props reports the loaded context size. */
async function probeLlamaCpp(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalModelInfo[]> {
  const props = (await getJson(`${baseUrl}/props`, fetchImpl, timeoutMs)) as {
    default_generation_settings?: { n_ctx?: unknown };
    model_path?: unknown;
    n_ctx?: unknown;
  };
  const ctx = props.default_generation_settings?.n_ctx ?? props.n_ctx;
  const path = typeof props.model_path === 'string' ? props.model_path : '';
  const id = path === '' ? '' : (path.split(/[\\/]/).pop() ?? '');
  if (id === '') return [];
  // llama-server only ever serves what it loaded, so n_ctx is the real window.
  return [{ id, ...(typeof ctx === 'number' ? { contextWindow: ctx, contextWindowSource: 'loaded' as const } : {}), chat: true }];
}

/**
 * ds4-server: its /v1/models is richer than plain OpenAI. `context_length` is
 * the server's own ctx_size, i.e. the window it was started with: the served
 * truth, not an advertised maximum. `supported_parameters` lists what the
 * endpoint accepts, tools included. The ids are aliases of the single loaded
 * GGUF: they all describe the same model. Verified on the official docs and on
 * ds4_server.c (send_models/append_model_json_values), 2026-07-24.
 */
async function probeDs4(baseUrl: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<LocalModelInfo[]> {
  interface Ds4Model {
    id?: unknown;
    context_length?: unknown;
    supported_parameters?: unknown;
  }
  const body = (await getJson(`${baseUrl}/v1/models`, fetchImpl, timeoutMs)) as { data?: Ds4Model[] };
  return (body.data ?? [])
    .filter((m): m is Ds4Model & { id: string } => typeof m.id === 'string')
    .map((m) => {
      const ctx = typeof m.context_length === 'number' ? m.context_length : undefined;
      const params = Array.isArray(m.supported_parameters)
        ? m.supported_parameters.filter((p) => typeof p === 'string')
        : undefined;
      return {
        id: m.id,
        ...(ctx !== undefined ? { contextWindow: ctx, contextWindowSource: 'loaded' as const } : {}),
        ...(params !== undefined ? { supportsTools: params.includes('tools') } : {}),
        chat: true,
      };
    });
}

/** Merges probe metadata onto the plain /v1/models list, which stays authoritative for ids. */
export function mergeProbe(ids: readonly string[], probed: readonly LocalModelInfo[]): LocalModelInfo[] {
  const byId = new Map(probed.map((p) => [p.id, p]));
  return ids.map((id) => byId.get(id) ?? { id, chat: true });
}
