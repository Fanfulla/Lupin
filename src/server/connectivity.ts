// Connectivity test for `lupin init` (SPEC-CLI §1): one real 1-token request
// against the provider, before anything is saved. Reuses the core request
// mapper for translate providers so the test exercises the same path Claude
// Code will.

import type { DefaultProfileDef } from '../providers/defaults.js';
import { PROVIDERS } from '../providers/registry.js';
import { mapAnthropicRequest, type AnthropicRequest } from '../core/request.js';

export interface ConnectivityResult {
  ok: boolean;
  detail: string;
}

export async function testProviderKey(d: DefaultProfileDef, key: string): Promise<ConnectivityResult> {
  const def = PROVIDERS[d.provider];
  if (def === undefined) return { ok: false, detail: `unknown provider "${d.provider}"` };
  // Local profiles never get here: init routes them to the GET /models flow
  // (SPEC-PROVIDERS §3ter) before any key exists to test.
  const slots = d.slots;
  if (slots === undefined) return { ok: false, detail: `profile "${d.id}" has no slots to test` };

  const minimal: AnthropicRequest = {
    model: slots.sonnet,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (d.auth === 'x-api-key') headers['x-api-key'] = key;
  else headers['authorization'] = `Bearer ${key}`;

  let url: string;
  let body: unknown;
  if (d.mode === 'passthrough') {
    url = `${def.baseUrl}/v1/messages`;
    headers['anthropic-version'] = '2023-06-01';
    body = minimal;
  } else {
    url = `${def.translateBaseUrl ?? def.baseUrl}/chat/completions`;
    body = mapAnthropicRequest(minimal, d.quirks ?? []);
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, detail: `${slots.sonnet} answers` };
    const text = (await res.text()).slice(0, 200);
    return { ok: false, detail: `HTTP ${String(res.status)}: ${text}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
