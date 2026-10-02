# REWIND

```
 ██████╗ ███████╗██╗    ██╗██╗███╗   ██╗██████╗ 
 ██╔══██╗██╔════╝██║    ██║██║████╗  ██║██╔══██╗
 ██████╔╝█████╗  ██║ █╗ ██║██║██╔██╗ ██║██║  ██║
 ██╔══██╗██╔══╝  ██║███╗██║██║██║╚██╗██║██║  ██║
 ██║  ██║███████╗╚███╔███╔╝██║██║ ╚████║██████╔╝
 ╚═╝  ╚═╝╚══════╝ ╚══╝╚══╝ ╚═╝╚═╝  ╚═══╝╚═════╝ 
```

> **The uncrashable flight recorder and transaction-rollback hypervisor for autonomous CLI coding agents.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)

---

## ⚡ The Problem

Autonomous CLI coding agents (**Claude Code, Cursor background agents, Aider, Open Interpreter**) operate with ambient shell write access. Developers frequently experience unrecoverable project loss due to:
* **Rogue subshell commands:** Destructive `rm -rf`, invalid `sed -i` substitutions, or invalid `git reset` commands.
* **Loss of untracked local state:** Accidental modification or deletion of `.env` files, local scratchpads, or SQLite databases.
* **Context drift:** Multi-turn rabbit holes where reverting manually requires untangling dozens of scattered edits.

Standard Docker containers break local toolchains, and `git stash`/worktrees pollute Git history and move `HEAD`.

**Rewind provides an instant, interactive "Ctrl+Z" for the entire project tree — without moving `HEAD`, polluting `git status`, or touching `.git/index`.**

---

## 🛠️ Architecture

```
                                  +------------------------------------+
                                  |    CLI Coding Agent (node-pty)     |
                                  +-----------------+------------------+
                                                    |
                                          Syscall Invocations
                                    (openat, write, unlink, rename)
                                                    |
                 +----------------------------------+----------------------------------+
                 |                                                                     |
                 v                                                                     v
  [eBPF Kernel Hypervisor]                                                    [FUSE Virtual CoW Sandbox]
  src/kernel/bpf_interceptor.c                                                src/core/fuse-sandbox.ts
  - Hooks sys_enter_openat & sys_enter_write                                  - Mount: /tmp/rewind-sandbox/<sessionId>
  - Bounded BPF Hash Map (target_pids)                                        - Read Passthrough from physical disk
  - BPF Ring Buffer (events_ringbuf)                                          - Writes & Unlinks isolated in CAS delta
  - Proactive Graceful Degradation on Darwin                                  - Real disk 100% untouched until approved
                 |                                                                     |
                 v                                                                     v
  +------------------------------------------------------------------------------------+
  |                           Rewind Flight Recorder Daemon                            |
  |                           - ShadowGit (/tmp/rewind-idx-*.tmp)                      |
  |                           - OverlayCAS (.git/rewind/overlay/blobs)                 |
  |                           - SQLite WAL Ledger (.git/rewind/metadata.db)            |
  +------------------------------------------------------------------------------------+
                                                    |
                                    Rollback & Mesh Synchronization
                                                    |
                 +----------------------------------+----------------------------------+
                 |                                                                     |
                 v                                                                     v
  [Zero-Trust P2P CRDT Mesh]                                                  [AI Auto-Reconciliation Engine]
  src/network/mesh.ts                                                         src/ai/explainer.ts
  - Yjs CRDT (Y.Doc, Y.Map: steps, sessions, fileOwners)                      - Analyzes Git diff of undone actions
  - AES-256-GCM wire encryption (12-byte random IV + auth tag)                - Injects corrective prompt into PTY stream
  - High-throughput batching via Y.mergeUpdates                               - Deterministic synthesis fallback
  - Vector-Clock sequence conflict resolution
```

---

## 🚀 Key Features

* **🛡️ Shadow Git Isolation:** Intercepts staging via an ephemeral index (`GIT_INDEX_FILE=/tmp/rewind-idx-*.tmp`). Writes custom tree refs (`refs/rewind/<sessionId>/<stepId>`) directly into the Git object store without moving branch pointers or staging files into the user's `.git/index`.
* **📦 Overlay Content-Addressable Storage (CAS):** Automatically snapshots untracked, Git-ignored configuration files (`.env*`, `local.db`, `schema.prisma`) using two-character SHA-256 sharding with a strict 50MB ceiling to prevent media bloat.
* **⚡ Embedded SQLite WAL Ledger:** Foreign-key linked transaction metadata store operating in WAL mode (`PRAGMA journal_mode = WAL`) with zero contention or locking under rapid file mutation bursts.
* **🖥️ Interactive Terminal Scrubber (TUI):** High-speed terminal UI powered by Ink and React with full keyboard navigation to inspect step diffs and execute pinpoint rollbacks.
* **🔬 eBPF Kernel Hypervisor:** Native C program hooking `sys_enter_openat` and `sys_enter_write` tracepoints with bounded maps and ring buffer streaming. Gracefully degrades to native Sentinel watching on non-Linux or header-less hosts with zero panics.
* **🧱 FUSE Copy-on-Write Sandbox:** Virtual overlay mounted at `/tmp/rewind-sandbox/` shielding physical disks from destructive commands (`rm -rf`) until explicitly approved.
* **🌐 Zero-Trust P2P CRDT Mesh:** Synchronizes distributed developer sessions across local networks via AES-256-GCM encrypted WebSockets with vector-clock conflict resolution.
* **🧠 LLM Context Auto-Reconciliation:** Formats diffs of undone steps and injects corrective guidance directly into the agent's PTY input stream to prevent hallucinated assumptions after rollbacks.

---

## 📦 Installation & Quickstart

```bash
# Clone the repository
git clone https://github.com/Shlok04423/rewind.git
cd rewind

# Install dependencies and build
npm install
npm run build

# Link CLI globally (optional)
npm link
```

---

## 💻 CLI Commands

### 1. Wrap an AI Agent
Run any CLI coding agent inside the Rewind flight recorder:
```bash
rewind run claude
rewind run aider
rewind claude --dangerously-skip-permissions
```

### 2. Transaction Rollback
Revert the working tree by N steps (restores code and CAS `.env` files):
```bash
rewind undo 1
rewind undo 5 --force
```

### 3. Launch Interactive Scrubber (TUI)
Visually scrub through checkpoints and inspect diffs:
```bash
rewind ui
```

### 4. Flight Status
Check active flight session, branch, and CAS storage:
```bash
rewind status
```

### 5. P2P Mesh Network
Start a distributed CRDT synchronization node:
```bash
rewind mesh start --port 9001 --key <shared-key> [--peer ws://127.0.0.1:9002]
rewind mesh status
```

---

## 📄 License

MIT License. Designed and engineered for high-assurance autonomous coding.