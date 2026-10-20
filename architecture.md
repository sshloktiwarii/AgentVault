# Architecture Specification: AgentVault

## 1. System Architecture Diagram

```mermaid
graph TD
    Hook["Pre/Post Tool Hook"] -->|File Mutation Event| Engine["AgentVault Core Engine (Rust)"]
    
    subgraph "Dual Storage Architecture"
        Engine -->|Store Raw Blob Bytes| GitODB["Git Object Database (.git/objects)<br/>(git2::Repository::blob)"]
        Engine -->|Store Checkpoint Hashes| SQLite["SQLite Metadata Ledger<br/>(cas_manifest & transactions)"]
    end
    
    subgraph "Rollback & Recovery"
        Engine --> Rollback["Rollback Engine"]
        Rollback -->|Instant Inode Restore| Workspace["Working Tree Filesystem"]
    end
```

---

## 2. Component Blueprint
- **`src/lib.rs` / `src/main.rs`**: Core ledger entry points and CLI command parser.
- **`src/storage/`**: Native Git ODB integration via `libgit2` bindings.
- **`src/db/`**: SQLite transaction tracker maintaining checkpoint metadata.
- **`tests/v4_production_suite.rs`**: Verification suite for drift detection and instant rollbacks.
