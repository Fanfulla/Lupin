// Request mapping Anthropic → OpenAI Chat Completions (SPEC-TRANSLATION §1–3).
// Pure: input body → output body, no I/O. Model is passed through as-is:
// slot resolution happens in providers/resolve, before this layer.

import { sanitizeJsonSchema } from './quirks.js';

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: unknown;
}
export interface ImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | AnthropicBlock[];
  is_error?: boolean;
}
export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking';
  [k: string]: unknown;
}
export type AnthropicBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | TextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool' | 'none'; name?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  thinking?: unknown;
}

const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * OpenAI limits tool names to 64 chars of [a-zA-Z0-9_-]; Claude Code MCP names
 * can exceed that (SPEC-TRANSLATION §3, mandatory). Deterministic, so the
 * reverse map can always be rebuilt from the original tool list.
 */
export function sanitizeToolName(name: string): string {
  if (VALID_TOOL_NAME.test(name)) return name;
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (VALID_TOOL_NAME.test(cleaned)) return cleaned;
  return `${cleaned.slice(0, 48)}_${fnv1a(name)}`;
}

/** sanitized name → original name, for mapping tool calls in responses back. */
export function buildToolNameMap(tools: readonly AnthropicTool[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tools) map.set(sanitizeToolName(t.name), t.name);
  return map;
}

export function mapAnthropicRequest(input: AnthropicRequest, quirks: readonly string[] = []): Record<string, unknown> {
  const q = new Set(quirks);
  const out: Record<string, unknown> = { model: input.model };

  const messages: Record<string, unknown>[] = [];
  const system = flattenSystem(input.system);
  if (system !== undefined) messages.push({ role: 'system', content: system });
  for (const m of input.messages) messages.push(...mapMessage(m));
  out.messages = messages;

  if (q.has('maxCompletionTokens')) out.max_completion_tokens = input.max_tokens;
  else out.max_tokens = input.max_tokens;

  if (input.tools !== undefined && input.tools.length > 0) {
    out.tools = input.tools.map((t) => ({
      type: 'function',
      function: {
        name: sanitizeToolName(t.name),
        ...(t.description !== undefined ? { description: t.description } : {}),
        parameters: q.has('sanitizeJsonSchema') ? sanitizeJsonSchema(t.input_schema) : t.input_schema,
      },
    }));
    if (q.has('noParallelToolCalls')) out.parallel_tool_calls = false;
  }
  if (input.tool_choice !== undefined) out.tool_choice = mapToolChoice(input.tool_choice);

  if (!q.has('noTemperatureOnReasoning')) {
    if (input.temperature !== undefined) out.temperature = input.temperature;
    if (input.top_p !== undefined) out.top_p = input.top_p;
  }
  if (input.stop_sequences !== undefined && input.stop_sequences.length > 0) {
    out.stop = input.stop_sequences.slice(0, 4); // OpenAI max 4 (§1)
  }
  if (input.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  if (input.metadata?.user_id !== undefined) out.user = input.metadata.user_id;
  out.n = 1; // §4: only choices[0] is ever read
  // dropped by design (§1): top_k, thinking (v1)
  return out;
}

function flattenSystem(system: AnthropicRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  // array of text blocks: join with \n\n, cache_control markers dropped (§1, §5)
  return system.map((b) => b.text).join('\n\n');
}

function mapToolChoice(tc: NonNullable<AnthropicRequest['tool_choice']>): unknown {
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: sanitizeToolName(tc.name ?? '') } };
  }
}

function mapMessage(m: AnthropicMessage): Record<string, unknown>[] {
  if (typeof m.content === 'string') {
    return [{ role: m.role, content: m.content }];
  }
  return m.role === 'assistant' ? mapAssistantBlocks(m.content) : mapUserBlocks(m.content);
}

function mapAssistantBlocks(blocks: AnthropicBlock[]): Record<string, unknown>[] {
  // thinking/redacted_thinking in history: dropped (§2 rule 6)
  const text = blocks
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolCalls = blocks
    .filter((b): b is ToolUseBlock => b.type === 'tool_use')
    .map((b) => ({
      id: b.id,
      type: 'function',
      function: { name: sanitizeToolName(b.name), arguments: JSON.stringify(b.input) },
    }));
  const msg: Record<string, unknown> = { role: 'assistant', content: text === '' ? null : text };
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return [msg];
}

function mapUserBlocks(blocks: AnthropicBlock[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  // §2 rules 1-2: tool_result blocks become role:tool messages, placed first so
  // they immediately follow the assistant message carrying the tool_calls.
  for (const b of blocks) {
    if (b.type === 'tool_result') {
      out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: toolResultText(b) });
    }
  }
  const rest = blocks.filter((b) => b.type === 'text' || b.type === 'image');
  if (rest.length > 0) {
    const hasImage = rest.some((b) => b.type === 'image');
    if (!hasImage) {
      out.push({ role: 'user', content: rest.map((b) => (b as TextBlock).text).join('') });
    } else {
      out.push({
        role: 'user',
        content: rest.map((b) =>
          b.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
            : { type: 'text', text: (b as TextBlock).text },
        ),
      });
    }
  }
  return out;
}

function toolResultText(b: ToolResultBlock): string {
  let text: string;
  if (b.content === undefined) text = '';
  else if (typeof b.content === 'string') text = b.content;
  else {
    // §2 rule 7: role:tool only takes strings, so text blocks are concatenated and images dropped
    text = b.content
      .filter((c): c is TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  }
  return b.is_error === true ? `Error: ${text}` : text; // §2 rule 8
}
