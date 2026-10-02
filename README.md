# GHOSTBRANCH V3

```
  ██████╗ ██╗  ██╗ ██████╗ ███████╗████████╗██████╗ ██████╗  █████╗ ███╗   ██╗ ██████╗██╗  ██╗
 ██╔════╝ ██║  ██║██╔═══██╗██╔════╝╚══██╔══╝██╔══██╗██╔══██╗██╔══██╗████╗  ██║██╔════╝██║  ██║
 ██║  ███╗███████║██║   ██║███████╗   ██║   ██████╔╝██████╔╝███████║██╔██╗ ██║██║     ███████║
 ██║   ██║██╔══██║██║   ██║╚════██║   ██║   ██╔══██╗██╔══██╗██╔══██║██║╚██╗██║██║     ██╔══██║
 ╚██████╔╝██║  ██║╚██████╔╝███████║   ██║   ██████╔╝██║  ██║██║  ██║██║ ╚████║╚██████╗██║  ██║
  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝   ╚═╝   ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝╚═╝  ╚═╝
```

> **The ultra-fast, uncrashable flight recorder and transaction layer for autonomous AI coding agents.**
> Re-architected in pure, memory-safe Rust with persistent OS application data isolation, Reachability GC, Zstandard compression, and native VSCode IDE timeline integration.

> 📖 **New to GhostBranch?** Check out the [Plain-English Beginner's Guide (README.simple.md)](./README.simple.md) for an intuitive introduction.
> 🔍 **Deep Architecture:** Review the [Architectural Autopsy (ARCHITECTURAL_AUTOPSY.md)](./ARCHITECTURAL_AUTOPSY.md) and [System Specification PRD (REWIND_SYSTEM_SPEC_PRD.md)](./REWIND_SYSTEM_SPEC_PRD.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange.svg)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue.svg)](https://github.com/Shlok04423/ghostbranch)
[![Tests](https://img.shields.io/badge/Chaos%20Suite-4%2F4%20Passing-brightgreen.svg)](tests/chaos_suite.rs)

---

## ⚡ Why GhostBranch V3?

Autonomous CLI coding agents (**Claude Code, Cursor background agents, Aider, Codex, Open Interpreter**) execute shell commands with ambient write access. A single rogue command or hallucinated edit can destroy an entire codebase:

* **Rogue subshell commands:** Destructive `rm -rf`, malformed `sed -i` substitutions, or truncated source trees.
* **Loss of untracked secrets:** Accidental overwrites or deletion of `.env`, `.pem`, or local SQLite databases.
* **The 250ms Debounce Blindspot:** Autonomous agents emit rapid write bursts; asynchronous debouncers fail to capture snapshots before sudden exits or crashes.
* **Monorepo Stat Thrashing:** Traditional tools walk the entire filesystem using `git add --all`, causing 300ms–1.5s lag spikes.
* **The Storage Cache Trap:** Storing recovery ledgers in `~/.cache` leaves backups vulnerable to silent OS disk cleanups (macOS Storage Optimizer, `systemd-tmpfiles`).
* **The Repo Identity Crisis:** Folder renames orphan backups when storage is indexed merely by path strings.

**GhostBranch V3 fixes all critical failure modes with an immutable root-commit identity, persistent OS storage, Zstandard compression, Reachability GC, and native IDE integration.**

---

## 🛡️ Architectural Evolutions (V2 → V3)

| Flaw / Risk | Latent Failure Mode | GhostBranch V3 Production Solution |
| :--- | :--- | :--- |
| **Storage Death Trap** | `~/.cache` was silently purged by OS temp sweepers, causing data loss | **Persistent OS App Data Directory** (`directories::ProjectDirs::data_local_dir()`, e.g., `~/Library/Application Support/com.GhostBranch.GhostBranch/` or `~/.local/share/GhostBranch/`). |
| **Repo Identity Crisis** | Renaming project directories permanently orphaned flight recorder backups | **Root-Commit Identity Derivation** (`git::derive_repo_identity`) hashes the root commit OID via `blake3`, keeping backups permanently attached. |
| **LRU Data Corruption** | LRU evicted untouched `.env` files still referenced by older valid checkpoints | **SQLite Reference-Counting & Reachability GC** (`ref_count` triggers on `cas_manifest` cascade; only orphaned blobs with `ref_count <= 0` are deleted). |
| **Suboptimal Compression** | `lz4_flex` wasted disk storage for text-heavy source code and `.env` files | **Mandatory Level 3 Zstandard (`zstd`) Streaming Compression** balancing maximum compression ratios with zero-overhead read/write speeds. |
| **PTY Sniffer Blocking** | Regex matching on terminal streams was bypassed by ANSI codes and risked blocking | **ANSI-Stripping Decoupled Warning Logger** using `strip-ansi-escapes` and non-blocking `tracing::warn!`. |
| **IDE Friction** | CLI-only tools require context switching away from VSCode / Cursor | **Native VSCode Extension (`vscode-extension/`)** implementing a custom `vscode.TimelineProvider` with one-click checkpoint rollback. |
| **Source Compilation** | Users had to install the Rust toolchain and compile locally | **Automated Multi-Arch CI/CD Matrix** building native binaries for 5 OS architectures on tag releases. |

---

## 🏛️ V3 System Architecture

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
                    |     GhostBranchEngine (Rust)       |
                    +-----------------+------------------+
                                      |
                   +------------------+------------------+
                   |                                     |
                   v                                     v
       [IncrementalIndex Daemon]                [Persistent Storage Store]
       - notify OS File Watcher                 com.GhostBranch.GhostBranch/stores/
       - In-memory BTreeMap VFS                 ├── metadata.db (SQLite WAL + Triggers)
       - Sub-10ms delta detection               └── cas_objects/ (zstd Level 3)
                   |                                     |
                   v                                     v
       [Direct libgit2 ODB Writer]              [Reachability GC Engine]
       - Writes Blobs & Trees directly          - SQLite triggers on cas_manifest
       - refs/ghostbranch/<session>/HEAD        - ref_count tracking on cas_blobs
       - Zero index lock contention             - Auto-prunes orphaned blobs <= 0
```

---

## 📦 Installation & Build

### Option 1: Pre-Compiled Binary
Download the pre-compiled binary for your architecture from the [GitHub Releases](https://github.com/Shlok04423/ghostbranch/releases).

### Option 2: Build from Source
```bash
# Clone the repository
git clone https://github.com/Shlok04423/ghostbranch.git
cd ghostbranch

# Build optimized release binary
cargo build --release

# Install locally to $HOME/.cargo/bin
cargo install --path .
```

---

## 💻 CLI Commands

### 1. Wrap an Agent with Flight Recording
```bash
ghostbranch run claude
ghostbranch run aider --model sonnet
ghostbranch run bash
```

### 2. Manual or Pre-Tool Checkpoint
```bash
ghostbranch checkpoint --trigger MANUAL
ghostbranch checkpoint --trigger PRE_HOOK
```

### 3. Atomic Transaction Rollback
```bash
# Revert the last checkpoint
ghostbranch undo 1

# Revert 3 checkpoints with forced override
ghostbranch undo 3 --force
```

### 4. Flight Status (Human-Readable & JSON)
```bash
# Standard status dashboard
ghostbranch status

# Machine-readable JSON output (used by VSCode extension)
ghostbranch status --json
```

### 5. Reachability Garbage Collection
```bash
# Run Reachability GC with default 5GB ceiling
ghostbranch gc

# Run GC with custom limit
ghostbranch gc --max-mb 2000
```

### 6. Synchronous Pre-Flight Hook Daemon
```bash
ghostbranch serve-hooks --port 7394
```

---

## 🔌 VSCode & Cursor Extension

GhostBranch includes a first-party TypeScript extension providing a native Timeline UI in VSCode and Cursor:

1. Open `vscode-extension/` in your IDE.
2. Run `npm install && npm run compile`.
3. Open the **Timeline** view in the Explorer panel to inspect GhostBranch checkpoints in real time.
4. Click any checkpoint to trigger atomic rollback with an interactive confirmation prompt.

---

## 🧪 Chaos Test Suite

GhostBranch V3 includes an exhaustive chaos integration test suite (`tests/chaos_suite.rs`):

```bash
cargo test --test chaos_suite
```

### Verification Results
* ✅ **`test_rm_rf_git_survival`:** Verified that deleting `.git` leaves recovery data unharmed in persistent OS application directories; `.env` restored bit-for-bit.
* ✅ **`test_10k_file_delta_speed`:** In-memory incremental inode index computed deltas across 10,000 files in **6.56ms** (<50ms budget).
* ✅ **`test_pre_tool_hook_race`:** Synchronous pre-flight hook blocked execution during 50 rapid write bursts, preventing data loss from destructive commands.
* ✅ **`test_reachability_gc`:** Verified reference-counting SQLite triggers; reachability GC pruned oldest checkpoints and unreferenced blobs below budget ceiling.

---

## 📁 Repository Structure

```
├── Cargo.toml                  # Rust manifest (ghostbranch v3.0.0)
├── ARCHITECTURAL_AUTOPSY.md    # Autopsy of V1/V2 flaws and V3 solutions
├── REWIND_SYSTEM_SPEC_PRD.md   # Complete system specification
├── src/
│   ├── main.rs                 # CLI entrypoint and command routing
│   ├── lib.rs                  # GhostBranchEngine core coordinator
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
│   └── chaos_suite.rs          # 4-stage hostile chaos test suite
├── vscode-extension/           # Native VSCode TimelineProvider extension
└── .github/workflows/
    └── release.yml             # 5-architecture cross-compilation release matrix
```

---

## 📄 License

MIT License. Designed and engineered for high-assurance autonomous coding.