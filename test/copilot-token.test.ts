// The Copilot two-token exchange (SPEC-PROVIDERS §3quater, ADR-38).
// Nothing here has ever run against the real service: the shapes come from the
// official client bundle and from an independent implementation that agree with
// each other (research 2026-08-02). The tests pin OUR behaviour against those
// shapes, and are honest about being fixtures, not captures.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCopilotTokenCache, CopilotExchangeError, resolveCopilotToken } from '../src/server/copilot-token.js';
import { resolveCredential } from '../src/server/credential.js';
import type { OAuthProviderDef } from '../src/providers/oauth.js';
import type { ProfileConfig } from '../src/config/config.js';

const URL_ = 'https://api.example.invalid/copilot_internal/v2/token';

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => clearCopilotTokenCache());

describe('what the exchange reads from the answer', () => {
  it('takes the token, the deadline from refresh_in, and the account API host', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(answer({ token: 'tid=abc;exp=1', refresh_in: 1500, endpoints: { api: 'https://api.acme.invalid' } })),
    );
    const t = await resolveCopilotToken({
      storeKey: 'k',
      url: URL_,
      githubToken: 'gho_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1_000_000,
    });
    expect(t.token).toBe('tid=abc;exp=1');
    // refresh_in is seconds, and the exchange happens a minute BEFORE the
    // deadline so a long stream never starts on a dying token.
    expect(t.expiresAt).toBe(1_000_000 + 1500 * 1000 - 60_000);
    expect(t.apiBaseUrl).toBe('https://api.acme.invalid');
  });

  it('the well-known host is only a fallback, never an assumption', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', refresh_in: 100 })));
    const t = await resolveCopilotToken({
      storeKey: 'k',
      url: URL_,
      githubToken: 'gho_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(t.apiBaseUrl).toBe('https://api.githubcopilot.com');
  });

  it('falls back to expires_at when refresh_in is absent', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', expires_at: 2000 })));
    const t = await resolveCopilotToken({
      storeKey: 'k',
      url: URL_,
      githubToken: 'gho_1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: 1_000_000,
    });
    expect(t.expiresAt).toBe(2000 * 1000 - 60_000);
  });

  it('sends the GitHub token with GitHub s scheme for this endpoint', async () => {
    const fetchImpl = vi.fn((_u: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('token gho_secret');
      return Promise.resolve(answer({ token: 't', refresh_in: 100 }));
    });
    await resolveCopilotToken({
      storeKey: 'k',
      url: URL_,
      githubToken: 'gho_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe('when it fails', () => {
  it('a 401 names the likeliest cause instead of a bare status', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ message: 'Bad credentials' }, 401)));
    await expect(
      resolveCopilotToken({ storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/no active Copilot subscription/);
  });

  it('an answer without a token is an error, never an empty Bearer', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ refresh_in: 100 })));
    await expect(
      resolveCopilotToken({ storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toBeInstanceOf(CopilotExchangeError);
  });

  it('a failed exchange is not cached: the next request tries again', async () => {
    let ok = false;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(ok ? answer({ token: 't', refresh_in: 100 }) : answer({ message: 'boom' }, 500)),
    );
    const args = { storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch };
    await expect(resolveCopilotToken(args)).rejects.toBeInstanceOf(CopilotExchangeError);
    ok = true;
    await expect(resolveCopilotToken(args)).resolves.toHaveProperty('token', 't');
  });
});

describe('caching', () => {
  it('a live token is reused instead of bought again', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', refresh_in: 1500 })));
    const args = { storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch };
    await resolveCopilotToken(args);
    await resolveCopilotToken(args);
    await resolveCopilotToken(args);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('an expired one is bought again', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', refresh_in: 100 })));
    const args = { storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch };
    await resolveCopilotToken({ ...args, now: 1_000_000 });
    await resolveCopilotToken({ ...args, now: 1_000_000 + 200_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // A re-login replaces the GitHub token: a Copilot token bought with the old
  // one must never survive it.
  it('a different GitHub token invalidates the cached one', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', refresh_in: 1500 })));
    const base = { storeKey: 'k', url: URL_, fetchImpl: fetchImpl as unknown as typeof fetch };
    await resolveCopilotToken({ ...base, githubToken: 'old' });
    await resolveCopilotToken({ ...base, githubToken: 'new' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('two accounts of the same provider hold separate tokens', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(answer({ token: 't', refresh_in: 1500 })));
    const base = { url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch };
    await resolveCopilotToken({ ...base, storeKey: 'copilot#work' });
    await resolveCopilotToken({ ...base, storeKey: 'copilot#home' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  // Found by review, not by a failure: on a 401 the ingress re-resolves the
  // credential with forceOAuthRefresh. For this provider the OAuth token never
  // expires, so that force is a no-op, and without dropping the BOUGHT token
  // the retry would send back the very Bearer the provider just refused.
  it('the reactive 401 path drops the bought token, so the retry sends a new one', async () => {
    let n = 0;
    const fetchImpl = vi.fn(() => {
      n += 1;
      return Promise.resolve(answer({ token: `t${String(n)}`, refresh_in: 1500 }));
    });
    const profile: ProfileConfig = {
      provider: 'acmeauth',
      mode: 'translate',
      auth: { type: 'oauth', provider: 'acmeauth' },
      slots: { opus: 'm', sonnet: 'm', haiku: 'm' },
    };
    const defs = {
      acmeauth: {
        id: 'acmeauth',
        aliases: ['acme'],
        host: 'https://auth.example.invalid',
        clientId: 'c',
        flow: { kind: 'device', deviceAuthorizationPath: '/d', pollIntervalMs: 1 },
        tokenPath: '/t',
        verifyUrl: 'https://example.invalid',
        importPaths: [],
        nonExpiringToken: true,
        tokenExchange: URL_,
      } satisfies OAuthProviderDef,
    };
    const resolveToken = (): Promise<string> => Promise.resolve('gho_stable');

    const first = await resolveCredential(profile, {
      oauthDefs: defs,
      resolveToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const retry = await resolveCredential(profile, {
      oauthDefs: defs,
      resolveToken,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      forceOAuthRefresh: true,
    });
    expect(first.value).toBe('Bearer t1');
    expect(retry.value).toBe('Bearer t2');
  });

  it('a burst of requests buys exactly one token', async () => {
    let resolveIt: ((r: Response) => void) | undefined;
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((r) => {
          resolveIt = r;
        }),
    );
    const args = { storeKey: 'k', url: URL_, githubToken: 'g', fetchImpl: fetchImpl as unknown as typeof fetch };
    const all = Promise.all([resolveCopilotToken(args), resolveCopilotToken(args), resolveCopilotToken(args)]);
    resolveIt?.(answer({ token: 't', refresh_in: 1500 }));
    await all;
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
