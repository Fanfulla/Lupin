// lupin-tui: the optional terminal hub for the Lupin proxy
// (DESIGN-OAUTH-PKCE-TUI section 2). It is a sidecar: the core proxy is pure
// Node and never depends on this binary. The TUI reads the local config and
// log (they are on the same machine) and calls the loopback control API for
// everything that changes state, so the config file stays the single writer
// and the daemon's hot-reload watch the single reload trigger.
//
// v1 scope: profiles + slots + health + lastDoctor, "serving now" from
// /health, the recent-requests log tail, and the one action worth having on
// the main screen (1-9 switches the active profile through POST /v1/lupin/use).

mod api;
mod config;
mod job;
mod logtail;
mod ui;

use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io;
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_secs(1);

pub(crate) enum AddProviderMode {
    Loading,
    List {
        providers: Vec<api::ProviderRow>,
        cursor: usize,
    },
    ConfirmRisk {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
    },
    KeyInput {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        value: String,
    },
    OAuthWaiting {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        job: String,
        url: Option<String>,
    },
    Success(String),
    Error {
        message: String,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        return_to_list: bool,
    },
}

fn main() -> io::Result<()> {
    // --version / no-config short-circuits, kept out of the alternate screen.
    if std::env::args().any(|a| a == "--version" || a == "-V") {
        println!("lupin-tui {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let bootstrap_identity = config::bootstrap_identity_from_env();
    let cfg_path = match config::default_config_path() {
        Some(p) => p,
        None if bootstrap_identity.is_some() => std::path::PathBuf::new(),
        None => {
            eprintln!("no config yet: run `lupin init` first");
            std::process::exit(1);
        }
    };
    if config::load(&cfg_path).is_err() && bootstrap_identity.is_none() {
        eprintln!("no config yet: run `lupin init` first");
        std::process::exit(1);
    }

    // A panic mid-draw must not strand the terminal in raw mode inside the
    // alternate screen: restore FIRST, then let the default hook print the
    // message somewhere it can actually be read (audit 2026-07-29).
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
        default_hook(info);
    }));

    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen)?;

    // Restore runs on the error paths too (Terminal::new included), and a
    // failed restore never shadows the real error.
    let result = Terminal::new(CrosstermBackend::new(stdout))
        .and_then(|mut t| run(&mut t, &cfg_path, bootstrap_identity.as_ref()));
    let _ = disable_raw_mode();
    let _ = execute!(io::stdout(), LeaveAlternateScreen);
    result
}

fn run(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    cfg_path: &std::path::Path,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
) -> io::Result<()> {
    let mut last = Instant::now() - REFRESH;
    let mut snap = api::snapshot(cfg_path, bootstrap_identity);
    // The talking line: the dashboard narrates what it just did, so an action
    // and its outcome are never invisible.
    let mut message = String::from(
        "ready: 1-9 or arrows+enter switch the active profile, `lupin use` shows up here too",
    );
    // The highlighted profile row: arrows move it, Enter activates the switch.
    // Kept in range of the visible rows; a switch leaves it where it was.
    let mut selected: usize = 0;
    // Order mode (ADR-34): Some(picked row indexes) while the user is typing
    // the automatic-switch order, None otherwise. While it is on, the digit
    // keys build the chain instead of switching.
    let mut order: Option<Vec<usize>> = None;
    // A running CLI command (doctor and friends) and its output, or None. The
    // dashboard keeps repainting while it runs: that is the whole point.
    let mut job: Option<job::Job> = None;
    let mut palette = false;
    // Agents mode (ADR-47): Some(edit) while the user is aiming the per-agent
    // routes, None otherwise. Applied atomically through the control API on
    // Enter, thrown away on Esc.
    let mut agents_edit: Option<ui::AgentsEdit> = None;
    let mut add_provider = needs_provider(&snap).then_some(AddProviderMode::Loading);
    loop {
        if last.elapsed() >= REFRESH {
            snap = api::snapshot(cfg_path, bootstrap_identity);
            poll_provider_login(
                &mut add_provider,
                &mut snap,
                cfg_path,
                bootstrap_identity,
                &mut message,
            );
            if matches!(add_provider, Some(AddProviderMode::Success(_))) && !needs_provider(&snap) {
                add_provider = None;
                message = "provider added".to_string();
            }
            last = Instant::now();
        }
        // Drained every tick, before the draw, so the panel shows what arrived.
        if let Some(j) = job.as_mut() {
            let was_running = j.running();
            j.poll();
            if was_running && !j.running() {
                message = match j.finished {
                    Some(true) => format!("{} finished (esc closes)", j.label),
                    _ => format!("{} failed (esc closes)", j.label),
                };
                snap = api::snapshot(cfg_path, bootstrap_identity);
                last = Instant::now();
            }
        }
        clamp_selected(&mut selected, snap.profile_names.len());
        terminal.draw(|f| {
            ui::render(
                f,
                &snap,
                &message,
                selected,
                job.as_ref(),
                palette,
                agents_edit.as_ref(),
                add_provider.as_ref(),
            )
        })?;
        if matches!(add_provider, Some(AddProviderMode::Loading)) {
            add_provider = Some(load_providers(&snap, bootstrap_identity));
            continue;
        }

        // Poll input with a short timeout so the repaint cadence is steady.
        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                if let Some(mode) = add_provider.take() {
                    match handle_add_provider_key(
                        mode,
                        key.code,
                        &snap,
                        bootstrap_identity,
                        cfg_path,
                        &mut message,
                    ) {
                        AddProviderAction::Stay(mode) => add_provider = Some(mode),
                        AddProviderAction::Dashboard(new_snap) => snap = new_snap,
                        AddProviderAction::Exit => return Ok(()),
                    }
                    continue;
                }
                // The palette swallows its keys first, like order mode: a
                // letter here picks a command, it does not fall through.
                if palette {
                    match key.code {
                        KeyCode::Esc => {
                            palette = false;
                            message = "palette closed".to_string();
                        }
                        KeyCode::Char(c) => {
                            palette = false;
                            match job::palette_entry(c) {
                                None => message = format!("no command on \"{c}\""),
                                Some(e) if !e.runnable() => {
                                    message = format!("{}: {}", e.label, e.why_not);
                                }
                                Some(e) => {
                                    let mut args: Vec<String> =
                                        e.args.iter().map(|a| (*a).to_string()).collect();
                                    // The doctor grades a profile, and the one
                                    // on screen is the one the user means.
                                    if e.args.first() == Some(&"doctor") {
                                        if let Some(name) = snap.profile_names.get(selected) {
                                            args.push(name.clone());
                                        }
                                    }
                                    message = start_job(&mut job, e.label, &args);
                                }
                            }
                        }
                        _ => {}
                    }
                    continue;
                }
                // While a job is on screen, esc closes it and everything else
                // still works: the dashboard never stops being a dashboard.
                if job.is_some() && key.code == KeyCode::Esc {
                    let running = job.as_ref().is_some_and(job::Job::running);
                    job = None;
                    message = if running {
                        "closed the panel: the command keeps running".to_string()
                    } else {
                        "ready".to_string()
                    };
                    continue;
                }
                // Order mode swallows its own keys FIRST: a digit here must
                // build the chain, never fire an immediate switch.
                if let Some(picked) = order.as_mut() {
                    match key.code {
                        KeyCode::Esc => {
                            order = None;
                            message = "order cancelled".to_string();
                        }
                        KeyCode::Enter => {
                            if picked.len() < 2 {
                                message = "the order needs at least two profiles (esc cancels)"
                                    .to_string();
                            } else {
                                let names: Vec<String> = picked
                                    .iter()
                                    .filter_map(|i| snap.profile_names.get(*i).cloned())
                                    .collect();
                                message = match api::set_switch_order(&snap, &names) {
                                    Ok(()) => format!("switch order: {}", names.join(" -> ")),
                                    Err(e) => format!("switch order failed: {e}"),
                                };
                                order = None;
                                snap = api::snapshot(cfg_path, bootstrap_identity);
                                last = Instant::now();
                            }
                        }
                        KeyCode::Char(d) if d.is_ascii_digit() && d != '0' => {
                            let idx = (d as usize) - ('1' as usize);
                            message = match push_pick(picked, idx, snap.profile_names.len()) {
                                Ok(()) => order_message(&snap.profile_names, picked),
                                Err(e) => e,
                            };
                        }
                        _ => {}
                    }
                    continue;
                }
                // Agents mode swallows its own keys the same way: a digit here
                // aims the selected route, never switches the active profile.
                if let Some(edit) = agents_edit.as_mut() {
                    match key.code {
                        KeyCode::Esc => {
                            agents_edit = None;
                            message = "agents cancelled".to_string();
                        }
                        KeyCode::Up | KeyCode::Char('k') => {
                            edit.cursor = edit.cursor.saturating_sub(1);
                        }
                        KeyCode::Down | KeyCode::Char('j') => {
                            if edit.cursor + 1 < edit.rows.len() {
                                edit.cursor += 1;
                            }
                        }
                        KeyCode::Char('x') => {
                            if let Some(row) = edit.rows.get_mut(edit.cursor) {
                                row.1 = None;
                                message = format!("{}: unset (enter applies)", row.0);
                            }
                        }
                        KeyCode::Char(d) if d.is_ascii_digit() && d != '0' => {
                            let idx = (d as usize) - ('1' as usize);
                            match snap.profile_names.get(idx).cloned() {
                                // Words, never silence: a swallowed keypress is
                                // indistinguishable from a broken keyboard.
                                None => message = format!("there is no profile {}", idx + 1),
                                Some(name) => {
                                    if let Some(row) = edit.rows.get_mut(edit.cursor) {
                                        row.1 = Some(serde_json::json!({ "profile": name }));
                                        message = format!(
                                            "{} -> {name} (enter applies, esc cancels)",
                                            row.0
                                        );
                                    }
                                }
                            }
                        }
                        KeyCode::Enter => {
                            let table = agents_table(&edit.rows);
                            message = match api::set_agents(&snap, &table) {
                                Ok(()) if table.is_empty() => "agent routes cleared".to_string(),
                                Ok(()) => format!("agent routes applied ({})", table.len()),
                                Err(e) => format!("agent routes failed: {e}"),
                            };
                            agents_edit = None;
                            snap = api::snapshot(cfg_path, bootstrap_identity);
                            last = Instant::now();
                        }
                        _ => {}
                    }
                    continue;
                }
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                    KeyCode::Char('d') => {
                        let mut args = vec!["doctor".to_string()];
                        if let Some(name) = snap.profile_names.get(selected) {
                            args.push(name.clone());
                        }
                        message = start_job(&mut job, "doctor", &args);
                    }
                    KeyCode::Char(':') => {
                        palette = true;
                        message = "palette: pick a command by its letter, esc closes".to_string();
                    }
                    KeyCode::Char('o') => {
                        order = Some(Vec::new());
                        message =
                            "order mode: type the profile numbers in the order automatic switches should follow, enter applies, esc cancels"
                                .to_string();
                    }
                    KeyCode::Char('a') => {
                        agents_edit = Some(ui::AgentsEdit {
                            rows: agent_rows(snap.config.as_ref()),
                            cursor: 0,
                        });
                        message =
                            "agents mode: 1-9 aims the selected route at a profile, x clears, enter applies, esc cancels"
                                .to_string();
                    }
                    KeyCode::Char('c') if key.modifiers.contains(event::KeyModifiers::CONTROL) => {
                        return Ok(())
                    }
                    KeyCode::Char('r') => {
                        snap = api::snapshot(cfg_path, bootstrap_identity);
                        last = Instant::now();
                        message = "refreshed".to_string();
                    }
                    KeyCode::Up | KeyCode::Char('k') => {
                        selected = selected.saturating_sub(1);
                    }
                    KeyCode::Down | KeyCode::Char('j') => {
                        selected = selected.saturating_add(1);
                        clamp_selected(&mut selected, snap.profile_names.len());
                    }
                    KeyCode::Enter => {
                        if let Some(name) = snap.profile_names.get(selected).cloned() {
                            // Same control-API write as the 1-9 hotkey.
                            message = match api::switch_profile(&snap, &name) {
                                Ok(()) => format!("active profile -> {name}"),
                                Err(e) => format!("switch to {name} failed: {e}"),
                            };
                            snap = api::snapshot(cfg_path, bootstrap_identity);
                            last = Instant::now();
                        }
                    }
                    KeyCode::Char(d) if d.is_ascii_digit() && d != '0' => {
                        let index = (d as usize) - ('1' as usize);
                        if let Some(name) = snap.profile_names.get(index).cloned() {
                            // The switch goes through the control API: the
                            // daemon writes the config and hot-reloads it.
                            message = match api::switch_profile(&snap, &name) {
                                Ok(()) => format!("active profile -> {name}"),
                                Err(e) => format!("switch to {name} failed: {e}"),
                            };
                            snap = api::snapshot(cfg_path, bootstrap_identity);
                            last = Instant::now();
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

enum AddProviderAction {
    Stay(AddProviderMode),
    Dashboard(api::Snapshot),
    Exit,
}

fn needs_provider(snap: &api::Snapshot) -> bool {
    snap.config
        .as_ref()
        .is_none_or(|config| config.profiles.is_empty())
}

fn onboarding_identity(
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
) -> Option<config::BootstrapIdentity> {
    snap.config
        .as_ref()
        .map(|config| config::BootstrapIdentity {
            port: config.port,
            local_token: config.local_token.clone(),
        })
        .or_else(|| bootstrap_identity.cloned())
}

fn onboarding_error(error: String) -> String {
    if error.starts_with("daemon not answering") {
        "daemon not answering: restart with `lupin`".to_string()
    } else {
        error
    }
}

fn load_providers(
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
) -> AddProviderMode {
    let Some(identity) = onboarding_identity(snap, bootstrap_identity) else {
        return AddProviderMode::Error {
            message: "daemon not answering: restart with `lupin`".to_string(),
            providers: Vec::new(),
            cursor: 0,
            return_to_list: false,
        };
    };
    match api::fetch_providers(&identity) {
        Ok(providers) => AddProviderMode::List {
            providers,
            cursor: 0,
        },
        Err(error) => AddProviderMode::Error {
            message: onboarding_error(error),
            providers: Vec::new(),
            cursor: 0,
            return_to_list: false,
        },
    }
}

fn start_provider_login(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    accept_risk: bool,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
) -> AddProviderMode {
    let Some(identity) = onboarding_identity(snap, bootstrap_identity) else {
        return AddProviderMode::Error {
            message: "daemon not answering: restart with `lupin`".to_string(),
            providers,
            cursor,
            return_to_list: true,
        };
    };
    match api::start_login(&identity, &provider.id, accept_risk) {
        Ok(job) => AddProviderMode::OAuthWaiting {
            provider,
            providers,
            cursor,
            job,
            url: None,
        },
        Err(error) => AddProviderMode::Error {
            message: onboarding_error(error),
            providers,
            cursor,
            return_to_list: true,
        },
    }
}

fn clear_cancelled_key(value: &mut String) {
    value.clear();
}

fn redact_key_from_error(error: &str, key: &str) -> String {
    if key.is_empty() {
        error.to_string()
    } else {
        error.replace(key, "********")
    }
}

fn submit_provider_key(
    provider_id: &str,
    value: &mut String,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
) -> Result<(), String> {
    let result = onboarding_identity(snap, bootstrap_identity)
        .ok_or_else(|| "daemon not answering: restart with `lupin`".to_string())
        .and_then(|identity| api::setup_key(&identity, provider_id, value))
        .map_err(|error| redact_key_from_error(&error, value));
    value.clear();
    result
}

fn handle_add_provider_key(
    mode: AddProviderMode,
    key: KeyCode,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    match mode {
        AddProviderMode::Loading => AddProviderAction::Stay(AddProviderMode::Loading),
        AddProviderMode::List {
            providers,
            mut cursor,
        } => match key {
            KeyCode::Esc => AddProviderAction::Exit,
            KeyCode::Up | KeyCode::Char('k') => {
                cursor = cursor.saturating_sub(1);
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if cursor + 1 < providers.len() {
                    cursor += 1;
                }
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Enter => {
                let Some(provider) = providers.get(cursor).cloned() else {
                    return AddProviderAction::Stay(AddProviderMode::List { providers, cursor });
                };
                match provider.auth_kind {
                    api::AuthKind::Key => AddProviderAction::Stay(AddProviderMode::KeyInput {
                        provider,
                        providers,
                        cursor,
                        value: String::new(),
                    }),
                    api::AuthKind::Oauth if provider.suspension_warning.is_some() => {
                        AddProviderAction::Stay(AddProviderMode::ConfirmRisk {
                            provider,
                            providers,
                            cursor,
                        })
                    }
                    api::AuthKind::Oauth => AddProviderAction::Stay(start_provider_login(
                        provider,
                        providers,
                        cursor,
                        false,
                        snap,
                        bootstrap_identity,
                    )),
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::List { providers, cursor }),
        },
        AddProviderMode::ConfirmRisk {
            provider,
            providers,
            cursor,
        } => match key {
            KeyCode::Enter => AddProviderAction::Stay(start_provider_login(
                provider,
                providers,
                cursor,
                true,
                snap,
                bootstrap_identity,
            )),
            KeyCode::Esc => {
                *message = "OAuth login cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            _ => AddProviderAction::Stay(AddProviderMode::ConfirmRisk {
                provider,
                providers,
                cursor,
            }),
        },
        AddProviderMode::KeyInput {
            provider,
            providers,
            cursor,
            mut value,
        } => match key {
            KeyCode::Esc => {
                clear_cancelled_key(&mut value);
                *message = "API key entry cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Backspace => {
                value.pop();
                AddProviderAction::Stay(AddProviderMode::KeyInput {
                    provider,
                    providers,
                    cursor,
                    value,
                })
            }
            KeyCode::Char(character) => {
                value.push(character);
                AddProviderAction::Stay(AddProviderMode::KeyInput {
                    provider,
                    providers,
                    cursor,
                    value,
                })
            }
            KeyCode::Enter => {
                let result =
                    submit_provider_key(&provider.id, &mut value, snap, bootstrap_identity);
                match result {
                    Ok(()) => {
                        let refreshed = api::snapshot(cfg_path, bootstrap_identity);
                        *message = "provider added".to_string();
                        if needs_provider(&refreshed) {
                            AddProviderAction::Stay(AddProviderMode::Success(
                                "provider added".to_string(),
                            ))
                        } else {
                            AddProviderAction::Dashboard(refreshed)
                        }
                    }
                    Err(error) => AddProviderAction::Stay(AddProviderMode::Error {
                        message: onboarding_error(error),
                        providers,
                        cursor,
                        return_to_list: true,
                    }),
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::KeyInput {
                provider,
                providers,
                cursor,
                value,
            }),
        },
        AddProviderMode::OAuthWaiting {
            provider,
            providers,
            cursor,
            job,
            url,
        } => match key {
            KeyCode::Esc => {
                *message = "OAuth login hidden; the daemon may still finish it".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            _ => AddProviderAction::Stay(AddProviderMode::OAuthWaiting {
                provider,
                providers,
                cursor,
                job,
                url,
            }),
        },
        AddProviderMode::Success(message_text) => {
            AddProviderAction::Stay(AddProviderMode::Success(message_text))
        }
        AddProviderMode::Error {
            message: error,
            providers,
            cursor,
            return_to_list,
        } => match key {
            KeyCode::Enter | KeyCode::Esc if return_to_list => {
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Esc => AddProviderAction::Exit,
            _ => AddProviderAction::Stay(AddProviderMode::Error {
                message: error,
                providers,
                cursor,
                return_to_list,
            }),
        },
    }
}

fn poll_provider_login(
    add_provider: &mut Option<AddProviderMode>,
    snap: &mut api::Snapshot,
    cfg_path: &std::path::Path,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    message: &mut String,
) {
    let Some(AddProviderMode::OAuthWaiting { .. }) = add_provider else {
        return;
    };
    let Some(AddProviderMode::OAuthWaiting {
        provider,
        providers,
        cursor,
        job,
        mut url,
    }) = add_provider.take()
    else {
        return;
    };
    let result = onboarding_identity(snap, bootstrap_identity)
        .ok_or_else(|| "daemon not answering: restart with `lupin`".to_string())
        .and_then(|identity| api::poll_login(&identity, &job));
    *add_provider = Some(match result {
        Ok(poll) if poll.status == api::LoginStatus::Pending => {
            if poll.message.is_some() {
                url = poll.message;
            }
            AddProviderMode::OAuthWaiting {
                provider,
                providers,
                cursor,
                job,
                url,
            }
        }
        Ok(poll) if poll.status == api::LoginStatus::Done => {
            *snap = api::snapshot(cfg_path, bootstrap_identity);
            *message = "provider added".to_string();
            if needs_provider(snap) {
                AddProviderMode::Success("provider added".to_string())
            } else {
                *add_provider = None;
                return;
            }
        }
        Ok(poll) => AddProviderMode::Error {
            message: poll
                .error
                .or(poll.message)
                .unwrap_or_else(|| "login failed".to_string()),
            providers,
            cursor,
            return_to_list: true,
        },
        Err(error) => AddProviderMode::Error {
            message: onboarding_error(error),
            providers,
            cursor,
            return_to_list: true,
        },
    });
}

/// Start a CLI command, or say why it could not start. A dashboard that shows
/// an empty panel when the binary is missing is worse than one that says so.
fn start_job(slot: &mut Option<job::Job>, label: &str, args: &[String]) -> String {
    if slot.as_ref().is_some_and(job::Job::running) {
        return "a command is already running (esc closes the panel)".to_string();
    }
    let Some(launcher) = job::find_lupin() else {
        return "`lupin` is not on PATH: install it with `npm i -g lupin-code`".to_string();
    };
    match job::Job::spawn(&launcher, label, args) {
        Ok(j) => {
            *slot = Some(j);
            format!("{label} running: it keeps refreshing, esc closes the panel")
        }
        Err(e) => format!("could not start {label}: {e}"),
    }
}

/// One picked row for the order chain: out of range and duplicates come back
/// as words for the talking line, never as silence (a swallowed keypress is
/// indistinguishable from a broken keyboard).
fn push_pick(picked: &mut Vec<usize>, idx: usize, len: usize) -> Result<(), String> {
    if idx >= len {
        return Err(format!("there is no profile {}", idx + 1));
    }
    if picked.contains(&idx) {
        return Err("a profile cannot appear twice in the order".to_string());
    }
    picked.push(idx);
    Ok(())
}

/// The chain typed so far, previewed by name: the user confirms what they see,
/// not what they remember pressing.
fn order_message(names: &[String], picked: &[usize]) -> String {
    let chain: Vec<&str> = picked
        .iter()
        .filter_map(|i| names.get(*i).map(|s| s.as_str()))
        .collect();
    format!("order: {} (enter applies, esc cancels)", chain.join(" -> "))
}

/// The conventional blanket route (SPEC-PROVIDERS section 4decies): shown even
/// when unset, so the first-use gesture exists on screen.
const SUBAGENTS_ROUTE: &str = "subagents";

/// The rows agents mode edits: every configured route, plus the conventional
/// `subagents` one when absent. Config order (alphabetical) is kept.
fn agent_rows(config: Option<&config::LupinConfig>) -> Vec<(String, Option<serde_json::Value>)> {
    let mut rows: Vec<(String, Option<serde_json::Value>)> = config
        .map(|c| {
            c.agents
                .iter()
                .map(|(k, v)| (k.clone(), Some(v.clone())))
                .collect()
        })
        .unwrap_or_default();
    if !rows.iter().any(|(n, _)| n == SUBAGENTS_ROUTE) {
        rows.push((SUBAGENTS_ROUTE.to_string(), None));
    }
    rows
}

/// What Enter applies: the rows that still have a target. An unset row is a
/// removal, and an empty table turns the feature off (the daemon drops the key).
fn agents_table(
    rows: &[(String, Option<serde_json::Value>)],
) -> std::collections::BTreeMap<String, serde_json::Value> {
    rows.iter()
        .filter_map(|(n, t)| t.clone().map(|t| (n.clone(), t)))
        .collect()
}

/// Keeps the cursor on a real row when the profile list shrinks (a profile
/// removed elsewhere, or the first draw before any config): never highlights a
/// row that does not exist, and stays at 0 on an empty list.
fn clamp_selected(selected: &mut usize, len: usize) {
    if len == 0 {
        *selected = 0;
    } else if *selected >= len {
        *selected = len - 1;
    }
}

#[cfg(test)]
mod tests {
    use super::{
        agent_rows, agents_table, clamp_selected, clear_cancelled_key, handle_add_provider_key,
        onboarding_error, order_message, push_pick, redact_key_from_error, submit_provider_key,
        AddProviderAction, AddProviderMode,
    };
    use crate::api::{AuthKind, ProviderRow, Snapshot};
    use crossterm::event::KeyCode;

    fn empty_snapshot() -> Snapshot {
        Snapshot {
            config: None,
            health: None,
            recent: Vec::new(),
            profile_names: Vec::new(),
        }
    }

    fn provider(auth_kind: AuthKind) -> ProviderRow {
        ProviderRow {
            id: "catalogue-row".to_string(),
            description: "Catalogue Row".to_string(),
            auth_kind,
            suspension_warning: None,
        }
    }

    fn route(mode: AddProviderMode, key: KeyCode) -> AddProviderAction {
        handle_add_provider_key(
            mode,
            key,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        )
    }

    fn stayed_mode(action: AddProviderAction) -> AddProviderMode {
        let AddProviderAction::Stay(mode) = action else {
            panic!("onboarding must stay active");
        };
        mode
    }

    #[test]
    fn delayed_success_keys_never_exit_the_tui() {
        for key in [KeyCode::Enter, KeyCode::Esc] {
            assert!(matches!(
                route(AddProviderMode::Success("provider added".to_string()), key),
                AddProviderAction::Stay(AddProviderMode::Success(_))
            ));
        }
    }

    #[test]
    fn risk_cancel_restores_the_existing_catalogue_and_cursor() {
        let key_row = provider(AuthKind::Key);
        let mut oauth_row = provider(AuthKind::Oauth);
        oauth_row.suspension_warning = Some("Account suspension risk".to_string());
        let confirmation = stayed_mode(route(
            AddProviderMode::List {
                providers: vec![key_row, oauth_row],
                cursor: 1,
            },
            KeyCode::Enter,
        ));
        let cancelled = stayed_mode(route(confirmation, KeyCode::Esc));
        let AddProviderMode::List { providers, cursor } = cancelled else {
            panic!("risk cancel must restore the catalogue");
        };
        assert_eq!(providers.len(), 2);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn key_cancel_restores_the_existing_catalogue_and_cursor() {
        let input = stayed_mode(route(
            AddProviderMode::List {
                providers: vec![provider(AuthKind::Oauth), provider(AuthKind::Key)],
                cursor: 1,
            },
            KeyCode::Enter,
        ));
        let input = stayed_mode(route(input, KeyCode::Char('s')));
        let cancelled = stayed_mode(route(input, KeyCode::Esc));
        let AddProviderMode::List { providers, cursor } = cancelled else {
            panic!("key cancel must restore the catalogue");
        };
        assert_eq!(providers.len(), 2);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn oauth_cancel_restores_the_existing_catalogue_and_cursor() {
        let oauth_row = provider(AuthKind::Oauth);
        let cancelled = stayed_mode(route(
            AddProviderMode::OAuthWaiting {
                provider: oauth_row.clone(),
                providers: vec![provider(AuthKind::Key), oauth_row],
                cursor: 1,
                job: "job-7".to_string(),
                url: Some("https://auth.example/start".to_string()),
            },
            KeyCode::Esc,
        ));
        let AddProviderMode::List { providers, cursor } = cancelled else {
            panic!("OAuth cancel must restore the catalogue");
        };
        assert_eq!(providers.len(), 2);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn retryable_error_acknowledgement_restores_the_existing_catalogue() {
        let error = stayed_mode(route(
            AddProviderMode::List {
                providers: vec![provider(AuthKind::Oauth), provider(AuthKind::Key)],
                cursor: 0,
            },
            KeyCode::Enter,
        ));
        assert!(matches!(error, AddProviderMode::Error { .. }));
        let acknowledged = stayed_mode(route(error, KeyCode::Enter));
        let AddProviderMode::List { providers, cursor } = acknowledged else {
            panic!("error acknowledgement must restore the catalogue");
        };
        assert_eq!(providers.len(), 2);
        assert_eq!(cursor, 0);
    }

    #[test]
    fn cancelling_key_entry_clears_the_sensitive_buffer() {
        let mut value = "secret-value".to_string();
        clear_cancelled_key(&mut value);
        assert!(value.is_empty());
    }

    #[test]
    fn failed_key_submission_clears_the_sensitive_buffer() {
        let snap = empty_snapshot();
        let mut value = "secret-value".to_string();
        assert_eq!(
            submit_provider_key("catalogue-key", &mut value, &snap, None),
            Err("daemon not answering: restart with `lupin`".to_string())
        );
        assert!(value.is_empty());
    }

    #[test]
    fn daemon_errors_cannot_echo_the_submitted_key() {
        assert_eq!(
            redact_key_from_error("invalid key: secret-value", "secret-value"),
            "invalid key: ********"
        );
    }

    #[test]
    fn oauth_warning_enters_confirmation_without_starting_login() {
        let mut row = provider(AuthKind::Oauth);
        row.suspension_warning = Some("Account suspension risk".to_string());
        let action = handle_add_provider_key(
            AddProviderMode::List {
                providers: vec![row],
                cursor: 0,
            },
            KeyCode::Enter,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        );
        assert!(matches!(
            action,
            AddProviderAction::Stay(AddProviderMode::ConfirmRisk { .. })
        ));
    }

    #[test]
    fn backspace_removes_one_unicode_scalar_from_key_input() {
        let action = handle_add_provider_key(
            AddProviderMode::KeyInput {
                provider: provider(AuthKind::Key),
                providers: Vec::new(),
                cursor: 0,
                value: "clé🔑".to_string(),
            },
            KeyCode::Backspace,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        );
        let AddProviderAction::Stay(AddProviderMode::KeyInput { value, .. }) = action else {
            panic!("key input must stay active");
        };
        assert_eq!(value, "clé");
    }

    #[test]
    fn onboarding_transport_errors_use_bootstrap_restart_guidance() {
        assert_eq!(
            onboarding_error("daemon not answering (old guidance)".to_string()),
            "daemon not answering: restart with `lupin`"
        );
    }

    #[test]
    fn a_pick_out_of_range_or_repeated_answers_in_words() {
        let names = ["a", "b", "c"].map(String::from);
        let mut picked = Vec::new();
        assert!(push_pick(&mut picked, 0, names.len()).is_ok());
        assert!(push_pick(&mut picked, 2, names.len()).is_ok());
        assert_eq!(
            push_pick(&mut picked, 0, names.len()),
            Err("a profile cannot appear twice in the order".to_string()),
        );
        assert_eq!(
            push_pick(&mut picked, 7, names.len()),
            Err("there is no profile 8".to_string()),
        );
        // The refused picks left the chain untouched.
        assert_eq!(
            order_message(&names, &picked),
            "order: a -> c (enter applies, esc cancels)"
        );
    }

    #[test]
    fn the_preview_names_the_chain_in_the_order_typed() {
        let names = ["kimi-sub", "openai-sub"].map(String::from);
        assert_eq!(
            order_message(&names, &[1, 0]),
            "order: openai-sub -> kimi-sub (enter applies, esc cancels)",
        );
    }

    #[test]
    fn the_subagents_row_is_always_on_screen_even_when_unset() {
        // No config at all: the conventional row is still there to aim.
        let rows = agent_rows(None);
        assert_eq!(rows, vec![("subagents".to_string(), None)]);

        // A configured table keeps its rows and gains the conventional one.
        let raw = r#"{
            "activeProfile": "a", "port": 1, "localToken": "t",
            "profiles": {},
            "agents": { "explore": { "profile": "local" }, "planner": "big" }
        }"#;
        let c: crate::config::LupinConfig = serde_json::from_str(raw).expect("parses");
        let rows = agent_rows(Some(&c));
        let names: Vec<&str> = rows.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["explore", "planner", "subagents"]);
        assert_eq!(rows[2].1, None);
    }

    #[test]
    fn enter_applies_only_the_rows_that_still_have_a_target() {
        let rows = vec![
            ("explore".to_string(), Some(serde_json::json!({"profile": "local"}))),
            ("planner".to_string(), None),
        ];
        let table = agents_table(&rows);
        assert_eq!(table.len(), 1);
        assert_eq!(
            table.get("explore"),
            Some(&serde_json::json!({"profile": "local"}))
        );
    }

    #[test]
    fn the_cursor_stays_on_a_real_row() {
        let mut s = 0;
        clamp_selected(&mut s, 3);
        assert_eq!(s, 0, "in range: unchanged");

        let mut s = 5;
        clamp_selected(&mut s, 3);
        assert_eq!(s, 2, "past the end: clamped to the last row");

        let mut s = 4;
        clamp_selected(&mut s, 0);
        assert_eq!(s, 0, "empty list: reset to 0");
    }
}
