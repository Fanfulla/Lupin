// Control API (DESIGN-OAUTH-PKCE-TUI §2.2): the loopback surface the TUI and
// the simplified CLI drive. 127.0.0.1 only, every route behind the localToken,
// nothing but metadata crosses (privacy rule: state, never prompts). The TUI
// reads the log itself; everything that CHANGES state goes through here so the
// config file stays the single writer and the hot-reload watch the single
// reload trigger.
//
// Long-running work (an OAuth login, a doctor run) is job-based: POST returns
// a job id, GET polls. The daemon owns the work; the TUI stays responsive.

import type { Context, Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { loadConfig, saveConfig } from '../config/config.js';
import { deleteOAuthTokens } from '../config/credentials.js';
import { findOAuthProvider, type OAuthProviderDef } from '../providers/oauth.js';
import { runPkceLogin, type PkceLoginHooks } from './oauth-pkce.js';
import { asDeviceFlow } from '../providers/oauth.js';
import { pollDeviceToken, startDeviceAuthorization } from './oauth.js';
import { setOAuthTokens } from '../config/credentials.js';

type JobStatus = 'pending' | 'done' | 'error';

interface Job {
  id: string;
  kind: 'login' | 'doctor';
  status: JobStatus;
  createdAt: number;
  /** For a login job: the URL/code the user must visit, once known. */
  message?: string;
  error?: string;
}

// Module-level on purpose: createApp is rebuilt on every hot reload, but a
// login in flight must survive it. Jobs are short-lived and in-memory only.
const jobs = new Map<string, Job>();

function newJob(kind: Job['kind']): Job {
  const job: Job = { id: randomBytes(8).toString('hex'), kind, status: 'pending', createdAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}

/** Drops finished jobs older than a minute: the map must not grow without bound. */
function sweepJobs(now: number = Date.now()): void {
  for (const [id, j] of jobs) {
    if (j.status !== 'pending' && now - j.createdAt > 60_000) jobs.delete(id);
  }
}

export interface ControlDeps {
  /** Opens the browser best-effort (the CLI's implementation; a no-op in tests). */
  openBrowser: (url: string) => void;
}

/**
 * Mounts the control routes on the daemon app. `config.localToken` guards every
 * route; the config itself is re-read from disk per request so a hot reload is
 * always honoured (these routes never see the rebuilt app as a problem).
 */
export function registerControlRoutes(app: Hono, localToken: string, deps: ControlDeps): void {
  const guard = (c: Context): Response | undefined => {
    const auth = c.req.header('authorization');
    const bearer = auth !== undefined && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const token = c.req.header('x-api-key') ?? bearer;
    if (token === undefined || token !== localToken) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: '[lupin] invalid local token' } }, 401);
    }
    return undefined;
  };

  // Full routing truth for the TUI: superset of /health, straight from disk.
  app.get('/v1/lupin/state', (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    try {
      const config = loadConfig();
      return c.json({ ok: true, config });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Switch the active profile. Writes the config file; the existing hot-reload
  // watch picks it up, so this is the SAME path as `lupin use`.
  app.post('/v1/lupin/use', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { profile?: string };
    try {
      body = (await c.req.json()) as { profile?: string };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { profile }' }, 400);
    }
    if (typeof body.profile !== 'string' || body.profile === '') {
      return c.json({ ok: false, error: 'expected a JSON body { profile }' }, 400);
    }
    try {
      const config = loadConfig();
      if (!(body.profile in config.profiles)) {
        return c.json({ ok: false, error: `unknown profile "${body.profile}"` }, 404);
      }
      config.activeProfile = body.profile;
      saveConfig(config);
      return c.json({ ok: true, activeProfile: config.activeProfile });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // The automatic-switch order (ADR-34): the failover chain, set atomically.
  // Each named profile fails over to the next; the LAST one's failover is
  // removed (a chain has an end, not a loop); profiles outside the list keep
  // whatever they had. Atomic on purpose: no partial chain can survive a
  // mid-edit failure.
  app.post('/v1/lupin/switch-order', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { order?: unknown };
    try {
      body = (await c.req.json()) as { order?: unknown };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { order: [profile names…] }' }, 400);
    }
    const order = body.order;
    if (!Array.isArray(order) || order.length < 2 || !order.every((p): p is string => typeof p === 'string')) {
      return c.json({ ok: false, error: 'expected { order: [at least two profile names] }' }, 400);
    }
    if (new Set(order).size !== order.length) {
      return c.json({ ok: false, error: 'a profile cannot appear twice in the order' }, 400);
    }
    try {
      const config = loadConfig();
      const missing = order.find((p) => !(p in config.profiles));
      if (missing !== undefined) return c.json({ ok: false, error: `unknown profile "${missing}"` }, 404);
      for (let i = 0; i < order.length; i++) {
        const name = order[i];
        const next = order[i + 1];
        const profile = name === undefined ? undefined : config.profiles[name];
        if (profile === undefined) continue;
        if (next === undefined) delete profile.failover;
        else profile.failover = next;
      }
      saveConfig(config);
      return c.json({ ok: true, order });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Agent routes (SPEC-PROVIDERS §4decies, ADR-47): the whole table at once,
  // like switch-order (ADR-34): no partial edit can survive a mid-write
  // failure. An empty table removes the key: an absent table is the documented
  // "feature off" state, and a lingering {} would read as something else.
  app.post('/v1/lupin/agents', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { agents?: unknown };
    try {
      body = (await c.req.json()) as { agents?: unknown };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { agents: { name: target… } }' }, 400);
    }
    const agents = body.agents;
    if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) {
      return c.json({ ok: false, error: 'expected { agents: { name: target… } }' }, 400);
    }
    try {
      const config = loadConfig();
      const table = agents as Record<string, string | { profile: string }>;
      if (Object.keys(table).length === 0) delete config.agents;
      else config.agents = table;
      try {
        saveConfig(config);
      } catch (e) {
        // saveConfig validates first: a bad name or target is the caller's
        // mistake, not a server failure.
        return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 400);
      }
      return c.json({ ok: true, agents: config.agents ?? {} });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Start an OAuth login as a job. The job's message carries the URL/code.
  app.post('/v1/lupin/login', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { provider?: string; acceptRisk?: boolean };
    try {
      body = (await c.req.json()) as { provider?: string; acceptRisk?: boolean };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { provider }' }, 400);
    }
    const def = body.provider !== undefined ? findOAuthProvider(body.provider) : undefined;
    if (def === undefined) {
      return c.json({ ok: false, error: `no OAuth flow for "${String(body.provider)}"` }, 404);
    }
    if (def.suspensionWarning !== undefined && body.acceptRisk !== true) {
      return c.json({ ok: false, error: def.suspensionWarning, requiresRiskAcceptance: true }, 409);
    }
    sweepJobs();
    const job = newJob('login');
    void runLoginJob(job, def, body.acceptRisk === true, deps);
    return c.json({ ok: true, job: job.id });
  });

  app.get('/v1/lupin/login/:id', (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    const job = jobs.get(c.req.param('id'));
    if (job === undefined) return c.json({ ok: false, error: 'unknown job' }, 404);
    return c.json({
      ok: true,
      status: job.status,
      ...(job.message !== undefined ? { message: job.message } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    });
  });

  app.post('/v1/lupin/logout', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { provider?: string };
    try {
      body = (await c.req.json()) as { provider?: string };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { provider }' }, 400);
    }
    const def = body.provider !== undefined ? findOAuthProvider(body.provider) : undefined;
    if (def === undefined) return c.json({ ok: false, error: `unknown OAuth provider "${String(body.provider)}"` }, 404);
    deleteOAuthTokens(def.id);
    return c.json({ ok: true });
  });
}

async function runLoginJob(job: Job, def: OAuthProviderDef, acceptRisk: boolean, deps: ControlDeps): Promise<void> {
  try {
    const hooks: PkceLoginHooks = {
      openBrowser: deps.openBrowser,
      onUrl: (url) => {
        job.message = url;
      },
    };
    let tokens;
    if (def.flow.kind === 'device') {
      const ddef = asDeviceFlow(def);
      const auth = await startDeviceAuthorization(ddef);
      job.message = auth.verificationUriComplete ?? auth.verificationUri;
      deps.openBrowser(job.message);
      tokens = await pollDeviceToken(ddef, auth);
    } else {
      tokens = await runPkceLogin(def, hooks);
    }
    setOAuthTokens(def.id, tokens);
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e instanceof Error ? e.message : String(e);
  }
}
