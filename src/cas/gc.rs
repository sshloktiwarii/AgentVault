use anyhow::Result;
use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use super::store::CasStore;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct GcStats {
    pub blobs_scanned: usize,
    pub blobs_evicted: usize,
    pub bytes_evicted: u64,
    pub total_remaining_bytes: u64,
}

#[derive(Debug)]
struct BlobMeta {
    path: PathBuf,
    size_bytes: u64,
    last_accessed: SystemTime,
}

/// Enforces the LRU eviction policy on the Content-Addressable Storage
pub fn run_garbage_collection(store: &CasStore, max_allowed_bytes: u64) -> Result<GcStats> {
    let mut blobs: Vec<BlobMeta> = Vec::new();
    let mut total_size: u64 = 0;

    // Scan sharded objects directory
    if store.objects_dir.exists() {
        for prefix_entry in fs::read_dir(&store.objects_dir)? {
            let prefix_entry = prefix_entry?;
            if prefix_entry.file_type()?.is_dir() {
                for blob_entry in fs::read_dir(prefix_entry.path())? {
                    let blob_entry = blob_entry?;
                    if blob_entry.file_type()?.is_file() {
                        let metadata = blob_entry.metadata()?;
                        let size = metadata.len();
                        total_size += size;
                        let last_accessed = metadata.accessed().unwrap_or_else(|_| metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH));
                        blobs.push(BlobMeta {
                            path: blob_entry.path(),
                            size_bytes: size,
                            last_accessed,
                        });
                    }
                }
            }
        }
    }

    let mut stats = GcStats {
        blobs_scanned: blobs.len(),
        blobs_evicted: 0,
        bytes_evicted: 0,
        total_remaining_bytes: total_size,
    };

    if total_size <= max_allowed_bytes {
        return Ok(stats);
    }

    // Sort by oldest access time first (LRU)
    blobs.sort_by(|a, b| a.last_accessed.cmp(&b.last_accessed));

    // Target dropping down to 80% of max budget
    let target_size = (max_allowed_bytes as f64 * 0.8) as u64;

    for blob in blobs {
        if stats.total_remaining_bytes <= target_size {
            break;
        }

        if let Ok(()) = fs::remove_file(&blob.path) {
            stats.blobs_evicted += 1;
            stats.bytes_evicted += blob.size_bytes;
            stats.total_remaining_bytes = stats.total_remaining_bytes.saturating_sub(blob.size_bytes);
        }
    }

    Ok(stats)
}
