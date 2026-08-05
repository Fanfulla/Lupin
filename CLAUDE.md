# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# Project: Lupin

A local proxy that lets you use Claude Code (with all its MCP servers, skills, hooks, memories and plugins such as claude-mem) on any LLM provider. Claude Code only speaks the Anthropic Messages API: Lupin receives it and forwards it to the chosen provider, either in **passthrough** (Anthropic-native providers: Kimi/Moonshot, DeepSeek, Z.AI, OpenRouter) or in **translate** (OpenAI-compat: OpenAI, Gemini, Ollama, LM Studio).

## Documentation: read BEFORE implementing

| File | Content |
|---|---|
| `DESIGN.md` | Vision, prior art, positioning against claude-code-router, architecture, risks |
| `docs/SPEC-TRANSLATION.md` | Translation core spec: field mapping, content blocks, tools, the SSE state machine, errors, count_tokens, 10 acceptance fixtures |
| `docs/SPEC-PROVIDERS.md` | Provider registry with verified endpoints, config/profile schema, slot mapping, quirk registry |
| `docs/SPEC-CLI.md` | CLI commands, the `lupin doctor` spec, security, UX acceptance criteria |
| `docs/ROADMAP.md` | Milestones M0 to M5 with verification criteria, out of scope, risks |
| `docs/ARCHITECTURE.md` | Repo layout, dependency rules (a pure core), request flow, allowed dependencies |
| `docs/TESTING.md` | Fixture format, recording from real output, test levels, the fake provider |
| `docs/DECISIONS.md` | ADR-lite log: decisions taken and why. Read it BEFORE reopening a choice |

## Project-specific working rules

1. **The specs are the source of truth.** If while implementing you find a spec wrong or incomplete: stop, propose the spec change, then implement. Never diverge silently.
2. **Work order = ROADMAP.md.** A milestone closes only when its verification criteria pass. Do not pull features from future milestones forward (for example no behavioural adapters before M5).
3. **Every behaviour of the translation core is born from a test fixture** (Anthropic input to expected provider output, and the other way round). Fixture first, code second.
4. **Centralized quirks**: never `if (provider === "x")` scattered through the code, only flags in the quirk registry (SPEC-PROVIDERS §5) with a single implementation.
5. **Never hardcode model names in the sources**: they live only in the default profiles and in SPEC-PROVIDERS, each with a verification date.
6. **Stack**: TypeScript strict, Node >= 20, vitest. Minimal dependencies; no mandatory native dependency.
7. **Privacy**: the proxy never persists prompts or responses; API keys live in the keychain or in a 600 file, never in the config or the logs.
8. **Language**: everything in this repo is written in English, code and documentation alike (user decision, 2026-07-24). No em-dashes in any text.
