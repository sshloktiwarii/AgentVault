use anyhow::{bail, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
#[error("Safety Lock Triggered: The following files have uncommitted user modifications:\n{}", .conflicting_files.iter().map(|f| format!("  - {}", f.display())).collect::<Vec<_>>().join("\n"))]
pub struct SafetyLockError {
    pub conflicting_files: Vec<PathBuf>,
}

/// Evaluates if files scheduled for rollback have been modified by a human user outside of Rewind checkpoints
pub fn verify_safety_conflicts<P: AsRef<Path>>(
    repo_root: P,
    files_to_mutate: &[PathBuf],
    latest_checkpoint_hashes: &BTreeMap<PathBuf, String>,
    force: bool,
) -> Result<()> {
    if force {
        return Ok(());
    }

    let root = repo_root.as_ref();
    let mut conflicts = Vec::new();

    for rel_path in files_to_mutate {
        let abs_path = root.join(rel_path);
        if abs_path.is_file() {
            if let Ok(bytes) = fs::read(&abs_path) {
                let current_hash = blake3::hash(&bytes).to_hex().to_string();
                if let Some(recorded_hash) = latest_checkpoint_hashes.get(rel_path) {
                    if &current_hash != recorded_hash {
                        conflicts.push(rel_path.clone());
                    }
                } else {
                    // File was untracked in checkpoint but exists on disk
                    conflicts.push(rel_path.clone());
                }
            }
        }
    }

    if !conflicts.is_empty() {
        bail!(SafetyLockError {
            conflicting_files: conflicts,
        });
    }

    Ok(())
}
