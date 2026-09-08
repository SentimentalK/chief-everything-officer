//! Wire types for the identity-scoped server bridge protocol.
//!
//! These mirror the Server's HTTP contract (A2.2-1 + A2.2-2). The client only
//! ever emits these shapes and never manufactures attempt/token values itself.
//!
//! Contract rules enforced by the client:
//!   * Required fields must be PRESENT. Removing `#[serde(default)]` alone does
//!     not reliably reject a missing field (serde tolerates absent `Option`
//!     fields), so response types are deserialized with explicit visitors that
//!     require every key listed below and surface a missing field as an error.
//!   * Nullable fields carry `Option<T>` and may be an explicit `null`, but the
//!     key itself must still be present.
//!   * Value semantics (ID formats, alias rules, RFC3339 timestamps, phase,
//!     byte limits, timeout range) are validated after deserialization by the
//!     client (see client.rs).
//!
//! Nullable-but-required keys (explicit `null` allowed, missing rejected):
//! `PendingJob.resource_id`, `ClaimedJob.resource_id`, `Execution.started_at`,
//! `Execution.execution_deadline`.

use serde::de::{Error as _, IgnoredAny, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// Response of GET /api/identity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct IdentityInfo {
    pub user_id: String,
    pub workspace_id: String,
    pub deployment_mode: String,
}

/// A single discovered candidate task. `resource_id` is present-but-nullable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PendingJob {
    pub job_id: String,
    pub workspace_ref: String,
    pub resource_id: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

impl<'de> Deserialize<'de> for PendingJob {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = PendingJob;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a pending job object")
            }
            fn visit_map<A>(self, mut map: A) -> Result<PendingJob, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut job_id: Option<String> = None;
                let mut workspace_ref: Option<String> = None;
                let mut resource_id: Option<Option<String>> = None;
                let mut created_at: Option<String> = None;
                let mut expires_at: Option<String> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "job_id" => job_id = Some(map.next_value()?),
                        "workspace_ref" => workspace_ref = Some(map.next_value()?),
                        "resource_id" => resource_id = Some(map.next_value()?),
                        "created_at" => created_at = Some(map.next_value()?),
                        "expires_at" => expires_at = Some(map.next_value()?),
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(PendingJob {
                    job_id: job_id.ok_or_else(|| A::Error::missing_field("job_id"))?,
                    workspace_ref: workspace_ref
                        .ok_or_else(|| A::Error::missing_field("workspace_ref"))?,
                    resource_id: resource_id
                        .ok_or_else(|| A::Error::missing_field("resource_id"))?,
                    created_at: created_at.ok_or_else(|| A::Error::missing_field("created_at"))?,
                    expires_at: expires_at.ok_or_else(|| A::Error::missing_field("expires_at"))?,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Pending {
    pub ok: bool,
    pub jobs: Vec<PendingJob>,
    pub next_cursor: String,
    pub has_more: bool,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct ClaimRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub workspace_ref: String,
    pub lease_token: String,
}

// The lease token is a client secret; it must never print. The write-request
// Debug is redacted so a stray log (or a test unwrap_err) cannot leak it.
impl fmt::Debug for ClaimRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("workspace_ref", &self.workspace_ref)
            .field("lease_token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct LeaseOperationRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub lease_token: String,
}

impl fmt::Debug for LeaseOperationRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("LeaseOperationRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("lease_token", &"[redacted]")
            .finish()
    }
}

/// Execution phase value. Only `claimed`/`running` are valid; the client
/// validates the wire string into a [`Phase`] during semantic checks so a bad
/// phase becomes a distinct "invalid execution phase" error (never echoing the
/// raw value).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Claimed,
    Running,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Claimed => "claimed",
            Phase::Running => "running",
        }
    }
}

/// Public execution view returned by claim/start/heartbeat. All fields are
/// required keys; `started_at` and `execution_deadline` may be explicit null.
#[derive(Debug, Clone)]
pub struct Execution {
    pub worker_id: String,
    pub attempt_id: String,
    pub phase: String,
    pub claimed_at: String,
    pub start_deadline: String,
    pub started_at: Option<String>,
    pub lease_expires_at: String,
    pub execution_deadline: Option<String>,
}

impl<'de> Deserialize<'de> for Execution {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Execution;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an execution object")
            }
            fn visit_map<A>(self, mut map: A) -> Result<Execution, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut worker_id: Option<String> = None;
                let mut attempt_id: Option<String> = None;
                let mut phase: Option<String> = None;
                let mut claimed_at: Option<String> = None;
                let mut start_deadline: Option<String> = None;
                let mut started_at: Option<Option<String>> = None;
                let mut lease_expires_at: Option<String> = None;
                let mut execution_deadline: Option<Option<String>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "worker_id" => worker_id = Some(map.next_value()?),
                        "attempt_id" => attempt_id = Some(map.next_value()?),
                        "phase" => phase = Some(map.next_value()?),
                        "claimed_at" => claimed_at = Some(map.next_value()?),
                        "start_deadline" => start_deadline = Some(map.next_value()?),
                        "started_at" => started_at = Some(map.next_value()?),
                        "lease_expires_at" => lease_expires_at = Some(map.next_value()?),
                        "execution_deadline" => execution_deadline = Some(map.next_value()?),
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(Execution {
                    worker_id: worker_id.ok_or_else(|| A::Error::missing_field("worker_id"))?,
                    attempt_id: attempt_id.ok_or_else(|| A::Error::missing_field("attempt_id"))?,
                    phase: phase.ok_or_else(|| A::Error::missing_field("phase"))?,
                    claimed_at: claimed_at.ok_or_else(|| A::Error::missing_field("claimed_at"))?,
                    start_deadline: start_deadline
                        .ok_or_else(|| A::Error::missing_field("start_deadline"))?,
                    started_at: started_at.ok_or_else(|| A::Error::missing_field("started_at"))?,
                    lease_expires_at: lease_expires_at
                        .ok_or_else(|| A::Error::missing_field("lease_expires_at"))?,
                    execution_deadline: execution_deadline
                        .ok_or_else(|| A::Error::missing_field("execution_deadline"))?,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
}

/// The task details a successful claim returns (whitelist; never the token).
/// Debug is redacted so prompt/acceptance never print via a derived Debug.
/// `resource_id` is present-but-nullable.
#[derive(Clone)]
pub struct ClaimedJob {
    pub job_id: String,
    pub workspace_ref: String,
    pub resource_id: Option<String>,
    pub prompt: String,
    pub acceptance: String,
    pub timeout_seconds: i64,
}

impl fmt::Debug for ClaimedJob {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimedJob")
            .field("job_id", &self.job_id)
            .field("workspace_ref", &self.workspace_ref)
            .field("resource_id", &self.resource_id)
            .field("prompt", &"[redacted]")
            .field("acceptance", &"[redacted]")
            .field("timeout_seconds", &self.timeout_seconds)
            .finish()
    }
}

impl<'de> Deserialize<'de> for ClaimedJob {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ClaimedJob;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a claimed job object")
            }
            fn visit_map<A>(self, mut map: A) -> Result<ClaimedJob, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut job_id: Option<String> = None;
                let mut workspace_ref: Option<String> = None;
                let mut resource_id: Option<Option<String>> = None;
                let mut prompt: Option<String> = None;
                let mut acceptance: Option<String> = None;
                let mut timeout_seconds: Option<i64> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "job_id" => job_id = Some(map.next_value()?),
                        "workspace_ref" => workspace_ref = Some(map.next_value()?),
                        "resource_id" => resource_id = Some(map.next_value()?),
                        "prompt" => prompt = Some(map.next_value()?),
                        "acceptance" => acceptance = Some(map.next_value()?),
                        "timeout_seconds" => timeout_seconds = Some(map.next_value()?),
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(ClaimedJob {
                    job_id: job_id.ok_or_else(|| A::Error::missing_field("job_id"))?,
                    workspace_ref: workspace_ref
                        .ok_or_else(|| A::Error::missing_field("workspace_ref"))?,
                    resource_id: resource_id
                        .ok_or_else(|| A::Error::missing_field("resource_id"))?,
                    prompt: prompt.ok_or_else(|| A::Error::missing_field("prompt"))?,
                    acceptance: acceptance.ok_or_else(|| A::Error::missing_field("acceptance"))?,
                    timeout_seconds: timeout_seconds
                        .ok_or_else(|| A::Error::missing_field("timeout_seconds"))?,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
}

/// Successful claim response. Claim always carries `job` and `execution`.
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimOk {
    pub ok: bool,
    pub replayed: bool,
    pub server_time: String,
    pub job: ClaimedJob,
    pub execution: Execution,
}

/// Successful start response. Distinct from a heartbeat: start carries the
/// required `replayed` boolean while a heartbeat does not.
#[derive(Debug, Clone, Deserialize)]
pub struct StartOk {
    pub ok: bool,
    pub replayed: bool,
    pub server_time: String,
    pub execution: Execution,
}

/// Successful heartbeat response (no `replayed` field on the wire).
#[derive(Debug, Clone, Deserialize)]
pub struct HeartbeatOk {
    pub ok: bool,
    pub server_time: String,
    pub execution: Execution,
}

/// Server business-error envelope (also tolerates the auth middleware's
/// jsonrpc error shape, which carries a numeric code and a message). Used only
/// for classification; `message` is never surfaced to the client.
#[derive(Debug, Clone, Deserialize)]
pub struct ErrorEnvelope {
    #[serde(default)]
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
