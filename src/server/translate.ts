// Translate mode wiring (SPEC-TRANSLATION §0): Anthropic ingress body → core
// mappers → provider Chat Completions → Anthropic response/SSE back out.
// All translation logic lives in core/; this module only moves bytes.

import type { ProfileConfig } from '../config/config.js';
import type { ResolvedCredential } from './credential.js';
import { buildToolNameMap, mapAnthropicRequest, type AnthropicRequest } from '../core/request.js';
import { mapOpenAIResponse, type OpenAIResponse } from '../core/response.js';
import { OpenAIStreamTranslator, type AnthropicStreamEvent, type StreamOptions } from '../core/stream.js';
import { networkError, normalizeProviderError, proxyError, type NormalizedError } from '../core/errors.js';
import type { QuirkName } from '../core/quirks.js';

export interface TranslateArgs {
  /** Original Anthropic body from Claude Code (model not yet rewritten). */
  body: Record<string, unknown>;
  /** Real model name after slot resolution. */
  model: string;
  /** Model name Claude Code asked for (echoed back in responses, §4). */
  requestedModel: string;
  profile: ProfileConfig;
  baseUrl: string;
  credential: ResolvedCredential;
  /** Client attribution headers for this provider, if any (SPEC-PROVIDERS §5bis). */
  attribution?: Record<string, string>;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  /** Keep-alive ping cadence toward Claude Code during slow streams (§9.3). */
  pingIntervalMs?: number;
  /** Diagnostic sink: dialect normalizations that fired (§5bis rule 3). */
  onDialect?: (applied: QuirkName[]) => void;
}

export type TranslateResult = { status: number; response: Response } | { err: NormalizedError };

export async function translateForward(args: TranslateArgs): Promise<TranslateResult> {
  const anthropicReq = { ...args.body, model: args.model } as unknown as AnthropicRequest;
  const toolNames = buildToolNameMap(anthropicReq.tools ?? []);
  const providerBody = mapAnthropicRequest(anthropicReq, args.profile.quirks ?? []);

  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(args.credential.header, args.credential.value);
  for (const [k, v] of Object.entries(args.attribution ?? {})) headers.set(k, v);

  let providerRes: Response;
  try {
    providerRes = await args.fetchImpl(args.baseUrl + '/chat/completions', {
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

  const opts: StreamOptions = {
    requestedModel: args.requestedModel,
    toolNames,
    quirks: args.profile.quirks ?? [],
    hasTools: (anthropicReq.tools ?? []).length > 0,
    ...(args.onDialect !== undefined ? { onDialect: args.onDialect } : {}),
  };

  if (anthropicReq.stream === true) {
    return { status: 200, response: streamResponse(providerRes, opts, args.pingIntervalMs ?? 15_000) };
  }

  let parsed: OpenAIResponse;
  try {
    parsed = (await providerRes.json()) as OpenAIResponse;
  } catch {
    return { err: proxyError('provider returned a non-JSON response body') };
  }
  try {
    const mapped = mapOpenAIResponse(parsed, opts); // StreamOptions is a superset of MapResponseOptions
    return {
      status: 200,
      response: new Response(JSON.stringify(mapped), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    };
  } catch (e) {
    // includes ToolArgumentsParseError (§3: clear api_error, repair is M5)
    return { err: proxyError(e instanceof Error ? e.message : String(e)) };
  }
}

/** Provider SSE → Anthropic SSE, streamed through the core state machine. */
function streamResponse(providerRes: Response, opts: StreamOptions, pingIntervalMs: number): Response {
  const translator = new OpenAIStreamTranslator(opts);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder(); // stream:true handles UTF-8 split across transport chunks (§5 insidia d)
  const reader = providerRes.body?.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let alive = true;
      // §9.3: Claude Code must see traffic while a slow provider thinks
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
          }
          emit(translator.push(decoder.decode()));
        }
        emit(translator.finish()); // no-op if [DONE] already closed the message (§5)
      } catch (e) {
        emit(translator.abort(`provider stream failed: ${e instanceof Error ? e.message : String(e)}`));
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
