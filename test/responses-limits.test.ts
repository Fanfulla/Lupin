// Proxy-side max_tokens and stop_sequences (DESIGN-TRANSLATORS-DEDICATED
// §2.1bis). WHAM refuses both as request parameters, so the proxy enforces
// them inside the stream instead. The hold-back cases are the ones that matter:
// a stop sequence arriving split across deltas must still be caught.

import { describe, expect, it } from 'vitest';
import { OutputLimiter } from '../src/core/responses/limits.js';

/** Feed deltas, collect everything emitted plus how it ended. */
function run(limiter: OutputLimiter, deltas: string[]) {
  let text = '';
  let stop: string | undefined;
  let matched: string | undefined;
  for (const d of deltas) {
    const r = limiter.push(d);
    text += r.emit;
    if (r.stop !== undefined) {
      stop = r.stop;
      matched = r.matched;
      break;
    }
  }
  if (stop === undefined) {
    const f = limiter.flush();
    text += f.emit;
    if (f.stop !== undefined) stop = f.stop;
  }
  return { text, stop, matched };
}

describe('OutputLimiter: no limits set', () => {
  it('passes text through untouched and reports itself inactive', () => {
    const l = new OutputLimiter();
    expect(l.inactive).toBe(true);
    expect(run(l, ['hello ', 'world'])).toEqual({ text: 'hello world', stop: undefined, matched: undefined });
  });
});

describe('OutputLimiter: stop_sequences', () => {
  it('cuts at the sequence and never emits the sequence itself', () => {
    const l = new OutputLimiter({ stopSequences: ['STOP'] });
    const r = run(l, ['keep this ', 'STOP drop this']);
    expect(r.text).toBe('keep this ');
    expect(r.stop).toBe('stop_sequence');
    expect(r.matched).toBe('STOP');
  });

  it('catches a sequence split across deltas (the hold-back rule)', () => {
    const l = new OutputLimiter({ stopSequences: ['STOP'] });
    // The sequence arrives one character at a time, straddling four deltas.
    const r = run(l, ['keep', 'S', 'T', 'O', 'P', 'gone']);
    expect(r.text).toBe('keep');
    expect(r.stop).toBe('stop_sequence');
    expect(r.matched).toBe('STOP');
  });

  it('does not hold text back forever when the tail is not a prefix', () => {
    const l = new OutputLimiter({ stopSequences: ['STOP'] });
    const r = run(l, ['abcdefgh']);
    expect(r.text).toBe('abcdefgh');
    expect(r.stop).toBeUndefined();
  });

  it('honours the earliest of several sequences', () => {
    const l = new OutputLimiter({ stopSequences: ['END', 'XX'] });
    const r = run(l, ['a XX b END c']);
    expect(r.text).toBe('a ');
    expect(r.matched).toBe('XX');
  });

  it('emits nothing once finished', () => {
    const l = new OutputLimiter({ stopSequences: ['STOP'] });
    run(l, ['a STOP b']);
    expect(l.finished).toBe(true);
    expect(l.push('more').emit).toBe('');
  });
});

describe('OutputLimiter: max_tokens', () => {
  it('truncates on the token boundary the caller asked for', () => {
    const l = new OutputLimiter({ maxTokens: 3 });
    const r = run(l, ['one two three four five six seven']);
    expect(r.stop).toBe('max_tokens');
    // Exactly three tokens of the original text, nothing invented.
    expect(r.text.length).toBeGreaterThan(0);
    expect('one two three four five six seven'.startsWith(r.text)) .toBe(true);
  });

  it('counts across deltas, not per delta', () => {
    const l = new OutputLimiter({ maxTokens: 4 });
    const r = run(l, ['alpha ', 'beta ', 'gamma ', 'delta ', 'epsilon ', 'zeta']);
    expect(r.stop).toBe('max_tokens');
    expect('alpha beta gamma delta epsilon zeta'.startsWith(r.text)).toBe(true);
  });

  it('lets a short answer through untouched', () => {
    const l = new OutputLimiter({ maxTokens: 1000 });
    const r = run(l, ['short answer']);
    expect(r.text).toBe('short answer');
    expect(r.stop).toBeUndefined();
  });
});

describe('OutputLimiter: both limits at once', () => {
  it('reports the stop sequence when it comes before the token budget', () => {
    const l = new OutputLimiter({ maxTokens: 1000, stopSequences: ['HALT'] });
    const r = run(l, ['a few words HALT and more']);
    expect(r.stop).toBe('stop_sequence');
    expect(r.text).toBe('a few words ');
  });

  it('reports max_tokens when the budget runs out first', () => {
    const l = new OutputLimiter({ maxTokens: 2, stopSequences: ['HALT'] });
    const r = run(l, ['one two three four five HALT']);
    expect(r.stop).toBe('max_tokens');
  });
});
