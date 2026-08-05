// M6b: Code Assist SSE -> Anthropic events. The fixtures are REAL captures from
// cloudcode-pa.googleapis.com (2026-07-29), replayed byte for byte.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CodeAssistStreamTranslator } from '../src/core/codeassist/stream.js';
import type { AnthropicStreamEvent } from '../src/core/stream.js';

const capture = (name: string): string => readFileSync(`test/helpers/captures/${name}`, 'utf8');

function run(sse: string, opts = {}, chunkSize = 0): AnthropicStreamEvent[] {
  const t = new CodeAssistStreamTranslator(opts);
  const events: AnthropicStreamEvent[] = [];
  if (chunkSize > 0) {
    for (let i = 0; i < sse.length; i += chunkSize) events.push(...t.push(sse.slice(i, i + chunkSize)));
  } else {
    events.push(...t.push(sse));
  }
  events.push(...t.finish());
  return events;
}

const names = (evs: AnthropicStreamEvent[]): string[] => evs.map((e) => e.event);
const text = (evs: AnthropicStreamEvent[]): string =>
  evs
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => {
      const d = (e.data as { delta?: { type?: string; text?: string } }).delta;
      return d?.type === 'text_delta' ? (d.text ?? '') : '';
    })
    .join('');

describe('a plain text stream', () => {
  const evs = run(capture('codeassist-stream-simple.sse'), { requestedModel: 'claude-sonnet-4' });

  it('opens and closes a well-formed Anthropic message', () => {
    expect(names(evs)[0]).toBe('message_start');
    expect(names(evs).at(-1)).toBe('message_stop');
    expect(names(evs)).toContain('content_block_start');
    expect(names(evs)).toContain('content_block_stop');
  });

  it('carries the text through', () => {
    expect(text(evs)).toBe('One\nTwo\nThree\nFour\nFive');
  });

  it('echoes the model Claude Code asked for, not the provider slug', () => {
    const m = (evs[0]?.data as { message: { model: string } }).message;
    expect(m.model).toBe('claude-sonnet-4');
  });

  it('reports usage and end_turn from the final frame', () => {
    const delta = evs.find((e) => e.event === 'message_delta')?.data as {
      delta: { stop_reason: string };
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(delta.delta.stop_reason).toBe('end_turn');
    expect(delta.usage.input_tokens).toBe(18);
    expect(delta.usage.output_tokens).toBe(9);
  });

  it('survives being fed one byte at a time', () => {
    expect(text(run(capture('codeassist-stream-simple.sse'), {}, 1))).toBe('One\nTwo\nThree\nFour\nFive');
  });
});

describe('a tool call', () => {
  const evs = run(capture('codeassist-stream-toolcall.sse'));

  it('emits a tool_use block with a synthesized id (Gemini sends none)', () => {
    const start = evs.find(
      (e) => e.event === 'content_block_start' && (e.data as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    expect(start).toBeDefined();
    const block = (start?.data as { content_block: { id: string; name: string } }).content_block;
    expect(block.name).toBe('get_weather');
    expect(block.id).toMatch(/^toolu_/);
  });

  it('streams the arguments as input_json_delta that parses back', () => {
    const json = evs
      .filter((e) => e.event === 'content_block_delta')
      .map((e) => {
        const d = (e.data as { delta?: { type?: string; partial_json?: string } }).delta;
        return d?.type === 'input_json_delta' ? (d.partial_json ?? '') : '';
      })
      .join('');
    expect(JSON.parse(json)).toEqual({ city: 'Rome' });
  });

  it('stops with tool_use, not end_turn', () => {
    const delta = evs.find((e) => e.event === 'message_delta')?.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('tool_use');
  });

  it('never leaks the opaque thoughtSignature into the text', () => {
    expect(text(evs)).not.toContain('thoughtSignature');
    expect(text(evs)).toBe('');
  });

  it('maps the sanitized name back to the original', () => {
    const withMap = run(capture('codeassist-stream-toolcall.sse'), {
      toolNames: new Map([['get_weather', 'mcp__weather__get_current_weather_for_a_city']]),
    });
    const start = withMap.find(
      (e) => e.event === 'content_block_start' && (e.data as { content_block: { type: string } }).content_block.type === 'tool_use',
    );
    expect((start?.data as { content_block: { name: string } }).content_block.name).toBe(
      'mcp__weather__get_current_weather_for_a_city',
    );
  });
});

describe('a multi-frame answer (the tool result round trip)', () => {
  const evs = run(capture('codeassist-stream-toolresult.sse'));

  it('joins the frames into one text block', () => {
    expect(text(evs)).toBe('The weather in Rome is clear with a temperature of 31C.');
    expect(names(evs).filter((n) => n === 'content_block_start')).toHaveLength(1);
  });

  it('takes usage from the last frame, where it is complete', () => {
    const delta = evs.find((e) => e.event === 'message_delta')?.data as {
      usage: { input_tokens: number; output_tokens: number };
    };
    expect(delta.usage.input_tokens).toBe(41);
    expect(delta.usage.output_tokens).toBe(15);
  });
});

describe('failure modes', () => {
  it('a truncated stream still closes the message', () => {
    const half = capture('codeassist-stream-simple.sse').slice(0, 120);
    const evs = run(half);
    expect(names(evs).at(-1)).toBe('message_stop');
  });

  it('a malformed frame ends the stream with an error, it does not throw', () => {
    const t = new CodeAssistStreamTranslator();
    const evs = t.push('data: {not json\n\n');
    expect(evs.at(-1)?.event).toBe('error');
  });

  it('an abort produces exactly one error event', () => {
    const t = new CodeAssistStreamTranslator();
    const evs = t.abort('connection died');
    expect(names(evs)).toEqual(['error']);
    expect(t.push('data: {}\n\n')).toEqual([]);
  });

  it('MAX_TOKENS becomes max_tokens', () => {
    const frame =
      'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"MAX_TOKENS"}]}}\n\n';
    const delta = run(frame).find((e) => e.event === 'message_delta')?.data as { delta: { stop_reason: string } };
    expect(delta.delta.stop_reason).toBe('max_tokens');
  });
});
