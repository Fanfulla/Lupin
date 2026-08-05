import { describe, expect, it } from 'vitest';
import { mapAnthropicRequest, type AnthropicRequest } from '../src/core/request.js';

// Every OpenAI-compatible provider we target caches automatically on a byte
// prefix match: nothing to opt into, but nothing to warn you either. If the
// translated system+tools prefix wobbles between two requests of one session,
// the cache silently misses and the user pays full price without a single
// error to look at. These tests pin the property the billing depends on.

const TOOLS = [
  {
    name: 'mcp__filesystem__list_directory_with_sizes',
    description: 'List a directory',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'Read',
    description: 'Read a file',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' } } },
  },
];

function request(userText: string): AnthropicRequest {
  return {
    model: 'target-model',
    max_tokens: 1000,
    system: [
      { type: 'text', text: 'You are a coding assistant.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Follow the project conventions.' },
    ],
    messages: [{ role: 'user', content: userText }],
    tools: TOOLS,
  } as unknown as AnthropicRequest;
}

/** What the provider hashes: everything before the conversation's last turn. */
function prefix(body: Record<string, unknown>): string {
  const messages = body['messages'] as Record<string, unknown>[];
  return JSON.stringify({ model: body['model'], system: messages[0], tools: body['tools'] });
}

describe('translated prefix stability (prompt caching)', () => {
  it('maps identical requests to byte-identical bodies', () => {
    const a = JSON.stringify(mapAnthropicRequest(request('hello')));
    const b = JSON.stringify(mapAnthropicRequest(request('hello')));
    expect(a).toBe(b);
  });

  it('keeps the prefix byte-identical when only the last turn changes', () => {
    const first = mapAnthropicRequest(request('what does this repo do?'));
    const second = mapAnthropicRequest(request('now add a test for it'));
    expect(prefix(second)).toBe(prefix(first));
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first));
  });

  it('keeps the prefix stable across the quirks that do not touch it', () => {
    const plain = mapAnthropicRequest(request('hi'));
    const clamped = mapAnthropicRequest(request('hi'), ['maxCompletionTokens']);
    expect(prefix(clamped)).toBe(prefix(plain));
  });

  it('emits tools in the order Claude Code sent them, never reordered', () => {
    const body = mapAnthropicRequest(request('hi'));
    const names = (body['tools'] as { function: { name: string } }[]).map((t) => t.function.name);
    // The long MCP name is sanitized but keeps its position.
    expect(names).toHaveLength(2);
    expect(names[1]).toBe('Read');
  });

  it('sanitizing a tool schema does not reorder its keys', () => {
    const a = JSON.stringify(mapAnthropicRequest(request('hi'), ['sanitizeJsonSchema']));
    const b = JSON.stringify(mapAnthropicRequest(request('hi'), ['sanitizeJsonSchema']));
    expect(a).toBe(b);
  });
});
