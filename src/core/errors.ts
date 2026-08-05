// Error mapping per SPEC-TRANSLATION §6: every error leaves the proxy in
// Anthropic format, provider message always propagated (truncated).

export interface AnthropicErrorBody {
  type: 'error';
  error: { type: string; message: string };
}

export interface NormalizedError {
  status: number;
  body: AnthropicErrorBody;
  retryAfter?: string;
}

const MAX_MESSAGE_LEN = 2000;

// Credential scrubbing (ROADMAP backlog #4): provider messages can echo the
// key/token that failed. High-precision patterns only: a legit message must
// never be mangled. Order matters: Bearer swallows the token that follows it.
const CREDENTIAL_PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/g, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]+){0,2}/g, '[redacted]'], // JWT
  [/sk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/AIza[0-9A-Za-z_-]{30,}/g, '[redacted]'], // Google API key
  [/([?&]key=)[^&\s]+/g, '$1[redacted]'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted]'], // email
];

function scrubCredentials(message: string): string {
  let out = message;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function errorBody(type: string, message: string): AnthropicErrorBody {
  return { type: 'error', error: { type, message: scrubCredentials(message) } };
}

function extractMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const err = parsed['error'];
    if (err !== null && typeof err === 'object') {
      const message = (err as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    if (typeof parsed['message'] === 'string') return parsed['message'];
  } catch {
    // not JSON: use the raw text
  }
  return rawBody;
}

/**
 * clientErrorsWrappedIn500: some local runtimes answer HTTP 500 while the
 * engine's real error, nested in the message, is a permanent 4xx. Verified
 * live on LM Studio 2026-07-19: a context overflow arrived as
 * `500 {"error":{"message":"Engine ... returned 400: {\"code\":400,
 * \"type\":\"exceed_context_size_error\"}"}}`. Mapped to 529 it made Claude
 * Code retry four times and then report "the API is at capacity", which is
 * both wrong and unactionable.
 *
 * Returns the nested status only when it is unmistakably a client error, so a
 * genuine provider 500 keeps its retryable mapping.
 */
function nestedClientErrorStatus(message: string): number | undefined {
  const stated = /returned\s+(4\d{2})\b/.exec(message);
  if (stated?.[1] !== undefined) return Number(stated[1]);
  const start = message.indexOf('{');
  if (start === -1) return undefined;
  try {
    const inner = JSON.parse(message.slice(start)) as Record<string, unknown>;
    const err = inner['error'];
    const code = err !== null && typeof err === 'object' ? (err as Record<string, unknown>)['code'] : inner['code'];
    if (typeof code === 'number' && code >= 400 && code < 500) return code;
  } catch {
    // not JSON after all: no nested status to trust
  }
  return undefined;
}

export function normalizeProviderError(
  status: number,
  rawBody: string,
  retryAfter?: string,
  quirks?: ReadonlySet<string>,
): NormalizedError {
  const message = extractMessage(rawBody).slice(0, MAX_MESSAGE_LEN);
  if (status === 401 || status === 403) {
    return { status: 401, body: errorBody('authentication_error', message) };
  }
  if (status === 429) {
    const out: NormalizedError = { status: 429, body: errorBody('rate_limit_error', message) };
    if (retryAfter !== undefined) out.retryAfter = retryAfter;
    return out;
  }
  if (status >= 500) {
    if (quirks?.has('clientErrorsWrappedIn500') === true) {
      const nested = nestedClientErrorStatus(message);
      if (nested !== undefined) {
        // Re-dispatch on the nested status so a wrapped 429/401 keeps the type
        // (and Retry-After) Claude Code keys its retry loop on: flattening to
        // 400 made a momentary rate limit look permanent. Nested is always 4xx,
        // so this cannot recurse further.
        return normalizeProviderError(nested, rawBody, retryAfter);
      }
    }
    return { status: 529, body: errorBody('overloaded_error', message) };
  }
  // remaining 4xx (400, 404, 422, …): invalid request, provider message preserved
  return { status: 400, body: errorBody('invalid_request_error', message) };
}

/**
 * Retry-After (RFC 9110 §10.2.3) as milliseconds: either delta-seconds or an
 * HTTP-date, measured against `now`. Returns undefined for anything absent,
 * unparseable or already elapsed: the caller must never wait on a guess.
 */
export function parseRetryAfterMs(value: string | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (raw === '') return undefined;
  if (/^\d+$/.test(raw)) {
    const ms = Number(raw) * 1000;
    return ms > 0 ? ms : undefined;
  }
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const ms = at - now;
  return ms > 0 ? ms : undefined;
}

/** Proxy bug or unimplemented path: [lupin] prefix distinguishes it from provider errors. */
export function proxyError(message: string): NormalizedError {
  return { status: 500, body: errorBody('api_error', `[lupin] ${message}`) };
}

/** Provider unreachable / timeout: 529 so Claude Code retries automatically. */
export function networkError(detail: string): NormalizedError {
  return { status: 529, body: errorBody('overloaded_error', `provider unreachable: ${detail}`.slice(0, MAX_MESSAGE_LEN)) };
}
