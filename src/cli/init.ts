// Hosted-profile persistence shared by every setup surface (SPEC-CLI §1).
// The interactive `lupin init` wizard was removed with ADR-51: the TUI hub
// drives these functions through the control API (server/control.ts), which
// also owns local-runtime setup via providers/local.ts discoverChatModels.

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  defaultConfigPath,
  loadConfig,
  saveConfig,
  type LupinConfig,
  type ProfileConfig,
  type SlotName,
} from '../config/config.js';
import { setCredential } from '../config/credentials.js';
import type { DefaultProfileDef } from '../providers/defaults.js';
import { testProviderKey } from '../server/connectivity.js';
import type { BootstrapIdentity } from './login.js';

/** Pure merge, exported for tests: adds/replaces the profile and activates it. */
export function mergeProfile(
  d: DefaultProfileDef,
  existing?: LupinConfig,
  slotsOverride?: Record<SlotName, string>,
  economy = false,
): LupinConfig {
  const preset = economy ? d.economy : undefined;
  const slots = slotsOverride ?? preset?.slots ?? d.slots;
  if (slots === undefined) {
    throw new Error(`profile "${d.id}": no slots (local profiles pick them at setup, SPEC-PROVIDERS §3ter)`);
  }
  if (d.auth !== 'none' && d.apiKeyEnv === undefined) {
    throw new Error(`profile "${d.id}": auth "${d.auth}" requires apiKeyEnv in the defaults`);
  }
  const profile: ProfileConfig = {
    provider: d.provider,
    mode: d.mode,
    auth: d.auth === 'none' ? { type: 'none' } : { type: d.auth, apiKeyRef: d.apiKeyEnv ?? '' },
    slots: { ...slots },
    ...(d.contextWindows !== undefined ? { contextWindows: { ...d.contextWindows } } : {}),
    ...(preset !== undefined ? { routes: structuredClone(preset.routes) } : {}),
    ...(d.quirks !== undefined ? { quirks: [...d.quirks] } : {}),
  };
  const config: LupinConfig = existing ?? {
    activeProfile: d.id,
    port: 3456,
    localToken: randomBytes(24).toString('hex'),
    profiles: {},
  };
  config.profiles[d.id] = profile;
  config.activeProfile = d.id;
  return config;
}

/** Choices the TUI setup carries that the wizard used to ask (SPEC-CLI §1, ADR-51). */
export interface KeySetupOptions {
  economy?: boolean;
  failover?: string;
  /** Store key and profile even though the connectivity test failed: an explicit choice, never a default. */
  saveAnyway?: boolean;
}

/** Verifies and persists one hosted default without any interactive choices. */
export async function persistKeyProfile(
  d: DefaultProfileDef,
  key: string,
  bootstrapIdentity?: BootstrapIdentity,
  testKey: typeof testProviderKey = testProviderKey,
  opts: KeySetupOptions = {},
): Promise<{ ok: true } | { ok: false; error: string; canSaveAnyway?: true }> {
  if (opts.economy === true && d.economy === undefined) {
    return { ok: false, error: `profile "${d.id}" has no economy preset` };
  }
  const test = await testKey(d, key);
  // canSaveAnyway marks the one failure the caller may overrule: the provider
  // said no, but the key might still be right (offline, quota, wrong region).
  if (!test.ok && opts.saveAnyway !== true) return { ok: false, error: test.detail, canSaveAnyway: true };
  if (d.apiKeyEnv === undefined) return { ok: false, error: `profile "${d.id}" has no API-key credential` };

  const existing = existsSync(defaultConfigPath())
    ? loadConfig()
    : bootstrapIdentity === undefined
      ? undefined
      : { activeProfile: '', port: bootstrapIdentity.port, localToken: bootstrapIdentity.localToken, profiles: {} };
  if (opts.failover !== undefined && (existing === undefined || !(opts.failover in existing.profiles) || opts.failover === d.id)) {
    return { ok: false, error: `unknown failover profile "${opts.failover}"` };
  }
  setCredential(d.apiKeyEnv, key);
  const merged = mergeProfile(d, existing, undefined, opts.economy === true);
  if (opts.failover !== undefined) {
    const profile = merged.profiles[d.id];
    if (profile !== undefined) profile.failover = opts.failover;
  }
  saveConfig(merged);
  return { ok: true };
}
