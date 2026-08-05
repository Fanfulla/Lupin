import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OpenAIStreamTranslator, type AnthropicStreamEvent } from '../src/core/stream.js';
import { mapOpenAIResponse } from '../src/core/response.js';

// Real captures, not hand-written shapes (ADR-10): recorded 2026-07-19 from
// LM Studio serving google/gemma-4-12b-qat, the local runtime path §3ter.

function replay(file: string, chunkSize = 7): AnthropicStreamEvent[] {
  const raw = readFileSync(join(__dirname, 'helpers/captures', file), 'utf8');
  const t = new OpenAIStreamTranslator({ requestedModel: 'claude-sonnet-5' });
  const events: AnthropicStreamEvent[] = [];
  // Small chunks on purpose: the transport splits frames wherever it likes.
  for (let i = 0; i < raw.length; i += chunkSize) events.push(...t.push(raw.slice(i, i + chunkSize)));
  events.push(...t.finish());
  return events;
}

describe('LM Studio / gemma-4-12b capture (SPEC-TRANSLATION §5)', () => {
  const events = replay('lmstudio-gemma4-toolcall.sse');

  it('produces the Anthropic event sequence in the mandated order', () => {
    expect(events.map((e) => e.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
  });

  it('rebuilds the tool call, keeping the provider id which has no call_ prefix', () => {
    const start = events[1]?.data as { content_block: { type: string; id: string; name: string } };
    expect(start.content_block.type).toBe('tool_use');
    expect(start.content_block.name).toBe('Read');
    expect(start.content_block.id).toBe('gOEZzOe9KVq8j3gmjQ8d7W7OtehrCtad');
    const delta = events[2]?.data as { delta: { partial_json: string } };
    expect(JSON.parse(delta.delta.partial_json)).toEqual({ file_path: 'src/app.ts' });
  });

  it('picks up the usage chunk that arrives after finish_reason with empty choices', () => {
    const closing = events.find((e) => e.event === 'message_delta')?.data as {
      delta: { stop_reason: string };
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(closing.delta.stop_reason).toBe('tool_use');
    expect(closing.usage).toEqual({ input_tokens: 75, output_tokens: 23 });
  });

  it('echoes back the model name Claude Code asked for, not the local one', () => {
    const start = events[0]?.data as { message: { model: string } };
    expect(start.message.model).toBe('claude-sonnet-5');
  });
});

describe('LM Studio reasoning shape (observed live 2026-07-19)', () => {
  // gemma-4-12b answers tool-use turns with content:"" and everything in
  // reasoning_content. Dropping that field — as the code did before — handed
  // Claude Code an assistant message with no content at all.
  it('non-streaming: an empty content plus reasoning still yields a usable message', () => {
    const mapped = mapOpenAIResponse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            reasoning_content: 'The user wants me to read the file. Plan: call the Read tool.',
            tool_calls: [{ id: 'abc', function: { name: 'Read', arguments: '{"file_path":"src/app.ts"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(mapped['content']).toEqual([
      { type: 'thinking', thinking: 'The user wants me to read the file. Plan: call the Read tool.' },
      { type: 'tool_use', id: 'abc', name: 'Read', input: { file_path: 'src/app.ts' } },
    ]);
  });

  it('streaming: reasoning_content deltas arrive token by token and become one thinking block', () => {
    const t = new OpenAIStreamTranslator();
    const frame = (delta: Record<string, unknown>): string =>
      `data: ${JSON.stringify({ id: 'c', model: 'gemma', choices: [{ index: 0, delta }] })}\n\n`;
    const events = [
      ...t.push(frame({ role: 'assistant', reasoning_content: 'The' })),
      ...t.push(frame({ reasoning_content: ' user' })),
      ...t.push(frame({ reasoning_content: ' wants' })),
      ...t.finish(),
    ];
    const starts = events.filter((e) => e.event === 'content_block_start');
    expect(starts).toHaveLength(1);
    expect((starts[0]?.data as { content_block: { type: string } }).content_block.type).toBe('thinking');
    const text = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { thinking: string } }).delta.thinking)
      .join('');
    expect(text).toBe('The user wants');
  });
});
