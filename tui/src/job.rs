// Running a CLI command from the dashboard without freezing it.
//
// The dashboard repaints on a 200ms poll, and `lupin doctor` takes two to three
// minutes: running it inline would leave a dead screen for the whole session
// and look like a crash. So a job is a child process plus a thread that pushes
// its output down a channel, and the main loop drains the channel each tick.
//
// The commands are the CLI's, spawned as a child, never reimplemented here.
// That is the same rule the rest of this binary follows: the screen has no
// truth of its own, so the two surfaces cannot disagree.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver, TryRecvError};

/// How the `lupin` command has to be launched on this machine.
///
/// On Windows the global npm install puts a `lupin.cmd` shim on PATH, and a
/// batch file cannot be spawned directly: `CreateProcess` refuses it, which is
/// the same trap ADR-29 documents on the Node side. It has to go through
/// `cmd /c`. An `.exe` (or a POSIX executable) is spawned directly, which keeps
/// argument fidelity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launcher {
    Direct(PathBuf),
    ThroughCmd(PathBuf),
}

impl Launcher {
    fn command(&self, args: &[String]) -> Command {
        match self {
            Launcher::Direct(p) => {
                let mut c = Command::new(p);
                c.args(args);
                c
            }
            Launcher::ThroughCmd(p) => {
                let mut c = Command::new("cmd");
                c.arg("/c").arg(p).args(args);
                c
            }
        }
    }
}

/// Pick a launcher from candidate paths, in the caller's order of preference.
/// Separated from the filesystem so the Windows shim rule is testable anywhere.
pub fn pick_launcher(existing: &[PathBuf]) -> Option<Launcher> {
    let batch = |p: &Path| {
        matches!(
            p.extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("cmd") | Some("bat")
        )
    };
    // An executable beats a shim when both are present: fewer parsers in the
    // way means the arguments arrive as written.
    existing
        .iter()
        .find(|p| !batch(p))
        .map(|p| Launcher::Direct(p.clone()))
        .or_else(|| existing.first().map(|p| Launcher::ThroughCmd(p.clone())))
}

/// The candidate names for `lupin` on this platform, in preference order.
pub fn candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["lupin.exe", "lupin.cmd", "lupin.bat"]
    } else {
        &["lupin"]
    }
}

/// Walk PATH for the CLI. `None` means the dashboard says so instead of
/// spawning something that does not exist.
pub fn find_lupin() -> Option<Launcher> {
    let path = std::env::var_os("PATH")?;
    let mut found: Vec<PathBuf> = Vec::new();
    for dir in std::env::split_paths(&path) {
        for name in candidate_names() {
            let p = dir.join(name);
            if p.is_file() {
                found.push(p);
            }
        }
    }
    pick_launcher(&found)
}

/// A running (or finished) child command and everything the screen shows of it.
pub struct Job {
    pub label: String,
    pub lines: Vec<String>,
    pub finished: Option<bool>,
    rx: Receiver<Message>,
}

enum Message {
    Line(String),
    Done(bool),
}

/// Output kept in memory. A doctor run prints a few dozen lines; the cap is
/// there so a runaway command cannot grow the buffer without end.
pub const MAX_LINES: usize = 400;

impl Job {
    pub fn spawn(
        launcher: &Launcher,
        label: impl Into<String>,
        args: &[String],
    ) -> std::io::Result<Job> {
        let mut cmd = launcher.command(args);
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn()?;
        let (tx, rx) = mpsc::channel();
        // stderr is merged into the same stream on purpose: the CLI puts usage
        // errors there, and a job that fails silently on screen is the bug this
        // whole module exists to avoid.
        let out = child.stdout.take();
        let err = child.stderr.take();
        let tx_err = tx.clone();
        if let Some(err) = err {
            std::thread::spawn(move || {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if tx_err.send(Message::Line(line)).is_err() {
                        return;
                    }
                }
            });
        }
        std::thread::spawn(move || {
            if let Some(out) = out {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if tx.send(Message::Line(line)).is_err() {
                        return;
                    }
                }
            }
            let ok = child.wait().map(|s| s.success()).unwrap_or(false);
            let _ = tx.send(Message::Done(ok));
        });
        Ok(Job {
            label: label.into(),
            lines: Vec::new(),
            finished: None,
            rx,
        })
    }

    /// Drain whatever the child produced since the last tick. Never blocks: the
    /// repaint cadence must not depend on how talkative the command is.
    pub fn poll(&mut self) {
        loop {
            match self.rx.try_recv() {
                Ok(Message::Line(l)) => {
                    self.lines.push(l);
                    if self.lines.len() > MAX_LINES {
                        self.lines.drain(0..self.lines.len() - MAX_LINES);
                    }
                }
                Ok(Message::Done(ok)) => self.finished = Some(ok),
                // Disconnected without a Done means the reader thread died with
                // the child: treat it as finished rather than spinning forever.
                Err(TryRecvError::Disconnected) => {
                    if self.finished.is_none() {
                        self.finished = Some(false);
                    }
                    return;
                }
                Err(TryRecvError::Empty) => return,
            }
        }
    }

    pub fn running(&self) -> bool {
        self.finished.is_none()
    }
}

/// One row of the command palette.
pub struct PaletteEntry {
    pub key: char,
    pub label: &'static str,
    /// Arguments for the CLI, empty when this row cannot be run from here.
    pub args: &'static [&'static str],
    /// Why it cannot be run from here. Empty for the runnable ones.
    pub why_not: &'static str,
}

impl PaletteEntry {
    pub fn runnable(&self) -> bool {
        self.why_not.is_empty()
    }
}

/// What the palette offers, and what it refuses to pretend about.
///
/// Three commands cannot be hosted by a dashboard and saying so beats a row
/// that hangs: `init` reads hidden input, `login` opens a browser and waits for
/// the user to come back, and `run`/`go`/`resume` hand the terminal to Claude
/// Code, which needs to own it.
pub const PALETTE: &[PaletteEntry] = &[
    PaletteEntry {
        key: 'd',
        label: "doctor (selected profile)",
        args: &["doctor"],
        why_not: "",
    },
    PaletteEntry {
        key: 'u',
        label: "usage: tokens really served",
        args: &["usage"],
        why_not: "",
    },
    PaletteEntry {
        key: 'l',
        label: "list: profiles, slots, doctor scores",
        args: &["list"],
        why_not: "",
    },
    PaletteEntry {
        key: 's',
        label: "status: is the daemon up",
        args: &["status"],
        why_not: "",
    },
    PaletteEntry {
        key: 'x',
        label: "stop the daemon",
        args: &["stop"],
        why_not: "",
    },
    PaletteEntry {
        key: 'i',
        label: "init",
        args: &[],
        why_not: "a wizard with hidden input: run `lupin init` in a shell",
    },
    PaletteEntry {
        key: 'g',
        label: "login",
        args: &[],
        why_not: "opens a browser and waits: run `lupin login <provider>` in a shell",
    },
    PaletteEntry {
        key: 'c',
        label: "run claude",
        args: &[],
        why_not: "Claude Code needs the terminal: run `lupin run -- claude` in a shell",
    },
];

pub fn palette_entry(key: char) -> Option<&'static PaletteEntry> {
    PALETTE.iter().find(|e| e.key == key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_executable_beats_a_batch_shim() {
        let picked = pick_launcher(&[PathBuf::from("/x/lupin.cmd"), PathBuf::from("/x/lupin.exe")]);
        assert_eq!(
            picked,
            Some(Launcher::Direct(PathBuf::from("/x/lupin.exe")))
        );
    }

    /// A .cmd cannot be spawned directly (ADR-29 on the Node side, CreateProcess
    /// on this one), so it has to go through cmd /c or the job never starts.
    #[test]
    fn a_batch_shim_is_launched_through_cmd() {
        let picked = pick_launcher(&[PathBuf::from("C:/npm/lupin.cmd")]);
        assert_eq!(
            picked,
            Some(Launcher::ThroughCmd(PathBuf::from("C:/npm/lupin.cmd")))
        );
        let picked = pick_launcher(&[PathBuf::from("C:/npm/lupin.BAT")]);
        assert!(
            matches!(picked, Some(Launcher::ThroughCmd(_))),
            "the extension test is case blind"
        );
    }

    #[test]
    fn nothing_on_path_is_not_a_launcher() {
        assert_eq!(pick_launcher(&[]), None);
    }

    #[test]
    fn every_palette_key_is_unique() {
        let mut keys: Vec<char> = PALETTE.iter().map(|e| e.key).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before, "two palette rows share a key");
    }

    /// The point of the palette is that it does not pretend: a row that cannot
    /// run must carry the reason, and a row that can must carry arguments.
    #[test]
    fn every_row_either_runs_or_says_why_not() {
        for e in PALETTE {
            if e.runnable() {
                assert!(
                    !e.args.is_empty(),
                    "{} is runnable with no arguments",
                    e.label
                );
            } else {
                assert!(
                    e.args.is_empty(),
                    "{} has arguments but is not runnable",
                    e.label
                );
                assert!(
                    e.why_not.contains("shell"),
                    "{} must say where to run it",
                    e.label
                );
            }
        }
    }

    #[test]
    fn a_job_collects_output_and_reports_the_exit() {
        let launcher = if cfg!(windows) {
            Launcher::Direct(PathBuf::from("cmd"))
        } else {
            Launcher::Direct(PathBuf::from("sh"))
        };
        let args: Vec<String> = if cfg!(windows) {
            vec!["/c".into(), "echo hello".into()]
        } else {
            vec!["-c".into(), "echo hello".into()]
        };
        let mut job = Job::spawn(&launcher, "echo", &args).expect("spawn");
        for _ in 0..200 {
            job.poll();
            if !job.running() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert_eq!(job.finished, Some(true), "lines so far: {:?}", job.lines);
        assert!(
            job.lines.iter().any(|l| l.contains("hello")),
            "{:?}",
            job.lines
        );
    }
}
