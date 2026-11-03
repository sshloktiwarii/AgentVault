use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use subtle::ConstantTimeEq;
use tokio::net::TcpListener;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PreFlightRequest {
    pub tool_name: Option<String>,
    pub command: Option<String>,
    pub session_id: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
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
    pub auth_token: Option<String>,
}

pub struct HookServer {
    pub port: u16,
    pub state: ServerState,
}

impl HookServer {
    pub fn new(default_session_id: &str, trigger_checkpoint: CheckpointTriggerFn, port: u16) -> Self {
        let auth_token = std::env::var("AGENTVAULT_TOKEN")
            .or_else(|_| std::env::var("AGENTVAULT_HOOK_TOKEN"))
            .or_else(|_| std::env::var("AGENTVAULT_SESSION_TOKEN"))
            .ok();
        Self {
            port,
            state: ServerState {
                default_session_id: default_session_id.to_string(),
                trigger_checkpoint,
                auth_token,
            },
        }
    }

    pub fn with_auth_token(mut self, token: impl Into<String>) -> Self {
        self.state.auth_token = Some(token.into());
        self
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

/// Validates session or local environment tokens from request headers or payload.
pub fn validate_token(
    state: &ServerState,
    headers: &HeaderMap,
    payload: &PreFlightRequest,
) -> Result<String, StatusCode> {
    // 1. Gather candidate tokens from headers or JSON body
    let mut candidate_tokens = Vec::new();

    if let Some(auth_val) = headers.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let token = if let Some(bearer) = auth_val.strip_prefix("Bearer ") {
            bearer.trim()
        } else {
            auth_val.trim()
        };
        if !token.is_empty() {
            candidate_tokens.push(token);
        }
    }

    if let Some(tok) = headers.get("x-agentvault-token").and_then(|v| v.to_str().ok()) {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            candidate_tokens.push(trimmed);
        }
    }

    if let Some(tok) = headers.get("x-session-token").and_then(|v| v.to_str().ok()) {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            candidate_tokens.push(trimmed);
        }
    }

    if let Some(ref tok) = payload.token {
        let trimmed = tok.trim();
        if !trimmed.is_empty() {
            candidate_tokens.push(trimmed);
        }
    }

    // 2. Resolve local environment token dynamically or from state
    let env_token = std::env::var("AGENTVAULT_TOKEN")
        .or_else(|_| std::env::var("AGENTVAULT_HOOK_TOKEN"))
        .or_else(|_| std::env::var("AGENTVAULT_SESSION_TOKEN"))
        .ok();

    let is_env_token_valid = |t: &str| -> bool {
        if let Some(ref env_t) = env_token {
            if !env_t.is_empty() && bool::from(t.as_bytes().ct_eq(env_t.as_bytes())) {
                return true;
            }
        }
        if let Some(ref state_t) = state.auth_token {
            if !state_t.is_empty() && bool::from(t.as_bytes().ct_eq(state_t.as_bytes())) {
                return true;
            }
        }
        false
    };

    // 3. If any provided token matches environment token or state auth token in constant time
    let has_valid_token = candidate_tokens.iter().any(|&t| is_env_token_valid(t));

    if has_valid_token {
        let session_id = payload
            .session_id
            .as_deref()
            .unwrap_or(&state.default_session_id);
        return Ok(session_id.to_string());
    }

    Err(StatusCode::UNAUTHORIZED)
}

/// Synchronous Pre-Tool Hook Handler (Solves Flaw #1: Debounced Race Condition)
/// Blocks until the snapshot is fully hashed, tree-committed, and recorded in SQLite.
async fn pre_flight_checkpoint(
    State(state): State<ServerState>,
    headers: HeaderMap,
    Json(payload): Json<PreFlightRequest>,
) -> impl IntoResponse {
    let session_id = match validate_token(&state, &headers, &payload) {
        Ok(sid) => sid,
        Err(status) => {
            return (
                status,
                Json(serde_json::json!({
                    "status": "ERROR",
                    "error": "Unauthorized: invalid or missing session or environment token"
                })),
            );
        }
    };

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

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    #[test]
    fn test_default_session_id_bypass_rejected() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: Some("secret_token".to_string()),
        };
        let headers = HeaderMap::new();
        // Request specifying default_session_id in payload with no token must be rejected
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: Some("sess_xyz_123".to_string()),
            token: None,
        };
        assert_eq!(validate_token(&state, &headers, &payload), Err(StatusCode::UNAUTHORIZED));

        // Request with wrong token on default_session_id must also be rejected
        let payload_wrong = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: Some("sess_xyz_123".to_string()),
            token: Some("wrong_token".to_string()),
        };
        assert_eq!(validate_token(&state, &headers, &payload_wrong), Err(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn test_constant_time_token_check_valid() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: Some("secret_token_constant_time".to_string()),
        };
        let headers = HeaderMap::new();
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: Some("sess_xyz_123".to_string()),
            token: Some("secret_token_constant_time".to_string()),
        };
        assert_eq!(validate_token(&state, &headers, &payload), Ok("sess_xyz_123".to_string()));
    }

    #[test]
    fn test_invalid_session_token_rejected() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: Some("secret_token".to_string()),
        };
        let headers = HeaderMap::new();
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: Some("attacker_session".to_string()),
            token: Some("invalid_token".to_string()),
        };
        assert_eq!(validate_token(&state, &headers, &payload), Err(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn test_missing_token_rejected() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: None,
        };
        let headers = HeaderMap::new();
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: None,
            token: None,
        };
        assert_eq!(validate_token(&state, &headers, &payload), Err(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn test_valid_environment_token_in_header() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: Some("secret_local_env_token".to_string()),
        };
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer secret_local_env_token".parse().unwrap(),
        );
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: None,
            token: None,
        };
        assert_eq!(validate_token(&state, &headers, &payload), Ok("sess_xyz_123".to_string()));
    }

    #[test]
    fn test_valid_environment_token_in_payload_token() {
        let state = ServerState {
            default_session_id: "sess_xyz_123".to_string(),
            trigger_checkpoint: Arc::new(|_, _| Ok((1, "commit".to_string()))),
            auth_token: Some("secret_local_env_token".to_string()),
        };
        let headers = HeaderMap::new();
        let payload = PreFlightRequest {
            tool_name: Some("test".to_string()),
            command: None,
            session_id: Some("custom_session".to_string()),
            token: Some("secret_local_env_token".to_string()),
        };
        assert_eq!(validate_token(&state, &headers, &payload), Ok("custom_session".to_string()));
    }
}
