use anyhow::Result;
use clap::Parser;
use serde_json::json;
use std::sync::Arc;
use agentvault::cli::{Cli, Commands};
use agentvault::{AgentVaultEngine, HookServer, PtySession};

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize tracing subscriber for non-blocking warnings
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .try_init();

    let cli = Cli::parse();
    let current_dir = std::env::current_dir()?;

    match cli.command {
        Commands::Run { command, dangerously_skip_permissions: _ } => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            let agent_name = command.first().map(|s| s.as_str()).unwrap_or("agent");
            let session = engine.start_session(agent_name)?;

            println!("\x1b[36m● AgentVault V4 Active:\x1b[0m wrapping {} (Session: {})", agent_name, session.id);
            println!("  Persistent store: {:?}", engine.cas.store_dir);

            // Spawn background synchronous hook server on port 4040
            let engine_hook_clone = engine.clone();
            let session_id_clone = session.id.clone();
            tokio::spawn(async move {
                let trigger_fn = Arc::new(move |sid: &str, trigger: &str| {
                    let cp = engine_hook_clone.take_checkpoint(sid, trigger)?;
                    Ok((cp.id, cp.git_commit_hash))
                });
                let server = HookServer::new(&session_id_clone, trigger_fn, 4040);
                let _ = server.start().await;
            });

            // Run agent command inside native PTY with non-blocking stream sniffing
            let pty = PtySession::new();
            let engine_pty_clone = engine.clone();
            let session_id_pty = session.id.clone();

            let exit_code = pty.run_command(&command, move || {
                let _ = engine_pty_clone.take_checkpoint(&session_id_pty, "EMERGENCY_SNIFF_TRIGGER");
            })?;

            // Capture final checkpoint upon process exit
            let _ = engine.take_checkpoint(&session.id, "SESSION_EXIT");
            println!("\x1b[32m✔ Flight session completed.\x1b[0m");

            std::process::exit(exit_code);
        }

        Commands::Claude { args } => {
            let mut full_cmd = vec!["claude".to_string()];
            full_cmd.extend(args);
            let engine = AgentVaultEngine::new(&current_dir)?;
            let session = engine.start_session("claude")?;

            println!("\x1b[36m● AgentVault V4 Active:\x1b[0m wrapping claude (Session: {})", session.id);

            let engine_hook = engine.clone();
            let sid = session.id.clone();
            tokio::spawn(async move {
                let trigger_fn = Arc::new(move |s: &str, t: &str| {
                    let cp = engine_hook.take_checkpoint(s, t)?;
                    Ok((cp.id, cp.git_commit_hash))
                });
                let server = HookServer::new(&sid, trigger_fn, 4040);
                let _ = server.start().await;
            });

            let pty = PtySession::new();
            let engine_pty = engine.clone();
            let sid_pty = session.id.clone();

            let exit_code = pty.run_command(&full_cmd, move || {
                let _ = engine_pty.take_checkpoint(&sid_pty, "EMERGENCY_SNIFF_TRIGGER");
            })?;

            let _ = engine.take_checkpoint(&session.id, "SESSION_EXIT");
            std::process::exit(exit_code);
        }

        Commands::Aider { args } => {
            let mut full_cmd = vec!["aider".to_string()];
            full_cmd.extend(args);
            let engine = AgentVaultEngine::new(&current_dir)?;
            let session = engine.start_session("aider")?;

            println!("\x1b[36m● AgentVault V4 Active:\x1b[0m wrapping aider (Session: {})", session.id);

            let engine_hook = engine.clone();
            let sid = session.id.clone();
            tokio::spawn(async move {
                let trigger_fn = Arc::new(move |s: &str, t: &str| {
                    let cp = engine_hook.take_checkpoint(s, t)?;
                    Ok((cp.id, cp.git_commit_hash))
                });
                let server = HookServer::new(&sid, trigger_fn, 4040);
                let _ = server.start().await;
            });

            let pty = PtySession::new();
            let engine_pty = engine.clone();
            let sid_pty = session.id.clone();

            let exit_code = pty.run_command(&full_cmd, move || {
                let _ = engine_pty.take_checkpoint(&sid_pty, "EMERGENCY_SNIFF_TRIGGER");
            })?;

            let _ = engine.take_checkpoint(&session.id, "SESSION_EXIT");
            std::process::exit(exit_code);
        }

        Commands::Undo { target, force } => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            // If target is 1 and latest checkpoint is not 1, roll back 1 step.
            // If target matches a specific checkpoint ID, rollback to that checkpoint ID.
            // Otherwise, rollback `target` steps.
            let res = if target == 1 {
                engine.rollback(1, force)
            } else if let Ok(Some(_)) = engine.ledger.get_checkpoint(target) {
                engine.rollback_to_checkpoint_id(target, force)
            } else {
                engine.rollback(target.max(1) as usize, force)
            };

            match res {
                Ok(restored_cp) => {
                    println!("\x1b[32m✔ Codebase successfully restored to checkpoint #{}.\x1b[0m", restored_cp.id);
                    println!("  Restored Checkpoint ID: {}", restored_cp.id);
                    println!("  Git Commit Tree: {}", restored_cp.git_commit_hash);
                    println!("  Timestamp: {}", restored_cp.created_at);
                }
                Err(err) => {
                    eprintln!("\x1b[31m✖ Rollback Failed: {}\x1b[0m", err);
                    std::process::exit(1);
                }
            }
        }

        Commands::Gc { max_mb } => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            let stats = engine.run_gc(max_mb)?;

            println!("\x1b[32m✔ Reachability Garbage Collection complete:\x1b[0m");
            println!("  Blobs Scanned: {}", stats.blobs_scanned);
            println!("  Blobs Evicted: {}", stats.blobs_evicted);
            println!("  Bytes Reclaimed: {} bytes ({:.2} MB)", stats.bytes_evicted, stats.bytes_evicted as f64 / 1_048_576.0);
            println!("  Current CAS Footprint: {} bytes ({:.2} MB)", stats.total_remaining_bytes, stats.total_remaining_bytes as f64 / 1_048_576.0);
        }

        Commands::Status { json } => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            let latest = engine.ledger.get_latest_checkpoint()?;
            let total_cas_bytes = engine.ledger.get_total_cas_size()?;
            let checkpoints = engine.ledger.get_all_checkpoints()?;

            if json {
                // Return checkpoints array directly for VSCode TimelineProvider compatibility
                let json_items: Vec<_> = checkpoints.iter().map(|cp| {
                    json!({
                        "id": cp.id,
                        "session_id": cp.session_id,
                        "git_commit_hash": cp.git_commit_hash,
                        "trigger_type": cp.trigger_type,
                        "timestamp": cp.timestamp,
                        "created_at": cp.created_at,
                        "files_mutated": cp.files_mutated,
                    })
                }).collect();
                println!("{}", serde_json::to_string_pretty(&json_items)?);
            } else {
                println!("\x1b[36mAGENTVAULT V4 FLIGHT RECORDER STATUS\x1b[0m");
                println!("  Repository Root: {:?}", engine.repo_root);
                println!("  Repository Identity: {}", engine.cas.repo_hash);
                println!("  Persistent Store: {:?}", engine.cas.store_dir);
                println!("  Total CAS Size: {} bytes ({:.2} MB)", total_cas_bytes, total_cas_bytes as f64 / 1_048_576.0);

                if let Some(cp) = latest {
                    println!("  Latest Checkpoint ID: {}", cp.id);
                    println!("  Latest Commit OID: {}", cp.git_commit_hash);
                    println!("  Trigger: {}", cp.trigger_type);
                    println!("  Created At: {}", cp.created_at);
                    println!("  Files Mutated: {}", cp.files_mutated);
                } else {
                    println!("  No checkpoints recorded yet.");
                }
            }
        }

        Commands::ServeHooks { port } => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            let trigger_fn = Arc::new(move |sid: &str, trigger: &str| {
                let cp = engine.take_checkpoint(sid, trigger)?;
                Ok((cp.id, cp.git_commit_hash))
            });
            let server = HookServer::new("standalone", trigger_fn, port);
            println!("\x1b[36m● Starting AgentVault Pre-Tool Hook Server on port {}\x1b[0m", port);
            server.start().await?;
        }

        Commands::Ui => {
            let engine = AgentVaultEngine::new(&current_dir)?;
            println!("\x1b[36m┌─────────────────────────────────────────────────────────────┐\x1b[0m");
            println!("\x1b[36m│ AGENTVAULT FLIGHT RECORDER DASHBOARD                       │\x1b[0m");
            println!("\x1b[36m├─────────────────────────────────────────────────────────────┤\x1b[0m");
            println!("│ Persistent Store: {:<42} │", engine.cas.store_dir.display());

            if let Ok(Some(latest)) = engine.ledger.get_latest_checkpoint() {
                if let Ok(cps) = engine.ledger.get_checkpoints_for_session(&latest.session_id) {
                    println!("\x1b[36m├─────────────────────────────────────────────────────────────┤\x1b[0m");
                    println!("│ \x1b[1mID    TIMESTAMP             TRIGGER              COMMIT\x1b[0m    │");
                    for cp in cps.iter().rev().take(10) {
                        println!("│ {:<5} {:<21} {:<20} {:<8} │", cp.id, cp.created_at, cp.trigger_type, &cp.git_commit_hash[0..8.min(cp.git_commit_hash.len())]);
                    }
                }
            } else {
                println!("│ No recorded checkpoints in database.                       │");
            }
            println!("\x1b[36m└─────────────────────────────────────────────────────────────┘\x1b[0m");
        }
    }

    Ok(())
}
