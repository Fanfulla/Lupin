// M6b Code Assist stream translator (DESIGN-TRANSLATORS-DEDICATED §2.2bis):
// Google Code Assist SSE -> Anthropic typed events. Pure and synchronous, like
// its siblings (core/stream.ts, core/responses/stream.ts): the server feeds
// decoded transport chunks in, gets Anthropic events out.
//
// The grammar is from REAL captures (test/helpers/captures/codeassist-*.sse,
// 2026-07-29) and differs from both siblings in three ways that matter:
//
//   1. There are no event TYPES. Every frame is the same shape,
//      `data: {"response": <GenerateContentResponse>, "traceId", "metadata"}`,
//      and the payload is WRAPPED under `response`.
//   2. Deltas are whole parts, not token slices: each frame carries a
//      `parts` array whose text is appended to what came before.
//   3. Usage arrives ONLY on the final frame; intermediate frames carry a
//      near-empty usageMetadata. finishReason likewise marks the last frame.
//
// A `functionCall` part has NO id (Google matches tools by name), so the
// tool_use id Anthropic requires is synthesized here. A part may also carry an
// opaque `thoughtSignature`: it is deliberately not emitted, since it is not
// text and has no Anthropic block.

import type { AnthropicStreamEvent } from '../stream.js';

export interface CodeAssistStreamOptions {
  /** Original model name Claude Code asked for (echoed in message_start). */
  requestedModel?: string;
  /** sanitized -> original tool names (core/request buildToolNameMap). */
  toolNames?: ReadonlyMap<string, string>;
}

interface Part {
  text?: string;
  thoughtSignature?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
}

interface CaFrame {
  response?: {
    candidates?: { content?: { role?: string; parts?: Part[] }; finishReason?: string }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number };
    responseId?: string;
  };
}

/** Gemini finishReason -> Anthropic stop_reason. */
function stopReason(finish: string | undefined, sawToolCall: boolean): string {
  if (sawToolCall) return 'tool_use';
  switch (finish) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    // SAFETY, RECITATION, BLOCKLIST and friends all mean "the model stopped
    // early on its own terms"; Anthropic has no matching reason, and end_turn
    // is the honest fallback rather than inventing one.
    default:
      return 'end_turn';
  }
}

export class CodeAssistStreamTranslator {
  private buffer = '';
  private started = false;
  private dead = false;
  private closed = false;
  private responseId = 'lupin';
  private blockIndex = -1;
  private blockOpen: 'text' | 'tool_use' | null = null;
  private sawToolCall = false;
  private finishReason: string | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedTokens = 0;

  constructor(private readonly opts: CodeAssistStreamOptions = {}) {}

  /** Feed one decoded transport chunk; returns the Anthropic events it produced. */
  push(chunk: string): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    this.buffer += chunk;
    const events: AnthropicStreamEvent[] = [];
    for (;;) {
      // Code Assist separates frames with CRLF CRLF, unlike WHAM's bare LF LF
      // (verified in the captures). Both are accepted here, and the earliest
      // wins, so a chunk boundary landing between \r and \n simply waits.
      const crlf = this.buffer.indexOf('\r\n\r\n');
      const lf = this.buffer.indexOf('\n\n');
      let sep = -1;
      let width = 2;
      if (crlf !== -1 && (lf === -1 || crlf <= lf)) {
        sep = crlf;
        width = 4;
      } else if (lf !== -1) {
        sep = lf;
      }
      if (sep === -1) break;
      const frame = this.buffer.slice(0, sep);
      this.buffer = this.buffer.slice(sep + width);
      this.handleFrame(frame, events);
      if (this.dead || this.closed) break;
    }
    return events;
  }

  /** Stream ended: close cleanly even if the last frame never arrived. */
  finish(): AnthropicStreamEvent[] {
    if (this.dead || this.closed) return [];
    const events: AnthropicStreamEvent[] = [];
    this.closeMessage(events);
    return events;
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
    if (payload === '' || payload === '[DONE]') return;
    let ev: CaFrame;
    try {
      ev = JSON.parse(payload) as CaFrame;
    } catch {
      this.dead = true;
      events.push({
        event: 'error',
        data: { type: 'error', error: { type: 'api_error', message: '[lupin] malformed Code Assist stream frame' } },
      });
      return;
    }
    this.handleResponse(ev, events);
  }

  private handleResponse(ev: CaFrame, events: AnthropicStreamEvent[]): void {
    const res = ev.response;
    if (res === undefined) return;
    this.responseId = res.responseId ?? this.responseId;
    this.ensureStarted(events);

    const candidate = res.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      this.handlePart(part, events);
    }

    // Usage is complete only on the final frame; the intermediate ones carry a
    // stub, so a missing count must never overwrite a real one with zero.
    const u = res.usageMetadata;
    if (u !== undefined) {
      this.inputTokens = u.promptTokenCount ?? this.inputTokens;
      this.outputTokens = u.candidatesTokenCount ?? this.outputTokens;
      this.cachedTokens = u.cachedContentTokenCount ?? this.cachedTokens;
    }

    if (candidate?.finishReason !== undefined) {
      this.finishReason = candidate.finishReason;
      this.closeMessage(events);
    }
  }

  private handlePart(part: Part, events: AnthropicStreamEvent[]): void {
    if (part.functionCall !== undefined) {
      this.sawToolCall = true;
      this.openToolBlock(part.functionCall, events);
      // Gemini sends the arguments whole, never in slices, so the whole JSON
      // goes out as a single input_json_delta and the block closes at once.
      const args = JSON.stringify(part.functionCall.args ?? {});
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.blockIndex,
          delta: { type: 'input_json_delta', partial_json: args },
        },
      });
      this.closeBlock(events);
      return;
    }

    // `thought: true` marks the model's own reasoning text, and
    // thoughtSignature is an opaque blob. Neither is an Anthropic block, and
    // replaying either as assistant text would surface private reasoning.
    if (part.thought === true) return;
    if (typeof part.text !== 'string' || part.text === '') return;

    this.openTextBlockIfNeeded(events);
    events.push({
      event: 'content_block_delta',
      data: { type: 'content_block_delta', index: this.blockIndex, delta: { type: 'text_delta', text: part.text } },
    });
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

  private openToolBlock(call: NonNullable<Part['functionCall']>, events: AnthropicStreamEvent[]): void {
    this.closeBlock(events);
    this.blockIndex++;
    this.blockOpen = 'tool_use';
    const rawName = call.name ?? '';
    events.push({
      event: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: this.blockIndex,
        content_block: {
          type: 'tool_use',
          // Google sends no id: Anthropic requires one, and the tool_result
          // that comes back will quote it, so it is minted here and resolved
          // back to a name by the request mapper.
          id: `toolu_lupin_${this.responseId}_${String(this.blockIndex)}`,
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
    events.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: `msg_${this.responseId}`,
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
    this.closeBlock(events);
    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: {
          stop_reason: stopReason(this.finishReason, this.sawToolCall),
          // Gemini reports a stop-sequence cut as a plain STOP, with no way to
          // tell which sequence fired (verified live), so this stays null
          // rather than guessing one.
          stop_sequence: null,
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
