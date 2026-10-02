use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use std::fs;
use std::path::Path;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct GcStats {
    pub blobs_scanned: usize,
    pub blobs_evicted: usize,
    pub bytes_evicted: u64,
    pub total_remaining_bytes: u64,
}

/// Reconciles trigger drift that may occur from ungraceful crashes mid-write.
/// Recalculates true reference counts directly from `cas_manifest` and corrects `cas_blobs.ref_count`.
pub fn reconcile_ref_counts(conn: &Connection) -> Result<()> {
    // Fixes crash-induced trigger drift on application startup
    conn.execute_batch(
        "UPDATE cas_blobs 
         SET ref_count = (SELECT COUNT(*) FROM cas_manifest WHERE blob_hash = cas_blobs.hash) 
         WHERE ref_count != (SELECT COUNT(*) FROM cas_manifest WHERE blob_hash = cas_blobs.hash);"
    )?;
    Ok(())
}

/// Executes Reachability Garbage Collection on Content-Addressable Storage.
/// Instead of LRU (which corrupts untouched .env files still referenced by older checkpoints),
/// Reachability GC prunes the oldest non-compensation checkpoints when total size exceeds max_mb.
/// Cascading deletes trigger automatic decrement of cas_blobs.ref_count via SQLite triggers.
/// Blobs with ref_count <= 0 are physically removed from disk using `std::fs::remove_file`
/// and only unlinked from the database upon confirmed deletion.
pub fn run_reachability_gc(max_mb: u64, conn: &Connection, blobs_dir: &Path) -> Result<GcStats> {
    reconcile_ref_counts(conn)?;
    let max_bytes = max_mb * 1024 * 1024;
    let target_ceiling_bytes = (max_bytes as f64 * 0.80) as u64;

    let total_size: u64 = conn.query_row(
        "SELECT COALESCE(SUM(size_bytes), 0) FROM cas_blobs",
        [],
        |row| row.get(0),
    ).context("Failed to query total CAS blob storage size")?;

    let total_blobs: i64 = conn.query_row(
        "SELECT COUNT(*) FROM cas_blobs",
        [],
        |row| row.get(0),
    ).unwrap_or(0);

    let mut current_size = total_size;
    let mut stats = GcStats {
        blobs_scanned: total_blobs as usize,
        blobs_evicted: 0,
        bytes_evicted: 0,
        total_remaining_bytes: current_size,
    };

    if current_size <= max_bytes {
        return Ok(stats);
    }

    // Iteratively evict oldest unpinned/non-compensation checkpoints until size drops below target ceiling
    while current_size > target_ceiling_bytes {
        // Delete oldest unpinned checkpoints. Triggers will auto-decrement ref_counts.
        let rows_deleted = conn.execute(
            "DELETE FROM checkpoints 
             WHERE id IN (
                 SELECT id FROM checkpoints 
                 WHERE trigger_type NOT LIKE 'COMPENSATION%' 
                 ORDER BY created_at ASC LIMIT 50
             )",
            [],
        )?;

        if rows_deleted == 0 {
            // No more unpinned checkpoints eligible for eviction
            break;
        }

        // Reap zero-ref blobs
        let mut stmt = conn.prepare("SELECT hash, size_bytes FROM cas_blobs WHERE ref_count <= 0")?;
        let orphaned: Vec<(String, i64)> = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?
        .filter_map(Result::ok)
        .collect();

        if orphaned.is_empty() {
            break;
        }

        for (hash, size) in orphaned {
            let (prefix, rest) = if hash.len() >= 2 {
                (&hash[0..2], &hash[2..])
            } else {
                ("00", hash.as_str())
            };
            let sharded_path = blobs_dir.join(prefix).join(rest);
            let direct_path = blobs_dir.join(&hash);

            let blob_path = if sharded_path.exists() {
                sharded_path
            } else {
                direct_path
            };

            // Implementation physically deletes the file using std::fs::remove_file
            let removed = if blob_path.exists() {
                fs::remove_file(&blob_path).is_ok()
            } else {
                true // file already removed from disk
            };

            // Only if std::fs::remove_file succeeds, execute DELETE FROM cas_blobs WHERE hash = ?
            if removed {
                conn.execute("DELETE FROM cas_blobs WHERE hash = ?1", params![hash])?;
                stats.blobs_evicted += 1;
                stats.bytes_evicted += size as u64;
                current_size = current_size.saturating_sub(size as u64);
            }
        }
    }

    stats.total_remaining_bytes = current_size;
    Ok(stats)
}
