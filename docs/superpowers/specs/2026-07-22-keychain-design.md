# The OS keychain as the credential backend: design (2026-07-22)

It closes the last piece of M3: SPEC-CLI §4 prescribes "API keys in the OS keychain; fallback: a 600 file", but today only the fallback exists. The comment at the head of `src/config/credentials.ts` already promised the shape: "an alternative backend behind these same functions".

## Decisions taken while brainstorming (2026-07-22, with the user)

1. **Platforms**: all three from the start, Windows (Credential Manager), macOS (Keychain), Linux (Secret Service/libsecret).
2. **What migrates**: everything, API keys **and** OAuth tokens. Zero secrets on files when the keychain is active.
3. **Activation**: none. Keychain-first **by default** when available, as SPEC-CLI §4 says. This is not routing: ADR-25 (opt-in) does not apply to storage. There is no installed base to migrate.
4. **Mechanism**: **approach A**, `@napi-rs/keyring` in `optionalDependencies` plus the fallback to the existing 600 file. Rejected: shelling out to the OS tools (the secrets would pass through a subprocess argv or stdin: a security regression); a three-layer `cross-keychain`-style architecture (the middle layer covers an almost empty set).

**Dependency verified (2026-07-22)**: `@napi-rs/keyring` v1.3.0, the Node binding (napi-rs) of `keyring-rs`, around 220k downloads per week, 414 dependents, prebuilt per platform with no compilation, a synchronous `Entry` API, keytar-compatible. Microsoft is migrating MSAL from keytar to this one (AzureAD/microsoft-authentication-library-for-js#7170). keytar has been archived since 2023: the mentions in ARCHITECTURE.md and SPEC-CLI need updating.

## Architecture

`credentials.ts` keeps **all its existing exported functions with the same signatures**. Inside, two backends behind a common interface:

- **`KeychainStore`**: `new Entry("lupin", ref)` with `getPassword()`/`setPassword()`/`deletePassword()`. `ref` is the key already in use (`moonshot`, `oauth/kimi` and so on); the value is the API key (a string) or `JSON.stringify` of the OAuth tokens.
- **`FileStore`**: the current code, unchanged (600, atomic tmp plus rename).

No enumeration: it was verified in the sources that every caller (`config.ts`, `oauth.ts`, `login.ts`, `init.ts`) only does get, set and delete by exact key. `loadCredentials` stays internal to the FileStore.

### Backend selection (once per process, cached)

1. An explicit `path` passed by the caller **or** `LUPIN_CREDENTIALS` set means **file** at that path. An explicit path means an explicit file: it preserves every existing test and the doctor's isolation.
2. `LUPIN_CREDSTORE=file` means **file** (a user opt-out, and CI).
3. A runtime probe: a dynamic `import('@napi-rs/keyring')` plus a write, read and delete of a `__probe__` entry. The import alone is not enough: on Linux without a Secret Service the module loads but the operations fail.
4. A successful probe means **keychain**; a failure for any reason means **file**, with no error but visibly (see Visibility).

## The Windows blob limit: chunking

Credential Manager truncates blobs at around 2560 bytes (`CRED_MAX_CREDENTIAL_BLOB_SIZE`). Above **2048 UTF-8 bytes** (a conservative threshold, applied on every platform so there is only one behaviour) the value is split into `ref#0`, `ref#1` and so on entries; the main `ref` entry contains only the header `{"__chunks": N}`. On read, a value that parses as a header is reassembled; the delete removes the header and the chunks. API keys never trigger it; OAuth tokens with long JWTs do.

## Visibility and coherence

- `lupin status` and the daemon's startup log say where the secrets live: `credentials: Windows Credential Manager` / `macOS Keychain` / `Secret Service (libsecret)` / `file 600`.
- `init` and `login` confirm the destination in the outcome line they already print.
- **Lazy promotion**: with the keychain active and a key found only in the file, the read writes it into the keychain, **verifies it by reading it back**, and only after that verification removes it from the file. In steady state there are zero secrets on files, with no migration command.
- `device_id` stays on file: an identifier, not a secret (DESIGN-OAUTH §6).
- The `credentials.json` file is not created when the keychain is active and there is nothing to promote.

## Errors

- A failed probe means the file fallback, silent but visible in `lupin status`.
- A keychain error **after** a successful probe (rare: a Secret Service dying mid-process) is propagated with a clear message. **Never** a mid-process downgrade to file: it would create a split brain of writes (reads from the keychain, writes to the file).
- A persistence failure during an OAuth refresh keeps today's file semantics: the error propagates, and the rotated token is not lost silently.

## Tests (contract-first)

- **One contract suite run against both backends** (FileStore on a temp dir plus an injected in-memory fake keychain): get/set/delete, an OAuth round trip, the tombstone, `oauthNeedsRefresh`. Backend parity is the invariant, like "streaming == non-streaming" for the dialects (ADR-22).
- Unit: backend selection (an explicit path means file; `LUPIN_CREDSTORE=file`; a failed probe means file), a chunking round trip across the threshold (2047/2048/2049 bytes and multi-chunk), and lazy promotion with verification (including: a failed verification leaves the file untouched).
- The 279 existing tests pass **untouched** (they use explicit paths, hence the FileStore).
- **A live smoke test on Windows** (the dogfooding machine): `lupin init`, then the `lupin/<ref>` entry visible in Credential Manager, then `lupin run` giving a working session, with `credentials.json` absent or carrying no secrets.

## Documentation to update

- `DECISIONS.md`: a new ADR, with the `@napi-rs/keyring` dependency justified (the ARCHITECTURE rule), keychain-first by default, the explicit-path-means-file rule, and no mid-process downgrade.
- `ARCHITECTURE.md` and `SPEC-CLI.md` §4: keytar becomes `@napi-rs/keyring` (keytar archived in 2023).
- `ROADMAP.md`: tick point 3 of the resume list.

## Out of scope

Enumerating keychain entries; a `lupin keychain` command; assisted migration; keytar compatibility; encrypting the fallback file (600 stays the minimum contract, SPEC-CLI §4).
