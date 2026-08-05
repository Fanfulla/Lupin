# TUI: the `lupin-tui` terminal hub

> The optional terminal console for the Lupin proxy (DESIGN-OAUTH-PKCE-TUI §2, ADR-27). It answers, live, the question a proxy user cannot otherwise answer: **which model is really serving this session, is the profile healthy, and what has just gone through**. Everything is metadata: never a prompt, never a response body (the privacy rule, ADR-12).

The TUI is a **sidecar**. The core proxy is pure Node with zero native dependencies and never needs this binary; `lupin` (no arguments) launches the TUI only when it is on the PATH and stdout is a terminal, and falls back to a text status everywhere else. A user without a Rust toolchain loses nothing.

## Install and build

Requires a Rust toolchain (rustup) and, on Windows, the MSVC linker plus the Windows SDK (the `link.exe` and `kernel32.lib` the `msvc` target needs).

```sh
cd tui
cargo build --release
```

On Windows, if `cargo` cannot find the linker, use the wrapper that enters the MSVC environment first:

```bat
cd tui
build-msvc.bat --release
```

Then put the binary on the PATH:

| Platform | Binary to expose as `lupin-tui` |
|---|---|
| Windows | `tui\target\release\lupin-tui.exe` |
| macOS / Linux | `tui/target/release/lupin-tui` |

Once it is on the PATH, a bare `lupin` finds it. `lupin-tui --version` prints the version and exits.

## Launch

```sh
lupin            # the hub: TUI if the sidecar is on the PATH, else a text status
lupin-tui        # directly, the same screen
```

The TUI needs a config: with none it prints `no config yet: run \`lupin init\` first` and exits 1. It talks only to 127.0.0.1 and reads only local files.

## The screen, panel by panel

Since 2026-07-29 (ADR-31) the screen is a dashboard: bordered panels, the
gentleman thief, and a talking status line that narrates every action and its
outcome.

**The portrait** (2026-08-05) is Arsene Lupin as Leo Fontan drew him in 1908 for
the cover of "Arsene Lupin contre Herlock Sholmes", traced from the public
domain scan. It is drawn in braille by default, because a braille cell is a 2x4
dot matrix and carries four times the detail of a character cell; a plain ASCII
rendering of the same source is used instead when something says the glyphs will
not draw (a non-UTF-8 locale, or `LUPIN_TUI_ASCII` set by hand). Both are the
same height, so the layout never moves. Under 32 rows the screen gets a compact
sixteen-cell version, and under 20 it drops the art entirely rather than clip
the facts.

```
╭────────────────────────────────────────────────────────────────────────╮
│⣀⣤⣶⣾⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀  L U P I N  v0.1.0   the gentleman router
│⠈⢿⣿⣿⣿⣿⣿⣷⣖⠀⠀⠀⠀⠀⠀⠀  daemon up   127.0.0.1:3456
│⠀⠴⢿⣿⣿⣿⣿⣿⣿⣀⠀⠀⠀⠀⠀⠀  active: kimi-sub  ->  k3
│⠀⠀⠈⠛⢿⠿⣿⣿⣿⣿⣿⣶⣶⣶⣤⣄  FREE tier (free models, free limits)
╰────────────────────────────────────────────────────────────────────────╯
╭ profiles ──────────────────────────────────────╮╭ serving now ────────╮
│profile      mode        opus/sonnet/haiku  ... ││opus   k3            │
│*1 kimi-sub  passthrough k3/k3/kimi-for-coding  ││sonnet k3            │
│ 2 glm       passthrough glm-5.2/glm-5.2/glm-5  ││haiku  kimi-for-c    │
│                                                │╰─────────────────────╯
│                                                │╭ this window ────────╮
│                                                ││12 requests  0 errors│
│                                                ││p50 980ms            │
╰────────────────────────────────────────────────╯╰─────────────────────╯
╭ recent requests ───────────────────────────────────────────────────────╮
│07:11:46 200     980ms  kimi-sub/k3  routed:thinking                    │
╰────────────────────────────────────────────────────────────────────────╯
 > active profile -> kimi-sub
  q quit    1-9 / arrows+enter switch    r refresh    (auto-refresh 1s)
```

| Panel | What it shows | Source |
|---|---|---|
| Header | the Lupin portrait, daemon up/DOWN, endpoint, the active profile and the model really behind it, and the FREE-tier line (only when `/health` declares the tier: the M6b honesty rule, never a guess) | config + `GET /health` (DOWN when the daemon does not answer) |
| Profiles | one row per profile with its `1`-`9` hotkey fused into the label (no width squeeze can hide it): mode, the three slots, per-profile health, the last doctor score, and the automatic-switch link as `-> name` when the profile declares a `failover` (ADR-34: the switch order IS the failover chain) | config on disk; health from `GET /health` |
| Serving now | the models the daemon **really** resolves per slot | `GET /health` (the routing truth, never the model's own claim) |
| This window | requests, errors and p50 latency over the rows the screen holds. An honest window, not a pretend "today": the full aggregation stays in `lupin usage` | the same log tail the request panel shows |
| Recent requests | the last `/v1/messages` calls: time, status, latency, profile/model, and the routing markers | the local `lupin.log` tail |
| Talking line | what the dashboard just did, in words: `active profile -> x`, `switch to x failed: daemon not answering`, `refreshed`. A failed action is never a silently unchanged screen | the last action's outcome |

A slot shown as `->name` means the slot delegates to another profile. Health shows `cooldown Ns` while a profile is in failover cooldown (ADR-25), `healthy` otherwise. A doctor score shows as `score/max date`, `-` when the profile was never doctored.

### Request markers

Each recent request can carry the routing truth inline, exactly like `lupin logs`:

| Marker | Meaning |
|---|---|
| `routed:<kind>` | a content-aware route fired (longContext, vision, thinking) |
| `failover<-<profile>` | the request failed over FROM that profile |
| `cooldown:<profile>` | a profile was skipped because it is in cooldown |
| `streamError:<type>` | an SSE stream returned HTTP 200 but carried an `event: error` (ADR-24) |

## Keys

| Key | Action |
|---|---|
| `q` / `Esc` / `Ctrl-C` | quit (the terminal is restored on every exit path, panics included) |
| `1` - `9` | switch the active profile to the row carrying that number |
| `↑` / `↓` (or `k` / `j`) | move the cursor over the profile rows (the highlighted row) |
| `Enter` | switch the active profile to the row under the cursor |
| `r` | refresh now, without waiting for the next tick |
| `o` | order mode: type the profile numbers in the order automatic switches should follow (previewed by name in the status line), `Enter` applies, `Esc` cancels |

The `1`-`9` hotkeys act immediately; the cursor path is two-step on purpose, so
scrolling the list never fires a switch by accident. The cursor stays on a real
row: when the profile list shrinks it clamps back into range.

Order mode (ADR-34) edits the failover chain through one atomic control call
(`POST /v1/lupin/switch-order`): each named profile fails over to the next, the
last one's failover is removed (a chain has an end, not a loop), and profiles
outside the list keep whatever they had. A quota-exhausted answer then walks
this chain durably (SPEC-PROVIDERS §4octies). At least two numbers are needed;
a repeated number is refused and said out loud in the status line.

The screen repaints once a second and immediately after a switch. A `lupin use`
from another terminal shows up within a second too: the TUI re-reads the same
config file and `/health` the CLI writes and reads, so the two surfaces cannot
disagree for longer than one refresh.

## How a profile switch works (and why it is safe)

Pressing `1`-`9` (or `Enter` on the highlighted row) does NOT write the config file from the TUI. It calls `POST /v1/lupin/use` on the daemon's control API; **the daemon** writes the config, and its existing hot-reload watch reloads it. There is exactly one writer and one reload trigger, so a TUI switch and a `lupin use` from another terminal can never split the state. An open Claude Code session picks the new profile up on its next request, with no restart.

## Settings and environment

The TUI reads the same paths as the Node side; nothing is configured separately.

| Setting | Effect |
|---|---|
| `LUPIN_DIR` | Moves the whole Lupin home (config, log, credentials). The TUI honours it exactly like the daemon (the split-brain lesson of 2026-07-24). Default `~/.lupin`. |
| `LUPIN_CONFIG` | Overrides the config file path only. |
| Config file | `~/.lupin/config.json`: profiles, slots, the active profile, the port, the localToken. Read directly, never written by the TUI. |
| Log file | `~/.lupin/lupin.log`: the recent-requests tail. Only the last 64 KB are read, and a partial first line is dropped. |
| Control API | `http://127.0.0.1:<port>/v1/lupin/*`, guarded by the config's `localToken` (401 without it). |

## Fallback behaviour

| Situation | What happens |
|---|---|
| Sidecar not on the PATH | bare `lupin` prints status plus the next steps; `lupin top` still works with no sidecar |
| Not a terminal (piped) | bare `lupin` prints the text status, never a repainting screen in a pipe |
| Daemon down | the header says `daemon DOWN`, health and "serving now" show as unknown, the screen keeps working |
| No config | `no config yet: run \`lupin init\` first`, exit 1 |

## Troubleshooting

- **`lupin` does not open the TUI**: the sidecar is not on the PATH or stdout is not a terminal. Check `lupin-tui --version`; if it errors, the binary is not reachable. The text fallback is the intended behaviour, not a failure.
- **Build fails with `linker link.exe not found` or `cannot open input file 'kernel32.lib'` (Windows)**: the MSVC Build Tools or the Windows SDK are missing. Install them, then build with `build-msvc.bat --release`.
- **A switch does not move the active profile**: the daemon is down (the control API is unreachable) or returned an error. The talking line says which of the two it was; start the daemon with `lupin run -- claude`.
- **`401 invalid local token`**: the config's `localToken` changed while the daemon kept running with the old one. Restart the daemon.
