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

        // Base tree: either from parent commit or empty tree
        let mut tree_builder = if let Some(parent_oid) = parent_commit_oid {
            let parent_commit = repo.find_commit(parent_oid)?;
            let parent_tree = parent_commit.tree()?;
            repo.treebuilder(Some(&parent_tree))?
        } else if let Ok(head_commit) = repo.head().and_then(|h| h.peel_to_commit()) {
            let head_tree = head_commit.tree()?;
            repo.treebuilder(Some(&head_tree))?
        } else {
            repo.treebuilder(None)?
        };

        // Apply deltas into the tree builder
        for (rel_path, blob_oid, file_mode) in delta_entries {
            // For root files or nested paths:
            // Insert file mode (usually 0o100644 or 0o100755)
            let mode = match *file_mode {
                FileMode::BlobExecutable => 0o100755,
                _ => 0o100644,
            };
            tree_builder.insert(rel_path, *blob_oid, mode)?;
        }

        let tree_oid = tree_builder.write()?;
        let tree = repo.find_tree(tree_oid)?;

        let sig = Signature::now("Rewind Flight Recorder", "rewind@local.internal")?;
        let message = format!("rewind: checkpoint [{}] trigger: {}", session_id, trigger);

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

        // Update custom out-of-band reference: refs/rewind/session_<id>/HEAD
        let ref_name = format!("refs/rewind/session_{}/HEAD", session_id);
        repo.reference(&ref_name, commit_oid, true, "rewind: update checkpoint ref")?;

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

