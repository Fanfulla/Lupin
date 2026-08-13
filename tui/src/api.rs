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
    Local,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRow {
    pub id: String,
    pub description: String,
    pub auth_kind: AuthKind,
    #[serde(default)]
    pub suspension_warning: Option<String>,
    /// Key rows only: a human-readable description of the economy preset.
    #[serde(default)]
    pub economy: Option<String>,
    /// Local rows only: the shell command that starts the server, shown when
    /// discovery fails.
    #[serde(default)]
    pub start_hint: Option<String>,
    /// OAuth rows: credentials of the official provider CLI exist on this
    /// machine and can be imported without a browser.
    #[serde(default)]
    pub import_available: bool,
}

/// One model the local runtime discovery found (ADR-51): filtered to chat
/// models already, so an empty list means "server up, nothing installed".
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalModel {
    pub id: String,
    #[serde(default)]
    pub context_window: Option<u64>,
    /// "loaded" = the window the model actually runs with; "max" = the
    /// model's theoretical maximum, which is not what gets served.
    #[serde(default)]
    pub context_window_source: Option<String>,
    #[serde(default)]
    pub supports_tools: Option<bool>,
    #[serde(default)]
    pub supports_vision: Option<bool>,
    #[serde(default)]
    pub context_too_small: bool,
}

/// One model of a hosted provider's published catalogue (design 2026-08-13),
/// as `/v1/lupin/discover-catalog` normalizes it. It informs the assisted
/// input; it never gates a write (ADR-42).
#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogModel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub supports_tools: Option<bool>,
    /// USD per token, as the provider publishes it.
    #[serde(default)]
    pub prompt_price: Option<f64>,
    #[serde(default)]
    pub completion_price: Option<f64>,
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
    account: Option<&str>,
    import_if_available: bool,
) -> Result<String, String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/login", identity.port);
    let mut body = serde_json::json!({ "provider": provider, "acceptRisk": accept_risk });
    if let Some(a) = account {
        body["account"] = serde_json::json!(a);
    }
    if import_if_available {
        body["importIfAvailable"] = serde_json::json!(true);
    }
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

/// The optional fields `setup-key` grows beyond `{ providerId, key }`.
#[derive(Debug, Clone, Default)]
pub struct SetupKeyOptions {
    pub economy: bool,
    /// Retry after a failed connectivity test: store anyway.
    pub save_anyway: bool,
}

/// A rejected `setup-key`: the message for the talking line, and whether the
/// daemon is offering the "save anyway" escape hatch (a failed connectivity
/// test only, never a bad request).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupKeyError {
    pub message: String,
    pub can_save_anyway: bool,
}

pub fn setup_key(
    identity: &BootstrapIdentity,
    provider_id: &str,
    key: &str,
    opts: &SetupKeyOptions,
) -> Result<(), SetupKeyError> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/setup-key", identity.port);
    let mut body = serde_json::json!({ "providerId": provider_id, "key": key });
    if opts.economy {
        body["economy"] = serde_json::json!(true);
    }
    if opts.save_anyway {
        body["saveAnyway"] = serde_json::json!(true);
    }
    let client = setup_key_client().map_err(|e| SetupKeyError {
        message: e,
        can_save_anyway: false,
    })?;
    let res = client
        .post(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .json(&body)
        .send()
        .map_err(|_| SetupKeyError {
            message: daemon_not_answering(),
            can_save_anyway: false,
        })?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_setup_key(status, &body)
}

/// A rejected `discover-local`/`setup-local`: both share the same envelope, an
/// unreachable local server carries the start command as its own remedy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalDiscoveryError {
    pub message: String,
    pub start_hint: Option<String>,
}

pub fn discover_local(
    identity: &BootstrapIdentity,
    provider_id: &str,
) -> Result<Vec<LocalModel>, LocalDiscoveryError> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/discover-local", identity.port);
    let body = serde_json::json!({ "providerId": provider_id });
    let client = control_client().map_err(|e| LocalDiscoveryError {
        message: e,
        start_hint: None,
    })?;
    let res = client
        .post(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .json(&body)
        .send()
        .map_err(|_| LocalDiscoveryError {
            message: daemon_not_answering(),
            start_hint: None,
        })?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_discover_local(status, &body)
}

/// The hosted twin of `discover_local` (design 2026-08-13): the provider's
/// published catalogue, normalized and cached daemon-side. A 404 (provider
/// without a catalogue) and a 502 (catalogue unreachable) both come back as
/// Err: the caller degrades to a plain input, never to an error state.
pub fn discover_catalog(
    identity: &BootstrapIdentity,
    provider_id: &str,
    profile: Option<&str>,
) -> Result<Vec<CatalogModel>, String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/discover-catalog", identity.port);
    // The profile rides along for the auth catalogues (ADR-53): the daemon
    // resolves that profile's own key; public catalogues ignore it.
    let mut body = serde_json::json!({ "providerId": provider_id });
    if let Some(p) = profile {
        body["profile"] = serde_json::json!(p);
    }
    // The daemon's first fetch goes upstream (10s bound server-side), so this
    // deserves the generous client, not the 1.5s control one.
    let res = setup_key_client()?
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
    parse_discover_catalog(status, &body)
}

#[derive(Deserialize)]
struct CatalogEnvelope {
    ok: bool,
    #[serde(default)]
    models: Vec<CatalogModel>,
    #[serde(default)]
    error: Option<String>,
}

fn parse_discover_catalog(status: u16, body: &str) -> Result<Vec<CatalogModel>, String> {
    let parsed: CatalogEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| http_error(status)));
    }
    Ok(parsed.models)
}

/// The picks `setup-local` writes into the new profile.
pub struct SetupLocalRequest<'a> {
    pub provider_id: &'a str,
    pub main: &'a str,
    pub light: &'a str,
    /// Offered only for models that declare vision and differ from `main`.
    pub vision: Option<&'a str>,
    pub long_context: bool,
}

pub fn setup_local(
    identity: &BootstrapIdentity,
    req: &SetupLocalRequest,
) -> Result<(), LocalDiscoveryError> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/setup-local", identity.port);
    let mut body = serde_json::json!({
        "providerId": req.provider_id,
        "main": req.main,
        "light": req.light,
    });
    if let Some(v) = req.vision {
        body["vision"] = serde_json::json!(v);
    }
    if req.long_context {
        body["longContext"] = serde_json::json!(true);
    }
    // setup-local re-runs the live discovery server-side before writing (a
    // stale screen must not persist a model the server no longer serves), so
    // it deserves the same generous timeout as setup-key.
    let client = setup_key_client().map_err(|e| LocalDiscoveryError {
        message: e,
        start_hint: None,
    })?;
    let res = client
        .post(url)
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Bearer {}", identity.local_token),
        )
        .json(&body)
        .send()
        .map_err(|_| LocalDiscoveryError {
            message: daemon_not_answering(),
            start_hint: None,
        })?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_setup_local(status, &body)
}

pub fn logout(
    identity: &BootstrapIdentity,
    provider: &str,
    account: Option<&str>,
) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/logout", identity.port);
    let mut body = serde_json::json!({ "provider": provider });
    if let Some(a) = account {
        body["account"] = serde_json::json!(a);
    }
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
    parse_logout(status, &body)
}

/// Sets one profile's failover on its own route: the TUI asks AFTER a setup
/// succeeded (the answer follows the verdict), so the write cannot ride the
/// setup body. The setup routes still take `failover` for headless one-call
/// setups; this surface never sends it there.
pub fn set_failover(identity: &BootstrapIdentity, profile: &str, failover: &str) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{}/v1/lupin/failover", identity.port);
    let body = serde_json::json!({ "profile": profile, "failover": failover });
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
    parse_logout(status, &body)
}

fn control_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())
}

fn setup_key_client() -> Result<reqwest::blocking::Client, String> {
    // Node may spend up to 15 seconds verifying the provider. The caller must
    // wait for that authoritative save-or-reject answer, plus local overhead.
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
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
    #[serde(default, rename = "canSaveAnyway")]
    can_save_anyway: bool,
}

fn parse_setup_key(status: u16, body: &str) -> Result<(), SetupKeyError> {
    let parsed: SetupKeyEnvelope = serde_json::from_str(body).map_err(|_| SetupKeyError {
        message: http_error(status),
        can_save_anyway: false,
    })?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(SetupKeyError {
            message: parsed.error.unwrap_or_else(|| http_error(status)),
            can_save_anyway: parsed.can_save_anyway,
        });
    }
    Ok(())
}

#[derive(Deserialize)]
struct DiscoverLocalEnvelope {
    ok: bool,
    #[serde(default)]
    models: Option<Vec<LocalModel>>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "startHint")]
    start_hint: Option<String>,
}

fn parse_discover_local(status: u16, body: &str) -> Result<Vec<LocalModel>, LocalDiscoveryError> {
    let parsed: DiscoverLocalEnvelope =
        serde_json::from_str(body).map_err(|_| LocalDiscoveryError {
            message: http_error(status),
            start_hint: None,
        })?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(LocalDiscoveryError {
            message: parsed.error.unwrap_or_else(|| http_error(status)),
            start_hint: parsed.start_hint,
        });
    }
    Ok(parsed.models.unwrap_or_default())
}

#[derive(Deserialize)]
struct SetupLocalEnvelope {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default, rename = "startHint")]
    start_hint: Option<String>,
}

fn parse_setup_local(status: u16, body: &str) -> Result<(), LocalDiscoveryError> {
    let parsed: SetupLocalEnvelope =
        serde_json::from_str(body).map_err(|_| LocalDiscoveryError {
            message: http_error(status),
            start_hint: None,
        })?;
    if !(200..300).contains(&status) || !parsed.ok {
        return Err(LocalDiscoveryError {
            message: parsed.error.unwrap_or_else(|| http_error(status)),
            start_hint: parsed.start_hint,
        });
    }
    Ok(())
}

#[derive(Deserialize)]
struct LogoutEnvelope {
    ok: bool,
    #[serde(default)]
    error: Option<String>,
}

fn parse_logout(status: u16, body: &str) -> Result<(), String> {
    let parsed: LogoutEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
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

/// The `POST /v1/lupin/slots` body: only the aimed slots are named, so the
/// daemon leaves the others alone. A model whose window the catalogue knows
/// rides the same call as `contextWindows` (design 2026-08-13), so one
/// gesture is one write. Split out for the wire test.
fn slots_body(
    profile: &str,
    aims: &[(&'static str, String)],
    windows: &[(String, u64)],
) -> serde_json::Value {
    let mut body = serde_json::json!({ "profile": profile });
    for (slot, model) in aims {
        body[*slot] = serde_json::json!(model);
    }
    if !windows.is_empty() {
        let map: serde_json::Map<String, serde_json::Value> = windows
            .iter()
            .map(|(model, w)| (model.clone(), serde_json::json!(w)))
            .collect();
        body["contextWindows"] = serde_json::Value::Object(map);
    }
    body
}

/// Aim a profile's slots (SPEC-CLI section 1, the `use --opus` rule): the
/// names travel as given and are never checked, and the screen says so too.
pub fn set_slots(
    snap: &Snapshot,
    profile: &str,
    aims: &[(&'static str, String)],
    windows: &[(String, u64)],
) -> Result<(), String> {
    let Some(config) = &snap.config else {
        return Err("no config".to_string());
    };
    let url = format!("http://127.0.0.1:{}/v1/lupin/slots", config.port);
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_millis(1500))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("authorization", format!("Bearer {}", config.local_token))
        .json(&slots_body(profile, aims, windows))
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

/// What a wire wrote (ADR-48 over the control API, design 2026-08-13): the
/// file, the previous value when the field existed, and what it says now.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WireOutcome {
    pub file: String,
    #[serde(default)]
    pub previous: Option<String>,
    pub value: String,
}

#[derive(Deserialize)]
struct WireEnvelope {
    ok: bool,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    previous: Option<String>,
    #[serde(default)]
    value: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    hint: Option<String>,
}

fn parse_wire(status: u16, body: &str) -> Result<WireOutcome, String> {
    let parsed: WireEnvelope = serde_json::from_str(body).map_err(|_| http_error(status))?;
    if !(200..300).contains(&status) || !parsed.ok {
        let error = parsed.error.unwrap_or_else(|| http_error(status));
        return Err(match parsed.hint {
            Some(hint) => format!("{error}. Add the line yourself: {hint}"),
            None => error,
        });
    }
    match (parsed.file, parsed.value) {
        (Some(file), Some(value)) => Ok(WireOutcome {
            file,
            previous: parsed.previous,
            value,
        }),
        _ => Err(http_error(status)),
    }
}

/// The ADR-48 wire gesture: the daemon finds the agent file and edits its one
/// frontmatter field. The TUI's cwd rides along, because the daemon's own cwd
/// is the state directory (ADR-49) and the project-level `.claude/agents`
/// lookup would miss without it.
pub fn wire_agent(snap: &Snapshot, name: &str) -> Result<WireOutcome, String> {
    let Some(config) = &snap.config else {
        return Err("no config".to_string());
    };
    let url = format!("http://127.0.0.1:{}/v1/lupin/agents/wire", config.port);
    let mut body = serde_json::json!({ "name": name });
    if let Some(cwd) = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
    {
        body["cwd"] = serde_json::json!(cwd);
    }
    let res = control_client()?
        .post(&url)
        .header("authorization", format!("Bearer {}", config.local_token))
        .json(&body)
        .send()
        .map_err(|_| "daemon not answering (lupin run -- claude starts it)".to_string())?;
    let status = res.status().as_u16();
    let body = res.text().unwrap_or_default();
    parse_wire(status, &body)
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
        discover_local, logout, parse_discover_catalog, parse_discover_local, parse_login_poll,
        parse_login_start, parse_providers, parse_setup_key, parse_setup_local, set_failover,
        setup_key, setup_local, slots_body, start_login, AuthKind, Health, LoginStatus,
        SetupKeyOptions, SetupLocalRequest,
    };
    use crate::config::BootstrapIdentity;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::Duration;

    /// A loopback server that answers `response` once and hands back the raw
    /// request bytes it received: the only way to check the wire shape a
    /// client function actually sends, not just what it claims to send.
    fn capture_request(response: &str) -> (BootstrapIdentity, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let port = listener.local_addr().expect("listener address").port();
        let response = response.to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("connection");
            let mut buf = [0_u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]).to_string();
            let _ = stream.write_all(response.as_bytes());
            request
        });
        let identity = BootstrapIdentity {
            port,
            local_token: "tok".to_string(),
        };
        (identity, handle)
    }

    /// A minimal well-formed HTTP/1.1 JSON response with a correct
    /// Content-Length, computed from the body so a hand-counted mismatch can
    /// never leave a test hanging on a client that expects more bytes.
    fn http_ok(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

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

    /// ADR-51 parity: local rows, the economy description, the local start
    /// hint and the OAuth import flag, all optional and absent by default.
    #[test]
    fn provider_catalogue_decodes_the_adr_51_fields() {
        let body = r#"{
            "ok": true,
            "providers": [
                { "id": "key-row", "description": "Key provider", "authKind": "key", "economy": "cheap by default" },
                {
                    "id": "local-row",
                    "description": "Local runtime",
                    "authKind": "local",
                    "startHint": "ollama serve"
                },
                {
                    "id": "oauth-row",
                    "description": "OAuth provider",
                    "authKind": "oauth",
                    "importAvailable": true
                },
                { "id": "plain-oauth", "description": "No import", "authKind": "oauth" }
            ]
        }"#;
        let rows = parse_providers(200, body).expect("provider catalogue");
        assert_eq!(rows[0].economy.as_deref(), Some("cheap by default"));
        assert_eq!(rows[0].start_hint, None);
        assert!(!rows[0].import_available);

        assert_eq!(rows[1].auth_kind, AuthKind::Local);
        assert_eq!(rows[1].start_hint.as_deref(), Some("ollama serve"));

        assert!(rows[2].import_available);
        assert!(!rows[3].import_available, "absent means not importable");
    }

    #[test]
    fn wire_parses_the_outcome_and_keeps_the_paste_by_hand_hint_on_failure() {
        let ok = super::parse_wire(
            200,
            r#"{"ok":true,"file":"C:/proj/.claude/agents/scout.md","previous":"sonnet","value":"claude-lupin-agent:scout"}"#,
        )
        .expect("outcome");
        assert_eq!(ok.previous.as_deref(), Some("sonnet"));
        assert_eq!(ok.value, "claude-lupin-agent:scout");
        let err = super::parse_wire(
            404,
            r#"{"ok":false,"error":"no agent definition found for \"ghost\"","hint":"model: claude-lupin-agent:ghost"}"#,
        )
        .expect_err("a miss is an error");
        assert!(err.contains("no agent definition found"), "{err}");
        assert!(err.contains("model: claude-lupin-agent:ghost"), "{err}");
    }

    #[test]
    fn discover_catalog_names_the_provider_and_the_profile() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true,"models":[]}"#));
        let result = super::discover_catalog(&identity, "deepseek", Some("ds"));
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(Vec::new()));
        assert!(request.contains("\"providerId\":\"deepseek\""), "{request}");
        assert!(request.contains("\"profile\":\"ds\""), "{request}");
    }

    #[test]
    fn discover_catalog_parses_models_and_failures() {
        let ok = parse_discover_catalog(
            200,
            r#"{"ok":true,"models":[{"id":"vendor/alpha","name":"Alpha","contextWindow":100000,"supportsTools":true,"promptPrice":0.000001,"completionPrice":0.000002}]}"#,
        )
        .expect("models");
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].id, "vendor/alpha");
        assert_eq!(ok[0].context_window, Some(100_000));
        assert_eq!(ok[0].supports_tools, Some(true));
        let err = parse_discover_catalog(502, r#"{"ok":false,"error":"catalogue unreachable"}"#);
        assert_eq!(err, Err("catalogue unreachable".to_string()));
        assert!(parse_discover_catalog(200, "not json").is_err());
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
            Err(super::SetupKeyError {
                message: "invalid key".to_string(),
                can_save_anyway: false,
            })
        );
    }

    /// A failed connectivity test carries the save-anyway escape hatch; every
    /// other rejection (unknown provider, bad body) does not.
    #[test]
    fn a_failed_connectivity_test_offers_save_anyway_other_rejections_do_not() {
        let offered = parse_setup_key(
            400,
            r#"{"ok":false,"error":"the provider does not answer","canSaveAnyway":true}"#,
        )
        .expect_err("rejected");
        assert!(offered.can_save_anyway);
        assert_eq!(offered.message, "the provider does not answer");

        let not_offered = parse_setup_key(404, r#"{"ok":false,"error":"unknown provider"}"#)
            .expect_err("rejected");
        assert!(!not_offered.can_save_anyway);
    }

    #[test]
    fn setup_key_waits_past_the_shared_control_timeout_for_the_authoritative_response() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("loopback listener");
        let port = listener.local_addr().expect("listener address").port();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("setup-key connection");
            let mut request = [0_u8; 2048];
            let _ = stream.read(&mut request);
            thread::sleep(Duration::from_millis(1_650));
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            );
        });
        let identity = BootstrapIdentity {
            port,
            local_token: "local-token".to_string(),
        };

        let result = setup_key(
            &identity,
            "provider",
            "delayed-key",
            &SetupKeyOptions::default(),
        );
        server.join().expect("delayed server");

        assert_eq!(result, Ok(()));
    }

    /// The wire shape matters: these fields are camelCase on the daemon side,
    /// and a mismatched key would silently fail to reach it.
    #[test]
    fn setup_key_sends_economy_and_save_anyway_only_when_set() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let opts = SetupKeyOptions {
            economy: true,
            save_anyway: true,
        };
        let result = setup_key(&identity, "openai", "sk-secret", &opts);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(request.contains(r#""economy":true"#), "{request}");
        assert!(request.contains(r#""saveAnyway":true"#), "{request}");
    }

    // The failover travels on its own route since the offer moved AFTER the
    // verdict: the setup body no longer carries it from the TUI.
    #[test]
    fn set_failover_names_the_profile_and_the_target() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let result = set_failover(&identity, "gpt", "kimi-sub");
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(request.contains("/v1/lupin/failover"), "{request}");
        assert!(request.contains(r#""profile":"gpt""#), "{request}");
        assert!(request.contains(r#""failover":"kimi-sub""#), "{request}");
    }

    #[test]
    fn setup_key_omits_the_optional_fields_by_default() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let result = setup_key(&identity, "openai", "sk-secret", &SetupKeyOptions::default());
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(!request.contains("economy"), "{request}");
        assert!(!request.contains("saveAnyway"), "{request}");
    }

    #[test]
    fn discover_local_sends_the_provider_id() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true,"models":[]}"#));
        let result = discover_local(&identity, "ollama");
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(Vec::new()));
        assert!(request.contains(r#""providerId":"ollama""#), "{request}");
    }

    #[test]
    fn discover_local_reports_models_with_the_three_warnings_data() {
        let body = r#"{
            "ok": true,
            "models": [
                {
                    "id": "loaded-model",
                    "contextWindow": 65536,
                    "contextWindowSource": "loaded",
                    "supportsTools": true,
                    "supportsVision": false,
                    "contextTooSmall": false
                },
                {
                    "id": "max-only-model",
                    "contextWindow": 8192,
                    "contextWindowSource": "max",
                    "supportsTools": false,
                    "contextTooSmall": true
                }
            ]
        }"#;
        let models = parse_discover_local(200, body).expect("model list");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].context_window_source.as_deref(), Some("loaded"));
        assert!(!models[0].context_too_small);
        assert_eq!(models[1].context_window_source.as_deref(), Some("max"));
        assert_eq!(models[1].supports_tools, Some(false));
        assert!(models[1].context_too_small);
    }

    /// An empty list is a legal success: the server is up, nothing is
    /// installed. Different from the 502 unreachable case below.
    #[test]
    fn discover_local_empty_list_is_success_not_an_error() {
        assert_eq!(
            parse_discover_local(200, r#"{"ok":true,"models":[]}"#),
            Ok(Vec::new())
        );
    }

    #[test]
    fn discover_local_unreachable_carries_the_start_hint() {
        let err = parse_discover_local(
            502,
            r#"{"ok":false,"error":"local server unreachable at http://127.0.0.1:11434/v1/models","startHint":"ollama serve"}"#,
        )
        .expect_err("unreachable");
        assert_eq!(err.start_hint.as_deref(), Some("ollama serve"));
        assert!(err.message.contains("unreachable"), "{}", err.message);

        // A route with no configured start hint carries none: never invented.
        let no_hint =
            parse_discover_local(502, r#"{"ok":false,"error":"unreachable"}"#).expect_err("x");
        assert_eq!(no_hint.start_hint, None);
    }

    #[test]
    fn setup_local_success_and_rejection_with_and_without_a_start_hint() {
        assert_eq!(parse_setup_local(200, r#"{"ok":true}"#), Ok(()));
        let bad_pick = parse_setup_local(
            404,
            r#"{"ok":false,"error":"model \"x\" is not on the local server"}"#,
        )
        .expect_err("rejected");
        assert_eq!(bad_pick.start_hint, None);
        let revalidation_failed = parse_setup_local(
            502,
            r#"{"ok":false,"error":"local server unreachable","startHint":"lms server start"}"#,
        )
        .expect_err("rejected");
        assert_eq!(
            revalidation_failed.start_hint.as_deref(),
            Some("lms server start")
        );
    }

    #[test]
    fn setup_local_sends_the_picks_and_the_optional_routes() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let req = SetupLocalRequest {
            provider_id: "ollama",
            main: "big-model",
            light: "small-model",
            vision: Some("vision-model"),
            long_context: true,
        };
        let result = setup_local(&identity, &req);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(request.contains(r#""providerId":"ollama""#), "{request}");
        assert!(request.contains(r#""main":"big-model""#), "{request}");
        assert!(request.contains(r#""light":"small-model""#), "{request}");
        assert!(request.contains(r#""vision":"vision-model""#), "{request}");
        assert!(request.contains(r#""longContext":true"#), "{request}");
    }

    #[test]
    fn setup_local_omits_vision_and_long_context_when_unset() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let req = SetupLocalRequest {
            provider_id: "ollama",
            main: "big-model",
            light: "big-model",
            vision: None,
            long_context: false,
        };
        let result = setup_local(&identity, &req);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(!request.contains("vision"), "{request}");
        assert!(!request.contains("longContext"), "{request}");
        assert!(!request.contains("failover"), "{request}");
    }

    #[test]
    fn start_login_sends_the_account_label_and_import_flag_only_when_given() {
        let (identity, handle) =
            capture_request(&http_ok(r#"{"ok":true,"job":"job-9"}"#));
        let result = start_login(&identity, "openai", false, Some("work"), true);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok("job-9".to_string()));
        assert!(request.contains(r#""account":"work""#), "{request}");
        assert!(request.contains(r#""importIfAvailable":true"#), "{request}");
    }

    #[test]
    fn start_login_omits_account_and_import_by_default() {
        let (identity, handle) =
            capture_request(&http_ok(r#"{"ok":true,"job":"job-9"}"#));
        let result = start_login(&identity, "openai", false, None, false);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok("job-9".to_string()));
        assert!(!request.contains("account"), "{request}");
        assert!(!request.contains("importIfAvailable"), "{request}");
    }

    #[test]
    fn logout_sends_the_provider_and_the_account_label_when_given() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let result = logout(&identity, "openai", Some("work"));
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(request.contains(r#""provider":"openai""#), "{request}");
        assert!(request.contains(r#""account":"work""#), "{request}");
    }

    #[test]
    fn logout_without_an_account_label_omits_the_field() {
        let (identity, handle) = capture_request(&http_ok(r#"{"ok":true}"#));
        let result = logout(&identity, "openai", None);
        let request = handle.join().expect("server thread");
        assert_eq!(result, Ok(()));
        assert!(!request.contains("account"), "{request}");
    }

    #[test]
    fn logout_surfaces_the_daemon_error_text() {
        assert_eq!(
            super::parse_logout(404, r#"{"ok":false,"error":"unknown OAuth provider \"x\""}"#),
            Err("unknown OAuth provider \"x\"".to_string())
        );
    }

    #[test]
    fn slots_body_names_only_the_aimed_slots() {
        let body = slots_body(
            "kimi",
            &[("opus", "big".to_string()), ("haiku", "small".to_string())],
            &[],
        );
        assert_eq!(body["profile"], "kimi");
        assert_eq!(body["opus"], "big");
        assert_eq!(body["haiku"], "small");
        assert!(body.get("sonnet").is_none());
        assert!(body.get("contextWindows").is_none());
    }

    #[test]
    fn slots_body_carries_a_known_window_with_the_same_write() {
        let body = slots_body(
            "or",
            &[("opus", "vendor/alpha".to_string())],
            &[("vendor/alpha".to_string(), 262_144)],
        );
        assert_eq!(body["contextWindows"]["vendor/alpha"], 262_144);
    }
}
