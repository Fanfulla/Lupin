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
    // OAuth: import-available rows ask first, every OAuth row then offers an
    // account label, and a suspension warning still gates the login itself.
    OAuthImportConfirm {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
    },
    OAuthAccount {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        import_if_available: bool,
        value: String,
    },
    ConfirmRisk {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        account: Option<String>,
        import_if_available: bool,
    },
    OAuthWaiting {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        job: String,
        url: Option<String>,
    },
    // OAuth logout (reached from a row with `x`, the same catalogue the login
    // gesture already lives on): an optional account label, same field as login.
    LogoutAccount {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        value: String,
    },
    // Key rows: the masked field, then the economy offer (only when the row
    // carries one), then the shared failover offer, then submit.
    KeyInput {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        value: String,
    },
    EconomyChoice {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        key: String,
        economy: bool,
    },
    // A failed connectivity test on a key row offers this escape hatch:
    // nothing is stored unless the user explicitly says so again.
    SaveAnywayConfirm {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        key: String,
        economy: bool,
        failover: Option<String>,
        message: String,
    },
    // Local rows: live discovery, then main/light model picks, then the two
    // opt-in offers (vision, long context), then the shared failover offer.
    LocalDiscoverLoading {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
    },
    LocalDiscoverError {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        message: String,
        start_hint: Option<String>,
    },
    ModelPick {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        models: Vec<api::LocalModel>,
        model_cursor: usize,
        target: ModelPickTarget,
        /// Set once the main model is picked, so the light picker's cursor
        /// can start there: pressing enter without moving reproduces "same
        /// as main" with no separate skip gesture.
        main: Option<String>,
    },
    VisionPick {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        models: Vec<api::LocalModel>,
        main: String,
        light: String,
        /// Candidate model ids (supportsVision, differ from main). Row 0 of
        /// the rendered list is always the synthetic "no route" choice.
        candidates: Vec<String>,
        pick_cursor: usize,
    },
    LongContextConfirm {
        provider: api::ProviderRow,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        main: String,
        light: String,
        vision: Option<String>,
    },
    // Shared by the key and local flows: offered only when another profile
    // already exists, default none (row 0 of the rendered list).
    FailoverOffer {
        pending: PendingSubmit,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        candidates: Vec<String>,
        pick_cursor: usize,
    },
    Success(String),
    Error {
        message: String,
        providers: Vec<api::ProviderRow>,
        cursor: usize,
        return_to_list: bool,
    },
}

pub(crate) enum ModelPickTarget {
    Main,
    Light,
}

/// What the shared failover offer resumes into once a choice is made.
pub(crate) enum PendingSubmit {
    Key {
        provider: api::ProviderRow,
        key: String,
        economy: bool,
    },
    Local {
        provider: api::ProviderRow,
        main: String,
        light: String,
        vision: Option<String>,
        long_context: bool,
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
            eprintln!("no config yet: run `lupin` to add a provider from the hub");
            std::process::exit(1);
        }
    };
    if config::load(&cfg_path).is_err() && bootstrap_identity.is_none() {
        eprintln!("no config yet: run `lupin` to add a provider from the hub");
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
    // Slots editor (`m`): Some(edit) while the three slots of the selected
    // profile are being aimed, None otherwise. Applied on the last Enter.
    let mut slots_edit: Option<ui::SlotsEdit> = None;
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
            promote_success_to_dashboard(&mut add_provider, &snap, &mut message);
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
                slots_edit.as_ref(),
                add_provider.as_ref(),
            )
        })?;
        if matches!(add_provider, Some(AddProviderMode::Loading)) {
            add_provider = Some(load_providers(&snap, bootstrap_identity));
            continue;
        }
        if let Some(AddProviderMode::LocalDiscoverLoading { .. }) = &add_provider {
            let Some(AddProviderMode::LocalDiscoverLoading {
                provider,
                providers,
                cursor,
            }) = add_provider.take()
            else {
                unreachable!("matched above");
            };
            add_provider = Some(load_local_models(
                provider,
                providers,
                cursor,
                &snap,
                bootstrap_identity,
            ));
            continue;
        }

        // Poll input with a short timeout so the repaint cadence is steady.
        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
                    continue;
                }
                // Ctrl-C is global: resolve it before an onboarding modal can
                // route or consume the key.
                if is_ctrl_c(key.code, key.modifiers) {
                    return Ok(());
                }
                if let Some(mode) = add_provider.take() {
                    match handle_add_provider_key(
                        mode,
                        key.code,
                        key.modifiers,
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
                // The slots editor swallows its keys the same way: letters here
                // spell a model name, they never fall through to hotkeys.
                if slots_edit.is_some() {
                    let action = handle_slots_key(
                        slots_edit.as_mut().expect("checked just above"),
                        key.code,
                    );
                    match action {
                        SlotsAction::Stay => {}
                        SlotsAction::Cancel(reason) => {
                            slots_edit = None;
                            message = reason;
                        }
                        SlotsAction::Apply(aims) => {
                            let edit = slots_edit.take().expect("checked just above");
                            let said: Vec<String> =
                                aims.iter().map(|(s, m)| format!("{s}={m}")).collect();
                            message = match api::set_slots(&snap, &edit.profile, &aims) {
                                Ok(()) => {
                                    format!("{}: slots aimed ({})", edit.profile, said.join(", "))
                                }
                                Err(e) => format!("aim slots failed: {e}"),
                            };
                            snap = api::snapshot(cfg_path, bootstrap_identity);
                            last = Instant::now();
                        }
                    }
                    continue;
                }
                match key.code {
                    KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                    KeyCode::Char('m') => match slots_edit_for(&snap, selected) {
                        Some(edit) => {
                            message = format!(
                                "aim slots for {}: enter advances, the last enter applies, esc cancels",
                                edit.profile
                            );
                            slots_edit = Some(edit);
                        }
                        None => message = "no profile selected".to_string(),
                    },
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
                    KeyCode::Char('r') => {
                        snap = api::snapshot(cfg_path, bootstrap_identity);
                        last = Instant::now();
                        message = "refreshed".to_string();
                    }
                    KeyCode::Char('p') => {
                        add_provider = Some(AddProviderMode::Loading);
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

fn promote_success_to_dashboard(
    add_provider: &mut Option<AddProviderMode>,
    snap: &api::Snapshot,
    message: &mut String,
) {
    if matches!(add_provider, Some(AddProviderMode::Success(_))) && !needs_provider(snap) {
        *add_provider = None;
        *message = "provider added".to_string();
    }
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

#[allow(clippy::too_many_arguments)]
fn start_provider_login(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    accept_risk: bool,
    account: Option<String>,
    import_if_available: bool,
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
    match api::start_login(
        &identity,
        &provider.id,
        accept_risk,
        account.as_deref(),
        import_if_available,
    ) {
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

/// What one key does to the slots editor. Pure, so the whole sequence is
/// testable without a terminal (the order/agents rule).
pub(crate) enum SlotsAction {
    Stay,
    Cancel(String),
    Apply(Vec<(&'static str, String)>),
}

/// Enter advances; on the last field it applies ONLY what changed, and
/// changing nothing is a cancel with words, never a silent no-op write.
pub(crate) fn handle_slots_key(edit: &mut ui::SlotsEdit, key: KeyCode) -> SlotsAction {
    match key {
        KeyCode::Esc => SlotsAction::Cancel("aim cancelled".to_string()),
        KeyCode::Backspace => {
            edit.values[edit.field].pop();
            SlotsAction::Stay
        }
        KeyCode::Up => {
            edit.field = edit.field.saturating_sub(1);
            SlotsAction::Stay
        }
        KeyCode::Down | KeyCode::Tab => {
            if edit.field + 1 < ui::SLOT_NAMES.len() {
                edit.field += 1;
            }
            SlotsAction::Stay
        }
        KeyCode::Enter => {
            if edit.field + 1 < ui::SLOT_NAMES.len() {
                edit.field += 1;
                return SlotsAction::Stay;
            }
            let aims: Vec<(&'static str, String)> = ui::SLOT_NAMES
                .iter()
                .enumerate()
                .filter(|(i, _)| edit.values[*i] != edit.original[*i] && !edit.values[*i].is_empty())
                .map(|(i, name)| (*name, edit.values[i].clone()))
                .collect();
            if aims.is_empty() {
                SlotsAction::Cancel("nothing changed".to_string())
            } else {
                SlotsAction::Apply(aims)
            }
        }
        KeyCode::Char(c) => {
            edit.values[edit.field].push(c);
            SlotsAction::Stay
        }
        _ => SlotsAction::Stay,
    }
}

/// The editor for the selected profile row, prefilled with the current slot
/// labels. A delegated slot shows its `->profile` label: typing over it
/// replaces the delegation with a model string, leaving it keeps it (the
/// unchanged label never matches a model name, so nothing is sent for it).
fn slots_edit_for(snap: &api::Snapshot, selected: usize) -> Option<ui::SlotsEdit> {
    let name = snap.profile_names.get(selected)?;
    let profile = snap.config.as_ref()?.profiles.get(name)?;
    let current: Vec<String> = ui::SLOT_NAMES
        .iter()
        .map(|slot| {
            profile
                .slots
                .get(*slot)
                .map(config::slot_label)
                .unwrap_or_default()
        })
        .collect();
    let values: [String; 3] = [current[0].clone(), current[1].clone(), current[2].clone()];
    Some(ui::SlotsEdit {
        profile: name.clone(),
        original: values.clone(),
        values,
        field: 0,
    })
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

/// Letters, digits, dot, dash or underscore: the same set the daemon accepts
/// for an OAuth account label (`src/providers/oauth.ts`, `ACCOUNT_LABEL`).
/// Filtering at the keystroke keeps the field always valid, so there is
/// nothing to reject on submit.
fn is_account_label_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'
}

const ACCOUNT_LABEL_MAX: usize = 32;

/// An empty field means "no label" (login/logout both treat it as optional).
fn none_or(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// The vision-route candidates (mirrors `visionCandidates`, src/cli/init.ts):
/// only models that declare vision support and are not already the main
/// model, since routing to the model that would serve it anyway is a no-op.
fn vision_candidates(models: &[api::LocalModel], main: &str) -> Vec<String> {
    models
        .iter()
        .filter(|m| m.supports_vision == Some(true) && m.id != main)
        .map(|m| m.id.clone())
        .collect()
}

/// Whether the long-context offer is worth asking at all: a light model
/// distinct from main, and a discovered window on at least one of the picks
/// (mirrors the CLI's `windows.length > 0 && small !== big`, init.ts). The
/// daemon re-validates with the exact rule when the route is actually written,
/// so an occasional over-offer here just costs a rejected write, never a
/// silently wrong one.
fn long_context_eligible(models: &[api::LocalModel], main: &str, light: &str) -> bool {
    if main == light {
        return false;
    }
    let known = |id: &str| models.iter().any(|m| m.id == id && m.context_window.is_some());
    known(main) || known(light)
}

/// Other profiles the new one could fail over to (mirrors `offerFailover`,
/// src/cli/init.ts): every existing profile except one already carrying this
/// provider's id.
fn failover_candidates(snap: &api::Snapshot, new_id: &str) -> Vec<String> {
    snap.profile_names
        .iter()
        .filter(|n| n.as_str() != new_id)
        .cloned()
        .collect()
}

/// What a successful setup does next: back to the dashboard directly once a
/// profile exists, or the delayed-success screen while the cold-start
/// bootstrap is still the only thing on screen (the same fork the original
/// key-only flow used, now shared by every path that can succeed).
fn finish_add_provider(
    cfg_path: &std::path::Path,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    message: &mut String,
) -> AddProviderAction {
    let refreshed = api::snapshot(cfg_path, bootstrap_identity);
    *message = "provider added".to_string();
    if needs_provider(&refreshed) {
        AddProviderAction::Stay(AddProviderMode::Success("provider added".to_string()))
    } else {
        AddProviderAction::Dashboard(refreshed)
    }
}

#[allow(clippy::too_many_arguments)]
fn submit_key(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    key: String,
    economy: bool,
    failover: Option<String>,
    save_anyway: bool,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    let Some(identity) = onboarding_identity(snap, bootstrap_identity) else {
        return AddProviderAction::Stay(AddProviderMode::Error {
            message: "daemon not answering: restart with `lupin`".to_string(),
            providers,
            cursor,
            return_to_list: true,
        });
    };
    let opts = api::SetupKeyOptions {
        economy,
        failover: failover.as_deref(),
        save_anyway,
    };
    match api::setup_key(&identity, &provider.id, &key, &opts) {
        Ok(()) => finish_add_provider(cfg_path, bootstrap_identity, message),
        Err(e) if e.can_save_anyway && !save_anyway => {
            let shown = redact_key_from_error(&onboarding_error(e.message), &key);
            AddProviderAction::Stay(AddProviderMode::SaveAnywayConfirm {
                provider,
                providers,
                cursor,
                key,
                economy,
                failover,
                message: shown,
            })
        }
        Err(e) => {
            let shown = redact_key_from_error(&onboarding_error(e.message), &key);
            AddProviderAction::Stay(AddProviderMode::Error {
                message: shown,
                providers,
                cursor,
                return_to_list: true,
            })
        }
    }
}

/// After the key and (when offered) the economy choice: the shared failover
/// offer when another profile exists, otherwise straight to submission.
#[allow(clippy::too_many_arguments)]
fn after_key_details(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    key: String,
    economy: bool,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    let candidates = failover_candidates(snap, &provider.id);
    if candidates.is_empty() {
        submit_key(
            provider,
            providers,
            cursor,
            key,
            economy,
            None,
            false,
            snap,
            bootstrap_identity,
            cfg_path,
            message,
        )
    } else {
        AddProviderAction::Stay(AddProviderMode::FailoverOffer {
            pending: PendingSubmit::Key {
                provider,
                key,
                economy,
            },
            providers,
            cursor,
            candidates,
            pick_cursor: 0,
        })
    }
}

#[allow(clippy::too_many_arguments)]
fn submit_local(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    main: String,
    light: String,
    vision: Option<String>,
    long_context: bool,
    failover: Option<String>,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    let Some(identity) = onboarding_identity(snap, bootstrap_identity) else {
        return AddProviderAction::Stay(AddProviderMode::Error {
            message: "daemon not answering: restart with `lupin`".to_string(),
            providers,
            cursor,
            return_to_list: true,
        });
    };
    let req = api::SetupLocalRequest {
        provider_id: &provider.id,
        main: &main,
        light: &light,
        vision: vision.as_deref(),
        long_context,
        failover: failover.as_deref(),
    };
    match api::setup_local(&identity, &req) {
        Ok(()) => finish_add_provider(cfg_path, bootstrap_identity, message),
        Err(e) => AddProviderAction::Stay(AddProviderMode::Error {
            message: onboarding_error(e.message),
            providers,
            cursor,
            return_to_list: true,
        }),
    }
}

/// After the two opt-in local offers (vision, long context): the shared
/// failover offer when another profile exists, otherwise straight to
/// submission. Same fork as `after_key_details`.
#[allow(clippy::too_many_arguments)]
fn after_local_details(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    main: String,
    light: String,
    vision: Option<String>,
    long_context: bool,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    let candidates = failover_candidates(snap, &provider.id);
    if candidates.is_empty() {
        submit_local(
            provider,
            providers,
            cursor,
            main,
            light,
            vision,
            long_context,
            None,
            snap,
            bootstrap_identity,
            cfg_path,
            message,
        )
    } else {
        AddProviderAction::Stay(AddProviderMode::FailoverOffer {
            pending: PendingSubmit::Local {
                provider,
                main,
                light,
                vision,
                long_context,
            },
            providers,
            cursor,
            candidates,
            pick_cursor: 0,
        })
    }
}

/// After the light-model pick: the vision offer when the runtime lists a
/// candidate, otherwise straight to the long-context question.
#[allow(clippy::too_many_arguments)]
fn after_light_pick(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    models: Vec<api::LocalModel>,
    main: String,
    light: String,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    let candidates = vision_candidates(&models, &main);
    if candidates.is_empty() {
        after_vision(
            provider,
            providers,
            cursor,
            models,
            main,
            light,
            None,
            snap,
            bootstrap_identity,
            cfg_path,
            message,
        )
    } else {
        AddProviderAction::Stay(AddProviderMode::VisionPick {
            provider,
            providers,
            cursor,
            models,
            main,
            light,
            candidates,
            pick_cursor: 0,
        })
    }
}

/// After the vision offer: the long-context question when a window is known
/// and the picks differ, otherwise straight to the shared failover offer.
#[allow(clippy::too_many_arguments)]
fn after_vision(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
    models: Vec<api::LocalModel>,
    main: String,
    light: String,
    vision: Option<String>,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    if long_context_eligible(&models, &main, &light) {
        AddProviderAction::Stay(AddProviderMode::LongContextConfirm {
            provider,
            providers,
            cursor,
            main,
            light,
            vision,
        })
    } else {
        after_local_details(
            provider,
            providers,
            cursor,
            main,
            light,
            vision,
            false,
            snap,
            bootstrap_identity,
            cfg_path,
            message,
        )
    }
}

fn load_local_models(
    provider: api::ProviderRow,
    providers: Vec<api::ProviderRow>,
    cursor: usize,
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
    match api::discover_local(&identity, &provider.id) {
        Ok(models) if models.is_empty() => AddProviderMode::Error {
            message: "the local server answers but has no models installed (embeddings excluded)"
                .to_string(),
            providers,
            cursor,
            return_to_list: true,
        },
        Ok(models) => AddProviderMode::ModelPick {
            provider,
            providers,
            cursor,
            models,
            model_cursor: 0,
            target: ModelPickTarget::Main,
            main: None,
        },
        Err(e) => AddProviderMode::LocalDiscoverError {
            provider,
            providers,
            cursor,
            message: onboarding_error(e.message),
            start_hint: e.start_hint,
        },
    }
}

fn handle_add_provider_key(
    mode: AddProviderMode,
    key: KeyCode,
    modifiers: event::KeyModifiers,
    snap: &api::Snapshot,
    bootstrap_identity: Option<&config::BootstrapIdentity>,
    cfg_path: &std::path::Path,
    message: &mut String,
) -> AddProviderAction {
    // Exit keys are resolved before any modal state can consume them. `q` is
    // excluded only while it is literal text input (the API key or an
    // account label).
    if is_ctrl_c(key, modifiers) {
        return AddProviderAction::Exit;
    }
    let is_text_input = matches!(
        &mode,
        AddProviderMode::KeyInput { .. }
            | AddProviderMode::OAuthAccount { .. }
            | AddProviderMode::LogoutAccount { .. }
    );
    if key == KeyCode::Char('q') && !is_text_input {
        return AddProviderAction::Exit;
    }
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
            KeyCode::Char('x') => {
                let Some(provider) = providers.get(cursor).cloned() else {
                    return AddProviderAction::Stay(AddProviderMode::List { providers, cursor });
                };
                if provider.auth_kind != api::AuthKind::Oauth {
                    *message = "only OAuth providers can log out".to_string();
                    return AddProviderAction::Stay(AddProviderMode::List { providers, cursor });
                }
                AddProviderAction::Stay(AddProviderMode::LogoutAccount {
                    provider,
                    providers,
                    cursor,
                    value: String::new(),
                })
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
                    api::AuthKind::Local => AddProviderAction::Stay(
                        AddProviderMode::LocalDiscoverLoading {
                            provider,
                            providers,
                            cursor,
                        },
                    ),
                    api::AuthKind::Oauth if provider.import_available => {
                        AddProviderAction::Stay(AddProviderMode::OAuthImportConfirm {
                            provider,
                            providers,
                            cursor,
                        })
                    }
                    api::AuthKind::Oauth => AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                        provider,
                        providers,
                        cursor,
                        import_if_available: false,
                        value: String::new(),
                    }),
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::List { providers, cursor }),
        },
        AddProviderMode::OAuthImportConfirm {
            provider,
            providers,
            cursor,
        } => match key {
            KeyCode::Esc => {
                *message = "OAuth login cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Char('n') => AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                provider,
                providers,
                cursor,
                import_if_available: false,
                value: String::new(),
            }),
            KeyCode::Enter | KeyCode::Char('y') => {
                AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                    provider,
                    providers,
                    cursor,
                    import_if_available: true,
                    value: String::new(),
                })
            }
            _ => AddProviderAction::Stay(AddProviderMode::OAuthImportConfirm {
                provider,
                providers,
                cursor,
            }),
        },
        AddProviderMode::OAuthAccount {
            provider,
            providers,
            cursor,
            import_if_available,
            mut value,
        } => match key {
            KeyCode::Esc => {
                *message = "OAuth login cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Backspace => {
                value.pop();
                AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                    provider,
                    providers,
                    cursor,
                    import_if_available,
                    value,
                })
            }
            KeyCode::Char(c) if is_account_label_char(c) => {
                if value.chars().count() < ACCOUNT_LABEL_MAX {
                    value.push(c);
                } else {
                    *message = "account label: max 32 characters".to_string();
                }
                AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                    provider,
                    providers,
                    cursor,
                    import_if_available,
                    value,
                })
            }
            KeyCode::Char(_) => {
                *message =
                    "account label: letters, digits, dot, dash or underscore only".to_string();
                AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                    provider,
                    providers,
                    cursor,
                    import_if_available,
                    value,
                })
            }
            KeyCode::Enter => {
                let account = none_or(&value);
                if provider.suspension_warning.is_some() {
                    AddProviderAction::Stay(AddProviderMode::ConfirmRisk {
                        provider,
                        providers,
                        cursor,
                        account,
                        import_if_available,
                    })
                } else {
                    AddProviderAction::Stay(start_provider_login(
                        provider,
                        providers,
                        cursor,
                        false,
                        account,
                        import_if_available,
                        snap,
                        bootstrap_identity,
                    ))
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::OAuthAccount {
                provider,
                providers,
                cursor,
                import_if_available,
                value,
            }),
        },
        AddProviderMode::ConfirmRisk {
            provider,
            providers,
            cursor,
            account,
            import_if_available,
        } => match key {
            KeyCode::Enter => AddProviderAction::Stay(start_provider_login(
                provider,
                providers,
                cursor,
                true,
                account,
                import_if_available,
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
                account,
                import_if_available,
            }),
        },
        AddProviderMode::LogoutAccount {
            provider,
            providers,
            cursor,
            mut value,
        } => match key {
            KeyCode::Esc => {
                *message = "logout cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Backspace => {
                value.pop();
                AddProviderAction::Stay(AddProviderMode::LogoutAccount {
                    provider,
                    providers,
                    cursor,
                    value,
                })
            }
            KeyCode::Char(c) if is_account_label_char(c) => {
                if value.chars().count() < ACCOUNT_LABEL_MAX {
                    value.push(c);
                }
                AddProviderAction::Stay(AddProviderMode::LogoutAccount {
                    provider,
                    providers,
                    cursor,
                    value,
                })
            }
            KeyCode::Enter => {
                let account = none_or(&value);
                let Some(identity) = onboarding_identity(snap, bootstrap_identity) else {
                    return AddProviderAction::Stay(AddProviderMode::Error {
                        message: "daemon not answering: restart with `lupin`".to_string(),
                        providers,
                        cursor,
                        return_to_list: true,
                    });
                };
                match api::logout(&identity, &provider.id, account.as_deref()) {
                    Ok(()) => {
                        *message = format!("logged out of {}", provider.id);
                        AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
                    }
                    Err(error) => AddProviderAction::Stay(AddProviderMode::Error {
                        message: onboarding_error(error),
                        providers,
                        cursor,
                        return_to_list: true,
                    }),
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::LogoutAccount {
                provider,
                providers,
                cursor,
                value,
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
                if provider.economy.is_some() {
                    AddProviderAction::Stay(AddProviderMode::EconomyChoice {
                        provider,
                        providers,
                        cursor,
                        key: value,
                        economy: false,
                    })
                } else {
                    after_key_details(
                        provider,
                        providers,
                        cursor,
                        value,
                        false,
                        snap,
                        bootstrap_identity,
                        cfg_path,
                        message,
                    )
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::KeyInput {
                provider,
                providers,
                cursor,
                value,
            }),
        },
        AddProviderMode::EconomyChoice {
            provider,
            providers,
            cursor,
            key: entered_key,
            economy,
        } => match key {
            KeyCode::Esc => {
                *message = "API key entry cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Char('1') => AddProviderAction::Stay(AddProviderMode::EconomyChoice {
                provider,
                providers,
                cursor,
                key: entered_key,
                economy: false,
            }),
            KeyCode::Char('2') => AddProviderAction::Stay(AddProviderMode::EconomyChoice {
                provider,
                providers,
                cursor,
                key: entered_key,
                economy: true,
            }),
            KeyCode::Enter => after_key_details(
                provider,
                providers,
                cursor,
                entered_key,
                economy,
                snap,
                bootstrap_identity,
                cfg_path,
                message,
            ),
            _ => AddProviderAction::Stay(AddProviderMode::EconomyChoice {
                provider,
                providers,
                cursor,
                key: entered_key,
                economy,
            }),
        },
        AddProviderMode::SaveAnywayConfirm {
            provider,
            providers,
            cursor,
            key: entered_key,
            economy,
            failover,
            message: shown,
        } => match key {
            KeyCode::Char('y') => submit_key(
                provider,
                providers,
                cursor,
                entered_key,
                economy,
                failover,
                true,
                snap,
                bootstrap_identity,
                cfg_path,
                message,
            ),
            KeyCode::Enter | KeyCode::Char('n') | KeyCode::Esc => {
                *message = format!("{shown} (not saved)");
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            _ => AddProviderAction::Stay(AddProviderMode::SaveAnywayConfirm {
                provider,
                providers,
                cursor,
                key: entered_key,
                economy,
                failover,
                message: shown,
            }),
        },
        AddProviderMode::LocalDiscoverLoading {
            provider,
            providers,
            cursor,
        } => AddProviderAction::Stay(AddProviderMode::LocalDiscoverLoading {
            provider,
            providers,
            cursor,
        }),
        AddProviderMode::LocalDiscoverError {
            provider,
            providers,
            cursor,
            message: shown,
            start_hint,
        } => match key {
            KeyCode::Enter => AddProviderAction::Stay(AddProviderMode::LocalDiscoverLoading {
                provider,
                providers,
                cursor,
            }),
            KeyCode::Esc => AddProviderAction::Stay(AddProviderMode::List { providers, cursor }),
            _ => AddProviderAction::Stay(AddProviderMode::LocalDiscoverError {
                provider,
                providers,
                cursor,
                message: shown,
                start_hint,
            }),
        },
        AddProviderMode::ModelPick {
            provider,
            providers,
            cursor,
            models,
            mut model_cursor,
            target,
            main,
        } => match key {
            KeyCode::Esc => {
                *message = "local setup cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Up | KeyCode::Char('k') => {
                model_cursor = model_cursor.saturating_sub(1);
                AddProviderAction::Stay(AddProviderMode::ModelPick {
                    provider,
                    providers,
                    cursor,
                    models,
                    model_cursor,
                    target,
                    main,
                })
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if model_cursor + 1 < models.len() {
                    model_cursor += 1;
                }
                AddProviderAction::Stay(AddProviderMode::ModelPick {
                    provider,
                    providers,
                    cursor,
                    models,
                    model_cursor,
                    target,
                    main,
                })
            }
            KeyCode::Enter => {
                let Some(picked) = models.get(model_cursor).map(|m| m.id.clone()) else {
                    return AddProviderAction::Stay(AddProviderMode::ModelPick {
                        provider,
                        providers,
                        cursor,
                        models,
                        model_cursor,
                        target,
                        main,
                    });
                };
                match target {
                    ModelPickTarget::Main => {
                        // The light picker's cursor starts on the same model:
                        // enter with no movement reproduces "same as main".
                        AddProviderAction::Stay(AddProviderMode::ModelPick {
                            provider,
                            providers,
                            cursor,
                            models,
                            model_cursor,
                            target: ModelPickTarget::Light,
                            main: Some(picked),
                        })
                    }
                    ModelPickTarget::Light => {
                        let main_id = main.unwrap_or_else(|| picked.clone());
                        after_light_pick(
                            provider,
                            providers,
                            cursor,
                            models,
                            main_id,
                            picked,
                            snap,
                            bootstrap_identity,
                            cfg_path,
                            message,
                        )
                    }
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::ModelPick {
                provider,
                providers,
                cursor,
                models,
                model_cursor,
                target,
                main,
            }),
        },
        AddProviderMode::VisionPick {
            provider,
            providers,
            cursor,
            models,
            main,
            light,
            candidates,
            mut pick_cursor,
        } => match key {
            KeyCode::Esc => {
                *message = "local setup cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Up | KeyCode::Char('k') => {
                pick_cursor = pick_cursor.saturating_sub(1);
                AddProviderAction::Stay(AddProviderMode::VisionPick {
                    provider,
                    providers,
                    cursor,
                    models,
                    main,
                    light,
                    candidates,
                    pick_cursor,
                })
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if pick_cursor < candidates.len() {
                    pick_cursor += 1;
                }
                AddProviderAction::Stay(AddProviderMode::VisionPick {
                    provider,
                    providers,
                    cursor,
                    models,
                    main,
                    light,
                    candidates,
                    pick_cursor,
                })
            }
            KeyCode::Enter => {
                let vision = if pick_cursor == 0 {
                    None
                } else {
                    candidates.get(pick_cursor - 1).cloned()
                };
                after_vision(
                    provider,
                    providers,
                    cursor,
                    models,
                    main,
                    light,
                    vision,
                    snap,
                    bootstrap_identity,
                    cfg_path,
                    message,
                )
            }
            _ => AddProviderAction::Stay(AddProviderMode::VisionPick {
                provider,
                providers,
                cursor,
                models,
                main,
                light,
                candidates,
                pick_cursor,
            }),
        },
        AddProviderMode::LongContextConfirm {
            provider,
            providers,
            cursor,
            main,
            light,
            vision,
        } => match key {
            KeyCode::Esc => {
                *message = "local setup cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Char('y') => after_local_details(
                provider,
                providers,
                cursor,
                main,
                light,
                vision,
                true,
                snap,
                bootstrap_identity,
                cfg_path,
                message,
            ),
            KeyCode::Enter | KeyCode::Char('n') => after_local_details(
                provider,
                providers,
                cursor,
                main,
                light,
                vision,
                false,
                snap,
                bootstrap_identity,
                cfg_path,
                message,
            ),
            _ => AddProviderAction::Stay(AddProviderMode::LongContextConfirm {
                provider,
                providers,
                cursor,
                main,
                light,
                vision,
            }),
        },
        AddProviderMode::FailoverOffer {
            pending,
            providers,
            cursor,
            candidates,
            mut pick_cursor,
        } => match key {
            KeyCode::Esc => {
                *message = "provider setup cancelled".to_string();
                AddProviderAction::Stay(AddProviderMode::List { providers, cursor })
            }
            KeyCode::Up | KeyCode::Char('k') => {
                pick_cursor = pick_cursor.saturating_sub(1);
                AddProviderAction::Stay(AddProviderMode::FailoverOffer {
                    pending,
                    providers,
                    cursor,
                    candidates,
                    pick_cursor,
                })
            }
            KeyCode::Down | KeyCode::Char('j') => {
                if pick_cursor < candidates.len() {
                    pick_cursor += 1;
                }
                AddProviderAction::Stay(AddProviderMode::FailoverOffer {
                    pending,
                    providers,
                    cursor,
                    candidates,
                    pick_cursor,
                })
            }
            KeyCode::Enter => {
                let failover = if pick_cursor == 0 {
                    None
                } else {
                    candidates.get(pick_cursor - 1).cloned()
                };
                match pending {
                    PendingSubmit::Key {
                        provider,
                        key: entered_key,
                        economy,
                    } => submit_key(
                        provider,
                        providers,
                        cursor,
                        entered_key,
                        economy,
                        failover,
                        false,
                        snap,
                        bootstrap_identity,
                        cfg_path,
                        message,
                    ),
                    PendingSubmit::Local {
                        provider,
                        main,
                        light,
                        vision,
                        long_context,
                    } => submit_local(
                        provider,
                        providers,
                        cursor,
                        main,
                        light,
                        vision,
                        long_context,
                        failover,
                        snap,
                        bootstrap_identity,
                        cfg_path,
                        message,
                    ),
                }
            }
            _ => AddProviderAction::Stay(AddProviderMode::FailoverOffer {
                pending,
                providers,
                cursor,
                candidates,
                pick_cursor,
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

fn is_ctrl_c(key: KeyCode, modifiers: event::KeyModifiers) -> bool {
    key == KeyCode::Char('c') && modifiers.contains(event::KeyModifiers::CONTROL)
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
        handle_slots_key, onboarding_error, order_message, promote_success_to_dashboard, push_pick,
        redact_key_from_error, submit_key, AddProviderAction, AddProviderMode, ModelPickTarget,
        PendingSubmit, SlotsAction,
    };
    use crate::api::{AuthKind, ProviderRow, Snapshot};
    use crate::ui;
    use crossterm::event::{KeyCode, KeyModifiers};

    fn empty_snapshot() -> Snapshot {
        Snapshot {
            config: None,
            health: None,
            recent: Vec::new(),
            profile_names: Vec::new(),
        }
    }

    fn provider(auth_kind: AuthKind) -> ProviderRow {
        provider_with_id("catalogue-row", auth_kind)
    }

    fn provider_with_id(id: &str, auth_kind: AuthKind) -> ProviderRow {
        ProviderRow {
            id: id.to_string(),
            description: "Catalogue Row".to_string(),
            auth_kind,
            suspension_warning: None,
            economy: None,
            start_hint: None,
            import_available: false,
        }
    }

    fn provider_ids(providers: &[ProviderRow]) -> Vec<&str> {
        providers
            .iter()
            .map(|provider| provider.id.as_str())
            .collect()
    }

    fn route(mode: AddProviderMode, key: KeyCode) -> AddProviderAction {
        handle_add_provider_key(
            mode,
            key,
            KeyModifiers::NONE,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        )
    }

    fn route_with_modifiers(
        mode: AddProviderMode,
        key: KeyCode,
        modifiers: KeyModifiers,
    ) -> AddProviderAction {
        handle_add_provider_key(
            mode,
            key,
            modifiers,
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
        for key in [
            KeyCode::Enter,
            KeyCode::Esc,
            KeyCode::Char('x'),
            KeyCode::Char('c'),
        ] {
            assert!(matches!(
                route(AddProviderMode::Success("provider added".to_string()), key),
                AddProviderAction::Stay(AddProviderMode::Success(_))
            ));
        }
    }

    #[test]
    fn delayed_success_q_exits_the_tui() {
        assert!(matches!(
            route(
                AddProviderMode::Success("provider added".to_string()),
                KeyCode::Char('q')
            ),
            AddProviderAction::Exit
        ));
    }

    #[test]
    fn delayed_success_ctrl_c_exits_the_tui() {
        assert!(matches!(
            route_with_modifiers(
                AddProviderMode::Success("provider added".to_string()),
                KeyCode::Char('c'),
                KeyModifiers::CONTROL,
            ),
            AddProviderAction::Exit
        ));
    }

    /// Every onboarding state, text-input ones included: ctrl-c is the global
    /// exit regardless of what the current field is doing with a plain `q`.
    fn every_onboarding_state() -> Vec<AddProviderMode> {
        vec![
            AddProviderMode::Loading,
            AddProviderMode::List {
                providers: vec![provider(AuthKind::Key)],
                cursor: 0,
            },
            AddProviderMode::OAuthImportConfirm {
                provider: provider(AuthKind::Oauth),
                providers: Vec::new(),
                cursor: 0,
            },
            AddProviderMode::OAuthAccount {
                provider: provider(AuthKind::Oauth),
                providers: Vec::new(),
                cursor: 0,
                import_if_available: false,
                value: "work".to_string(),
            },
            AddProviderMode::ConfirmRisk {
                provider: provider(AuthKind::Oauth),
                providers: Vec::new(),
                cursor: 0,
                account: None,
                import_if_available: false,
            },
            AddProviderMode::LogoutAccount {
                provider: provider(AuthKind::Oauth),
                providers: Vec::new(),
                cursor: 0,
                value: "work".to_string(),
            },
            AddProviderMode::KeyInput {
                provider: provider(AuthKind::Key),
                providers: Vec::new(),
                cursor: 0,
                value: "secret".to_string(),
            },
            AddProviderMode::EconomyChoice {
                provider: provider(AuthKind::Key),
                providers: Vec::new(),
                cursor: 0,
                key: "secret".to_string(),
                economy: false,
            },
            AddProviderMode::SaveAnywayConfirm {
                provider: provider(AuthKind::Key),
                providers: Vec::new(),
                cursor: 0,
                key: "secret".to_string(),
                economy: false,
                failover: None,
                message: "the provider does not answer".to_string(),
            },
            AddProviderMode::LocalDiscoverLoading {
                provider: provider(AuthKind::Local),
                providers: Vec::new(),
                cursor: 0,
            },
            AddProviderMode::LocalDiscoverError {
                provider: provider(AuthKind::Local),
                providers: Vec::new(),
                cursor: 0,
                message: "local server unreachable".to_string(),
                start_hint: Some("ollama serve".to_string()),
            },
            AddProviderMode::ModelPick {
                provider: provider(AuthKind::Local),
                providers: Vec::new(),
                cursor: 0,
                models: Vec::new(),
                model_cursor: 0,
                target: ModelPickTarget::Main,
                main: None,
            },
            AddProviderMode::VisionPick {
                provider: provider(AuthKind::Local),
                providers: Vec::new(),
                cursor: 0,
                models: Vec::new(),
                main: "big".to_string(),
                light: "big".to_string(),
                candidates: Vec::new(),
                pick_cursor: 0,
            },
            AddProviderMode::LongContextConfirm {
                provider: provider(AuthKind::Local),
                providers: Vec::new(),
                cursor: 0,
                main: "big".to_string(),
                light: "small".to_string(),
                vision: None,
            },
            AddProviderMode::FailoverOffer {
                pending: PendingSubmit::Key {
                    provider: provider(AuthKind::Key),
                    key: "secret".to_string(),
                    economy: false,
                },
                providers: Vec::new(),
                cursor: 0,
                candidates: vec!["other".to_string()],
                pick_cursor: 0,
            },
            AddProviderMode::OAuthWaiting {
                provider: provider(AuthKind::Oauth),
                providers: Vec::new(),
                cursor: 0,
                job: "job-7".to_string(),
                url: None,
            },
            AddProviderMode::Error {
                message: "failed".to_string(),
                providers: Vec::new(),
                cursor: 0,
                return_to_list: true,
            },
            AddProviderMode::Success("provider added".to_string()),
        ]
    }

    #[test]
    fn ctrl_c_exits_from_every_onboarding_state() {
        for state in every_onboarding_state() {
            assert!(matches!(
                route_with_modifiers(state, KeyCode::Char('c'), KeyModifiers::CONTROL),
                AddProviderAction::Exit
            ));
        }
    }

    /// The text-input states, where a plain `q` must be swallowed as a
    /// character rather than treated as the global exit key.
    fn is_text_input_state(mode: &AddProviderMode) -> bool {
        matches!(
            mode,
            AddProviderMode::KeyInput { .. }
                | AddProviderMode::OAuthAccount { .. }
                | AddProviderMode::LogoutAccount { .. }
        )
    }

    #[test]
    fn q_exits_every_non_text_onboarding_state() {
        for state in every_onboarding_state() {
            if is_text_input_state(&state) {
                continue;
            }
            assert!(matches!(
                route(state, KeyCode::Char('q')),
                AddProviderAction::Exit
            ));
        }
    }

    #[test]
    fn q_is_literal_text_inside_every_text_input_state() {
        for state in every_onboarding_state() {
            if !is_text_input_state(&state) {
                continue;
            }
            assert!(
                matches!(route(state, KeyCode::Char('q')), AddProviderAction::Stay(_)),
                "q must stay literal text, not exit"
            );
        }
    }

    #[test]
    fn q_is_literal_text_inside_key_input() {
        let mode = stayed_mode(route(
            AddProviderMode::KeyInput {
                provider: provider(AuthKind::Key),
                providers: Vec::new(),
                cursor: 0,
                value: "se".to_string(),
            },
            KeyCode::Char('q'),
        ));
        let AddProviderMode::KeyInput { value, .. } = mode else {
            panic!("key input must stay active");
        };
        assert_eq!(value, "seq");
    }

    #[test]
    fn refresh_with_a_profile_returns_delayed_success_to_the_dashboard() {
        let config = serde_json::from_str(
            r#"{
                "activeProfile": "ready-profile",
                "port": 3456,
                "localToken": "t",
                "profiles": {
                    "ready-profile": {
                        "mode": "passthrough",
                        "slots": {}
                    }
                }
            }"#,
        )
        .expect("config");
        let snap = Snapshot {
            config: Some(config),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["ready-profile".to_string()],
        };
        let mut mode = Some(AddProviderMode::Success("provider added".to_string()));
        let mut message = String::new();

        promote_success_to_dashboard(&mut mode, &snap, &mut message);

        assert!(mode.is_none());
        assert_eq!(message, "provider added");
    }

    #[test]
    fn risk_cancel_restores_the_existing_catalogue_and_cursor() {
        let key_row = provider_with_id("key-first", AuthKind::Key);
        let mut oauth_row = provider_with_id("oauth-second", AuthKind::Oauth);
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
        assert_eq!(provider_ids(&providers), ["key-first", "oauth-second"]);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn key_cancel_restores_the_existing_catalogue_and_cursor() {
        let input = stayed_mode(route(
            AddProviderMode::List {
                providers: vec![
                    provider_with_id("oauth-first", AuthKind::Oauth),
                    provider_with_id("key-second", AuthKind::Key),
                ],
                cursor: 1,
            },
            KeyCode::Enter,
        ));
        let input = stayed_mode(route(input, KeyCode::Char('s')));
        let cancelled = stayed_mode(route(input, KeyCode::Esc));
        let AddProviderMode::List { providers, cursor } = cancelled else {
            panic!("key cancel must restore the catalogue");
        };
        assert_eq!(provider_ids(&providers), ["oauth-first", "key-second"]);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn oauth_cancel_restores_the_existing_catalogue_and_cursor() {
        let oauth_row = provider_with_id("oauth-second", AuthKind::Oauth);
        let cancelled = stayed_mode(route(
            AddProviderMode::OAuthWaiting {
                provider: oauth_row.clone(),
                providers: vec![provider_with_id("key-first", AuthKind::Key), oauth_row],
                cursor: 1,
                job: "job-7".to_string(),
                url: Some("https://auth.example/start".to_string()),
            },
            KeyCode::Esc,
        ));
        let AddProviderMode::List { providers, cursor } = cancelled else {
            panic!("OAuth cancel must restore the catalogue");
        };
        assert_eq!(provider_ids(&providers), ["key-first", "oauth-second"]);
        assert_eq!(cursor, 1);
    }

    #[test]
    fn retryable_error_acknowledgement_restores_the_existing_catalogue() {
        let account_step = stayed_mode(route(
            AddProviderMode::List {
                providers: vec![
                    provider_with_id("oauth-first", AuthKind::Oauth),
                    provider_with_id("key-second", AuthKind::Key),
                ],
                cursor: 0,
            },
            KeyCode::Enter,
        ));
        // The account-label step takes no network round trip; the login
        // attempt (and so the daemon-not-answering error) fires on its Enter.
        let error = stayed_mode(route(account_step, KeyCode::Enter));
        assert!(matches!(error, AddProviderMode::Error { .. }));
        let acknowledged = stayed_mode(route(error, KeyCode::Enter));
        let AddProviderMode::List { providers, cursor } = acknowledged else {
            panic!("error acknowledgement must restore the catalogue");
        };
        assert_eq!(provider_ids(&providers), ["oauth-first", "key-second"]);
        assert_eq!(cursor, 0);
    }

    #[test]
    fn cancelling_key_entry_clears_the_sensitive_buffer() {
        let mut value = "secret-value".to_string();
        clear_cancelled_key(&mut value);
        assert!(value.is_empty());
    }

    #[test]
    fn a_daemon_not_answering_failure_is_a_hard_error_not_a_save_anyway_retry() {
        let action = submit_key(
            provider(AuthKind::Key),
            Vec::new(),
            0,
            "secret-value".to_string(),
            false,
            None,
            false,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        );
        let AddProviderAction::Stay(AddProviderMode::Error { message, .. }) = action else {
            panic!("a daemon that never answered must be a hard error, not a retry offer");
        };
        assert_eq!(message, "daemon not answering: restart with `lupin`");
    }

    #[test]
    fn daemon_errors_cannot_echo_the_submitted_key() {
        assert_eq!(
            redact_key_from_error("invalid key: secret-value", "secret-value"),
            "invalid key: ********"
        );
    }

    #[test]
    fn oauth_warning_enters_confirmation_after_the_account_step_without_starting_login() {
        let mut row = provider(AuthKind::Oauth);
        row.suspension_warning = Some("Account suspension risk".to_string());
        let account_step = stayed_mode(handle_add_provider_key(
            AddProviderMode::List {
                providers: vec![row],
                cursor: 0,
            },
            KeyCode::Enter,
            KeyModifiers::NONE,
            &empty_snapshot(),
            None,
            std::path::Path::new(""),
            &mut String::new(),
        ));
        assert!(
            matches!(account_step, AddProviderMode::OAuthAccount { .. }),
            "every OAuth row offers the account label first"
        );
        let action = route(account_step, KeyCode::Enter);
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
            KeyModifiers::NONE,
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
            (
                "explore".to_string(),
                Some(serde_json::json!({"profile": "local"})),
            ),
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

    fn slots_edit() -> ui::SlotsEdit {
        ui::SlotsEdit {
            profile: "p".to_string(),
            values: ["a".to_string(), "b".to_string(), "c".to_string()],
            original: ["a".to_string(), "b".to_string(), "c".to_string()],
            field: 0,
        }
    }

    #[test]
    fn slots_enter_advances_and_the_last_enter_with_no_change_cancels_with_words() {
        let mut edit = slots_edit();
        assert!(matches!(handle_slots_key(&mut edit, KeyCode::Enter), SlotsAction::Stay));
        assert!(matches!(handle_slots_key(&mut edit, KeyCode::Enter), SlotsAction::Stay));
        assert_eq!(edit.field, 2);
        match handle_slots_key(&mut edit, KeyCode::Enter) {
            SlotsAction::Cancel(reason) => assert_eq!(reason, "nothing changed"),
            _ => panic!("expected a worded cancel"),
        }
    }

    #[test]
    fn slots_apply_names_only_what_changed() {
        let mut edit = slots_edit();
        // Retype the haiku slot: down twice, clear "c", type "z".
        handle_slots_key(&mut edit, KeyCode::Down);
        handle_slots_key(&mut edit, KeyCode::Down);
        handle_slots_key(&mut edit, KeyCode::Backspace);
        handle_slots_key(&mut edit, KeyCode::Char('z'));
        match handle_slots_key(&mut edit, KeyCode::Enter) {
            SlotsAction::Apply(aims) => assert_eq!(aims, vec![("haiku", "z".to_string())]),
            _ => panic!("expected an apply"),
        }
    }

    #[test]
    fn slots_an_emptied_field_is_kept_not_sent() {
        let mut edit = slots_edit();
        handle_slots_key(&mut edit, KeyCode::Backspace); // opus becomes ""
        handle_slots_key(&mut edit, KeyCode::Down);
        handle_slots_key(&mut edit, KeyCode::Down);
        match handle_slots_key(&mut edit, KeyCode::Enter) {
            SlotsAction::Cancel(reason) => assert_eq!(reason, "nothing changed"),
            _ => panic!("an empty value must never be sent as a model name"),
        }
    }

    #[test]
    fn slots_esc_cancels_from_any_field() {
        let mut edit = slots_edit();
        handle_slots_key(&mut edit, KeyCode::Down);
        assert!(matches!(
            handle_slots_key(&mut edit, KeyCode::Esc),
            SlotsAction::Cancel(_)
        ));
    }
}
