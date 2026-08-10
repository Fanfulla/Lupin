// The daemon-facing half: a snapshot of everything the screen needs, built
// from the local config, /health (the routing truth from the daemon itself)
// and the log tail. State changes go through the control API, never by
// writing the config file here.

use crate::config::{self, BootstrapIdentity, LupinConfig};
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

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Key,
    Oauth,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: String,
    pub description: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub suspension_warning: Option<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LoginStatus {
    Pending,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginPoll {
    pub status: LoginStatus,
    pub message: Option<String>,
    pub error: Option<String>,
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

pub fn snapshot(cfg_path: &Path, bootstrap_identity: Option<&BootstrapIdentity>) -> Snapshot {
    let config = config::load(cfg_path).ok();
    let (health, profile_names) = match &config {
        Some(c) => (fetch_health(c.port), c.profiles.keys().cloned().collect()),
        None => (
            bootstrap_identity.and_then(|identity| fetch_health(identity.port)),
            Vec::new(),
        ),
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

fn fetch_health(port: u16) -> Option<Health> {
    let url = format!("http://127.0.0.1:{port}/health");
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

pub fn fetch_providers(identity: &BootstrapIdentity) -> Result<Vec<ProviderRow>, String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/providers", identity.port);
    let res = control_client()?
        .get(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .send()
        .map_err(|_| daemon_not_answering())?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_providers(status, &body)
}

pub fn start_login(
    identity: &BootstrapIdentity,
    provider: &str,
    accept_risk: bool,
) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/login", identity.port);
    let body = serde_json::json!({ "provider": provider, "acceptRisk": accept_risk });
    let res = control_client()?
        .post(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .json(&body)
        .send()
        .map_err(|_| daemon_not_answering())?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_login_start(status, &body)
}

pub fn poll_login(identity: &BootstrapIdentity, job: &str) -> Result<LoginPoll, String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/login/{job}", identity.port);
    let res = control_client()?
        .get(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .send()
        .map_err(|_| daemon_not_answering())?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_login_poll(status, &body)
}

pub fn setup_key(identity: &BootstrapIdentity, provider_id: &str, key: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/setup-key", identity.port);
    let body = serde_json::json!({ "providerId": provider_id, "key": key });
    let res = control_client()?
        .post(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .json(&body)
        .send()
        .map_err(|_| daemon_not_answering())?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_setup_key(status, &body)
}

fn control_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())
}

fn daemon_not_answering() -> String {
    "daemon not answering (lupin run -- claude starts it)".to_string()
}

#[derive(Deserialize)]
struct ProvidersEnvelope {
    ok: bool,
    #[serde(default)]
    providers: Option<Vec<ProviderRow>>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_providers(status: u16, body: &str) -> Result<Vec<ProviderRow>, String> {
    let parsed: ProvidersEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| http_error(status)));
    }
    parsed.providers.ok_or_else(|| http_error(status))
}

#[derive(Deserialize)]
struct LoginStartEnvelope {
    ok: bool,
    #[serde(default)]
    job: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_login_start(status: u16, body: &str) -> Result<String, String> {
    let parsed: LoginStartEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| http_error(status)));
    }
    parsed.job.ok_or_else(|| http_error(status))
}

#[derive(Deserialize)]
struct LoginPollEnvelope {
    ok: bool,
    #[serde(default)]
    status: Option<LoginStatus>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_login_poll(status: u16, body: &str) -> Result<LoginPoll, String> {
    let parsed: LoginPollEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| http_error(status)));
    }
    Ok(LoginPoll {
        status: parsed.status.ok_or_else(|| http_error(status))?,
        message: parsed.message,
        error: parsed.error,
    })
}

#[derive(Deserialize)]
struct SetupKeyEnvelope {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

fn parse_setup_key(status: u16, body: &str) -> Result<(), String> {
    let parsed: SetupKeyEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| http_error(status)));
    }
    Ok(())
}

fn http_error(status: u16) -> String {
    format!("daemon said HTTP {status}")
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

/// Replace the agent-routes table (SPEC-PROVIDERS section 4decies): one atomic
/// call, like the switch order. The daemon validates, writes the config and
/// hot-reloads; the outcome comes back as words for the talking line.
pub fn set_agents(
    snap: &Snapshot,
    agents: &std::collections::BTreeMap<String, serde_json::Value>,
) -> Result<(), String> {
    let Some(config) = &snap.config else {
        return Err("no config".to_string());
    };
    let url = format!("http://127.0.0.1:{}/v1/lupin/agents", config.port);
    let body = serde_json::json!({ "agents": agents });
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
    use super::{
        parse_login_poll, parse_login_start, parse_providers, parse_setup_key, AuthKind, Health,
        LoginStatus,
    };

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

    #[test]
    fn provider_catalogue_decodes_auth_kinds_and_optional_warning() {
        let body = r#"{
            "ok": true,
            "providers": [
                { "id": "key-row", "description": "Key provider", "authKind": "key" },
                {
                    "id": "oauth-row",
                    "description": "OAuth provider",
                    "authKind": "oauth",
                    "suspensionWarning": "Account risk"
                }
            ]
        }"#;
        let rows = parse_providers(200, body).expect("provider catalogue");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].auth_kind, AuthKind::Key);
        assert_eq!(rows[0].suspension_warning, None);
        assert_eq!(rows[1].auth_kind, AuthKind::Oauth);
        assert_eq!(rows[1].suspension_warning.as_deref(), Some("Account risk"));
    }

    #[test]
    fn login_poll_preserves_pending_url_and_done_state() {
        let pending = parse_login_poll(
            200,
            r#"{"ok":true,"status":"pending","message":"https://auth.example/start"}"#,
        )
        .expect("pending login");
        assert_eq!(pending.status, LoginStatus::Pending);
        assert_eq!(
            pending.message.as_deref(),
            Some("https://auth.example/start")
        );
        assert_eq!(pending.error, None);

        let done = parse_login_poll(200, r#"{"ok":true,"status":"done"}"#).expect("done login");
        assert_eq!(done.status, LoginStatus::Done);
        assert_eq!(done.message, None);
        assert_eq!(done.error, None);
    }

    #[test]
    fn login_start_returns_the_job_id() {
        assert_eq!(
            parse_login_start(200, r#"{"ok":true,"job":"job-7"}"#),
            Ok("job-7".to_string())
        );
    }

    #[test]
    fn route_errors_surface_the_node_error_text() {
        assert_eq!(
            parse_login_start(
                409,
                r#"{"ok":false,"error":"Risk acceptance required","requiresRiskAcceptance":true}"#,
            ),
            Err("Risk acceptance required".to_string())
        );
        assert_eq!(
            parse_providers(503, "not json"),
            Err("daemon said HTTP 503".to_string())
        );
    }

    #[test]
    fn successful_key_setup_requires_an_ok_envelope() {
        assert_eq!(parse_setup_key(200, r#"{"ok":true}"#), Ok(()));
        assert_eq!(
            parse_setup_key(400, r#"{"ok":false,"error":"invalid key"}"#),
            Err("invalid key".to_string())
        );
    }
}
