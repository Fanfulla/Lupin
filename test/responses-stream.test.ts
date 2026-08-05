// M6a Responses API stream translator (DESIGN-TRANSLATORS-DEDICATED §2.1):
// WHAM Responses SSE -> Anthropic typed events. Fixture-first from REAL
// captures (test/helpers/captures/wham-*.sse, recorded 2026-07-29 against a
// live ChatGPT account and redacted), never invented.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResponsesStreamTranslator } from '../src/core/responses/stream.js';

const captures = (name: string): string => readFileSync(join(__dirname, 'helpers', 'captures', name), 'utf8');

/** Feed a whole capture through the translator, then finish. */
function run(capture: string) {
  const tr = new ResponsesStreamTranslator({ requestedModel: 'claude-opus-5' });
  const events = [...tr.push(captures(capture)), ...tr.finish()];
  return events;
}

const byEvent = <T extends { event: string; data: Record<string, unknown> }>(events: T[], name: string): T[] =>
  events.filter((e) => e.event === name);

describe('ResponsesStreamTranslator: text (wham-stream-simple.sse)', () => {
  const events = run('wham-stream-simple.sse');

  it('opens the message with message_start carrying the requested model', () => {
    const start = byEvent(events, 'message_start');
    expect(start).toHaveLength(1);
    const msg = start[0]?.data['message'] as Record<string, unknown>;
    expect(msg['model']).toBe('claude-opus-5');
    expect(msg['role']).toBe('assistant');
  });

  it('streams the text as content_block deltas and closes it', () => {
    expect(byEvent(events, 'content_block_start').length).toBeGreaterThan(0);
    const deltas = byEvent(events, 'content_block_delta');
    const text = deltas.map((d) => (d.data['delta'] as { text?: string }).text ?? '').join('');
    expect(text).toBe('ok');
    expect(byEvent(events, 'content_block_stop').length).toBeGreaterThan(0);
  });

  it('closes with message_delta (usage) and message_stop', () => {
    const md = byEvent(events, 'message_delta');
    expect(md).toHaveLength(1);
    const usage = (md[0]?.data['usage'] ?? {}) as Record<string, number>;
    expect(usage['input_tokens']).toBe(24);
    expect(usage['output_tokens']).toBe(5);
    expect(byEvent(events, 'message_stop')).toHaveLength(1);
  });

  it('marks end_turn (no tool call in this capture)', () => {
    const md = byEvent(events, 'message_delta')[0];
    expect((md?.data['delta'] as Record<string, unknown>)['stop_reason']).toBe('end_turn');
  });
});

describe('ResponsesStreamTranslator: tool call (wham-stream-toolcall.sse)', () => {
  const events = run('wham-stream-toolcall.sse');

  it('emits a tool_use block with the function name and call id', () => {
    const start = byEvent(events, 'content_block_start');
    const tool = start.find((s) => (s.data['content_block'] as Record<string, unknown>)['type'] === 'tool_use');
    expect(tool).toBeDefined();
    const block = tool?.data['content_block'] as Record<string, unknown>;
    expect(block['name']).toBe('get_weather');
    expect(block['id']).toBe('call_MBUg6vQXJc7xHZ12rgt3oYrW');
  });

  it('streams the function arguments as input_json deltas, reassembled', () => {
    const deltas = byEvent(events, 'content_block_delta').filter(
      (d) => (d.data['delta'] as Record<string, unknown>)['type'] === 'input_json_delta',
    );
    const json = deltas.map((d) => (d.data['delta'] as { partial_json?: string }).partial_json ?? '').join('');
    expect(JSON.parse(json)).toEqual({ city: 'Rome' });
  });

  it('marks tool_use as the stop reason', () => {
    const md = byEvent(events, 'message_delta')[0];
    expect((md?.data['delta'] as Record<string, unknown>)['stop_reason']).toBe('tool_use');
  });
});

describe('ResponsesStreamTranslator: a mid-stream failure', () => {
  // WHAM's `response.failed` has NEVER been seen live (the M6a limit list says
  // so). That is a reason to pin what the code does with it, not to leave it
  // untested: without this, "unverified" hid the fact that nothing exercised
  // the branch at all. The frame is synthetic and labelled as such.
  const failed = 'data: {"type":"response.failed","response":{"id":"resp_1","status":"failed"}}\n\n';

  it('produces exactly one error event', () => {
    const tr = new ResponsesStreamTranslator();
    const events = tr.push(failed);
    expect(events.map((e) => e.event)).toEqual(['error']);
    const err = events[0]?.data['error'] as { type: string; message: string };
    expect(err.type).toBe('api_error');
    expect(err.message).toContain('[lupin]');
  });

  it('the stream is over: nothing more is emitted, and finish() adds nothing', () => {
    const tr = new ResponsesStreamTranslator();
    tr.push(failed);
    expect(tr.push('data: {"type":"response.output_text.delta","delta":"ignored"}\n\n')).toEqual([]);
    expect(tr.finish()).toEqual([]);
  });

  it('a failure AFTER text still ends the message with the error, not a clean stop', () => {
    const tr = new ResponsesStreamTranslator();
    const events = [
      ...tr.push('data: {"type":"response.created","response":{"id":"resp_1"}}\n\n'),
      ...tr.push('data: {"type":"response.output_text.delta","delta":"half an ans"}\n\n'),
      ...tr.push(failed),
      ...tr.finish(),
    ];
    expect(events.at(-1)?.event).toBe('error');
    // No message_stop: the caller must not read a truncated answer as complete.
    expect(events.some((e) => e.event === 'message_stop')).toBe(false);
  });
});
