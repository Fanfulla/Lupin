// Provider catalogue (design 2026-08-13): normalization from a recorded
// OpenRouter response, the 10-minute cache, and the honest failure shapes.
// The recording is real provider output (TESTING.md rule), truncated to 5
// rows. It lives in test/recordings/, NOT test/fixtures/: that directory
// belongs to the translation fixture runner, which rejects any other shape.

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearCatalogCache, fetchCatalog, type CatalogModel } from '../src/providers/catalog.js';
import type { ProviderDef } from '../src/providers/registry.js';

const fixture = readFileSync(join(import.meta.dirname, 'recordings', 'openrouter-models.json'), 'utf8');

function defWithCatalog(): ProviderDef {
  return {
    id: 'test-catalog',
    modes: ['translate'],
    baseUrl: 'https://example.test',
    auth: 'bearer',
    catalogApi: { url: 'https://example.test/models' },
    verified: '2026-08-13',
  };
}

function fetchOk(body: string): { impl: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init !== undefined ? { init } : {}) });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;
  return { impl, calls };
}

beforeEach(() => {
  clearCatalogCache();
});

describe('fetchCatalog', () => {
  it('normalizes the recorded OpenRouter response', async () => {
    const { impl } = fetchOk(fixture);
    const result = await fetchCatalog(defWithCatalog(), { fetchImpl: impl });
    if (!result.ok) throw new Error(result.error);
    expect(result.models).toHaveLength(5);
    const first = result.models[0] as CatalogModel;
    expect(first.id).toBe('bytedance-seed/seed-2-1-turbo');
    expect(first.name).toBe('ByteDance Seed: Seed 2.1 Turbo');
    expect(first.contextWindow).toBe(262144);
    expect(first.supportsTools).toBe(true);
    // pricing arrives as USD-per-token strings and becomes numbers
    expect(first.promptPrice).toBeCloseTo(0.0000005, 10);
    expect(first.completionPrice).toBeCloseTo(0.0000025, 10);
    // The routed limit wins over the declared maximum (§4quinquies): the
    // recorded qwen row advertises 1M but its top provider serves 262144.
    const qwen = result.models[1] as CatalogModel;
    expect(qwen.id).toBe('qwen/qwen3.8-2.4t-a95b');
    expect(qwen.contextWindow).toBe(262_144);
  });

  it('sends no credential and no headers beyond the bare GET', async () => {
    const { impl, calls } = fetchOk(fixture);
    await fetchCatalog(defWithCatalog(), { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://example.test/models');
    const headers = calls[0]?.init?.headers;
    expect(headers ?? {}).toEqual({});
  });

  it('tolerates rows with missing fields and drops rows without an id', async () => {
    const body = JSON.stringify({
      data: [
        { id: 'bare/model' },
        { name: 'no id at all' },
        { id: 'odd/prices', pricing: { prompt: 'free', completion: '' } },
        { id: 'no-tools/listed', supported_parameters: ['temperature'] },
      ],
    });
    const { impl } = fetchOk(body);
    const result = await fetchCatalog(defWithCatalog(), { fetchImpl: impl });
    if (!result.ok) throw new Error(result.error);
    expect(result.models.map((m) => m.id)).toEqual(['bare/model', 'odd/prices', 'no-tools/listed']);
    expect(result.models[0]).toEqual({ id: 'bare/model' });
    expect(result.models[1]).toEqual({ id: 'odd/prices' });
    expect(result.models[2]).toEqual({ id: 'no-tools/listed', supportsTools: false });
  });

  it('caches per provider for ten minutes', async () => {
    const { impl, calls } = fetchOk(fixture);
    const def = defWithCatalog();
    await fetchCatalog(def, { fetchImpl: impl, now: 1_000_000 });
    const again = await fetchCatalog(def, { fetchImpl: impl, now: 1_000_000 + 9 * 60_000 });
    expect(calls).toHaveLength(1);
    if (!again.ok) throw new Error(again.error);
    expect(again.models).toHaveLength(5);
  });

  it('refetches after the TTL', async () => {
    const { impl, calls } = fetchOk(fixture);
    const def = defWithCatalog();
    await fetchCatalog(def, { fetchImpl: impl, now: 1_000_000 });
    await fetchCatalog(def, { fetchImpl: impl, now: 1_000_000 + 11 * 60_000 });
    expect(calls).toHaveLength(2);
  });

  it('answers ok:false when the fetch fails, without caching the failure', async () => {
    const failing = (() => Promise.reject(new Error('boom'))) as typeof fetch;
    const def = defWithCatalog();
    const result = await fetchCatalog(def, { fetchImpl: failing });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    expect(result.error).toContain('https://example.test/models');
    // a later call with a working fetch succeeds: the failure was not cached
    const { impl } = fetchOk(fixture);
    const retry = await fetchCatalog(def, { fetchImpl: impl });
    expect(retry.ok).toBe(true);
  });

  it('answers ok:false on a non-2xx status', async () => {
    const impl = (() => Promise.resolve(new Response('nope', { status: 500 }))) as typeof fetch;
    const result = await fetchCatalog(defWithCatalog(), { fetchImpl: impl });
    expect(result.ok).toBe(false);
  });

  it('treats a 200 without a data array as a failure and does not cache it', async () => {
    const wrongShape = (() =>
      Promise.resolve(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 200 }))) as typeof fetch;
    const def = defWithCatalog();
    const result = await fetchCatalog(def, { fetchImpl: wrongShape });
    expect(result.ok).toBe(false);
    // the failure was not cached as an authoritative empty catalogue
    const { impl } = fetchOk(fixture);
    const retry = await fetchCatalog(def, { fetchImpl: impl });
    if (!retry.ok) throw new Error(retry.error);
    expect(retry.models).toHaveLength(5);
  });

  it('answers ok:false for a provider without a catalogue', async () => {
    const def: ProviderDef = { ...defWithCatalog() };
    delete def.catalogApi;
    const result = await fetchCatalog(def);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    expect(result.error).toContain('test-catalog');
  });
});
