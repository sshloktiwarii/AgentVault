# Rewind: Architectural Autopsy & Solution Matrix

> **Permanent Record of Known Architectural Bottlenecks, Vulnerabilities, and Next-Gen Engineering Solutions.**  
> *Logged on: October 2, 2026*

---

## 1. The Debounced Race Condition (The 250ms Blind Spot)

* **Severity:** 🔴 **Critical**
* **Problem:** The architecture relies on a 250ms quiet-window debounce to trigger snapshots. Autonomous agents emit write bursts, subshell loops, and batch edits continuously.
* **Failure Mode / Explanation:** If an agent executes a destructive command (`rm -rf` or a bad `sed -i`) during an active write burst, the debounce timer keeps resetting. If the process exits or crashes before that quiet window finally expires, the pre-destruction snapshot is never written, completely missing the critical recovery window.
* **Target Solution:** Implement synchronous pre-tool interception hooks (`PreToolUse` for Claude/Cursor/Codex) to force an immediate snapshot the exact millisecond a shell command or write tool is dispatched, bypassing the asynchronous debounce delay entirely.

---

## 2. The Monorepo Stat-Cache / Latency Illusion

* **Severity:** 🟠 **High**
* **Problem:** The spec claims sub-15ms performance via `git add --all` against an ephemeral index.
* **Failure Mode / Explanation:** In a real repository with `node_modules`, build artifacts, or deep asset directories (50,000+ files), `git add` forces a full filesystem stat walk. Without a persistent caching daemon tracking directory inode changes via OS native hooks, snapshot latency balloons to 300ms–1.5s, shattering the real-time guarantee.
* **Target Solution:** Drop raw `git add --all` re-indexing loops. Maintain an incremental inode index mapping file modification times (`mtimes`) and sizes, only hashing files that have explicitly changed since the last delta.

---

## 3. The `.git/` Blast Radius Paradox

* **Severity:** 🔴 **Critical**
* **Problem:** All rollback references and CAS overlays are stored inside `.git/rewind/`.
* **Failure Mode / Explanation:** If an agent runs a blunt-force command like `rm -rf .git` or performs an aggressive history rewrite/clean, it instantly vaporizes its own insurance policy because the backup mechanism lives directly inside the target blast zone.
* **Target Solution:** Shift the shadow store entirely out of band into an isolated user-state directory (`~/.cache/rewind/stores/<repo-hash>/`) so a rogue `rm -rf .git` can never reach the recovery state.

---

## 4. Unbounded CAS Storage (The Disk Bomb)

* **Severity:** 🟠 **High**
* **Problem:** Every snapshot creates new content-addressed blobs, but old ones are never pruned.
* **Failure Mode / Explanation:** After 30 days of heavy agent usage, `.git/rewind/overlay/blobs/` or the out-of-band store will swell to tens of gigabytes. Without an eviction policy or total size ceiling, users' SSDs will fill up unexpectedly.
* **Target Solution:** Implement an LRU (Least Recently Used) eviction strategy, a configurable total size budget (e.g., hard cap at 5GB), and a manual/automatic `rewind gc` command.

---

## 5. Native Dependency Install Friction (Node-PTY)

* **Severity:** 🟠 **High**
* **Problem:** Building a terminal wrapper via `node-pty` requires compiling a C++ addon (`node-gyp`).
* **Failure Mode / Explanation:** Windows users who lack Visual Studio Build Tools or Python will experience a catastrophic installation failure stack trace when running `npm i -g rewind`, instantly killing adoption across a huge percentage of developers.
* **Target Solution:** Rewrite the core PTY and execution harness in Rust (using `portable-pty`) or Go to distribute a single self-contained binary with zero build-time system dependencies.

---

### Implementation Status Matrix

| ID | Issue | Severity | Status | Planned Phase |
|---|---|---|---|---|
| `AUTOPSY-01` | Debounced Race Condition | 🔴 Critical | Documented | v1.1 Pre-Tool Synchronous Hooks |
| `AUTOPSY-02` | Monorepo Stat-Cache Latency | 🟠 High | Documented | v1.1 Incremental Inode Index |
| `AUTOPSY-03` | `.git/` Blast Radius Paradox | 🔴 Critical | Documented | v1.2 Out-of-Band Store Migration (`~/.cache/rewind/`) |
| `AUTOPSY-04` | Unbounded CAS Storage | 🟠 High | Documented | v1.2 LRU Eviction & `rewind gc` |
| `AUTOPSY-05` | Node-PTY Native Friction | 🟠 High | Documented | v2.0 Rust/Go Single-Binary Core Engine |
