use once_cell::sync::Lazy;
use regex::Regex;
use strip_ansi_escapes::strip;

static DANGEROUS_PATTERNS: Lazy<Vec<Regex>> = Lazy::new(|| {
    vec![
        Regex::new(r"rm\s+-r[fF]?\s+").unwrap(),
        Regex::new(r"git\s+clean\s+-f[dx]?").unwrap(),
        Regex::new(r"git\s+reset\s+--hard").unwrap(),
        Regex::new(r">\s*\.env").unwrap(),
    ]
});

/// Sniffs a raw PTY stream buffer and emits a non-blocking UX warning if a destructive pattern is matched.
///
/// STRICT ARCHITECTURAL RULE:
/// Relying on regex in a PTY stream to block `rm -rf` is fundamentally broken due to ANSI escapes,
/// aliases, and multi-chunk buffering. Therefore, this function is STRICTLY A NON-BLOCKING UX WARNING.
/// Absolute safety relies on synchronous pre-tool hooks and the notify incremental snapshotter.
pub fn sniff_ux_warning(raw_buffer: &[u8]) {
    let stripped = strip(raw_buffer);
    let text = String::from_utf8_lossy(&stripped);

    for pattern in DANGEROUS_PATTERNS.iter() {
        if pattern.is_match(&text) {
            // STRICT RULE: DO NOT BLOCK THREAD. THIS IS UX ONLY.
            tracing::warn!(
                "AgentVault: Destructive pattern matched in stdout ({}). Background snapshot active.",
                pattern.as_str()
            );
            break;
        }
    }
}

/// Helper wrapper that performs non-blocking UX sniffing and returns whether a pattern matched.
pub fn sniff_and_warn_destructive(raw_buffer: &[u8]) -> bool {
    let stripped = strip(raw_buffer);
    let text = String::from_utf8_lossy(&stripped);

    for pattern in DANGEROUS_PATTERNS.iter() {
        if pattern.is_match(&text) {
            tracing::warn!(
                "AgentVault: Destructive pattern matched in stdout ({}). Background snapshot active.",
                pattern.as_str()
            );
            return true;
        }
    }
    false
}

pub fn contains_destructive_pattern(text: &str) -> bool {
    let stripped = strip(text.as_bytes());
    let clean = String::from_utf8_lossy(&stripped);
    DANGEROUS_PATTERNS.iter().any(|p| p.is_match(&clean))
}
