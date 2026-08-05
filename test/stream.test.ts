import { describe, expect, it } from 'vitest';
import { OpenAIStreamTranslator } from '../src/core/stream.js';

// Behavioral edges not expressible as happy-path fixtures (SPEC-TRANSLATION §5 punto 4).

describe('OpenAIStreamTranslator edge cases', () => {
  it('malformed chunk → single error event, stream dead', () => {
    const t = new OpenAIStreamTranslator();
    const events = t.push('data: {broken json\n\n');
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('error');
    expect(t.push('data: {"id":"x","choices":[]}\n\n')).toHaveLength(0);
    expect(t.finish()).toHaveLength(0);
  });

  it('stream dies before any chunk → still a protocol-valid sequence with message_start first', () => {
    const t = new OpenAIStreamTranslator({ requestedModel: 'claude-sonnet-5' });
    const events = t.finish();
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
    const start = events[0]?.data as { message: { model: string } };
    expect(start.message.model).toBe('claude-sonnet-5');
  });

  it('[DONE] as the only frame → message_start still precedes the closing events', () => {
    const t = new OpenAIStreamTranslator();
    const events = t.push('data: [DONE]\n\n');
    expect(events.map((e) => e.event)).toEqual(['message_start', 'message_delta', 'message_stop']);
  });

  it('abort mid-stream → error event, then silence', () => {
    const t = new OpenAIStreamTranslator();
    t.push('data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"content":"ciao"}}]}\n\n');
    const events = t.abort('provider connection lost');
    expect(events[0]?.event).toBe('error');
    expect((events[0]?.data as { error: { message: string } }).error.message).toContain('lost');
    expect(t.finish()).toHaveLength(0);
  });

  it('stream truncated without [DONE] → finish() still closes the message', () => {
    const t = new OpenAIStreamTranslator();
    t.push('data: {"id":"x","model":"m","choices":[{"index":0,"delta":{"content":"met"}}]}\n\n');
    const closing = t.finish();
    const types = closing.map((e) => e.event);
    expect(types).toEqual(['content_block_stop', 'message_delta', 'message_stop']);
  });

  it('SSE frame split across two transport chunks is reassembled', () => {
    const t = new OpenAIStreamTranslator();
    const a = t.push('data: {"id":"x","model":"m","choices":[{"index":0,"del');
    const b = t.push('ta":{"content":"ok"}}]}\n\n');
    expect(a).toHaveLength(0);
    expect(b.map((e) => e.event)).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
  });
});
