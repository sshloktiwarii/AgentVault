use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use super::schema::*;
use crate::cas::CasManifestEntry;

#[derive(Clone)]
pub struct Ledger {
    conn: Arc<Mutex<Connection>>,
}

impl Ledger {
    /// Opens or creates the SQLite WAL ledger at the given database file path
    pub fn open<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let conn = Connection::open(db_path)
            .context("Failed to open SQLite database")?;

        conn.busy_timeout(std::time::Duration::from_secs(10))?;

        // Mandated PRAGMAs: WAL mode, normal synchronous, foreign keys enabled, busy timeout
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;
             PRAGMA busy_timeout = 10000;"
        )?;

        let ledger = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        ledger.init_schema()?;

        Ok(ledger)
    }

    pub fn get_connection(&self) -> Arc<Mutex<Connection>> {
        Arc::clone(&self.conn)
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                repo_hash TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                start_time INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS checkpoints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                git_commit_hash TEXT NOT NULL,
                trigger_type TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cas_manifest (
                checkpoint_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                blob_hash TEXT NOT NULL,
                is_encrypted BOOLEAN NOT NULL DEFAULT 0,
                is_compressed BOOLEAN NOT NULL DEFAULT 0,
                FOREIGN KEY(checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS cas_blobs (
                hash TEXT PRIMARY KEY,
                size_bytes INTEGER NOT NULL,
                last_referenced_at INTEGER NOT NULL,
                ref_count INTEGER DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id);
            CREATE INDEX IF NOT EXISTS idx_manifest_checkpoint ON cas_manifest(checkpoint_id);
            CREATE INDEX IF NOT EXISTS idx_blobs_last_ref ON cas_blobs(last_referenced_at);
            CREATE INDEX IF NOT EXISTS idx_blobs_ref_count ON cas_blobs(ref_count);

            -- Task 3 Triggers for Reachability Reference Counting
            CREATE TRIGGER IF NOT EXISTS trg_cas_manifest_insert
            AFTER INSERT ON cas_manifest
            BEGIN
                UPDATE cas_blobs SET ref_count = ref_count + 1 WHERE hash = NEW.blob_hash;
            END;

            CREATE TRIGGER IF NOT EXISTS trg_cas_manifest_delete
            AFTER DELETE ON cas_manifest
            BEGIN
                UPDATE cas_blobs SET ref_count = ref_count - 1 WHERE hash = OLD.blob_hash;
            END;"
        )?;
        Ok(())
    }

    pub fn create_session(&self, repo_hash: &str, agent_name: &str) -> Result<SessionRecord> {
        let session_id = uuid::Uuid::new_v4().to_string();
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;

        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO sessions (id, repo_hash, agent_name, start_time) VALUES (?1, ?2, ?3, ?4)",
            params![session_id, repo_hash, agent_name, now],
        )?;

        Ok(SessionRecord {
            id: session_id,
            repo_hash: repo_hash.to_string(),
            agent_name: agent_name.to_string(),
            start_time: now,
        })
    }

    pub fn insert_checkpoint(
        &self,
        session_id: &str,
        git_commit_hash: &str,
        trigger_type: &str,
        cas_entries: &[CasManifestEntry],
    ) -> Result<CheckpointRecord> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs() as i64;

        tx.execute(
            "INSERT INTO checkpoints (session_id, git_commit_hash, trigger_type, timestamp)
             VALUES (?1, ?2, ?3, ?4)",
            params![session_id, git_commit_hash, trigger_type, now],
        )?;

        let checkpoint_id = tx.last_insert_rowid();

        for entry in cas_entries {
            // Ensure blob record exists with base ref_count = 0 if new
            tx.execute(
                "INSERT INTO cas_blobs (hash, size_bytes, last_referenced_at, ref_count)
                 VALUES (?1, ?2, ?3, 0)
                 ON CONFLICT(hash) DO UPDATE SET last_referenced_at = ?3",
                params![entry.blob_hash, entry.size_bytes as i64, now],
            )?;

            // Inserting into manifest will fire trg_cas_manifest_insert to increment ref_count
            tx.execute(
                "INSERT INTO cas_manifest (checkpoint_id, file_path, blob_hash, is_encrypted, is_compressed)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![checkpoint_id, entry.relative_path, entry.blob_hash, false, entry.is_compressed],
            )?;
        }

        tx.commit()?;

        Ok(CheckpointRecord {
            id: checkpoint_id,
            session_id: session_id.to_string(),
            git_commit_hash: git_commit_hash.to_string(),
            trigger_type: trigger_type.to_string(),
            timestamp: now,
        })
    }

    pub fn get_latest_checkpoint(&self) -> Result<Option<CheckpointRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, git_commit_hash, trigger_type, timestamp
             FROM checkpoints ORDER BY id DESC LIMIT 1",
        )?;

        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            Ok(Some(CheckpointRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                git_commit_hash: row.get(2)?,
                trigger_type: row.get(3)?,
                timestamp: row.get(4)?,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn get_checkpoints_for_session(&self, session_id: &str) -> Result<Vec<CheckpointRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, git_commit_hash, trigger_type, timestamp
             FROM checkpoints WHERE session_id = ?1 ORDER BY id ASC",
        )?;

        let rows = stmt.query_map(params![session_id], |row| {
            Ok(CheckpointRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                git_commit_hash: row.get(2)?,
                trigger_type: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_all_checkpoints(&self) -> Result<Vec<CheckpointRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, session_id, git_commit_hash, trigger_type, timestamp
             FROM checkpoints ORDER BY id ASC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(CheckpointRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                git_commit_hash: row.get(2)?,
                trigger_type: row.get(3)?,
                timestamp: row.get(4)?,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_cas_manifest(&self, checkpoint_id: i64) -> Result<Vec<CasManifestRecord>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT checkpoint_id, file_path, blob_hash, is_encrypted, is_compressed
             FROM cas_manifest WHERE checkpoint_id = ?1",
        )?;

        let rows = stmt.query_map(params![checkpoint_id], |row| {
            Ok(CasManifestRecord {
                checkpoint_id: row.get(0)?,
                file_path: row.get(1)?,
                blob_hash: row.get(2)?,
                is_encrypted: row.get(3)?,
                is_compressed: row.get(4)?,
            })
        })?;

        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn get_total_cas_size(&self) -> Result<u64> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT COALESCE(SUM(size_bytes), 0) FROM cas_blobs")?;
        let size: i64 = stmt.query_row([], |row| row.get(0))?;
        Ok(size as u64)
    }

    pub fn get_oldest_non_compensation_checkpoints(&self, limit: usize) -> Result<Vec<i64>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id FROM checkpoints 
             WHERE trigger_type != 'COMPENSATION_PRE_ROLLBACK' 
             ORDER BY id ASC LIMIT ?1",
        )?;

        let rows = stmt.query_map(params![limit as i64], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn delete_checkpoint(&self, checkpoint_id: i64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        // Deleting from checkpoints cascades to cas_manifest, firing trg_cas_manifest_delete
        conn.execute("DELETE FROM checkpoints WHERE id = ?1", params![checkpoint_id])?;
        Ok(())
    }

    pub fn get_orphaned_blobs(&self) -> Result<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT hash FROM cas_blobs WHERE ref_count <= 0")?;
        let rows = stmt.query_map([], |row| row.get(0))?;
        let mut res = Vec::new();
        for r in rows {
            res.push(r?);
        }
        Ok(res)
    }

    pub fn delete_cas_blob_record(&self, hash: &str) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM cas_blobs WHERE hash = ?1", params![hash])?;
        Ok(())
    }
}
