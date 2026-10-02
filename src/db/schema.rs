use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub repo_hash: String,
    pub agent_name: String,
    pub start_time: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointRecord {
    pub id: i64,
    pub session_id: String,
    pub git_commit_hash: String,
    pub trigger_type: String,
    pub timestamp: i64,
    pub created_at: String,
    pub files_mutated: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasManifestRecord {
    pub checkpoint_id: i64,
    pub file_path: String,
    pub blob_hash: String,
    pub is_encrypted: bool,
    pub is_compressed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CasBlobRecord {
    pub hash: String,
    pub size_bytes: i64,
    pub ref_count: i64,
    pub created_at: String,
}
