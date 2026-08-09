# Agent routes: per-subagent model and provider control (2026-08-09)

Origin: the 0.2.0 launch thread. One commenter asked for per-subagent model control beyond `--bg`; another asked for "mix sub agents with total control". The idea itself was already parked in ADR-25 ("subagent routing, deferred to M5") and listed as a steal candidate from claude-code-router and rayline (DESIGN §3: rayline's "hybrid sessions" is the same intuition). This design makes it real.

## The problem

Today the only subagent lever is the haiku slot (`--bg`). It is coarse in two ways:

1. Subagents that inherit the main model arrive as `claude-fable-5`/`claude-sonnet-*` and land on the opus or sonnet slot, so `--bg` never touches them. The README's "subagents somewhere cheaper" claim is only true for the haiku-tier traffic.
2. There is one lever for ALL background traffic. "Explore on the local model, Plan on the strong one, everything else on the cheap hosted one" cannot be expressed.

## Wire facts (verified 2026-08-09 against code.claude.com/docs/en/sub-agents.md and GitHub issues)

1. **No request marker exists for subagents.** No header, no `metadata` field, nothing in the body identifies the agent type; the feature request for such headers (anthropics/claude-code#12430) was closed "not planned". A proxy cannot detect "this is a subagent" from the request, and sniffing system-prompt text would be version-fragile and against the spirit of ADR-12.
2. **The model id is the one reliable channel.** Subagent model resolution order (docs, v2.1.211+): `CLAUDE_CODE_SUBAGENT_MODEL` env var, then the Agent tool `model` parameter, then the agent's frontmatter `model:`, then inherit. The frontmatter field accepts "a full model ID" and the resolved id travels verbatim in the body.
3. **`CLAUDE_CODE_SUBAGENT_MODEL` overrides frontmatter.** Setting it routes EVERY subagent, including ones with their own `model:`. So the blanket route and per-agent frontmatter routing are mutually exclusive client-side, and the docs must say so.
4. Caveat: an org `availableModels` allowlist can substitute ids client-side. Not a Lupin concern (gateway setups are exactly the case the allowlist does not know), documented as a limit.

## Design: id algebra, zero content inspection

Same family as ADR-37's `claude-lupin-switch:<profile>` rows: the id namespace under `claude-lupin-` is the one channel Lupin controls end to end.

1. **A new id shape**: `claude-lupin-agent:<name>`. The user puts it where Claude Code already accepts a model id: an agent's frontmatter `model:`, the Agent tool `model` parameter, or `CLAUDE_CODE_SUBAGENT_MODEL`.
2. **A global `agents` table in the config** (top level, next to `profiles`): `"agents": { "<name>": <slot target> }`. The target has the exact `SlotTarget` shape slots already use: a model string (a real model of the profile serving the request, normally the active one) or `{"profile": "x"}` (delegate; the request lands on x's sonnet slot, since an agent id names no tier).
3. **Resolution**, in `resolveRequest`: after `normalizeModelId`, an id starting with `agent:` looks up the table. A match resolves to the target and **bypasses content routes** (total control means the request goes exactly where aimed, like direct use). An unknown name serves the request on the normal path (the id contains neither `opus` nor `haiku`, so it lands on the sonnet slot) and the log says `agentRoute: "unknown:<name>"`: serve, never break (the ADR-37 rule).
4. **The blanket route is a naming convention, not a new mechanism**: the reserved-by-convention name `subagents`. When `config.agents.subagents` exists and the user has not set `CLAUDE_CODE_SUBAGENT_MODEL` themselves (any explicit value wins, empty included), `lupin run` fills it with `claude-lupin-agent:subagents`. Same launch-env pattern as `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` and `raiseStreamIdleTimeout` (ADR-35), same honest limit: the env var is read at launch, but the TABLE is hot-reloaded, so where `subagents` points can change mid-session from any surface.
5. **Visible, never silent**: the request line carries `agentRoute: "<name>"`; `lupin top` and the TUI print it as `agent:<name>` next to the other routing markers.
6. **Not published in `/v1/models`**: agent ids are typed into agent definitions, not picked from the picker; publishing them would put inert rows in a model picker for no gesture. (The switch rows exist because the picker IS their surface; here the surface is the agent file.)

## Surfaces

- **CLI**: `lupin agents` (list, plus the exact id to paste and the precedence warning), `lupin agents set <name> --profile <p> | --model <m>` (exactly one; a model name is written as given and never checked, the `use --opus` rule), `lupin agents unset <name>`. Names are `[A-Za-z0-9._-]{1,32}`: a `:` would break the sentinel, a space would break the frontmatter value. Direct config write like `use` (load, mutate, save; hot reload does the rest).
- **Control API**: `POST /v1/lupin/agents { agents: { ... } }`, the whole table atomically (the ADR-34 argument: no partial edit can survive a mid-write failure), validated like the config, same localToken guard.
- **TUI**: key `a` opens agents mode (the order-mode pattern: an `Option` state checked before the normal key match). Rows: every configured agent route, plus `subagents` always shown (even when unset) so the first-use gesture exists. Arrows pick a row, `1`-`9` aims it at that profile (delegation), `x` clears it, Enter applies through the control endpoint, Esc cancels. Creating other names stays a CLI gesture (`lupin agents set`), said in the status line.

## What this deliberately does not do

- No system-prompt sniffing, no heuristic subagent detection: the only honest signal is the id (wire fact 1).
- No per-agent failover or routes: an agent route is a pointer, and the profile it lands on keeps its own quirks and health. Failover of the active profile still applies per request; a delegated agent target re-resolves identically on the failover attempt and the log shows it, which is the same honest limit slot delegation already has.
- No writing into `~/.claude` (ADR-11): Lupin prints the frontmatter line, the user pastes it.
- Nothing on by default: an absent table changes zero behaviour, and `lupin run` fills the env var only when the user declared the `subagents` route.

## Interactions checked

- `switch:` and `agent:` sentinels live in the same namespace and cannot collide (distinct prefixes).
- `[1m]` suffix and gateway prefix strip before the sentinel check, so `claude-lupin-agent:x[1m]` still routes.
- Failover: string targets re-resolve against the failover profile (like slots); `{profile}` targets are absolute and retry the same place once, visibly.
- count_tokens goes through the same resolution (harmless, same as slots).
- Doctor: untouched; it aims real profiles.
- Privacy: the mechanism reads only `body.model`.

## Test plan

Unit (resolve, config validation, cli parse, run env), integration (ingress serves an agent id on the target model and logs `agentRoute`; unknown name falls back and logs `unknown:`; control endpoint writes atomically), TUI (config parse, overlay render into TestBackend, api call unit), marker parity between `lupin top` and the sidecar. Not a translation-core behaviour, so no core fixture is due (TESTING rule: fixtures are for the translate core; routing is unit plus integration, like routes and failover).
