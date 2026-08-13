// Config reading: the same ~/.lupin/config.json the daemon watches. The TUI
// reads it directly (it is local); it never writes it. LUPIN_DIR moves the
// whole home, exactly like the Node side (the split-brain lesson of 2026-07-24).

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
pub struct ProfileConfig {
    // `baseUrl` is in the JSON but the screen never shows it, so it is not
    // modelled here: serde ignores the extra fields. `provider` IS modelled
    // since the catalogue gestures (design 2026-08-13) key on it.
    #[serde(default)]
    pub provider: String,
    pub mode: String,
    #[serde(default)]
    pub slots: BTreeMap<String, serde_json::Value>,
    /// The automatic-switch link (ADR-34): who this profile fails over to.
    #[serde(default)]
    pub failover: Option<String>,
    #[serde(default)]
    #[serde(rename = "lastDoctor")]
    pub last_doctor: Option<LastDoctor>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LastDoctor {
    pub score: u32,
    pub max: u32,
    pub date: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LupinConfig {
    #[serde(rename = "activeProfile")]
    pub active_profile: String,
    pub port: u16,
    #[serde(rename = "localToken")]
    pub local_token: String,
    #[serde(default)]
    pub profiles: BTreeMap<String, ProfileConfig>,
    /// Agent routes (SPEC-PROVIDERS section 4decies, ADR-47): name -> target,
    /// where a target has the same shape as a slot (model name or delegation).
    #[serde(default)]
    pub agents: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootstrapIdentity {
    pub port: u16,
    pub local_token: String,
}

pub fn default_config_path() -> Option<PathBuf> {
    config_path_from(
        std::env::var("LUPIN_DIR").ok(),
        std::env::var("LUPIN_CONFIG").ok(),
        dirs_home(),
    )
}

pub fn bootstrap_identity_from_env() -> Option<BootstrapIdentity> {
    bootstrap_identity_from(
        std::env::var("LUPIN_BOOTSTRAP_PORT").ok(),
        std::env::var("LUPIN_BOOTSTRAP_TOKEN").ok(),
    )
}

fn bootstrap_identity_from(
    port: Option<String>,
    local_token: Option<String>,
) -> Option<BootstrapIdentity> {
    let port = port?.parse::<u16>().ok()?;
    let local_token = local_token?;
    if port == 0 || local_token.is_empty() {
        return None;
    }
    Some(BootstrapIdentity { port, local_token })
}

/// The same precedence the Node side uses (`src/config/config.ts`):
/// LUPIN_CONFIG is a FILE-level override and wins over LUPIN_DIR, which moves
/// the whole home. This used to be the other way round here, so with both set
/// the TUI and the daemon read two different files: the split-brain of
/// 2026-07-24 all over again, on the other side of the wire. Taking the env as
/// arguments keeps it testable without racing other tests over the process env.
fn config_path_from(
    dir: Option<String>,
    cfg: Option<String>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(p) = cfg {
        return Some(PathBuf::from(p));
    }
    if let Some(d) = dir {
        return Some(PathBuf::from(d).join("config.json"));
    }
    home.map(|h| h.join(".lupin").join("config.json"))
}

pub fn lupin_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("LUPIN_DIR") {
        return Some(PathBuf::from(dir));
    }
    dirs_home().map(|h| h.join(".lupin"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

pub fn load(path: &std::path::Path) -> Result<LupinConfig, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read config: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse config: {e}"))
}

/// A slot is either a model name or a delegation to another profile.
pub fn slot_label(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(o) => o
            .get("profile")
            .and_then(|p| p.as_str())
            .map(|p| format!("->{p}"))
            .unwrap_or_else(|| "?".to_string()),
        _ => "?".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lupin_config_wins_over_lupin_dir_exactly_as_node_does() {
        // With both set, the TUI must open the SAME file the daemon opens.
        let p = config_path_from(
            Some("/somewhere/home".to_string()),
            Some("/elsewhere/other.json".to_string()),
            None,
        );
        assert_eq!(p, Some(PathBuf::from("/elsewhere/other.json")));
    }

    #[test]
    fn lupin_dir_moves_the_whole_home() {
        let p = config_path_from(Some("/somewhere/home".to_string()), None, None);
        assert_eq!(
            p,
            Some(PathBuf::from("/somewhere/home").join("config.json"))
        );
    }

    #[test]
    fn with_no_env_it_falls_back_under_the_home() {
        let p = config_path_from(None, None, Some(PathBuf::from("/u/me")));
        assert_eq!(
            p,
            Some(PathBuf::from("/u/me").join(".lupin").join("config.json"))
        );
    }

    #[test]
    fn no_env_and_no_home_is_no_path_rather_than_a_wrong_one() {
        assert_eq!(config_path_from(None, None, None), None);
    }

    #[test]
    fn a_config_parses_with_the_fields_the_screen_shows() {
        let raw = r#"{
            "activeProfile": "kimi-sub",
            "port": 3456,
            "localToken": "tok",
            "profiles": {
                "kimi-sub": {
                    "provider": "kimi",
                    "mode": "passthrough",
                    "slots": { "opus": "k2.5", "sonnet": { "profile": "other" } },
                    "lastDoctor": { "score": 9, "max": 10, "date": "2026-07-29" }
                }
            }
        }"#;
        let c: LupinConfig = serde_json::from_str(raw).expect("parses");
        assert_eq!(c.active_profile, "kimi-sub");
        assert_eq!(c.port, 3456);
        let p = c.profiles.get("kimi-sub").expect("profile");
        assert_eq!(p.mode, "passthrough");
        assert_eq!(p.last_doctor.as_ref().map(|d| d.score), Some(9));
        // Unknown fields (provider, baseUrl) are ignored on purpose.
        assert_eq!(slot_label(p.slots.get("opus").unwrap()), "k2.5");
        assert_eq!(slot_label(p.slots.get("sonnet").unwrap()), "->other");
    }

    #[test]
    fn an_empty_bootstrap_config_parses() {
        let c: LupinConfig = serde_json::from_str(
            r#"{"activeProfile":"","port":3456,"localToken":"tok","profiles":{}}"#,
        )
        .expect("empty bootstrap config parses");
        assert_eq!(c.active_profile, "");
        assert!(c.profiles.is_empty());
    }

    #[test]
    fn bootstrap_identity_requires_both_valid_values() {
        assert_eq!(
            bootstrap_identity_from(Some("3456".to_string()), Some("tok".to_string())),
            Some(BootstrapIdentity {
                port: 3456,
                local_token: "tok".to_string(),
            })
        );
        assert_eq!(
            bootstrap_identity_from(Some("3456".to_string()), None),
            None
        );
        assert_eq!(bootstrap_identity_from(None, Some("tok".to_string())), None);
        assert_eq!(
            bootstrap_identity_from(Some("0".to_string()), Some("tok".to_string())),
            None
        );
        assert_eq!(
            bootstrap_identity_from(Some("nope".to_string()), Some("tok".to_string())),
            None
        );
        assert_eq!(
            bootstrap_identity_from(Some("3456".to_string()), Some(String::new())),
            None
        );
    }

    #[test]
    fn a_slot_that_is_neither_a_name_nor_a_delegation_shows_as_unknown() {
        assert_eq!(slot_label(&serde_json::json!(42)), "?");
        assert_eq!(slot_label(&serde_json::json!({})), "?");
    }
}
