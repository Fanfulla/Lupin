// SSE state machine: OpenAI chunk stream → Anthropic typed events
// (SPEC-TRANSLATION §5). Pure and synchronous: the server feeds decoded text
// chunks in, gets Anthropic events out. Behaviors below marked "observed" come
// from real captures in test/helpers/captures/ (2026-07-18):
// - SSE comment lines (": OPENROUTER PROCESSING") used as keep-alive → ignored
// - multiple SSE frames can arrive merged in one transport chunk → buffer + split
// - finish_reason repeats on later chunks → handled idempotently
// - usage arrives in a final chunk AFTER the first finish_reason → closing
//   events (message_delta + message_stop) are emitted at [DONE]/stream end

import { mapFinishReason, mapUsage, type OpenAIUsage } from './response.js';
import { DialectNormalizer, type DialectSegment } from './dialect.js';
import type { QuirkName } from './quirks.js';

/** Mid-stream error code → Anthropic error type (same table as core/errors §6). */
function mapErrorCode(code: number | string | undefined): string {
  const n = typeof code === 'string' ? Number(code) : code;
  if (n === 401 || n === 403) return 'authentication_error';
  if (n === 429) return 'rate_limit_error';
  if (n !== undefined && !Number.isNaN(n) && n >= 500) return 'overloaded_error';
  return 'api_error';
}

export interface AnthropicStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface StreamOptions {
  /** Original model name Claude Code asked for (echoed in message_start). */
  requestedModel?: string;
  /** sanitized → original tool names (core/request buildToolNameMap). */
  toolNames?: ReadonlyMap<string, string>;
  /** Profile quirks: drive the §5bis dialect pipeline. */
  quirks?: readonly string[];
  /** The request offered tools: gates parseTextToolCalls (§5bis). */
  hasTools?: boolean;
  /** Diagnostic sink: which normalizations fired (§5bis rule 3). */
  onDialect?: (applied: QuirkName[]) => void;
}

interface OpenAIToolCallFragment {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: {
    index?: number;
    delta?: {
      content?: string | null;
      role?: string;
      tool_calls?: OpenAIToolCallFragment[];
      /** DeepSeek and friends stream reasoning here, not in content (§4). */
      reasoning_content?: unknown;
      reasoning?: unknown;
    };
    finish_reason?: string | null;
  }[];
  usage?: OpenAIUsage | null;
  /** OpenAI-compat providers deliver mid-stream failures as a data frame (§10 caso 8). */
  error?: { message?: string; code?: number | string };
}

export class OpenAIStreamTranslator {
  private buffer = '';
  private started = false;
  private dead = false;
  private closed = false;
  private blockIndex = -1;
  private blockOpen: 'text' | 'thinking' | 'tool_use' | null = null;
  private currentToolIndex: number | null = null;
  private pendingTool: { id?: string; name?: string; args: string } | null = null;
  private finishReason: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  private readonly dialect: DialectNormalizer;
  /** A call recovered from text means the provider's finish_reason lies (§5bis). */
  private synthesizedToolUse = false;

  constructor(private readonly opts: StreamOptions = {}) {
    this.dialect = new DialectNormalizer({
      ...(opts.quirks !== undefined ? { quirks: opts.quirks } : {}),
      ...(opts.hasTools !== undefined ? { hasTools: opts.hasTools } : {}),
    });
  }

  /** Feed one decoded transport chunk; returns the Anthropic events it produced. */
  push(chunk: string): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    this.buffer += chunk;
    const events: AnthropicStreamEvent[] = [];
    let sep: number;
    while ((sep = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + 2);
      this.handleFrame(frame, events);
      if (this.dead || this.closed) break;
    }
    return events;
  }

  /** Stream ended without [DONE]: emit the closing events anyway (§5: never leave the stream hanging). */
  finish(): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    const events: AnthropicStreamEvent[] = [];
    this.closeMessage(events);
    return events;
  }

  /** Provider connection died mid-stream (§5 punto 4): one error event, then the stream is over. */
  abort(message: string): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    this.dead = true;
    return [{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message } } }];
  }

  private handleFrame(frame: string, events: AnthropicStreamEvent[]): void {
    // SSE comment lines start with ':' (observed keep-alive): skipped here
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) return;
    const payload = dataLines.map((l) => l.slice('data:'.length).trimStart()).join('\n');
    if (payload === '[DONE]') {
      this.closeMessage(events);
      return;
    }
    let chunk: OpenAIChunk;
    try {
      chunk = JSON.parse(payload) as OpenAIChunk;
    } catch {
      this.dead = true;
      events.push({
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: '[lupin] malformed provider stream chunk' } },
      });
      return;
    }
    this.handleChunk(chunk, events);
  }

  private handleChunk(c: OpenAIChunk, events: AnthropicStreamEvent[]): void {
    if (c.error !== undefined) {
      // §5 point 4: surface the failure and end the stream, never a clean end_turn
      this.dead = true;
      events.push({
        event: 'error',
        data: {
          type: 'error',
          error: { type: mapErrorCode(c.error.code), message: c.error.message ?? 'provider stream error' },
        },
      });
      return;
    }
    this.ensureStarted(events, c);
    if (c.usage != null) {
      this.inputTokens = c.usage.prompt_tokens ?? this.inputTokens;
      this.outputTokens = c.usage.completion_tokens ?? this.outputTokens;
      this.cachedTokens = c.usage.prompt_tokens_details?.cached_tokens ?? this.cachedTokens;
    }
    const choice = c.choices?.[0];
    if (choice === undefined) return;

    for (const tc of choice.delta?.tool_calls ?? []) this.handleToolFragment(tc, events);

    const reasoning = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
    if (typeof reasoning === 'string' && reasoning !== '') {
      this.emitSegment({ kind: 'thinking', text: reasoning }, events);
    }

    const text = choice.delta?.content;
    if (typeof text === 'string' && text !== '') {
      for (const seg of this.dialect.push(text)) this.emitSegment(seg, events);
    }

    if (choice.finish_reason != null && this.finishReason === null) {
      this.finishReason = choice.finish_reason;
      this.closeBlock(events);
    }
  }

  /**
   * One normalized segment → Anthropic events. Text and thinking stream into an
   * open block of their kind; a tool call recovered from text arrives whole, so
   * its block opens and closes in one go.
   */
  private emitSegment(seg: DialectSegment, events: AnthropicStreamEvent[]): void {
    if (seg.kind === 'toolCall') {
      this.closeBlock(events);
      this.synthesizedToolUse = true;
      this.blockIndex++;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: {
            type: 'tool_use',
            id: seg.id,
            name: this.opts.toolNames?.get(seg.name) ?? seg.name,
            input: {},
          },
        },
      });
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: seg.arguments },
        },
      });
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.blockIndex } });
      return;
    }

    const kind = seg.kind === 'thinking' ? 'thinking' : 'text';
    if (this.blockOpen !== kind) {
      this.closeBlock(events);
      this.blockIndex++;
      this.blockOpen = kind;
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: this.blockIndex,
          content_block: kind === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' },
        },
      });
    }
    events.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: this.blockIndex,
        delta:
          kind === 'thinking' ? { type: 'thinking_delta', thinking: seg.text } : { type: 'text_delta', text: seg.text },
      },
    });
  }

  private handleToolFragment(tc: OpenAIToolCallFragment, events: AnthropicStreamEvent[]): void {
    const index = tc.index ?? 0; // observed in the wild: some providers omit index → assume 0 (§5 insidia a)
    if (this.currentToolIndex !== index) {
      this.closeBlock(events);
      this.currentToolIndex = index;
      const pending: { id?: string; name?: string; args: string } = { args: tc.function?.arguments ?? '' };
      if (tc.id !== undefined) pending.id = tc.id;
      if (tc.function?.name !== undefined) pending.name = tc.function.name;
      this.pendingTool = pending;
      this.tryOpenToolBlock(events);
      return;
    }
    const argsFragment = tc.function?.arguments ?? '';
    if (this.blockOpen === 'tool_use') {
      if (argsFragment !== '') {
        events.push({
          event: 'content_block_delta',
          data: {
            type: 'content_block_delta',
            index: this.blockIndex,
            delta: { type: 'input_json_delta', partial_json: argsFragment },
          },
        });
      }
      return;
    }
    // still buffering: id/name may be split across fragments (§5 insidia b)
    if (this.pendingTool !== null) {
      if (tc.id !== undefined && this.pendingTool.id === undefined) this.pendingTool.id = tc.id;
      if (tc.function?.name !== undefined) this.pendingTool.name = (this.pendingTool.name ?? '') + tc.function.name;
      this.pendingTool.args += argsFragment;
      this.tryOpenToolBlock(events);
    }
  }

  /** content_block_start only once the tool name is known (§5 insidia b). */
  private tryOpenToolBlock(events: AnthropicStreamEvent[], force = false): void {
    const p = this.pendingTool;
    if (p === null) return;
    if (!force && (p.name === undefined || p.name === '')) return;
    this.blockIndex++;
    this.blockOpen = 'tool_use';
    const rawName = p.name ?? '';
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: {
          type: 'tool_use',
          id: p.id ?? `toolu_lupin_${String(this.blockIndex)}`,
          name: this.opts.toolNames?.get(rawName) ?? rawName,
          input: {},
        },
      },
    });
    if (p.args !== '') {
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: p.args },
        },
      });
    }
    this.pendingTool = null;
  }

  private closeBlock(events: AnthropicStreamEvent[]): void {
    if (this.pendingTool !== null) this.tryOpenToolBlock(events, true); // name never arrived: flush anyway
    if (this.blockOpen !== null) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.blockIndex } });
      this.blockOpen = null;
    }
  }

  /** message_start exactly once: also from closeMessage, so a stream that dies
   *  (or sends only [DONE]) before any chunk still opens the message it closes. */
  private ensureStarted(events: AnthropicStreamEvent[], c?: OpenAIChunk): void {
    if (this.started) return;
    this.started = true;
    const id = c?.id ?? 'lupin';
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: id.startsWith('msg_') ? id : `msg_${id}`,
          type: 'message',
          role: 'assistant',
          model: this.opts.requestedModel ?? c?.model ?? '',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // §5: input estimated 0 here, corrected in message_delta
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
  }

  private closeMessage(events: AnthropicStreamEvent[]): void {
    this.ensureStarted(events);
    for (const seg of this.dialect.flush()) this.emitSegment(seg, events);
    this.closeBlock(events);
    if (this.dialect.applied.length > 0) this.opts.onDialect?.(this.dialect.applied);
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        // A tool call rescued from text leaves finish_reason at "stop": Claude
        // Code only runs tools on stop_reason "tool_use", so correct it here.
        delta: {
          stop_reason: this.synthesizedToolUse ? 'tool_use' : mapFinishReason(this.finishReason),
          stop_sequence: null,
        },
        // §4 semantics via the same mapper as non-streaming: cache reads out of input_tokens
        usage: mapUsage({
          prompt_tokens: this.inputTokens,
          completion_tokens: this.outputTokens,
          prompt_tokens_details: { cached_tokens: this.cachedTokens },
        }),
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    this.closed = true;
  }
}
