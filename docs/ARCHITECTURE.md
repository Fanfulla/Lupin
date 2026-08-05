# ARCHITECTURE: repo structure and dependency rules

The layout is mandatory. New files go where this scheme says; if a deviation is needed, update this document first (CLAUDE.md rule 1).

```
src/
  core/        PURE translation core: no I/O, no imports from server/providers.
    request.ts     Anthropic request -> provider mapping (SPEC-TRANSLATION §1-3)
    response.ts    non-streaming response mapping (§4)
    stream.ts      SSE state machine (§5)
    dialect.ts     dialect normalization (§5bis)
    errors.ts      error mapping (§6)
    tokens.ts      count_tokens estimate (§7)
    quirks.ts      centralized quirk implementation (the single place)
  providers/   Declarative registry: provider definitions, default profiles, config schema.
  server/      HTTP ingress, passthrough/translate routing, daemon, logging.
  config/      Config load/save, keychain/credentials, schema validation.
  cli/         Commands (init, use, run, doctor, list, status, stop, logs). Orchestration only:
               the logic lives elsewhere.
  doctor/      Agentic benchmark (SPEC-CLI §3), added in M4.
    plan.ts        PURE: workspace, prompt, scoring from artefacts, preflight, honest
                   reading of the headless result, cache_control probe classification
    run.ts         I/O: ephemeral server, headless Claude Code session, artefact collection
scripts/       Utilities not shipped with the package (for example ci-config.ts for the doctor
               workflow). No product logic: if it is needed elsewhere, it belongs in src/.
test/
  *.test.ts    unit (pure core, fixture runner) and integration (server against the fake provider); run in CI
  fixtures/    see TESTING.md
  helpers/     fake provider server, request builders
  e2e/         doctor and tests against real providers (excluded from CI by default)
```

## Dependency rules (enforced at review)

1. `core/` imports from `core/` only. It is a pure library: functions (input to output), synchronous or generators for streaming. All fixture testing depends on this.
2. `providers/` is declarative: data (endpoints, quirk flags, profiles), not logic. Quirk logic lives in `core/quirks.ts`.
3. `server/` is the only place with HTTP, sockets and runtime filesystem access. It composes `core/`, `providers/` and `config/`.
4. `cli/` implements no business logic: it calls `server/`, `config/` and `doctor/`.
5. `doctor/` splits in two: `plan.ts` is **pure** like `core/` (input to output, testable with no network and no disk) and imports nothing outside itself; `run.ts` is the I/O side and may compose `server/` and `config/`. The split is not cosmetic: everything that decides a verdict lives in the pure half, so a judgement about a model never depends on how the network behaved. Nothing in `core/` may import from `doctor/`.

A note on `plan.ts` being imported by `cli/init.ts`: the harness context floor (`DOCTOR_MIN_CONTEXT`) is one single measurement and must hold identically in the wizard and in the doctor. Duplicating it would mean letting the two drift apart.

Request flow (translate mode):

```
Claude Code -> server/ingress -> [local auth] -> providers/resolve(profile, slot)
  -> core/request.map -> HTTP to the provider -> core/stream (or response)
  -> core/dialect.normalize -> SSE back to Claude Code
```

In passthrough the core branch shrinks to: rewrite URL, auth and model, then pipe.

## Allowed external dependencies

Minimal and justified: a lightweight HTTP framework (hono or fastify), tiktoken-js (count_tokens), jsonrepair (the looseJsonArguments quirk), @napi-rs/keyring (optional, with the 600 file fallback, ADR-26). Every new dependency must be justified in DECISIONS.md.
