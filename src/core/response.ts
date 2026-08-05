// Response mapping OpenAI Chat Completions → Anthropic (SPEC-TRANSLATION §4).
// Pure. Only choices[0] is ever read (requests always send n=1).

import { DialectNormalizer, looseParse, type DialectSegment } from './dialect.js';
import type { QuirkName } from './quirks.js';

export interface OpenAIToolCall {
  id?: string;
  index?: number;
  type?: string;
  function: { name: string; arguments: string };
}

export interface OpenAIResponseMessage {
  role: string;
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  reasoning?: unknown; // DeepSeek & co: dropped in v1 (§4)
  reasoning_content?: unknown;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** Cache hits as reported by OpenAI-compat providers (GLM, OpenAI, ...): mapped per §4, not dropped. */
  prompt_tokens_details?: { cached_tokens?: number } | null;
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices: { index?: number; message: OpenAIResponseMessage; finish_reason?: string | null }[];
  usage?: OpenAIUsage | null;
}

export interface MapResponseOptions {
  /** Original model name Claude Code asked for (§4: echoed back, not the real one). */
  requestedModel?: string;
  /** sanitized → original tool names (core/request buildToolNameMap). */
  toolNames?: ReadonlyMap<string, string>;
  /** Profile quirks: drive the §5bis dialect pipeline and loose argument parsing. */
  quirks?: readonly string[];
  /** The request offered tools: gates parseTextToolCalls (§5bis). */
  hasTools?: boolean;
  /** Diagnostic sink: which normalizations fired (§5bis rule 3). */
  onDialect?: (applied: QuirkName[]) => void;
}

/** Malformed JSON in tool arguments: v1 surfaces a clear api_error (§3); repair is M5. */
export class ToolArgumentsParseError extends Error {
  constructor(toolName: string, cause: string) {
    super(`tool "${toolName}" returned malformed JSON arguments: ${cause}`);
    this.name = 'ToolArgumentsParseError';
  }
}

export function mapFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
    case 'content_filter': // §4: end_turn + warning at the logging layer
    default:
      return 'end_turn';
  }
}

/**
 * §4: OpenAI prompt_tokens INCLUDES cache-read tokens; Anthropic input_tokens
 * EXCLUDES them (they travel in cache_read_input_tokens). With cached_tokens > 0
 * we subtract and emit the field; 0/absent: field omitted, never invented.
 */
export function mapUsage(usage: OpenAIUsage | null | undefined): Record<string, number> {
  const prompt = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  if (cached <= 0) return { input_tokens: prompt, output_tokens: output };
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: output,
    cache_read_input_tokens: cached,
  };
}

/** DeepSeek and friends carry reasoning in a sibling field, not in the content (§4). */
function reasoningText(msg: OpenAIResponseMessage): string {
  const raw = msg.reasoning_content ?? msg.reasoning;
  return typeof raw === 'string' ? raw : '';
}

export function mapOpenAIResponse(input: OpenAIResponse, opts: MapResponseOptions = {}): Record<string, unknown> {
  const choice = input.choices[0];
  if (choice === undefined) throw new Error('provider response has no choices');
  const msg = choice.message;

  const content: Record<string, unknown>[] = [];
  // Structured reasoning first: mapping it to a thinking block instead of
  // dropping it is what keeps reasoning models coherent across turns.
  const reasoning = reasoningText(msg);
  if (reasoning !== '') content.push({ type: 'thinking', thinking: reasoning });

  const normalizer = new DialectNormalizer({
    ...(opts.quirks !== undefined ? { quirks: opts.quirks } : {}),
    ...(opts.hasTools !== undefined ? { hasTools: opts.hasTools } : {}),
  });
  const segments: DialectSegment[] =
    typeof msg.content === 'string' && msg.content !== ''
      ? [...normalizer.push(msg.content), ...normalizer.flush()]
      : [];
  let text = '';
  const synthetic: Record<string, unknown>[] = [];
  for (const seg of segments) {
    if (seg.kind === 'text') text += seg.text;
    else if (seg.kind === 'thinking') content.push({ type: 'thinking', thinking: seg.text });
    else {
      const name = opts.toolNames?.get(seg.name) ?? seg.name;
      synthetic.push({ type: 'tool_use', id: seg.id, name, input: parseArguments(name, seg.arguments, opts.quirks) });
    }
  }
  if (text !== '') content.push({ type: 'text', text });
  content.push(...synthetic);
  if (normalizer.applied.length > 0) opts.onDialect?.(normalizer.applied);

  const toolCalls = msg.tool_calls ?? [];
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc === undefined) continue;
    const name = opts.toolNames?.get(tc.function.name) ?? tc.function.name;
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_lupin_${String(i)}`,
      name,
      input: parseArguments(name, tc.function.arguments, opts.quirks),
    });
  }

  const id = input.id ?? 'lupin';
  return {
    id: id.startsWith('msg_') ? id : `msg_${id}`,
    type: 'message',
    role: 'assistant',
    model: opts.requestedModel ?? input.model ?? '',
    content,
    // A tool call rescued from text leaves finish_reason at "stop": Claude Code
    // only runs tools on stop_reason "tool_use", so correct it here (§5bis).
    stop_reason: synthetic.length > 0 ? 'tool_use' : mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: mapUsage(input.usage),
  };
}

function parseArguments(toolName: string, raw: string, quirks?: readonly string[]): unknown {
  if (raw === '') return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    // looseJsonArguments (§5bis): repair only after the strict parse failed, so
    // a provider that is actually fine never goes through the tolerant path.
    if (quirks?.includes('looseJsonArguments') === true) {
      const repaired = looseParse(raw);
      if (repaired !== undefined) return repaired;
    }
    throw new ToolArgumentsParseError(toolName, e instanceof Error ? e.message : String(e));
  }
}
