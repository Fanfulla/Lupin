// M6b request mapping Anthropic -> Google Code Assist
// (DESIGN-TRANSLATORS-DEDICATED §2.2/§2.2bis). Pure: input body -> output body,
// no I/O. The model name arrives already resolved from providers/resolve.
//
// Every shape here answered 200 live on cloudcode-pa.googleapis.com on
// 2026-07-29 (captures in test/helpers/captures/codeassist-*.sse):
// - the envelope is `{model, project, user_prompt_id, request}`: outer keys
//   snake_case, the inner request camelCase, which is not a style choice but
//   what the wire accepts
// - the assistant role is called `model`
// - the system prompt is `systemInstruction`, not a turn
// - a tool call is a `functionCall` part, a tool result a `functionResponse`
// - tools are declared under `functionDeclarations`
// - UNKNOWN FIELDS ARE REJECTED with 400 "Cannot find field" (verified), so
//   nothing Anthropic-only may leak into this body

import { sanitizeToolName, type AnthropicBlock, type AnthropicRequest, type TextBlock } from '../request.js';

/**
 * The fields Gemini's Schema knows. An ALLOW list, not a deny list, because an
 * unknown field is answered with a 400 and fails the whole request: the shared
 * `sanitizeJsonSchema` quirk strips three known offenders, which is the right
 * shape for providers that merely ignore the rest, and the wrong one here.
 *
 * Found by `lupin doctor`, not by a unit test: Claude Code's own tool schemas
 * carry `$schema`, and a real session died on
 * `Unknown name "$schema" at 'request.tools[0].function_declarations[0].parameters'`.
 */
const GEMINI_SCHEMA_KEYS = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
  'default',
  'example',
  'anyOf',
  'propertyOrdering',
]);

/**
 * A JSON Schema reduced to what Gemini accepts. Lowercase type names travel
 * as they are: Claude Code sends `"object"`, and the live API took it (verified
 * end to end 2026-07-29), so they are not uppercased on a guess.
 */
function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    // Under `properties` the keys are the caller's own field names, not schema
    // keywords, so they must pass through untouched: only their values are
    // schemas to be reduced.
    if (k === 'properties' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(v)) props[name] = geminiSchema(sub);
      out[k] = props;
    } else {
      out[k] = geminiSchema(v);
    }
  }
  return out;
}

export interface CodeAssistRequestEnv {
  /** The resolved slot model (gemini-2.5-flash and friends). */
  model: string;
  /** cloudaicompanionProject, from :loadCodeAssist. */
  project: string;
  /** Per-request id the API wants; opaque to us. */
  userPromptId: string;
  /** Stable per-conversation id. */
  sessionId: string;
}

interface Content {
  role: 'user' | 'model';
  parts: Record<string, unknown>[];
}

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
 * A tool result's content, as the `response` object Gemini expects. Anthropic
 * sends free text or blocks; Gemini wants a struct, so text is wrapped under a
 * single `result` key rather than invented into fields that do not exist.
 */
function toolResponse(content: unknown): Record<string, unknown> {
  if (typeof content === 'string') return { result: content };
  if (Array.isArray(content)) {
    const text = content
      .map((b) => (typeof b === 'object' && b !== null && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
    return { result: text };
  }
  if (typeof content === 'object' && content !== null) return content as Record<string, unknown>;
  return { result: '' };
}

/**
 * Anthropic identifies a tool call by id and matches the result against it;
 * Gemini has NO id on functionCall and matches by name alone (verified live).
 * So the ids are resolved here, walking the conversation, and never sent.
 */
function toolNamesById(messages: AnthropicRequest['messages']): Map<string, string> {
  const byId = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const b of msg.content) {
      if (b.type === 'tool_use') {
        const tu = b as { id?: string; name?: string };
        if (typeof tu.id === 'string' && typeof tu.name === 'string') byId.set(tu.id, sanitizeToolName(tu.name));
      }
    }
  }
  return byId;
}

/**
 * One Anthropic message -> its Gemini parts. `thinking` and `redacted_thinking`
 * are dropped: they are Anthropic's own reasoning record, Gemini has no channel
 * for them, and replaying them as text would put private reasoning in the
 * prompt (the §2.1 rule, unchanged here).
 */
function messageParts(
  content: string | AnthropicBlock[],
  namesById: ReadonlyMap<string, string>,
): Record<string, unknown>[] {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];

  const parts: Record<string, unknown>[] = [];
  for (const b of content) {
    switch (b.type) {
      case 'text': {
        if (b.text !== '') parts.push({ text: b.text });
        break;
      }
      case 'image': {
        const src = b.source;
        if (src.type === 'base64' && src.data !== '') {
          parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
        }
        break;
      }
      case 'tool_use': {
        const tu = b as { name?: string; input?: unknown };
        parts.push({
          functionCall: {
            name: sanitizeToolName(tu.name ?? ''),
            args: (tu.input ?? {}) as Record<string, unknown>,
          },
        });
        break;
      }
      case 'tool_result': {
        const tr = b as { tool_use_id?: string; content?: unknown };
        parts.push({
          functionResponse: {
            // No matching tool_use means a truncated history, not a reason to
            // drop the result: the model still needs to see what came back.
            name: namesById.get(tr.tool_use_id ?? '') ?? 'unknown_tool',
            response: toolResponse(tr.content),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

/** Anthropic Messages request -> the Code Assist body. Gemini is stateless: the full history travels. */
export function mapAnthropicToCodeAssist(input: AnthropicRequest, env: CodeAssistRequestEnv): Record<string, unknown> {
  const namesById = toolNamesById(input.messages);

  const contents: Content[] = [];
  for (const msg of input.messages) {
    const parts = messageParts(msg.content, namesById);
    // A turn whose blocks all dropped out carries nothing: an empty parts array
    // is not a valid Content.
    if (parts.length > 0) contents.push({ role: msg.role === 'assistant' ? 'model' : 'user', parts });
  }

  const request: Record<string, unknown> = { contents, session_id: env.sessionId };

  const system = flattenSystem(input.system);
  if (system !== undefined) request['systemInstruction'] = { parts: [{ text: system }] };

  if (input.tools !== undefined && input.tools.length > 0) {
    request['tools'] = [
      {
        functionDeclarations: input.tools.map((t) => ({
          name: sanitizeToolName(t.name),
          ...(t.description !== undefined ? { description: t.description } : {}),
          parameters: geminiSchema(t.input_schema),
        })),
      },
    ];
  }

  // Anthropic tool_choice -> functionCallingConfig. Gemini's modes are AUTO,
  // ANY and NONE; "must call a tool" and "must call THIS tool" are both ANY,
  // the second narrowed by allowedFunctionNames.
  const tc = input.tool_choice;
  if (tc !== undefined) {
    if (tc.type === 'tool' && tc.name !== undefined) {
      request['toolConfig'] = {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [sanitizeToolName(tc.name)] },
      };
    } else if (tc.type === 'any') {
      request['toolConfig'] = { functionCallingConfig: { mode: 'ANY' } };
    } else if (tc.type === 'none') {
      request['toolConfig'] = { functionCallingConfig: { mode: 'NONE' } };
    } else {
      request['toolConfig'] = { functionCallingConfig: { mode: 'AUTO' } };
    }
  }

  // The sampling and length knobs, which this provider really does honour: WHAM
  // refuses every one of them (§2.1), Code Assist accepts them (verified live
  // 2026-07-29, stopSequences included, and the cut was real). Only fields
  // proven on the wire go in: an unknown one is answered with a 400
  // "Cannot find field", so a guess here would break every request.
  //
  // KNOWN TRAP, not solved in this pure layer: maxOutputTokens is spent by the
  // model's THINKING tokens too. A small max_tokens can therefore come back
  // with finishReason MAX_TOKENS and NO content at all (seen live: 20 tokens in,
  // 16 spent thinking, zero text out). `thinkingConfig: {thinkingBudget: 0}` is
  // accepted and fixes it, at the cost of the model's reasoning.
  const gen: Record<string, unknown> = {};
  if (input.max_tokens > 0) gen['maxOutputTokens'] = input.max_tokens;
  if (input.temperature !== undefined) gen['temperature'] = input.temperature;
  if (input.top_p !== undefined) gen['topP'] = input.top_p;
  // top_k has no Responses-API equivalent (§2.1 limit 6); here it does, verified.
  if (input.top_k !== undefined) gen['topK'] = input.top_k;
  if (input.stop_sequences !== undefined && input.stop_sequences.length > 0) {
    gen['stopSequences'] = input.stop_sequences;
  }
  if (Object.keys(gen).length > 0) request['generationConfig'] = gen;

  return {
    model: env.model,
    project: env.project,
    user_prompt_id: env.userPromptId,
    request,
  };
}
