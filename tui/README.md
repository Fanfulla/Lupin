# lupin-tui

The optional terminal hub for the Lupin proxy (DESIGN-OAUTH-PKCE-TUI §2). A Rust
sidecar: **the core proxy is pure Node with zero native dependencies and never
needs this binary.** `lupin` (no arguments) launches it when it is on the PATH,
and falls back to a text status everywhere else.

## Build

Requires a Rust toolchain (rustup) and, on Windows, the MSVC linker plus the
Windows SDK (the `link.exe` and `kernel32.lib` the `msvc` target needs).

```sh
cargo build --release
```

On Windows, if `cargo` cannot find the linker, use the wrapper that enters the
MSVC environment first:

```bat
build-msvc.bat --release
```

Then put `target/release/lupin-tui` (`lupin-tui.exe` on Windows) on the PATH.

## What it does

A dashboard (ADR-31): header with the ASCII Lupin, the daemon state and the
FREE-tier honesty line; a profiles panel with the `1`-`9` hotkey fused into
each row; serving-now; per-window request stats; the request tail; and a
talking status line that narrates every action and its outcome (a failed
switch comes back as words, never as a silently unchanged screen).

- Reads `~/.lupin/config.json` directly (it is local; `LUPIN_DIR` moves the whole home).
- Polls the daemon's `GET /health` for the routing truth (resolved slots, per-profile health, tier).
- Reads the recent-requests tail from the local `lupin.log`.
- Switches the active profile through `POST /v1/lupin/use` on the control API, so the
  config file stays the single writer and the daemon's hot-reload the single reload trigger.

Keys: `q` / `Esc` quit, `1`-`9` switch the active profile at once, `↑`/`↓` (or `j`/`k`)
move a cursor over the rows and `Enter` switches to it, `r` refresh now.
Refreshes every second; a `lupin use` from another terminal shows up within a
second too. Full guide: [docs/TUI.md](../docs/TUI.md).

It talks only to 127.0.0.1 and reads only local files. No prompt or response content
is ever shown or sent anywhere (the privacy rule): state, not content.
