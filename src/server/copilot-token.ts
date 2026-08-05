// The second token of GitHub Copilot (SPEC-PROVIDERS §3quater, ADR-38).
//
// A GitHub OAuth token does not pay for inference. It buys a SHORT-LIVED
// Copilot token from an exchange endpoint, and that answer also names the API
// host this account must use: the well-known host is a fallback, never an
// assumption. One central implementation flagged from the descriptor
// (`tokenExchange`), so the request path never grows a provider check
// (CLAUDE.md rule 4).

export interface CopilotToken {
  /** Bearer for the inference calls. */
  token: string;
  /** Epoch ms after which it must be exchanged again. */
  expiresAt: number;
  /** The API base this account is served from. */
  apiBaseUrl: string;
}

/** Documented default, used only when the exchange does not name a host. */
const DEFAULT_API_BASE = 'https://api.githubcopilot.com';

/**
 * Exchange this long BEFORE the server-declared deadline. The official client
 * uses the same margin, and it is what keeps a long streaming request from
 * starting on a token that dies mid-answer.
 */
const REFRESH_MARGIN_MS = 60_000;

interface Cached extends CopilotToken {
  /** The GitHub token this was bought with: a re-login must invalidate it. */
  source: string;
}

const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<CopilotToken>>();

/** Test seam and `lupin logout`: forget everything bought with these credentials. */
export function clearCopilotTokenCache(storeKey?: string): void {
  if (storeKey === undefined) {
    cache.clear();
    inflight.clear();
    return;
  }
  cache.delete(storeKey);
  inflight.delete(storeKey);
}

export class CopilotExchangeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CopilotExchangeError';
  }
}

async function exchange(url: string, githubToken: string, fetchImpl: typeof fetch, now: number): Promise<CopilotToken> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: {
        // GitHub's own scheme for this endpoint: `token`, not `Bearer`.
        authorization: `token ${githubToken}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CopilotExchangeError(0, `Copilot token exchange unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    // 401 here means the GitHub token is fine but this account has no Copilot
    // entitlement, which is the single most likely failure: say so plainly.
    const detail = res.status === 401 || res.status === 403 ? ' (no active Copilot subscription on this account?)' : '';
    throw new CopilotExchangeError(res.status, `Copilot token exchange answered ${String(res.status)}${detail}`);
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new CopilotExchangeError(res.status, 'Copilot token exchange did not answer JSON');
  }
  const token = body['token'];
  if (typeof token !== 'string' || token === '') {
    throw new CopilotExchangeError(res.status, 'Copilot token exchange answered without a token');
  }
  // `refresh_in` is seconds and is the field the official client honours;
  // `expires_at` (epoch seconds) is used as a fallback when it is absent.
  const refreshIn = body['refresh_in'];
  const expiresAtSec = body['expires_at'];
  const deadline =
    typeof refreshIn === 'number'
      ? now + refreshIn * 1000
      : typeof expiresAtSec === 'number'
        ? expiresAtSec * 1000
        : now + 25 * 60 * 1000; // neither field: assume the documented ~30 min, minus the margin below
  const endpoints = body['endpoints'];
  const apiBase =
    endpoints !== null && typeof endpoints === 'object' && typeof (endpoints as Record<string, unknown>)['api'] === 'string'
      ? ((endpoints as Record<string, unknown>)['api'] as string)
      : DEFAULT_API_BASE;
  return { token, expiresAt: Math.max(now, deadline - REFRESH_MARGIN_MS), apiBaseUrl: apiBase };
}

/**
 * The cached Copilot token for these credentials, exchanging when it is missing,
 * stale, or was bought with a different GitHub token. Single-flight per store
 * key, like the OAuth refresh: a burst of requests buys one token.
 */
export async function resolveCopilotToken(args: {
  storeKey: string;
  url: string;
  githubToken: string;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<CopilotToken> {
  const now = args.now ?? Date.now();
  const hit = cache.get(args.storeKey);
  if (hit !== undefined && hit.source === args.githubToken && hit.expiresAt > now) {
    return { token: hit.token, expiresAt: hit.expiresAt, apiBaseUrl: hit.apiBaseUrl };
  }
  let flight = inflight.get(args.storeKey);
  if (flight === undefined) {
    flight = exchange(args.url, args.githubToken, args.fetchImpl ?? fetch, now)
      .then((fresh) => {
        cache.set(args.storeKey, { ...fresh, source: args.githubToken });
        return fresh;
      })
      .finally(() => inflight.delete(args.storeKey));
    inflight.set(args.storeKey, flight);
  }
  return await flight;
}
