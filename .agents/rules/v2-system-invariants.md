# REWIND V2: SYSTEM ARCHITECTURAL INVARIANTS

These rules are permanent invariants for the Rewind codebase, derived from the architectural autopsy of V1 and proven in V2.

## Rule 1: Synchronous Pre-Tool Interception (Banning Asynchronous Debounce for Mutations)
- **Symptom:** V1 relied on a 250ms sliding window debounce. During continuous agent write bursts or rapid subshell execution (e.g. `rm -rf`), the debounce timer continuously reset. If a crash or exit occurred before the quiet window completed, the pre-destruction state was never captured.
- **Invariant:** Destructive agent actions must be gated synchronously. Before an AI agent executes a bash or file-write tool, a synchronous pre-flight hook (`PreToolUse`) must intercept and block execution until an atomic snapshot is committed to disk.

## Rule 2: In-Memory Incremental Inode Delta Tracking
- **Symptom:** V1 relied on `git add --all` against an ephemeral index. In repositories with large directory trees (50k+ files across `node_modules` or build artifacts), Git stat-walks took 300ms–1.5s, breaking real-time latency guarantees.
- **Invariant:** Never perform full-tree filesystem scans during active agent turns. The system must maintain an in-memory incremental index (`BTreeMap<PathBuf, FileMetadata>`) updated via OS-native events (`notify`: FSEvents/inotify/ReadDirectoryChangesW) that only hashes files with modified `mtime` or size deltas.

## Rule 3: Complete Out-of-Band State Isolation (Protecting Against the `.git/` Blast Radius)
- **Symptom:** V1 stored rollback references and CAS blobs inside `.git/rewind/`. When an agent issued `rm -rf .git` or a clean rewrite, it destroyed both the repository and its recovery flight recorder simultaneously.
- **Invariant:** The rollback ledger and CAS blob storage must reside strictly out-of-band in an isolated user cache directory (`~/.cache/rewind/stores/<blake3-repo-hash>/`), completely untouchable by commands executed within the target project directory.

## Rule 4: Deterministic Bounded Storage with LRU Eviction
- **Symptom:** V1 appended content-addressed blobs indefinitely without pruning, turning the CAS store into an unbounded disk bomb.
- **Invariant:** Storage systems must enforce a strict, configurable size budget (default 5GB). Checkpoint transactions must periodically trigger an LRU eviction pass that drops unreferenced blobs below 80% capacity while maintaining ledger referential integrity.

## Rule 5: Zero-Dependency Single Binary Distribution (Eradicating C++ Node-GYP Friction)
- **Symptom:** Node-PTY required compiling C++ addons on installation, resulting in fatal compilation errors for Windows and minimal environments without Visual Studio or Python.
- **Invariant:** The core PTY wrapper, watcher, database, and Git ODB manipulation must be compiled into a single static, cross-platform native binary (via Rust and portable-pty) with zero runtime or build-time system dependencies.
