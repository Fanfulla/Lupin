// M6b: Anthropic Messages -> Google Code Assist request. Every expectation here
// is a shape that answered 200 live on cloudcode-pa.googleapis.com on
// 2026-07-29 (see docs/DESIGN-TRANSLATORS-DEDICATED §2.2bis), not a reading of
// the public Gemini docs.

import { describe, expect, it } from 'vitest';
import { mapAnthropicToCodeAssist } from '../src/core/codeassist/request.js';
import type { AnthropicRequest } from '../src/core/request.js';

const ENV = { model: 'gemini-2.5-flash', project: 'proj-1', userPromptId: 'p-1', sessionId: 's-1' };

function req(over: Partial<AnthropicRequest>): AnthropicRequest {
  return { model: 'claude-sonnet-4', max_tokens: 1024, messages: [], ...over };
}

interface CaBody {
  model: string;
  project: string;
  user_prompt_id: string;
  request: {
    contents: { role: string; parts: Record<string, unknown>[] }[];
    systemInstruction?: { parts: { text: string }[] };
    tools?: { functionDeclarations: Record<string, unknown>[] }[];
    toolConfig?: unknown;
    generationConfig?: Record<string, unknown>;
    session_id: string;
  };
}

const map = (r: AnthropicRequest): CaBody => mapAnthropicToCodeAssist(r, ENV) as unknown as CaBody;

describe('the Code Assist envelope', () => {
  it('wraps the request: outer snake_case, inner camelCase', () => {
    const out = map(req({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(out.model).toBe('gemini-2.5-flash');
    expect(out.project).toBe('proj-1');
    expect(out.user_prompt_id).toBe('p-1');
    expect(out.request.session_id).toBe('s-1');
    expect(out.request.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('the resolved slot model wins over the model Claude Code asked for', () => {
    expect(map(req({ model: 'claude-opus-4', messages: [{ role: 'user', content: 'x' }] })).model).toBe(
      'gemini-2.5-flash',
    );
  });
});

describe('roles and content', () => {
  it('assistant becomes model: Gemini has no "assistant" role', () => {
    const out = map(
      req({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }),
    );
    expect(out.request.contents.map((c) => c.role)).toEqual(['user', 'model']);
  });

  it('system travels as systemInstruction, not as a content turn', () => {
    const out = map(req({ system: 'Be terse.', messages: [{ role: 'user', content: 'a' }] }));
    expect(out.request.systemInstruction).toEqual({ parts: [{ text: 'Be terse.' }] });
    expect(out.request.contents).toHaveLength(1);
  });

  it('system blocks are joined', () => {
    const out = map(
      req({
        system: [
          { type: 'text', text: 'one' },
          { type: 'text', text: 'two' },
        ],
        messages: [{ role: 'user', content: 'a' }],
      }),
    );
    expect(out.request.systemInstruction?.parts[0]?.text).toBe('one\n\ntwo');
  });

  it('an image becomes inlineData, it is not dropped', () => {
    const out = map(
      req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        ],
      }),
    );
    expect(out.request.contents[0]?.parts).toEqual([
      { text: 'what is this' },
      { inlineData: { mimeType: 'image/png', data: 'AAAA' } },
    ]);
  });

  it('thinking blocks are dropped, never replayed as prompt text', () => {
    const out = map(
      req({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'private reasoning' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    );
    expect(JSON.stringify(out.request.contents)).not.toContain('private reasoning');
    expect(out.request.contents[0]?.parts).toEqual([{ text: 'answer' }]);
  });

  it('a message whose blocks all drop out carries no empty turn', () => {
    const out = map(req({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] }] }));
    expect(out.request.contents).toEqual([]);
  });
});

describe('tools', () => {
  const tools = [
    { name: 'get_weather', description: 'weather', input_schema: { type: 'object' as const, properties: {} } },
  ];

  it('declared flat under functionDeclarations', () => {
    const out = map(req({ tools, messages: [{ role: 'user', content: 'a' }] }));
    expect(out.request.tools).toEqual([
      { functionDeclarations: [{ name: 'get_weather', description: 'weather', parameters: { type: 'object', properties: {} } }] },
    ]);
  });

  it('the tool schema is reduced to the fields Gemini knows', () => {
    // A real Claude Code session died on this: `$schema` is answered with a 400
    // "Cannot find field", so anything Gemini does not declare must not travel.
    const out = map(
      req({
        tools: [
          {
            name: 'Edit',
            input_schema: {
              $schema: 'http://json-schema.org/draft-07/schema#',
              additionalProperties: false,
              type: 'object',
              properties: {
                // A property literally named like a keyword must survive: under
                // `properties` the keys are the caller's field names.
                required: { type: 'string', description: 'a field called required' },
                path: { type: 'string', $comment: 'dropped' },
              },
              required: ['path'],
            },
          },
        ],
        messages: [],
      }),
    );
    expect(out.request.tools?.[0]?.functionDeclarations[0]?.['parameters']).toEqual({
      type: 'object',
      properties: {
        required: { type: 'string', description: 'a field called required' },
        path: { type: 'string' },
      },
      required: ['path'],
    });
  });

  it('a tool_use becomes a functionCall part, and the id is NOT sent (Gemini has none)', () => {
    const out = map(
      req({
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Rome' } }] },
        ],
      }),
    );
    expect(out.request.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Rome' } } }],
    });
    expect(JSON.stringify(out.request.contents)).not.toContain('toolu_1');
  });

  it('a tool_result becomes functionResponse, its name recovered from the matching tool_use id', () => {
    const out = map(
      req({
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '31C, clear' }] },
        ],
      }),
    );
    expect(out.request.contents[2]).toEqual({
      role: 'user',
      parts: [{ functionResponse: { name: 'get_weather', response: { result: '31C, clear' } } }],
    });
  });

  it('an orphan tool_result still travels, under a placeholder name', () => {
    const out = map(
      req({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'x' }] }] }),
    );
    const part = out.request.contents[0]?.parts[0] as { functionResponse: { name: string } };
    expect(part.functionResponse.name).toBe('unknown_tool');
  });

  it('generationConfig carries the knobs Code Assist actually accepts', () => {
    // Unlike WHAM (§2.1, which refuses all of these and fails the whole
    // request), Code Assist honours them: verified live 2026-07-29, including a
    // stopSequences cut that really truncated the answer.
    const out = map(
      req({
        max_tokens: 512,
        temperature: 0.3,
        top_p: 0.9,
        top_k: 20,
        stop_sequences: ['STOP'],
        messages: [{ role: 'user', content: 'a' }],
      }),
    );
    expect(out.request.generationConfig).toEqual({
      maxOutputTokens: 512,
      temperature: 0.3,
      topP: 0.9,
      topK: 20,
      stopSequences: ['STOP'],
    });
  });

  it('no knobs set → no generationConfig at all (an unknown field is a 400 here)', () => {
    const out = map(req({ max_tokens: 0, messages: [{ role: 'user', content: 'a' }] }));
    expect(out.request.generationConfig).toBeUndefined();
  });

  it('tool_choice any becomes mode ANY, tool becomes an allowed name', () => {
    expect(map(req({ tools, tool_choice: { type: 'any' }, messages: [] })).request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    });
    expect(
      map(req({ tools, tool_choice: { type: 'tool', name: 'get_weather' }, messages: [] })).request.toolConfig,
    ).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } });
    expect(map(req({ tools, tool_choice: { type: 'none' }, messages: [] })).request.toolConfig).toEqual({
      functionCallingConfig: { mode: 'NONE' },
    });
  });
});
