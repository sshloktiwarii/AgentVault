# GHOSTBRANCH V3: SYSTEM ARCHITECTURAL INVARIANTS

These rules are permanent invariants for Project GhostBranch, evolved from V1 and V2 to eradicate latent flaws in data retention, identity orphaning, and process safety.

## Rule 1: Persistent OS Application Data Isolation (Banning `~/.cache`)
- **Symptom:** V2 stored rollback ledgers and CAS blobs in `~/.cache/rewind/`. OS maintenance daemons (macOS Storage Optimizer, Linux `systemd-tmpfiles`) silently purged the cache directory under storage pressure, deleting recovery history.
- **Invariant:** Recovery ledgers and CAS blobs must be stored in persistent XDG/OS application data directories via `directories::ProjectDirs::data_local_dir()` (e.g. `~/Library/Application Support/com.GhostBranch.GhostBranch/` on macOS or `~/.local/share/GhostBranch/` on Linux).

## Rule 2: Root-Commit Repository Identity (Immunizing Against Directory Renames)
- **Symptom:** Hashing the absolute directory path caused all recovery history to be orphaned if the user or agent renamed the repository folder.
- **Invariant:** Repository identity must be derived by walking the revision graph to the root commit (commit with 0 parents) and hashing the root commit OID via `blake3`. If no commits exist yet, fallback to the canonical path hash.

## Rule 3: SQLite Trigger-Driven Reference Counting & Reachability GC
- **Symptom:** LRU (Least Recently Used) blob eviction deleted untouched `.env` files if they were older than recent edits, corrupting earlier checkpoints.
- **Invariant:** CAS blobs must maintain an explicit `ref_count` column managed by SQLite triggers (`AFTER INSERT` and `AFTER DELETE` on `cas_manifest`). Checkpoint deletion cascades to `cas_manifest`, decrementing `ref_count`. Blobs are only unlinked from disk when `ref_count <= 0`.

## Rule 4: Mandatory Level 3 Zstandard (zstd) Compression
- **Symptom:** `lz4_flex` was suboptimal for text and source code deltas, consuming unnecessary disk space.
- **Invariant:** Sensitive configuration files (`.env*`, `*.pem`, `*.json`) must be compressed with `zstd` at level 3, which delivers the optimal mathematical tradeoff between compression ratio and sub-millisecond execution latency.

## Rule 5: ANSI-Stripped Decoupled Stream Sniffing
- **Symptom:** Blocking execution or sending SIGINT from regex checks on raw PTY terminal buffers caused false positives and was bypassed by ANSI escape sequences.
- **Invariant:** PTY output buffers must be stripped of ANSI codes via `strip_ansi_escapes::strip()` before pattern evaluation, and pattern matches must emit non-blocking `tracing::warn!` alerts rather than halting the process.
