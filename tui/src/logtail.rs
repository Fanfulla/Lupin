// The recent-requests tail, read from the local log file (the same source
// top.ts uses). Bounded on purpose: a session's log grows without bound, so
// only the last chunk is read and a partial first line is dropped.

use serde::Deserialize;

const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
pub struct LogLine {
    #[serde(default)]
    pub ts: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub status: u16,
    #[serde(default)]
    #[serde(rename = "latencyMs")]
    pub latency_ms: u64,
    #[serde(default)]
    pub profile: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub routed: Option<String>,
    #[serde(default)]
    #[serde(rename = "failedOver")]
    pub failed_over: Option<String>,
    #[serde(default)]
    pub cooldown: Option<String>,
    // The three markers top.ts has always printed and this side did not read, so
    // the sidecar showed less than SPEC-CLI section 2 promised of it.
    #[serde(default)]
    #[serde(rename = "retryAfterMs")]
    pub retry_after_ms: Option<u64>,
    #[serde(default)]
    pub dialect: Option<Vec<String>>,
    #[serde(default)]
    #[serde(rename = "editHint")]
    pub edit_hint: Option<bool>,
    #[serde(default)]
    #[serde(rename = "streamError")]
    pub stream_error: Option<String>,
}

pub fn recent(path: &std::path::Path, rows: usize) -> Vec<LogLine> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Vec::new();
    };
    let size = meta.len();
    let start = size.saturating_sub(TAIL_BYTES);
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    use std::io::{Read, Seek, SeekFrom};
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = String::new();
    if file.read_to_string(&mut buf).is_err() {
        return Vec::new();
    }
    // A partial first line is garbage: drop it rather than parse half a record.
    let text = if start > 0 {
        match buf.find('\n') {
            Some(i) => &buf[i + 1..],
            None => "",
        }
    } else {
        &buf
    };
    let mut lines: Vec<LogLine> = text
        .lines()
        .filter_map(|l| serde_json::from_str::<LogLine>(l).ok())
        .filter(|l| l.path == "/v1/messages")
        .collect();
    let n = lines.len();
    lines.split_off(n.saturating_sub(rows))
}

impl LogLine {
    pub fn markers(&self) -> String {
        let mut parts = Vec::new();
        if let Some(r) = &self.routed {
            parts.push(format!("routed:{r}"));
        }
        if let Some(f) = &self.failed_over {
            parts.push(format!("failover<-{f}"));
        }
        if let Some(c) = &self.cooldown {
            parts.push(format!("cooldown:{c}"));
        }
        // The strings are top.ts's, character for character: one log line must
        // read the same whichever front end is watching it.
        if let Some(w) = self.retry_after_ms {
            parts.push(format!("waited:{w}ms"));
        }
        if let Some(d) = &self.dialect {
            if !d.is_empty() {
                parts.push(format!("dialect:{}", d.join("+")));
            }
        }
        if self.edit_hint == Some(true) {
            parts.push("editHint".to_string());
        }
        if let Some(s) = &self.stream_error {
            parts.push(format!("streamError:{s}"));
        }
        parts.join(" ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// A unique scratch file: no dev-dependency is worth adding for this
    /// (ARCHITECTURE.md keeps the dependency list short on both sides).
    fn scratch(name: &str, body: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("lupin-tui-{name}.log"));
        let mut f = std::fs::File::create(&p).expect("create");
        f.write_all(body.as_bytes()).expect("write");
        p
    }

    fn line(model: &str, path: &str) -> String {
        format!(
            r#"{{"ts":"t","profile":"p","model":"{model}","path":"{path}","status":200,"latencyMs":5}}"#
        )
    }

    #[test]
    fn only_model_traffic_survives_and_only_the_last_rows() {
        let body = format!(
            "{}\n{}\n{}\n{}\n",
            line("a", "/v1/messages"),
            line("b", "/v1/messages/count_tokens"), // not model traffic
            line("c", "/v1/messages"),
            line("d", "/v1/messages"),
        );
        let p = scratch("tail", &body);
        let rows = recent(&p, 2);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].model, "c");
        assert_eq!(rows[1].model, "d");
    }

    #[test]
    fn a_missing_log_is_empty_rather_than_a_panic() {
        let p = std::env::temp_dir().join("lupin-tui-does-not-exist.log");
        let _ = std::fs::remove_file(&p);
        assert!(recent(&p, 5).is_empty());
    }

    #[test]
    fn a_half_written_line_is_dropped_not_parsed() {
        let p = scratch(
            "garbage",
            &format!("{{not json\n{}\n", line("ok", "/v1/messages")),
        );
        let rows = recent(&p, 5);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "ok");
    }

    #[test]
    fn the_markers_name_every_routing_event_that_fired() {
        let raw = r#"{"ts":"t","profile":"p","model":"m","path":"/v1/messages","status":200,
            "latencyMs":1,"routed":"vision","failedOver":"other","cooldown":"3s","retryAfterMs":1500,
            "dialect":["stripThinkTags","looseJsonArguments"],"editHint":true,"streamError":"boom"}"#;
        let l: LogLine = serde_json::from_str(raw).expect("parses");
        let m = l.markers();
        assert!(m.contains("routed:vision"));
        assert!(m.contains("failover<-other"));
        assert!(m.contains("cooldown:3s"));
        assert!(m.contains("streamError:boom"));
        // The three the sidecar used to drop, in top.ts's wording exactly.
        assert!(m.contains("waited:1500ms"));
        assert!(m.contains("dialect:stripThinkTags+looseJsonArguments"));
        assert!(m.contains("editHint"));
    }

    /// An empty dialect array means "no repair fired" and must print nothing:
    /// a bare `dialect:` would read as a normalization with a missing name.
    #[test]
    fn an_empty_dialect_list_prints_no_marker() {
        let raw = r#"{"ts":"t","profile":"p","model":"m","path":"/v1/messages","status":200,
            "latencyMs":1,"dialect":[],"editHint":false}"#;
        let l: LogLine = serde_json::from_str(raw).expect("parses");
        assert_eq!(l.markers(), "");
    }

    #[test]
    fn a_quiet_request_has_no_markers_at_all() {
        let l: LogLine = serde_json::from_str(&line("m", "/v1/messages")).expect("parses");
        assert_eq!(l.markers(), "");
    }
}
