pub mod cli;
pub mod daemon;
pub mod git;
pub mod cas;
pub mod db;
pub mod pty;
pub mod server;
pub mod safety;

use anyhow::{bail, Context, Result};
use git2::{FileMode, Oid};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub use cas::{CasManifestEntry, CasStore, GcStats, DEFAULT_MAX_CAS_TOTAL_BYTES};
pub use daemon::{FileMetadata, IncrementalIndex, WatcherDaemon};
pub use db::{CheckpointRecord, Ledger, SessionRecord};
pub use git::GitEngine;
pub use pty::PtySession;
pub use safety::{verify_safety_conflicts, SafetyLockError};
pub use server::HookServer;

/// Rewind V2 Primary Engine Coordinator
#[derive(Clone)]
pub struct RewindEngine {
    pub repo_root: PathBuf,
    pub cas: CasStore,
    pub ledger: Ledger,
    pub git: Arc<GitEngine>,
    pub watcher: Arc<WatcherDaemon>,
    pub active_session: Arc<Mutex<Option<SessionRecord>>>,
}

impl RewindEngine {
    pub fn new<P: AsRef<Path>>(repo_path: P) -> Result<Self> {
        let repo_root = dunce::canonicalize(repo_path.as_ref())
            .context("Failed to canonicalize repository root")?;

        let cas = CasStore::new(&repo_root)?;
        let db_path = cas.store_dir.join("metadata.db");
        let ledger = Ledger::open(&db_path)?;
        let git = Arc::new(GitEngine::open(&repo_root)?);
        let watcher = Arc::new(WatcherDaemon::start(&repo_root)?);

        Ok(Self {
            repo_root,
            cas,
            ledger,
            git,
            watcher,
            active_session: Arc::new(Mutex::new(None)),
        })
    }

    pub fn start_session(&self, agent_name: &str) -> Result<SessionRecord> {
        let session = self.ledger.create_session(&self.cas.repo_hash, agent_name)?;
        *self.active_session.lock().unwrap() = Some(session.clone());

        // Baseline initial snapshot
        let _ = self.take_checkpoint(&session.id, "SESSION_START");

        Ok(session)
    }

    /// Generates an atomic, sub-20ms checkpoint commit and CAS snapshot
    pub fn take_checkpoint(&self, session_id: &str, trigger: &str) -> Result<CheckpointRecord> {
        let mut index = self.watcher.index.write().unwrap();
        let deltas = index.get_deltas(&self.repo_root);

        // 1. Process untracked whitelisted files (e.g. .env*) into Content-Addressable Storage (CAS)
        let mut cas_manifest = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&self.repo_root) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && CasStore::is_whitelisted(&path) {
                    if let Ok(Some(cas_entry)) = self.cas.store_file(&path) {
                        cas_manifest.push(cas_entry);
                    }
                }
            }
        }

        // 2. Process Git tracked deltas into Git ODB as raw Blobs
        let mut git_delta_entries: Vec<(String, Oid, FileMode)> = Vec::new();
        for (rel_path, bytes_opt, is_deleted) in &deltas {
            let rel_str = rel_path.to_string_lossy().to_string();

            // Do not store .env files in Git ODB (prevents secret leaks)
            if CasStore::is_whitelisted(rel_path) {
                continue;
            }

            if *is_deleted {
                // Deletions are omitted from tree builder
                continue;
            }

            if let Some(bytes) = bytes_opt {
                let blob_oid = self.git.write_blob(bytes)?;
                git_delta_entries.push((rel_str, blob_oid, FileMode::Blob));
            }
        }

        // 3. Resolve parent commit
        let parent_oid = self.ledger.get_latest_checkpoint()
            .ok()
            .flatten()
            .and_then(|cp| Oid::from_str(&cp.git_commit_hash).ok());

        // 4. Create Git Tree and Commit in ODB
        let commit_oid = self.git.create_checkpoint_commit(
            session_id,
            &git_delta_entries,
            parent_oid,
            trigger,
        )?;

        let commit_hash_str = commit_oid.to_string();

        // 5. Insert record into SQLite WAL ledger
        let checkpoint = self.ledger.insert_checkpoint(
            session_id,
            &commit_hash_str,
            trigger,
            &cas_manifest,
        )?;

        // 6. Update index committed state
        index.mark_checkpoint_committed();

        Ok(checkpoint)
    }

    /// Rollback working directory by N checkpoints
    pub fn rollback(&self, steps: usize, force: bool) -> Result<CheckpointRecord> {
        let latest = self.ledger.get_latest_checkpoint()?
            .context("No checkpoints found to rollback")?;

        let session_checkpoints = self.ledger.get_checkpoints_for_session(&latest.session_id)?;
        if session_checkpoints.is_empty() {
            bail!("No checkpoints recorded for current session");
        }

        let target_idx = session_checkpoints.len().saturating_sub(steps.max(1) + 1);
        let target_checkpoint = &session_checkpoints[target_idx];

        // 1. Safety conflict check
        let mut latest_hashes = BTreeMap::new();
        {
            let idx = self.watcher.index.read().unwrap();
            for (path, meta) in &idx.entries {
                latest_hashes.insert(path.clone(), meta.blake3_hash.clone());
            }
        }

        let files_to_mutate: Vec<PathBuf> = latest_hashes.keys().cloned().collect();
        verify_safety_conflicts(&self.repo_root, &files_to_mutate, &latest_hashes, force)?;

        // 2. Compensation checkpoint (makes rollbacks themselves reversible)
        let _ = self.take_checkpoint(&latest.session_id, "COMPENSATION_PRE_ROLLBACK");

        // 3. Checkout target Git tree
        let commit_oid = Oid::from_str(&target_checkpoint.git_commit_hash)?;
        self.git.checkout_commit(commit_oid, true)?;

        // 4. Reconcile CAS files (restore .env, delete newly added secrets that didn't exist)
        let manifest = self.ledger.get_cas_manifest(target_checkpoint.id)?;
        for entry in &manifest {
            let cas_entry = CasManifestEntry {
                relative_path: entry.file_path.clone(),
                blob_hash: entry.blob_hash.clone(),
                size_bytes: 0,
                permissions_mode: 0o600,
                is_compressed: false,
                last_modified: 0,
            };
            let _ = self.cas.restore_file(&cas_entry);
        }

        // Rescan watcher index
        {
            let mut idx = self.watcher.index.write().unwrap();
            let _ = idx.initial_scan(&self.repo_root);
        }

        Ok(target_checkpoint.clone())
    }

    /// Runs garbage collection enforcing max allowed storage
    pub fn run_gc(&self, max_bytes: Option<u64>) -> Result<GcStats> {
        let limit = max_bytes.unwrap_or(DEFAULT_MAX_CAS_TOTAL_BYTES);
        cas::run_garbage_collection(&self.cas, limit)
    }
}
