// Connectivity test for key setup (SPEC-CLI §1): one real 1-token request
// against the provider, before anything is saved. Reuses the core request
// mapper for translate providers so the test exercises the same path Claude
// Code will.

import type { DefaultProfileDef } from '../providers/defaults.js';
import type { ProfileConfig } from '../config/config.js';
import { PROVIDERS } from '../providers/registry.js';
import { mapAnthropicRequest, type AnthropicRequest } from '../core/request.js';
import { scrubSecrets } from '../core/errors.js';

export interface ConnectivityResult {
  ok: boolean;
  detail: string;
}

interface KeyProbe {
  provider: string;
  mode: 'passthrough' | 'translate';
  baseUrl?: string;
  auth: 'bearer' | 'x-api-key';
  model: string;
  quirks: string[];
}

async function runKeyProbe(
  probe: KeyProbe,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivityResult> {
  const def = PROVIDERS[probe.provider];
  if (def === undefined) return { ok: false, detail: `unknown provider "${probe.provider}"` };

  const minimal: AnthropicRequest = {
    model: probe.model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (probe.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers['authorization'] = `Bearer ${key}`;

  const baseUrl =
    probe.baseUrl ?? (probe.mode === 'passthrough' ? def.baseUrl : (def.translateBaseUrl ?? def.baseUrl));
  const url =
    probe.mode === 'passthrough' ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
  if (probe.mode === 'passthrough') headers['anthropic-version'] = '2023-06-01';
  const body = probe.mode === 'passthrough' ? minimal : mapAnthropicRequest(minimal, probe.quirks);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, detail: `${probe.model} answers` };
    const text = await res.text();
    return { ok: false, detail: scrubSecrets(`HTTP ${String(res.status)}: ${text}`, [key]).slice(0, 200) };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { ok: false, detail: scrubSecrets(detail, [key]) };
  }
}

export async function testProviderKey(d: DefaultProfileDef, key: string): Promise<ConnectivityResult> {
  const def = PROVIDERS[d.provider];
  if (def === undefined) return { ok: false, detail: `unknown provider "${d.provider}"` };
  // Local profiles never get here: init routes them to the GET /models flow
  // (SPEC-PROVIDERS §3ter) before any key exists to test.
  const slots = d.slots;
  if (slots === undefined) return { ok: false, detail: `profile "${d.id}" has no slots to test` };

  if (d.mode !== 'passthrough' && d.mode !== 'translate') {
    return { ok: false, detail: `profile "${d.id}" uses unsupported mode "${d.mode}"` };
  }
  if (d.auth !== 'bearer' && d.auth !== 'x-api-key') {
    return { ok: false, detail: `profile "${d.id}" has no API-key credential` };
  }
  return await runKeyProbe(
    {
      provider: d.provider,
      mode: d.mode,
      auth: d.auth,
      model: slots.sonnet,
      quirks: d.quirks ?? [],
    },
    key,
  );
}

export async function testConfiguredProfileKey(
  profileName: string,
  profile: ProfileConfig,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectivityResult> {
  if (profile.mode !== 'passthrough' && profile.mode !== 'translate') {
    return { ok: false, detail: `profile "${profileName}" uses unsupported mode "${profile.mode}"` };
  }
  if (profile.auth.type !== 'bearer' && profile.auth.type !== 'x-api-key') {
    return { ok: false, detail: `profile "${profileName}" has no API-key credential` };
  }
  const direct = [profile.slots.sonnet, profile.slots.opus, profile.slots.haiku].find(
    (target): target is string => typeof target === 'string',
  );
  if (direct === undefined) {
    return { ok: false, detail: `profile "${profileName}" has no direct model to test` };
  }
  return await runKeyProbe(
    {
      provider: profile.provider,
      mode: profile.mode,
      ...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
      auth: profile.auth.type,
      model: direct,
      quirks: profile.quirks ?? [],
    },
    key,
    fetchImpl,
  );
}
