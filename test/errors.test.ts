import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { networkError, normalizeProviderError, parseRetryAfterMs, proxyError } from '../src/core/errors.js';

const capture = JSON.parse(
  readFileSync(new URL('./helpers/captures/lmstudio-context-overflow.json', import.meta.url), 'utf8'),
) as { nonStream: { httpStatus: number; body: string } };

describe('normalizeProviderError (SPEC-TRANSLATION §6)', () => {
  it('401 and 403 → 401 authentication_error', () => {
    expect(normalizeProviderError(401, 'nope').status).toBe(401);
    expect(normalizeProviderError(403, 'nope').body.error.type).toBe('authentication_error');
  });

  it('429 → rate_limit_error, keeps retry-after', () => {
    const e = normalizeProviderError(429, 'slow', '30');
    expect(e.status).toBe(429);
    expect(e.body.error.type).toBe('rate_limit_error');
    expect(e.retryAfter).toBe('30');
  });

  it('5xx → 529 overloaded_error', () => {
    expect(normalizeProviderError(500, 'x').status).toBe(529);
    expect(normalizeProviderError(502, 'x').body.error.type).toBe('overloaded_error');
  });

  it('other 4xx → 400 invalid_request_error', () => {
    expect(normalizeProviderError(400, 'x').status).toBe(400);
    expect(normalizeProviderError(404, 'x').body.error.type).toBe('invalid_request_error');
    expect(normalizeProviderError(422, 'x').status).toBe(400);
  });

  it('extracts message from OpenAI-style and Anthropic-style error bodies', () => {
    expect(normalizeProviderError(400, '{"error":{"message":"ctx too long"}}').body.error.message).toBe('ctx too long');
    expect(normalizeProviderError(400, '{"message":"bare"}').body.error.message).toBe('bare');
  });

  it('keeps raw text when the body is not JSON', () => {
    expect(normalizeProviderError(400, '<html>gateway</html>').body.error.message).toBe('<html>gateway</html>');
  });

  it('truncates the message at 2000 chars', () => {
    const long = 'x'.repeat(3000);
    expect(normalizeProviderError(400, long).body.error.message.length).toBe(2000);
  });
});

describe('credential scrubbing (ROADMAP backlog #4, da CCProxy)', () => {
  it('scrubs Bearer tokens and sk- keys from provider messages', () => {
    const raw = JSON.stringify({ error: { message: 'auth failed: Bearer sk-ant-abc123DEF456ghi789jkl rejected' } });
    const msg = normalizeProviderError(401, raw).body.error.message;
    expect(msg).not.toContain('sk-ant-abc123DEF456ghi789jkl');
    expect(msg).toContain('[redacted]');
  });

  it('scrubs JWTs, Google-style keys and emails', () => {
    const raw = 'token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123 for user mario.rossi@example.com key AIzaSyA1234567890abcdefghijklmnopqrstuvw';
    const msg = normalizeProviderError(400, raw).body.error.message;
    expect(msg).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(msg).not.toContain('mario.rossi@example.com');
    expect(msg).not.toContain('AIzaSyA1234567890abcdefghijklmnopqrstuvw');
  });

  it('scrubs key= query params in network error details', () => {
    const e = networkError('fetch failed: https://api.example.com/v1?key=supersecret123&x=1');
    expect(e.body.error.message).not.toContain('supersecret123');
    expect(e.body.error.message).toContain('key=[redacted]');
  });

  it('leaves normal provider messages untouched', () => {
    const raw = JSON.stringify({ error: { message: 'context length exceeded: 131072 tokens max' } });
    expect(normalizeProviderError(400, raw).body.error.message).toBe('context length exceeded: 131072 tokens max');
  });
});

// clientErrorsWrappedIn500 (SPEC-PROVIDERS §5). Observed live 2026-07-19: a
// context overflow, permanent by nature, reached the proxy as HTTP 500 and was
// mapped to a retryable 529 — Claude Code retried four times and then blamed
// "the API is at capacity", hiding the real cause from the user.
describe('local runtimes that wrap a client error in a 500', () => {
  const quirks = new Set(['clientErrorsWrappedIn500']);
  const raw = capture.nonStream.body;

  it('without the quirk, the real capture still maps to a retryable 529', () => {
    expect(normalizeProviderError(500, raw).status).toBe(529);
  });

  it('with the quirk, the nested 400 wins: permanent, so no retry', () => {
    const e = normalizeProviderError(500, raw, undefined, quirks);
    expect(e.status).toBe(400);
    expect(e.body.error.type).toBe('invalid_request_error');
  });

  it('the cause survives into the message the user can actually read', () => {
    const e = normalizeProviderError(500, raw, undefined, quirks);
    expect(e.body.error.message).toContain('exceeds the available context size');
    expect(e.body.error.message).toContain('8192');
  });

  it('a genuine provider 500 stays retryable even with the quirk on', () => {
    const e = normalizeProviderError(500, JSON.stringify({ error: { message: 'internal server error' } }), undefined, quirks);
    expect(e.status).toBe(529);
    expect(e.body.error.type).toBe('overloaded_error');
  });

  it('a nested 5xx is not a client error either', () => {
    const nested = JSON.stringify({ error: { message: 'Engine returned 503: {"error":{"code":503,"message":"busy"}}' } });
    expect(normalizeProviderError(500, nested, undefined, quirks).status).toBe(529);
  });

  // Audit 2026-07-22 §4 punto 3: flattening every nested 4xx to 400 destroyed
  // the type Claude Code keys its retry loop on — a wrapped 429 became
  // permanent and a wrapped 401 lost the credential signal.
  it('a nested 429 keeps its rate_limit type and the Retry-After hint', () => {
    const nested = JSON.stringify({ error: { message: 'Engine returned 429: {"error":{"code":429,"message":"slow down"}}' } });
    const e = normalizeProviderError(500, nested, '2', quirks);
    expect(e.status).toBe(429);
    expect(e.body.error.type).toBe('rate_limit_error');
    expect(e.retryAfter).toBe('2');
  });

  it('a nested 401 surfaces as authentication_error, not invalid_request', () => {
    const nested = JSON.stringify({ error: { message: 'Engine returned 401: {"error":{"code":401,"message":"bad key"}}' } });
    const e = normalizeProviderError(500, nested, undefined, quirks);
    expect(e.status).toBe(401);
    expect(e.body.error.type).toBe('authentication_error');
  });
});

describe('proxy-generated errors', () => {
  it('proxyError → 500 api_error with [lupin] prefix', () => {
    const e = proxyError('boom');
    expect(e.status).toBe(500);
    expect(e.body.error.type).toBe('api_error');
    expect(e.body.error.message).toBe('[lupin] boom');
  });

  it('networkError → 529 overloaded_error', () => {
    const e = networkError('ECONNREFUSED');
    expect(e.status).toBe(529);
    expect(e.body.error.type).toBe('overloaded_error');
    expect(e.body.error.message).toContain('ECONNREFUSED');
  });
});

// §4ter: the wait before the failover is only as trustworthy as this parser.
describe('parseRetryAfterMs (RFC 9110 §10.2.3)', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('  30 ')).toBe(30_000);
  });

  it('reads an HTTP-date against the given now', () => {
    const now = Date.parse('2026-07-24T12:00:00Z');
    expect(parseRetryAfterMs('Fri, 24 Jul 2026 12:00:03 GMT', now)).toBe(3000);
  });

  it('a date already elapsed is not a wait', () => {
    const now = Date.parse('2026-07-24T12:00:00Z');
    expect(parseRetryAfterMs('Fri, 24 Jul 2026 11:59:59 GMT', now)).toBeUndefined();
  });

  it('absent, empty, zero or unparseable: nothing to wait on', () => {
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('0')).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });
});
