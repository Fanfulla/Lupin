// M6b codeassist-mode wiring (DESIGN-TRANSLATORS-DEDICATED §2.2bis): Anthropic
// ingress body -> core/codeassist mappers -> Google Code Assist -> Anthropic
// response/SSE back out. Sibling of translate.ts and responses-forward.ts; all
// translation logic lives in core/, this module only moves bytes.
//
// Two things this lane needs that no other one does:
//
//   1. A PROJECT ID. Code Assist refuses to generate without the account's
//      cloudaicompanionProject, which only `:loadCodeAssist` knows. That is one
//      extra round trip, on a tier that rate-limits readily, so it is resolved
//      once per token and cached.
//   2. A SESSION ID. Google threads a conversation by it; one per proxy process
//      is the honest equivalent of one CLI session.
//
// Like the responses lane, a non-streaming caller is served by consuming the
// stream and recomposing the Message from the SAME translator. Code Assist does
// expose a non-streaming `:generateContent`, but using it would mean a second
// parser for the same grammar, which is exactly what ADR-22 warns against.

import { randomUUID } from 'node:crypto';
import type { ProfileConfig } from '../config/config.js';
import type { ResolvedCredential } from './credential.js';
import { buildToolNameMap, type AnthropicRequest } from '../core/request.js';
import { mapAnthropicToCodeAssist } from '../core/codeassist/request.js';
import { CodeAssistStreamTranslator } from '../core/codeassist/stream.js';
import type { AnthropicStreamEvent } from '../core/stream.js';
import { networkError, normalizeProviderError, type NormalizedError } from '../core/errors.js';
import { recomposeMessage } from './responses-forward.js';
import { noteFreeTier } from '../providers/tiers.js';

/** One proxy process is one Code Assist session, as one CLI run would be. */
const SESSION_ID = randomUUID();

/**
 * What `:loadCodeAssist` told us about this account, per access token. Keyed by
 * the credential value so a re-login (or a different account) never reuses the
 * previous answer.
 */
interface Account {
  project: string;
  /** `free-tier`, `standard-tier`, ... straight from the provider. */
  tierId: string;
}
const accountCache = new Map<string, Account>();

/**
 * The one slot a FREE tier account can actually serve: that tier answers 429
 * RESOURCE_EXHAUSTED on every pro model (verified live 2026-07-29). `sonnet` is
 * deliberately the one, because it is where Claude Code's own /model default
 * sits, so the profile behaves normally for the work that matters.
 */
const FREE_TIER_SLOT = 'sonnet';

export interface CodeAssistForwardArgs {
  body: Record<string, unknown>;
  model: string;
  requestedModel: string;
  profile: ProfileConfig;
  baseUrl: string;
  credential: ResolvedCredential;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  pingIntervalMs?: number;
  /** The slot this request resolved to ('opus' | 'sonnet' | 'haiku' | 'direct' | 'agent'). */
  slot?: string;
  /** Profile name, so a discovered free tier can be reported to every surface. */
  profileName?: string;
  /** Called when the account tier cannot serve `slot` and another model answered instead. */
  onTierDowngrade?: (slot: string, servedModel: string) => void;
}

export type CodeAssistForwardResult = { status: number; response: Response } | { err: NormalizedError };

/** Only for tests: forget what the provider said about the account. */
export function resetCodeAssistProjectCache(): void {
  accountCache.clear();
}

/**
 * The account's project id, from `:loadCodeAssist`. An account that has never
 * been onboarded answers without one; that is a real, actionable state (the
 * user must complete onboarding), not a transport failure, so it is reported
 * as such instead of being retried forever.
 */
async function resolveAccount(args: CodeAssistForwardArgs): Promise<Account | { err: NormalizedError }> {
  const cached = accountCache.get(args.credential.value);
  if (cached !== undefined) return cached;

  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(args.credential.header, args.credential.value);

  let res: Response;
  try {
    res = await args.fetchImpl(`${args.baseUrl}:loadCodeAssist`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' },
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (e) {
    return { err: networkError(e instanceof Error ? e.message : String(e)) };
  }

  if (!res.ok) {
    const raw = await res.text();
    return { err: normalizeProviderError(res.status, raw, undefined, new Set(args.profile.quirks ?? [])) };
  }

  const loaded = (await res.json()) as {
    cloudaicompanionProject?: string | null;
    currentTier?: { id?: string } | null;
  };
  const project = loaded.cloudaicompanionProject;
  if (typeof project !== 'string' || project === '') {
    return {
      err: {
        status: 400,
        body: {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message:
              '[lupin] this Google account has no Code Assist project yet: it has never been onboarded. ' +
              'Sign in once with the official Gemini CLI to complete onboarding, then retry.',
          },
        },
      },
    };
  }

  const account: Account = { project, tierId: loaded.currentTier?.id ?? '' };
  accountCache.set(args.credential.value, account);
  return account;
}

export async function codeassistForward(args: CodeAssistForwardArgs): Promise<CodeAssistForwardResult> {
  const resolved = await resolveAccount(args);
  if ('err' in resolved) return resolved;

  // A free tier account serves exactly one slot: every pro model answers 429
  // there. Refusing the others outright was tried and measured, and it does not
  // degrade the experience but ends it: Claude Code opens a session on the OPUS
  // slot, so the very first request died and `lupin doctor` never reached the
  // model (2026-07-29). They are served by the tier's own model instead, and
  // the substitution is logged rather than hidden: silently answering as if
  // opus had run would be the one thing worse than either.
  let model = args.model;
  if (resolved.tierId === 'free-tier') {
    // Tell every surface that names a model: the picker, /health, the statusline.
    if (args.profileName !== undefined) noteFreeTier(args.profileName, FREE_TIER_SLOT);
  }
  if (resolved.tierId === 'free-tier' && args.slot !== undefined && args.slot !== FREE_TIER_SLOT) {
    const served = args.profile.slots[FREE_TIER_SLOT];
    if (typeof served === 'string' && served !== model) {
      model = served;
      args.onTierDowngrade?.(args.slot, served);
    }
  }

  const anthropicReq = { ...args.body, model } as unknown as AnthropicRequest;
  const toolNames = buildToolNameMap(anthropicReq.tools ?? []);
  const providerBody = mapAnthropicToCodeAssist(anthropicReq, {
    model,
    project: resolved.project,
    userPromptId: randomUUID(),
    sessionId: SESSION_ID,
  });

  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  headers.set(args.credential.header, args.credential.value);

  let providerRes: Response;
  try {
    providerRes = await args.fetchImpl(`${args.baseUrl}:streamGenerateContent?alt=sse`, {
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

  const opts = { requestedModel: args.requestedModel, toolNames };

  if (anthropicReq.stream === true) {
    return { status: 200, response: streamResponse(providerRes, opts, args.pingIntervalMs ?? 15_000) };
  }

  const translator = new CodeAssistStreamTranslator(opts);
  const events: AnthropicStreamEvent[] = [];
  try {
    const text = await providerRes.text();
    events.push(...translator.push(text), ...translator.finish());
  } catch (e) {
    return { err: networkError(`Code Assist stream failed: ${e instanceof Error ? e.message : String(e)}`) };
  }
  return {
    status: 200,
    response: new Response(JSON.stringify(recomposeMessage(events)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  };
}

/** Code Assist SSE -> Anthropic SSE, streamed through the core state machine. */
function streamResponse(
  providerRes: Response,
  opts: { requestedModel: string; toolNames: ReadonlyMap<string, string> },
  pingIntervalMs: number,
): Response {
  const translator = new CodeAssistStreamTranslator(opts);
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
          }
          emit(translator.push(decoder.decode()));
        }
        emit(translator.finish());
      } catch (e) {
        emit(translator.abort(`Code Assist stream failed: ${e instanceof Error ? e.message : String(e)}`));
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
