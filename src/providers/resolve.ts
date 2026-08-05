import type { LupinConfig, ProfileConfig, SlotName } from '../config/config.js';

export type RouteKind = 'longContext' | 'vision' | 'thinking';

// Slot resolution per SPEC-PROVIDERS §4: claude-* names map onto slots by
// substring; a real model name already present in the slots is used directly.

export interface ResolvedTarget {
  profileName: string;
  profile: ProfileConfig;
  model: string;
  slot: SlotName | 'direct';
}

const MAX_DELEGATION_DEPTH = 3;

/**
 * Prefix of the ids published by GET /v1/models (SPEC-PROVIDERS §4.2).
 * Claude Code's gateway discovery keeps ONLY ids matching /^(claude|anthropic)/i
 * (verified on the client binary 2.1.219, 2026-07-24), so a bare `kimi-k3` is
 * dropped before reaching the picker. The prefix buys the model a row; the real
 * name travels in `display_name`, which is what the picker shows. It is stripped
 * again here, so the id the picker sends back lands on the direct-use path.
 */
export const GATEWAY_MODEL_PREFIX = 'claude-lupin-';

/** Publishes a model under a picker-visible id. Inverse of normalizeModelId. */
export function gatewayModelId(model: string): string {
  return `${GATEWAY_MODEL_PREFIX}${model}`;
}

/**
 * Sentinel of the profile-switch rows published in the picker (§4.3, ADR-37).
 * A colon keeps it out of the way of real model names, which use dots, dashes
 * and slashes; the client validates nothing behind a custom base URL, so the id
 * travels back verbatim.
 */
const SWITCH_SENTINEL = 'switch:';

/** The picker id whose pick means `lupin use <profile>`. */
export function profileSwitchId(profileName: string): string {
  return `${GATEWAY_MODEL_PREFIX}${SWITCH_SENTINEL}${profileName}`;
}

/** The profile a picked row names, or undefined when this is an ordinary model id. */
export function profileSwitchTarget(requestedModel: string): string | undefined {
  const id = normalizeModelId(requestedModel);
  if (!id.startsWith(SWITCH_SENTINEL)) return undefined;
  const name = id.slice(SWITCH_SENTINEL.length);
  return name === '' ? undefined : name;
}

export function normalizeModelId(requestedModel: string): string {
  // Sonnet-5-era Claude Code lets users suffix any model id with [1m] (the
  // 1M-context variant, set via /model or settings.json). The suffix is
  // client-side routing info: strip it before matching so direct-use still hits
  // and the upstream never receives a name it does not know (SPEC-PROVIDERS §4).
  const noSuffix = requestedModel.endsWith('[1m]') ? requestedModel.slice(0, -'[1m]'.length) : requestedModel;
  return noSuffix.startsWith(GATEWAY_MODEL_PREFIX) ? noSuffix.slice(GATEWAY_MODEL_PREFIX.length) : noSuffix;
}

export function slotForModel(requestedModel: string): SlotName {
  const m = requestedModel.toLowerCase();
  // fable/mythos: Claude 5 top tier, above Opus (SPEC-PROVIDERS §4)
  if (m.includes('opus') || m.includes('fable') || m.includes('mythos')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet';
}

// --- Content-aware routing (SPEC-PROVIDERS §4quater) -----------------------

/** Cheap chars/4 heuristic: routing threshold, NOT billing (§4quater). */
export function cheapInputEstimate(body: Record<string, unknown>): number {
  return Math.ceil(JSON.stringify(body).length / 4);
}

function hasImageBlock(body: Record<string, unknown>): boolean {
  const messages = body['messages'];
  if (!Array.isArray(messages)) return false;
  for (const m of messages) {
    const content = (m as Record<string, unknown>)['content'];
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if ((block as Record<string, unknown>)['type'] === 'image') return true;
    }
  }
  return false;
}

function isThinkingOn(body: Record<string, unknown>): boolean {
  const t = body['thinking'];
  if (t === null || typeof t !== 'object') return false;
  const type = (t as Record<string, unknown>)['type'];
  return type === 'enabled' || type === 'adaptive';
}

/** Safety margin over the chars/4 heuristic for the dynamic threshold (§4quater). */
const LONG_CONTEXT_FRACTION = 0.8;

/**
 * First matching route in the FIXED order longContext → vision → thinking.
 * `resolvedWindow` is the context window of the pre-routing resolved model:
 * with no explicit threshold, longContext fires at 80% of it (unknown window →
 * the route stays quiet for this request, no invented threshold).
 */
export function routeForContent(
  profile: ProfileConfig,
  body: Record<string, unknown>,
  resolvedWindow?: number,
): RouteKind | undefined {
  const r = profile.routes;
  if (r === undefined) return undefined;
  if (r.longContext !== undefined) {
    const threshold =
      r.longContext.threshold ??
      (resolvedWindow === undefined ? undefined : Math.floor(resolvedWindow * LONG_CONTEXT_FRACTION));
    if (threshold !== undefined && cheapInputEstimate(body) >= threshold) return 'longContext';
  }
  if (r.vision !== undefined && hasImageBlock(body)) return 'vision';
  if (r.thinking !== undefined && isThinkingOn(body)) return 'thinking';
  return undefined;
}

/**
 * Applies the start profile's routes to an already-resolved target.
 * Direct-use (model picker) is never rerouted. Returns the routed target and
 * which route fired, or the input unchanged.
 */
export function applyContentRoutes(
  config: LupinConfig,
  startName: string,
  requestedModel: string,
  resolved: ResolvedTarget,
  body: Record<string, unknown>,
): { resolved: ResolvedTarget; routed?: RouteKind } {
  if (resolved.slot === 'direct') return { resolved };
  const startProfile = config.profiles[startName];
  if (startProfile === undefined) return { resolved };
  const resolvedWindow =
    resolved.profile.contextWindows?.[resolved.model] ?? startProfile.contextWindows?.[resolved.model];
  const kind = routeForContent(startProfile, body, resolvedWindow);
  if (kind === undefined) return { resolved };
  const target = startProfile.routes?.[kind]?.target;
  if (target === undefined) return { resolved };
  if (typeof target === 'string') {
    return {
      resolved: { profileName: startName, profile: startProfile, model: target, slot: resolved.slot },
      routed: kind,
    };
  }
  return { resolved: resolveRequest(config, requestedModel, target.profile), routed: kind };
}

export function resolveRequest(
  config: LupinConfig,
  requestedModel: string,
  startName: string = config.activeProfile,
): ResolvedTarget {
  const start = config.profiles[startName];
  if (start === undefined) throw new Error(`profile "${startName}" not found in config`);

  const requested = normalizeModelId(requestedModel);

  // Direct use: model picker sends real model names (SPEC-PROVIDERS §4 case 2).
  for (const target of Object.values(start.slots)) {
    if (typeof target === 'string' && target === requested) {
      return { profileName: startName, profile: start, model: requested, slot: 'direct' };
    }
  }

  const slot = slotForModel(requested);
  let name = startName;
  let profile = start;
  for (let depth = 0; depth <= MAX_DELEGATION_DEPTH; depth++) {
    const target = profile.slots[slot];
    if (typeof target === 'string') {
      return { profileName: name, profile, model: target, slot };
    }
    name = target.profile;
    const next = config.profiles[name];
    if (next === undefined) throw new Error(`slot "${slot}" delegates to unknown profile "${name}"`);
    profile = next;
  }
  throw new Error(`slot "${slot}" delegation deeper than ${MAX_DELEGATION_DEPTH} profiles (cycle?)`);
}
