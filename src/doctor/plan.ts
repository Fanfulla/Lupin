// lupin doctor, the check plan (SPEC-CLI §3). PURE module: it defines the
// workspace, the task prompt and the scoring from the collected observations.
// The score comes from ARTEFACTS on disk (edited files, scripts that ran),
// never from what the model claims. No hidden retries (ADR-6).

export const MAGIC_TOKEN = 'MAGIC-TOKEN-7431';

/** Initial files of the temporary workspace. */
export const DOCTOR_FILES: Record<string, string> = {
  'notes.txt': `Project notes.\nThe secret token for the doctor: ${MAGIC_TOKEN}\nEnd of notes.\n`,
  'greet.js': `function greet(name) {\n  return "Hello, " + name + "!";\n}\nconsole.log(greet("world"));\n`,
  'counter.js': `const START = 1;\nconst STEP = 1;\nlet v = START;\nfor (let i = 0; i < 3; i++) v += STEP;\nconsole.log(v);\n`,
  'broken.js': `const items = ["a", "b", "c"];\nfor (let i = 0; i <= items.length; i++) {\n  console.log(items[i].toUpperCase());\n}\n`,
};

/** One task covering all 6 checks: explicit instructions, one operation per line. */
export function doctorPrompt(): string {
  return [
    'Do these steps in order, in the current directory. Do not ask for confirmation.',
    '1. Read notes.txt with the Read tool and write the secret token you find (the token only, nothing else) into found.txt.',
    // "Ciao" on purpose: a word the model cannot autocomplete from English
    // habit, so the exact-match Edit is really exercised.
    '2. In greet.js, with the Edit tool, change the greeting "Hello" to "Ciao" (exact string match).',
    '3. In counter.js, with TWO separate Edits in sequence: first change START from 1 to 10, then change STEP from 1 to 5.',
    '4. Call the MCP tool mcp__lupin_doctor__echo_test with text "doctor-ping" and write the EXACT output it returns into echo.txt.',
    '5. Run broken.js with Bash, read the error, fix the bug with Edit, run it again until it prints A B C with no errors.',
    '6. When you are done, reply with the single word: DONE',
  ].join('\n');
}

/** Observations the runner collects after the session (I/O lives outside this module). */
export interface DoctorObservations {
  /** The headless session ended with a valid result JSON. */
  sessionCompleted: boolean;
  resultText: string;
  foundTxt?: string;
  greetJs?: string;
  /** Outcome of `node greet.js` after the session. */
  greetRun?: { code: number; stdout: string };
  counterJs?: string;
  echoTxt?: string;
  /** Outcome of `node broken.js` after the session. */
  brokenRun?: { code: number; stdout: string };
}

export interface CheckResult {
  id: number;
  name: string;
  points: number;
  max: number;
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  score: number;
  max: number;
  passed: boolean;
}

export const DOCTOR_THRESHOLD = 7;

/**
 * Smallest context window in which the doctor task can even start. Measured,
 * not guessed: the Claude Code harness sent 46075 tokens for THIS task (system
 * prompt + 5 allowed tools + the MCP fixture), verified live against LM Studio
 * on 2026-07-19. The rest is headroom for the model's own output.
 *
 * Below this the session dies before the model is ever asked anything, so a
 * score would measure the runtime's load parameters, not the model.
 */
export const DOCTOR_MIN_CONTEXT = 50_000;

export interface ContextPreflight {
  ok: boolean;
  detail: string;
}

/**
 * A window the runtime never reported is NOT a small window: hosted providers
 * publish no such number and must not be refused on silence.
 */
export function preflightContext(contextWindow: number | undefined): ContextPreflight {
  if (contextWindow === undefined) return { ok: true, detail: 'context window not declared by the provider' };
  if (contextWindow < DOCTOR_MIN_CONTEXT) {
    return {
      ok: false,
      detail:
        `the model serves ${String(contextWindow)} context tokens, the Claude Code harness needs at least ` +
        `${String(DOCTOR_MIN_CONTEXT)} (46075 measured live for this task). ` +
        'The session would fail before reaching the model: raise the window in the local runtime, then run again.',
    };
  }
  return { ok: true, detail: `context window ${String(contextWindow)} tokens` };
}

/**
 * Three outcomes, not two. "The provider refused the field" and "the provider
 * did not answer in time" lead to opposite actions, and collapsing them made
 * the doctor accuse a merely slow provider of rejecting `cache_control`, which
 * is certain to happen on local models. A 5xx is equally uninformative: it used
 * to be reported as ACCEPTED while the same line called it inconclusive.
 */
export type CacheControlOutcome = 'accepted' | 'rejected' | 'inconclusive';

export interface CacheControlProbe {
  /** 0 when no HTTP response arrived at all. */
  status: number;
  outcome: CacheControlOutcome;
  detail: string;
}

export function classifyCacheControl(
  result: { status: number; body: string } | { networkError: string },
): CacheControlProbe {
  if ('networkError' in result) {
    return {
      status: 0,
      outcome: 'inconclusive',
      detail: `no response from the provider: ${result.networkError}`,
    };
  }
  const { status, body } = result;
  if (status >= 200 && status < 300) {
    return { status, outcome: 'accepted', detail: 'the provider accepts cache_control' };
  }
  if (status >= 500) {
    return { status, outcome: 'inconclusive', detail: `provider error, inconclusive: ${body.slice(0, 160)}` };
  }
  return { status, outcome: 'rejected', detail: `rejected: ${body.slice(0, 160)}` };
}

export interface HeadlessResult {
  ok: boolean;
  resultText: string;
  costUsd?: number;
  /** Why the session did not really run. Absent when it did. */
  failure?: string;
  /**
   * The session died on the transport, never on the model's own output. A
   * score would be meaningless: it would measure the connection. Kept separate
   * from `failure` because a model too weak to finish IS a verdict, while a
   * provider that never answered is not.
   */
  neverRan?: boolean;
}

/** Terminal reasons that mean the provider, not the model, ended the session. */
const TRANSPORT_TERMINAL_REASONS = new Set(['api_error', 'auth_error']);

/**
 * Claude Code reports subtype "success" whenever its own loop ended cleanly,
 * including runs where every single request to the provider failed. Observed
 * live 2026-07-19: `{"subtype":"success","is_error":true,"num_turns":1,
 * "terminal_reason":"api_error"}` was scored as a completed session, turning an
 * infrastructure failure into a 1/10 that read as a verdict on the model.
 * is_error and terminal_reason are the fields that tell the truth.
 *
 * So the fields are read in the reverse of the order they read in: the name
 * `subtype` promises a verdict and only describes how Claude Code's own loop
 * exited, and it is consulted last. terminal_reason states the outcome on its
 * own, and the recorded capture carrying is_error too was luck, not a rule.
 */
export function interpretHeadlessResult(parsed: Record<string, unknown>): HeadlessResult {
  const resultText = typeof parsed['result'] === 'string' ? parsed['result'] : JSON.stringify(parsed).slice(0, 300);
  const costUsd = typeof parsed['total_cost_usd'] === 'number' ? parsed['total_cost_usd'] : undefined;
  const subtype = typeof parsed['subtype'] === 'string' ? parsed['subtype'] : '(absent)';
  const terminal = typeof parsed['terminal_reason'] === 'string' ? parsed['terminal_reason'] : undefined;
  const isError = parsed['is_error'] === true;

  const base = { resultText, ...(costUsd !== undefined ? { costUsd } : {}) };
  if (terminal !== undefined && TRANSPORT_TERMINAL_REASONS.has(terminal)) {
    return {
      ...base,
      ok: false,
      failure: `the session died on the transport (terminal_reason: ${terminal})`,
      neverRan: true,
    };
  }
  if (isError) {
    return {
      ...base,
      ok: false,
      failure: `the session ended in error (terminal_reason: ${terminal ?? 'not declared'})`,
    };
  }
  if (subtype !== 'success') {
    return { ...base, ok: false, failure: `session closed with subtype "${subtype}"` };
  }
  return { ...base, ok: true };
}

export function scoreDoctor(obs: DoctorObservations): DoctorReport {
  const checks: CheckResult[] = [];

  // 1. Basic answer (1): the session reaches the end and produces text
  checks.push(
    obs.sessionCompleted && obs.resultText.trim() !== ''
      ? { id: 1, name: 'Basic answer', points: 1, max: 1, detail: 'session completed' }
      : { id: 1, name: 'Basic answer', points: 0, max: 1, detail: 'session not completed, or empty' },
  );

  // 2. Read + comprehension (1): the token read from notes.txt lands in found.txt
  const found = (obs.foundTxt ?? '').trim();
  checks.push(
    found.includes(MAGIC_TOKEN)
      ? { id: 2, name: 'Read + comprehension', points: 1, max: 1, detail: 'token found in found.txt' }
      : { id: 2, name: 'Read + comprehension', points: 0, max: 1, detail: `found.txt: "${found.slice(0, 60)}"` },
  );

  // 3. Edit exact-match (3): greet.js edited AND still runnable
  const greet = obs.greetJs ?? '';
  const greetEdited = greet.includes('"Ciao, "') && !greet.includes('"Hello, "');
  const greetRuns = obs.greetRun !== undefined && obs.greetRun.code === 0 && obs.greetRun.stdout.includes('Ciao, world');
  checks.push(
    greetEdited && greetRuns
      ? { id: 3, name: 'Edit exact-match', points: 3, max: 3, detail: 'greet.js edited and runnable' }
      : greetEdited
        ? { id: 3, name: 'Edit exact-match', points: 1, max: 3, detail: 'edited but it does not run correctly' }
        : { id: 3, name: 'Edit exact-match', points: 0, max: 3, detail: 'greet.js not edited' },
  );

  // 4. Multiple edits in sequence (2): both constants updated
  const counter = obs.counterJs ?? '';
  const startOk = /const START = 10;/.test(counter);
  const stepOk = /const STEP = 5;/.test(counter);
  checks.push(
    startOk && stepOk
      ? { id: 4, name: 'Edits in sequence', points: 2, max: 2, detail: 'START and STEP updated' }
      : startOk || stepOk
        ? { id: 4, name: 'Edits in sequence', points: 1, max: 2, detail: 'only one edit landed' }
        : { id: 4, name: 'Edits in sequence', points: 0, max: 2, detail: 'counter.js not edited' },
  );

  // 5. MCP tool (2): the echo tool's exact output in echo.txt
  const echo = (obs.echoTxt ?? '').trim();
  checks.push(
    echo.includes('echo:doctor-ping')
      ? { id: 5, name: 'MCP tool', points: 2, max: 2, detail: 'mcp__lupin_doctor__echo_test called' }
      : { id: 5, name: 'MCP tool', points: 0, max: 2, detail: `echo.txt: "${echo.slice(0, 60)}"` },
  );

  // 6. Multi-step task with verification (1): broken.js fixed AND printing A B C
  const fixedRuns =
    obs.brokenRun?.code === 0 &&
    obs.brokenRun.stdout.includes('A') &&
    obs.brokenRun.stdout.includes('C') &&
    !obs.brokenRun.stdout.includes('undefined');
  checks.push(
    fixedRuns
      ? { id: 6, name: 'Multi-step with check', points: 1, max: 1, detail: 'bug fixed, script green' }
      : { id: 6, name: 'Multi-step with check', points: 0, max: 1, detail: 'broken.js still broken' },
  );

  const score = checks.reduce((s, ch) => s + ch.points, 0);
  const max = checks.reduce((s, ch) => s + ch.max, 0);
  return { checks, score, max, passed: score >= DOCTOR_THRESHOLD };
}
