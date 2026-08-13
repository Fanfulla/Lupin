// Hosted-provider model catalogue (design 2026-08-13). The registry carries
// the capability (`catalogApi`, rule 4) and this module does the one fetch,
// the normalization and the 10-minute cache. The catalogue INFORMS the TUI's
// assisted input, it never gates a write (ADR-42: the check is real data or
// it is nothing). No credential is ever sent: the endpoint is public.

import type { ProviderDef } from './registry.js';

export interface CatalogModel {
  id: string;
  name?: string;
  /** The router's advertised window, not a per-plan promise. */
  contextWindow?: number;
  /** Declared tool support: without tools Claude Code cannot run a step. */
  supportsTools?: boolean;
  /** USD per token, as published. */
  promptPrice?: number;
  completionPrice?: number;
}

export type CatalogResult = { ok: true; models: CatalogModel[] } | { ok: false; error: string };

export interface CatalogOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Test seam for the cache clock. */
  now?: number;
}

const CATALOG_TTL_MS = 10 * 60_000;

// Module-level on purpose (same reasoning as the control jobs): the daemon
// owns the cache so every TUI keystroke is served from memory, and a hot
// reload of the app does not re-pay the fetch.
const cache = new Map<string, { at: number; models: CatalogModel[] }>();

export function clearCatalogCache(): void {
  cache.clear();
}

/** One row as OpenRouter publishes it; every field beyond `id` is optional. */
interface WireRow {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  top_provider?: { context_length?: unknown };
  supported_parameters?: unknown;
  pricing?: { prompt?: unknown; completion?: unknown };
}

function price(v: unknown): number | undefined {
  if (typeof v !== 'string' && typeof v !== 'number') return undefined;
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function normalizeRow(row: WireRow): CatalogModel | undefined {
  if (typeof row.id !== 'string' || row.id === '') return undefined;
  const params = Array.isArray(row.supported_parameters)
    ? row.supported_parameters.filter((p): p is string => typeof p === 'string')
    : undefined;
  const prompt = price(row.pricing?.prompt);
  const completion = price(row.pricing?.completion);
  // The routed limit beats the model's declared maximum (§4quinquies: "for a
  // proxy the second is what counts"; the recorded fixture has a real 3.8x
  // gap). The declared figure is only the fallback.
  const routed = row.top_provider?.context_length;
  const window =
    typeof routed === 'number' && routed > 0
      ? routed
      : typeof row.context_length === 'number' && row.context_length > 0
        ? row.context_length
        : undefined;
  return {
    id: row.id,
    ...(typeof row.name === 'string' && row.name !== '' ? { name: row.name } : {}),
    ...(window !== undefined ? { contextWindow: window } : {}),
    ...(params !== undefined ? { supportsTools: params.includes('tools') } : {}),
    ...(prompt !== undefined ? { promptPrice: prompt } : {}),
    ...(completion !== undefined ? { completionPrice: completion } : {}),
  };
}

/**
 * The provider's published model list, normalized. Failures are a verdict,
 * not an exception, and are never cached: the next keystroke may retry.
 */
export async function fetchCatalog(def: ProviderDef, opts: CatalogOptions = {}): Promise<CatalogResult> {
  const api = def.catalogApi;
  if (api === undefined) return { ok: false, error: `provider "${def.id}" publishes no catalogue` };
  const now = opts.now ?? Date.now();
  const hit = cache.get(def.id);
  if (hit !== undefined && now - hit.at < CATALOG_TTL_MS) return { ok: true, models: hit.models };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(api.url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
    const body = (await res.json()) as { data?: unknown[] };
    // A 200 whose body is not the published shape (a rate-limit envelope, a
    // renamed field) is a FAILURE, or it would be cached as an authoritative
    // empty catalogue for the whole TTL.
    if (!Array.isArray(body.data)) throw new Error('unexpected response shape (no "data" array)');
    const rows = body.data as WireRow[];
    const models = rows.map(normalizeRow).filter((m): m is CatalogModel => m !== undefined);
    cache.set(def.id, { at: now, models });
    return { ok: true, models };
  } catch (e) {
    return {
      ok: false,
      error: `catalogue unreachable at ${api.url}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
