import { describe, expect, it } from 'vitest';
import { mapOpenAIResponse } from '../src/core/response.js';
import { OpenAIStreamTranslator, type AnthropicStreamEvent } from '../src/core/stream.js';

// The dialect pipeline reaching both mappers end to end (SPEC-TRANSLATION §5bis).

const QUIRKS = ['stripThinkTags', 'parseTextToolCalls'];

function chunk(delta: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ id: 'x', model: 'm', choices: [{ index: 0, delta }] })}\n\n`;
}

function blocks(events: AnthropicStreamEvent[]): { type: string; index: number }[] {
  return events
    .filter((e) => e.event === 'content_block_start')
    .map((e) => {
      const data = e.data as { index: number; content_block: { type: string } };
      return { type: data.content_block.type, index: data.index };
    });
}

function deltasOf(events: AnthropicStreamEvent[], index: number): Record<string, unknown>[] {
  return events
    .filter((e) => e.event === 'content_block_delta' && (e.data as { index: number }).index === index)
    .map((e) => (e.data as { delta: Record<string, unknown> }).delta);
}

describe('non-streaming dialect wiring (§4 + §5bis)', () => {
  it('reasoning_content becomes a thinking block instead of being dropped', () => {
    const mapped = mapOpenAIResponse({
      choices: [{ message: { role: 'assistant', content: 'The answer.', reasoning_content: 'step by step' } }],
    });
    expect(mapped['content']).toEqual([
      { type: 'thinking', thinking: 'step by step' },
      { type: 'text', text: 'The answer.' },
    ]);
  });

  it('a tool call hidden in the text is recovered and flips stop_reason to tool_use', () => {
    const mapped = mapOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Checking.<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}</tool_call>',
            },
            finish_reason: 'stop',
          },
        ],
      },
      { quirks: QUIRKS, hasTools: true },
    );
    expect(mapped['content']).toEqual([
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_lupin_0', name: 'Read', input: { path: 'a.ts' } },
    ]);
    // The provider said "stop"; Claude Code would never run the tool on that.
    expect(mapped['stop_reason']).toBe('tool_use');
  });

  it('reports the quirks that fired', () => {
    const applied: string[][] = [];
    mapOpenAIResponse(
      { choices: [{ message: { role: 'assistant', content: '<think>hm</think>ok' } }] },
      { quirks: QUIRKS, hasTools: true, onDialect: (q) => applied.push(q) },
    );
    expect(applied).toEqual([['stripThinkTags']]);
  });

  it('without quirks the raw text is left exactly as the provider sent it', () => {
    const raw = '<think>hm</think>ok';
    const mapped = mapOpenAIResponse({ choices: [{ message: { role: 'assistant', content: raw } }] });
    expect(mapped['content']).toEqual([{ type: 'text', text: raw }]);
  });

  it('looseJsonArguments repairs malformed native tool arguments, and only then', () => {
    const broken = {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: "{'path': 'a.ts',}" } }],
          },
        },
      ],
    };
    expect(() => mapOpenAIResponse(broken)).toThrow(/malformed JSON/);
    const repaired = mapOpenAIResponse(broken, { quirks: ['looseJsonArguments'] });
    expect(repaired['content']).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a.ts' } },
    ]);
  });
});

describe('streaming dialect wiring (§5 + §5bis)', () => {
  it('reasoning_content deltas open a thinking block, then text opens its own', () => {
    const t = new OpenAIStreamTranslator({ quirks: QUIRKS });
    const events = [
      ...t.push(chunk({ reasoning_content: 'weighing ' })),
      ...t.push(chunk({ reasoning_content: 'options' })),
      ...t.push(chunk({ content: 'Answer.' })),
      ...t.finish(),
    ];
    expect(blocks(events)).toEqual([
      { type: 'thinking', index: 0 },
      { type: 'text', index: 1 },
    ]);
    expect(deltasOf(events, 0)).toEqual([
      { type: 'thinking_delta', thinking: 'weighing ' },
      { type: 'thinking_delta', thinking: 'options' },
    ]);
    expect(deltasOf(events, 1)).toEqual([{ type: 'text_delta', text: 'Answer.' }]);
  });

  it('a think tag split across chunks never leaks into the visible text', () => {
    const t = new OpenAIStreamTranslator({ quirks: QUIRKS });
    const events = [
      ...t.push(chunk({ content: 'a<thi' })),
      ...t.push(chunk({ content: 'nk>hidden</think>b' })),
      ...t.finish(),
    ];
    const texts = events
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => (e.data as { delta: { text?: string; thinking?: string } }).delta);
    expect(texts).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'thinking_delta', thinking: 'hidden' },
      { type: 'text_delta', text: 'b' },
    ]);
  });

  it('a textual tool call split across chunks becomes one tool_use block, stop_reason tool_use', () => {
    const t = new OpenAIStreamTranslator({ quirks: QUIRKS, hasTools: true });
    const events = [
      ...t.push(chunk({ content: 'Let me look.<tool_call>{"name":"Re' })),
      ...t.push(chunk({ content: 'ad","arguments":{"path":"a.ts"}}</tool_call>' })),
      ...t.push('data: [DONE]\n\n'),
    ];
    expect(blocks(events)).toEqual([
      { type: 'text', index: 0 },
      { type: 'tool_use', index: 1 },
    ]);
    expect(deltasOf(events, 1)).toEqual([
      { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
    ]);
    const closing = events.find((e) => e.event === 'message_delta');
    expect((closing?.data as { delta: { stop_reason: string } }).delta.stop_reason).toBe('tool_use');
  });

  it('a tool call still open at stream end is flushed, not lost', () => {
    const t = new OpenAIStreamTranslator({ quirks: QUIRKS, hasTools: true });
    const events = [...t.push(chunk({ content: '<tool_call>{"name":"Read","arguments":{}}' })), ...t.finish()];
    expect(blocks(events)).toEqual([{ type: 'tool_use', index: 0 }]);
  });

  it('with no quirks the stream behaves exactly as before', () => {
    const t = new OpenAIStreamTranslator();
    const events = [...t.push(chunk({ content: '<think>x</think>y' })), ...t.finish()];
    expect(blocks(events)).toEqual([{ type: 'text', index: 0 }]);
    expect(deltasOf(events, 0)).toEqual([{ type: 'text_delta', text: '<think>x</think>y' }]);
  });
});
