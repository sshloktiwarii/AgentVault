use clap::{Parser, Subcommand};

#[derive(Parser, Debug)]
#[command(
    name = "agentvault",
    version = "4.0.0",
    about = "AgentVault V4: Production-grade local-first transaction layer & flight recorder for autonomous AI coding agents"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Run an AI coding agent inside the AgentVault flight recorder
    Run {
        /// Target agent CLI executable and arguments
        #[arg(trailing_var_arg = true, required = true)]
        command: Vec<String>,

        /// Allow destructive operations without prompting
        #[arg(long)]
        dangerously_skip_permissions: bool,
    },

    /// Shortcut for: agentvault run claude [args...]
    Claude {
        #[arg(trailing_var_arg = true)]
        args: Vec<String>,
    },

    /// Shortcut for: agentvault run aider [args...]
    Aider {
        #[arg(trailing_var_arg = true)]
        args: Vec<String>,
    },

    /// Revert the repository working tree by N checkpoints or to a specific Checkpoint ID
    Undo {
        /// Number of checkpoints to revert (default: 1) or target Checkpoint ID
        #[arg(default_value_t = 1)]
        target: i64,

        /// Force rollback even if uncommitted manual human edits are detected
        #[arg(short, long)]
        force: bool,
    },

    /// Run reachability garbage collection to prune orphaned CAS blobs
    Gc {
        /// Max storage ceiling in Megabytes (default: 5000 MB)
        #[arg(long)]
        max_mb: Option<u64>,
    },

    /// Display flight recorder status, storage consumption, and active session
    Status {
        /// Output status and checkpoints as JSON (for IDE and VSCode extensions)
        #[arg(long)]
        json: bool,
    },

    /// Start the synchronous PreToolUse HTTP hook server for agents
    ServeHooks {
        /// Port to bind the HTTP hook server to
        #[arg(short, long, default_value_t = 4040)]
        port: u16,
    },

    /// Launch interactive terminal flight scrubber
    Ui,
}
