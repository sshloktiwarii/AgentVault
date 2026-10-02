use anyhow::{Context, Result};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::config::resolve_storage_dir;

/// Default maximum file size for individual CAS blobs (50 MB)
pub const MAX_CAS_FILE_SIZE_BYTES: u64 = 50 * 1024 * 1024;

/// Default maximum CAS total directory size (5 GB)
pub const DEFAULT_MAX_CAS_TOTAL_BYTES: u64 = 5 * 1024 * 1024 * 1024;

/// High-performance Content-Addressable Storage (CAS) for untracked secrets and configs.
/// Stored strictly out-of-band in persistent XDG/OS application data directory
/// (`com.AgentVault.AgentVault/stores/<root_commit_hash>`) to guarantee immunity from OS cache sweepers.
#[derive(Debug, Clone)]
pub struct CasStore {
    pub repo_root: PathBuf,
    pub repo_hash: String,
    pub store_dir: PathBuf,
    pub objects_dir: PathBuf,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CasManifestEntry {
    pub relative_path: String,
    pub blob_hash: String,
    pub size_bytes: u64,
    pub permissions_mode: u32,
    pub is_compressed: bool,
    pub last_modified: i64,
}

impl CasStore {
    /// Initialize or resolve the persistent out-of-band CAS store for a given repository path.
    pub fn new<P: AsRef<Path>>(repo_path: P) -> Result<Self> {
        let canonical_repo = dunce::canonicalize(repo_path.as_ref())
            .context("Failed to canonicalize repository path for CasStore")?;

        let store_dir = resolve_storage_dir(&canonical_repo)
            .context("Failed to resolve persistent storage directory")?;

        let repo_hash = store_dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        let objects_dir = store_dir.join("cas_objects");

        fs::create_dir_all(&objects_dir)
            .with_context(|| format!("Failed to create CAS directory at {:?}", objects_dir))?;

        // Enforce user-only permissions (0700) on store directory for security
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&store_dir, fs::Permissions::from_mode(0o700));
            let _ = fs::set_permissions(&objects_dir, fs::Permissions::from_mode(0o700));
        }

        Ok(Self {
            repo_root: canonical_repo,
            repo_hash,
            store_dir,
            objects_dir,
        })
    }

    /// Evaluates if a relative file path matches the critical untracked secrets whitelist
    pub fn is_whitelisted<P: AsRef<Path>>(path: P) -> bool {
        let p = path.as_ref();
        let file_name = match p.file_name().and_then(|s| s.to_str()) {
            Some(name) => name,
            None => return false,
        };

        // Whitelist rules: .env*, *.sqlite*, *.db, schema.prisma, *.pem, *.key
        if file_name.starts_with(".env") {
            return true;
        }
        if file_name.ends_with(".sqlite") || file_name.ends_with(".sqlite-wal") || file_name.ends_with(".sqlite-shm") {
            return true;
        }
        if file_name.ends_with(".db") || file_name == "schema.prisma" || file_name.ends_with(".pem") || file_name.ends_with(".key") {
            return true;
        }

        false
    }

    /// Resolves the sharded path for a Blake3 hash: `cas_objects/<first-2-chars>/<rest-of-hash>`
    pub fn get_blob_path(&self, hash: &str) -> PathBuf {
        let (prefix, rest) = if hash.len() >= 2 {
            (&hash[0..2], &hash[2..])
        } else {
            ("00", hash)
        };
        self.objects_dir.join(prefix).join(rest)
    }

    /// Stores a file into the Content-Addressable Storage with transparent Blake3 hashing
    /// and mandatory Level 3 Zstandard (zstd) stream compression for files.
    pub fn store_file<P: AsRef<Path>>(&self, abs_path: P) -> Result<Option<CasManifestEntry>> {
        let path = abs_path.as_ref();
        if !path.exists() || !path.is_file() {
            return Ok(None);
        }

        let metadata = fs::symlink_metadata(path)
            .with_context(|| format!("Failed to fetch metadata for {:?}", path))?;
        if metadata.len() > MAX_CAS_FILE_SIZE_BYTES {
            // Bypass files exceeding 50MB ceiling to prevent disk bloat
            return Ok(None);
        }

        // Stream raw bytes through zstd::stream::Encoder at level 3 before hashing
        let mut file = File::open(path)
            .with_context(|| format!("Failed to open file for CAS storage at {:?}", path))?;
        let mut encoder = zstd::stream::Encoder::new(Vec::new(), 3)
            .context("Failed to initialize zstd stream encoder")?;
        std::io::copy(&mut file, &mut encoder)
            .context("Failed to stream file through zstd encoder")?;
        let compressed_bytes = encoder.finish()
            .context("Failed to finalize zstd stream compression")?;

        let hash = blake3::hash(&compressed_bytes).to_hex().to_string();
        let blob_path = self.get_blob_path(&hash);

        // Write blob if not already deduplicated
        if !blob_path.exists() {
            if let Some(parent) = blob_path.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut blob_file = File::create(&blob_path)?;
            blob_file.write_all(&compressed_bytes)?;

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = fs::set_permissions(&blob_path, fs::Permissions::from_mode(0o600));
            }
        }

        let rel_path = path.strip_prefix(&self.repo_root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();

        let permissions_mode = {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode()
            }
            #[cfg(not(unix))]
            {
                0o644
            }
        };

        let last_modified = metadata.modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        Ok(Some(CasManifestEntry {
            relative_path: rel_path,
            blob_hash: hash,
            size_bytes: metadata.len(),
            permissions_mode,
            is_compressed: true,
            last_modified,
        }))
    }

    /// Restores a file from CAS blob to its physical target path with zstd decompression
    pub fn restore_file(&self, entry: &CasManifestEntry) -> Result<()> {
        let blob_path = self.get_blob_path(&entry.blob_hash);
        if !blob_path.exists() {
            anyhow::bail!("CAS blob not found for hash: {}", entry.blob_hash);
        }

        let mut blob_file = File::open(&blob_path)
            .with_context(|| format!("Failed to open CAS blob at {:?}", blob_path))?;
        let mut blob_bytes = Vec::new();
        blob_file.read_to_end(&mut blob_bytes)?;

        let raw_bytes = if entry.is_compressed {
            zstd::decode_all(&blob_bytes[..])
                .context("Failed to decompress zstd CAS blob")?
        } else {
            blob_bytes
        };

        let target_path = self.repo_root.join(&entry.relative_path);
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut target_file = File::create(&target_path)
            .with_context(|| format!("Failed to create restore target at {:?}", target_path))?;
        target_file.write_all(&raw_bytes)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target_path, fs::Permissions::from_mode(entry.permissions_mode));
        }

        Ok(())
    }
}

/// Simple heuristic to identify if buffer contains UTF-8 text (for safe zstd compression)
#[allow(dead_code)]
fn is_text_content(bytes: &[u8]) -> bool {
    let check_len = bytes.len().min(1024);
    if check_len == 0 {
        return true;
    }
    // Check for null bytes
    if bytes[0..check_len].contains(&0) {
        return false;
    }
    std::str::from_utf8(&bytes[0..check_len]).is_ok()
}
