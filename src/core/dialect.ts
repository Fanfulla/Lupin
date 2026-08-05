// Model dialect normalization (SPEC-TRANSLATION §5bis).
//
// A provider can be protocol-correct and still hand us garbage *inside* the
// content: reasoning wrapped in <think> tags, tool calls the server never
// parsed into tool_calls[], leaked special tokens. This module turns that raw
// text into structured segments.
//
// ONE implementation feeds both paths: the non-streaming mapper calls
// push()+flush() on the whole string, the SSE translator calls push() per
// delta. That is deliberate: the competitor bug pattern we are avoiding is a
// normalization that behaves differently when streamed (CCR #1397: reasoning
// transformer corrupts tool-call argument deltas; #1356: interleaved
// text/tool_call breaks content blocks).
//
// Streaming correctness rests on the hold-back rule: text whose tail could
// still grow into a marker is never emitted, so a marker split across chunks
// ("<to" + "ol_call>") is recognized exactly like a whole one.

import type { QuirkName } from './quirks.js';

export type DialectSegment =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; id: string; name: string; arguments: string };

/** A parsed call as it sits in the raw text: arguments stay a JSON string, same as OpenAI. */
interface ParsedCall {
  name: string;
  arguments: string;
}

type Rule =
  | { quirk: QuirkName; kind: 'strip'; open: string }
  | { quirk: QuirkName; kind: 'thinking'; open: string; close: string }
  | {
      quirk: QuirkName;
      kind: 'toolCall';
      open: string;
      close: string;
      parse: (payload: string) => ParsedCall[] | null;
    };

type RegionRule = Extract<Rule, { kind: 'thinking' | 'toolCall' }>;

// --- payload parsers -------------------------------------------------------

/** `{"name": "x", "arguments": {...}}`: Hermes/Qwen family and most local templates. */
function parseNameArgumentsJson(payload: string): ParsedCall[] | null {
  const obj = looseParse(payload);
  if (obj === undefined) return null;
  const call = callFromObject(obj);
  return call === undefined ? null : [call];
}

/**
 * `<tool_call>` is spelled the same by Qwen and GLM but filled differently:
 * Qwen puts a JSON envelope inside, GLM puts the bare function name followed by
 * <arg_key>/<arg_value> pairs (verified against the GLM-4.5→5.2 chat templates -
 * there is genuinely no {"name":…} envelope). One marker, two payloads.
 */
function parseToolCallBody(payload: string): ParsedCall[] | null {
  return parseNameArgumentsJson(payload) ?? parseGlmArgPairs(payload);
}

const ARG_PAIR = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

function parseGlmArgPairs(payload: string): ParsedCall[] | null {
  const firstTag = payload.indexOf('<arg_key>');
  // GLM 4.5/4.6 put a newline after the name, 4.7+ put nothing: trim covers both.
  const name = (firstTag === -1 ? payload : payload.slice(0, firstTag)).trim();
  if (name === '' || /\s/.test(name)) return null;
  const args: Record<string, unknown> = {};
  ARG_PAIR.lastIndex = 0;
  for (let m = ARG_PAIR.exec(payload); m !== null; m = ARG_PAIR.exec(payload)) {
    const key = m[1]?.trim();
    const raw = m[2]?.trim() ?? '';
    if (key === undefined || key === '') continue;
    args[key] = coerceScalar(raw);
  }
  return [{ name, arguments: JSON.stringify(args) }];
}

/**
 * Qwen3-Coder: `<function=NAME>` with `<parameter=NAME>` blocks whose values are
 * RAW TEXT, not JSON: one leading and one trailing newline are structural and
 * get stripped, everything else is the value verbatim.
 */
const QWEN_PARAM = /<parameter=([^>]*)>\n?([\s\S]*?)\n?<\/parameter>/g;

function parseQwenCoderFunction(payload: string): ParsedCall[] | null {
  const close = payload.indexOf('>');
  if (close === -1) return null;
  const name = payload.slice(0, close).trim();
  if (name === '') return null;
  const body = payload.slice(close + 1);
  const args: Record<string, unknown> = {};
  QWEN_PARAM.lastIndex = 0;
  for (let m = QWEN_PARAM.exec(body); m !== null; m = QWEN_PARAM.exec(body)) {
    const key = m[1]?.trim();
    if (key === undefined || key === '') continue;
    args[key] = coerceScalar(m[2] ?? '');
  }
  return [{ name, arguments: JSON.stringify(args) }];
}

/**
 * Untyped values from the XML-ish dialects. The tool schema is the real
 * authority on types, but it does not reach this layer; JSON-shaped values and
 * the obvious scalars are recovered, everything else stays a string.
 */
function coerceScalar(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d*\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith('{') || raw.startsWith('[')) {
    const parsed = looseParse(raw);
    if (parsed !== undefined) return parsed;
  }
  return raw;
}

/**
 * DeepSeek batches calls between fullwidth-pipe markers (U+FF5C) with U+2581
 * word separators. Inside: `function<｜tool▁sep｜>NAME\n```json\n{…}\n````.
 */
const DEEPSEEK_CALL = /<｜tool▁call▁begin｜>([\s\S]*?)(?:<｜tool▁call▁end｜>|$)/g;

function parseDeepSeekBatch(payload: string): ParsedCall[] | null {
  const calls: ParsedCall[] = [];
  DEEPSEEK_CALL.lastIndex = 0;
  for (let m = DEEPSEEK_CALL.exec(payload); m !== null; m = DEEPSEEK_CALL.exec(payload)) {
    const inner = m[1] ?? '';
    const sep = inner.indexOf('<｜tool▁sep｜>');
    if (sep === -1) continue;
    const rest = inner.slice(sep + '<｜tool▁sep｜>'.length);
    const nl = rest.indexOf('\n');
    const name = (nl === -1 ? rest : rest.slice(0, nl)).trim();
    if (name === '') continue;
    const args = nl === -1 ? '{}' : (JSON.stringify(looseParse(rest.slice(nl)) ?? {}) ?? '{}');
    calls.push({ name, arguments: args });
  }
  return calls.length > 0 ? calls : null;
}

/**
 * Kimi K2: `<|tool_call_begin|>functions.NAME:INDEX<|tool_call_argument_begin|>{…}<|tool_call_end|>`,
 * ASCII pipes (verified: no fullwidth pipe anywhere in the Kimi code paths).
 */
const KIMI_CALL = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_argument_begin\|>([\s\S]*?)(?:<\|tool_call_end\|>|$)/g;

function parseKimiSection(payload: string): ParsedCall[] | null {
  const calls: ParsedCall[] = [];
  KIMI_CALL.lastIndex = 0;
  for (let m = KIMI_CALL.exec(payload); m !== null; m = KIMI_CALL.exec(payload)) {
    // `functions.Read:0` → the tool is the middle segment.
    const id = (m[1] ?? '').trim();
    const name = (id.split(':')[0] ?? id).replace(/^functions\./, '').trim();
    if (name === '') continue;
    calls.push({ name, arguments: JSON.stringify(looseParse(m[2] ?? '') ?? {}) });
  }
  return calls.length > 0 ? calls : null;
}

/**
 * Mistral has two shapes across tokenizer versions: the older `[TOOL_CALLS]`
 * followed by a JSON array, and the v13 grammar `[TOOL_CALLS]NAME[ARGS]{…}`.
 */
function parseMistralCalls(payload: string): ParsedCall[] | null {
  const argsAt = payload.indexOf('[ARGS]');
  if (argsAt !== -1) {
    const name = payload.slice(0, argsAt).trim();
    if (name === '') return null;
    return [{ name, arguments: JSON.stringify(looseParse(payload.slice(argsAt + '[ARGS]'.length)) ?? {}) }];
  }
  return parseCallArray(payload);
}

/** `[{"name": ...}, ...]` or a single object: Mistral's [TOOL_CALLS] payload. */
function parseCallArray(payload: string): ParsedCall[] | null {
  const parsed = looseParse(payload);
  if (parsed === undefined) return null;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const calls: ParsedCall[] = [];
  for (const item of items) {
    const call = callFromObject(item);
    if (call === undefined) return null;
    calls.push(call);
  }
  return calls.length > 0 ? calls : null;
}

/** Accepts both `arguments` and `parameters` (Llama-style templates use the latter). */
function callFromObject(value: unknown): ParsedCall | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  const name = rec['name'];
  if (typeof name !== 'string' || name === '') return undefined;
  const rawArgs = rec['arguments'] ?? rec['parameters'] ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  return { name, arguments: args };
}

// --- rule table ------------------------------------------------------------
//
// Literals are data, not logic: every entry is a documented dialect with a
// verification date in SPEC-TRANSLATION §5bis. Adding a model family means
// adding a row here, never a branch elsewhere (CLAUDE.md rule 4).

const RULES: Rule[] = [
  // Thinking: <think> is the near-universal spelling (DeepSeek R1 distills,
  // Qwen, and the local re-exports of both).
  { quirk: 'stripThinkTags', kind: 'thinking', open: '<think>', close: '</think>' },
  { quirk: 'stripThinkTags', kind: 'thinking', open: '<thinking>', close: '</thinking>' },
  // Orphan closing tags: some templates pre-fill the opener in the prompt, so
  // the model emits only the close. Classifying the text before it as thinking
  // would need unbounded lookahead: impossible while streaming without
  // holding the whole message, which is the one cost a proxy must not pay. We
  // strip the stray marker and leave the text alone; the structured
  // reasoning_content path (§4) is what actually recovers those models.
  { quirk: 'stripThinkTags', kind: 'strip', open: '</think>' },
  { quirk: 'stripThinkTags', kind: 'strip', open: '</thinking>' },
  // Kimi K2 marks reasoning with the same ASCII spelling; the VL branch uses
  // triangle brackets U+25C1/U+25B7 instead.
  { quirk: 'stripThinkTags', kind: 'thinking', open: '◁think▷', close: '◁/think▷' },
  // Harmony (GPT-OSS): analysis channel is reasoning, final channel is the
  // answer, and the final channel closes with <|return|>, not <|end|>.
  { quirk: 'harmonyChannels', kind: 'thinking', open: '<|channel|>analysis<|message|>', close: '<|end|>' },
  { quirk: 'harmonyChannels', kind: 'strip', open: '<|channel|>final<|message|>' },
  { quirk: 'harmonyChannels', kind: 'strip', open: '<|start|>assistant' },
  { quirk: 'harmonyChannels', kind: 'strip', open: '<|return|>' },
  // Textual tool calls, longest marker first where prefixes overlap.
  {
    quirk: 'parseTextToolCalls',
    kind: 'toolCall',
    open: '<｜tool▁calls▁begin｜>',
    close: '<｜tool▁calls▁end｜>',
    parse: parseDeepSeekBatch,
  },
  {
    quirk: 'parseTextToolCalls',
    kind: 'toolCall',
    open: '<|tool_calls_section_begin|>',
    close: '<|tool_calls_section_end|>',
    parse: parseKimiSection,
  },
  {
    quirk: 'parseTextToolCalls',
    kind: 'toolCall',
    open: '<tool_call>',
    close: '</tool_call>',
    parse: parseToolCallBody,
  },
  {
    quirk: 'parseTextToolCalls',
    kind: 'toolCall',
    open: '<function=',
    close: '</function>',
    parse: parseQwenCoderFunction,
  },
  // No closing marker in the Mistral grammar: </s> or end of message ends it,
  // and flush() recovers the call either way.
  { quirk: 'parseTextToolCalls', kind: 'toolCall', open: '[TOOL_CALLS]', close: '</s>', parse: parseMistralCalls },
  {
    quirk: 'parseTextToolCalls',
    kind: 'toolCall',
    open: '<|python_tag|>',
    close: '<|eom_id|>',
    parse: parseNameArgumentsJson,
  },
  // Leaked special tokens: plain removal, no payload. The FIM family and the
  // think tags are declared special:false in the Qwen vocab, so a correct
  // server does NOT strip them: they are the ones that actually leak.
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|im_end|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|im_start|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|eot_id|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|eom_id|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|end_of_text|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|endoftext|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|fim_prefix|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|fim_middle|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|fim_suffix|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|fim_pad|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|repo_name|>' },
  { quirk: 'stripSpecialTokens', kind: 'strip', open: '<|file_sep|>' },
];

export interface DialectOptions {
  quirks?: readonly string[];
  /** parseTextToolCalls only fires when the request actually offered tools. */
  hasTools?: boolean;
  /** Prefix for synthetic ids; the counter keeps them unique inside a message. */
  idPrefix?: string;
}

/**
 * Stateful, chunk-safe normalizer. Feed text with push(), then flush() once the
 * message is over. Every quirk that fired is listed in `applied`: the doctor
 * reports it, because "works, but only thanks to parseTextToolCalls" is a very
 * different verdict from "works" (§5bis rule 3).
 */
export class DialectNormalizer {
  private buffer = '';
  private region: RegionRule | null = null;
  private counter = 0;
  private readonly rules: Rule[];
  private readonly idPrefix: string;
  private readonly fired = new Set<QuirkName>();

  constructor(opts: DialectOptions = {}) {
    const quirks = new Set(opts.quirks ?? []);
    this.rules = RULES.filter((r) => {
      if (!quirks.has(r.quirk)) return false;
      if (r.kind === 'toolCall' && opts.hasTools !== true) return false;
      return true;
    });
    this.idPrefix = opts.idPrefix ?? 'toolu_lupin';
  }

  /** Quirks that actually fired: diagnostic signal, not control flow. */
  get applied(): QuirkName[] {
    return [...this.fired];
  }

  /** True when no rule is active: callers can then skip the scan entirely. */
  get inert(): boolean {
    return this.rules.length === 0;
  }

  push(chunk: string): DialectSegment[] {
    if (this.inert) return chunk === '' ? [] : [{ kind: 'text', text: chunk }];
    this.buffer += chunk;
    const out: DialectSegment[] = [];
    this.scan(out);
    return out;
  }

  /** End of message: emit whatever is still held, never swallow it silently. */
  flush(): DialectSegment[] {
    const out: DialectSegment[] = [];
    const rule = this.region;
    if (rule !== null) {
      const payload = this.buffer;
      this.region = null;
      this.buffer = '';
      if (rule.kind === 'thinking') {
        if (payload !== '') out.push({ kind: 'thinking', text: payload });
        return out;
      }
      // Unterminated tool call: models drop the closing marker often enough
      // that a lenient parse is worth trying before falling back to text.
      const calls = rule.parse(payload);
      if (calls !== null) this.emitCalls(rule, calls, out);
      else out.push({ kind: 'text', text: rule.open + payload });
      return out;
    }
    if (this.buffer !== '') {
      out.push({ kind: 'text', text: this.buffer });
      this.buffer = '';
    }
    return out;
  }

  private scan(out: DialectSegment[]): void {
    for (;;) {
      const region = this.region;
      if (region !== null) {
        const end = this.buffer.indexOf(region.close);
        if (end === -1) return; // whole region held until it closes
        const payload = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + region.close.length);
        this.region = null;
        this.fired.add(region.quirk);
        if (region.kind === 'thinking') {
          if (payload !== '') out.push({ kind: 'thinking', text: payload });
        } else {
          const calls = region.parse(payload);
          if (calls !== null) this.emitCalls(region, calls, out);
          else out.push({ kind: 'text', text: region.open + payload + region.close });
        }
        continue;
      }

      const hit = this.firstMarker();
      if (hit === undefined) {
        const hold = this.heldSuffixLength();
        const safe = this.buffer.length - hold;
        if (safe > 0) {
          out.push({ kind: 'text', text: this.buffer.slice(0, safe) });
          this.buffer = this.buffer.slice(safe);
        }
        return;
      }

      if (hit.index > 0) out.push({ kind: 'text', text: this.buffer.slice(0, hit.index) });
      this.buffer = this.buffer.slice(hit.index + hit.rule.open.length);
      if (hit.rule.kind === 'strip') {
        this.fired.add(hit.rule.quirk);
        continue;
      }
      this.region = hit.rule;
    }
  }

  /** Earliest open marker in the buffer; ties go to the longer marker. */
  private firstMarker(): { rule: Rule; index: number } | undefined {
    let best: { rule: Rule; index: number } | undefined;
    for (const rule of this.rules) {
      const at = this.buffer.indexOf(rule.open);
      if (at === -1) continue;
      if (best === undefined || at < best.index || (at === best.index && rule.open.length > best.rule.open.length)) {
        best = { rule, index: at };
      }
    }
    return best;
  }

  /** Longest tail of the buffer that is a proper prefix of a marker we still watch. */
  private heldSuffixLength(): number {
    const markers = this.rules.map((r) => r.open);
    const longest = markers.reduce((max, m) => Math.max(max, m.length), 0);
    const max = Math.min(longest - 1, this.buffer.length);
    for (let len = max; len > 0; len--) {
      const tail = this.buffer.slice(this.buffer.length - len);
      for (const marker of markers) {
        if (marker.length > len && marker.startsWith(tail)) return len;
      }
    }
    return 0;
  }

  private emitCalls(rule: Rule, calls: ParsedCall[], out: DialectSegment[]): void {
    this.fired.add(rule.quirk);
    for (const call of calls) {
      out.push({
        kind: 'toolCall',
        id: `${this.idPrefix}_${String(this.counter++)}`,
        name: call.name,
        arguments: call.arguments,
      });
    }
  }
}

// --- looseJsonArguments ----------------------------------------------------

/**
 * Strict JSON first; the repair path runs only on failure (§5bis: never mask a
 * provider that is actually fine). Handles the failure modes seen in the wild:
 * markdown fences, single quotes, trailing commas, unterminated objects.
 */
export function looseParse(raw: string): unknown | undefined {
  const text = raw.trim();
  if (text === '') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to repair */
  }
  const repaired = repairJson(text);
  if (repaired === undefined) return undefined;
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

function repairJson(input: string): string | undefined {
  let text = input;
  // ```json … ``` fences around the payload
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1];
  // Trim anything before the first brace/bracket: prose preambles are common.
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;
  text = text.slice(start);

  let out = '';
  const stack: string[] = [];
  let inString = false;
  let quote = '"';
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === quote) {
        inString = false;
        out += '"';
        continue;
      }
      // A raw double quote inside a single-quoted string must be escaped.
      out += ch === '"' ? '\\"' : ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += '"';
      continue;
    }
    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
    if (ch === '}' || ch === ']') stack.pop();
    out += ch;
  }
  if (inString) out += '"';
  // Trailing commas before a close, or left dangling by truncation.
  out = out.replace(/,\s*(?=[}\]])/g, '').replace(/,\s*$/, '');
  while (stack.length > 0) out += stack.pop();
  return out;
}
