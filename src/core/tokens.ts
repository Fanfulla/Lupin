// Local input-token estimate (SPEC-TRANSLATION §7): o200k_base via js-tiktoken,
// ±10% is acceptable: Claude Code uses this for context management, not billing.
// Counts system + serialized messages + tools (JSON schemas weigh!).

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import type { AnthropicRequest, AnthropicBlock, TextBlock } from './request.js';

let encoder: Tiktoken | null = null;
function enc(): Tiktoken {
  encoder ??= new Tiktoken(o200k_base);
  return encoder;
}

const PER_MESSAGE_OVERHEAD = 4; // chat format framing per message
// Base64 carries no dimensions; flat cost ≈ a mid-size image (§7 is silent on
// images: better a stable overestimate than dropping them from the count).
const PER_IMAGE_TOKENS = 1500;

export function estimateInputTokens(req: AnthropicRequest): number {
  const parts: string[] = [];
  let images = 0;
  let messages = 0;

  if (req.system !== undefined) {
    parts.push(typeof req.system === 'string' ? req.system : req.system.map((b) => b.text).join('\n\n'));
  }

  for (const m of req.messages) {
    messages++;
    if (typeof m.content === 'string') {
      parts.push(m.content);
      continue;
    }
    for (const b of m.content) images += collectBlock(b, parts);
  }

  for (const t of req.tools ?? []) {
    messages++; // tool defs carry framing overhead too
    parts.push(t.name);
    if (t.description !== undefined) parts.push(t.description);
    parts.push(JSON.stringify(t.input_schema));
  }

  const textTokens = enc().encode(parts.join('\n')).length;
  return textTokens + messages * PER_MESSAGE_OVERHEAD + images * PER_IMAGE_TOKENS;
}

/** Pushes the block's countable text into parts; returns how many images it contained. */
function collectBlock(b: AnthropicBlock, parts: string[]): number {
  switch (b.type) {
    case 'text':
      parts.push(b.text);
      return 0;
    case 'image':
      return 1;
    case 'tool_use':
      parts.push(b.name, JSON.stringify(b.input));
      return 0;
    case 'tool_result': {
      if (typeof b.content === 'string') {
        parts.push(b.content);
        return 0;
      }
      let images = 0;
      for (const c of b.content ?? []) {
        if (c.type === 'text') parts.push((c as TextBlock).text);
        else if (c.type === 'image') images++;
      }
      return images;
    }
    default:
      // thinking/redacted_thinking: dropped in translation (§2 rule 6), not counted
      return 0;
  }
}
