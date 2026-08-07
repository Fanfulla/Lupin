// editRetryHint (SPEC-PROVIDERS §5quater, ADR-45): the opt-in quirk that answers
// a rejected exact-match edit with ONE system block, instead of letting the model
// resend the same `old_string` for three turns. Like identityHint (ADR-39) it
// edits the request body, so what is pinned here is: off unless the profile asks,
// appended LAST, fired only on the turn right after the failure, and silent on a
// failure that had nothing to do with an edit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editRetryHintText, identityHintText, lastEditFailed, withEditRetryHint } from '../src/core/quirks.js';
import { createApp } from '../src/server/ingress.js';
import { saveConfig, type LupinConfig } from '../src/config/config.js';

const editCall = (id: string): Record<string, unknown> => ({
  type: 'tool_use',
  id,
  name: 'Edit',
  input: { file_path: 'greet.js', old_string: 'const a = 1;', new_string: 'const a = 2;' },
});

const result = (id: string, isError: boolean): Record<string, unknown> => ({
  type: 'tool_result',
  tool_use_id: id,
  content: isError ? 'String to replace not found in file.' : 'The file has been updated.',
  ...(isError ? { is_error: true } : {}),
});

describe('when the hint fires', () => {
  it('fires on the turn right after a rejected edit', () => {
    expect(
      lastEditFailed([
        { role: 'user', content: 'change it' },
        { role: 'assistant', content: [editCall('t1')] },
        { role: 'user', content: [result('t1', true)] },
      ]),
    ).toBe(true);
  });

  it('stays silent when the edit was applied', () => {
    expect(
      lastEditFailed([
        { role: 'assistant', content: [editCall('t1')] },
        { role: 'user', content: [result('t1', false)] },
      ]),
    ).toBe(false);
  });

  // The hint is for the model that is about to retry. Once the edit lands, going
  // on to repeat "your edit failed" every turn would burn tokens and nag about
  // something already fixed, so only the last turn is read.
  it('stays silent once a later edit succeeded', () => {
    expect(
      lastEditFailed([
        { role: 'assistant', content: [editCall('t1')] },
        { role: 'user', content: [result('t1', true)] },
        { role: 'assistant', content: [editCall('t2')] },
        { role: 'user', content: [result('t2', false)] },
      ]),
    ).toBe(false);
  });

  // A Bash that exits 1 is a failure too, and this hint would be pure noise on
  // it: what fires the hint is the shape of the call, not the fact it failed.
  it('stays silent on a failure that carried no old_string', () => {
    expect(
      lastEditFailed([
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
        { role: 'user', content: [result('t1', true)] },
      ]),
    ).toBe(false);
  });

  it('fires for MultiEdit, same failure one level down', () => {
    expect(
      lastEditFailed([
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'MultiEdit',
              input: { file_path: 'a.js', edits: [{ old_string: 'x', new_string: 'y' }] },
            },
          ],
        },
        { role: 'user', content: [result('t1', true)] },
      ]),
    ).toBe(true);
  });

  it('stays silent on a plain user turn', () => {
    expect(lastEditFailed([{ role: 'user', content: 'hello' }])).toBe(false);
  });

  it('never throws on a shape it does not know', () => {
    expect(lastEditFailed(undefined)).toBe(false);
    expect(lastEditFailed([])).toBe(false);
    expect(lastEditFailed('nonsense')).toBe(false);
    expect(lastEditFailed([{ role: 'user' }])).toBe(false);
    expect(lastEditFailed([{ role: 'user', content: [{ type: 'tool_result' }] }])).toBe(false);
  });
});

describe('where the hint goes', () => {
  it('appends to a block array, leaving every earlier block untouched', () => {
    const system = [
      { type: 'text', text: 'you are Claude Code' },
      { type: 'text', text: 'harness rules', cache_control: { type: 'ephemeral' } },
    ];
    const out = withEditRetryHint(system) as Record<string, unknown>[];
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(system[0]);
    expect(out[1]).toEqual(system[1]);
    expect(out[2]).toEqual({ type: 'text', text: editRetryHintText() });
  });

  it('a shape it does not understand is left alone, never corrupted', () => {
    const weird = { unexpected: true };
    expect(withEditRetryHint(weird)).toBe(weird);
  });

  it('names the exact-match rule and forbids resending the same old_string', () => {
    const t = editRetryHintText();
    expect(t).toContain('old_string');
    expect(t).toMatch(/byte for byte/i);
    expect(t).toMatch(/trailing newline/i);
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
    dir = mkdtempSync(join(tmpdir(), 'lupin-edit-hint-'));
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

  const failedEditBody = {
    model: 'claude-fable-5',
    system: [{ type: 'text', text: 'harness' }],
    messages: [
      { role: 'assistant', content: [editCall('t1')] },
      { role: 'user', content: [result('t1', true)] },
    ],
  };

  const send = async (
    quirks?: string[],
    body: Record<string, unknown> = failedEditBody,
    path = '/v1/messages',
  ): Promise<Record<string, unknown>> => {
    const fetchImpl = vi.fn((_u: string | URL | Request, _i?: RequestInit) =>
      Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
    );
    const app = createApp(config(quirks), { fetchImpl: fetchImpl as unknown as typeof fetch, logger: () => undefined });
    await app.request(path, { method: 'POST', headers: auth, body: JSON.stringify(body) });
    return JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
  };

  it('is OFF unless the profile asks for it (ADR-7: never on by default)', async () => {
    const sent = await send();
    expect(sent['system']).toEqual([{ type: 'text', text: 'harness' }]);
  });

  it('appends exactly one block when the profile asked and an edit failed', async () => {
    const sent = await send(['editRetryHint']);
    const system = sent['system'] as { text: string }[];
    expect(system).toHaveLength(2);
    expect(system[1]?.text).toBe(editRetryHintText());
  });

  it('leaves the body alone when no edit failed, quirk on', async () => {
    const sent = await send(['editRetryHint'], {
      ...failedEditBody,
      messages: [{ role: 'user', content: 'just talk to me' }],
    });
    expect(sent['system']).toEqual([{ type: 'text', text: 'harness' }]);
  });

  it('is not applied to count_tokens (ADR-39: the estimate is not the turn)', async () => {
    const sent = await send(['editRetryHint'], failedEditBody, '/v1/messages/count_tokens');
    expect(sent['system']).toEqual([{ type: 'text', text: 'harness' }]);
  });

  // Order is not cosmetic: identityHint is constant for the whole session while
  // this one comes and goes, so the volatile block goes last. Any other order
  // would move the identity block's index the first time an edit fails, and the
  // provider's cached prefix would end at a different boundary (§3ter).
  // An intervention nobody can see cannot be evaluated: without this field the
  // A/B that has to justify the quirk could not tell "did not help" from "never
  // fired", which are opposite verdicts that leave the same score.
  it('says on the log line that it fired, and stays quiet when it did not', async () => {
    const lines: { editHint?: true }[] = [];
    const run = async (body: Record<string, unknown>): Promise<void> => {
      const fetchImpl = vi.fn(() =>
        Promise.resolve(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })),
      );
      const app = createApp(config(['editRetryHint']), {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        logger: (l) => lines.push(l),
      });
      await app.request('/v1/messages', { method: 'POST', headers: auth, body: JSON.stringify(body) });
    };
    await run(failedEditBody);
    await run({ ...failedEditBody, messages: [{ role: 'user', content: 'nothing failed here' }] });
    expect(lines[0]?.editHint).toBe(true);
    expect(lines[1]?.editHint).toBeUndefined();
  });

  it('goes after identityHint, which keeps its position', async () => {
    const sent = await send(['identityHint', 'editRetryHint']);
    const system = sent['system'] as { text: string }[];
    expect(system).toHaveLength(3);
    expect(system[0]?.text).toBe('harness');
    expect(system[1]?.text).toBe(identityHintText('the-model', 'moonshot'));
    expect(system[2]?.text).toBe(editRetryHintText());
  });
});
