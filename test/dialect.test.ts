import { describe, expect, it } from 'vitest';
import { DialectNormalizer, looseParse, type DialectSegment } from '../src/core/dialect.js';

const ALL = ['stripThinkTags', 'parseTextToolCalls', 'stripSpecialTokens', 'harmonyChannels'];

/** Whole string in one push, then flush — the non-streaming path. */
function whole(input: string, quirks: readonly string[] = ALL, hasTools = true): DialectSegment[] {
  const n = new DialectNormalizer({ quirks, hasTools });
  return [...n.push(input), ...n.flush()];
}

/** One character per push — the worst case a provider can hand the SSE path. */
function charByChar(input: string, quirks: readonly string[] = ALL, hasTools = true): DialectSegment[] {
  const n = new DialectNormalizer({ quirks, hasTools });
  const out: DialectSegment[] = [];
  for (const ch of input) out.push(...n.push(ch));
  out.push(...n.flush());
  return out;
}

/** Adjacent text segments differ only by chunking: merge before comparing. */
function coalesce(segments: DialectSegment[]): DialectSegment[] {
  const out: DialectSegment[] = [];
  for (const seg of segments) {
    const prev = out[out.length - 1];
    if (seg.kind !== 'text' || prev?.kind !== 'text') {
      out.push(seg);
      continue;
    }
    out[out.length - 1] = { kind: 'text', text: prev.text + seg.text };
  }
  return out;
}

describe('DialectNormalizer (SPEC-TRANSLATION §5bis)', () => {
  it('passes text through untouched when no quirk is active', () => {
    expect(whole('plain <think> text </think> here', [])).toEqual([
      { kind: 'text', text: 'plain <think> text </think> here' },
    ]);
  });

  it('stripThinkTags: reasoning becomes a thinking segment, answer stays text', () => {
    expect(coalesce(whole('<think>weighing options</think>The answer is 4.'))).toEqual([
      { kind: 'thinking', text: 'weighing options' },
      { kind: 'text', text: 'The answer is 4.' },
    ]);
  });

  // Templates that pre-fill the opener leave an orphan close. Reclassifying the
  // text before it would need unbounded lookahead, so we only drop the marker —
  // the honest limit, identical streamed or not.
  it('stripThinkTags: an orphan closing tag is dropped, surrounding text kept', () => {
    expect(coalesce(whole('reasoned silently</think>Done.'))).toEqual([
      { kind: 'text', text: 'reasoned silentlyDone.' },
    ]);
  });

  it('parseTextToolCalls: a textual call becomes a structured tool call', () => {
    expect(whole('<tool_call>{"name": "Read", "arguments": {"path": "a.ts"}}</tool_call>')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"path":"a.ts"}' },
    ]);
  });

  it('parseTextToolCalls: text before and after a call is preserved in order', () => {
    expect(coalesce(whole('Let me look.<tool_call>{"name":"Read","arguments":{}}</tool_call>Found it.'))).toEqual([
      { kind: 'text', text: 'Let me look.' },
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{}' },
      { kind: 'text', text: 'Found it.' },
    ]);
  });

  it('parseTextToolCalls: Mistral pre-v11 emits an array, each entry gets its own id', () => {
    expect(whole('[TOOL_CALLS][{"name":"A","arguments":{}},{"name":"B","arguments":{"x":1}}]')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'A', arguments: '{}' },
      { kind: 'toolCall', id: 'toolu_lupin_1', name: 'B', arguments: '{"x":1}' },
    ]);
  });

  it('parseTextToolCalls: Mistral v13 grammar puts the name before [ARGS]', () => {
    expect(whole('[TOOL_CALLS]Read[ARGS]{"file_path":"a.ts"}')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ]);
  });

  // GLM reuses <tool_call> with a completely different body: bare name plus
  // arg_key/arg_value pairs, no JSON envelope (verified on the 4.5→5.2 templates).
  it('parseTextToolCalls: GLM arg_key/arg_value pairs inside the same marker', () => {
    expect(whole('<tool_call>Read\n<arg_key>file_path</arg_key><arg_value>src/a.ts</arg_value></tool_call>')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"file_path":"src/a.ts"}' },
    ]);
  });

  it('parseTextToolCalls: GLM 4.7+ drops the newline after the name', () => {
    expect(whole('<tool_call>Bash<arg_key>timeout</arg_key><arg_value>30</arg_value></tool_call>')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Bash', arguments: '{"timeout":30}' },
    ]);
  });

  // Qwen3-Coder: values are raw text, and exactly one newline on each side is
  // structural rather than content.
  it('parseTextToolCalls: Qwen3-Coder function/parameter blocks with raw values', () => {
    const raw = '<function=Write>\n<parameter=file_path>\nsrc/a.ts\n</parameter>\n<parameter=content>\nline one\nline two\n</parameter>\n</function>';
    expect(whole(raw)).toEqual([
      {
        kind: 'toolCall',
        id: 'toolu_lupin_0',
        name: 'Write',
        arguments: '{"file_path":"src/a.ts","content":"line one\\nline two"}',
      },
    ]);
  });

  it('parseTextToolCalls: DeepSeek fullwidth-pipe batch with a fenced JSON payload', () => {
    const raw =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Read\n```json\n{"file_path":"a.ts"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    expect(whole(raw)).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ]);
  });

  it('parseTextToolCalls: Kimi section, name taken from functions.NAME:index', () => {
    const raw =
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"file_path":"a.ts"}<|tool_call_end|><|tool_calls_section_end|>';
    expect(whole(raw)).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"file_path":"a.ts"}' },
    ]);
  });

  it('stripThinkTags: the Kimi VL branch spells the tag with triangle brackets', () => {
    expect(coalesce(whole('◁think▷pondering◁/think▷Answer.'))).toEqual([
      { kind: 'thinking', text: 'pondering' },
      { kind: 'text', text: 'Answer.' },
    ]);
  });

  it('stripSpecialTokens: the FIM family leaks because it is declared non-special', () => {
    expect(coalesce(whole('code<|fim_middle|>more<|file_sep|>'))).toEqual([{ kind: 'text', text: 'codemore' }]);
  });

  it('parseTextToolCalls: Llama templates spell the payload with "parameters"', () => {
    expect(whole('<|python_tag|>{"name":"Bash","parameters":{"cmd":"ls"}}<|eom_id|>')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Bash', arguments: '{"cmd":"ls"}' },
    ]);
  });

  it('parseTextToolCalls stays off when the request offered no tools', () => {
    const raw = '<tool_call>{"name":"Read","arguments":{}}</tool_call>';
    expect(whole(raw, ALL, false)).toEqual([{ kind: 'text', text: raw }]);
  });

  it('stripSpecialTokens: leaked end-of-turn markers vanish from the text', () => {
    expect(coalesce(whole('answer<|im_end|>'))).toEqual([{ kind: 'text', text: 'answer' }]);
  });

  it('harmonyChannels: the analysis channel is reasoning, the final channel is the answer', () => {
    const raw = '<|channel|>analysis<|message|>scratch work<|end|><|channel|>final<|message|>Result: 7';
    expect(coalesce(whole(raw))).toEqual([
      { kind: 'thinking', text: 'scratch work' },
      { kind: 'text', text: 'Result: 7' },
    ]);
  });

  it('an unterminated tool call is still recovered at flush', () => {
    expect(whole('<tool_call>{"name":"Read","arguments":{"path":"a.ts"}}')).toEqual([
      { kind: 'toolCall', id: 'toolu_lupin_0', name: 'Read', arguments: '{"path":"a.ts"}' },
    ]);
  });

  it('an unparseable region is surfaced as text, never swallowed', () => {
    const raw = '<tool_call>not json at all</tool_call>';
    expect(coalesce(whole(raw))).toEqual([{ kind: 'text', text: raw }]);
  });

  it('reports which quirks actually fired, and stays quiet when none did', () => {
    const fired = new DialectNormalizer({ quirks: ALL, hasTools: true });
    fired.push('<think>x</think>hi<|im_end|>');
    fired.flush();
    expect(fired.applied.sort()).toEqual(['stripSpecialTokens', 'stripThinkTags']);

    const quiet = new DialectNormalizer({ quirks: ALL, hasTools: true });
    quiet.push('a normal answer');
    quiet.flush();
    expect(quiet.applied).toEqual([]);
  });

  // The invariant that matters: a normalization that behaves differently when
  // streamed is the exact competitor failure we exist to avoid (CCR #1397).
  it.each([
    ['thinking then answer', '<think>slow reasoning</think>Final answer.'],
    ['orphan close tag', 'reasoned</think>Final.'],
    ['tool call between text', 'before<tool_call>{"name":"Read","arguments":{"p":"x"}}</tool_call>after'],
    ['two mistral calls', '[TOOL_CALLS][{"name":"A","arguments":{}},{"name":"B","arguments":{}}]'],
    ['glm arg pairs', 'ok<tool_call>Read<arg_key>p</arg_key><arg_value>a.ts</arg_value></tool_call>'],
    ['qwen coder params', '<function=Read>\n<parameter=p>\na.ts\n</parameter>\n</function>done'],
    [
      'deepseek batch',
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Read\n```json\n{"p":"a"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    ],
    [
      'kimi section',
      '<|tool_calls_section_begin|><|tool_call_begin|>functions.Read:0<|tool_call_argument_begin|>{"p":"a"}<|tool_call_end|><|tool_calls_section_end|>',
    ],
    ['kimi vl thinking', '◁think▷x◁/think▷y'],
    ['harmony channels', '<|channel|>analysis<|message|>think<|end|><|channel|>final<|message|>done'],
    ['leaked tokens', 'text<|im_end|>more<|eot_id|>'],
    ['no markers at all', 'a plain answer with < and | characters'],
    ['marker-like text that never completes', 'trailing <tool_ca'],
  ])('streaming equals non-streaming: %s', (_name, input) => {
    expect(coalesce(charByChar(input))).toEqual(coalesce(whole(input)));
  });

  it('holds back a partial marker instead of leaking it as text', () => {
    const n = new DialectNormalizer({ quirks: ALL, hasTools: true });
    expect(n.push('answer <think')).toEqual([{ kind: 'text', text: 'answer ' }]);
    expect(n.push('>reasoning</think>')).toEqual([{ kind: 'thinking', text: 'reasoning' }]);
  });
});

describe('looseParse (quirk looseJsonArguments)', () => {
  it('returns strict JSON untouched', () => {
    expect(looseParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('repairs trailing commas', () => {
    expect(looseParse('{"a":1,"b":2,}')).toEqual({ a: 1, b: 2 });
  });

  it('repairs single-quoted strings', () => {
    expect(looseParse("{'path': 'src/a.ts'}")).toEqual({ path: 'src/a.ts' });
  });

  it('unwraps a markdown fence', () => {
    expect(looseParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('closes a truncated object', () => {
    expect(looseParse('{"path":"a.ts"')).toEqual({ path: 'a.ts' });
  });

  it('gives up rather than inventing a value', () => {
    expect(looseParse('not json')).toBeUndefined();
    expect(looseParse('')).toBeUndefined();
  });
});
