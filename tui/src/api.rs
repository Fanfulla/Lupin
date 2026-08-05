// The daemon-facing half: a snapshot of everything the screen needs, built
// from the local config, /health (the routing truth from the daemon itself)
// and the log tail. State changes go through the control API, never by
// writing the config file here.

use crate::config::{self, LupinConfig};
use crate::logtail::{self, LogLine};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Health {
    #[serde(default)]
    #[serde(rename = "activeProfile")]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub slots: BTreeMap<String, String>,
    #[serde(default)]
    pub health: BTreeMap<String, String>,
    /// The free-tier honesty (M6b): shown only when the daemon KNOWS.
    #[serde(default)]
    pub tier: Option<Tier>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Tier {
    #[serde(default)]
    pub free: Option<bool>,
    #[serde(default)]
    pub upgrade: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Snapshot {
    pub config: Option<LupinConfig>,
    /// None when the daemon is not answering: the screen says so, not guesses.
    pub health: Option<Health>,
    pub recent: Vec<LogLine>,
    /// Profile names in display order: the 1-9 hotkeys index into this.
    pub profile_names: Vec<String>,
}

pub fn snapshot(cfg_path: &Path) -> Snapshot {
    let config = config::load(cfg_path).ok();
    let (health, profile_names) = match &config {
        Some(c) => (fetch_health(c), c.profiles.keys().cloned().collect()),
        None => (None, Vec::new()),
    };
    let recent = config::lupin_dir()
        .map(|d| logtail::recent(&d.join("lupin.log"), 12))
        .unwrap_or_default();
    Snapshot {
        config,
        health,
        recent,
        profile_names,
    }
}

fn fetch_health(config: &LupinConfig) -> Option<Health> {
    let url = format!("http://127.0.0.1:{}/health", config.port);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(800))
        .build()
        .ok()?;
    let res = client.get(&url).send().ok()?;
    // The status is the whole answer here. When the daemon dies, the watchdog
    // re-binds the port and serves a 529 to EVERY path, which is its job (a
    // live Claude Code session needs a well-formed retryable error). Its body
    // is an Anthropic error object, and `Health` has no required field, so it
    // parsed into an empty Health and the dashboard announced "daemon up" while
    // every switch failed against a watchdog. Reported from a real session,
    // 2026-08-05.
    if !res.status().is_success() {
        return None;
    }
    res.json::<Health>().ok()
}

/// Switch the active profile through the control API (the daemon writes the
/// config; the hot-reload watch reloads it). The outcome comes back as words
/// for the status line: a silent failure looks identical to a slow refresh,
/// and a dashboard that swallows errors is not "talking".
/// Set the automatic-switch order (ADR-34): one atomic call, the daemon
/// rewrites the failover chain and hot-reloads. Same shape as switch_profile:
/// the outcome comes back as words for the talking line.
pub fn set_switch_order(snap: &Snapshot, order: &[String]) -> Result<(), String> {
    let Some(config) = &snap.config else {
        return Err("no config".to_string());
    };
    let url = format!("http://127.0.0.1:{}/v1/lupin/switch-order", config.port);
    let body = serde_json::json!({ "order": order });
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("authorization", format!("Bearer {}", config.local_token))
        .json(&body)
        .send()
        .map_err(|_| "daemon not answering (lupin run -- claude starts it)".to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("daemon said HTTP {}", res.status().as_u16()))
    }
}

pub fn switch_profile(snap: &Snapshot, name: &str) -> Result<(), String> {
    let Some(config) = &snap.config else {
        return Err("no config".to_string());
    };
    let url = format!("http://127.0.0.1:{}/v1/lupin/use", config.port);
    let body = serde_json::json!({ "profile": name });
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("authorization", format!("Bearer {}", config.local_token))
        .json(&body)
        .send()
        .map_err(|_| "daemon not answering (lupin run -- claude starts it)".to_string())?;
    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("daemon said HTTP {}", res.status().as_u16()))
    }
}

#[cfg(test)]
mod tests {
    use super::Health;

    /// The reason `fetch_health` checks the status before parsing. The watchdog
    /// answers a 529 whose body is an Anthropic error object, and nothing in
    /// `Health` is required, so serde accepts it happily and returns a Health
    /// with no profile and no slots. A dashboard that trusted the parse
    /// announced "daemon up" while every switch failed (2026-08-05).
    #[test]
    fn an_anthropic_error_body_parses_as_an_empty_health() {
        let body =
            r#"{"type":"error","error":{"type":"api_error","message":"Lupin daemon is down"}}"#;
        let parsed: Health = serde_json::from_str(body).expect("it parses, and that is the trap");
        assert!(parsed.active_profile.is_none());
        assert!(parsed.slots.is_empty());
        assert!(parsed.health.is_empty());
    }

    #[test]
    fn a_real_health_body_still_parses() {
        let body =
            r#"{"activeProfile":"kimi-sub","slots":{"opus":"k3"},"health":{"kimi-sub":"healthy"}}"#;
        let parsed: Health = serde_json::from_str(body).expect("health");
        assert_eq!(parsed.active_profile.as_deref(), Some("kimi-sub"));
        assert_eq!(parsed.slots.get("opus").map(String::as_str), Some("k3"));
    }
}
