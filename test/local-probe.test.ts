import { describe, expect, it } from 'vitest';
import { mergeProbe, persistableWindow, probeLocalModels } from '../src/providers/local.js';
import { PROVIDERS } from '../src/providers/registry.js';

// Shapes captured live on 2026-07-19 (Ollama 0.21.0, LM Studio) — SPEC-PROVIDERS §3ter.

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return ((url: string) => {
    const path = new URL(url).pathname;
    const body = routes[path];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as unknown as typeof fetch;
}

const ollamaDef = PROVIDERS['ollama'];
const lmStudioDef = PROVIDERS['lmstudio'];
const llamaCppDef = PROVIDERS['llamacpp'];
const ds4Def = PROVIDERS['ds4'];
if (ollamaDef === undefined || lmStudioDef === undefined || llamaCppDef === undefined || ds4Def === undefined) {
  throw new Error('local providers missing from the registry');
}

/** Exactly what append_model_json_values() writes (ds4_server.c, 2026-07-24). */
function ds4Model(id: string, ctx: number): Record<string, unknown> {
  return {
    id,
    object: 'model',
    created: 1767225600,
    owned_by: 'ds4.c',
    name: 'DeepSeek-V4-Flash',
    context_length: ctx,
    top_provider: { context_length: ctx, max_completion_tokens: ctx, is_moderated: false },
    supported_parameters: [
      'tools',
      'tool_choice',
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'min_p',
      'stop',
      'seed',
      'stream',
      'reasoning_effort',
    ],
  };
}

describe('probeLocalModels (SPEC-PROVIDERS §3ter)', () => {
  it('Ollama: context window from the arch-namespaced key, tools from capabilities', async () => {
    const fetchImpl = fakeFetch({
      '/api/tags': { models: [{ name: 'qwen3.5:latest' }] },
      '/api/show': {
        model_info: { 'qwen35.context_length': 262144, 'qwen35.block_count': 48 },
        capabilities: ['completion', 'vision', 'tools', 'thinking'],
      },
    });
    expect(await probeLocalModels(ollamaDef, { fetchImpl })).toEqual([
      {
        id: 'qwen3.5:latest',
        contextWindow: 262144,
        contextWindowSource: 'max',
        supportsTools: true,
        supportsVision: true,
        chat: true,
      },
    ]);
  });

  it('Ollama: a model without the tools capability is reported as such', async () => {
    const fetchImpl = fakeFetch({
      '/api/tags': { models: [{ name: 'plain:7b' }] },
      '/api/show': { model_info: { 'llama.context_length': 8192 }, capabilities: ['completion'] },
    });
    const [model] = await probeLocalModels(ollamaDef, { fetchImpl });
    expect(model?.supportsTools).toBe(false);
    expect(model?.contextWindow).toBe(8192);
  });

  it('LM Studio: one call carries window and model type', async () => {
    const fetchImpl = fakeFetch({
      '/api/v0/models': {
        data: [
          { id: 'ternary-bonsai-27b', type: 'vlm', max_context_length: 4096 },
          { id: 'nomic-embed', type: 'embeddings', max_context_length: 2048 },
        ],
      },
    });
    expect(await probeLocalModels(lmStudioDef, { fetchImpl })).toEqual([
      { id: 'ternary-bonsai-27b', contextWindow: 4096, contextWindowSource: 'max', supportsVision: true, chat: true },
      { id: 'nomic-embed', contextWindow: 2048, contextWindowSource: 'max', supportsVision: false, chat: false },
    ]);
  });

  // Captured live 2026-07-19: the model advertises 262144 but runs with 8192.
  // Taking the advertised number would put the long-context threshold 25x above
  // the point where the model actually overflows.
  it('LM Studio: a loaded model reports the window it really runs with, plus capabilities', async () => {
    const fetchImpl = fakeFetch({
      '/api/v0/models': {
        data: [
          {
            id: 'google/gemma-4-12b-qat',
            type: 'vlm',
            state: 'loaded',
            max_context_length: 262144,
            loaded_context_length: 8192,
            capabilities: ['tool_use'],
          },
        ],
      },
    });
    expect(await probeLocalModels(lmStudioDef, { fetchImpl })).toEqual([
      {
        id: 'google/gemma-4-12b-qat',
        contextWindow: 8192,
        contextWindowSource: 'loaded',
        supportsTools: true,
        supportsVision: true,
        chat: true,
      },
    ]);
  });

  it('llama.cpp: the loaded model and its n_ctx', async () => {
    const fetchImpl = fakeFetch({
      '/props': { model_path: '/models/qwen2.5-coder-7b.gguf', default_generation_settings: { n_ctx: 32768 } },
    });
    expect(await probeLocalModels(llamaCppDef, { fetchImpl })).toEqual([
      { id: 'qwen2.5-coder-7b.gguf', contextWindow: 32768, contextWindowSource: 'loaded', chat: true },
    ]);
  });

  // ds4-server reports its own ctx_size, i.e. the window the server was started
  // with: the served truth, unlike the advertised maximum of the other runtimes.
  // Both ids are aliases of the single loaded GGUF (README §Server).
  it('ds4: served window and tool support, one entry per model alias', async () => {
    const fetchImpl = fakeFetch({
      '/v1/models': { object: 'list', data: [ds4Model('deepseek-v4-flash', 100000), ds4Model('deepseek-v4-pro', 100000)] },
    });
    expect(await probeLocalModels(ds4Def, { fetchImpl })).toEqual([
      { id: 'deepseek-v4-flash', contextWindow: 100000, contextWindowSource: 'loaded', supportsTools: true, chat: true },
      { id: 'deepseek-v4-pro', contextWindow: 100000, contextWindowSource: 'loaded', supportsTools: true, chat: true },
    ]);
  });

  // The server's default --ctx is 32768 (ds4_server.c), below the harness floor:
  // a served window is trusted provenance, so init persists it and warns instead
  // of letting the session discover the refusal mid-request.
  it('ds4: the default 32768 window is persistable, being served and not advertised', async () => {
    const fetchImpl = fakeFetch({ '/v1/models': { object: 'list', data: [ds4Model('deepseek-v4-flash', 32768)] } });
    const [model] = await probeLocalModels(ds4Def, { fetchImpl });
    if (model === undefined) throw new Error('no model probed');
    expect(persistableWindow(model, 50_000)).toBe(32768);
  });

  it('a runtime that is down yields nothing instead of throwing', async () => {
    const fetchImpl = (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch;
    expect(await probeLocalModels(ollamaDef, { fetchImpl })).toEqual([]);
  });

  it('a hosted provider has no local metadata API', async () => {
    const openai = PROVIDERS['openai'];
    if (openai === undefined) throw new Error('openai missing');
    expect(await probeLocalModels(openai)).toEqual([]);
  });
});

describe('mergeProbe', () => {
  it('keeps /v1/models authoritative for ids and fills in what the probe knew', () => {
    expect(mergeProbe(['a', 'b'], [{ id: 'a', contextWindow: 100, supportsTools: true, chat: true }])).toEqual([
      { id: 'a', contextWindow: 100, supportsTools: true, chat: true },
      { id: 'b', chat: true },
    ]);
  });
});

// Audit 2026-07-22 gap `local-window-knowledge-poisoned`: init persisted the
// ADVERTISED window regardless of provenance, so a model advertising 262144
// while serving 8192 armed the longContext threshold ~26x past reality and
// sailed the doctor preflight straight into the ADR-23 incident. A 'max'
// window is an upper bound: proof of refusal (bound below the harness floor)
// is trustworthy, proof of fitness is not.
describe('persistableWindow (what init may write into contextWindows)', () => {
  const FLOOR = 50_000;

  it('a loaded window is the served truth: persisted as-is', () => {
    expect(persistableWindow({ id: 'm', chat: true, contextWindow: 65_536, contextWindowSource: 'loaded' }, FLOOR)).toBe(
      65_536,
    );
  });

  it('a max window at or above the floor proves nothing: NOT persisted', () => {
    expect(
      persistableWindow({ id: 'm', chat: true, contextWindow: 262_144, contextWindowSource: 'max' }, FLOOR),
    ).toBeUndefined();
  });

  it('a max window below the floor is a certain refusal: persisted', () => {
    expect(persistableWindow({ id: 'm', chat: true, contextWindow: 40_960, contextWindowSource: 'max' }, FLOOR)).toBe(
      40_960,
    );
  });

  it('a window without provenance is treated like max, not like loaded', () => {
    expect(persistableWindow({ id: 'm', chat: true, contextWindow: 262_144 }, FLOOR)).toBeUndefined();
    expect(persistableWindow({ id: 'm', chat: true, contextWindow: 8_192 }, FLOOR)).toBe(8_192);
  });

  it('no window, nothing to persist', () => {
    expect(persistableWindow({ id: 'm', chat: true }, FLOOR)).toBeUndefined();
  });
});
