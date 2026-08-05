// A free model is not a defect and Lupin does not hide it. What it must never
// do is let a user believe a frontier model answered when a free one did, so
// every surface that names a model also says when that model is free, and
// where the paid plan lives. One implementation (providers/tiers), so the
// surfaces cannot drift apart.

import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/ingress.js';
import { isFreeByConvention, labelModel, noteFreeTier, resetFreeTierNotes, upgradeUrl } from '../src/providers/tiers.js';
import type { LupinConfig } from '../src/config/config.js';

const TOKEN = 'local-token';

function config(provider: string, model: string): LupinConfig {
  return {
    activeProfile: 'p',
    port: 0,
    localToken: TOKEN,
    profiles: {
      p: {
        provider,
        mode: 'translate',
        auth: { type: 'bearer', apiKeyRef: 'FAKE_KEY' },
        slots: { opus: model, sonnet: model, haiku: model },
      },
    },
  };
}

const get = (path: string): Request =>
  new Request(`http://127.0.0.1${path}`, { headers: { 'x-api-key': TOKEN } });

afterEach(() => {
  resetFreeTierNotes();
});

describe('knowing a model is free', () => {
  it('by convention, from the id itself: OpenRouter suffixes :free', () => {
    expect(isFreeByConvention('deepseek/deepseek-r2:free')).toBe(true);
    expect(isFreeByConvention('deepseek/deepseek-r2')).toBe(false);
  });

  it('declared by the provider: a lane reports what the account tier is', () => {
    expect(labelModel('p', 'geminisub', 'gemini-2.5-flash')).toBe('gemini-2.5-flash');
    noteFreeTier('p', 'sonnet');
    expect(labelModel('p', 'geminisub', 'gemini-2.5-flash')).toContain('(free');
  });

  it('the label carries the upgrade link when the provider sells one', () => {
    noteFreeTier('p');
    expect(labelModel('p', 'geminisub', 'm')).toContain(upgradeUrl('geminisub') ?? 'MISSING');
    // A local runtime is free with nothing to buy: no link is invented.
    expect(labelModel('p', 'ollama', 'm')).toBe('m (free)');
  });
});

describe('the model picker says it, because that is where the user reads a model name', () => {
  it('marks a free model and points at the upgrade', async () => {
    const app = createApp(config('openrouter', 'deepseek/deepseek-r2:free'));
    const res = await app.request(get('/v1/models'));
    const body = (await res.json()) as { data: { display_name: string }[] };
    expect(body.data[0]?.display_name).toContain('(free');
    expect(body.data[0]?.display_name).toContain('openrouter.ai');
  });

  it('leaves a paid model alone', async () => {
    const app = createApp(config('openrouter', 'deepseek/deepseek-r2'));
    const res = await app.request(get('/v1/models'));
    const body = (await res.json()) as { data: { display_name: string }[] };
    expect(body.data[0]?.display_name).toBe('deepseek/deepseek-r2');
  });
});

describe('/health says it, so the statusline can show it every turn', () => {
  it('reports the tier and the upgrade url when the models are free', async () => {
    const app = createApp(config('openrouter', 'deepseek/deepseek-r2:free'));
    const body = (await (await app.request(get('/health'))).json()) as {
      tier?: { free: boolean; upgrade?: string };
    };
    expect(body.tier?.free).toBe(true);
    expect(body.tier?.upgrade).toBe(upgradeUrl('openrouter'));
  });

  it('says nothing at all when the tier is paid: silence is meaningful', async () => {
    const app = createApp(config('openrouter', 'deepseek/deepseek-r2'));
    const body = (await (await app.request(get('/health'))).json()) as { tier?: unknown };
    expect(body.tier).toBeUndefined();
  });
});
