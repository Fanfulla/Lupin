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

When bare `lupin` runs in a real terminal with the sidecar on the PATH, a
missing config starts the native add-provider flow. Direct `lupin-tui` still
needs either a config or the bootstrap identity supplied by the hub. Every
connection stays on 127.0.0.1.

## First provider on a cold start

```sh
lupin
```

With no config, the hub starts a temporary empty-profile daemon and the TUI
fetches the hosted-provider catalogue from `GET /v1/lupin/providers`.

1. Select a provider with arrows or `j` / `k` and press `Enter`.
2. `API key` rows open a masked field. Failed verification saves neither the
   key nor a profile and returns to the existing list for retry.
3. `OAuth` rows start an asynchronous login job. The TUI displays the browser
   URL and polls until completion, denial, timeout or network failure.
4. A provider carrying account-suspension risk shows the warning first and
   requires explicit confirmation.
5. On success, the daemon persists the first profile with its existing port
   and local token. The TUI refreshes into the normal dashboard without losing
   the connection.

Since ADR-51 the screen is the whole setup surface, hosted and local alike:

- `local` rows (Ollama, LM Studio, llama.cpp, ds4) run the live discovery
  through `POST /v1/lupin/discover-local`: every chat model is listed with its
  window (a `max` suffix when the number is only the declared maximum), a
  "no tools" warning and a "context too small" verdict. Pick the main model,
  then the light one (enter reuses the main); the vision and long-context
  routes are offered only when the discovery justifies them, default no. A
  server that is down answers with its start command and a retry key.
- `API key` rows offer the economy preset when the catalogue row carries one,
  and a failed verification shows the provider's error with an explicit
  "save anyway" choice (default no): nothing is stored without it.
- `OAuth` rows offer the official-CLI credential import when the row says one
  exists, and take an optional account label (`[A-Za-z0-9._-]{1,32}`) so a
  second account of the same provider gets its own profile (§4nonies).
- A failover offer appears after any setup when at least one other profile
  exists (default none).

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
│⣀⣤⣶⣾⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀  L U P I N  v0.2.5   the gentleman router
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
| `agent:<name>` | an agent route served this request (SPEC-PROVIDERS §4decies); `agent:unknown:<name>` means the id named a route the config does not have, served on the normal path |

## Keys

| Key | Action |
|---|---|
| `q` / `Esc` | quit from the dashboard; onboarding uses them as context-specific exit or cancel keys |
| `Ctrl-C` | global exit from every dashboard and onboarding state |
| `1` - `9` | switch the active profile to the row carrying that number |
| `↑` / `↓` (or `k` / `j`) | move the cursor over the profile rows (the highlighted row) |
| `Enter` | switch the active profile to the row under the cursor |
| `r` | refresh now, without waiting for the next tick |
| `d` | run the doctor for the highlighted profile and stream its output in the job panel |
| `:` | open the command palette for `doctor`, `usage`, `list`, `status` and `stop`; `run` remains shell-only |
| `o` | order mode: type the profile numbers in the order automatic switches should follow (previewed by name in the status line), `Enter` applies, `Esc` cancels |
| `a` | agents mode: aim the per-subagent routes (SPEC-PROVIDERS §4decies). `↑`/`↓` pick a route, `1`-`9` aim it at that profile, `x` clears it, `Enter` applies, `Esc` cancels |

Onboarding is modal. `q` exits loading, provider selection, risk confirmation,
OAuth waiting, errors and success. In the masked API-key field `q` is ordinary
text, so `Ctrl-C` is the global exit and the footer says so explicitly.

The `1`-`9` hotkeys act immediately; the cursor path is two-step on purpose, so
scrolling the list never fires a switch by accident. The cursor stays on a real
row: when the profile list shrinks it clamps back into range.

Agents mode (ADR-47) edits the `agents` table through one atomic control call
(`POST /v1/lupin/agents`): the rows are the configured agent routes, with the
conventional `subagents` row always shown (even when unset) so the first-use
gesture exists on screen. `1`-`9` on a row writes the delegation to that
profile, `x` clears the row, `Enter` applies the whole table at once, `Esc`
throws the edit away. Model-string targets and new route names are CLI gestures
(`lupin agents set`), and the status line says so when a key cannot do it.

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
| Config file | `~/.lupin/config.json`: profiles, slots, the active profile, the port, the localToken. Read directly, never written by the Rust process; onboarding asks the Node control API to write it. |
| Log file | `~/.lupin/lupin.log`: the recent-requests tail. Only the last 64 KB are read, and a partial first line is dropped. |
| Control API | `http://127.0.0.1:<port>/v1/lupin/*`, guarded by the config's `localToken` (401 without it). |
| Bootstrap identity | `LUPIN_BOOTSTRAP_PORT` plus `LUPIN_BOOTSTRAP_TOKEN`, supplied only by bare `lupin` while no config exists. A normal config takes precedence. |

## Fallback behaviour

| Situation | What happens |
|---|---|
| Sidecar not on the PATH | bare `lupin` prints status plus the next steps; `lupin top` still works with no sidecar |
| Not a terminal (piped) | bare `lupin` prints the text status, never a repainting screen in a pipe |
| Daemon down | the header says `daemon DOWN`, health and "serving now" show as unknown, the screen keeps working |
| No config, TTY and sidecar available | bare `lupin` starts the bootstrap daemon and opens add-provider |
| No config without a TTY or sidecar | the text fallback points at the control API (README §Headless setup); no repainting UI is attempted |
| Direct `lupin-tui` without config or bootstrap identity | exits honestly because it has no authenticated daemon identity |

## Troubleshooting

- **`lupin` does not open the TUI**: the sidecar is not on the PATH or stdout is not a terminal. Check `lupin-tui --version`; if it errors, the binary is not reachable. The text fallback is the intended behaviour, not a failure.
- **Build fails with `linker link.exe not found` or `cannot open input file 'kernel32.lib'` (Windows)**: the MSVC Build Tools or the Windows SDK are missing. Install them, then build with `build-msvc.bat --release`.
- **An API key is rejected**: the masked field stays retryable and nothing is saved unless you take the explicit save-anyway choice the error screen offers. Check the provider account, key scope and endpoint first.
- **The OAuth browser does not open**: copy the URL displayed by the TUI into a browser. The login job keeps polling in the terminal.
- **`daemon not answering: restart with \`lupin\`` during onboarding**: exit and run bare `lupin` again. There is no configured session for `lupin run -- claude` to repair yet.
- **A switch does not move the active profile**: the daemon is down (the control API is unreachable) or returned an error. The talking line says which of the two it was; start the daemon with `lupin run -- claude`.
- **`401 invalid local token`**: the config's `localToken` changed while the daemon kept running with the old one. Restart the daemon.
