# Glossary

This glossary defines the terms used by the README, terminal hub and command
output. For exact command syntax, see the README command reference or run
`lupin help`.

## Provider

The upstream system that receives an inference request, such as a hosted API
or a local runtime. A provider defines endpoints, authentication and supported
protocol lanes. It does not choose which provider is active.

## Profile

A named, switchable configuration that combines one provider, one credential
source, three model slots, optional routing and optional failover. `lupin use`
and the TUI number keys switch profiles without restarting an open session.

## Slot

One of `opus`, `sonnet` or `haiku`. The client asks for a capability tier and
the active profile maps that tier to a real model or delegates it to another
profile. `opus` usually carries the strongest model, `sonnet` the daily driver
and `haiku` background or high-volume work, but the mapping is entirely yours.

## Mode

The protocol path declared by a profile. The current modes are `passthrough`,
`translate`, `responses` and `codeassist`. The mode is visible in profile
lists and request logs.

## Passthrough

A mode for providers that already accept Anthropic Messages requests. Lupin
changes transport details such as URL, credential and model, while preserving
the request body as closely as possible. This has the lowest translation risk
and protects prefix-cache stability.

## Translate

A mode for OpenAI-compatible Chat Completions providers. Lupin maps messages,
content blocks, tools, responses and SSE events in both directions.

## Responses

A lane for providers using the OpenAI Responses event grammar instead of Chat
Completions. Lupin translates the same incoming Messages request into Responses
items and turns its stream back into Messages events.

## Code Assist

The dedicated lane for Google Code Assist accounts. It is separate because an
OAuth token for that account does not spend on the public Gemini API.

## Hub

The default experience opened by bare `lupin`. With the optional sidecar it is
the interactive TUI; without it, it prints status and the next applicable
steps.

## TUI

The optional Rust terminal user interface. It displays profiles, resolved
models, health and recent request metadata. It sends state changes through the
authenticated control API and never writes config or credential files itself.

## Daemon

The local Node process bound to `127.0.0.1`. It receives client requests,
resolves routing, authenticates to the selected provider and streams responses
back. The watchdog supplies a structured retryable error if the daemon stops
mid-session.

## Local token

A random secret used only between local clients and the daemon control API.
It protects profile, credential and routing operations even though the server
binds to loopback. It is not a provider API key.

## Credential store

The storage backend for API keys and OAuth tokens. Lupin prefers the operating
system keychain. If that backend is unavailable, it uses an atomic owner-only
file. Credentials never belong in `config.json`.

## Catalogue

A provider-published model list used for search and completion in the TUI.
It informs input but never blocks a manually typed model id. Being listed does
not guarantee that an account tier may use a model.

## Route

An opt-in rule that changes the target for a request based on observable input,
such as long context, images or thinking. At most one content route applies to
an attempt, and the request log names it.

## Agent route

A named mapping for a subagent or agent type. It can point at a profile or a
model and is activated through a `claude-lupin-agent:<name>` model id.

## Failover

An opt-in profile link used for one retry after a rate limit, overload or
network failure. It is not a loop and never activates itself during setup.

## Health

Short-lived runtime state derived from real request outcomes. It can show a
profile as healthy, cooling down or unavailable. It is not a model quality
score.

## Doctor

The behavioural compatibility test run by `lupin doctor`. It launches a real
headless session, checks artefacts written on disk and records a score only if
the provider actually received the work. A provider with no run has no score.

## Cache receipt

Token counts reported by a provider for cached input and newly processed
input during a doctor run. Missing fields mean the provider did not report
them; they are never displayed as invented zeros.
