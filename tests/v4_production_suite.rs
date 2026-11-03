use anyhow::Result;
use git2::{Repository, Signature};
use std::fs;
use std::path::Path;
use tempfile::tempdir;

use agentvault::cas::reconcile_ref_counts;
use agentvault::db::Ledger;
use agentvault::git::derive_repo_identity;
use agentvault::pty::{contains_destructive_pattern, sniff_and_warn_destructive, sniff_ux_warning};
use agentvault::AgentVaultEngine;

fn init_test_git_repo<P: AsRef<Path>>(path: P) -> Result<Repository> {
    let repo = Repository::init(path.as_ref())?;
    let sig = Signature::now("AgentVault Tester", "tester@agentvault.internal")?;
    let readme = path.as_ref().join("README.md");
    fs::write(&readme, "# Test Repo\n")?;

    let mut index = repo.index()?;
    index.add_path(Path::new("README.md"))?;
    let tree_id = index.write_tree()?;
    let message = format!("root commit for {:?}", path.as_ref());
    {
        let tree = repo.find_tree(tree_id)?;
        repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &[])?;
    }
    Ok(repo)
}

#[test]
fn test_repo_identity_derivation() -> Result<()> {
    let temp = tempdir()?;
    let repo_path = temp.path();

    // 1. Non-git directory -> fallback to path hash
    let non_git_id = derive_repo_identity(repo_path)?;
    assert!(!non_git_id.is_empty());

    // 2. Git repo with zero commits -> fallback to path hash
    let _ = Repository::init(repo_path)?;
    let zero_commit_id = derive_repo_identity(repo_path)?;
    assert!(!zero_commit_id.is_empty());

    // 3. Git repo with root commit -> deterministic hash of root commit OID
    let sig = Signature::now("Test", "test@test.com")?;
    let repo = Repository::open(repo_path)?;
    fs::write(repo_path.join("file.txt"), "hello")?;
    let mut index = repo.index()?;
    index.add_path(Path::new("file.txt"))?;
    let tree_id = index.write_tree()?;
    let root_oid = {
        let tree = repo.find_tree(tree_id)?;
        repo.commit(Some("HEAD"), &sig, &sig, "root", &tree, &[])?
    };

    let committed_id = derive_repo_identity(repo_path)?;
    let expected_hash = blake3::hash(root_oid.as_bytes()).to_hex().to_string();
    assert_eq!(committed_id, expected_hash);

    Ok(())
}

#[test]
fn test_reconcile_trigger_drift() -> Result<()> {
    let temp = tempdir()?;
    let db_path = temp.path().join("test.db");
    let ledger = Ledger::open(&db_path)?;

    let session = ledger.create_session("repo_test", "drift_agent")?;

    let conn_arc = ledger.get_connection();
    let conn = conn_arc.lock().unwrap();

    // Create fake blob and manifest entries
    conn.execute(
        "INSERT INTO cas_blobs (hash, size_bytes, ref_count) VALUES ('blob_alpha', 100, 10)",
        [],
    )?;

    conn.execute(
        "INSERT INTO checkpoints (session_id, git_commit_hash, trigger_type, timestamp, files_mutated) 
         VALUES (?1, 'hash1', 'TEST', 1000, 1)",
        [&session.id],
    )?;
    let ckpt_id = conn.last_insert_rowid();

    // Add only 1 manifest entry referencing blob_alpha
    conn.execute(
        "INSERT INTO cas_manifest (checkpoint_id, file_path, blob_hash, is_encrypted, is_compressed) 
         VALUES (?1, '.env', 'blob_alpha', 0, 1)",
        [ckpt_id],
    )?;

    // Notice: blob_alpha ref_count in DB is currently 10 + 1 (trigger) = 11, but manifest has only 1!
    let drifted_count: i64 = conn.query_row(
        "SELECT ref_count FROM cas_blobs WHERE hash = 'blob_alpha'",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(drifted_count, 11);

    // Run reconciliation
    reconcile_ref_counts(&conn)?;

    let corrected_count: i64 = conn.query_row(
        "SELECT ref_count FROM cas_blobs WHERE hash = 'blob_alpha'",
        [],
        |r| r.get(0),
    )?;
    // Now it matches exact manifest count: 1
    assert_eq!(corrected_count, 1);

    Ok(())
}

#[test]
fn test_pty_sniff_ansi_destructive_detection() {
    let ansi_rm_rf = b"\x1b[31;1mrm -rf /Users/test/workspace\x1b[0m";
    assert!(sniff_and_warn_destructive(ansi_rm_rf));

    let git_clean = b"git clean -fdx\r\n";
    assert!(sniff_and_warn_destructive(git_clean));

    // Non-destructive benign text
    let benign = b"\x1b[32mCompiling agentvault v4.0.0\x1b[0m\n";
    assert!(!sniff_and_warn_destructive(benign));

    // Verify non-blocking sniff_ux_warning does not panic or block
    sniff_ux_warning(ansi_rm_rf);
    sniff_ux_warning(benign);

    assert!(contains_destructive_pattern("rm -rF ./dist"));
    assert!(!contains_destructive_pattern("echo 'safely compiling'"));
}

#[test]
fn test_rollback_to_checkpoint_id() -> Result<()> {
    let temp_repo = tempdir()?;
    let repo_path = temp_repo.path();
    let _ = init_test_git_repo(repo_path)?;

    let engine = AgentVaultEngine::new(repo_path)?;
    let session = engine.start_session("multi_step_agent")?;

    let file_path = repo_path.join("counter.txt");

    // Checkpoint 1
    fs::write(&file_path, "value: 1\n")?;
    let mut idx = engine.watcher.index.write().unwrap();
    idx.update_file(repo_path, &file_path)?;
    drop(idx);
    let cp1 = engine.take_checkpoint(&session.id, "STEP_1")?;

    // Checkpoint 2
    fs::write(&file_path, "value: 2\n")?;
    let mut idx = engine.watcher.index.write().unwrap();
    idx.update_file(repo_path, &file_path)?;
    drop(idx);
    let cp2 = engine.take_checkpoint(&session.id, "STEP_2")?;

    // Checkpoint 3 (current / broken state)
    fs::write(&file_path, "value: 3_CORRUPTED\n")?;
    let mut idx = engine.watcher.index.write().unwrap();
    idx.update_file(repo_path, &file_path)?;
    drop(idx);
    let _ = engine.take_checkpoint(&session.id, "STEP_3_BAD")?;

    // Rollback directly to Checkpoint 1 by ID
    let restored = engine.rollback_to_checkpoint_id(cp1.id, true)?;
    assert_eq!(restored.id, cp1.id);

    let content = fs::read_to_string(&file_path)?;
    assert_eq!(content, "value: 1\n");

    // Rollback to Checkpoint 2 by ID
    let restored2 = engine.rollback_to_checkpoint_id(cp2.id, true)?;
    assert_eq!(restored2.id, cp2.id);

    let content2 = fs::read_to_string(&file_path)?;
    assert_eq!(content2, "value: 2\n");

    // Checkpoint 4: Nested path creation (src/cas/gc.rs) and git ls-tree inspection
    let nested_dir = repo_path.join("src").join("cas");
    fs::create_dir_all(&nested_dir)?;
    let nested_file = nested_dir.join("gc.rs");
    fs::write(&nested_file, "pub fn collect_garbage() {}")?;

    let mut idx = engine.watcher.index.write().unwrap();
    idx.update_file(repo_path, &nested_file)?;
    drop(idx);

    let cp4 = engine.take_checkpoint(&session.id, "NESTED_PATHS")?;
    assert!(!cp4.git_commit_hash.is_empty());

    // Inspect git commit tree with git CLI to prove nested structure is hierarchical
    let output = std::process::Command::new("git")
        .args(&["ls-tree", "-r", "--name-only", &cp4.git_commit_hash])
        .current_dir(repo_path)
        .output()?;

    let stdout_str = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout_str.contains("src/cas/gc.rs"),
        "Expected git ls-tree to contain 'src/cas/gc.rs', got: {}",
        stdout_str
    );

    Ok(())
}

#[test]
fn test_security_fixes_av01_av02_av03() -> Result<()> {
    let temp_repo = tempdir()?;
    let repo_path = temp_repo.path();
    let _ = init_test_git_repo(repo_path)?;

    let engine = AgentVaultEngine::new(repo_path)?;
    let session = engine.start_session("security_test_agent")?;

    // --- AV-01: Path traversal validation in CasStore::restore_file ---
    let real_env = repo_path.join(".env");
    fs::write(&real_env, "SAFE_KEY=safe_value\n")?;
    let manifest_entry = engine.cas.store_file(&real_env)?.expect("must store valid file");

    let mut traversal_entry = manifest_entry.clone();
    traversal_entry.relative_path = "../evil_traversal.txt".to_string();
    let res = engine.cas.restore_file(&traversal_entry);
    assert!(res.is_err(), "AV-01: CasStore::restore_file must reject ParentDir path traversal");

    let mut root_entry = manifest_entry.clone();
    root_entry.relative_path = "/etc/traversal.txt".to_string();
    let res = engine.cas.restore_file(&root_entry);
    assert!(res.is_err(), "AV-01: CasStore::restore_file must reject RootDir / absolute paths");

    // --- AV-02: Symlink traversal rejection in CAS Checkpointing ---
    #[cfg(unix)]
    {
        let outside_dir = tempdir()?;
        let outside_secret = outside_dir.path().join("outside_secret.env");
        fs::write(&outside_secret, "SUPER_SECRET_TOKEN=xyz\n")?;

        let symlink_path = repo_path.join(".env.symlink");
        std::os::unix::fs::symlink(&outside_secret, &symlink_path)?;

        // store_file must reject symlinks
        let store_res = engine.cas.store_file(&symlink_path)?;
        assert!(store_res.is_none(), "AV-02: CasStore::store_file must reject symlinks");

        // take_checkpoint must ignore symlinks and not record them into CAS manifest
        let cp = engine.take_checkpoint(&session.id, "TEST_SYMLINK_CHECK")?;
        let manifest = engine.ledger.get_cas_manifest(cp.id)?;
        for entry in &manifest {
            assert_ne!(
                entry.file_path, ".env.symlink",
                "AV-02: Symlink file must never be recorded into CAS manifest"
            );
        }
    }

    // --- AV-03: Hook API token validation ---
    use agentvault::server::{validate_token, PreFlightRequest, ServerState};
    use axum::http::{HeaderMap, StatusCode};
    use std::sync::Arc;

    let server_state = ServerState {
        default_session_id: session.id.clone(),
        trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
        auth_token: Some("local_env_secret_token".to_string()),
    };

    // Default session without valid token rejected (no authentication bypass)
    let req_unauth_session = PreFlightRequest {
        tool_name: Some("test_tool".to_string()),
        command: None,
        session_id: Some(session.id.clone()),
        token: None,
    };
    assert_eq!(
        validate_token(&server_state, &HeaderMap::new(), &req_unauth_session),
        Err(StatusCode::UNAUTHORIZED)
    );

    // Valid token in payload
    let req_valid_payload_token = PreFlightRequest {
        tool_name: Some("test_tool".to_string()),
        command: None,
        session_id: Some(session.id.clone()),
        token: Some("local_env_secret_token".to_string()),
    };
    assert_eq!(
        validate_token(&server_state, &HeaderMap::new(), &req_valid_payload_token),
        Ok(session.id.clone())
    );

    // Valid environment token in header
    let mut auth_headers = HeaderMap::new();
    auth_headers.insert(
        axum::http::header::AUTHORIZATION,
        "Bearer local_env_secret_token".parse().unwrap(),
    );
    let req_env_auth = PreFlightRequest {
        tool_name: Some("test_tool".to_string()),
        command: None,
        session_id: None,
        token: None,
    };
    assert_eq!(
        validate_token(&server_state, &auth_headers, &req_env_auth),
        Ok(session.id.clone())
    );

    // Invalid token rejected
    let req_invalid = PreFlightRequest {
        tool_name: Some("test_tool".to_string()),
        command: None,
        session_id: Some("malicious_hijacked_session".to_string()),
        token: None,
    };
    assert_eq!(
        validate_token(&server_state, &HeaderMap::new(), &req_invalid),
        Err(StatusCode::UNAUTHORIZED)
    );

    Ok(())
}
