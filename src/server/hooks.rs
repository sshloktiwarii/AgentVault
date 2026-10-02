use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::net::TcpListener;

#[derive(Debug, Deserialize)]
pub struct PreFlightRequest {
    pub tool_name: Option<String>,
    pub command: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PreFlightResponse {
    pub status: String,
    pub checkpoint_id: i64,
    pub git_commit_hash: String,
}

pub type CheckpointTriggerFn = Arc<dyn Fn(&str, &str) -> anyhow::Result<(i64, String)> + Send + Sync>;

#[derive(Clone)]
pub struct ServerState {
    pub default_session_id: String,
    pub trigger_checkpoint: CheckpointTriggerFn,
}

pub struct HookServer {
    pub port: u16,
    pub state: ServerState,
}

impl HookServer {
    pub fn new(default_session_id: &str, trigger_checkpoint: CheckpointTriggerFn, port: u16) -> Self {
        Self {
            port,
            state: ServerState {
                default_session_id: default_session_id.to_string(),
                trigger_checkpoint,
            },
        }
    }

    pub fn router(state: ServerState) -> Router {
        Router::new()
            .route("/health", get(health_check))
            .route("/api/v1/checkpoint/pre-flight", post(pre_flight_checkpoint))
            .with_state(state)
    }

    pub async fn start(&self) -> anyhow::Result<()> {
        let app = Self::router(self.state.clone());
        let addr = format!("127.0.0.1:{}", self.port);
        let listener = TcpListener::bind(&addr).await?;
        axum::serve(listener, app).await?;
        Ok(())
    }
}

async fn health_check() -> &'static str {
    "AgentVault Hook Server Active"
}

/// Synchronous Pre-Tool Hook Handler (Solves Flaw #1: Debounced Race Condition)
/// Blocks until the snapshot is fully hashed, tree-committed, and recorded in SQLite.
async fn pre_flight_checkpoint(
    State(state): State<ServerState>,
    Json(payload): Json<PreFlightRequest>,
) -> impl IntoResponse {
    let session_id = payload.session_id.unwrap_or(state.default_session_id);
    let trigger = payload.tool_name.unwrap_or_else(|| "PRE_TOOL_USE".to_string());

    match (state.trigger_checkpoint)(&session_id, &trigger) {
        Ok((checkpoint_id, commit_hash)) => (
            StatusCode::OK,
            Json(serde_json::to_value(PreFlightResponse {
                status: "OK".to_string(),
                checkpoint_id,
                git_commit_hash: commit_hash,
            }).unwrap()),
        ),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "status": "ERROR",
                "error": err.to_string()
            })),
        ),
    }
}
