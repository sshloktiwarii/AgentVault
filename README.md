# REWIND V2

```
 ██████╗ ███████╗██╗    ██╗██╗███╗   ██╗██████╗ 
 ██╔══██╗██╔════╝██║    ██║██║████╗  ██║██╔══██╗
 ██████╔╝█████╗  ██║ █╗ ██║██║██╔██╗ ██║██║  ██║
 ██╔══██╗██╔══╝  ██║███╗██║██║██║╚██╗██║██║  ██║
 ██║  ██║███████╗╚███╔███╔╝██║██║ ╚████║██████╔╝
 ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═════╝ 
```

> **The ultra-fast, uncrashable flight recorder and transaction layer for autonomous AI coding agents.**
> Re-architected in pure, memory-safe Rust for zero-latency execution, atomic rollbacks, and ironclad blast-radius isolation.

> 📖 **New to Rewind?** Check out the [Plain-English Beginner's Guide (README.simple.md)](./README.simple.md) for an intuitive introduction.
> 🔍 **Deep Architecture:** Review the [Architectural Autopsy (ARCHITECTURAL_AUTOPSY.md)](./ARCHITECTURAL_AUTOPSY.md) and [System Specification PRD (REWIND_SYSTEM_SPEC_PRD.md)](./REWIND_SYSTEM_SPEC_PRD.md).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Rust](https://img.shields.io/badge/Rust-1.80%2B-orange.svg)](https://www.rust-lang.org/)
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux%20%7C%20Windows-blue.svg)](https://github.com/Shlok04423/rewind)
[![Tests](https://img.shields.io/badge/Chaos%20Suite-4%2F4%20Passing-brightgreen.svg)](tests/chaos_suite.rs)

---

## ⚡ Why Rewind V2?

Autonomous CLI coding agents (**Claude Code, Cursor background agents, Aider, Codex, Open Interpreter**) execute shell commands with ambient write access. A single rogue command or hallucinated edit can destroy an entire codebase:

* **Rogue subshell commands:** Destructive `rm -rf`, malformed `sed -i` substitutions, or truncated source trees.
* **Loss of untracked secrets:** Accidental overwrites or deletion of `.env`, `.pem`, or local SQLite databases.
* **The 250ms Debounce Blindspot:** Autonomous agents emit rapid write bursts; asynchronous debouncers fail to capture snapshots before sudden exits or crashes.
* **Monorepo Stat Thrashing:** Traditional tools walk the entire filesystem using `git add --all`, causing 300ms–1.5s lag spikes.
* **The `.git/` Blast Radius:** Backups placed inside `.git/` are obliterated if an agent executes `rm -rf .git`.

**Rewind V2 fixes all 5 architectural failure modes with a production-grade, zero-dependency Rust engine.**

---

## 🛡️ The 5 Solved Architectural Flaws

| V1 Flaw | V1 Failure Mode | V2 Production Rust Solution |
| :--- | :--- | :--- |
| **1. Debounced Race Condition** | 250ms asynchronous quiet-window lost pre-destruction state during write bursts | **Synchronous Pre-Tool Hook (`POST /api/v1/checkpoint/pre-flight`)** blocks execution until snapshot is committed. Includes zero-overhead PTY stream sniffing for destructive commands (`rm -rf`, `sed -i`, `truncate`). |
| **2. Monorepo Stat Latency** | `git add --all` forced full filesystem stat walks taking 300ms–1.5s on 50k files | **In-Memory `IncrementalIndex`** updated via native OS events (`notify`: FSEvents, inotify, ReadDirectoryChangesW). Delta hashes 10,000 files in **6.56ms**. |
| **3. `.git/` Blast Radius** | State stored in `.git/rewind/`; `rm -rf .git` wiped recovery safety net | **Out-of-Band Global Store** in `~/.cache/rewind/stores/<blake3-repo-hash>/`. Even if `.git` is completely deleted, full state & CAS files are safely restored. |
| **4. Unbounded CAS Disk Bomb** | Continuous snapshots bloated disk storage without ceilings or eviction | **Deterministic LRU Eviction Engine** with configurable budget (e.g. 5GB ceiling), transparent **LZ4 compression**, and automatic background `rewind gc`. |
| **5. Native Dependency Friction** | `node-pty` / `node-gyp` C++ compilation frequently crashed on Windows | **Pure Rust Static Compilation** using `portable-pty`, bundled `libgit2`, and bundled `rusqlite` for zero-dependency cross-platform distribution. |

---

## 🏛️ V2 System Architecture

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
 Blocks agent until committed                              Regex scan: rm -rf, sed -i, truncate
         |                                                         |
         +----------------------------+----------------------------+
                                      |
                                      v
                    +------------------------------------+
                    |        RewindEngine (Rust)         |
                    +-----------------+------------------+
                                      |
                   +------------------+------------------+
                   |                                     |
                   v                                     v
       [IncrementalIndex Daemon]                [Global Out-of-Band Store]
       - notify OS File Watcher                 ~/.cache/rewind/stores/<hash>/
       - In-memory BTreeMap VFS                 ├── metadata.db (SQLite WAL)
       - Sub-10ms delta detection               └── cas_objects/ (LZ4 compressed)
                   |                                     |
                   v                                     v
       [Direct libgit2 ODB Writer]              [Conflict Matrix & GC]
       - Writes Blobs & Trees directly          - Blake3 pre-rollback safety lock
       - refs/rewind/<session>/HEAD             - COMPENSATION_PRE_ROLLBACK
       - Zero index lock contention             - LRU Eviction when size > budget
```

---

## 📦 Installation & Build

### Prerequisites
* Rust toolchain 1.80+ (`curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`)

### Build from Source
```bash
# Clone the repository
git clone https://github.com/Shlok04423/rewind.git
cd rewind

# Build optimized release binary
cargo build --release

# Install locally to $HOME/.cargo/bin
cargo install --path .
```

The resulting binary `rewind` is completely self-contained with **zero external shared-library dependencies**.

---

## 💻 CLI Commands

### 1. Wrap an Agent with Transparent Flight Recording
Spawns the agent inside a dedicated PTY with real-time stream sniffing and snapshot isolation:
```bash
rewind run claude
rewind run aider --model sonnet
rewind run bash
```

### 2. Manual or Pre-Tool Checkpoint
Takes an instantaneous sub-10ms snapshot of all modified tracked files and whitelisted sensitive files:
```bash
rewind checkpoint --trigger MANUAL
rewind checkpoint --trigger PRE_HOOK
```

### 3. Atomic Transaction Rollback
Safely reverts the repository by N steps. Checks the pre-flight conflict matrix to prevent overwriting human edits, and takes a `COMPENSATION_PRE_ROLLBACK` checkpoint for complete undoability:
```bash
# Revert the last step
rewind undo 1

# Revert 3 steps, overriding safety conflict warnings if desired
rewind undo 3 --force
```

### 4. Inspect Flight Recorder Status
Inspect the current session, checkpoint count, and CAS storage metrics:
```bash
rewind status
```

### 5. Deterministic Garbage Collection
Prune oldest CAS blobs until usage drops below 80% of the maximum budget (default: 5000 MB):
```bash
# Run GC with default 5GB limit
rewind gc

# Run GC with custom limit
rewind gc --max-mb 2000
```

### 6. Synchronous Pre-Flight Hook Daemon
Run the HTTP hook listener for agent extensions (Claude Code, Cursor, MCP):
```bash
rewind serve-hooks --port 7394
```
Agents call `POST http://127.0.0.1:7394/api/v1/checkpoint/pre-flight` before executing tools; the call blocks synchronously until the snapshot transaction commits.

---

## 🧪 Chaos Test Suite

Rewind V2 includes an exhaustive integration chaos test suite (`tests/chaos_suite.rs`) verifying each architectural guarantee:

```bash
cargo test --test chaos_suite
```

### Test Results
* ✅ **`test_rm_rf_git_survival`:** Verified that deleting `.git` does not destroy recovery data; out-of-band store successfully restored `.env` and project files.
* ✅ **`test_10k_file_delta_speed`:** Verified incremental inode index speed; computed delta across 10,000 files in **6.56ms** (well under the 50ms budget).
* ✅ **`test_pre_tool_hook_race`:** Verified synchronous hook blocking during 50 rapid write bursts, preventing data loss from destructive commands.
* ✅ **`test_disk_bomb_gc`:** Verified deterministic LRU eviction; pruned 15MB of compressed blobs down to $\le 80\%$ budget ceiling.

---

## 📁 Repository Structure

```
├── Cargo.toml                  # Rust dependencies (git2, rusqlite, notify, blake3, axum)
├── ARCHITECTURAL_AUTOPSY.md    # In-depth breakdown of V1 flaws and V2 solutions
├── REWIND_SYSTEM_SPEC_PRD.md   # Complete system specification and PRD
├── src/
│   ├── main.rs                 # CLI entrypoint and command routing
│   ├── lib.rs                  # RewindEngine core transaction coordinator
│   ├── cas/                    # Content-Addressable Storage (Blake3, LZ4, LRU GC)
│   ├── daemon/                 # IncrementalIndex & notify OS event loop
│   ├── db/                     # SQLite WAL ledger & transactional schema
│   ├── git/                    # Direct libgit2 ODB tree/commit writers
│   ├── pty/                    # portable-pty wrapper & regex stream sniffer
│   ├── safety/                 # Pre-flight conflict matrix & compensation snapshots
│   ├── server/                 # Axum HTTP pre-tool interception daemon
│   └── cli/                    # Clap command line argument definitions
├── tests/
│   └── chaos_suite.rs          # 4-stage hostile chaos test suite
└── v1/                         # Archived Node.js/TypeScript research prototype
```

---

## 📄 License

MIT License. Designed and engineered for high-assurance autonomous coding.