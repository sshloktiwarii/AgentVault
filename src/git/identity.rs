use anyhow::Result;
use git2::Repository;
use std::path::Path;

/// Derives an immutable repository identity hash based on the root commit OID via libgit2.
/// If shallow clone, zero commits, or non-git directory, emits tracing warnings and falls back
/// to hashing the canonicalized path using Blake3.
pub fn derive_repo_identity(repo_path: &Path) -> Result<String> {
    let canonical_path = dunce::canonicalize(repo_path)
        .unwrap_or_else(|_| repo_path.to_path_buf());

    match Repository::discover(&canonical_path) {
        Ok(repo) => {
            if repo.is_shallow() {
                tracing::warn!("⚠️️ Shallow clone detected. Repo identity may change if unshallowed.");
            }
            let mut revwalk = repo.revwalk()?;
            if revwalk.push_head().is_ok() {
                let mut root_oid = None;
                for oid in revwalk {
                    if let Ok(oid) = oid {
                        root_oid = Some(oid);
                    }
                }
                if let Some(oid) = root_oid {
                    return Ok(blake3::hash(oid.as_bytes()).to_hex().to_string());
                }
            }
            tracing::warn!("⚠️ Git repo has zero commits. Using fragile path-based identity.");
        }
        Err(_) => {
            tracing::warn!("⚠️ Directory is not a Git repo. Using fragile path-based identity. Rename/move will lose history.");
        }
    }

    // Fallback: Hash canonical path string
    let path_str = canonical_path.to_string_lossy();
    Ok(blake3::hash(path_str.as_bytes()).to_hex().to_string())
}
