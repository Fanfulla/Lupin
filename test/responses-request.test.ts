// M6a request mapper Anthropic -> WHAM Responses (DESIGN-TRANSLATORS-DEDICATED
// §2.1). Every expectation here mirrors a shape VERIFIED live against WHAM on
// 2026-07-29, not an inferred one: the content type is role-dependent, tools
// are flat, store/stream are mandatory, and the tool round trip uses
// function_call / function_call_output items.

import { describe, expect, it } from 'vitest';
import { mapAnthropicToResponses } from '../src/core/responses/request.js';
import type { AnthropicRequest } from '../src/core/request.js';

const base: AnthropicRequest = {
  model: 'gpt-5.6-terra',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hello' }],
};

const items = (out: Record<string, unknown>): Record<string, unknown>[] =>
  out['input'] as Record<string, unknown>[];

describe('mapAnthropicToResponses: mandatory WHAM shape', () => {
  it('always sends store:false and stream:true (WHAM rejects anything else)', () => {
    const out = mapAnthropicToResponses(base);
    expect(out['store']).toBe(false);
    expect(out['stream']).toBe(true);
  });

  it('passes the model through and honours an override', () => {
    expect(mapAnthropicToResponses(base)['model']).toBe('gpt-5.6-terra');
    expect(mapAnthropicToResponses(base, { model: 'gpt-5.5' })['model']).toBe('gpt-5.5');
  });

  it('never forwards a sampling or length knob (WHAM rejects each one outright)', () => {
    // Verified live 2026-07-29, one at a time:
    // {"detail":"Unsupported parameter: max_output_tokens | temperature | top_p | stop"}.
    // A single unsupported parameter fails the WHOLE request, so a client that
    // sets temperature must not break every call.
    const out = mapAnthropicToResponses({
      ...base,
      temperature: 0.7,
      top_p: 0.9,
      stop_sequences: ['STOP'],
    });
    expect(out['max_output_tokens']).toBeUndefined();
    expect(out['temperature']).toBeUndefined();
    expect(out['top_p']).toBeUndefined();
    expect(out['stop']).toBeUndefined();
    expect(out['stop_sequences']).toBeUndefined();
  });
});

describe('mapAnthropicToResponses: messages', () => {
  it('uses input_text for a user message', () => {
    const out = mapAnthropicToResponses(base);
    expect(items(out)).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }]);
  });

  it('uses output_text for an assistant message (WHAM rejects input_text there)', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        { role: 'user', content: 'remember 7' },
        { role: 'assistant', content: 'noted' },
        { role: 'user', content: 'which number?' },
      ],
    });
    const assistant = items(out).find((i) => i['role'] === 'assistant');
    expect(assistant?.['content']).toEqual([{ type: 'output_text', text: 'noted' }]);
  });

  it('flattens the system prompt into instructions', () => {
    const out = mapAnthropicToResponses({ ...base, system: 'be terse' });
    expect(out['instructions']).toBe('be terse');
    const blocks = mapAnthropicToResponses({
      ...base,
      system: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ],
    });
    expect(blocks['instructions']).toBe('a\n\nb');
  });

  it('drops an empty message instead of sending a contentless item', () => {
    const out = mapAnthropicToResponses({ ...base, messages: [{ role: 'user', content: '' }] });
    expect(items(out)).toEqual([]);
  });

  it('carries an image through as input_image with a data URL (WHAM accepts it)', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what colour?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    expect(items(out)[0]?.['content']).toEqual([
      { type: 'input_text', text: 'what colour?' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('drops thinking blocks rather than replaying private reasoning as prompt text', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'secret chain of thought' },
            { type: 'text', text: 'the answer' },
          ],
        },
      ],
    });
    expect(items(out)[0]?.['content']).toEqual([{ type: 'output_text', text: 'the answer' }]);
  });

  it('rewrites a system-role message to developer (WHAM rejects system outright)', () => {
    // Claude Code puts hook output into `messages` as role:"system"; WHAM
    // answers {"detail":"System messages are not allowed"} and kills the whole
    // session. Found by lupin doctor on 2026-07-29.
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'SessionStart hook output' } as never,
      ],
    });
    const roles = items(out).map((i) => i['role']);
    expect(roles).toEqual(['user', 'developer']);
    const dev = items(out)[1];
    expect(dev?.['content']).toEqual([{ type: 'input_text', text: 'SessionStart hook output' }]);
  });
});

describe('mapAnthropicToResponses: tools', () => {
  const withTools: AnthropicRequest = {
    ...base,
    tools: [{ name: 'get_weather', description: 'weather', input_schema: { type: 'object', properties: {} } }],
  };

  it('emits FLAT function tools (not nested under `function` as in Chat Completions)', () => {
    const tools = mapAnthropicToResponses(withTools)['tools'] as Record<string, unknown>[];
    expect(tools[0]).toMatchObject({ type: 'function', name: 'get_weather', description: 'weather' });
    expect(tools[0]?.['parameters']).toBeDefined();
    expect(tools[0]?.['function']).toBeUndefined();
  });

  it('sanitizes an MCP tool name too long or with invalid characters', () => {
    const out = mapAnthropicToResponses({
      ...base,
      tools: [{ name: 'mcp__server__some.tool', input_schema: { type: 'object' } }],
    });
    const tools = out['tools'] as Record<string, unknown>[];
    expect(tools[0]?.['name']).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it('maps tool_choice: any -> required, tool -> the named function', () => {
    expect(mapAnthropicToResponses({ ...withTools, tool_choice: { type: 'any' } })['tool_choice']).toBe('required');
    expect(mapAnthropicToResponses({ ...withTools, tool_choice: { type: 'auto' } })['tool_choice']).toBe('auto');
    expect(
      mapAnthropicToResponses({ ...withTools, tool_choice: { type: 'tool', name: 'get_weather' } })['tool_choice'],
    ).toEqual({ type: 'function', name: 'get_weather' });
  });
});

describe('mapAnthropicToResponses: the tool round trip', () => {
  it('turns an assistant tool_use into a function_call item', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        { role: 'user', content: 'weather in Rome?' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Rome' } }],
        },
      ],
    });
    const call = items(out).find((i) => i['type'] === 'function_call');
    expect(call).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Rome"}',
    });
  });

  it('turns a tool_result into a function_call_output item keyed by call_id', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"temp_c":21}' }] },
      ],
    });
    expect(items(out)).toEqual([{ type: 'function_call_output', call_id: 'call_1', output: '{"temp_c":21}' }]);
  });

  it('flattens a block-shaped tool_result into text', () => {
    const out = mapAnthropicToResponses({
      ...base,
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'sunny' }] }],
        },
      ],
    });
    expect(items(out)[0]?.['output']).toBe('sunny');
  });
});
