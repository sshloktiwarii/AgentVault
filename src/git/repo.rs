use anyhow::{Context, Result};
use git2::{Commit, FileMode, Oid, Repository, Signature};
use std::path::{Path, PathBuf};

pub struct GitEngine {
    pub repo_root: PathBuf,
}

impl GitEngine {
    pub fn open<P: AsRef<Path>>(repo_path: P) -> Result<Self> {
        let canonical = dunce::canonicalize(repo_path.as_ref())
            .context("Failed to canonicalize path for GitEngine")?;
        
        // Ensure repository can be opened
        let _ = Repository::open(&canonical)
            .with_context(|| format!("Failed to open Git repository at {:?}", canonical))?;

        Ok(Self {
            repo_root: canonical,
        })
    }

    /// Helper to get a fresh git2::Repository instance
    fn get_repo(&self) -> Result<Repository> {
        Ok(Repository::open(&self.repo_root)?)
    }

    /// Writes raw file bytes directly to the Git Object Database (ODB) as a blob without touching .git/index
    pub fn write_blob(&self, data: &[u8]) -> Result<Oid> {
        let repo = self.get_repo()?;
        let oid = repo.blob(data)?;
        Ok(oid)
    }

    /// Constructs and commits a Tree object representing the working directory delta directly to the ODB.
    /// Does NOT touch .git/index and does NOT move active branch HEAD.
    pub fn create_checkpoint_commit(
        &self,
        session_id: &str,
        delta_entries: &[(String, Oid, FileMode)],
        parent_commit_oid: Option<Oid>,
        trigger: &str,
    ) -> Result<Oid> {
        let repo = self.get_repo()?;

        // Use an in-memory index to build nested directory tree hierarchies properly
        let mut index = repo.index()?;
        index.clear()?;

        // If a parent commit exists, seed index from its tree
        let base_tree = if let Some(parent_oid) = parent_commit_oid {
            let parent_commit = repo.find_commit(parent_oid)?;
            Some(parent_commit.tree()?)
        } else if let Ok(head_commit) = repo.head().and_then(|h| h.peel_to_commit()) {
            Some(head_commit.tree()?)
        } else {
            None
        };

        if let Some(ref tree) = base_tree {
            index.read_tree(tree)?;
        }

        // Apply deltas into the in-memory index
        for (rel_path, blob_oid, file_mode) in delta_entries {
            let mode = match *file_mode {
                FileMode::BlobExecutable => 0o100755,
                _ => 0o100644,
            };
            let entry = git2::IndexEntry {
                ctime: git2::IndexTime::new(0, 0),
                mtime: git2::IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode,
                uid: 0,
                gid: 0,
                file_size: 0,
                id: *blob_oid,
                flags: 0,
                flags_extended: 0,
                path: rel_path.as_bytes().to_vec(),
            };
            index.add(&entry)?;
        }

        let tree_oid = index.write_tree_to(&repo)?;
        let tree = repo.find_tree(tree_oid)?;

        let sig = Signature::now("AgentVault Flight Recorder", "agentvault@local.internal")?;
        let message = format!("agentvault: checkpoint [{}] trigger: {}", session_id, trigger);

        let parent_commits: Vec<Commit> = match parent_commit_oid {
            Some(oid) => {
                if let Ok(c) = repo.find_commit(oid) {
                    vec![c]
                } else {
                    vec![]
                }
            }
            None => {
                if let Ok(head) = repo.head().and_then(|h| h.peel_to_commit()) {
                    vec![head]
                } else {
                    vec![]
                }
            }
        };

        let parent_refs: Vec<&Commit> = parent_commits.iter().collect();

        let commit_oid = repo.commit(
            None, // Do NOT update HEAD
            &sig,
            &sig,
            &message,
            &tree,
            &parent_refs,
        )?;

        // Update custom out-of-band reference: refs/agentvault/session_<id>/HEAD
        let ref_name = format!("refs/agentvault/session_{}/HEAD", session_id);
        repo.reference(&ref_name, commit_oid, true, "agentvault: update checkpoint ref")?;

        Ok(commit_oid)
    }

    /// Restores the working tree directly from a given Git commit OID
    pub fn checkout_commit(&self, commit_oid: Oid, force: bool) -> Result<()> {
        let repo = self.get_repo()?;
        let commit = repo.find_commit(commit_oid)?;
        let tree = commit.tree()?;

        let mut opts = git2::build::CheckoutBuilder::new();
        if force {
            opts.force();
        } else {
            opts.safe();
        }

        repo.checkout_tree(tree.as_object(), Some(&mut opts))?;
        Ok(())
    }

    /// Finds a tree OID from commit OID
    pub fn get_tree_oid_for_commit(&self, commit_oid: Oid) -> Result<Oid> {
        let repo = self.get_repo()?;
        let commit = repo.find_commit(commit_oid)?;
        Ok(commit.tree_id())
    }
}

