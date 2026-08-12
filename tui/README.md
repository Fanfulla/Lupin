# lupin-tui

The optional terminal hub for the Lupin proxy (DESIGN-OAUTH-PKCE-TUI §2). A Rust
sidecar: **the core proxy is pure Node with zero native dependencies and never
needs this binary.** `lupin` (no arguments) launches it when it is on the PATH,
and falls back to a text status everywhere else.

## Build

Requires a Rust toolchain (rustup) and, on Windows, the MSVC linker plus the
Windows SDK (the `link.exe` and `kernel32.lib` the `msvc` target needs).

From the repository root:

```sh
cargo build --release --manifest-path tui/Cargo.toml
```

On Windows, if `cargo` cannot find the linker, use the wrapper that enters the
MSVC environment first:

```bat
tui\build-msvc.bat --release
```

Then put `tui/target/release/lupin-tui` (`lupin-tui.exe` on Windows) on the
PATH.

## What it does

A dashboard (ADR-31): header with the Lupin portrait, daemon state and
FREE-tier honesty line; a profiles panel with the `1`-`9` hotkey fused into
each row; serving-now; per-window request stats; the request tail; and a
talking status line that narrates every action and its outcome.

On a cold start with no config, bare `lupin` launches a temporary bootstrap
daemon and opens the add-provider screen. The provider catalogue comes from
the Node registry, never from hardcoded Rust rows:

- API-key providers open a masked field, verify connectivity, and save only on
  success.
- OAuth providers show the browser URL and poll the asynchronous login job.
- Providers with suspension risk require confirmation before OAuth begins.
- Successful setup preserves the running daemon's port and local token, then
  returns to the normal dashboard without disconnecting.

Local runtimes are rows in the same screen (ADR-51): the TUI probes the live
server through the control API, shows windows and tool support per model, and
asks for the main and light picks before anything is saved.

- Reads `~/.lupin/config.json` directly after setup. Before the first profile,
  it reaches the bootstrap daemon through the identity supplied by bare
  `lupin`. `LUPIN_DIR` moves the whole home.
- Polls the daemon's `GET /health` for the routing truth (resolved slots, per-profile health, tier).
- Reads the recent-requests tail from the local `lupin.log`.
- Switches the active profile through `POST /v1/lupin/use` on the control API, so the
  daemon stays the single config writer and hot reload remains the single reload path.

Dashboard keys: `q` / `Esc` / `Ctrl-C` quit, `1`-`9` switch profiles,
`↑`/`↓` or `j`/`k` move the cursor, `Enter` selects, `r` refreshes, `d` runs
the doctor, `:` opens the command palette, `o` edits failover order, and `a`
opens agent routing. During masked key entry, `q` is ordinary input and
`Ctrl-C` remains the global exit.

The dashboard refreshes every second; a `lupin use` from another terminal
shows up within a second too. Full guide: [docs/TUI.md](../docs/TUI.md).

It talks only to 127.0.0.1 and reads only local files. No prompt or response content
is ever shown or sent anywhere (the privacy rule): state, not content.
