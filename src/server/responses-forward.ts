// M6a responses-mode wiring (DESIGN-TRANSLATORS-DEDICATED §2.1): Anthropic
// ingress body -> core/responses mappers -> WHAM Responses API -> Anthropic
// response/SSE back out. Sibling of translate.ts; all translation logic lives
// in core/, this module only moves bytes.
//
// The one structural difference from translate mode: WHAM has NO non-streaming
// mode (`stream:true` is mandatory, verified live 2026-07-29), so a
// non-streaming Anthropic caller is served by consuming the stream here and
// recomposing the Message from the very same translator. One grammar, one
// implementation, no second parser to drift (the ADR-22 lesson).

import type { ProfileConfig } from '../config/config.js';
import type { ResolvedCredential } from './credential.js';
import { buildToolNameMap, type AnthropicRequest } from '../core/request.js';
import { mapAnthropicToResponses } from '../core/responses/request.js';
import { ResponsesStreamTranslator } from '../core/responses/stream.js';
import type { AnthropicStreamEvent } from '../core/stream.js';
import { networkError, normalizeProviderError, type NormalizedError } from '../core/errors.js';

export interface ResponsesForwardArgs {
  /** Original Anthropic body from Claude Code (model not yet rewritten). */
  body: Record<string, unknown>;
  /** Real model name after slot resolution. */
  model: string;
  /** Model name Claude Code asked for (echoed back in responses). */
  requestedModel: string;
  profile: ProfileConfig;
  baseUrl: string;
  credential: ResolvedCredential;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Keep-alive ping cadence toward Claude Code during slow streams. */
  pingIntervalMs?: number;
}

export type ResponsesForwardResult = { status: number; response: Response } | { err: NormalizedError };

export async function responsesForward(args: ResponsesForwardArgs): Promise<ResponsesForwardResult> {
  const anthropicReq = { ...args.body, model: args.model } as unknown as AnthropicRequest;
  const toolNames = buildToolNameMap(anthropicReq.tools ?? []);
  const providerBody = mapAnthropicToResponses(anthropicReq, { model: args.model });

  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  headers.set(args.credential.header, args.credential.value);

  let providerRes: Response;
  try {
    providerRes = await args.fetchImpl(args.baseUrl + '/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify(providerBody),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (e) {
    return { err: networkError(e instanceof Error ? e.message : String(e)) };
  }

  if (!providerRes.ok) {
    const raw = await providerRes.text();
    const retryAfter = providerRes.headers.get('retry-after');
    return {
      err: normalizeProviderError(providerRes.status, raw, retryAfter ?? undefined, new Set(args.profile.quirks ?? [])),
    };
  }

  // max_tokens and stop_sequences never reach WHAM (it rejects both), so they
  // travel to the translator, which enforces them inside the stream instead.
  const opts = {
    requestedModel: args.requestedModel,
    toolNames,
    ...(typeof anthropicReq.max_tokens === 'number' && anthropicReq.max_tokens > 0
      ? { maxTokens: anthropicReq.max_tokens }
      : {}),
    ...((anthropicReq.stop_sequences ?? []).length > 0 ? { stopSequences: anthropicReq.stop_sequences } : {}),
  };

  if (anthropicReq.stream === true) {
    return { status: 200, response: streamResponse(providerRes, opts, args.pingIntervalMs ?? 15_000) };
  }

  // Non-streaming caller: consume the mandatory stream and rebuild the Message.
  const translator = new ResponsesStreamTranslator(opts);
  const events: AnthropicStreamEvent[] = [];
  try {
    const text = await providerRes.text();
    events.push(...translator.push(text), ...translator.finish());
  } catch (e) {
    return { err: networkError(`WHAM stream failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  return {
    status: 200,
    response: new Response(JSON.stringify(recomposeMessage(events)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
}

/**
 * Anthropic stream events -> the non-streaming Message they describe. The
 * translator stays the single source of grammar truth: this only folds its
 * output, so streaming and non-streaming can never disagree.
 */
export function recomposeMessage(events: readonly AnthropicStreamEvent[]): Record<string, unknown> {
  let message: Record<string, unknown> = {};
  const content: Record<string, unknown>[] = [];
  let current: Record<string, unknown> | undefined;
  let toolJson = '';

  for (const ev of events) {
    switch (ev.event) {
      case 'message_start': {
        message = { ...(ev.data['message'] as Record<string, unknown>) };
        break;
      }
      case 'content_block_start': {
        current = { ...(ev.data['content_block'] as Record<string, unknown>) };
        toolJson = '';
        break;
      }
      case 'content_block_delta': {
        const delta = ev.data['delta'] as Record<string, unknown>;
        if (delta['type'] === 'text_delta' && current !== undefined) {
          current['text'] = String(current['text'] ?? '') + String(delta['text'] ?? '');
        } else if (delta['type'] === 'input_json_delta') {
          toolJson += String(delta['partial_json'] ?? '');
        }
        break;
      }
      case 'content_block_stop': {
        if (current !== undefined) {
          if (current['type'] === 'tool_use') {
            try {
              current['input'] = toolJson === '' ? {} : (JSON.parse(toolJson) as unknown);
            } catch {
              // Malformed tool JSON stays visible as the raw string rather than
              // silently becoming {}: repair is M5, honesty is now.
              current['input'] = toolJson;
            }
          }
          content.push(current);
          current = undefined;
        }
        break;
      }
      case 'message_delta': {
        const delta = ev.data['delta'] as Record<string, unknown>;
        message['stop_reason'] = delta['stop_reason'] ?? null;
        message['stop_sequence'] = delta['stop_sequence'] ?? null;
        message['usage'] = ev.data['usage'] ?? message['usage'];
        break;
      }
      default:
        break;
    }
  }

  message['content'] = content;
  return message;
}

/** WHAM SSE -> Anthropic SSE, streamed through the core state machine. */
function streamResponse(
  providerRes: Response,
  opts: { requestedModel: string; toolNames: ReadonlyMap<string, string> },
  pingIntervalMs: number,
): Response {
  const translator = new ResponsesStreamTranslator(opts);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder(); // stream:true handles UTF-8 split across transport chunks
  const reader = providerRes.body?.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let alive = true;
      const ping = setInterval(() => {
        if (alive) controller.enqueue(encoder.encode('event: ping\ndata: {"type":"ping"}\n\n'));
      }, pingIntervalMs);
      const emit = (events: AnthropicStreamEvent[]): void => {
        for (const ev of events) {
          controller.enqueue(encoder.encode(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`));
        }
      };
      try {
        if (reader !== undefined) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            emit(translator.push(decoder.decode(value, { stream: true })));
            // A proxy-side limit ended the message: stop reading, or the
            // provider keeps generating tokens nobody will ever see.
            if (translator.limitReached) {
              void reader.cancel();
              break;
            }
          }
          if (!translator.limitReached) emit(translator.push(decoder.decode()));
        }
        emit(translator.finish());
      } catch (e) {
        emit(translator.abort(`WHAM stream failed: ${e instanceof Error ? e.message : String(e)}`));
      }
      alive = false;
      clearInterval(ping);
      controller.close();
    },
    cancel() {
      void reader?.cancel();
    },
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
