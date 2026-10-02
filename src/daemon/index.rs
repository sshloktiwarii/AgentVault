use anyhow::Result;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use crate::cas::CasStore;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMetadata {
    pub mtime: i64,
    pub size: u64,
    pub inode: u64,
    pub blake3_hash: String,
    pub is_deleted: bool,
}

#[derive(Debug, Clone, Default)]
pub struct IncrementalIndex {
    /// Live virtual working tree index
    pub entries: BTreeMap<PathBuf, FileMetadata>,
    /// Snapshot of hashes committed at the last checkpoint
    pub committed_hashes: BTreeMap<PathBuf, String>,
}

impl IncrementalIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fast initial scan using the ignore crate, respecting .gitignore but preserving .env whitelist
    pub fn initial_scan<P: AsRef<Path>>(&mut self, repo_root: P) -> Result<()> {
        let root = repo_root.as_ref();
        let walker = ignore::WalkBuilder::new(root)
            .hidden(false) // Allow checking .env* files
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                // Never descend into internal or heavy cache directories
                if name == ".git" || name == "node_modules" || name == "target" || name == ".cache" {
                    return false;
                }
                true
            })
            .build();

        for result in walker {
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };

            let path = entry.path();
            if path.is_file() {
                let rel_path = match path.strip_prefix(root) {
                    Ok(r) => r.to_path_buf(),
                    Err(_) => path.to_path_buf(),
                };

                if let Ok(meta) = Self::compute_file_metadata(path) {
                    self.entries.insert(rel_path.clone(), meta.clone());
                    self.committed_hashes.insert(rel_path, meta.blake3_hash);
                }
            }
        }

        // Also check if any whitelisted .env or secrets exist that were ignored by .gitignore
        self.scan_whitelisted_secrets(root)?;

        Ok(())
    }

    fn scan_whitelisted_secrets(&mut self, root: &Path) -> Result<()> {
        if let Ok(entries) = fs::read_dir(root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && CasStore::is_whitelisted(&path) {
                    let rel_path = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
                    if !self.entries.contains_key(&rel_path) {
                        if let Ok(meta) = Self::compute_file_metadata(&path) {
                            self.entries.insert(rel_path.clone(), meta.clone());
                            self.committed_hashes.insert(rel_path, meta.blake3_hash);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Computes mtime, size, inode, and blake3 hash for a single file
    pub fn compute_file_metadata<P: AsRef<Path>>(abs_path: P) -> Result<FileMetadata> {
        let path = abs_path.as_ref();
        let fs_meta = fs::symlink_metadata(path)?;

        let mtime = fs_meta.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        let size = fs_meta.len();

        let inode = {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                fs_meta.ino()
            }
            #[cfg(not(unix))]
            {
                0
            }
        };

        let raw_bytes = fs::read(path)?;
        let blake3_hash = blake3::hash(&raw_bytes).to_hex().to_string();

        Ok(FileMetadata {
            mtime,
            size,
            inode,
            blake3_hash,
            is_deleted: false,
        })
    }

    /// Incrementally updates a single path in the index
    pub fn update_file<P: AsRef<Path>>(&mut self, root: &Path, abs_path: P) -> Result<()> {
        let path = abs_path.as_ref();
        let rel_path = path.strip_prefix(root).unwrap_or(path).to_path_buf();

        if !path.exists() {
            if let Some(entry) = self.entries.get_mut(&rel_path) {
                entry.is_deleted = true;
            }
            return Ok(());
        }

        if path.is_file() {
            let meta = Self::compute_file_metadata(path)?;
            self.entries.insert(rel_path, meta);
        }
        Ok(())
    }

    /// Records deletion of a file in the index
    pub fn remove_file<P: AsRef<Path>>(&mut self, root: &Path, abs_path: P) {
        let path = abs_path.as_ref();
        let rel_path = path.strip_prefix(root).unwrap_or(path).to_path_buf();
        if let Some(entry) = self.entries.get_mut(&rel_path) {
            entry.is_deleted = true;
        }
    }

    /// Computes delta: returns list of (rel_path, Option<file_bytes>, is_deleted) modified since last checkpoint
    pub fn get_deltas(&self, root: &Path) -> Vec<(PathBuf, Option<Vec<u8>>, bool)> {
        let mut deltas = Vec::new();

        for (rel_path, meta) in &self.entries {
            let last_hash = self.committed_hashes.get(rel_path);

            if meta.is_deleted {
                if last_hash.is_some() {
                    deltas.push((rel_path.clone(), None, true));
                }
            } else {
                match last_hash {
                    Some(committed) if committed == &meta.blake3_hash => {
                        // Unmodified, skip hashing / writing
                    }
                    _ => {
                        // Modified or newly created: read file bytes
                        let abs_path = root.join(rel_path);
                        if let Ok(bytes) = fs::read(&abs_path) {
                            deltas.push((rel_path.clone(), Some(bytes), false));
                        }
                    }
                }
            }
        }

        deltas
    }

    /// Marks the current working tree state as committed to checkpoint
    pub fn mark_checkpoint_committed(&mut self) {
        self.committed_hashes.clear();
        self.entries.retain(|_, meta| !meta.is_deleted);
        for (rel_path, meta) in &self.entries {
            self.committed_hashes.insert(rel_path.clone(), meta.blake3_hash.clone());
        }
    }
}
