// M6a request mapping Anthropic -> OpenAI Responses API over WHAM
// (DESIGN-TRANSLATORS-DEDICATED §2.1). Pure: input body -> output body, no I/O.
// The model name is passed through as-is: slot resolution happens in
// providers/resolve, before this layer.
//
// Every shape here was verified live against WHAM on 2026-07-29 (captures in
// test/helpers/captures/wham-*.sse), never inferred:
// - content blocks must be `input_text` (`text` is rejected)
// - `instructions` carries the system prompt
// - a prior tool call is `{type:'function_call', call_id, name, arguments}`
// - a tool result is `{type:'function_call_output', call_id, output}`
// - tools are FLAT `{type:'function', name, description, parameters}`
//   (not nested under `function` as in Chat Completions)
// - `store:false` and `stream:true` are both mandatory (WHAM has no
//   non-streaming mode; the caller recomposes from the stream)

import { sanitizeToolName, type AnthropicBlock, type AnthropicRequest, type TextBlock } from '../request.js';
import { sanitizeJsonSchema } from '../quirks.js';

/** Anthropic `system` (string or blocks) flattened into the Responses `instructions`. */
function flattenSystem(system: AnthropicRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system === '' ? undefined : system;
  const text = system
    .map((b: TextBlock) => b.text)
    .filter((t) => typeof t === 'string' && t !== '')
    .join('\n\n');
  return text === '' ? undefined : text;
}

/**
 * The Responses content parts for one message. Text and images both travel;
 * WHAM accepts `input_image` with a data URL (verified live 2026-07-29), so a
 * vision request must NOT be flattened to its text alone. `thinking` and
 * `redacted_thinking` blocks are deliberately dropped: they are Anthropic's own
 * reasoning record, WHAM has no channel for them, and echoing them back as
 * plain text would put the model's private reasoning into the prompt.
 */
function messageContent(content: string | AnthropicBlock[], role: 'user' | 'assistant' | 'developer'): Record<string, unknown>[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text';
  if (typeof content === 'string') return content === '' ? [] : [{ type: textType, text: content }];

  const parts: Record<string, unknown>[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text !== '') parts.push({ type: textType, text: b.text });
    } else if (b.type === 'image' && role !== 'assistant') {
      // Only an input message may carry an image; an assistant turn cannot.
      const src = b.source;
      if (src.type === 'base64' && src.data !== '') {
        parts.push({ type: 'input_image', image_url: `data:${src.media_type};base64,${src.data}` });
      }
    }
  }
  return parts;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/**
 * Anthropic role -> the role WHAM accepts on an input message.
 *
 * Claude Code puts hook output (SessionStart and friends) into the messages
 * array as `role:"system"`, and WHAM rejects the whole request with
 * `{"detail":"System messages are not allowed"}` (found by `lupin doctor` on
 * 2026-07-29, then isolated: `developer` is accepted, `system` is not).
 * `developer` is the Responses API's own channel for system-level guidance, so
 * that instruction reaches the model instead of killing the session.
 */
function wireRole(role: string): 'user' | 'assistant' | 'developer' {
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  return 'developer';
}

export interface ResponsesRequestOptions {
  /** Overrides the outgoing model (the resolved slot model). */
  model?: string;
}

/**
 * Anthropic Messages request -> WHAM Responses request. The conversation is
 * flattened into the `input` array: WHAM is stateless, so the FULL history
 * travels on every call.
 */
export function mapAnthropicToResponses(
  input: AnthropicRequest,
  opts: ResponsesRequestOptions = {},
): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];

  for (const msg of input.messages) {
    const content = msg.content;

    // A tool_result block is its own top-level item, not part of a message.
    if (Array.isArray(content)) {
      const results = content.filter((b) => b.type === 'tool_result');
      for (const r of results) {
        const tr = r as { tool_use_id?: string; content?: unknown };
        items.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id ?? '',
          output: toolResultText(tr.content),
        });
      }

      // An assistant tool_use becomes a function_call item.
      const calls = content.filter((b) => b.type === 'tool_use');
      for (const c of calls) {
        const tu = c as { id?: string; name?: string; input?: unknown };
        items.push({
          type: 'function_call',
          call_id: tu.id ?? '',
          name: sanitizeToolName(tu.name ?? ''),
          arguments: JSON.stringify(tu.input ?? {}),
        });
      }
    }

    // The remaining text becomes a message item. Empty text carries nothing:
    // a message with no content is noise WHAM does not need.
    // The content type is role-dependent and WHAM enforces it (verified live
    // 2026-07-29: an assistant `input_text` is rejected with "Supported values
    // are: 'output_text' and 'refusal'").
    const role = wireRole(msg.role);
    const parts = messageContent(content, role);
    if (parts.length > 0) items.push({ type: 'message', role, content: parts });
  }

  const out: Record<string, unknown> = {
    model: opts.model ?? input.model,
    input: items,
    // Both verified mandatory on WHAM (2026-07-29).
    store: false,
    stream: true,
  };

  const instructions = flattenSystem(input.system);
  if (instructions !== undefined) out['instructions'] = instructions;

  if (input.tools !== undefined && input.tools.length > 0) {
    out['tools'] = input.tools.map((t) => ({
      type: 'function',
      name: sanitizeToolName(t.name),
      ...(t.description !== undefined ? { description: t.description } : {}),
      parameters: sanitizeJsonSchema(t.input_schema),
    }));
  }

  // Anthropic tool_choice -> Responses tool_choice (the shapes coincide for
  // auto/none; "any" means "must call some tool" = required).
  if (input.tool_choice !== undefined) {
    const tc = input.tool_choice;
    if (tc.type === 'tool' && tc.name !== undefined) {
      out['tool_choice'] = { type: 'function', name: sanitizeToolName(tc.name) };
    } else if (tc.type === 'any') {
      out['tool_choice'] = 'required';
    } else if (tc.type === 'none' || tc.type === 'auto') {
      out['tool_choice'] = tc.type;
    }
  }

  // Sampling and length controls are NOT forwarded. WHAM answers
  // `{"detail":"Unsupported parameter: X"}` for `temperature`, `top_p`,
  // `max_output_tokens` and `stop` alike (each verified live 2026-07-29), and
  // one unsupported parameter fails the WHOLE request. Anthropic's
  // max_tokens / temperature / top_p / stop_sequences therefore have no
  // equivalent here and are dropped rather than faked: a dropped knob costs
  // control, a forwarded one would cost every request.

  return out;
}
