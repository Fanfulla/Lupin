// Recommended-skills offer at the end of `lupin init` (user decision 2026-07-29).
// Same §4septies posture as the failover/vision/statusline offers: NEVER
// auto-install, the default is always "no", and the install runs only through
// the official `claude plugin` mechanism on an explicit yes (ADR-11: Lupin
// never writes into ~/.claude behind the user's back). These skills are not
// part of the proxy; they are quality-of-life Claude Code plugins the user
// asked to recommend. A failure to install never fails the init.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';

export interface RecommendedSkill {
  /** Short label shown in the offer. */
  label: string;
  /** One honest line on what it does. */
  description: string;
  /** `owner/repo` passed to `claude plugin marketplace add`. */
  marketplace: string;
  /** `plugin@marketplace` passed to `claude plugin install`. */
  plugin: string;
}

/** The curated list. Kept as data so a new recommendation is a one-line change. */
export const RECOMMENDED_SKILLS: RecommendedSkill[] = [
  {
    label: 'caveman',
    description: 'terse caveman-style answers, cuts output tokens by roughly 65%',
    marketplace: 'juliusbrussee/caveman',
    plugin: 'caveman@caveman',
  },
  {
    label: 'i-have-adhd',
    description: 'answers lead with the next action, no preamble or buried point',
    marketplace: 'ayghri/i-have-adhd',
    plugin: 'i-have-adhd@i-have-adhd',
  },
];

/** Yes only on an explicit yes: the default is always "no" (§4septies). */
function isYes(answer: string): boolean {
  return /^(s|si|sì|y|yes)$/i.test(answer.trim());
}

export interface SkillOfferIo {
  /** Asks one yes/no question; injected in tests. */
  ask: (prompt: string) => Promise<string>;
  /** Runs one `claude plugin ...` command; resolves true on success. Injected in tests. */
  run: (args: string[]) => Promise<boolean>;
  /** Prints a line; injected in tests. */
  print: (line: string) => void;
}

/**
 * The decision half, pure apart from the injected IO: for each skill it asks,
 * and installs only the ones answered yes. Returns the labels installed.
 * Exported for tests; the interactive wrapper below supplies the real IO.
 */
export async function runSkillOffer(skills: readonly RecommendedSkill[], io: SkillOfferIo): Promise<string[]> {
  const installed: string[] = [];
  for (const s of skills) {
    const ans = await io.ask(`  install ${s.label} (${s.description})? [y/N] `);
    if (!isYes(ans)) continue;
    const ok = (await io.run(['marketplace', 'add', s.marketplace])) && (await io.run(['install', s.plugin]));
    io.print(ok ? `  ✓ ${s.label} installed` : `  ✗ ${s.label}: install failed (init is not affected)`);
    if (ok) installed.push(s.label);
  }
  return installed;
}

/**
 * Offers the recommended skills and installs the accepted ones through the
 * official `claude plugin` commands. Interactive-only and opt-in; a no-op when
 * the list is empty or the user declines everything.
 */
export async function offerRecommendedSkills(skills: RecommendedSkill[] = RECOMMENDED_SKILLS): Promise<void> {
  if (skills.length === 0 || !process.stdin.isTTY) return;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nRecommended Claude Code skills (optional, installed only on your yes):');
  try {
    await runSkillOffer(skills, {
      ask: (p) => rl.question(p),
      run: runClaudePlugin,
      print: (l) => console.log(l),
    });
  } finally {
    rl.close();
  }
}

/** Runs one `claude plugin ...` command; resolves true on exit 0. */
function runClaudePlugin(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('claude', ['plugin', ...args], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
