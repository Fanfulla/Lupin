// Free tiers, in ONE place (CLAUDE.md rule 4: never a provider name check
// scattered through the code). A free model is not a defect and Lupin does not
// hide it, but a user who thinks they are running a frontier model when they
// are not is being misled by omission. So wherever Lupin names a model, it says
// when that model is free, and where a paid plan would be bought.
//
// Two independent ways to know, because providers publish it differently:
//   - DECLARED: the provider answers with the account's tier (Google Code
//     Assist returns `currentTier: free-tier`). Only the lane can see it, so it
//     reports back through `noteFreeTier`.
//   - BY CONVENTION: the model id itself says so (OpenRouter suffixes `:free`).
//     Visible without any request, so the model picker can mark it immediately.

import { PROVIDERS } from './registry.js';

/** Providers whose free tier can be left by paying. Local runtimes have none. */
const UPGRADE_URLS: Record<string, string> = {
  geminisub: 'https://codeassist.google.com/upgrade',
  openrouter: 'https://openrouter.ai/settings/credits',
};

/** Profiles a lane has SEEN answer on a free tier, and what it was serving. */
const declaredFreeTier = new Map<string, { servedSlot?: string }>();

/** A lane learned the account behind this profile is on a free tier. */
export function noteFreeTier(profileName: string, servedSlot?: string): void {
  declaredFreeTier.set(profileName, servedSlot === undefined ? {} : { servedSlot });
}

/** Only for tests: forget what the lanes reported. */
export function resetFreeTierNotes(): void {
  declaredFreeTier.clear();
}

/**
 * OpenRouter publishes its no-cost models with a `:free` suffix on the id
 * (openrouter.ai/models?max_price=0, verified 2026-07-20). This is the id's own
 * convention, not a model name in the sources: nothing here is a model list.
 */
export function isFreeByConvention(model: string): boolean {
  return model.endsWith(':free');
}

/** True when this profile is known to be serving free models. */
export function isFreeTier(profileName: string, model: string): boolean {
  return declaredFreeTier.has(profileName) || isFreeByConvention(model);
}

/** Where this provider sells its way out of the free tier, when it does. */
export function upgradeUrl(providerId: string): string | undefined {
  return UPGRADE_URLS[providerId];
}

/**
 * The model name as the user should read it: marked when it is free, so the
 * model picker and every status surface tell the same truth.
 */
export function labelModel(profileName: string, providerId: string, model: string): string {
  if (!isFreeTier(profileName, model)) return model;
  const url = upgradeUrl(providerId);
  return url === undefined ? `${model} (free)` : `${model} (free, upgrade: ${url})`;
}

/**
 * The paragraph shown when a free tier is first discovered: what is served,
 * and how to leave it. One text, so login, status and the doctor cannot drift.
 */
export function freeTierNotice(providerId: string, servedSlot?: string, upgradeOverride?: string): string {
  // A URL the provider itself returned beats the static one: Google's is built
  // for the signed-in account, so it lands on the right upgrade page.
  const url = upgradeOverride ?? upgradeUrl(providerId) ?? PROVIDERS[providerId]?.baseUrl ?? '';
  const lines = ['This account is on a FREE tier, so the models served are the free ones.'];
  if (servedSlot !== undefined) {
    lines.push(
      `  Lupin serves them on the ${servedSlot.toUpperCase()} slot and answers the other slots with the same`,
      '  model rather than failing, because the free tier refuses every paid one. Every',
      '  substitution is logged as tierDowngrade, so the logs always name the model that ran.',
    );
  }
  if (url !== '') lines.push(`  A paid plan removes the limit: ${url}`);
  return lines.join('\n');
}
