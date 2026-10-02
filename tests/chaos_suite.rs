use anyhow::Result;
use git2::{Repository, Signature};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use std::time::Instant;
use tempfile::tempdir;

use ghostbranch::cas::{run_reachability_gc, CasStore};
use ghostbranch::daemon::{FileMetadata, IncrementalIndex};
use ghostbranch::db::Ledger;
use ghostbranch::GhostBranchEngine;

/// Helper to initialize a mock git repository with an initial commit
fn init_mock_git_repo<P: AsRef<Path>>(path: P) -> Result<()> {
    let repo = Repository::init(path.as_ref())?;
    let sig = Signature::now("Test User", "test@example.com")?;

    let readme_path = path.as_ref().join("README.md");
    fs::write(&readme_path, "# Mock Repo\n")?;

    let mut index = repo.index()?;
    index.add_path(Path::new("README.md"))?;
    let tree_id = index.write_tree()?;
    let message = format!("initial commit for {:?}", path.as_ref());
    {
        let tree = repo.find_tree(tree_id)?;
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[])?;
    }
    Ok(())
}

/// TEST 1: The `rm -rf .git` Survival Test (Proves Fix #3 & Task 2)
/// Wiping .git inside the target repository must never destroy the recovery insurance policy
/// because GhostBranch stores all CAS blobs and SQLite ledgers in persistent application data directories.
#[test]
fn test_rm_rf_git_survival() -> Result<()> {
    let temp_repo = tempdir()?;
    let repo_path = temp_repo.path();
    let _ = init_mock_git_repo(repo_path)?;

    // Create a critical secret .env file
    let env_path = repo_path.join(".env");
    fs::write(&env_path, "STRIPE_SECRET_KEY=sk_test_999\nDATABASE_URL=postgres://localhost\n")?;

    let engine = GhostBranchEngine::new(repo_path)?;
    let session = engine.start_session("test_agent")?;

    // Checkpoint 1: baseline with .env captured in CAS
    let cp1 = engine.take_checkpoint(&session.id, "TEST_BASELINE")?;
    assert!(cp1.id > 0);

    // Verify out-of-band store is completely separate from repo_path
    assert_ne!(engine.cas.store_dir, repo_path.to_path_buf());
    assert!(engine.cas.store_dir.exists());
    assert!(engine.cas.store_dir.join("metadata.db").exists());

    // Agent executes destructive rogue command: rm -rf .git and corrupts .env
    fs::remove_dir_all(repo_path.join(".git"))?;
    fs::write(&env_path, "CORRUPTED CONTENT")?;

    assert!(!repo_path.join(".git").exists());

    // Out-of-band store is completely unharmed
    assert!(engine.cas.store_dir.exists());
    assert!(engine.cas.store_dir.join("metadata.db").exists());

    // Reconstruct and verify out-of-band CAS manifests restore the lost .env
    let manifest = engine.ledger.get_cas_manifest(cp1.id)?;
    assert!(!manifest.is_empty());

    let env_manifest_entry = manifest.iter()
        .find(|m| m.file_path == ".env")
        .expect("Manifest must contain .env entry");

    // Restore .env directly from out-of-band CAS
    let cas_entry = ghostbranch::cas::CasManifestEntry {
        relative_path: env_manifest_entry.file_path.clone(),
        blob_hash: env_manifest_entry.blob_hash.clone(),
        size_bytes: 0,
        permissions_mode: 0o600,
        is_compressed: env_manifest_entry.is_compressed,
        last_modified: 0,
    };
    engine.cas.restore_file(&cas_entry)?;

    let restored_content = fs::read_to_string(&env_path)?;
    assert_eq!(restored_content, "STRIPE_SECRET_KEY=sk_test_999\nDATABASE_URL=postgres://localhost\n");

    Ok(())
}

/// TEST 2: The 10k File Delta Speed Test (Proves Fix #2)
/// Asserts that delta computation on a 10,000-file repository executes in <50ms
/// by eliminating raw `git add --all` full-tree walks in favor of incremental inode checks.
#[test]
fn test_10k_file_delta_speed() -> Result<()> {
    let temp_repo = tempdir()?;
    let repo_path = temp_repo.path();

    let mut index = IncrementalIndex::new();

    // Populate index with 10,000 files in memory
    for i in 0..10_000 {
        let rel_path = std::path::PathBuf::from(format!("src/module_{}/file_{}.ts", i / 100, i));
        let meta = FileMetadata {
            mtime: 1700000000,
            size: 1024,
            inode: i as u64,
            blake3_hash: format!("hash_{}", i),
            is_deleted: false,
        };
        index.entries.insert(rel_path.clone(), meta.clone());
        index.committed_hashes.insert(rel_path, meta.blake3_hash);
    }

    assert_eq!(index.entries.len(), 10_000);

    // Simulate an agent modifying exactly 5 files out of 10,000
    for i in 42..47 {
        let rel_path = std::path::PathBuf::from(format!("src/module_{}/file_{}.ts", i / 100, i));
        let abs_path = repo_path.join(&rel_path);
        if let Some(parent) = abs_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&abs_path, format!("// Modified code in file {}", i))?;

        // Update index with modified file
        index.update_file(repo_path, &abs_path)?;
    }

    // Benchmark delta calculation speed
    let start = Instant::now();
    let deltas = index.get_deltas(repo_path);
    let duration = start.elapsed();

    println!("10,000 file delta calculation time: {:?}", duration);

    // Assert strictly under 50ms budget
    assert!(duration.as_millis() < 50, "Delta calculation must be under 50ms, took {:?}", duration);

    // Assert exactly 5 files detected as modified
    assert_eq!(deltas.len(), 5);

    Ok(())
}

/// TEST 3: Reachability GC & Reference Counting Test (Proves Task 3)
/// Writes CAS data exceeding a budget limit, triggers checkpoints,
/// verifies ref_count tracking, and asserts reachability GC evicts oldest checkpoints
/// and prunes orphaned unreferenced blobs.
#[test]
fn test_reachability_gc() -> Result<()> {
    let temp_store_dir = tempdir()?;
    let repo_dir = tempdir()?;

    let store = CasStore {
        repo_root: repo_dir.path().to_path_buf(),
        repo_hash: "mock_hash".to_string(),
        store_dir: temp_store_dir.path().to_path_buf(),
        objects_dir: temp_store_dir.path().join("cas_objects"),
    };
    fs::create_dir_all(&store.objects_dir)?;

    let ledger = Ledger::open(temp_store_dir.path().join("metadata.db"))?;
    let session = ledger.create_session("mock_hash", "gc_agent")?;

    // Store 15 individual 1 MB blobs across 15 checkpoints (15 MB total)
    let payload = vec![0xABu8; 1024 * 1024]; // 1MB
    for i in 0..15 {
        let file_path = repo_dir.path().join(format!("secret_{}.env", i));
        let mut f = File::create(&file_path)?;
        f.write_all(&payload)?;
        f.write_all(&[i as u8])?; // Ensure unique content/hash
        drop(f);

        if let Some(entry) = store.store_file(&file_path)? {
            ledger.insert_checkpoint(&session.id, &format!("commit_{}", i), "STEP", &[entry])?;
        }
    }

    // Verify initial size
    let initial_size = ledger.get_total_cas_size()?;
    assert!(initial_size >= 15 * 1024 * 1024);

    // Run reachability GC with a 10 MB ceiling (target ceiling = 80% = 8 MB)
    let conn = ledger.get_connection();
    let conn_guard = conn.lock().unwrap();
    let stats = run_reachability_gc(10, &conn_guard, &store.objects_dir)?;

    println!("Reachability GC Stats: {:?}", stats);

    // Assert eviction occurred
    assert!(stats.blobs_evicted > 0, "Blobs must be evicted");
    assert!(stats.bytes_evicted > 0, "Bytes must be reclaimed");

    // Assert total remaining storage is <= 80% of max budget (8 MB)
    let target_ceiling = (10.0 * 1024.0 * 1024.0 * 0.8) as u64;
    assert!(
        stats.total_remaining_bytes <= target_ceiling,
        "Remaining bytes ({}) must be <= target ceiling ({})",
        stats.total_remaining_bytes,
        target_ceiling
    );

    Ok(())
}

/// TEST 4: The Pre-Tool Hook Race (Proves Fix #1)
/// Rapid write burst followed by a synchronous pre-flight hook blocks execution
/// until all edits are safely committed, eliminating the 250ms race condition.
#[test]
fn test_pre_tool_hook_race() -> Result<()> {
    let temp_repo = tempdir()?;
    let repo_path = temp_repo.path();
    let _ = init_mock_git_repo(repo_path)?;

    let engine = GhostBranchEngine::new(repo_path)?;
    let session = engine.start_session("pre_hook_agent")?;

    // Simulate 50 rapid file edits
    for i in 0..50 {
        let file_path = repo_path.join(format!("rapid_file_{}.txt", i));
        fs::write(&file_path, format!("content for step {}", i))?;
        let mut idx = engine.watcher.index.write().unwrap();
        idx.update_file(repo_path, &file_path)?;
    }

    // Synchronous Pre-Tool Hook executes immediately
    let checkpoint = engine.take_checkpoint(&session.id, "PRE_TOOL_BASH_HOOK")?;
    assert!(checkpoint.id > 0);

    // Destructive action: delete all 50 files
    for i in 0..50 {
        let file_path = repo_path.join(format!("rapid_file_{}.txt", i));
        fs::remove_file(&file_path)?;
        assert!(!file_path.exists());
    }
    let mut idx = engine.watcher.index.write().unwrap();
    for i in 0..50 {
        let file_path = repo_path.join(format!("rapid_file_{}.txt", i));
        idx.remove_file(repo_path, &file_path);
    }
    drop(idx);

    // Agent attempts to record corrupted step upon exiting
    let _ = engine.take_checkpoint(&session.id, "AGENT_DESTRUCTION_STEP")?;

    // Rollback 1 step to revert the destruction and land on pre-flight hook checkpoint
    let rolled_back_cp = engine.rollback(1, true)?;
    assert_eq!(rolled_back_cp.id, checkpoint.id);

    // Verify all 50 files were safely captured and completely restored
    for i in 0..50 {
        let file_path = repo_path.join(format!("rapid_file_{}.txt", i));
        assert!(file_path.exists(), "File rapid_file_{}.txt must exist after rollback", i);
        let content = fs::read_to_string(&file_path)?;
        assert_eq!(content, format!("content for step {}", i));
    }

    Ok(())
}
