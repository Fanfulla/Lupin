// M6a Responses API stream translator (DESIGN-TRANSLATORS-DEDICATED §2.1):
// WHAM Responses SSE -> Anthropic typed events. Pure and synchronous, like its
// Chat Completions sibling (core/stream.ts): the server feeds decoded transport
// chunks in, gets Anthropic events out. The grammar below is from REAL captures
// (test/helpers/captures/wham-*.sse, 2026-07-29), never invented:
//
//   text:      response.created -> response.output_item.added (message)
//              -> response.content_part.added -> response.output_text.delta*
//              -> response.output_text.done -> ... -> response.completed
//   tool call: response.output_item.added (item.type="function_call")
//              -> response.function_call_arguments.delta*
//              -> response.function_call_arguments.done -> response.output_item.done
//   usage:     on response.completed only (usage.input/output_tokens)
//
// WHAM has NO non-streaming mode (stream:true is mandatory), so this machine is
// also what a non-streaming Anthropic caller is recomposed from.

import type { AnthropicStreamEvent } from '../stream.js';
import { OutputLimiter, type LimitStop } from './limits.js';

export interface ResponsesStreamOptions {
  /** Original model name Claude Code asked for (echoed in message_start). */
  requestedModel?: string;
  /** sanitized -> original tool names (core/request buildToolNameMap). */
  toolNames?: ReadonlyMap<string, string>;
  /**
   * Anthropic max_tokens. WHAM refuses it as a request parameter, so it is
   * enforced here instead: the cut is exact, o200k_base counts WHAM's own text
   * (§2.1bis). Tool-call arguments are deliberately NOT counted or truncated:
   * half a JSON object is a broken tool call, which is worse than a slightly
   * long answer.
   */
  maxTokens?: number;
  /** Anthropic stop_sequences, enforced here for the same reason. */
  stopSequences?: readonly string[];
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

interface ResponsesEvent {
  type?: string;
  // response.created / in_progress / completed carry the whole response object
  response?: { id?: string; model?: string; status?: string; usage?: ResponsesUsage | null };
  // output_item.added / done carry the item (message or function_call)
  item?: {
    id?: string;
    type?: string;
    role?: string;
    status?: string;
    name?: string;
    call_id?: string;
    arguments?: string;
  };
  // *_delta events
  delta?: string;
  // function_call_arguments.done carries the full arguments
  arguments?: string;
  // output_text.done carries the full text (ignored: already streamed in deltas)
}

export class ResponsesStreamTranslator {
  private buffer = '';
  private started = false;
  private dead = false;
  private closed = false;
  private responseId = 'lupin';
  private blockIndex = -1;
  private blockOpen: 'text' | 'tool_use' | null = null;
  private sawToolCall = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;
  /** Set when a proxy-side limit (max_tokens / stop_sequences) ended the message. */
  private limitStop: LimitStop | undefined;
  private matchedStopSequence: string | undefined;
  private readonly limiter: OutputLimiter;

  constructor(private readonly opts: ResponsesStreamOptions = {}) {
    this.limiter = new OutputLimiter({
      ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      ...(opts.stopSequences !== undefined ? { stopSequences: opts.stopSequences } : {}),
    });
  }

  /**
   * True once a proxy-side limit closed the message: the caller should stop
   * reading upstream (the provider would otherwise keep generating for nothing).
   */
  get limitReached(): boolean {
    return this.limitStop !== undefined;
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

  /** Stream ended without response.completed (§5 punto 5): every terminal path
   *  closes the message on its own, so reaching here means the body stopped mid
   *  answer. An error, never a synthesized clean turn (issue #1). */
  finish(): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    return this.abort('[lupin] provider stream ended without a terminal event');
  }

  /** Provider connection died mid-stream: one error event, then the stream is over. */
  abort(message: string): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    this.dead = true;
    return [{ event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message } } }];
  }

  private handleFrame(frame: string, events: AnthropicStreamEvent[]): void {
    const dataLines = frame.split('\n').filter((l) => l.startsWith('data:'));
    if (dataLines.length === 0) return;
    const payload = dataLines.map((l) => l.slice('data:'.length).trimStart()).join('\n');
    let ev: ResponsesEvent;
    try {
      ev = JSON.parse(payload) as ResponsesEvent;
    } catch {
      this.dead = true;
      events.push({
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: '[lupin] malformed WHAM stream frame' } },
      });
      return;
    }
    this.handleEvent(ev, events);
  }

  private handleEvent(ev: ResponsesEvent, events: AnthropicStreamEvent[]): void {
    switch (ev.type) {
      case 'response.created':
      case 'response.in_progress': {
        this.responseId = ev.response?.id ?? this.responseId;
        this.ensureStarted(events);
        return;
      }
      case 'response.output_item.added': {
        if (ev.item?.type === 'function_call') {
          this.ensureStarted(events);
          this.sawToolCall = true;
          this.openToolBlock(ev.item, events);
        }
        return;
      }
      case 'response.output_text.delta': {
        this.ensureStarted(events);
        if (typeof ev.delta !== 'string' || ev.delta === '') return;
        if (this.limiter.inactive) {
          this.openTextBlockIfNeeded(events);
          events.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: ev.delta } },
          });
          return;
        }
        // max_tokens / stop_sequences are enforced here: WHAM will not do it.
        const r = this.limiter.push(ev.delta);
        if (r.emit !== '') {
          this.openTextBlockIfNeeded(events);
          events.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: r.emit } },
          });
        }
        if (r.stop !== undefined) {
          this.limitStop = r.stop;
          this.matchedStopSequence = r.matched;
          this.closeMessage(events);
        }
        return;
      }
      case 'response.function_call_arguments.delta': {
        // The tool block opened on output_item.added; stream the argument bytes.
        if (this.blockOpen === 'tool_use' && typeof ev.delta === 'string' && ev.delta !== '') {
          events.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: this.blockIndex,
              delta: { type: 'input_json_delta', partial_json: ev.delta },
            },
          });
        }
        return;
      }
      case 'response.output_item.done': {
        // A finished function_call closes its block; a finished message closes the text block.
        this.closeBlock(events);
        return;
      }
      case 'response.completed': {
        const u = ev.response?.usage;
        if (u != null) {
          this.inputTokens = u.input_tokens ?? this.inputTokens;
          this.outputTokens = u.output_tokens ?? this.outputTokens;
          this.cachedTokens = u.input_tokens_details?.cached_tokens ?? this.cachedTokens;
        }
        this.closeMessage(events);
        return;
      }
      case 'response.failed': {
        this.dead = true;
        events.push({
          event: 'error',
          data: { type: 'error', error: { type: 'api_error', message: '[lupin] WHAM response failed' } },
        });
        return;
      }
      default:
        // content_part.added/done, output_text.done, output_item.done for
        // messages, and the many bookkeeping events: no Anthropic event needed.
        return;
    }
  }

  private openTextBlockIfNeeded(events: AnthropicStreamEvent[]): void {
    if (this.blockOpen === 'text') return;
    this.closeBlock(events);
    this.blockIndex++;
    this.blockOpen = 'text';
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index: this.blockIndex, content_block: { type: 'text', text: '' } },
    });
  }

  private openToolBlock(item: NonNullable<ResponsesEvent['item']>, events: AnthropicStreamEvent[]): void {
    this.closeBlock(events);
    this.blockIndex++;
    this.blockOpen = 'tool_use';
    const rawName = item.name ?? '';
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: {
          type: 'tool_use',
          id: item.call_id ?? `toolu_lupin_${String(this.blockIndex)}`,
          name: this.opts.toolNames?.get(rawName) ?? rawName,
          input: {},
        },
      },
    });
  }

  private closeBlock(events: AnthropicStreamEvent[]): void {
    if (this.blockOpen !== null) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: this.blockIndex } });
      this.blockOpen = null;
    }
  }

  private ensureStarted(events: AnthropicStreamEvent[]): void {
    if (this.started) return;
    this.started = true;
    const id = this.responseId;
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: id.startsWith('msg_') ? id : `msg_${id}`,
          type: 'message',
          role: 'assistant',
          model: this.opts.requestedModel ?? '',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    });
  }

  private closeMessage(events: AnthropicStreamEvent[]): void {
    if (this.closed) return;
    this.ensureStarted(events);
    // Release whatever the stop-sequence hold-back was still weighing up.
    if (!this.limiter.inactive && this.limitStop === undefined) {
      const rest = this.limiter.flush();
      if (rest.emit !== '') {
        this.openTextBlockIfNeeded(events);
        events.push({
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: rest.emit } },
        });
      }
      if (rest.stop !== undefined) this.limitStop = rest.stop;
    }
    this.closeBlock(events);
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: this.limitStop ?? (this.sawToolCall ? 'tool_use' : 'end_turn'),
          stop_sequence: this.matchedStopSequence ?? null,
        },
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: this.outputTokens,
          ...(this.cachedTokens > 0 ? { cache_read_input_tokens: this.cachedTokens } : {}),
        },
      },
    });
    events.push({ event: 'message_stop', data: { type: 'message_stop' } });
    this.closed = true;
  }
}
