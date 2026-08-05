// Outbound connection tuning (ROADMAP "Ottimizzazioni misurate" #1).
//
// Node's default dispatcher drops an idle connection after 4 seconds. A coding
// session is bursty by nature: the user reads, thinks, then sends the next
// turn: so under the default almost every turn pays a fresh TLS handshake:
// one RTT for TCP plus one or two for TLS, which is 160-240 ms to a US host and
// 600-750 ms to an Asian one, on every single request. Holding the connection
// open for 30 seconds instead covers the gap between turns.
//
// Deliberately NOT enabling HTTP/2: it is opt-in experimental in undici and has
// an open hang on the second request reused over one connection, which is
// precisely a proxy's traffic pattern.

import { Agent, setGlobalDispatcher } from 'undici';

/** Long enough to survive a user's think time, short enough to free sockets. */
export const KEEP_ALIVE_MS = 30_000;

/**
 * How long a provider may take, both to answer and between stream chunks.
 * Lives here because it is transport policy: undici enforces it, so the number
 * and the dispatcher must not be able to drift apart (they did: see below).
 */
export const PROVIDER_TIMEOUT_MS = 600_000;

/**
 * undici defaults headersTimeout AND bodyTimeout to 300s
 * (`lib/dispatcher/client.js`: `headersTimeout != null ? headersTimeout : 300e3`).
 * Leaving them alone silently halved the 600s this proxy advertises, and the
 * failure mode was worse than the wait: a provider slower than 5 minutes died
 * with UND_ERR_HEADERS_TIMEOUT, which the ingress maps to a RETRYABLE 529, so
 * Claude Code retried and paid the whole cost again. Verified 2026-07-19
 * against a local model whose prompt processing alone runs past five minutes.
 */
export const DISPATCHER_OPTIONS = {
  keepAliveTimeout: KEEP_ALIVE_MS,
  keepAliveMaxTimeout: PROVIDER_TIMEOUT_MS,
  headersTimeout: PROVIDER_TIMEOUT_MS,
  bodyTimeout: PROVIDER_TIMEOUT_MS,
  // A coding session is one provider at a time; this is headroom, not a target.
  connections: 32,
} as const;

let installed = false;

/**
 * Installs the pooled dispatcher for every `fetch` in this process. Idempotent:
 * the daemon and the doctor's ephemeral server both call it.
 */
export function installKeepAlive(): void {
  if (installed) return;
  installed = true;
  setGlobalDispatcher(new Agent({ ...DISPATCHER_OPTIONS }));
}
