# AGENTVAULT V4

```
 █████╗  ██████╗ ███████╗███╗   ██╗████████╗██╗   ██╗ █████╗ ██╗   ██╗██╗  ████████╗
██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝██║   ██║██╔══██╗██║   ██║██║  ╚══██╔══╝
███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ██║   ██║███████║██║   ██║██║     ██║   
██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ╚██╗ ██╔╝██╔══██║██║   ██║██║     ██║   
██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║    ╚████╔╝ ██║  ██║╚██████╔╝███████╗██║   
╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝     ╚═══╝  ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝   
```

> **The ultra-fast, uncrashable flight recorder and transaction layer for autonomous AI coding agents.**
> Re-architected in pure, memory-safe Rust with persistent OS application data isolation, Reachability GC, Zstandard streaming compression, and native VSCode IDE timeline integration.

> 📖 **New to AgentVault?** Check out the [Plain-English Beginner's Guide (README.simple.md)](./README.simple.md) for an intuitive introduction.


[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange.svg)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue.svg)](https://github.com/sshloktiwarii/AgentVault)
[![CI](https://github.com/sshloktiwarii/AgentVault/actions/workflows/ci.yml/badge.svg)](https://github.com/sshloktiwarii/AgentVault/actions/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/Test%20Suite-8%2F8%20Passing-brightgreen.svg)](tests/)


---

## ⚡ Why AgentVault V4?

Autonomous CLI coding agents (**Claude Code, Cursor background agents, Aider, Codex, Open Interpreter**) execute shell commands with ambient write access. A single rogue command or hallucinated edit can destroy an entire codebase:

* **Rogue subshell commands:** Destructive `rm -rf`, malformed `sed -i` substitutions, or truncated source trees.
* **Loss of untracked secrets:** Accidental overwrites or deletion of `.env`, `.pem`, or local SQLite databases.
* **The 250ms Debounce Blindspot:** Autonomous agents emit rapid write bursts; asynchronous debouncers fail to capture snapshots before sudden exits or crashes.
* **Monorepo Stat Thrashing:** Traditional tools walk the entire filesystem using `git add --all`, causing 300ms–1.5s lag spikes.
* **The Storage Cache Trap:** Storing recovery ledgers in `~/.cache` leaves backups vulnerable to silent OS disk cleanups (macOS Storage Optimizer, `systemd-tmpfiles`).
* **The Repo Identity Crisis:** Folder renames orphan backups when storage is indexed merely by path strings.

**AgentVault V4 fixes all critical failure modes with an immutable root-commit identity, persistent OS storage, streaming Zstandard compression, Reachability GC, and native IDE integration.**

---

## 🛡️ Architectural Evolutions (V3 → V4)

| Flaw / Risk | Latent Failure Mode | AgentVault V4 Production Solution |
| :--- | :--- | :--- |
| **Trademark Liability & Security** | Previous names collided with active trademarks or documented NTFS evasion malware | **Global Migration to AgentVault** across binary, crates, VSCode extension, and out-of-band references (`refs/agentvault/...`). |
| **Storage Death Trap** | `~/.cache` was silently purged by OS temp sweepers, causing data loss | **Persistent OS App Data Directory** (`directories::ProjectDirs::data_local_dir()`, e.g., `~/Library/Application Support/com.AgentVault.AgentVault/` or `~/.local/share/AgentVault/`). |
| **Repo Identity Crisis** | Renaming project directories permanently orphaned flight recorder backups | **Root-Commit Identity Derivation** (`git::derive_repo_identity`) hashes the root commit OID via `blake3`, keeping backups permanently attached. Handles zero-commit repos and shallow clones. |
| **LRU Data Corruption** | LRU evicted untouched `.env` files still referenced by older valid checkpoints | **SQLite Reference-Counting & Reachability GC** (`ref_count` triggers on `cas_manifest` cascade; only orphaned blobs with `ref_count <= 0` are physically unlinked with `std::fs::remove_file`). |
| **Crash Trigger Drift** | Ungraceful crashes during transactions could drift trigger counters | **Startup Reconciliation Engine** (`reconcile_ref_counts`) recalculates ground-truth reference counts directly from manifests upon boot. |
| **Suboptimal Compression** | Uncompressed buffers wasted disk storage for text-heavy source code and `.env` files | **Mandatory Level 3 Zstandard (`zstd::stream::Encoder`) Streaming Compression** balancing maximum compression ratios with microsecond throughput. |
| **PTY Sniffer Blocking** | Regex matching on terminal streams was bypassed by ANSI codes and risked blocking | **ANSI-Stripping Decoupled Warning Logger** using `strip-ansi-escapes` and non-blocking `tracing::warn!`. |
| **IDE Friction** | CLI-only tools require context switching away from VSCode / Cursor | **Native VSCode Extension (`vscode-extension/`)** implementing a custom `vscode.TimelineProvider` with one-click checkpoint rollback. |
| **Source Compilation** | Users had to install the Rust toolchain and compile locally | **Automated Multi-Arch CI/CD Matrix (`.github/workflows/release.yml`)** building native binaries for 5 OS architectures and VSIX packages on tag releases. |

---

## 🏛️ V4 System Architecture

```
                    +------------------------------------+
                    |    Autonomous Coding Agent         |
                    | (Claude Code, Cursor, Aider, CLI)  |
                    +-----------------+------------------+
                                      |
                     [PreToolUse / PTY Shell Stream]
                                      |
         +----------------------------+----------------------------+
         |                                                         |
         v                                                         v
 [Pre-Flight HTTP Server]                                  [PTY Sniffer Master]
 POST /api/v1/checkpoint/pre-flight                        portable-pty session master
 Blocks agent until committed                              ANSI-stripped non-blocking warning
         |                                                         |
         +----------------------------+----------------------------+
                                      |
                                      v
                    +------------------------------------+
                    |      AgentVaultEngine (Rust)       |
                    +-----------------+------------------+
                                      |
                   +------------------+------------------+
                   |                                     |
                   v                                     v
       [IncrementalIndex Daemon]                [Persistent Storage Store]
       - notify OS File Watcher                 com.AgentVault.AgentVault/stores/
       - In-memory BTreeMap VFS                 ├── metadata.db (SQLite WAL + Triggers)
       - Sub-10ms delta detection               └── cas_objects/ (zstd Level 3 Stream)
                   |                                     |
                   v                                     v
       [Direct libgit2 ODB Writer]              [Reachability GC Engine]
       - Writes Blobs & Trees directly          - SQLite triggers on cas_manifest
       - refs/agentvault/<session>/HEAD         - ref_count tracking on cas_blobs
       - Zero index lock contention             - Auto-reconciles trigger drift
```

---

## 📦 Installation & Build

### Option 1: Pre-Compiled Binary
Download the pre-compiled binary for your architecture from the [GitHub Releases](https://github.com/sshloktiwarii/agentvault/releases).

### Option 2: Build from Source
```bash
# Clone the repository
git clone https://github.com/sshloktiwarii/agentvault.git
cd agentvault

# Build optimized release binary
cargo build --release

# Install locally to $HOME/.cargo/bin
cargo install --path .
```

---

## 💻 CLI Commands

### 1. Wrap an Agent with Flight Recording
```bash
agentvault run claude
agentvault run aider --model sonnet
agentvault run bash
```

### 2. Atomic Transaction Rollback
```bash
# Revert the last checkpoint (1 step)
agentvault undo 1

# Revert to specific Checkpoint ID with forced override
agentvault undo 5 --force
```

### 3. Flight Status (Human-Readable & JSON)
```bash
# Standard status dashboard
agentvault status

# Machine-readable JSON output (used by VSCode extension)
agentvault status --json
```

### 4. Reachability Garbage Collection
```bash
# Run Reachability GC with default 5GB ceiling
agentvault gc

# Run GC with custom limit (in Megabytes)
agentvault gc --max-mb 2000
```

### 5. Synchronous Pre-Flight Hook Daemon
```bash
agentvault serve-hooks --port 4040
```

---

## 🔌 VSCode & Cursor Extension

AgentVault includes a first-party TypeScript extension providing a native Timeline UI in VSCode and Cursor:

1. Open `vscode-extension/` in your IDE.
2. Run `npm install && npm run compile`.
3. Package with `npm run package` to generate `agentvault-vscode.vsix`.
4. Open the **Timeline** view in the Explorer panel to inspect AgentVault checkpoints in real time.
5. Click any checkpoint to trigger atomic rollback with an interactive confirmation prompt.

---

## 🧪 Chaos & Verification Test Suite

AgentVault V4 includes an exhaustive chaos integration test suite:

```bash
cargo test
```

### Verification Results
* ✅ **`test_rm_rf_git_survival`:** Verified that deleting `.git` leaves recovery data unharmed in persistent OS application directories; `.env` restored bit-for-bit.
* ✅ **`test_10k_file_delta_speed`:** In-memory incremental inode index computed deltas across 10,000 files in **6.56ms** (<50ms budget).
* ✅ **`test_pre_tool_hook_race`:** Synchronous pre-flight hook blocked execution during 50 rapid write bursts, preventing data loss from destructive commands.
* ✅ **`test_reachability_gc`:** Verified reference-counting SQLite triggers; reachability GC pruned oldest checkpoints and unreferenced blobs below budget ceiling.
* ✅ **`test_reconcile_trigger_drift`:** Verified startup reconciliation heals trigger drift induced by crash interruptions.
* ✅ **`test_repo_identity_derivation`:** Verified immutable root commit hashing, shallow clone warnings, and uncommitted path hashing fallback.
* ✅ **`test_pty_sniff_ansi_destructive_detection`:** Verified non-blocking ANSI-stripped detection of destructive commands.
* ✅ **`test_rollback_to_checkpoint_id`:** Verified direct rollback to arbitrary checkpoint IDs.

---

## 📁 Repository Structure

```
├── Cargo.toml                  # Rust manifest (agentvault v4.0.0)
├── README.simple.md            # Plain-English beginner's guide
├── src/
│   ├── main.rs                 # CLI entrypoint and command routing
│   ├── lib.rs                  # AgentVaultEngine core coordinator
│   ├── config/                 # Persistent ProjectDirs resolution & storage paths
│   ├── cas/                    # Content-Addressable Storage (zstd, Reachability GC)
│   ├── daemon/                 # IncrementalIndex & notify OS event loop
│   ├── db/                     # SQLite WAL ledger, triggers & ref_count schema
│   ├── git/                    # Direct libgit2 ODB writers & root-commit identity
│   ├── pty/                    # portable-pty wrapper & ANSI-stripped stream sniffer
│   ├── safety/                 # Pre-flight conflict matrix & compensation snapshots
│   ├── server/                 # Axum HTTP pre-tool interception daemon
│   └── cli/                    # Clap subcommand definitions
├── tests/
│   ├── chaos_suite.rs          # 4-stage hostile chaos test suite
│   └── v4_production_suite.rs  # V4 architecture verification suite
├── vscode-extension/           # Native VSCode TimelineProvider extension
└── .github/workflows/
    └── release.yml             # 5-architecture cross-compilation & VSIX release matrix
```

---

## 📄 License

MIT License. Designed and engineered for high-assurance autonomous coding.