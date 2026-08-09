import { Hono } from 'hono';
import type { Context } from 'hono';
import { loadConfig, saveConfig, type LupinConfig } from '../config/config.js';
import { PROVIDERS } from '../providers/registry.js';
import { quotaExhausted } from '../providers/quota.js';
import { agentRouteName, applyContentRoutes, gatewayModelId, profileSwitchId, profileSwitchTarget, resolveRequest } from '../providers/resolve.js';
import { isFreeTier, labelModel, upgradeUrl } from '../providers/tiers.js';
import {
  networkError,
  normalizeProviderError,
  parseRetryAfterMs,
  proxyError,
  type AnthropicErrorBody,
  type NormalizedError,
} from '../core/errors.js';
import { estimateInputTokens } from '../core/tokens.js';
import { lastEditFailed, withEditRetryHint, withIdentityHint } from '../core/quirks.js';
import { observeCacheUsage } from './cache-watch.js';
import type { AnthropicRequest } from '../core/request.js';
import type { OAuthProviderDef } from '../providers/oauth.js';
import { resolveCredential, type ResolvedCredential } from './credential.js';
import { PROVIDER_TIMEOUT_MS } from './dispatcher.js';
import { createHealthTracker, type HealthTracker } from './health.js';
import { registerControlRoutes, type ControlDeps } from './control.js';
import { consoleLogger, type Logger, type RequestLogLine, type UsageLine } from './log.js';
import { translateForward } from './translate.js';
import { responsesForward } from './responses-forward.js';
import { codeassistForward } from './codeassist-forward.js';

// Agentic tasks are long (SPEC-TRANSLATION §9). Defined with the dispatcher
// that enforces it: undici's own 300s defaults would otherwise cap it silently.
const FORWARDED_REQUEST_HEADERS = ['anthropic-version', 'anthropic-beta'] as const;
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'request-id', 'anthropic-request-id'] as const;

export interface AppOptions {
  logger?: Logger;
  fetchImpl?: typeof fetch;
  /** Test hook: keep-alive ping cadence for translate streams (default 15s). */
  pingIntervalMs?: number;
  /** Test hook: overrides the OAuth descriptor registry. */
  oauthDefs?: Record<string, OAuthProviderDef>;
  /** Failover cooldown (§4sexies). Shared across requests; tests inject a fresh one. */
  health?: HealthTracker;
  /** Test hook: the wait itself (§4ter Retry-After retry). Default: real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Control API (TUI/CLI). Absent in tests that do not exercise it. */
  control?: ControlDeps;
  /**
   * Persists the quota-aware durable switch (§4octies). Default: the same
   * config write `lupin use` performs. Tests inject a spy; the guard on
   * `from` makes a stale write impossible when the user switched meanwhile.
   */
  persistActiveProfile?: (from: string, to: string) => void;
}

/**
 * Longest Retry-After Lupin honours in-process (SPEC-PROVIDERS §4ter). A short
 * hint is worth waiting for: the provider is telling us exactly when it will
 * answer, and waiting costs less than burning the failover hop on a flake. A
 * long one is not: the request would hang with nothing to show, while the
 * failover (or Claude Code's own retry on the surfaced 429) answers sooner.
 */
const RETRY_AFTER_MAX_MS = 5000;

export function createApp(config: LupinConfig, opts: AppOptions = {}): Hono {
  const log = opts.logger ?? consoleLogger;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const health = opts.health ?? createHealthTracker();
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const persistActiveProfile =
    opts.persistActiveProfile ??
    ((from: string, to: string): void => {
      // The same write path as `lupin use` (control.ts): a fresh load so a
      // concurrent edit is never clobbered, and only if the user has not
      // already moved on.
      try {
        const fresh = loadConfig();
        if (fresh.activeProfile !== from) return;
        fresh.activeProfile = to;
        saveConfig(fresh);
      } catch {
        // the in-memory switch still holds for this daemon's lifetime
      }
    });
  // The last profile-switch row acted on (§4.3): the client re-sends the picked
  // id on every turn, and only a CHANGE is a new gesture. Per daemon, in memory
  // on purpose: a restart re-reads the config, which already holds the truth.
  let lastSwitchTarget: string | undefined = undefined;
  const app = new Hono();

  // activeProfile + resolved slot models: lets a statusline show the real
  // routing truth without asking the model (SPEC-PROVIDERS §4, ROADMAP backlog 10)
  app.get('/health', (c) => {
    const slots: Partial<Record<'opus' | 'sonnet' | 'haiku', string>> = {};
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      try {
        slots[slot] = resolveRequest(config, slot).model;
      } catch {
        // a broken delegation is reported by the slot's absence, never a 500
      }
    }
    // §4sexies: per-profile failover health, for `lupin list` and the statusline.
    const healthStatus: Record<string, string> = {};
    for (const name of Object.keys(config.profiles)) {
      const rem = health.cooldownRemainingSec(name);
      healthStatus[name] = rem > 0 ? `cooldown ${String(rem)}s` : 'healthy';
    }
    // A free tier is part of the routing truth: a statusline that shows the
    // model without it would show half of it.
    const activeModel = slots.sonnet ?? slots.opus ?? '';
    const activeProvider = config.profiles[config.activeProfile]?.provider ?? '';
    const free = isFreeTier(config.activeProfile, activeModel)
      ? { free: true, ...(upgradeUrl(activeProvider) !== undefined ? { upgrade: upgradeUrl(activeProvider) } : {}) }
      : undefined;
    return c.json({
      ok: true,
      activeProfile: config.activeProfile,
      slots,
      health: healthStatus,
      ...(free !== undefined ? { tier: free } : {}),
    });
  });
  // Model picker (SPEC-PROVIDERS §4.2): the resolved slot models, Anthropic
  // list format. Selecting one in Claude Code enters the direct-use path, so
  // mid-session model switching works without touching the config. The ids
  // carry the gateway prefix because the client drops every id that does not
  // start with claude/anthropic; the real name is the display_name.
  app.get('/v1/models', (c) => {
    if (!isLocalTokenValid(c, config.localToken)) {
      return errorResponse(authError('[lupin] invalid or missing local token (check ANTHROPIC_AUTH_TOKEN)'));
    }
    const seen = new Set<string>();
    const data: { type: 'model'; id: string; display_name: string }[] = [];
    for (const slot of ['opus', 'sonnet', 'haiku'] as const) {
      try {
        const model = resolveRequest(config, slot).model;
        if (!seen.has(model)) {
          seen.add(model);
          // The display name is what the user reads in the picker, so it is
          // where "this one is free, and here is how to leave the free tier"
          // belongs.
          const provider = resolveRequest(config, slot).profile.provider;
          data.push({ type: 'model', id: gatewayModelId(model), display_name: labelModel(config.activeProfile, provider, model) });
        }
      } catch {
        // broken delegation → model absent from the list, never an error
      }
    }
    // One inert switch row per profile (§4.3, ADR-37), AFTER the models: the
    // picker is a model picker first. The active profile is listed too, because
    // the client fetches this list once per session and caches it: leaving it
    // out would make the switch a one-way trip for the whole session.
    for (const name of Object.keys(config.profiles)) {
      data.push({ type: 'model', id: profileSwitchId(name), display_name: `switch Lupin profile: ${name}` });
    }
    return c.json({ data, has_more: false });
  });
  app.post('/v1/messages', (c) => forward(c, '/v1/messages'));
  app.post('/v1/messages/count_tokens', (c) => forward(c, '/v1/messages/count_tokens'));

  // Control API (TUI hub + simplified CLI): state, profile switch, OAuth jobs.
  if (opts.control !== undefined) registerControlRoutes(app, config.localToken, opts.control);

  async function forward(c: Context, path: string): Promise<Response> {
    const started = Date.now();
    let profileName = '-';
    let requestedModel = '-';
    let model = '-';
    let mode = '-';

    let failedOver: string | undefined = undefined;
    let routed: string | undefined = undefined;
    let retryAfterMs: number | undefined = undefined;
    let cooldownSkip: string | undefined = undefined;
    // §5bis rule 3: a normalization that fires silently is indistinguishable
    // from a provider that never needed one. The log has to say which it was.
    let dialect: string[] | undefined = undefined;
    // §5quater rule: same argument as `dialect`, on the request side. A hint
    // that fires invisibly cannot be told from a model that never needed one,
    // and the A/B that has to justify the quirk would measure nothing.
    let editHint: true | undefined = undefined;
    // The account tier could not serve the requested slot: another model
    // answered, and the log has to say so.
    let tierDowngrade: string | undefined = undefined;
    // §4octies: the durable switch a quota-exhausted answer triggered.
    let quotaSwitch: string | undefined = undefined;
    // §4.3: the switch the user asked for from the model picker.
    let profileSwitch: string | undefined = undefined;
    // §4decies: the agent route the id named. "unknown:<name>" when the table
    // has no such route and the request was served on the normal path.
    let agentRoute: string | undefined = undefined;
    // Provider diagnostics on a failed request (§4octies): already scrubbed
    // and capped by the normalizer, truncated further for the log.
    let errorMessage: string | undefined = undefined;

    let logged = false;
    let lastStatus = 0;
    const done = (status: number): void => {
      logged = true;
      lastStatus = status;
      log({
        ts: new Date().toISOString(),
        profile: profileName,
        requestedModel,
        model,
        mode,
        path,
        status,
        latencyMs: Date.now() - started,
        ...(failedOver !== undefined ? { failedOver } : {}),
        ...(routed !== undefined ? { routed } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(cooldownSkip !== undefined ? { cooldown: cooldownSkip } : {}),
        ...(dialect !== undefined ? { dialect } : {}),
        ...(editHint !== undefined ? { editHint } : {}),
        ...(tierDowngrade !== undefined ? { tierDowngrade } : {}),
        ...(quotaSwitch !== undefined ? { quotaSwitch } : {}),
        ...(profileSwitch !== undefined ? { profileSwitch } : {}),
        ...(agentRoute !== undefined ? { agentRoute } : {}),
        ...(errorMessage !== undefined ? { errorMessage } : {}),
      });
    };

    // Whatever the body reveals arrives on a second line: with a stream both
    // the token counts and a mid-stream error only exist long after the
    // request line was written.
    const logExtra = (extra: Partial<RequestLogLine>): void => {
      log({
        ts: new Date().toISOString(),
        profile: profileName,
        requestedModel,
        model,
        mode,
        path,
        status: lastStatus,
        latencyMs: Date.now() - started,
        ...extra,
      });
    };

    /** Attaches the tap the transport needs, leaving the bytes untouched.
     *  Health verdicts ride on it too: a stream is a success only when it ENDS
     *  clean: recording at header time let a 200-then-dies provider reset its
     *  own failure counter on every request and never reach cooldown. */
    const tapBody = (res: Response, prof: string): Response => {
      const isSse = (res.headers.get('content-type') ?? '').includes('text/event-stream');
      if (!isSse) health.recordSuccess(prof); // complete body at header time: a 200 is a success
      if (res.body === null) return res;
      const body = isSse
        ? res.body.pipeThrough(
            watchSse(
              (streamError) => {
                logExtra({ streamError });
                // Same taxonomy as isRetryable: only what §4ter would fail over
                // on counts toward the §4sexies cooldown.
                if (streamError === 'overloaded_error' || streamError === 'rate_limit_error') {
                  health.recordFailure(prof);
                }
              },
              (usage) => logExtra({ usage, ...(observeCacheUsage(profileName, usage) === true ? { cacheBust: true } : {}) }),
              (sawError, sawTerminal) => {
                if (sawError) return;
                // §9.1: a stream that just stops, with no message_stop and no
                // stop_reason, is a truncated answer wearing a 200. It must not
                // credit the provider with the success that clears its cooldown.
                if (!sawTerminal) {
                  logExtra({ streamError: 'truncated' });
                  return;
                }
                health.recordSuccess(prof);
              },
            ),
          )
        : res.body.pipeThrough(
            watchJson((usage) =>
              logExtra({ usage, ...(observeCacheUsage(profileName, usage) === true ? { cacheBust: true } : {}) }),
            ),
          );
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const fail = (err: NormalizedError): Response => {
      errorMessage = err.body.error.message.slice(0, 200);
      done(err.status);
      return errorResponse(err);
    };

    if (!isLocalTokenValid(c, config.localToken)) {
      return fail(authError('[lupin] invalid or missing local token (check ANTHROPIC_AUTH_TOKEN)'));
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return fail({ status: 400, body: errBody('invalid_request_error', '[lupin] request body is not valid JSON') });
    }
    requestedModel = typeof body['model'] === 'string' ? body['model'] : '-';

    // §4.3 (ADR-37): the picked row of the model picker whose meaning is
    // `lupin use <profile>`. The id keeps travelling on every later turn of the
    // session, so it is read as a GESTURE (acted on when the target changes),
    // never as a pin: otherwise the next request would undo a `lupin use` made
    // meanwhile from the CLI or the TUI, and the config would stop being the
    // single source of truth. Whatever happens, the request is then served like
    // the client's default model, which lands on the opus slot (§4 rule 1).
    let resolveModelId = requestedModel;
    const switchTarget = profileSwitchTarget(requestedModel);
    if (switchTarget !== undefined) {
      if (config.profiles[switchTarget] === undefined) {
        // A pick outlives the profile it names: Claude Code saves it in the
        // user's global settings, so it can arrive from another config or after
        // the profile was renamed. Serving the session beats breaking it.
        profileSwitch = `unknown:${switchTarget}`;
      } else if (lastSwitchTarget !== switchTarget && config.activeProfile !== switchTarget) {
        const from = config.activeProfile;
        config.activeProfile = switchTarget; // this daemon, effective immediately
        persistActiveProfile(from, switchTarget); // the config file, hot-reload included
        profileSwitch = switchTarget;
        lastSwitchTarget = switchTarget;
      } else {
        lastSwitchTarget = switchTarget;
      }
      resolveModelId = 'opus';
    }

    // §4decies (ADR-47): the log must say when an agent route served the
    // request, and when the id named a route the table does not have (served on
    // the normal path instead). Resolution itself happens in resolveRequest.
    const agentName = agentRouteName(requestedModel);
    if (agentName !== undefined) {
      agentRoute = config.agents?.[agentName] !== undefined ? agentName : `unknown:${agentName}`;
    }

    const credentialOpts = {
      fetchImpl,
      ...(opts.oauthDefs !== undefined ? { oauthDefs: opts.oauthDefs } : {}),
    };

    // Retryable = the failover triggers (SPEC-PROVIDERS §4ter): normalized
    // rate limit (429) or provider overload/network (529). NOT 500 (proxy
    // bug), NOT 4xx/401 (an identical request would fail identically).
    const isRetryable = (err: NormalizedError): boolean => err.status === 429 || err.status === 529;

    // Resolve + dispatch for one starting profile. Retryable failures are
    // RETURNED (not sent) so the caller can try the failover profile once;
    // everything else is already a final Response.
    const attempt = async (startName?: string): Promise<Response | { retryable: NormalizedError }> => {
      let resolved;
      try {
        resolved =
          startName === undefined
            ? resolveRequest(config, resolveModelId)
            : resolveRequest(config, resolveModelId, startName);
        // content-aware routing (§4quater): the start profile's routes may
        // override the slot target; direct-use is never rerouted
        const routing = applyContentRoutes(config, startName ?? config.activeProfile, resolveModelId, resolved, body);
        resolved = routing.resolved;
        routed = routing.routed;
      } catch (e) {
        return fail(proxyError(e instanceof Error ? e.message : String(e)));
      }
      profileName = resolved.profileName;
      model = resolved.model;
      const profile = resolved.profile;
      mode = profile.mode;

      // identityHint (§5ter, ADR-39): opt-in, so the body is edited ONLY when
      // the profile asked for it. Appended last, which is what keeps the
      // provider's cached prefix intact. Both lanes read `outgoing`, so there
      // is one implementation and no lane can forget it.
      //
      // A COPY, never a reassignment of `body`: this function runs again on the
      // failover profile, and mutating the shared body would append a second
      // hint there, naming a different model than the first one.
      //
      // editRetryHint (§5quater, ADR-45) rides the same seam, and goes LAST:
      // the identity block is constant for the session while this one comes and
      // goes with the failures, so appending it after keeps every earlier block
      // at the same index and the cached prefix boundary where it was.
      let system = body['system'];
      if (path !== '/v1/messages/count_tokens') {
        if (profile.quirks?.includes('identityHint') === true) {
          system = withIdentityHint(system, model, profile.provider);
        }
        if (profile.quirks?.includes('editRetryHint') === true && lastEditFailed(body['messages'])) {
          system = withEditRetryHint(system);
          editHint = true;
        }
      }
      const outgoing = system === body['system'] ? body : { ...body, system };

      const def = PROVIDERS[profile.provider];

      let credential: ResolvedCredential;
      try {
        credential = await resolveCredential(profile, credentialOpts);
      } catch (e) {
        return fail(authError(`[lupin] ${e instanceof Error ? e.message : String(e)}`));
      }

      // The credential may name its own host (§3quater: a token bought at
      // exchange time says where it is spent). The user's explicit override
      // still wins; the registry default is the last word.
      const baseUrl =
        profile.baseUrl ??
        credential.baseUrl ??
        (profile.mode === 'translate' ? (def?.translateBaseUrl ?? def?.baseUrl) : def?.baseUrl);
      if (baseUrl === undefined) {
        return fail(proxyError(`profile "${profileName}": unknown provider "${profile.provider}" and no baseUrl override`));
      }

      // M6a lane: the OpenAI Responses API over WHAM (OAuth subscription).
      // Kept before translate because it shares nothing with Chat Completions
      // but the shape of this branch.
      if (profile.mode === 'responses') {
        if (path === '/v1/messages/count_tokens') {
          // WHAM exposes no count_tokens: same local estimate as translate (§7b).
          done(200);
          return jsonResponse({ input_tokens: estimateInputTokens(body as unknown as AnthropicRequest) });
        }
        const responsesArgs = {
          body: outgoing,
          model,
          requestedModel,
          profile,
          baseUrl,
          fetchImpl,
          timeoutMs: PROVIDER_TIMEOUT_MS,
          ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
        };
        let result = await responsesForward({ ...responsesArgs, credential });
        // reactive 401 on OAuth (DESIGN-OAUTH §4.3): one refresh + one retry, never a loop
        if ('err' in result && result.err.status === 401 && profile.auth.type === 'oauth') {
          try {
            credential = await resolveCredential(profile, { ...credentialOpts, forceOAuthRefresh: true });
          } catch (e) {
            return fail(authError(`[lupin] ${e instanceof Error ? e.message : String(e)}`));
          }
          result = await responsesForward({ ...responsesArgs, credential });
        }
        if ('err' in result) {
          if (isRetryable(result.err)) {
            health.recordFailure(profileName);
            return { retryable: result.err };
          }
          return fail(result.err);
        }
        done(result.status);
        return tapBody(result.response, profileName);
      }

      // M6b lane: Google Code Assist (OAuth subscription). Same shape as the
      // responses branch above, a different protocol underneath.
      if (profile.mode === 'codeassist') {
        if (path === '/v1/messages/count_tokens') {
          // Code Assist does expose :countTokens, but reaching it costs a round
          // trip on a tier that rate-limits: the local estimate (§7b) is the
          // same answer translate already gives, for free.
          done(200);
          return jsonResponse({ input_tokens: estimateInputTokens(body as unknown as AnthropicRequest) });
        }
        const codeassistArgs = {
          body: outgoing,
          model,
          requestedModel,
          profile,
          baseUrl,
          fetchImpl,
          // A free tier account cannot serve every slot, so the lane needs to
          // know which one this request resolved to, and says when it had to
          // answer with another model.
          slot: resolved.slot,
          profileName,
          onTierDowngrade: (slot: string, servedModel: string): void => {
            tierDowngrade = slot;
            model = servedModel; // the log must name the model that really ran
          },
          timeoutMs: PROVIDER_TIMEOUT_MS,
          ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
        };
        let result = await codeassistForward({ ...codeassistArgs, credential });
        // reactive 401 on OAuth (DESIGN-OAUTH §4.3): one refresh + one retry, never a loop
        if ('err' in result && result.err.status === 401 && profile.auth.type === 'oauth') {
          try {
            credential = await resolveCredential(profile, { ...credentialOpts, forceOAuthRefresh: true });
          } catch (e) {
            return fail(authError(`[lupin] ${e instanceof Error ? e.message : String(e)}`));
          }
          result = await codeassistForward({ ...codeassistArgs, credential });
        }
        if ('err' in result) {
          if (isRetryable(result.err)) {
            health.recordFailure(profileName);
            return { retryable: result.err };
          }
          return fail(result.err);
        }
        done(result.status);
        return tapBody(result.response, profileName);
      }

      if (profile.mode === 'translate') {
        if (path === '/v1/messages/count_tokens') {
          // §7 strategy (b): Chat Completions has no equivalent endpoint → local estimate
          done(200);
          return jsonResponse({ input_tokens: estimateInputTokens(body as unknown as AnthropicRequest) });
        }
        const translateArgs = {
          body: outgoing,
          model,
          requestedModel,
          profile,
          baseUrl,
          fetchImpl,
          timeoutMs: PROVIDER_TIMEOUT_MS,
          // Required headers first, attribution over them: a provider that
          // demands a header must never lose it to a cosmetic one.
          ...(def?.attribution !== undefined || def?.requiredHeaders !== undefined
            ? { attribution: { ...def.requiredHeaders, ...def.attribution } }
            : {}),
          onDialect: (applied: string[]): void => {
            dialect = applied;
            // Streaming closes long after the request line was logged: rather
            // than double every stream, emit an extra line only when a
            // normalization actually fired.
            if (logged) {
              log({
                ts: new Date().toISOString(),
                profile: profileName,
                requestedModel,
                model,
                mode,
                path,
                status: 200,
                latencyMs: Date.now() - started,
                dialect: applied,
              });
            }
          },
          ...(opts.pingIntervalMs !== undefined ? { pingIntervalMs: opts.pingIntervalMs } : {}),
        };
        let result = await translateForward({ ...translateArgs, credential });
        // reactive 401 on OAuth (DESIGN-OAUTH §4.3): one refresh + one retry, never a loop
        if ('err' in result && result.err.status === 401 && profile.auth.type === 'oauth') {
          try {
            credential = await resolveCredential(profile, { ...credentialOpts, forceOAuthRefresh: true });
          } catch (e) {
            return fail(authError(`[lupin] ${e instanceof Error ? e.message : String(e)}`));
          }
          result = await translateForward({ ...translateArgs, credential });
        }
        if ('err' in result) {
          if (isRetryable(result.err)) {
            health.recordFailure(profileName);
            return { retryable: result.err };
          }
          return fail(result.err);
        }
        done(result.status);
        return tapBody(result.response, profileName);
      }

      const headers = new Headers({ 'content-type': 'application/json' });
      for (const h of FORWARDED_REQUEST_HEADERS) {
        const v = c.req.header(h);
        if (v !== undefined) headers.set(h, v);
      }
      if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
      for (const [k, v] of Object.entries({ ...def?.requiredHeaders, ...def?.attribution })) headers.set(k, v);

      let providerRes: Response;
      for (let oauthAttempt = 0; ; oauthAttempt++) {
        headers.set(credential.header, credential.value);
        try {
          providerRes = await fetchImpl(baseUrl + path, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...outgoing, model }),
            signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
          });
        } catch (e) {
          health.recordFailure(profileName);
          return { retryable: networkError(e instanceof Error ? e.message : String(e)) };
        }
        // reactive 401 on OAuth: one refresh + one retry, never a loop (DESIGN-OAUTH §4.3)
        if (providerRes.status === 401 && profile.auth.type === 'oauth' && oauthAttempt === 0) {
          try {
            credential = await resolveCredential(profile, { ...credentialOpts, forceOAuthRefresh: true });
            continue;
          } catch (e) {
            return fail(authError(`[lupin] ${e instanceof Error ? e.message : String(e)}`));
          }
        }
        break;
      }

      if (!providerRes.ok) {
        if (path === '/v1/messages/count_tokens' && (providerRes.status === 404 || providerRes.status === 405)) {
          // §8: provider without count_tokens → local estimate instead of surfacing the 404
          done(200);
          return jsonResponse({ input_tokens: estimateInputTokens(body as unknown as AnthropicRequest) });
        }
        const raw = await providerRes.text();
        const retryAfter = providerRes.headers.get('retry-after');
        const err = normalizeProviderError(providerRes.status, raw, retryAfter ?? undefined, new Set(profile.quirks ?? []));
        if (isRetryable(err)) {
          health.recordFailure(profileName);
          return { retryable: err };
        }
        return fail(err);
      }

      // Success: pipe the provider body byte-per-byte (SSE included), zero parsing.
      // Health verdict deferred to tapBody: for a stream it is earned at clean
      // end, not at the 200 header (audit 2026-07-22, midstream gap).
      done(providerRes.status);
      const outHeaders = new Headers();
      for (const h of FORWARDED_RESPONSE_HEADERS) {
        const v = providerRes.headers.get(h);
        if (v !== null) outHeaders.set(h, v);
      }
      // A 200 whose stream carries only `event: error` is a failure the log
      // would otherwise record as success, and the token counts live in the
      // body too. The tap forwards every chunk untouched (ADR-7) and only
      // reports what it saw.
      return tapBody(new Response(providerRes.body, { status: providerRes.status, headers: outHeaders }), profileName);
    };

    // §4sexies: a primary in cooldown is skipped outright, so the request goes
    // straight to the failover instead of re-probing the dead profile first.
    // The cooldown key is the profile the request RESOLVES to (delegation and
    // routes included): failures are recorded under the resolved name, so
    // checking only activeProfile left the skip blind in delegated setups.
    const activeFailover = config.profiles[config.activeProfile]?.failover;
    if (activeFailover !== undefined) {
      let targetName = config.activeProfile;
      try {
        const pre = resolveRequest(config, requestedModel);
        targetName = applyContentRoutes(config, config.activeProfile, requestedModel, pre, body).resolved.profileName;
      } catch {
        // resolution errors are attempt()'s job to surface, not the skip's
      }
      if (health.inCooldown(targetName)) {
        cooldownSkip = targetName;
        failedOver = config.activeProfile;
        const skipped = await attempt(activeFailover);
        if (skipped instanceof Response) return skipped;
        return fail(skipped.retryable);
      }
    }

    let first = await attempt();
    if (first instanceof Response) return first;

    // Retry-After honoured in-process (SPEC-PROVIDERS §4ter, audit gap
    // retry-policy-single-hop): a 429 that says "come back in 2s" was spending
    // the failover hop on a flake that had already told us when it would pass.
    // One extra attempt on the SAME profile, only when the provider gave a
    // usable hint within the cap. No hint, or a long one: nothing changes.
    const waitMs = parseRetryAfterMs(first.retryable.retryAfter);
    if (waitMs !== undefined && waitMs <= RETRY_AFTER_MAX_MS) {
      await sleep(waitMs);
      retryAfterMs = waitMs;
      first = await attempt();
      if (first instanceof Response) return first;
    }

    // failover (SPEC-PROVIDERS §4ter): declared on the ACTIVE profile, one
    // retry through the named profile, no cascades, always visible in the log
    const failoverName = config.profiles[config.activeProfile]?.failover;
    if (failoverName === undefined) return fail(first.retryable);
    failedOver = config.activeProfile;

    // §4octies: a quota-exhausted answer on the ACTIVE profile itself (never a
    // delegated one) moves the active profile durably, through the same write
    // `lupin use` performs. It keys on the exhausted answer, not on the
    // failover's luck with this one request: the primary is spent either way.
    if (
      profileName === failedOver &&
      quotaExhausted(config.profiles[profileName]?.provider ?? '', first.retryable)
    ) {
      quotaSwitch = failoverName;
      config.activeProfile = failoverName; // this daemon, effective immediately
      persistActiveProfile(failedOver, failoverName); // the config file, hot-reload included
    }

    const second = await attempt(failoverName);
    if (second instanceof Response) return second;
    return fail(second.retryable);
  }

  return app;
}

/** Reads the Anthropic usage shape into log fields, ignoring what it lacks. */
function mergeUsage(into: UsageLine, raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const input = num(u['input_tokens']);
  const output = num(u['output_tokens']);
  const cacheRead = num(u['cache_read_input_tokens']);
  const cacheCreate = num(u['cache_creation_input_tokens']);
  if (input !== undefined) into.input = input;
  if (output !== undefined) into.output = output;
  if (cacheRead !== undefined) into.cacheRead = cacheRead;
  if (cacheCreate !== undefined) into.cacheCreate = cacheCreate;
  return input !== undefined || output !== undefined;
}

/**
 * Pass-through tap over an SSE body: every chunk is forwarded byte-identical,
 * `onError` fires once if the stream announces an `event: error`, and `onUsage`
 * fires at close with the token counts the stream announced. The decoder is
 * kept in streaming mode so a marker split across chunks (or a multi-byte
 * character straddling a boundary) is still read correctly.
 *
 * One tap, not two chained: both jobs need the same decoded text, and a second
 * TransformStream would decode every byte of every stream a second time.
 */
function watchSse(
  onError: (detail: string) => void,
  onUsage: (usage: UsageLine) => void,
  onEnd?: (sawError: boolean, sawTerminal: boolean) => void,
): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  const decoder = new TextDecoder();
  let pending = '';
  let fired = false;
  /** message_stop, or the message_delta that carries the stop_reason: without
   *  either, the body stopped mid answer (§9.1, issue #1). */
  let sawTerminal = false;
  // Separate buffer: the error scan truncates its tail aggressively, which
  // would shred the data lines the usage scan has to read whole.
  let lines = '';
  const usage: UsageLine = { input: 0, output: 0 };
  let sawUsage = false;
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk); // forward first: observation must never delay bytes
      const text = decoder.decode(chunk, { stream: true });

      if (!fired) {
        pending += text;
        const at = pending.indexOf('event: error');
        if (at !== -1) {
          fired = true;
          const slice = pending.slice(at);
          // The informative type is the nested one: the envelope always says
          // "error", the error object says WHICH error.
          const nested = /"error"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"/.exec(slice);
          const plain = /"type"\s*:\s*"([^"]+)"/.exec(slice);
          onError(nested?.[1] ?? plain?.[1] ?? 'error');
          pending = '';
        } else if (pending.length > 512) {
          // Keep only enough tail to catch a marker split across the boundary.
          pending = pending.slice(-32);
        }
      }

      // input counts ride on message_start, the final output count on
      // message_delta (SPEC-TRANSLATION §9.1): so both have to be read.
      lines += text;
      for (;;) {
        const nl = lines.indexOf('\n');
        if (nl === -1) break;
        const line = lines.slice(0, nl);
        lines = lines.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        if (line.includes('"type":"message_stop"')) sawTerminal = true;
        if (!line.includes('"usage"')) continue;
        try {
          const ev = JSON.parse(line.slice(line.indexOf(':') + 1)) as Record<string, unknown>;
          const msg = ev['message'];
          const raw = ev['type'] === 'message_start' && msg !== undefined ? (msg as Record<string, unknown>)['usage'] : ev['usage'];
          if (mergeUsage(usage, raw)) sawUsage = true;
          // The stop_reason lands here: a body cut between message_delta and
          // message_stop still delivered a complete answer.
          const delta = ev['delta'];
          if (ev['type'] === 'message_delta' && delta !== null && typeof delta === 'object') {
            if ((delta as Record<string, unknown>)['stop_reason'] != null) sawTerminal = true;
          }
        } catch {
          // A data line we cannot parse is not worth failing a request over.
        }
      }
      // A malformed stream with no newline must not grow the buffer forever.
      if (lines.length > 65_536) lines = '';
    },
    flush() {
      if (sawUsage) onUsage(usage);
      onEnd?.(fired, sawTerminal);
    },
  });
}

/**
 * Same contract for a non-streamed body: forward every byte, then read the
 * usage object once the whole JSON has gone by. Bounded so a huge or
 * malformed body cannot be accumulated without limit.
 */
function watchJson(onUsage: (usage: UsageLine) => void): TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>> {
  const decoder = new TextDecoder();
  let body = '';
  let overflow = false;
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk); // forward first: observation must never delay bytes
      if (overflow) return;
      body += decoder.decode(chunk, { stream: true });
      if (body.length > 1_048_576) {
        overflow = true;
        body = '';
      }
    },
    flush() {
      if (overflow) return;
      try {
        const usage: UsageLine = { input: 0, output: 0 };
        if (mergeUsage(usage, (JSON.parse(body) as Record<string, unknown>)['usage'])) onUsage(usage);
      } catch {
        // Not JSON, or no usage: nothing to report, never an error.
      }
    },
  });
}

function isLocalTokenValid(c: Context, localToken: string): boolean {
  const auth = c.req.header('authorization');
  const bearer = auth !== undefined && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
  const token = c.req.header('x-api-key') ?? bearer;
  return token !== undefined && token === localToken;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function errBody(type: string, message: string): AnthropicErrorBody {
  return { type: 'error', error: { type, message } };
}

function authError(message: string): NormalizedError {
  return { status: 401, body: errBody('authentication_error', message) };
}

function errorResponse(err: NormalizedError): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (err.retryAfter !== undefined) headers.set('retry-after', err.retryAfter);
  return new Response(JSON.stringify(err.body), { status: err.status, headers });
}
