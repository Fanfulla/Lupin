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
 * The request `system` with the hint appended, in the shape it already had.
 * Returns the input untouched when there is nothing sensible to append to.
 */
export function withIdentityHint(system: unknown, model: string, provider: string): unknown {
  const hint = identityHintText(model, provider);
  if (system === undefined || system === null) return [{ type: 'text', text: hint }];
  if (typeof system === 'string') return system === '' ? hint : `${system}\n\n${hint}`;
  if (Array.isArray(system)) return [...system, { type: 'text', text: hint }];
  return system; // an unknown shape is left alone: never corrupt a request to add a note
}
