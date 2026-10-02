use regex::Regex;
use std::sync::OnceLock;

static DESTRUCTIVE_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_destructive_regex() -> &'static Regex {
    DESTRUCTIVE_REGEX.get_or_init(|| {
        Regex::new(r"(?i)(rm\s+-[a-z]*r[a-z]*f|sed\s+-[a-z]*i|truncate\s+|git\s+reset\s+--hard|git\s+clean\s+-[a-z]*f|>\s*\.env)").unwrap()
    })
}

/// Detects destructive terminal commands in real-time stream buffers before they execute
pub fn contains_destructive_pattern(text: &str) -> bool {
    get_destructive_regex().is_match(text)
}
