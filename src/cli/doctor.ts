// `lupin doctor [<profile>] [--json] [--submit]` (SPEC-CLI §3): orchestration
// only, the logic lives in src/doctor/ (ARCHITECTURE cli-thin rule).

import { exec } from 'node:child_process';
import { loadConfig, saveConfig } from '../config/config.js';
import { DOCTOR_THRESHOLD, type CacheControlProbe } from '../doctor/plan.js';
import { cacheReceiptLine, preflightProfile, runDoctor } from '../doctor/run.js';
import { submissionUrl, type SubmissionInput } from '../doctor/submit.js';
import { CLIENT_VERSION } from '../providers/identity.js';

export async function doctorCommand(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const submit = args.includes('--submit');
  const profileArg = args.find((a) => !a.startsWith('--'));

  let config;
  try {
    config = loadConfig();
  } catch {
    console.error('no config yet, run `lupin init` first');
    return 1;
  }
  const profileName = profileArg ?? config.activeProfile;
  const profile = config.profiles[profileName];
  if (profile === undefined) {
    console.error(`profile "${profileName}" not found. Available: ${Object.keys(config.profiles).join(', ')}`);
    return 1;
  }

  // Only gates the banner: announcing a session that will be refused a
  // millisecond later reads as a crash. The run still proceeds, because it
  // performs the cache_control probe, which is a two-token request that stays
  // valid and informative even when the context window is too small.
  const willRun = preflightProfile(config, profileName).ok;
  if (!json && willRun) {
    console.log(`lupin doctor: profile "${profileName}", a real headless Claude Code session is running...`);
    console.log('(no hidden retries: the score measures the model bare)\n');
  }

  const result = await runDoctor(config, profileName);

  // §3.3: the submission is a URL, never an upload. Built here so both the
  // human and the --json output can carry it, and printed only after the
  // verdict: the user reads what they are about to publish first.
  const submission: SubmissionInput = {
    result,
    profile,
    profileName,
    version: CLIENT_VERSION,
    runtime: `${process.platform}, node ${process.version}`,
    date: new Date().toISOString().slice(0, 10),
  };
  const submitUrl = submit ? submissionUrl(submission) : undefined;
  // `quirks` is configuration, not measurement, which is why it lives on the
  // profile and not in the run result. It is copied into the payload anyway:
  // a consumer reading only this JSON cannot otherwise tell that the score was
  // earned under a quirk that changed the request. Always present, like
  // `dialects`, so the shape does not depend on the profile.
  const jsonPayload = (): string =>
    JSON.stringify(
      {
        ...result,
        quirks: profile.quirks ?? [],
        ...(submitUrl !== undefined ? { submitUrl } : {}),
      },
      null,
      2,
    );
  const printSubmission = (): void => {
    if (submitUrl === undefined) return;
    console.log('\nSubmission (public scoreboard): a pre-filled GitHub issue, nothing is uploaded.');
    console.log('It carries provider, model, score, checks and measurements only. No credentials, no prompts.');
    console.log(`\n${submitUrl}\n`);
    openBrowser(submitUrl);
  };

  // A run that never reached the model has no verdict: printing a score here
  // would blame the model for a transport or configuration failure. It is also
  // NOT persisted as lastDoctor: a 0 nobody earned would poison the history.
  if (result.notRun !== undefined) {
    if (json) {
      console.log(jsonPayload());
    } else {
      console.error(`x doctor did not run on "${profileName}" (${result.model})`);
      console.error(`  ${result.notRun}`);
      console.error('\n  No score: the session never reached the model.');
      // What the probe did learn stays worth printing: it is independent of
      // whatever stopped the session.
      if (result.cacheControl !== undefined) console.error(`\n  ${cacheControlLine(result.cacheControl)}`);
      // A refused run is worth reporting too: "this provider never let the
      // session start" is exactly the kind of fact the scoreboard exists for.
      printSubmission();
    }
    return 1;
  }

  const report = result.report;
  if (report === undefined) {
    // Unreachable by construction (notRun handled above); kept explicit so a
    // future refactor cannot silently print a verdict that does not exist.
    console.error('[lupin] internal: run ended with neither a report nor a notRun cause');
    return 1;
  }

  if (json) {
    console.log(jsonPayload());
  } else {
    for (const ch of report.checks) {
      const mark = ch.points === ch.max ? '✓' : ch.points > 0 ? '~' : '✗';
      console.log(`  ${mark} ${String(ch.id)}. ${ch.name.padEnd(24)} ${String(ch.points)}/${String(ch.max)}  ${ch.detail}`);
    }
    console.log(`\nScore: ${String(report.score)}/${String(report.max)} (threshold: ${String(DOCTOR_THRESHOLD)})`);
    console.log(
      `Duration: ${String(Math.round(result.durationMs / 1000))}s${result.costUsd !== undefined ? `, cost as Claude Code sees it ~$${result.costUsd.toFixed(4)} (Anthropic list price: through a third-party provider it is fictional)` : ''}`,
    );
    // SPEC-CLI §3: average latency and tokens, measured by the ephemeral proxy's tap.
    if (result.metrics !== undefined) {
      const m = result.metrics;
      console.log(
        `Requests: ${String(m.requests)}, average latency ${String(m.avgLatencyMs)}ms, tokens in/out ${String(m.inputTokens)}/${String(m.outputTokens)}`,
      );
      // Cache receipt (#11a): measured by the tap, never declared. A field the
      // provider never reported stays "never reported" when printed too: it is
      // not a zero.
      const receipt = cacheReceiptLine(m);
      if (receipt !== undefined) console.log(receipt);
    }
    if (result.sessionError !== undefined) console.log(`Session note: ${result.sessionError}`);
    // Configuration, not an observation, so no warning glyph: these are true on
    // every run of the profile. Worth printing anyway, because some of them
    // (noParallelToolCalls, singleSystemMessage, identityHint) change what the
    // model was asked, and a score earned under them is not comparable with a
    // bare one. The submission has always declared them: the terminal was the
    // one place that knew less than the scoreboard.
    if (profile.quirks !== undefined && profile.quirks.length > 0) {
      console.log(`Active quirks: ${profile.quirks.join(', ')} (from the profile, not measured)`);
    }
    // This one IS measured, and it is the number that tells an adapter that
    // helped from one that never fired (§5quater): both leave the score alone.
    if (result.editHints > 0) {
      console.log(`editRetryHint fired on ${String(result.editHints)} turn(s): that many edits were rejected`);
    }
    // §5bis rule 3: a high score earned thanks to a repair is a different
    // verdict from a high score without one. The number alone cannot say it.
    if (result.dialects.length > 0) {
      console.log(`\n⚠ Dialect normalizations that fired: ${result.dialects.join(', ')}`);
      console.log('  The model passed the checks only because the proxy repaired its output.');
    }
    if (result.cacheControl !== undefined) console.log(`\n${cacheControlLine(result.cacheControl)}`);
    console.log(
      report.passed
        ? `\n✓ "${profileName}" holds up under the Claude Code harness`
        : `\n✗ "${profileName}" below threshold: expect friction in real sessions (details above)`,
    );
    printSubmission();
  }

  // persisted on the profile (SPEC-CLI §3: lastDoctor)
  try {
    const fresh = loadConfig();
    const p = fresh.profiles[profileName];
    if (p !== undefined) {
      p.lastDoctor = { score: report.score, max: report.max, date: new Date().toISOString().slice(0, 10) };
      saveConfig(fresh);
    }
  } catch {
    // persisting the score must never make the verdict itself fail
  }

  return report.passed ? 0 : 1;
}

/** Best effort: the printed URL stays the real path, exactly like `lupin login`. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {
    // ignored on purpose
  });
}

/**
 * Three outcomes, one line. "Did not answer" is not "refused": printing the
 * latter for the former sends the reader chasing a caching bug that does not
 * exist (SPEC-CLI §3, verified against a slow local model 2026-07-19).
 */
function cacheControlLine(cc: CacheControlProbe): string {
  switch (cc.outcome) {
    case 'accepted':
      return '✓ cache_control accepted by the provider (prompt caching intact in passthrough)';
    case 'rejected':
      return `✗ cache_control rejected (HTTP ${String(cc.status)}): ${cc.detail}`;
    case 'inconclusive':
      return `? cache_control not verified: ${cc.detail}`;
  }
}
