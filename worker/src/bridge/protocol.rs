//! Wire types for the identity-scoped server bridge protocol.
//!
//! These mirror the Server's HTTP contract (A2.2-1 + A2.2-2). The client only
//! ever emits these shapes and never manufactures attempt/token values itself.

use serde::{Deserialize, Serialize};

/// Response of GET /api/identity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IdentityInfo {
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub workspace_id: String,
    #[serde(default)]
    pub deployment_mode: Option<String>,
}

/// A single discovered candidate task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingJob {
    pub job_id: String,
    pub workspace_ref: String,
    pub resource_id: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Pending {
    pub ok: bool,
    #[serde(default)]
    pub jobs: Vec<PendingJob>,
    pub next_cursor: String,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub workspace_ref: String,
    pub lease_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseOperationRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub lease_token: String,
}

/// Public execution view returned by claim/start/heartbeat.
#[derive(Debug, Clone, Deserialize)]
pub struct Execution {
    #[serde(default)]
    pub worker_id: String,
    #[serde(default)]
    pub attempt_id: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub claimed_at: Option<String>,
    #[serde(default)]
    pub start_deadline: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub lease_expires_at: Option<String>,
    #[serde(default)]
    pub execution_deadline: Option<String>,
}

/// The task details a successful claim returns (whitelist; never the token).
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimedJob {
    #[serde(default)]
    pub job_id: String,
    #[serde(default)]
    pub workspace_ref: String,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub acceptance: String,
    #[serde(default)]
    pub timeout_seconds: i64,
}

/// Successful claim response.
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimOk {
    pub ok: bool,
    #[serde(default)]
    pub replayed: bool,
    #[serde(default)]
    pub server_time: Option<String>,
    #[serde(default)]
    pub job: Option<ClaimedJob>,
    #[serde(default)]
    pub execution: Option<Execution>,
}

/// Successful start/heartbeat response.
#[derive(Debug, Clone, Deserialize)]
pub struct LeaseOk {
    pub ok: bool,
    #[serde(default)]
    pub replayed: Option<bool>,
    #[serde(default)]
    pub server_time: Option<String>,
    #[serde(default)]
    pub execution: Option<Execution>,
}

/// Server business-error envelope (also tolerates the auth middleware's
/// jsonrpc error shape, which carries a numeric code and a message).
#[derive(Debug, Clone, Deserialize)]
pub struct ErrorEnvelope {
    pub ok: Option<bool>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub details: Option<Details>,
    #[serde(default)]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Details {
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcError {
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub code: Option<i64>,
}
