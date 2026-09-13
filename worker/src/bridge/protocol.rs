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
//! `PendingJob.resource_id`, `ClaimedJob.resource_id`,
//! `AssignmentExecution.started_at`.

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
pub struct AssignmentClaimRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub workspace_ref: String,
    pub claim_token: String,
}

impl fmt::Debug for AssignmentClaimRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AssignmentClaimRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("workspace_ref", &self.workspace_ref)
            .field("claim_token", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AssignmentStartRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub claim_token: String,
}

impl fmt::Debug for AssignmentStartRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("AssignmentStartRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("claim_token", &"[redacted]")
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

/// Execution view returned by persistent assignment claim/start.
/// Exactly 5 fields: `worker_id`, `attempt_id`, `phase`, `claimed_at`, and `started_at`.
/// All 5 fields are required keys; `started_at` may be explicit null.
/// Any unexpected fields (e.g. lease deadlines) cause a deserialization error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssignmentExecution {
    pub worker_id: String,
    pub attempt_id: String,
    pub phase: String,
    pub claimed_at: String,
    pub started_at: Option<String>,
}

impl<'de> Deserialize<'de> for AssignmentExecution {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = AssignmentExecution;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an assignment execution object")
            }
            fn visit_map<A>(self, mut map: A) -> Result<AssignmentExecution, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut worker_id: Option<String> = None;
                let mut attempt_id: Option<String> = None;
                let mut phase: Option<String> = None;
                let mut claimed_at: Option<String> = None;
                let mut started_at: Option<Option<String>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "worker_id" => worker_id = Some(map.next_value()?),
                        "attempt_id" => attempt_id = Some(map.next_value()?),
                        "phase" => phase = Some(map.next_value()?),
                        "claimed_at" => claimed_at = Some(map.next_value()?),
                        "started_at" => started_at = Some(map.next_value()?),
                        _ => {
                            return Err(A::Error::custom(
                                "unexpected field in assignment execution",
                            ));
                        }
                    }
                }
                Ok(AssignmentExecution {
                    worker_id: worker_id.ok_or_else(|| A::Error::missing_field("worker_id"))?,
                    attempt_id: attempt_id.ok_or_else(|| A::Error::missing_field("attempt_id"))?,
                    phase: phase.ok_or_else(|| A::Error::missing_field("phase"))?,
                    claimed_at: claimed_at.ok_or_else(|| A::Error::missing_field("claimed_at"))?,
                    started_at: started_at.ok_or_else(|| A::Error::missing_field("started_at"))?,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
}

/// Result target requested by a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResultTarget {
    None,
    Resource,
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
    pub result_target: ResultTarget,
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
            .field("result_target", &self.result_target)
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
                let mut result_target: Option<ResultTarget> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "job_id" => job_id = Some(map.next_value()?),
                        "workspace_ref" => workspace_ref = Some(map.next_value()?),
                        "resource_id" => resource_id = Some(map.next_value()?),
                        "prompt" => prompt = Some(map.next_value()?),
                        "acceptance" => acceptance = Some(map.next_value()?),
                        "timeout_seconds" => timeout_seconds = Some(map.next_value()?),
                        "result_target" => {
                            let rt: ResultTarget = map.next_value()?;
                            result_target = Some(rt);
                        }
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                let res_id = resource_id.ok_or_else(|| A::Error::missing_field("resource_id"))?;
                let rt = result_target.ok_or_else(|| A::Error::missing_field("result_target"))?;
                if rt == ResultTarget::Resource && res_id.as_deref().unwrap_or("").trim().is_empty()
                {
                    return Err(A::Error::custom(
                        "resource_id required when result_target is resource",
                    ));
                }
                Ok(ClaimedJob {
                    job_id: job_id.ok_or_else(|| A::Error::missing_field("job_id"))?,
                    workspace_ref: workspace_ref
                        .ok_or_else(|| A::Error::missing_field("workspace_ref"))?,
                    resource_id: res_id,
                    prompt: prompt.ok_or_else(|| A::Error::missing_field("prompt"))?,
                    acceptance: acceptance.ok_or_else(|| A::Error::missing_field("acceptance"))?,
                    timeout_seconds: timeout_seconds
                        .ok_or_else(|| A::Error::missing_field("timeout_seconds"))?,
                    result_target: rt,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
}

/// Successful assignment claim response.
#[derive(Debug, Clone, Deserialize)]
pub struct AssignmentClaimOk {
    pub ok: bool,
    pub replayed: bool,
    pub server_time: String,
    pub job: ClaimedJob,
    pub execution: AssignmentExecution,
}

/// Successful assignment start response.
#[derive(Debug, Clone, Deserialize)]
pub struct AssignmentStartOk {
    pub ok: bool,
    pub replayed: bool,
    pub server_time: String,
    pub execution: AssignmentExecution,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReportError {
    pub stage: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReportExecutor {
    #[serde(rename = "type")]
    pub r#type: String,
    pub version: String,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReportBody {
    pub schema_version: u32,
    pub execution_status: String,
    pub business_outcome: String,
    pub task_dispatched: bool,
    pub finished_at_ms: i64,
    pub duration_ms: u64,
    pub executor: ExecutionReportExecutor,
    pub receipt_sha256: String,
    pub error: Option<ExecutionReportError>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReportRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub claim_token: String,
    pub report: ExecutionReportBody,
}

impl fmt::Debug for ExecutionReportRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecutionReportRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("claim_token", &"[redacted]")
            .field("report", &self.report)
            .finish()
    }
}

impl fmt::Debug for ExecutionReportBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExecutionReportBody")
            .field("schema_version", &self.schema_version)
            .field("execution_status", &self.execution_status)
            .field("business_outcome", &self.business_outcome)
            .field("task_dispatched", &self.task_dispatched)
            .field("finished_at_ms", &self.finished_at_ms)
            .field("duration_ms", &self.duration_ms)
            .field("executor", &self.executor)
            .field("receipt_sha256", &self.receipt_sha256)
            .field("error", &self.report_error_debug())
            .finish()
    }
}

impl ExecutionReportBody {
    fn report_error_debug(&self) -> Option<(&str, &str)> {
        self.error
            .as_ref()
            .map(|e| (e.stage.as_str(), e.code.as_str()))
    }
}

/// Successful execution-report acceptance. All listed keys are required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExecutionReportOk {
    pub ok: bool,
    pub job_id: String,
    pub attempt_id: String,
    pub state: String,
    pub report_received: bool,
    pub received_at: String,
    pub replayed: bool,
}

impl<'de> Deserialize<'de> for ExecutionReportOk {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = ExecutionReportOk;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("an execution report acceptance object")
            }
            fn visit_map<A>(self, mut map: A) -> Result<ExecutionReportOk, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut ok: Option<bool> = None;
                let mut job_id: Option<String> = None;
                let mut attempt_id: Option<String> = None;
                let mut state: Option<String> = None;
                let mut report_received: Option<bool> = None;
                let mut received_at: Option<String> = None;
                let mut replayed: Option<bool> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "ok" => ok = Some(map.next_value()?),
                        "job_id" => job_id = Some(map.next_value()?),
                        "attempt_id" => attempt_id = Some(map.next_value()?),
                        "state" => state = Some(map.next_value()?),
                        "report_received" => report_received = Some(map.next_value()?),
                        "received_at" => received_at = Some(map.next_value()?),
                        "replayed" => replayed = Some(map.next_value()?),
                        _ => {
                            let _: IgnoredAny = map.next_value()?;
                        }
                    }
                }
                Ok(ExecutionReportOk {
                    ok: ok.ok_or_else(|| A::Error::missing_field("ok"))?,
                    job_id: job_id.ok_or_else(|| A::Error::missing_field("job_id"))?,
                    attempt_id: attempt_id.ok_or_else(|| A::Error::missing_field("attempt_id"))?,
                    state: state.ok_or_else(|| A::Error::missing_field("state"))?,
                    report_received: report_received
                        .ok_or_else(|| A::Error::missing_field("report_received"))?,
                    received_at: received_at
                        .ok_or_else(|| A::Error::missing_field("received_at"))?,
                    replayed: replayed.ok_or_else(|| A::Error::missing_field("replayed"))?,
                })
            }
        }
        deserializer.deserialize_map(V)
    }
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

pub const MAX_RESULT_REQUEST_BYTES: usize = 9 * 1024 * 1024; // 9 MiB

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkerResultRequest {
    pub worker_id: String,
    pub attempt_id: String,
    pub claim_token: String,
    pub payload: crate::managed_result::ManagedResourceResult,
}

impl fmt::Debug for WorkerResultRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WorkerResultRequest")
            .field("worker_id", &self.worker_id)
            .field("attempt_id", &self.attempt_id)
            .field("claim_token", &"[redacted]")
            .field("payload", &"[redacted]")
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct WorkerResultResponse {
    pub ok: bool,
    pub commit: String,
    pub received_at: String,
}
