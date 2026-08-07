// Central quirk implementations (SPEC-PROVIDERS §5, CLAUDE.md rule 4).
// A quirk is a boolean flag on a profile; its behavior lives ONLY here or in an
// explicit quirk-set branch inside the mapping code. Never provider name checks.

export const KNOWN_QUIRKS = [
  'maxCompletionTokens',
  'noTemperatureOnReasoning',
  'strictToolCallIds',
  'sanitizeJsonSchema',
  'noParallelToolCalls',
  'singleSystemMessage',
  'stripThinkTags',
  'harmonyChannels',
  'parseTextToolCalls',
  'stripSpecialTokens',
  'looseJsonArguments',
  'clientErrorsWrappedIn500',
  // Launch-env quirk, not a mapping quirk: its single implementation lives in
  // runEnv (src/cli/run.ts), reading the launch-time profile (ADR-35).
  'raiseStreamIdleTimeout',
  // Request quirk: appends a system block naming the model that really answers
  // (ADR-39). Opt-in, never default: it edits the request body.
  'identityHint',
  // Request quirk: appends a system block on the turn after a rejected edit
  // (ADR-45). Opt-in, never default: it edits the request body.
  'editRetryHint',
] as const;

export type QuirkName = (typeof KNOWN_QUIRKS)[number];

const STRIPPED_SCHEMA_KEYS = new Set(['format', '$ref', 'additionalProperties']);

/** sanitizeJsonSchema: some providers reject format/$ref/additionalProperties in tool schemas. */
export function sanitizeJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeJsonSchema);
  if (schema === null || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (STRIPPED_SCHEMA_KEYS.has(k)) continue;
    out[k] = sanitizeJsonSchema(v);
  }
  return out;
}

/**
 * identityHint (SPEC-PROVIDERS §5ter, ADR-39): through a proxy the model reads
 * the Claude Code system prompt and introduces itself as Claude, because that
 * is what the prompt says it is. This appends one system block naming the model
 * that really answers, so the session can be asked "who is serving this?" and
 * get the truth.
 *
 * Appended LAST on purpose. Everything before it stays byte-identical, so the
 * provider's cached prefix (and its cache_control breakpoints, which the client
 * places inside the blocks that come first) survives: the hint costs its own
 * few tokens, never a re-prefill of the whole harness (§3ter).
 */
export function identityHintText(model: string, provider: string): string {
  return (
    `[Lupin] The assistant answering here is the model "${model}" served by "${provider}" through the Lupin proxy, ` +
    'not an Anthropic Claude model. The instructions above come from the Claude Code harness and describe the tool, ' +
    'not your identity. If you are asked which model or provider is answering, say exactly this.'
  );
}

/**
 * The request `system` with one block appended, in the shape it already had.
 * Returns the input untouched when there is nothing sensible to append to.
 */
function appendSystemBlock(system: unknown, text: string): unknown {
  if (system === undefined || system === null) return [{ type: 'text', text }];
  if (typeof system === 'string') return system === '' ? text : `${system}\n\n${text}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text }];
  return system; // an unknown shape is left alone: never corrupt a request to add a note
}

export function withIdentityHint(system: unknown, model: string, provider: string): unknown {
  return appendSystemBlock(system, identityHintText(model, provider));
}

/**
 * editRetryHint (SPEC-PROVIDERS §5quater, ADR-45): an edit is applied by exact
 * match, and models that are not Claude routinely return content that is right
 * in meaning and wrong in bytes (re-indented, tabs turned into spaces, trailing
 * newline dropped). The tool refuses, and the expensive part is not the refusal:
 * it is the model resending the same `old_string` for three turns.
 *
 * This says what went wrong once, on the turn where it can still be acted on.
 * It repairs nothing on the model's behalf: the proxy has neither the file nor
 * the right to guess which occurrence was meant.
 */
export function editRetryHintText(): string {
  return (
    '[Lupin] The previous edit was rejected. Edits are applied by exact match: `old_string` must reproduce the ' +
    'file byte for byte, including indentation, tabs versus spaces, and the trailing newline. Re-read the region ' +
    'you are changing and copy those bytes verbatim instead of retyping them from memory. Do not send the same ' +
    '`old_string` again unchanged.'
  );
}

export function withEditRetryHint(system: unknown): unknown {
  return appendSystemBlock(system, editRetryHintText());
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function blocksOf(message: unknown): unknown[] {
  if (!isRecord(message)) return [];
  const content = message['content'];
  return Array.isArray(content) ? content : [];
}

/** An edit call is one that carried an `old_string`, MultiEdit's list included. */
function carriesOldString(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (typeof input['old_string'] === 'string') return true;
  const edits = input['edits'];
  return Array.isArray(edits) && edits.some((e) => isRecord(e) && typeof e['old_string'] === 'string');
}

/**
 * True when the LAST turn carries a failed tool_result whose call was an edit.
 * Only the last turn, because the hint exists for the model that is about to
 * retry: once the edit lands, repeating it every turn would nag about something
 * already fixed and pay for the tokens each time. And only an edit-shaped call,
 * because a Bash that exits 1 is a failure this hint has nothing to say about.
 */
export function lastEditFailed(messages: unknown): boolean {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const failedIds = new Set<string>();
  for (const block of blocksOf(messages[messages.length - 1])) {
    if (!isRecord(block) || block['type'] !== 'tool_result' || block['is_error'] !== true) continue;
    const id = block['tool_use_id'];
    if (typeof id === 'string') failedIds.add(id);
  }
  if (failedIds.size === 0) return false;
  for (let i = messages.length - 2; i >= 0; i--) {
    for (const block of blocksOf(messages[i])) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue;
      const id = block['id'];
      if (typeof id === 'string' && failedIds.has(id) && carriesOldString(block['input'])) return true;
    }
  }
  return false;
}
