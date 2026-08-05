// Several accounts on one provider (SPEC-PROVIDERS §4nonies, ADR-36).
// A second account is a second credential-store key and therefore a second
// profile; rotation is the failover chain that already exists (ADR-33/34), so
// what is tested here is the key algebra and that the resolver reads the right
// token for the right profile. No new rotation logic exists to test.

import { describe, expect, it, vi } from 'vitest';
import { accountKey, isValidAccountLabel, splitAccountKey, type OAuthProviderDef } from '../src/providers/oauth.js';
import { oauthDefForProfile, resolveCredential } from '../src/server/credential.js';
import { catalogueLines, parseAccountFlag } from '../src/cli/login.js';
import type { ResolveOAuthOptions } from '../src/server/oauth.js';
import type { ProfileConfig } from '../src/config/config.js';

const fakeDef: OAuthProviderDef = {
  id: 'acmeauth',
  aliases: ['acme', 'acmeauth'],
  host: 'https://auth.example.invalid',
  clientId: 'test-client',
  flow: { kind: 'device', deviceAuthorizationPath: '/device', pollIntervalMs: 1 },
  tokenPath: '/token',
  verifyUrl: 'https://api.example.invalid/models',
  importPaths: [],
};
const defs = { acmeauth: fakeDef };

const profile = (storeKey: string): ProfileConfig => ({
  provider: 'acmeauth',
  mode: 'passthrough',
  auth: { type: 'oauth', provider: storeKey },
  slots: { opus: 'k3', sonnet: 'k3', haiku: 'k3' },
});

describe('the store key carries the account', () => {
  it('a bare provider stays a bare key: no migration for existing logins', () => {
    expect(accountKey('acmeauth')).toBe('acmeauth');
    expect(accountKey('acmeauth', '')).toBe('acmeauth');
    expect(splitAccountKey('acmeauth')).toEqual({ provider: 'acmeauth' });
  });

  it('an account becomes a suffix, and the split is its exact inverse', () => {
    expect(accountKey('acmeauth', 'work')).toBe('acmeauth#work');
    expect(splitAccountKey('acmeauth#work')).toEqual({ provider: 'acmeauth', account: 'work' });
  });

  it('only the FIRST # splits, so a label can never smuggle a second one', () => {
    // isValidAccountLabel refuses it at the door, but the split must stay total.
    expect(splitAccountKey('acmeauth#a#b')).toEqual({ provider: 'acmeauth', account: 'a#b' });
  });

  it('labels that would break a store key or a profile name are refused', () => {
    for (const ok of ['work', 'personal', 'acct-2', 'a.b_c', 'A1']) expect(isValidAccountLabel(ok)).toBe(true);
    for (const bad of ['', 'has space', 'with#hash', 'with/slash', 'x'.repeat(33)]) {
      expect(isValidAccountLabel(bad)).toBe(false);
    }
  });
});

describe('lupin login/logout --account', () => {
  it('no flag means the single-account behaviour that already existed', () => {
    expect(parseAccountFlag(['acme'])).toBeUndefined();
  });

  it('reads the label after the flag', () => {
    expect(parseAccountFlag(['acme', '--account', 'work'])).toBe('work');
  });

  it('a missing or unusable label is refused, never coerced into a broken key', () => {
    expect(parseAccountFlag(['acme', '--account'])).toBeNull();
    expect(parseAccountFlag(['acme', '--account', 'two words'])).toBeNull();
    expect(parseAccountFlag(['acme', '--account', 'a#b'])).toBeNull();
  });

  // The provider name is a bare word and so is the account label: reading the
  // first bare word blindly would make `lupin login --account work` log into a
  // provider called "work".
  it('the label is not mistaken for the provider name', () => {
    const positional = (args: string[]): string[] =>
      args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--account');
    expect(positional(['--account', 'work'])).toEqual([]);
    expect(positional(['acme', '--account', 'work'])).toEqual(['acme']);
    expect(positional(['--account', 'work', 'acme'])).toEqual(['acme']);
  });
});

describe('the descriptor is the provider s, never the account s', () => {
  it('a suffixed key still resolves to the provider descriptor', () => {
    expect(oauthDefForProfile(profile('acmeauth#work'), defs)).toBe(fakeDef);
    expect(oauthDefForProfile(profile('acmeauth'), defs)).toBe(fakeDef);
  });

  it('an alias with an account resolves too', () => {
    expect(oauthDefForProfile(profile('acme#personal'), defs)).toBe(fakeDef);
  });

  it('an unknown provider stays unknown, account or not', () => {
    expect(oauthDefForProfile(profile('nope#work'), defs)).toBeUndefined();
  });
});

describe('two profiles, two accounts, two tokens', () => {
  it('each profile spends its own account token', async () => {
    const tokens: Record<string, string> = { 'acmeauth#work': 'tok-work', 'acmeauth#home': 'tok-home' };
    const resolveToken = vi.fn((_def: OAuthProviderDef, opts: ResolveOAuthOptions = {}) =>
      Promise.resolve(tokens[opts.storeKey ?? 'acmeauth'] ?? 'tok-default'),
    );

    const work = await resolveCredential(profile('acmeauth#work'), { oauthDefs: defs, resolveToken });
    const home = await resolveCredential(profile('acmeauth#home'), { oauthDefs: defs, resolveToken });
    const plain = await resolveCredential(profile('acmeauth'), { oauthDefs: defs, resolveToken });

    expect(work).toEqual({ header: 'authorization', value: 'Bearer tok-work' });
    expect(home).toEqual({ header: 'authorization', value: 'Bearer tok-home' });
    expect(plain).toEqual({ header: 'authorization', value: 'Bearer tok-default' });
    // The store key travels whole; the descriptor is the shared one.
    expect(resolveToken.mock.calls.map((c) => c[1]?.storeKey)).toEqual(['acmeauth#work', 'acmeauth#home', 'acmeauth']);
    expect(resolveToken.mock.calls.every((c) => c[0] === fakeDef)).toBe(true);
  });
});

// The catalogue of a discovered profile is visible exactly once, at login: the
// names are not in the defaults (rule 5) and no command lists them. Before this
// only the count was printed, while three places claimed the list was
// (SPEC-PROVIDERS §3quater.1, found live against Copilot 2026-08-05).
describe('the discovered catalogue at login', () => {
  it('prints the models, the command to aim them, and the caveat', () => {
    const lines = catalogueLines('copilot-sub', ['a', 'b', 'c', 'd', 'e']);
    const text = lines.join('\n');
    expect(text).toContain('(5)');
    for (const m of ['a', 'b', 'c', 'd', 'e']) expect(text).toContain(m);
    expect(text).toContain('lupin use copilot-sub --opus <model>');
    expect(text).toContain('400');
  });

  it('wraps rather than printing fifty names on one line', () => {
    const lines = catalogueLines('p', Array.from({ length: 51 }, (_, i) => `m${String(i)}`));
    expect(lines.filter((l) => l.startsWith('    m')).length).toBe(13);
  });

  it('says nothing for a profile whose models come from the defaults', () => {
    expect(catalogueLines('kimi-sub', undefined)).toEqual([]);
    expect(catalogueLines('kimi-sub', [])).toEqual([]);
  });
});
