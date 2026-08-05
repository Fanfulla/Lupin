import { describe, expect, it } from 'vitest';
import { estimateInputTokens } from '../src/core/tokens.js';
import type { AnthropicRequest } from '../src/core/request.js';

// Unit level: the §7 local estimator. No exact token counts asserted (tokenizer
// data may evolve); we assert determinism, monotonicity and the flat image cost.

function base(): AnthropicRequest {
  return {
    model: 'm',
    max_tokens: 100,
    system: 'You are a coding agent.',
    messages: [{ role: 'user', content: 'Fix the bug in the auth middleware, please.' }],
  };
}

describe('estimateInputTokens (§7)', () => {
  it('is positive and deterministic', () => {
    const a = estimateInputTokens(base());
    const b = estimateInputTokens(base());
    expect(a).toBeGreaterThan(0);
    expect(a).toBe(b);
  });

  it('grows when tools with heavy JSON schemas are added', () => {
    const withTools: AnthropicRequest = {
      ...base(),
      tools: [
        {
          name: 'Edit',
          description: 'Edit a file by exact string replacement',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'absolute path of the file to edit' },
              old: { type: 'string', description: 'exact string to replace' },
              new: { type: 'string', description: 'replacement string' },
            },
            required: ['path', 'old', 'new'],
          },
        },
      ],
    };
    expect(estimateInputTokens(withTools)).toBeGreaterThan(estimateInputTokens(base()));
  });

  it('counts tool_use inputs and tool_result contents in history', () => {
    const withHistory: AnthropicRequest = {
      ...base(),
      messages: [
        ...base().messages,
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { path: 'a-very-long-path/to/some/file.ts' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents here, quite long indeed' }],
        },
      ],
    };
    expect(estimateInputTokens(withHistory)).toBeGreaterThan(estimateInputTokens(base()));
  });

  it('adds a flat cost per image (base64 has no dimensions)', () => {
    const req = base();
    const withImage: AnthropicRequest = {
      ...base(),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Fix the bug in the auth middleware, please.' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
          ],
        },
      ],
    };
    expect(estimateInputTokens(withImage)).toBe(estimateInputTokens(req) + 1500);
  });
});
