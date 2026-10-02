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

/// Executes Reachability Garbage Collection on Content-Addressable Storage.
/// Instead of LRU (which corrupts untouched .env files still referenced by older checkpoints),
/// Reachability GC prunes the oldest non-compensation checkpoints when total size exceeds max_mb.
/// Cascading deletes trigger automatic decrement of cas_blobs.ref_count.
/// Blobs with ref_count <= 0 are physically removed and unlinked from the database.
pub fn run_reachability_gc(max_mb: u64, conn: &Connection, blobs_dir: &Path) -> Result<GcStats> {
    let max_bytes = max_mb * 1024 * 1024;
    let target_ceiling_bytes = (max_bytes as f64 * 0.80) as u64;

    let mut size_stmt = conn.prepare("SELECT COALESCE(SUM(size_bytes), 0) FROM cas_blobs")
        .context("Failed to prepare CAS size query")?;
    let total_size: i64 = size_stmt.query_row([], |row| row.get(0))?;
    let mut current_size = total_size as u64;

    let mut count_stmt = conn.prepare("SELECT COUNT(*) FROM cas_blobs")?;
    let total_blobs: i64 = count_stmt.query_row([], |row| row.get(0)).unwrap_or(0);

    let mut stats = GcStats {
        blobs_scanned: total_blobs as usize,
        blobs_evicted: 0,
        bytes_evicted: 0,
        total_remaining_bytes: current_size,
    };

    if current_size <= max_bytes {
        return Ok(stats);
    }

    // Iteratively evict oldest non-compensation checkpoints until size drops below target ceiling
    while current_size > target_ceiling_bytes {
        let mut ckpt_stmt = conn.prepare(
            "SELECT id FROM checkpoints 
             WHERE trigger_type != 'COMPENSATION_PRE_ROLLBACK' 
             ORDER BY id ASC LIMIT 10",
        )?;
        let ckpt_ids: Vec<i64> = ckpt_stmt.query_map([], |r| r.get(0))?
            .filter_map(|r| r.ok())
            .collect();

        if ckpt_ids.is_empty() {
            // No more non-compensation checkpoints eligible for eviction
            break;
        }

        for ckpt_id in ckpt_ids {
            conn.execute("DELETE FROM checkpoints WHERE id = ?1", params![ckpt_id])?;
        }

        // Query orphaned blobs where ref_count <= 0
        let mut orphan_stmt = conn.prepare(
            "SELECT hash, size_bytes FROM cas_blobs WHERE ref_count <= 0"
        )?;
        let orphaned: Vec<(String, i64)> = orphan_stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .filter_map(|r| r.ok())
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
            let blob_path = blobs_dir.join(prefix).join(rest);

            let removed = if blob_path.exists() {
                fs::remove_file(&blob_path).is_ok()
            } else {
                true // already missing from filesystem
            };

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
