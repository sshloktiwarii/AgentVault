use anyhow::{Context, Result};
use directories::ProjectDirs;
use std::path::{Path, PathBuf};

use crate::git::derive_repo_identity;

/// Resolves the persistent root data directory for AgentVault.
/// Uses ProjectDirs::from("com", "AgentVault", "AgentVault") and data_local_dir()
/// to guarantee immunity from OS temporary cache sweepers and systemd-tmpfiles.
pub fn get_app_data_dir() -> Result<PathBuf> {
    let proj_dirs = ProjectDirs::from("com", "AgentVault", "AgentVault")
        .context("Failed to resolve ProjectDirs for com.AgentVault.AgentVault")?;
    let data_dir = proj_dirs.data_local_dir().to_path_buf();
    std::fs::create_dir_all(&data_dir)
        .with_context(|| format!("Failed to create data directory at {:?}", data_dir))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700));
    }

    Ok(data_dir)
}

/// Resolves the dedicated, out-of-band persistent storage path for a repository:
/// `<data_local_dir>/stores/<repo_identity_hash>/`
/// where `repo_identity_hash` is derived from the immutable root commit OID.
pub fn resolve_storage_dir(repo_path: &Path) -> Result<PathBuf> {
    let repo_identity_hash = derive_repo_identity(repo_path)
        .context("Failed to derive immutable repository identity")?;
    let data_dir = get_app_data_dir()?;
    let store_dir = data_dir.join("stores").join(&repo_identity_hash);
    std::fs::create_dir_all(&store_dir)
        .with_context(|| format!("Failed to create store directory at {:?}", store_dir))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&store_dir, std::fs::Permissions::from_mode(0o700));
    }

    Ok(store_dir)
}
