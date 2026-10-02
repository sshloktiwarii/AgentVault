use anyhow::{Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

use super::sniff::sniff_and_warn_destructive;

pub struct PtySession {
    pub is_running: Arc<AtomicBool>,
}

impl PtySession {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Spawns the target agent CLI command inside a cross-platform pseudo-terminal.
    /// Sniffs streams with ANSI stripping and emits non-blocking warnings if destructive patterns are seen.
    pub fn run_command<F>(
        &self,
        command_args: &[String],
        mut on_background_snapshot: F,
    ) -> Result<i32>
    where
        F: FnMut() + Send + 'static,
    {
        if command_args.is_empty() {
            anyhow::bail!("Command arguments cannot be empty");
        }

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(&command_args[0]);
        for arg in &command_args[1..] {
            cmd.arg(arg);
        }

        let mut child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave); // Master handles communication

        self.is_running.store(true, Ordering::SeqCst);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;

        // Background thread: read from PTY master, sniff stdout for patterns, and write to user stdout
        let is_running_clone = Arc::clone(&self.is_running);
        let stdout_handle = thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut stdout = std::io::stdout();
            while is_running_clone.load(Ordering::SeqCst) {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = sniff_and_warn_destructive(&buf[..n]);
                        let _ = stdout.write_all(&buf[..n]);
                        let _ = stdout.flush();
                    }
                    Err(_) => break,
                }
            }
        });

        // Background thread: read from stdin, sniff input buffer, and write to PTY master (non-blocking)
        let is_running_in = Arc::clone(&self.is_running);
        let _stdin_handle = thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let mut stdin = std::io::stdin();
            while is_running_in.load(Ordering::SeqCst) {
                match stdin.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if sniff_and_warn_destructive(&buf[..n]) {
                            on_background_snapshot();
                        }
                        let _ = writer.write_all(&buf[..n]);
                        let _ = writer.flush();
                    }
                    Err(_) => break,
                }
            }
        });

        // Wait for child process exit
        let status = child.wait().context("Failed to wait for child process")?;
        self.is_running.store(false, Ordering::SeqCst);

        let _ = stdout_handle.join();

        Ok(status.exit_code() as i32)
    }
}
