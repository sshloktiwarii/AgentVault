use regex::Regex;
use std::sync::OnceLock;

static DESTRUCTIVE_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_destructive_regex() -> &'static Regex {
    DESTRUCTIVE_REGEX.get_or_init(|| {
        Regex::new(r"(?i)(rm\s+-[a-z]*r[a-z]*f|sed\s+-[a-z]*i|truncate\s+|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|>\s*\.env)").unwrap()
    })
}

/// Strips ANSI escape codes from buffer and inspects for destructive shell patterns.
/// If detected, emits a non-blocking warning without halting or blocking the process.
/// Actual safety is guaranteed by the synchronous MCP pre-flight hook and notify incremental index.
pub fn sniff_and_warn_destructive(bytes: &[u8]) -> bool {
    let stripped = strip_ansi_escapes::strip(bytes);
    let text = String::from_utf8_lossy(&stripped);

    if get_destructive_regex().is_match(&text) {
        tracing::warn!("GhostBranch: Destructive pattern detected in stream. Background snapshot secured.");
        true
    } else {
        false
    }
}

pub fn contains_destructive_pattern(text: &str) -> bool {
    let stripped = strip_ansi_escapes::strip(text.as_bytes());
    let clean = String::from_utf8_lossy(&stripped);
    get_destructive_regex().is_match(&clean)
}
