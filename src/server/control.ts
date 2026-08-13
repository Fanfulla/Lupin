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
import { existsSync } from 'node:fs';
import { mergeProfile, persistKeyProfile, type KeySetupOptions } from '../cli/init.js';
import { ensureOAuthProfile, importOfficialCredentials, verifyToken, type BootstrapIdentity } from '../cli/login.js';
import { defaultConfigPath, loadConfig, saveConfig, type RoutesConfig, type SlotName } from '../config/config.js';
import { deleteOAuthTokens } from '../config/credentials.js';
import { DOCTOR_MIN_CONTEXT, preflightContext } from '../doctor/plan.js';
import { DEFAULT_PROFILES, type DefaultProfileDef } from '../providers/defaults.js';
import { fetchCatalog } from '../providers/catalog.js';
import { discoverChatModels, persistableWindow } from '../providers/local.js';
import { accountKey, findOAuthProvider, isValidAccountLabel, type OAuthProviderDef } from '../providers/oauth.js';
import { PROVIDERS } from '../providers/registry.js';
import { runPkceLogin, type PkceLoginHooks } from './oauth-pkce.js';
import { asDeviceFlow } from '../providers/oauth.js';
import { pollDeviceToken, startDeviceAuthorization } from './oauth.js';
import { setOAuthTokens } from '../config/credentials.js';
import { testProviderKey } from './connectivity.js';

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
  /** Connectivity seams keep failure-path tests local and deterministic. */
  testProviderKey?: typeof testProviderKey;
  verifyToken?: typeof verifyToken;
  /** Seam for local-runtime discovery: the probes hit 127.0.0.1 ports otherwise. */
  fetchLocal?: typeof fetch;
  /** Seam for the hosted catalogue fetch (design 2026-08-13). */
  fetchCatalog?: typeof fetch;
  /** Seam for the official-CLI credential import, which reads real files otherwise. */
  importCredentials?: typeof importOfficialCredentials;
}

export interface ProviderCatalogRow {
  id: string;
  description: string;
  authKind: 'key' | 'oauth' | 'local';
  suspensionWarning?: string;
  /** Human description of the economy preset, when the defaults declare one. */
  economy?: string;
  /** Local rows: the command that starts the server, shown when discovery fails. */
  startHint?: string;
  /** OAuth rows: official CLI credentials exist here and can be imported without a browser. */
  importAvailable?: true;
}

/**
 * Mounts the control routes on the daemon app. `config.localToken` guards every
 * route; the config itself is re-read from disk per request so a hot reload is
 * always honoured (these routes never see the rebuilt app as a problem).
 */
export function registerControlRoutes(app: Hono, bootstrapIdentity: BootstrapIdentity, deps: ControlDeps): void {
  const guard = (c: Context): Response | undefined => {
    const auth = c.req.header('authorization');
    const bearer = auth !== undefined && auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const token = c.req.header('x-api-key') ?? bearer;
    if (token === undefined || token !== bootstrapIdentity.localToken) {
      return c.json({ type: 'error', error: { type: 'authentication_error', message: '[lupin] invalid local token' } }, 401);
    }
    return undefined;
  };

  app.get('/v1/lupin/providers', (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    // Every default is a row since ADR-51: this catalogue IS the setup surface,
    // so hiding the local runtimes here would orphan them.
    const providers: ProviderCatalogRow[] = DEFAULT_PROFILES.map((d) => {
      const oauthDef = d.oauthOnly === true ? findOAuthProvider(d.id) : undefined;
      const importable = oauthDef !== undefined && (deps.importCredentials ?? importOfficialCredentials)(oauthDef) !== undefined;
      return {
        id: d.id,
        description: d.description,
        authKind: d.local === true ? 'local' : d.oauthOnly === true ? 'oauth' : 'key',
        ...(oauthDef?.suspensionWarning !== undefined ? { suspensionWarning: oauthDef.suspensionWarning } : {}),
        ...(d.local !== true && d.oauthOnly !== true && d.economy !== undefined ? { economy: d.economy.description } : {}),
        ...(d.local === true && d.startHint !== undefined ? { startHint: d.startHint } : {}),
        ...(importable ? { importAvailable: true as const } : {}),
      };
    });
    return c.json({ ok: true, providers });
  });

  // Finds a local default and its registry row, or answers for the caller.
  const localDef = (c: Context, providerId: unknown): { d: DefaultProfileDef; def: (typeof PROVIDERS)[string] } | Response => {
    if (typeof providerId !== 'string' || providerId === '') {
      return c.json({ ok: false, error: 'expected a JSON body { providerId }' }, 400);
    }
    const d = DEFAULT_PROFILES.find((x) => x.id === providerId);
    if (d === undefined || d.local !== true) {
      return c.json({ ok: false, error: `unknown local provider "${providerId}"` }, 404);
    }
    const def = PROVIDERS[d.provider];
    if (def === undefined) return c.json({ ok: false, error: `provider "${d.provider}" is not in the registry: defaults bug` }, 500);
    return { d, def };
  };

  // Live discovery for the TUI's local setup (SPEC-CLI §1, ADR-51): the same
  // probe the wizard ran, as data. Unreachable is a 502 WITH the start command:
  // the verdict must carry its own remedy.
  app.post('/v1/lupin/discover-local', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { providerId?: unknown };
    try {
      body = (await c.req.json()) as { providerId?: unknown };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { providerId }' }, 400);
    }
    const found = localDef(c, body.providerId);
    if (found instanceof Response) return found;
    const discovered = await discoverChatModels(found.def, { fetchImpl: deps.fetchLocal });
    if (!discovered.ok) {
      return c.json(
        { ok: false, error: discovered.error, ...(found.d.startHint !== undefined ? { startHint: found.d.startHint } : {}) },
        502,
      );
    }
    const models = discovered.models.map((m) => ({ ...m, contextTooSmall: !preflightContext(m.contextWindow).ok }));
    return c.json({ ok: true, models });
  });

  // The hosted twin of discover-local (design 2026-08-13): the registry's
  // catalogApi capability, fetched and cached daemon-side, keyed by the
  // profile's `provider` field. It feeds the TUI's assisted model input and
  // only informs: no write anywhere is gated on it (ADR-42).
  app.post('/v1/lupin/discover-catalog', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { providerId?: unknown };
    try {
      body = (await c.req.json()) as { providerId?: unknown };
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { providerId }' }, 400);
    }
    if (typeof body.providerId !== 'string' || body.providerId === '') {
      return c.json({ ok: false, error: 'expected a JSON body { providerId }' }, 400);
    }
    const def = PROVIDERS[body.providerId];
    if (def?.catalogApi === undefined) {
      return c.json({ ok: false, error: `provider "${body.providerId}" publishes no catalogue` }, 404);
    }
    const result = await fetchCatalog(def, deps.fetchCatalog !== undefined ? { fetchImpl: deps.fetchCatalog } : {});
    if (!result.ok) return c.json({ ok: false, error: result.error }, 502);
    return c.json({ ok: true, models: result.models });
  });

  // Writes a local profile from the TUI's picks: the same shape initLocal
  // wrote, re-validated against a fresh discovery so a stale screen cannot
  // persist a model the server no longer serves. Routes stay opt-in (§4septies).
  app.post('/v1/lupin/setup-local', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { providerId?: unknown; main?: unknown; light?: unknown; vision?: unknown; longContext?: unknown; failover?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { providerId, main }' }, 400);
    }
    const found = localDef(c, body.providerId);
    if (found instanceof Response) return found;
    if (typeof body.main !== 'string' || body.main === '') {
      return c.json({ ok: false, error: 'expected a JSON body { providerId, main }' }, 400);
    }
    for (const [name, v] of [['light', body.light], ['vision', body.vision], ['failover', body.failover]] as const) {
      if (v !== undefined && (typeof v !== 'string' || v === '')) {
        return c.json({ ok: false, error: `"${name}" must be a non-empty string` }, 400);
      }
    }
    if (body.longContext !== undefined && typeof body.longContext !== 'boolean') {
      return c.json({ ok: false, error: '"longContext" must be a boolean' }, 400);
    }
    const discovered = await discoverChatModels(found.def, { fetchImpl: deps.fetchLocal });
    if (!discovered.ok) {
      return c.json(
        { ok: false, error: discovered.error, ...(found.d.startHint !== undefined ? { startHint: found.d.startHint } : {}) },
        502,
      );
    }
    const byId = new Map(discovered.models.map((m) => [m.id, m]));
    const main = body.main;
    const light = typeof body.light === 'string' ? body.light : main;
    for (const pick of [main, light]) {
      if (!byId.has(pick)) return c.json({ ok: false, error: `model "${pick}" is not on the local server` }, 404);
    }
    if (typeof body.vision === 'string') {
      const vm = byId.get(body.vision);
      if (vm?.supportsVision !== true || body.vision === main) {
        return c.json({ ok: false, error: `"${body.vision}" is not a vision candidate (must declare vision and differ from the main model)` }, 400);
      }
    }
    const windows: Record<string, number> = {};
    for (const id of new Set([main, light])) {
      const m = byId.get(id);
      const w = m === undefined ? undefined : persistableWindow(m, DOCTOR_MIN_CONTEXT);
      if (w !== undefined) windows[id] = w;
    }
    if (body.longContext === true && (Object.keys(windows).length === 0 || light === main)) {
      return c.json({ ok: false, error: 'the long-context route needs a known window and a light model distinct from the main one' }, 400);
    }
    const existing = existsSync(defaultConfigPath())
      ? loadConfig()
      : { activeProfile: '', port: bootstrapIdentity.port, localToken: bootstrapIdentity.localToken, profiles: {} };
    if (typeof body.failover === 'string' && (!(body.failover in existing.profiles) || body.failover === found.d.id)) {
      return c.json({ ok: false, error: `unknown failover profile "${body.failover}"` }, 404);
    }
    try {
      const config = mergeProfile(found.d, existing, { opus: main, sonnet: main, haiku: light });
      const profile = config.profiles[found.d.id];
      if (profile !== undefined) {
        if (Object.keys(windows).length > 0) profile.contextWindows = windows;
        const routes: RoutesConfig = {};
        if (typeof body.vision === 'string') routes.vision = { target: body.vision };
        if (body.longContext === true) routes.longContext = { target: main };
        if (Object.keys(routes).length > 0) profile.routes = routes;
        if (typeof body.failover === 'string') profile.failover = body.failover;
      }
      saveConfig(config);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.post('/v1/lupin/setup-key', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { providerId?: unknown; key?: unknown; economy?: unknown; failover?: unknown; saveAnyway?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { providerId, key }' }, 400);
    }
    if (typeof body.providerId !== 'string' || body.providerId === '' || typeof body.key !== 'string' || body.key === '') {
      return c.json({ ok: false, error: 'expected a JSON body { providerId, key }' }, 400);
    }
    for (const [name, v] of [['economy', body.economy], ['saveAnyway', body.saveAnyway]] as const) {
      if (v !== undefined && typeof v !== 'boolean') return c.json({ ok: false, error: `"${name}" must be a boolean` }, 400);
    }
    const def = DEFAULT_PROFILES.find((d) => d.id === body.providerId);
    if (def === undefined) return c.json({ ok: false, error: `unknown provider "${body.providerId}"` }, 404);
    if (def.apiKeyEnv === undefined) {
      return c.json({ ok: false, error: `provider "${body.providerId}" does not accept an API key` }, 400);
    }
    if (body.failover !== undefined) {
      if (typeof body.failover !== 'string' || body.failover === '') {
        return c.json({ ok: false, error: '"failover" must be a non-empty profile name' }, 400);
      }
      const existing = existsSync(defaultConfigPath()) ? loadConfig() : undefined;
      if (existing === undefined || !(body.failover in existing.profiles) || body.failover === def.id) {
        return c.json({ ok: false, error: `unknown failover profile "${body.failover}"` }, 404);
      }
    }
    try {
      const opts: KeySetupOptions = {
        ...(body.economy === true ? { economy: true } : {}),
        ...(typeof body.failover === 'string' ? { failover: body.failover } : {}),
        ...(body.saveAnyway === true ? { saveAnyway: true } : {}),
      };
      const result = await persistKeyProfile(def, body.key, bootstrapIdentity, deps.testProviderKey ?? testProviderKey, opts);
      if (!result.ok) return c.json(result, 400);
      return c.json(result);
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

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

  // Aim a profile's slots (SPEC-CLI §1, the `use --opus` rule): the names are
  // written as given and never checked, because nothing local can know which
  // ids a plan will accept, and an invented validation would be worse than
  // none. Same write path as `use`: the daemon hot-reloads the config.
  app.post('/v1/lupin/slots', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { profile?: unknown; opus?: unknown; sonnet?: unknown; haiku?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { profile, opus?, sonnet?, haiku? }' }, 400);
    }
    if (typeof body.profile !== 'string' || body.profile === '') {
      return c.json({ ok: false, error: 'expected a JSON body { profile, opus?, sonnet?, haiku? }' }, 400);
    }
    const aims: [SlotName, unknown][] = [
      ['opus', body.opus],
      ['sonnet', body.sonnet],
      ['haiku', body.haiku],
    ];
    for (const [name, v] of aims) {
      if (v !== undefined && (typeof v !== 'string' || v === '')) {
        return c.json({ ok: false, error: `"${name}" must be a non-empty model name` }, 400);
      }
    }
    if (aims.every(([, v]) => v === undefined)) {
      return c.json({ ok: false, error: 'name at least one slot to aim' }, 400);
    }
    try {
      const config = loadConfig();
      const profile = config.profiles[body.profile];
      if (profile === undefined) return c.json({ ok: false, error: `unknown profile "${body.profile}"` }, 404);
      for (const [name, v] of aims) if (typeof v === 'string') profile.slots[name] = v;
      saveConfig(config);
      return c.json({ ok: true, slots: profile.slots });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // Set or clear ONE profile's failover. The setup routes accept `failover`
  // in-body so a headless setup stays one call; the TUI asks AFTER the setup
  // succeeded (the answer should follow the verdict, not precede it), and this
  // is the write that later question lands on. Absent or null clears.
  app.post('/v1/lupin/failover', async (c) => {
    const denied = guard(c);
    if (denied !== undefined) return denied;
    let body: { profile?: unknown; failover?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { profile, failover? }' }, 400);
    }
    if (typeof body.profile !== 'string' || body.profile === '') {
      return c.json({ ok: false, error: 'expected a JSON body { profile, failover? }' }, 400);
    }
    if (body.failover !== undefined && body.failover !== null && (typeof body.failover !== 'string' || body.failover === '')) {
      return c.json({ ok: false, error: '"failover" must be a profile name, or null to clear' }, 400);
    }
    if (body.failover === body.profile) {
      return c.json({ ok: false, error: 'a profile cannot fail over to itself' }, 400);
    }
    try {
      const config = loadConfig();
      const profile = config.profiles[body.profile];
      if (profile === undefined) return c.json({ ok: false, error: `unknown profile "${body.profile}"` }, 404);
      if (typeof body.failover === 'string') {
        if (!(body.failover in config.profiles)) {
          return c.json({ ok: false, error: `unknown failover profile "${body.failover}"` }, 404);
        }
        profile.failover = body.failover;
      } else {
        delete profile.failover;
      }
      saveConfig(config);
      return c.json({ ok: true });
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
    let body: { provider?: string; acceptRisk?: boolean; account?: unknown; importIfAvailable?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { provider }' }, 400);
    }
    const def = body.provider !== undefined ? findOAuthProvider(body.provider) : undefined;
    if (def === undefined) {
      return c.json({ ok: false, error: `no OAuth flow for "${String(body.provider)}"` }, 404);
    }
    if (body.account !== undefined && (typeof body.account !== 'string' || !isValidAccountLabel(body.account))) {
      return c.json({ ok: false, error: 'the account label must match [A-Za-z0-9._-]{1,32}' }, 400);
    }
    if (def.suspensionWarning !== undefined && body.acceptRisk !== true) {
      return c.json({ ok: false, error: def.suspensionWarning, requiresRiskAcceptance: true }, 409);
    }
    sweepJobs();
    const job = newJob('login');
    void runLoginJob(job, def, body.acceptRisk === true, bootstrapIdentity, deps, {
      ...(typeof body.account === 'string' ? { account: body.account } : {}),
      ...(body.importIfAvailable === true ? { importIfAvailable: true } : {}),
    });
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
    let body: { provider?: string; account?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: 'expected a JSON body { provider }' }, 400);
    }
    const def = body.provider !== undefined ? findOAuthProvider(body.provider) : undefined;
    if (def === undefined) return c.json({ ok: false, error: `unknown OAuth provider "${String(body.provider)}"` }, 404);
    if (body.account !== undefined && (typeof body.account !== 'string' || !isValidAccountLabel(body.account))) {
      return c.json({ ok: false, error: 'the account label must match [A-Za-z0-9._-]{1,32}' }, 400);
    }
    // Forgets ONLY the named account (§4nonies): the bare key and the other
    // accounts of the same provider stay untouched.
    deleteOAuthTokens(accountKey(def.id, typeof body.account === 'string' ? body.account : undefined));
    return c.json({ ok: true });
  });
}

async function runLoginJob(
  job: Job,
  def: OAuthProviderDef,
  acceptRisk: boolean,
  bootstrapIdentity: BootstrapIdentity,
  deps: ControlDeps,
  opts: { account?: string; importIfAvailable?: boolean } = {},
): Promise<void> {
  try {
    const hooks: PkceLoginHooks = {
      openBrowser: deps.openBrowser,
      onUrl: (url) => {
        job.message = url;
      },
    };
    // The official-CLI import (SPEC-CLI §1, ADR-51): asked for explicitly by
    // the caller, never assumed. When nothing is importable the browser flow
    // proceeds as if the flag was never sent.
    let tokens = opts.importIfAvailable === true ? (deps.importCredentials ?? importOfficialCredentials)(def) : undefined;
    if (tokens === undefined) {
      if (def.flow.kind === 'device') {
        const ddef = asDeviceFlow(def);
        const auth = await startDeviceAuthorization(ddef);
        job.message = auth.verificationUriComplete ?? auth.verificationUri;
        deps.openBrowser(job.message);
        tokens = await pollDeviceToken(ddef, auth);
      } else {
        tokens = await runPkceLogin(def, hooks);
      }
    }
    const verdict = await (deps.verifyToken ?? verifyToken)(def, tokens);
    if (!verdict.ok) throw new Error(verdict.detail);
    // The account label picks the store key AND the derived profile name
    // (§4nonies): one credential plus its slots, whatever surface logged in.
    const storeKey = accountKey(def.id, opts.account);
    setOAuthTokens(storeKey, tokens);
    // The CLI login prints profile-creation failures to the terminal; this job
    // has no terminal, so a token whose profile could not be created would
    // silently outlive the failure. Roll it back: the login is a clean no-op.
    try {
      if (!ensureOAuthProfile(def, opts.account, verdict.models, bootstrapIdentity)) {
        throw new Error('could not create an OAuth profile');
      }
    } catch (e) {
      deleteOAuthTokens(storeKey);
      throw e;
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = e instanceof Error ? e.message : String(e);
  }
}
