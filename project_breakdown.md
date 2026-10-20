# Project Breakdown: AgentVault

## 1. Why It Exists (The Problem)
When autonomous coding agents work on a codebase, they make dozens of granular file edits across multiple files. If an agent goes down the wrong rabbit hole or corrupts a configuration, standard `git status` shows an overwhelming diff mess that is risky and time-consuming to untangle.

---

## 2. What It Does (The Solution)
AgentVault is an immutable flight recorder and state ledger for autonomous AI coding agents:
- **Git ODB Blob Storage:** Stores changed file snapshots directly inside Git's native object database (`.git/objects`) via `git2::Repository::blob`.
- **Lightweight SQLite Metadata Ledger:** Records transaction checkpoints (`cas_manifest`) without bloating the SQLite database with multi-megabyte file contents.
- **Microsecond Rollback Engine:** Restores an entire repository to an exact previous checkpoint in < 1ms.
- **Destructive Command Detection:** Detects dangerous ANSI strings and file deletions before they cause catastrophic data loss.

---

## 3. Targeted Niche & Use Cases
Developers and autonomous agent frameworks needing an automatic, zero-overhead safety net that records every action before and after an AI tool runs.
