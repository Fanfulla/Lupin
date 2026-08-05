// Proxy-side enforcement of the knobs WHAM refuses to accept
// (DESIGN-TRANSLATORS-DEDICATED §2.1bis): `max_tokens` and `stop_sequences`.
//
// WHAM rejects both as REQUEST parameters, but that only means the provider
// will not do it for us: sitting inside the stream, the proxy can do it
// itself. This is the one thing a gateway can do that a plain client cannot,
// so "the provider does not accept the parameter" is not the same as "the
// behaviour is unobtainable".
//
// Accuracy: o200k_base counts WHAM's own text exactly (measured 2026-07-29
// over three responses: 43/87/19 ours against 47/91/23 reported, a CONSTANT
// offset of 4, which is the per-message framing WHAM adds and the same
// PER_MESSAGE_OVERHEAD core/tokens.ts already knows). So the cut lands on the
// token the caller asked for, it is not an estimate.
//
// Stop sequences need the hold-back rule the dialect engine already lives by
// (ADR-22): a sequence can arrive split across deltas, so the tail that could
// still become one is never emitted until it is ruled out.

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';

let encoder: Tiktoken | null = null;
function enc(): Tiktoken {
  encoder ??= new Tiktoken(o200k_base);
  return encoder;
}

export type LimitStop = 'max_tokens' | 'stop_sequence';

export interface LimitResult {
  /** Text cleared for emission (already truncated if a limit hit). */
  emit: string;
  /** Set when this push ended the message. */
  stop?: LimitStop;
  /** The stop sequence that matched, when stop is 'stop_sequence'. */
  matched?: string;
}

export interface OutputLimiterOptions {
  /** Anthropic max_tokens: the output budget, counted in real tokens. */
  maxTokens?: number;
  /** Anthropic stop_sequences: generation ends before the match. */
  stopSequences?: readonly string[];
}

/**
 * Applies max_tokens and stop_sequences to a text stream. Feed deltas in, get
 * the text that may be emitted out; once `stop` comes back the message is
 * over and the caller should close it (and stop reading upstream).
 */
export class OutputLimiter {
  /** Text seen but not yet cleared for emission (the hold-back tail). */
  private held = '';
  private tokensEmitted = 0;
  private done = false;
  private readonly maxStopLen: number;

  constructor(private readonly opts: OutputLimiterOptions = {}) {
    this.maxStopLen = Math.max(0, ...(opts.stopSequences ?? []).map((s) => s.length));
  }

  /** True once a limit ended the message: further pushes emit nothing. */
  get finished(): boolean {
    return this.done;
  }

  /** True when there is nothing to enforce, so the caller can skip the work. */
  get inactive(): boolean {
    return this.opts.maxTokens === undefined && (this.opts.stopSequences ?? []).length === 0;
  }

  push(text: string): LimitResult {
    if (this.done) return { emit: '' };
    this.held += text;

    // A stop sequence wins wherever it lands: everything before it is output,
    // the sequence itself and everything after are not.
    const hit = this.findStop(this.held);
    if (hit !== undefined) {
      const emit = this.capTokens(this.held.slice(0, hit.index));
      this.held = '';
      this.done = true;
      return emit.stop === 'max_tokens'
        ? { emit: emit.text, stop: 'max_tokens' }
        : { emit: emit.text, stop: 'stop_sequence', matched: hit.seq };
    }

    // Nothing matched yet, but the tail could still become a stop sequence:
    // hold back just enough characters to decide next time.
    const keep = this.maxStopLen === 0 ? 0 : Math.min(this.held.length, this.maxStopLen - 1);
    const ready = this.held.slice(0, this.held.length - keep);
    this.held = this.held.slice(this.held.length - keep);
    if (ready === '') return { emit: '' };

    const capped = this.capTokens(ready);
    if (capped.stop !== undefined) {
      this.held = '';
      this.done = true;
      return { emit: capped.text, stop: capped.stop };
    }
    return { emit: capped.text };
  }

  /** Stream ended: release whatever was held back for the stop-sequence check. */
  flush(): LimitResult {
    if (this.done || this.held === '') return { emit: '' };
    const rest = this.held;
    this.held = '';
    const capped = this.capTokens(rest);
    if (capped.stop !== undefined) {
      this.done = true;
      return { emit: capped.text, stop: capped.stop };
    }
    return { emit: capped.text };
  }

  /** The earliest stop sequence in `text`, if any. */
  private findStop(text: string): { index: number; seq: string } | undefined {
    let best: { index: number; seq: string } | undefined;
    for (const seq of this.opts.stopSequences ?? []) {
      if (seq === '') continue;
      const i = text.indexOf(seq);
      if (i !== -1 && (best === undefined || i < best.index)) best = { index: i, seq };
    }
    return best;
  }

  /** Truncates `text` to what is left of the token budget. */
  private capTokens(text: string): { text: string; stop?: LimitStop } {
    const max = this.opts.maxTokens;
    if (max === undefined || text === '') return { text };
    const remaining = max - this.tokensEmitted;
    if (remaining <= 0) return { text: '', stop: 'max_tokens' };
    const tokens = enc().encode(text);
    if (tokens.length <= remaining) {
      this.tokensEmitted += tokens.length;
      return { text };
    }
    this.tokensEmitted = max;
    return { text: enc().decode(tokens.slice(0, remaining)), stop: 'max_tokens' };
  }
}
