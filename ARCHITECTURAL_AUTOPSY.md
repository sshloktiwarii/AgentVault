# GhostBranch: Architectural Autopsy & Evolution Matrix (V1 → V2 → V3)

> **Permanent Record of Known Architectural Bottlenecks, Vulnerabilities, and Production Engineering Solutions.**  
> *Logged on: October 2, 2026*

---

## 1. The Debounced Race Condition (The 250ms Blind Spot)

* **Severity:** 🔴 **Critical**
* **V1 Problem:** The architecture relied on a 250ms quiet-window debounce to trigger snapshots. Autonomous agents emit write bursts, subshell loops, and batch edits continuously.
* **Failure Mode / Explanation:** If an agent executes a destructive command (`rm -rf` or a bad `sed -i`) during an active write burst, the debounce timer keeps resetting. If the process exits or crashes before that quiet window finally expires, the pre-destruction snapshot is never written, completely missing the critical recovery window.
* **GhostBranch V3 Solution:** Synchronous pre-tool interception hooks (`POST /api/v1/checkpoint/pre-flight` for Claude/Cursor/Codex/MCP) force an immediate snapshot the exact millisecond a shell command or write tool is dispatched, blocking execution until committed.

---

## 2. The Monorepo Stat-Cache / Latency Illusion

* **Severity:** 🟠 **High**
* **V1 Problem:** The spec claimed sub-15ms performance via `git add --all` against an ephemeral index.
* **Failure Mode / Explanation:** In a real repository with `node_modules`, build artifacts, or deep asset directories (50,000+ files), `git add` forces a full filesystem stat walk. Without a persistent caching daemon tracking directory inode changes via OS native hooks, snapshot latency balloons to 300ms–1.5s, shattering the real-time guarantee.
* **GhostBranch V3 Solution:** Completely dropped raw `git add --all` re-indexing loops. Maintained an in-memory `IncrementalIndex` mapping file modification times (`mtimes`), inodes, and sizes via `notify` OS events (FSEvents/inotify/ReadDirectoryChangesW). Delta calculation completes in **6.56ms** across 10,000 files.

---

## 3. Storage Death Trap & Repo Identity Crisis

* **Severity:** 🔴 **Critical**
* **V2 Problem:** Storing shadow ledgers and CAS blobs in `~/.cache/rewind/stores/<path-hash>`.
* **Failure Mode / Explanation:** Operating systems (macOS Storage Optimizer, Linux `systemd-tmpfiles`) silently wipe `~/.cache` when storage runs low, destroying user backups without warning. Furthermore, hashing the absolute path meant that renaming the project folder orphaned all previous recovery checkpoints.
* **GhostBranch V3 Solution:** 
  1. Migrated storage to persistent OS Application Data paths using `directories::ProjectDirs::data_local_dir()` (`com.GhostBranch.GhostBranch/stores/`).
  2. Implemented `git::derive_repo_identity()` which walks the commit graph to find the immutable root commit OID and hashes it via `blake3`. Renaming folders preserves 100% of backup history.

---

## 4. Reachability GC & Zstandard Compression

* **Severity:** 🟠 **High**
* **V2 Problem:** LRU eviction deleted oldest blobs even if they were still referenced by valid earlier checkpoints (e.g. untouched `.env` files). `lz4_flex` compression was suboptimal for text code.
* **Failure Mode / Explanation:** LRU created dangling pointers in `cas_manifest`, corrupting older rollback targets.
* **GhostBranch V3 Solution:**
  1. Added `ref_count` column and SQLite triggers on `cas_manifest` (`AFTER INSERT` and `AFTER DELETE`) to mathematically track active references.
  2. Implemented Reachability GC (`run_reachability_gc`): evicts oldest checkpoints when storage exceeds budget, triggering cascade decrements, and unlinks physical files only when `ref_count <= 0`.
  3. Integrated Level 3 Zstandard (`zstd`) streaming compression for optimal compression speed and ratio.

---

## 5. PTY Stream Sniffing Decoupling & Safety

* **Severity:** 🟡 **Medium**
* **V2 Problem:** Blocking execution or sending SIGINT from regex checks on raw PTY terminal buffers caused false positives and was bypassed by ANSI escape sequences.
* **GhostBranch V3 Solution:** Filter terminal buffers through `strip_ansi_escapes::strip()` and emit non-blocking `tracing::warn!` alerts. Execution blocking is strictly handled by the synchronous pre-flight hook.

---

## 6. IDE Integration & Multi-Arch Distribution

* **Severity:** 🟡 **Medium**
* **V2 Problem:** Requiring terminal-only operation created friction for VSCode/Cursor developers, and lack of pre-compiled binaries created compilation overhead.
* **GhostBranch V3 Solution:**
  1. Built native TypeScript VSCode Extension (`vscode-extension/`) implementing a custom `vscode.TimelineProvider` with visual rollback.
  2. Built GitHub Actions CI/CD matrix compiling native binaries across Linux (musl x86_64, aarch64), macOS (Intel, Apple Silicon), and Windows.

---

### Implementation Status Matrix

| ID | Issue | Severity | Status | Architecture Phase |
|---|---|---|---|---|
| `AUTOPSY-01` | Debounced Race Condition | 🔴 Critical | **SOLVED** | V2 Pre-Tool Synchronous Hooks & Axum Daemon |
| `AUTOPSY-02` | Monorepo Stat-Cache Latency | 🟠 High | **SOLVED** | V2 In-Memory Incremental Inode Index (6.56ms / 10k files) |
| `AUTOPSY-03` | Storage Death Trap & Path Identity | 🔴 Critical | **SOLVED** | V3 Persistent ProjectDirs & Root-Commit Identity |
| `AUTOPSY-04` | LRU Corruption & Blob Bloat | 🟠 High | **SOLVED** | V3 Reachability GC, SQLite Triggers & Level 3 Zstd |
| `AUTOPSY-05` | PTY Blocking & ANSI Escape Bypasses | 🟡 Medium | **SOLVED** | V3 ANSI Stripping & Decoupled Non-Blocking Logger |
| `AUTOPSY-06` | IDE Friction & Native Distribution | 🟡 Medium | **SOLVED** | V3 VSCode TimelineProvider & 5-Target CI/CD Matrix |
