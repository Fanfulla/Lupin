// identityHint (SPEC-PROVIDERS §5ter, ADR-39): the opt-in quirk that makes a
// session able to answer "who is really serving this?". It edits the request
// body, so the two things worth pinning are that it is OFF unless asked for,
// and that it appends rather than prepends: everything before it must stay
// byte-identical or the provider's cached prefix dies (§3ter).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityHintText, withIdentityHint } from '../src/core/quirks.js';
import { createApp } from '../src/server/ingress.js';
import { saveConfig, type LupinConfig } from '../src/config/config.js';

describe('where the hint goes', () => {
  it('appends to a block array, leaving every earlier block untouched', () => {
    const system = [
      { type: 'text', text: 'you are Claude Code' },
      { type: 'text', text: 'harness rules', cache_control: { type: 'ephemeral' } },
    ];
    const out = withIdentityHint(system, 'a-model', 'a-provider') as Record<string, unknown>[];
    expect(out).toHaveLength(3);
    // Byte-identical prefix: same objects, same order, cache breakpoint intact.
    expect(out[0]).toEqual(system[0]);
    expect(out[1]).toEqual(system[1]);
    expect(out[2]).toEqual({ type: 'text', text: identityHintText('a-model', 'a-provider') });
  });

  it('keeps a string system a string', () => {
    const out = withIdentityHint('be helpful', 'm', 'p');
    expect(typeof out).toBe('string');
    expect(out).toBe(`be helpful\n\n${identityHintText('m', 'p')}`);
  });

  it('an absent system becomes just the hint', () => {
    expect(withIdentityHint(undefined, 'm', 'p')).toEqual([{ type: 'text', text: identityHintText('m', 'p') }]);
  });

  it('a shape it does not understand is left alone, never corrupted', () => {
    const weird = { unexpected: true };
    expect(withIdentityHint(weird, 'm', 'p')).toBe(weird);
  });

  it('the text names the model and the provider, and nothing else invented', () => {
    const t = identityHintText('some-model', 'some-provider');
    expect(t).toContain('some-model');
    expect(t).toContain('some-provider');
  });
});

describe('through the proxy', () => {
  let dir: string;
  let prevDir: string | undefined;
  const TOKEN = 'tok';
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  const config = (quirks?: string[]): LupinConfig => ({
    activeProfile: 'p',
    port: 0,
    localToken: TOKEN,
    profiles: {
      p: {
        provider: 'moonshot',
        mode: 'passthrough',
        baseUrl: 'http://127.0.0.1:1',
        auth: { type: 'bearer', apiKeyRef: 'K' },
        slots: { opus: 'the-model', sonnet: 'the-model', haiku: 'the-model' },
        ...(quirks === undefined ? {} : { quirks }),
      },
    },
  });

  beforeEach(() => {
    prevDir = process.env.LUPIN_DIR;
    dir = mkdtempSync(join(tmpdir(), 'lupin-hint-'));
    process.env.LUPIN_DIR = dir;
    process.env['K'] = 'k';
    saveConfig(config());
  });

  afterEach(() => {
    if (prevDir === undefined) delete process.env.LUPIN_DIR;
    else process.env.LUPIN_DIR = prevDir;
    delete process.env['K'];
    rmSync(dir, { recursive: true, force: true });
  });

  const send = async (quirks?: string[]): Promise<Record<string, unknown>> => {
    const fetchImpl = vi.fn((_u: string | URL | Request, _i?: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const app = createApp(config(quirks), { fetchImpl: fetchImpl as unknown as typeof fetch, logger: () => undefined });
    await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'claude-fable-5', system: [{ type: 'text', text: 'harness' }], messages: [] }),
    });
    return JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  };

  it('is OFF unless the profile asks for it (ADR-7: never on by default)', async () => {
    const sent = await send();
    expect(sent['system']).toEqual([{ type: 'text', text: 'harness' }]);
  });

  // Found by reading the code, not by a failing test: the dispatch runs AGAIN
  // on the failover profile. Editing the shared body instead of a copy appended
  // a second hint there, naming a different model than the first one, so the
  // model would have been told two contradictory things about its own identity.
  it('a failover gets exactly ONE hint, naming the profile that answers', async () => {
    const withFailover: LupinConfig = {
      activeProfile: 'first',
      port: 0,
      localToken: TOKEN,
      profiles: {
        first: {
          provider: 'moonshot',
          mode: 'passthrough',
          baseUrl: 'http://127.0.0.1:1',
          auth: { type: 'bearer', apiKeyRef: 'K' },
          slots: { opus: 'model-one', sonnet: 'model-one', haiku: 'model-one' },
          quirks: ['identityHint'],
          failover: 'second',
        },
        second: {
          provider: 'moonshot',
          mode: 'passthrough',
          baseUrl: 'http://127.0.0.1:2',
          auth: { type: 'bearer', apiKeyRef: 'K' },
          slots: { opus: 'model-two', sonnet: 'model-two', haiku: 'model-two' },
          quirks: ['identityHint'],
        },
      },
    };
    saveConfig(withFailover);
    let call = 0;
    const fetchImpl = vi.fn((_u: string | URL | Request, _i?: RequestInit) => {
      call += 1;
      // The first profile answers 429, which is what sends the request to the
      // failover (§4ter).
      return Promise.resolve(
        call === 1
          ? new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }), {
              status: 429,
              headers: { 'content-type': 'application/json' },
            })
          : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      );
    });
    const app = createApp(withFailover, { fetchImpl: fetchImpl as unknown as typeof fetch, logger: () => undefined });
    await app.request('/v1/messages', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model: 'claude-fable-5', system: [{ type: 'text', text: 'harness' }], messages: [] }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as { system: { text: string }[] };
    expect(second.system).toHaveLength(2);
    expect(second.system[1]?.text).toBe(identityHintText('model-two', 'moonshot'));
    expect(second.system.filter((b) => b.text.includes('[Lupin]'))).toHaveLength(1);
  });

  it('names the model that really answers, not the one the client asked for', async () => {
    const sent = await send(['identityHint']);
    const system = sent['system'] as { text: string }[];
    expect(system).toHaveLength(2);
    expect(system[1]?.text).toBe(identityHintText('the-model', 'moonshot'));
    // The client asked for a Claude name; the hint must say what really serves.
    expect(system[1]?.text).not.toContain('claude-fable-5');
  });
});
