# Security policy

Lupin sits between Claude Code and a provider, which means it handles API keys
and OAuth tokens. That makes a few classes of bug worse than usual here, and
this page says which ones, how to report them, and what the tool already
promises.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (Security, then "Report a vulnerability"). It reaches the
maintainer without disclosing anything.

Please include the version (`lupin --version`), the platform, and the smallest
reproduction you have. If a proof of concept involves a real credential,
describe it rather than pasting it: never send a token, an authorization code or
an API key, not even a revoked one.

Expect a first response within a week. There is no bounty programme.

## What Lupin promises

These are the properties worth breaking. If you defeat one of them, it is a
vulnerability even if nothing else goes wrong.

- **Credentials never enter the config file, the logs, or a crash report.** They
  live in the OS keychain or in `~/.lupin/credentials.json`, written atomically
  with mode 600. `lupin doctor --submit` builds a GitHub issue locally and is
  pinned by tests to carry no credential, no key environment variable name, and
  no profile base URL.
- **Prompts and responses are never persisted.** The request log holds metadata
  only: model, lane, status, latency, token counts, routing markers. The
  cache-bust detector reads the provider's own token counters rather than
  holding any prompt bytes.
- **The listener is loopback only.** The daemon binds 127.0.0.1 and the control
  API additionally requires the local token from the config file.
- **Lupin never writes into `~/.claude`.** Uninstalling it means stopping using
  it.
- **Provider error messages are scrubbed** before being propagated, so a
  provider that echoes a key back does not put it on your screen.

## Deliberate risks, not vulnerabilities

Two provider logins are gated behind an explicit `--i-accept-the-risk` flag,
because the risk is real, documented, and cannot be engineered away:

- **Google** has suspended accounts for third-party OAuth use of Code Assist.
- **GitHub Copilot** access has been suspended in reports tied to the user's
  main GitHub identity. Using several accounts to stretch a quota is the pattern
  most associated with those reports, so Lupin refuses to combine Copilot with
  its multi-account feature.

Reusing the public OAuth client identifiers that ship inside official CLIs is a
deliberate, documented decision (see `docs/DECISIONS.md` and
`docs/SPEC-PROVIDERS.md`). Reporting that they are present in the source is not
a vulnerability report; reporting a way in which Lupin leaks *your* credentials
is.

## Supported versions

Pre-1.0, only the latest published version is supported. Fixes land on `main`
and ship in the next release.
