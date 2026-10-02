use anyhow::Result;
use git2::{Repository, Sort};
use std::path::Path;

/// Derives an immutable repository identity hash based on the root commit OID.
/// If the repository is brand new (no commits) or git discovery fails,
/// it gracefully falls back to hashing the canonicalized repository path.
pub fn derive_repo_identity(repo_path: &Path) -> Result<String> {
    if let Ok(repo) = Repository::discover(repo_path) {
        if let Ok(mut revwalk) = repo.revwalk() {
            // Push HEAD or all references to find root commit
            let _ = revwalk.push_head();
            let _ = revwalk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE);

            for oid_res in revwalk {
                if let Ok(oid) = oid_res {
                    if let Ok(commit) = repo.find_commit(oid) {
                        if commit.parent_count() == 0 {
                            let root_oid_str = commit.id().to_string();
                            let hash = blake3::hash(root_oid_str.as_bytes()).to_hex().to_string();
                            return Ok(hash);
                        }
                    }
                }
            }
        }
    }

    // Fallback: Hash canonicalized path for uncommitted repo or discovery failure
    let canonical = dunce::canonicalize(repo_path).unwrap_or_else(|_| repo_path.to_path_buf());
    let path_str = canonical.to_string_lossy();
    let hash = blake3::hash(path_str.as_bytes()).to_hex().to_string();
    Ok(hash)
}
