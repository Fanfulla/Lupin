// The screen: a minimal dashboard. One glance answers the three questions
// that matter (is the daemon up, who serves the session, what just happened),
// the art answers a fourth nobody asked (who is Lupin). Every number on
// screen has a CLI twin: profiles/health/doctor mirror `lupin list`, serving
// now mirrors /health exactly like `lupin run`'s announcement, the request
// tail mirrors `lupin logs`, and a switch here is the same control-API write
// `lupin use` performs, so the two surfaces can never disagree for longer
// than one refresh.

use crate::api::Snapshot;
use crate::config::slot_label;
use crate::job::{Job, PALETTE};
use ratatui::layout::{Constraint, Direction, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Cell, Clear, Paragraph, Row, Table, Wrap};
use ratatui::Frame;

/// Arsene Lupin, the gentleman burglar Maurice Leblanc published in 1905, as
/// Leo Fontan drew him for the 1908 Pierre Lafitte cover of "Arsene Lupin
/// contre Herlock Sholmes": top hat, hooked profile, high collar. Traced from
/// the Wikimedia Commons scan of that cover, which is public domain, so the
/// project owes nobody anything for its own face.
///
/// The silhouette was isolated by flood-filling the ink from inside the hat,
/// then downsampled onto a twelve-level ramp: the cover is two-tone, so what
/// the ramp actually draws is the anti-aliased edge, which is why the brim and
/// the moustache survive at this size.
const ART_ASCII: [&str; 15] = [
    r"       .:~+*#%@*",
    r"    :=*%@@@@@@@@+",
    r".:+%@@@@@@@@@@@@@+",
    r"*@@@@@@@@@@@@@@@@@#,",
    r".=@@@@@@@@@@@@@@@@@@~. ...",
    r"  ~@@@@@@@@@@@@@@@@@@@%*+-",
    r"   -@@@@@@@@@@@@@@@@@@@=",
    r"    -@@@@@@@@@@@@@@@@@@@*",
    r"    ,%@@@@@@@@@@@@@@@@@@@,",
    r"   ~@##@@@@@@@@@@@@@@@@@#",
    r"  .~, .#@@@@@@@@@@@@@@@@@*~,",
    r"      -@@@@@@@@@@@@@@@@@@@@@#~.",
    r"      .-=%@@@@@@@@@@@@@@@@@@@@@%#*++=~:,",
    r"        :,.=@@@@@@@@@@@@@@@@@@@@@@@@@@@@%*-.",
    r"            ~=~:-%@@@@@@@@@@@@@@@@@@@@@@@@@%",
];

/// The same portrait at four times the resolution, because a braille cell is a
/// 2x4 dot matrix. Same row count as the ASCII one on purpose: the layout must
/// not move when the art does. This is the one that gets drawn unless something
/// says it cannot be (see `braille_supported`), because it is the one where the
/// hat brim and the moustache survive.
const ART_BRAILLE: [&str; 15] = [
    r"⠀⠀⠀⠀⠀⠀⠀⠀⣀⣠⣴⣶⣾⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⣀⣤⣶⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⣠⣴⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⢾⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠻⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡿⠿⠗⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠘⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⣰⣿⡿⢿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠐⠛⠁⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣤⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⠀⠀⠈⠛⢉⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷⣶⣶⣦⣤⣤⣀⣀⠀⠀⠀⠀",
    r"⠀⠀⠀⠀⠀⠀⠀⠐⠋⠁⠀⢹⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣶⣄⠀",
    r"⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠛⠛⠛⠉⠉⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣷",
];

/// The compact portrait, and the one most people actually see: a terminal
/// thirty rows tall is the common case, not the tall one. Kept to exactly the
/// width of the drawn hat below, because the header splits its columns around
/// the art and a wider one clips the facts (which is how a test caught it).
const ART_BRAILLE_SMALL: [&str; 4] = [
    r"⣀⣤⣶⣾⣿⣷⣄⠀⠀⠀⠀⠀⠀⠀⠀⠀",
    r"⠈⢿⣿⣿⣿⣿⣿⣷⣖⠀⠀⠀⠀⠀⠀⠀",
    r"⠀⠴⢿⣿⣿⣿⣿⣿⣿⣀⠀⠀⠀⠀⠀⠀",
    r"⠀⠀⠈⠛⢿⠿⣿⣿⣿⣿⣿⣶⣶⣶⣤⣄",
];

/// The same idea at a size that fits a short terminal: just the hat. A shrunken
/// downsample of the portrait turns to mush, so this one is drawn, not traced.
const ART_HAT: [&str; 4] = [
    r"    ,-------,",
    r"    |       |",
    r" ,--'-------'--,",
    r" '-------------'",
];

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Whether to draw the braille portrait, which is the one worth looking at.
///
/// It is the DEFAULT, and the plain one is the exception, because the terminals
/// that cannot draw braille are now the rare ones: a legacy conhost on a raster
/// font, or a session whose locale is not UTF-8. There is no capability query to
/// ask, so the only honest options are to assume the common case or to punish
/// everyone for the rare one. This assumes, and steps aside on evidence:
///
/// - `LUPIN_TUI_ASCII`, set by whoever is actually looking at boxes;
/// - a locale variable that positively says it is not UTF-8 (`LANG=C` and the
///   like). A missing locale is not evidence and does not count.
fn braille_supported() -> bool {
    let locales: Vec<String> = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .collect();
    braille_wanted(
        std::env::var_os("LUPIN_TUI_ASCII").is_some(),
        &locales.iter().map(String::as_str).collect::<Vec<_>>(),
    )
}

/// The decision itself, away from the environment so it can be tested without
/// mutating process state.
fn braille_wanted(force_ascii: bool, locales: &[&str]) -> bool {
    if force_ascii {
        return false;
    }
    !locales
        .iter()
        .filter(|v| !v.is_empty())
        .any(|v| !v.to_ascii_lowercase().replace('-', "").contains("utf8"))
}

/// The art for the room available. Both portraits are the SAME height, so the
/// layout below never depends on which one was picked.
fn art_for(height: u16, braille: bool) -> &'static [&'static str] {
    if height >= 32 {
        if braille {
            &ART_BRAILLE
        } else {
            &ART_ASCII
        }
    } else if height >= 20 {
        if braille {
            &ART_BRAILLE_SMALL
        } else {
            &ART_HAT
        }
    } else {
        &[]
    }
}

/// Secondary text: panel titles, key hints, timestamps, units. It used to be
/// `DarkGray`, which is ANSI bright-black and sits a hair away from the
/// background on most dark themes: on a real screen the whole key legend and
/// every panel title were invisible (reported 2026-08-05). `Gray` is ANSI 7,
/// quiet but legible on both dark and light backgrounds.
fn dim() -> Style {
    Style::default().fg(Color::Gray)
}

fn bold() -> Style {
    Style::default().add_modifier(Modifier::BOLD)
}

pub fn render(
    f: &mut Frame,
    snap: &Snapshot,
    message: &str,
    selected: usize,
    job: Option<&Job>,
    palette: bool,
) {
    // The portrait is worth 15 rows only where 15 rows are spare. Below that the
    // hat says the same thing in 4, and below THAT the screen is for facts.
    let h = f.area().height;
    let art = art_for(h, braille_supported());
    let header_h = (art.len() as u16 + 2).max(6);
    let recent_h = if h >= 32 { 8 } else { 6 };

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(header_h), // header: art + facts
            Constraint::Min(6),           // middle: profiles | serving+window
            Constraint::Length(recent_h), // recent requests
            Constraint::Length(1),        // talking line
            Constraint::Length(1),        // keys
        ])
        .split(f.area());

    render_header(f, snap, chunks[0], art);

    let middle = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Min(46), Constraint::Length(34)])
        .split(chunks[1]);
    render_profiles(f, snap, middle[0], selected);
    let right = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(5), Constraint::Min(0)])
        .split(middle[1]);
    render_serving(f, snap, right[0]);
    render_window(f, snap, right[1]);

    render_recent(f, snap, chunks[2]);
    render_message(f, message, chunks[3]);
    render_keys(f, chunks[4]);

    // Overlays last: they sit ON the dashboard, which keeps refreshing under
    // them, so a two-minute doctor never freezes the screen it runs from.
    if let Some(j) = job {
        render_job(f, j, f.area());
    }
    if palette {
        render_palette(f, f.area());
    }
}

/// A centred box, in percent of the screen, for the overlays.
fn centred(area: Rect, pct_x: u16, pct_y: u16) -> Rect {
    let v = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Percentage((100 - pct_y) / 2),
            Constraint::Percentage(pct_y),
            Constraint::Percentage((100 - pct_y) / 2),
        ])
        .split(area);
    Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage((100 - pct_x) / 2),
            Constraint::Percentage(pct_x),
            Constraint::Percentage((100 - pct_x) / 2),
        ])
        .split(v[1])[1]
}

fn render_job(f: &mut Frame, job: &Job, area: Rect) {
    let area = centred(area, 86, 74);
    let state = match job.finished {
        None => Span::styled(" running ", Style::default().fg(Color::Yellow)),
        Some(true) => Span::styled(" done ", Style::default().fg(Color::Green)),
        Some(false) => Span::styled(" failed ", Style::default().fg(Color::Red)),
    };
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(Line::from(vec![
            Span::styled(format!(" {} ", job.label), bold()),
            state,
        ]));
    let inner = block.inner(area);
    f.render_widget(Clear, area);
    f.render_widget(block, area);

    // The tail, because the answer of every one of these commands is at the
    // end: the score, the total, the verdict.
    let wrapped = wrap_tail(&job.lines, inner.width as usize, inner.height as usize);
    let lines: Vec<Line> = wrapped
        .into_iter()
        .map(|l| Line::from(Span::raw(l)))
        .collect();
    f.render_widget(Paragraph::new(lines), inner);
}

/// The last `rows` screen rows of `lines`, hard wrapped at `width`.
///
/// Wrapping here rather than through `Paragraph::wrap` is what makes the tail
/// honest: the panel shows the END of a command's output, and the end is where
/// the answer is (the score, the verdict, the error). Counting unwrapped lines
/// against screen rows overcounts whenever a line is longer than the panel, so
/// the real last rows fall off the bottom while the visible ones run past the
/// right border. Reported from a real doctor run whose error message was cut
/// mid-sentence, 2026-08-05.
fn wrap_tail(lines: &[String], width: usize, rows: usize) -> Vec<String> {
    if width == 0 || rows == 0 {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for line in lines {
        if line.is_empty() {
            out.push(String::new());
            continue;
        }
        // Split on character count, not bytes: the output carries box glyphs
        // and check marks, and a byte slice would cut one in half.
        let chars: Vec<char> = line.chars().collect();
        for chunk in chars.chunks(width) {
            out.push(chunk.iter().collect());
        }
    }
    if out.len() > rows {
        out.drain(0..out.len() - rows);
    }
    out
}

fn render_palette(f: &mut Frame, area: Rect) {
    let area = centred(area, 66, 60);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .title(Span::styled(" commands ", bold()));
    let inner = block.inner(area);
    f.render_widget(Clear, area);
    f.render_widget(block, area);
    let lines: Vec<Line> = PALETTE
        .iter()
        .map(|e| {
            let key = Span::styled(format!(" {}  ", e.key), bold().fg(Color::Cyan));
            if e.runnable() {
                Line::from(vec![key, Span::raw(e.label)])
            } else {
                // Named, not hidden: a command that cannot run here still has
                // to say where it does run.
                Line::from(vec![
                    Span::styled(format!(" {}  ", e.key), dim()),
                    Span::styled(e.label, dim()),
                    Span::styled(format!("  {}", e.why_not), dim()),
                ])
            }
        })
        .collect();
    f.render_widget(Paragraph::new(lines).wrap(Wrap { trim: true }), inner);
}

fn render_header(f: &mut Frame, snap: &Snapshot, area: Rect, art: &[&str]) {
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(dim());
    let inner = block.inner(area);
    f.render_widget(block, area);

    // The art column is exactly as wide as the art, so the facts never float
    // away from it when the portrait is swapped for the hat.
    let art_w = art.iter().map(|l| l.chars().count()).max().unwrap_or(0) as u16;
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(if art_w == 0 { 0 } else { art_w + 2 }),
            Constraint::Min(0),
        ])
        .split(inner);

    let lines: Vec<Line> = art
        .iter()
        .map(|l| Line::from(Span::styled(*l, Style::default().fg(Color::Yellow))))
        .collect();
    f.render_widget(Paragraph::new(lines), cols[0]);

    // The daemon's own words beat the config file: the file says what SHOULD
    // serve, /health says what DOES.
    let (daemon_up, active, port) = match (&snap.config, &snap.health) {
        (Some(c), Some(h)) => (
            true,
            h.active_profile
                .clone()
                .unwrap_or_else(|| c.active_profile.clone()),
            c.port,
        ),
        (Some(c), None) => (false, c.active_profile.clone(), c.port),
        (None, _) => (false, "-".to_string(), 0),
    };
    let serving = snap
        .health
        .as_ref()
        .and_then(|h| h.slots.get("sonnet").or_else(|| h.slots.get("opus")))
        .cloned();

    let mut facts: Vec<Line> = vec![
        Line::from(vec![
            Span::styled("L U P I N", bold().fg(Color::Yellow)),
            Span::styled(format!("  v{VERSION}"), dim()),
            Span::styled("   the gentleman router", dim()),
        ]),
        if snap.config.is_none() {
            Line::from(Span::styled(
                "no config: run `lupin init` first",
                Style::default().fg(Color::Red),
            ))
        } else if daemon_up {
            Line::from(vec![
                Span::styled("daemon up", Style::default().fg(Color::Green)),
                Span::raw(format!("   127.0.0.1:{port}")),
            ])
        } else {
            Line::from(vec![
                Span::styled("daemon DOWN", Style::default().fg(Color::Red)),
                Span::styled("   `lupin run -- claude` starts it", dim()),
            ])
        },
        Line::from(vec![
            Span::raw("active: "),
            Span::styled(
                active,
                Style::default()
                    .fg(Color::Cyan)
                    .add_modifier(Modifier::BOLD),
            ),
            match serving {
                Some(m) => Span::raw(format!("  ->  {m}")),
                None => Span::raw(""),
            },
        ]),
    ];
    // Free-tier honesty (M6b): a line only when the daemon KNOWS it is free.
    if let Some(tier) = snap.health.as_ref().and_then(|h| h.tier.as_ref()) {
        if tier.free == Some(true) {
            let upgrade = tier
                .upgrade
                .as_ref()
                .map(|u| format!("  paid plan: {u}"))
                .unwrap_or_default();
            facts.push(Line::from(vec![
                Span::styled(
                    "FREE tier",
                    Style::default()
                        .fg(Color::Yellow)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(" (free models, free limits)", dim()),
                Span::styled(upgrade, dim()),
            ]));
        }
    }
    f.render_widget(Paragraph::new(facts), cols[1]);
}

fn render_profiles(f: &mut Frame, snap: &Snapshot, area: Rect, selected: usize) {
    let header = Row::new(vec![
        "profile",
        "mode",
        "opus/sonnet/haiku",
        "health",
        "doctor",
    ])
    .style(bold())
    .bottom_margin(0);

    let rows: Vec<Row> = match &snap.config {
        Some(c) => c
            .profiles
            .iter()
            .enumerate()
            .map(|(i, (name, p))| {
                let is_active = *name == c.active_profile;
                // The hotkey lives IN the row (nobody should have to count),
                // fused into the name cell so a narrow table can never
                // squeeze it off the screen.
                let key = if i < 9 {
                    format!("{}{}", if is_active { "*" } else { " " }, i + 1)
                } else {
                    (if is_active { "* " } else { "  " }).to_string()
                };
                let slots = format!(
                    "{}/{}/{}",
                    slot_label(p.slots.get("opus").unwrap_or(&serde_json::Value::Null)),
                    slot_label(p.slots.get("sonnet").unwrap_or(&serde_json::Value::Null)),
                    slot_label(p.slots.get("haiku").unwrap_or(&serde_json::Value::Null))
                );
                let health = snap
                    .health
                    .as_ref()
                    .and_then(|h| h.health.get(name).cloned())
                    .unwrap_or_else(|| "-".to_string());
                let doctor = p
                    .last_doctor
                    .as_ref()
                    .map(|d| format!("{}/{} {}", d.score, d.max, d.date))
                    .unwrap_or_else(|| "-".to_string());
                let style = if i == selected {
                    // The cursor: reversed so it reads on any theme, on top of
                    // the active colour so the two states never hide each other.
                    if is_active {
                        Style::default()
                            .fg(Color::Cyan)
                            .add_modifier(Modifier::REVERSED)
                    } else {
                        Style::default().add_modifier(Modifier::REVERSED)
                    }
                } else if is_active {
                    Style::default().fg(Color::Cyan)
                } else {
                    Style::default()
                };
                // The automatic-switch link (ADR-34) rides in the name cell:
                // the chain must be readable at a glance, row by row.
                let link = p
                    .failover
                    .as_ref()
                    .map(|t| format!(" ->{t}"))
                    .unwrap_or_default();
                Row::new(vec![
                    Cell::from(format!("{key} {name}{link}")),
                    Cell::from(p.mode.clone()),
                    Cell::from(slots),
                    Cell::from(health),
                    Cell::from(doctor),
                ])
                .style(style)
            })
            .collect(),
        None => vec![Row::new(vec!["no config", "", "", "", ""])],
    };

    let table = Table::new(
        rows,
        [
            Constraint::Min(13),
            Constraint::Length(11),
            Constraint::Min(18),
            Constraint::Min(8),
            Constraint::Min(10),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(dim())
            .title(Span::styled(" profiles ", bold())),
    );
    f.render_widget(table, area);
}

fn render_serving(f: &mut Frame, snap: &Snapshot, area: Rect) {
    let lines: Vec<Line> = match &snap.health {
        Some(h) => {
            let g = |k: &str| h.slots.get(k).cloned().unwrap_or_else(|| "-".to_string());
            vec![
                Line::from(vec![Span::styled("opus   ", dim()), Span::raw(g("opus"))]),
                Line::from(vec![Span::styled("sonnet ", dim()), Span::raw(g("sonnet"))]),
                Line::from(vec![Span::styled("haiku  ", dim()), Span::raw(g("haiku"))]),
            ]
        }
        None => vec![Line::from(Span::styled("unknown: daemon DOWN", dim()))],
    };
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(dim())
                .title(Span::styled(" serving now ", bold())),
        ),
        area,
    );
}

/// Stats over the rows the screen already holds: an honest window, not a
/// pretend "today" (the full aggregation is `lupin usage`, and stays there).
fn render_window(f: &mut Frame, snap: &Snapshot, area: Rect) {
    let total = snap.recent.len();
    let errors = snap.recent.iter().filter(|l| l.status >= 400).count();
    let p50 = {
        let mut lat: Vec<u64> = snap.recent.iter().map(|l| l.latency_ms).collect();
        lat.sort_unstable();
        lat.get(lat.len() / 2).copied()
    };
    let lines = if total == 0 {
        vec![Line::from(Span::styled("no traffic yet", dim()))]
    } else {
        vec![
            Line::from(vec![
                Span::raw(format!("{total} requests  ")),
                Span::styled(
                    format!("{errors} errors"),
                    if errors == 0 {
                        Style::default().fg(Color::Green)
                    } else {
                        Style::default().fg(Color::Red)
                    },
                ),
            ]),
            Line::from(Span::raw(match p50 {
                Some(ms) => format!("p50 {ms}ms"),
                None => String::new(),
            })),
        ]
    };
    f.render_widget(
        Paragraph::new(lines).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(dim())
                .title(Span::styled(" this window ", bold())),
        ),
        area,
    );
}

fn render_recent(f: &mut Frame, snap: &Snapshot, area: Rect) {
    let mut lines = Vec::new();
    if snap.recent.is_empty() {
        lines.push(Line::from(Span::styled("(nothing yet)", dim())));
    }
    for l in &snap.recent {
        let when = l.ts.get(11..19).unwrap_or("--------");
        let status_style = if (200..300).contains(&l.status) {
            Style::default().fg(Color::Green)
        } else {
            Style::default().fg(Color::Red)
        };
        let markers = l.markers();
        lines.push(Line::from(vec![
            Span::styled(format!("{when} "), dim()),
            Span::styled(format!("{:3}", l.status), status_style),
            Span::raw(format!(" {:>7}ms  {}/{}", l.latency_ms, l.profile, l.model)),
            Span::styled(
                if markers.is_empty() {
                    String::new()
                } else {
                    format!("  {markers}")
                },
                Style::default().fg(Color::Yellow),
            ),
        ]));
    }
    f.render_widget(
        Paragraph::new(lines).wrap(Wrap { trim: true }).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(dim())
                .title(Span::styled(" recent requests ", bold())),
        ),
        area,
    );
}

/// The talking line: what the dashboard just did, in words.
fn render_message(f: &mut Frame, message: &str, area: Rect) {
    f.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(" > ", Style::default().fg(Color::Yellow)),
            Span::raw(message.to_string()),
        ])),
        area,
    );
}

fn render_keys(f: &mut Frame, area: Rect) {
    f.render_widget(
        Paragraph::new(Line::from(Span::styled(
            "  q quit   1-9/arrows+enter switch   d doctor   : commands   o order   r refresh",
            dim(),
        ))),
        area,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::{Health, Snapshot, Tier};
    use crate::config::LupinConfig;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use std::collections::BTreeMap;

    /// The screen drawn into memory. Until this existed the rendering had never
    /// been exercised at all: the only way to see it was to open a terminal by
    /// hand, so a panic in a widget would have shipped unnoticed.
    fn screen(snap: &Snapshot) -> String {
        screen_with(snap, "ready")
    }

    fn screen_with(snap: &Snapshot, message: &str) -> String {
        screen_sel(snap, message, 0)
    }

    fn screen_sel(snap: &Snapshot, message: &str, selected: usize) -> String {
        let mut term = Terminal::new(TestBackend::new(100, 30)).expect("terminal");
        term.draw(|f| render(f, snap, message, selected, None, false))
            .expect("draw");
        term.backend()
            .buffer()
            .content()
            .iter()
            .map(|c| c.symbol())
            .collect::<String>()
    }

    fn config() -> LupinConfig {
        serde_json::from_str(
            r#"{
                "activeProfile": "kimi-sub",
                "port": 3456,
                "localToken": "tok",
                "profiles": {
                    "kimi-sub": {
                        "mode": "passthrough",
                        "slots": { "opus": "k2.5", "sonnet": "k2.5", "haiku": "k2" },
                        "lastDoctor": { "score": 9, "max": 10, "date": "2026-07-29" }
                    }
                }
            }"#,
        )
        .expect("config")
    }

    fn health() -> Health {
        let mut slots = BTreeMap::new();
        slots.insert("opus".to_string(), "k2.5".to_string());
        let mut h = BTreeMap::new();
        h.insert("kimi-sub".to_string(), "healthy".to_string());
        Health {
            active_profile: Some("kimi-sub".to_string()),
            slots,
            health: h,
            tier: None,
        }
    }

    #[test]
    fn a_healthy_daemon_shows_the_profile_and_its_models() {
        let snap = Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen(&snap);
        assert!(out.contains("daemon up"), "{out}");
        assert!(out.contains("kimi-sub"), "{out}");
        assert!(out.contains("k2.5"), "{out}");
        assert!(out.contains("3456"), "{out}");
    }

    #[test]
    #[allow(non_snake_case)] // DOWN is semantic: it is exactly what the screen prints
    fn a_silent_daemon_says_DOWN_instead_of_inventing_what_is_served() {
        let snap = Snapshot {
            config: Some(config()),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen(&snap);
        assert!(out.contains("daemon DOWN"), "{out}");
    }

    #[test]
    fn no_config_at_all_still_draws_a_screen_rather_than_panicking() {
        let snap = Snapshot {
            config: None,
            health: None,
            recent: Vec::new(),
            profile_names: Vec::new(),
        };
        let out = screen(&snap);
        assert!(out.contains("no config"), "{out}");
    }

    #[test]
    fn a_tiny_terminal_does_not_panic_on_the_layout() {
        // Every constraint asks for more rows than this: the widgets must cope.
        let snap = Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let mut term = Terminal::new(TestBackend::new(20, 4)).expect("terminal");
        term.draw(|f| render(f, &snap, "ready", 0, None, false))
            .expect("draw on a cramped screen");
    }

    #[test]
    fn a_known_free_tier_is_announced_never_guessed() {
        let mut h = health();
        h.tier = Some(Tier {
            free: Some(true),
            upgrade: Some("https://example.test/plans".to_string()),
        });
        let snap = Snapshot {
            config: Some(config()),
            health: Some(h),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen(&snap);
        assert!(out.contains("FREE tier"), "{out}");
        assert!(out.contains("example.test/plans"), "{out}");
        // And with no tier at all, no claim appears (the honesty rule).
        let none = screen(&Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        });
        assert!(!none.contains("FREE tier"), "{none}");
    }

    #[test]
    fn the_talking_line_repeats_the_last_action_in_words() {
        let snap = Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen_with(&snap, "active profile -> kimi-sub");
        assert!(out.contains("active profile -> kimi-sub"), "{out}");
    }

    #[test]
    fn the_hotkey_number_sits_in_the_profile_row() {
        let snap = Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: Vec::new(),
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen(&snap);
        // Active profile, first row: marker and hotkey together.
        assert!(out.contains("*1"), "{out}");
    }

    #[test]
    fn the_window_panel_counts_requests_and_errors_it_can_see() {
        let mk = |status: u16, ms: u64| crate::logtail::LogLine {
            ts: "2026-07-29T10:00:00.000Z".to_string(),
            path: "/v1/messages".to_string(),
            status,
            latency_ms: ms,
            profile: "p".to_string(),
            model: "m".to_string(),
            routed: None,
            failed_over: None,
            cooldown: None,
            stream_error: None,
        };
        let snap = Snapshot {
            config: Some(config()),
            health: Some(health()),
            recent: vec![mk(200, 100), mk(500, 300), mk(200, 200)],
            profile_names: vec!["kimi-sub".to_string()],
        };
        let out = screen(&snap);
        assert!(out.contains("3 requests"), "{out}");
        assert!(out.contains("1 errors"), "{out}");
        assert!(out.contains("p50 200ms"), "{out}");
    }

    /// True when any cell in the profiles panel carries the REVERSED modifier:
    /// the cursor highlight, drawn on the selected row.
    fn any_reversed(snap: &Snapshot, selected: usize) -> bool {
        let mut term = Terminal::new(TestBackend::new(100, 30)).expect("terminal");
        term.draw(|f| render(f, snap, "ready", selected, None, false))
            .expect("draw");
        term.backend()
            .buffer()
            .content()
            .iter()
            .any(|c| c.modifier.contains(Modifier::REVERSED))
    }

    fn two_profiles() -> LupinConfig {
        serde_json::from_str(
            r#"{
                "activeProfile": "a",
                "port": 3456,
                "localToken": "tok",
                "profiles": {
                    "a": { "mode": "passthrough", "slots": { "opus": "x", "sonnet": "x", "haiku": "y" } },
                    "b": { "mode": "passthrough", "slots": { "opus": "z", "sonnet": "z", "haiku": "z" } }
                }
            }"#,
        )
        .expect("config")
    }

    #[test]
    fn the_failover_link_shows_in_the_profile_row() {
        let mut cfg = two_profiles();
        cfg.profiles.get_mut("a").expect("a").failover = Some("b".to_string());
        let snap = Snapshot {
            config: Some(cfg),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["a".to_string(), "b".to_string()],
        };
        let out = screen(&snap);
        assert!(out.contains("a ->b"), "{out}");
        // And a profile with no failover carries no arrow of its own: the end
        // of the chain must look like an end.
        let none = screen(&Snapshot {
            config: Some(two_profiles()),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["a".to_string(), "b".to_string()],
        });
        assert!(!none.contains("a ->"), "{none}");
    }

    #[test]
    fn the_selected_row_is_highlighted() {
        let snap = Snapshot {
            config: Some(two_profiles()),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["a".to_string(), "b".to_string()],
        };
        // Selecting an existing row draws the cursor somewhere on screen.
        assert!(any_reversed(&snap, 0), "row 0 selected should highlight");
        assert!(any_reversed(&snap, 1), "row 1 selected should highlight");
    }

    #[test]
    fn moving_the_cursor_moves_the_highlight_to_a_different_row() {
        let snap = Snapshot {
            config: Some(two_profiles()),
            health: None,
            recent: Vec::new(),
            profile_names: vec!["a".to_string(), "b".to_string()],
        };
        // The reversed cell's vertical position changes with `selected`.
        let y_of = |selected: usize| {
            let mut term = Terminal::new(TestBackend::new(100, 30)).expect("terminal");
            term.draw(|f| render(f, &snap, "ready", selected, None, false))
                .expect("draw");
            let buf = term.backend().buffer();
            let width = buf.area().width as usize;
            buf.content()
                .iter()
                .position(|c| c.modifier.contains(Modifier::REVERSED))
                .map(|idx| idx / width)
                .expect("a reversed cell")
        };
        assert_ne!(y_of(0), y_of(1), "highlight must follow the cursor");
    }

    /// The two portraits must stay interchangeable: the header height is chosen
    /// before the art is, so a mismatch would silently clip one of them.
    #[test]
    fn the_two_portraits_are_the_same_height() {
        assert_eq!(ART_ASCII.len(), ART_BRAILLE.len());
        assert_eq!(art_for(40, true).len(), art_for(40, false).len());
    }

    #[test]
    fn a_terminal_without_the_glyphs_gets_plain_ascii() {
        let art = art_for(40, false);
        assert!(
            art.iter().all(|l| l.is_ascii()),
            "the ASCII portrait must survive a raster font: {art:?}"
        );
        assert!(art_for(40, true).iter().any(|l| !l.is_ascii()));
    }

    #[test]
    fn a_short_terminal_drops_the_portrait_before_it_clips() {
        assert_eq!(art_for(30, true), ART_BRAILLE_SMALL);
        assert_eq!(art_for(30, false), ART_HAT);
        assert!(art_for(12, true).is_empty());
    }

    /// The portrait is the point of the header, so it is what gets drawn unless
    /// something actually says otherwise. A missing locale is not otherwise.
    #[test]
    fn braille_is_the_default_and_only_evidence_takes_it_away() {
        assert!(
            braille_wanted(false, &[]),
            "no locale at all is not evidence"
        );
        assert!(braille_wanted(false, &["en_US.UTF-8"]));
        assert!(braille_wanted(false, &["C.utf8", ""]));
        assert!(
            !braille_wanted(false, &["C"]),
            "a non-UTF-8 locale steps it aside"
        );
        assert!(
            !braille_wanted(false, &["en_US.UTF-8", "POSIX"]),
            "any one of them is enough"
        );
        assert!(
            !braille_wanted(true, &["en_US.UTF-8"]),
            "LUPIN_TUI_ASCII always wins"
        );
    }

    /// The panel shows the tail because the answer is at the end. A long line
    /// takes more than one row, and counting it as one pushed the real last
    /// rows off the bottom while the visible text ran past the border.
    #[test]
    fn the_tail_is_counted_in_screen_rows_not_in_lines() {
        let lines = vec!["a".repeat(100), "short".to_string()];
        let out = wrap_tail(&lines, 20, 3);
        assert_eq!(out.len(), 3);
        assert_eq!(
            out.last().map(String::as_str),
            Some("short"),
            "the end must survive"
        );
        assert!(out.iter().all(|l| l.chars().count() <= 20), "{out:?}");
    }

    #[test]
    fn wrapping_splits_on_characters_so_a_glyph_is_never_cut_in_half() {
        let out = wrap_tail(&["✓ è un carattere multibyte".to_string()], 5, 10);
        assert!(out.iter().all(|l| l.chars().count() <= 5), "{out:?}");
        assert_eq!(out.concat(), "✓ è un carattere multibyte");
    }

    #[test]
    fn an_empty_line_still_takes_a_row() {
        assert_eq!(
            wrap_tail(&[String::new(), "x".to_string()], 10, 5),
            vec!["", "x"]
        );
    }

    #[test]
    fn a_panel_with_no_room_draws_nothing_rather_than_panicking() {
        assert!(wrap_tail(&["anything".to_string()], 0, 5).is_empty());
        assert!(wrap_tail(&["anything".to_string()], 10, 0).is_empty());
    }
}
