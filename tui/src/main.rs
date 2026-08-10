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
    loop {
        if last.elapsed() >= REFRESH {
            snap = api::snapshot(cfg_path, bootstrap_identity);
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
            )
        })?;

        // Poll input with a short timeout so the repaint cadence is steady.
        if event::poll(Duration::from_millis(200))? {
            if let Event::Key(key) = event::read()? {
                if key.kind != KeyEventKind::Press {
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
    use super::{agent_rows, agents_table, clamp_selected, order_message, push_pick};

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
