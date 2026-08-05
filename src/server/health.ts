// Failover cooldown (SPEC-PROVIDERS §4sexies): in-memory health per profile.
// A dead primary is retried on every request without this; with it, after a
// few consecutive retryable failures the profile cools down and requests skip
// straight to the failover. Never persisted: a restart is already recovery.

export const FAILOVER_COOLDOWN_THRESHOLD = 3;
export const FAILOVER_COOLDOWN_MS = 60_000;

export type ProfileHealth = 'healthy' | 'cooldown';

interface State {
  consecutiveFailures: number;
  cooldownUntil: number;
}

export interface HealthTracker {
  /** Record a retryable failure; may trip the profile into cooldown. */
  recordFailure(profile: string, now?: number): void;
  /** Record a success: clears the counter and any cooldown. */
  recordSuccess(profile: string): void;
  /** True while the profile is in cooldown and should be skipped. */
  inCooldown(profile: string, now?: number): boolean;
  /** Seconds of cooldown left (0 when healthy), for `lupin list` and logs. */
  cooldownRemainingSec(profile: string, now?: number): number;
  /** Health label for display. */
  status(profile: string, now?: number): ProfileHealth;
}

export function createHealthTracker(opts: { threshold?: number; cooldownMs?: number } = {}): HealthTracker {
  const threshold = opts.threshold ?? FAILOVER_COOLDOWN_THRESHOLD;
  const cooldownMs = opts.cooldownMs ?? FAILOVER_COOLDOWN_MS;
  const states = new Map<string, State>();

  const get = (profile: string): State => {
    let s = states.get(profile);
    if (s === undefined) {
      s = { consecutiveFailures: 0, cooldownUntil: 0 };
      states.set(profile, s);
    }
    return s;
  };

  return {
    recordFailure(profile, now = Date.now()) {
      const s = get(profile);
      s.consecutiveFailures += 1;
      if (s.consecutiveFailures >= threshold) s.cooldownUntil = now + cooldownMs;
    },
    recordSuccess(profile) {
      states.delete(profile);
    },
    inCooldown(profile, now = Date.now()) {
      return get(profile).cooldownUntil > now;
    },
    cooldownRemainingSec(profile, now = Date.now()) {
      const left = get(profile).cooldownUntil - now;
      return left > 0 ? Math.ceil(left / 1000) : 0;
    },
    status(profile, now = Date.now()) {
      return get(profile).cooldownUntil > now ? 'cooldown' : 'healthy';
    },
  };
}
