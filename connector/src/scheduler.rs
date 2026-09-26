use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::Path;
use thiserror::Error;

use crate::client::ClaimJobResponse;
use crate::config::LocalTarget;
use crate::execution_contract::ExecutionReport;
use crate::local_state::atomic_write_json;

pub const ACTIVE_ATTEMPT_SCHEMA_VERSION: u32 = 4;

#[derive(Error, Debug)]
pub enum SchedulerError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unsupported schema version: {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("Active attempt identity mismatch: expected server '{expected_server}' / device '{expected_device}', but got '{actual_server}' / '{actual_device}' (RECOVERY_REQUIRED)")]
    IdentityMismatch {
        expected_server: String,
        expected_device: String,
        actual_server: String,
        actual_device: String,
    },
    #[error("Active attempt payload integrity hash mismatch (LOCAL_STATE_INVALID)")]
    PayloadHashMismatch,
    #[error("Claim response correlation mismatch: {0} (RECOVERY_REQUIRED)")]
    ClaimCorrelationMismatch(String),
    #[error("Corrupt active attempt state: {0} (LOCAL_STATE_INVALID)")]
    CorruptState(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptPhase {
    ClaimIntent,
    Claimed,
    StartIntent,
    Started,
    PrepareIntent,
    Prepared,
    DispatchIntent,
    Dispatched,
    Waiting,
    OutcomeRecorded,
    FinalizedLocal,
    RecoveryRequired,
    #[serde(rename = "running")]
    LegacyRunning,
}

#[derive(Serialize)]
struct CanonicalPayload<'a> {
    job_id: &'a str,
    workspace_id: &'a str,
    target_id: &'a str,
    resource_id: Option<&'a str>,
    prompt: &'a str,
    acceptance: &'a str,
    execution_timeout_seconds: u32,
    result_target: &'a str,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PreparedExecution {
    pub orca_version: String,
    pub worktree_id: String,
    pub terminal_id: String,
    pub agent_id: String,
    pub agent_ready_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AttemptExecutorState {
    #[serde(rename = "type")]
    pub executor_type: String, // "orca" or "ceo-connector"
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orca_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_ready_at_ms: Option<i64>,
    #[serde(default)]
    pub dispatch_send_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_deadline_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch_accepted_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_dispatch_outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_completion_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_completed_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_error: Option<crate::execution_contract::ExecutionReportError>,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ActiveAttempt {
    pub schema_version: u32,
    pub server_origin: String,
    pub device_id: String,
    pub job_id: String,
    pub workspace_id: String,
    pub target_id: String,
    pub attempt_id: String,
    pub claim_token: String,
    pub phase: AttemptPhase,
    pub resource_id: Option<String>,
    pub prompt: Option<String>,
    pub acceptance: Option<String>,
    pub execution_timeout_seconds: Option<u32>,
    pub result_target: Option<String>,
    pub payload_sha256: Option<String>,
    pub claimed_at_ms: Option<i64>,
    pub terminal_report_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<AttemptExecutorState>,
}

impl fmt::Debug for ActiveAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ActiveAttempt")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("device_id", &self.device_id)
            .field("job_id", &self.job_id)
            .field("workspace_id", &self.workspace_id)
            .field("target_id", &self.target_id)
            .field("attempt_id", &self.attempt_id)
            .field("claim_token", &"[REDACTED]")
            .field("phase", &self.phase)
            .field("resource_id", &self.resource_id)
            .field("prompt", &"[REDACTED]")
            .field("acceptance", &"[REDACTED]")
            .field("execution_timeout_seconds", &self.execution_timeout_seconds)
            .field("result_target", &self.result_target)
            .field("payload_sha256", &self.payload_sha256)
            .field("claimed_at_ms", &self.claimed_at_ms)
            .field("terminal_report_sha256", &self.terminal_report_sha256)
            .field("executor", &self.executor)
            .finish()
    }
}

impl ActiveAttempt {
    #[allow(clippy::too_many_arguments)]
    pub fn compute_payload_sha256(
        job_id: &str,
        workspace_id: &str,
        target_id: &str,
        resource_id: Option<&str>,
        prompt: &str,
        acceptance: &str,
        execution_timeout_seconds: u32,
        result_target: &str,
    ) -> String {
        let canonical = CanonicalPayload {
            job_id,
            workspace_id,
            target_id,
            resource_id,
            prompt,
            acceptance,
            execution_timeout_seconds,
            result_target,
        };
        let bytes =
            serde_json::to_vec(&canonical).expect("canonical payload serialization cannot fail");
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    }

    pub fn validate(&self) -> Result<(), SchedulerError> {
        if self.schema_version != ACTIVE_ATTEMPT_SCHEMA_VERSION {
            return Err(SchedulerError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }

        if !is_valid_attempt_id(&self.attempt_id) {
            return Err(SchedulerError::CorruptState(format!(
                "invalid attempt_id format: '{}' (must be att-<uuid> or att_<uuid>)",
                self.attempt_id
            )));
        }

        if self.claim_token.len() != 64
            || !self
                .claim_token
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(SchedulerError::CorruptState(
                "claim_token must be 64 lowercase hex characters".into(),
            ));
        }

        let normalized = crate::config::normalize_server_origin(&self.server_origin)
            .map_err(|e| SchedulerError::CorruptState(format!("invalid server_origin: {e}")))?;
        if normalized != self.server_origin {
            return Err(SchedulerError::CorruptState(
                "server_origin is not normalized".into(),
            ));
        }

        match self.phase {
            AttemptPhase::ClaimIntent => {
                // No confirmed payload required
            }
            AttemptPhase::Claimed
            | AttemptPhase::StartIntent
            | AttemptPhase::Started
            | AttemptPhase::PrepareIntent
            | AttemptPhase::Prepared
            | AttemptPhase::DispatchIntent
            | AttemptPhase::Dispatched
            | AttemptPhase::Waiting
            | AttemptPhase::OutcomeRecorded => {
                let prompt = self.prompt.as_deref().ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "claimed/pre-terminal attempt missing prompt".into(),
                    )
                })?;
                let acceptance = self.acceptance.as_deref().ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "claimed/pre-terminal attempt missing acceptance".into(),
                    )
                })?;
                let timeout = self.execution_timeout_seconds.ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "claimed/pre-terminal attempt missing execution_timeout_seconds".into(),
                    )
                })?;
                let result_target = self.result_target.as_deref().ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "claimed/pre-terminal attempt missing result_target".into(),
                    )
                })?;
                let payload_hash = self.payload_sha256.as_deref().ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "claimed/pre-terminal attempt missing payload_sha256".into(),
                    )
                })?;

                let computed = Self::compute_payload_sha256(
                    &self.job_id,
                    &self.workspace_id,
                    &self.target_id,
                    self.resource_id.as_deref(),
                    prompt,
                    acceptance,
                    timeout,
                    result_target,
                );
                if computed != *payload_hash {
                    return Err(SchedulerError::PayloadHashMismatch);
                }

                if matches!(
                    self.phase,
                    AttemptPhase::Prepared
                        | AttemptPhase::DispatchIntent
                        | AttemptPhase::Dispatched
                        | AttemptPhase::Waiting
                        | AttemptPhase::OutcomeRecorded
                ) {
                    if let Some(ref exec) = self.executor {
                        if exec.worktree_id.is_none() || exec.terminal_id.is_none() {
                            return Err(SchedulerError::CorruptState(
                                "prepared attempt missing worktree_id or terminal_id".into(),
                            ));
                        }
                        if exec.agent_id.is_none() {
                            return Err(SchedulerError::CorruptState(
                                "prepared attempt missing agent_id".into(),
                            ));
                        }
                        if exec.runtime_completion_kind.as_deref() != Some("not_started")
                            && exec.agent_ready_at_ms.is_none()
                        {
                            return Err(SchedulerError::CorruptState(
                                "prepared attempt missing agent_ready_at_ms".into(),
                            ));
                        }

                        if matches!(
                            self.phase,
                            AttemptPhase::Dispatched
                                | AttemptPhase::StartIntent
                                | AttemptPhase::Started
                                | AttemptPhase::Waiting
                        ) && exec.dispatch_request_id.is_none()
                        {
                            return Err(SchedulerError::CorruptState(
                                "dispatched/waiting attempt missing dispatch_request_id".into(),
                            ));
                        }

                        if self.phase == AttemptPhase::OutcomeRecorded
                            && matches!(
                                exec.runtime_completion_kind.as_deref(),
                                Some("tui_idle") | Some("timed_out") | Some("interrupted")
                            )
                            && exec.dispatch_request_id.is_none()
                        {
                            return Err(SchedulerError::CorruptState(
                                "dispatched outcome missing dispatch_request_id".into(),
                            ));
                        }
                    } else {
                        return Err(SchedulerError::CorruptState(
                            "prepared attempt missing executor state".into(),
                        ));
                    }
                }
            }
            AttemptPhase::FinalizedLocal => {
                let hash = self.terminal_report_sha256.as_deref().ok_or_else(|| {
                    SchedulerError::CorruptState(
                        "finalized_local attempt missing terminal_report_sha256".into(),
                    )
                })?;
                if hash.len() != 64
                    || !hash
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
                {
                    return Err(SchedulerError::CorruptState(
                        "terminal_report_sha256 must be 64 lowercase hex characters".into(),
                    ));
                }
            }
            AttemptPhase::RecoveryRequired | AttemptPhase::LegacyRunning => {
                // Remains blocking or will be migrated
            }
        }

        Ok(())
    }

    pub fn load(path: &Path) -> Result<Option<Self>, SchedulerError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let val: serde_json::Value = serde_json::from_str(&content)?;
        let version = val
            .get("schema_version")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| SchedulerError::CorruptState("missing schema_version field".into()))?
            as u32;

        let attempt = match version {
            4 => {
                let mut att: ActiveAttempt = serde_json::from_value(val)?;
                if att.phase == AttemptPhase::LegacyRunning {
                    att.phase = AttemptPhase::RecoveryRequired;
                }
                att
            }
            1..=3 => return Err(SchedulerError::UnsupportedSchemaVersion(version)),
            other => return Err(SchedulerError::UnsupportedSchemaVersion(other)),
        };

        attempt.validate()?;
        Ok(Some(attempt))
    }

    pub fn save(&self, path: &Path) -> Result<(), SchedulerError> {
        self.validate()?;
        atomic_write_json(path, self)?;
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchReconciliation {
    Accepted { request_id: String },
    DefinitelyNotDispatched,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    Accepted {
        request_id: String,
        accepted_at_ms: i64,
    },
    KnownRejectedBeforeAcceptance {
        reason: String,
    },
    AmbiguousTransportFailure {
        error: String,
    },
    RecoveryRequired {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitOutcome {
    TuiIdle { elapsed_ms: u64 },
    TimedOut { elapsed_ms: u64 },
    Interrupted { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedExecutionIdentity {
    pub orca_version: String,
    pub worktree_id: String,
    pub terminal_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareOutcome {
    Ready(PreparedExecution),
    NotReady {
        execution: PreparedExecutionIdentity,
        reason: String,
    },
    Retryable {
        execution: Option<PreparedExecutionIdentity>,
        reason: String,
    },
    RecoveryRequired {
        execution: Option<PreparedExecutionIdentity>,
        reason: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupOutcome {
    VerifiedClosed { closed_at_ms: i64 },
    AlreadyAbsent { verified_at_ms: i64 },
    Retryable { reason: String },
    RecoveryRequired { code: String, message: String },
}

/// Boundary trait for job execution adapters.
/// V1.6 used monolithic execute().
/// V1.7 implements fine-grained prepare, dispatch, wait, close stages.
#[async_trait]
pub trait ExecutionAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    async fn is_ready(&self) -> bool;

    async fn prepare(
        &self,
        attempt: &ActiveAttempt,
        target: &LocalTarget,
    ) -> Result<PrepareOutcome, String>;

    async fn reconcile_dispatch(
        &self,
        attempt: &ActiveAttempt,
        terminal_id: &str,
    ) -> Result<DispatchReconciliation, String>;

    async fn dispatch(
        &self,
        attempt: &ActiveAttempt,
        terminal_id: &str,
        prompt_text: &str,
    ) -> Result<DispatchOutcome, String>;

    async fn wait(
        &self,
        attempt: &ActiveAttempt,
        terminal_id: &str,
        remaining_timeout: std::time::Duration,
    ) -> Result<WaitOutcome, String>;

    async fn close(&self, terminal_id: &str) -> CleanupOutcome;
}

/// Production fallback execution adapter: explicitly not ready, preventing premature claim.
pub struct UnavailableExecutionAdapter;

#[async_trait]
impl ExecutionAdapter for UnavailableExecutionAdapter {
    fn name(&self) -> &'static str {
        "unavailable"
    }

    async fn is_ready(&self) -> bool {
        false
    }

    async fn prepare(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<PrepareOutcome, String> {
        Ok(PrepareOutcome::RecoveryRequired {
            execution: None,
            reason: "UnavailableExecutionAdapter cannot prepare".into(),
        })
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        Err("UnavailableExecutionAdapter cannot reconcile dispatch".into())
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        Err("UnavailableExecutionAdapter cannot dispatch".into())
    }

    async fn wait(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _remaining_timeout: std::time::Duration,
    ) -> Result<WaitOutcome, String> {
        Err("UnavailableExecutionAdapter cannot wait".into())
    }

    async fn close(&self, _terminal_id: &str) -> CleanupOutcome {
        CleanupOutcome::AlreadyAbsent {
            verified_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// Fake execution adapter for testing the scheduler state machine.
pub struct FakeExecutionAdapter {
    pub ready: bool,
    pub report_to_produce: ExecutionReport,
}

#[async_trait]
impl ExecutionAdapter for FakeExecutionAdapter {
    fn name(&self) -> &'static str {
        "fake"
    }

    async fn is_ready(&self) -> bool {
        self.ready
    }

    async fn prepare(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<PrepareOutcome, String> {
        Ok(PrepareOutcome::Ready(PreparedExecution {
            orca_version: "1.4.209".into(),
            worktree_id: "wt_fake".into(),
            terminal_id: "term_fake".into(),
            agent_id: "fake_agent".into(),
            agent_ready_at_ms: chrono::Utc::now().timestamp_millis(),
        }))
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        Ok(DispatchReconciliation::DefinitelyNotDispatched)
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        Ok(DispatchOutcome::Accepted {
            request_id: "req_fake".into(),
            accepted_at_ms: chrono::Utc::now().timestamp_millis(),
        })
    }

    async fn wait(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _remaining_timeout: std::time::Duration,
    ) -> Result<WaitOutcome, String> {
        Ok(WaitOutcome::TuiIdle { elapsed_ms: 100 })
    }

    async fn close(&self, _terminal_id: &str) -> CleanupOutcome {
        CleanupOutcome::VerifiedClosed {
            closed_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

pub fn is_valid_attempt_id(id: &str) -> bool {
    let suffix = if let Some(s) = id.strip_prefix("att-") {
        s
    } else if let Some(s) = id.strip_prefix("att_") {
        s
    } else {
        return false;
    };
    uuid::Uuid::parse_str(suffix).is_ok()
}

pub fn parse_timestamp_strict(s: &str) -> Result<i64, String> {
    if let Ok(ts) = s.parse::<i64>() {
        return Ok(ts);
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .map_err(|e| format!("invalid RFC3339 timestamp '{s}': {e}"))
}

pub fn validate_claim_response(
    intent: &ActiveAttempt,
    response: &ClaimJobResponse,
) -> Result<(), SchedulerError> {
    if !response.ok {
        return Err(SchedulerError::ClaimCorrelationMismatch(
            "response.ok is false".into(),
        ));
    }
    if response.job.job_id != intent.job_id {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "job_id mismatch: expected '{}', got '{}'",
            intent.job_id, response.job.job_id
        )));
    }
    if response.job.workspace_id != intent.workspace_id {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "workspace_id mismatch: expected '{}', got '{}'",
            intent.workspace_id, response.job.workspace_id
        )));
    }
    if response.job.target_id != intent.target_id {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "target_id mismatch: expected '{}', got '{}'",
            intent.target_id, response.job.target_id
        )));
    }
    if response.attempt.attempt_id != intent.attempt_id {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "attempt_id mismatch: expected '{}', got '{}'",
            intent.attempt_id, response.attempt.attempt_id
        )));
    }
    if response.attempt.phase != "claimed" {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "attempt.phase mismatch: expected 'claimed', got '{}'",
            response.attempt.phase
        )));
    }
    if let Err(e) = parse_timestamp_strict(&response.attempt.claimed_at) {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "attempt.claimed_at is invalid: {e}"
        )));
    }
    if let Err(e) = parse_timestamp_strict(&response.server_time) {
        return Err(SchedulerError::ClaimCorrelationMismatch(format!(
            "server_time is invalid: {e}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{ClaimAttemptWire, ClaimedJobWire};

    #[test]
    fn test_is_valid_attempt_id() {
        assert!(is_valid_attempt_id(
            "att-00000000-0000-0000-0000-000000000001"
        ));
        assert!(is_valid_attempt_id(
            "att_00000000-0000-0000-0000-000000000001"
        ));
        assert!(!is_valid_attempt_id("00000000-0000-0000-0000-000000000001"));
        assert!(!is_valid_attempt_id("att-12345"));
        assert!(!is_valid_attempt_id("att_invalid"));
        assert!(!is_valid_attempt_id(""));
    }

    #[test]
    fn test_parse_timestamp_strict() {
        assert_eq!(
            parse_timestamp_strict("1727220000000").unwrap(),
            1727220000000
        );
        assert_eq!(
            parse_timestamp_strict("2026-09-24T19:00:00.000Z").unwrap(),
            1790276400000
        );
        assert!(parse_timestamp_strict("invalid-timestamp").is_err());
    }

    #[test]
    fn test_validate_claim_response_ok() {
        let intent = ActiveAttempt {
            schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
            server_origin: "https://server.test".into(),
            device_id: "dev_1".into(),
            job_id: "job-1".into(),
            workspace_id: "ws-1".into(),
            target_id: "tgt-1".into(),
            attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
            claim_token: "tok1".into(),
            phase: AttemptPhase::ClaimIntent,
            resource_id: None,
            prompt: None,
            acceptance: None,
            execution_timeout_seconds: None,
            result_target: None,
            payload_sha256: None,
            claimed_at_ms: None,
            terminal_report_sha256: None,
            executor: None,
        };

        let resp = ClaimJobResponse {
            ok: true,
            replayed: false,
            server_time: "2026-09-24T19:00:01.000Z".into(),
            attempt: ClaimAttemptWire {
                attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
                phase: "claimed".into(),
                claimed_at: "2026-09-24T19:00:01.000Z".into(),
                started_at: None,
            },
            job: ClaimedJobWire {
                job_id: "job-1".into(),
                workspace_id: "ws-1".into(),
                target_id: "tgt-1".into(),
                resource_id: None,
                prompt: "prompt".into(),
                acceptance: "acceptance".into(),
                timeout_seconds: 600,
                result_target: "none".into(),
            },
        };

        assert!(validate_claim_response(&intent, &resp).is_ok());
    }

    #[test]
    fn test_active_attempt_validate_invalid_attempt_id() {
        let mut intent = ActiveAttempt {
            schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
            server_origin: "https://server.test".into(),
            device_id: "dev_1".into(),
            job_id: "job-1".into(),
            workspace_id: "ws-1".into(),
            target_id: "tgt-1".into(),
            attempt_id: "att-invalid".into(),
            claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
            phase: AttemptPhase::ClaimIntent,
            resource_id: None,
            prompt: None,
            acceptance: None,
            execution_timeout_seconds: None,
            result_target: None,
            payload_sha256: None,
            claimed_at_ms: None,
            terminal_report_sha256: None,
            executor: None,
        };

        assert!(matches!(
            intent.validate(),
            Err(SchedulerError::CorruptState(_))
        ));
        intent.attempt_id = "att-00000000-0000-0000-0000-000000000001".into();
        assert!(intent.validate().is_ok());
    }

    #[test]
    fn test_active_attempt_schema_version_rejection_and_v4_loading() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("active-attempt.json");

        // Write a v1 schema JSON -> must return UnsupportedSchemaVersion(1)
        let v1_json = serde_json::json!({
            "schema_version": 1,
            "server_origin": "https://server.test",
            "device_id": "dev_1",
            "job_id": "job_1",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-00000000-0000-0000-0000-000000000001",
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "claim_intent",
            "resource_id": null,
            "prompt": null,
            "acceptance": null,
            "execution_timeout_seconds": null,
            "result_target": null,
            "payload_sha256": null,
            "claimed_at_ms": null,
            "terminal_report_sha256": null
        });
        std::fs::write(&path, serde_json::to_string(&v1_json).unwrap()).unwrap();

        let err = ActiveAttempt::load(&path).unwrap_err();
        assert!(matches!(err, SchedulerError::UnsupportedSchemaVersion(1)));

        // Write a valid v4 schema JSON -> loads cleanly
        let v4_json = serde_json::json!({
            "schema_version": 4,
            "server_origin": "https://server.test",
            "device_id": "dev_1",
            "job_id": "job_1",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-00000000-0000-0000-0000-000000000001",
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "claim_intent",
            "resource_id": null,
            "prompt": null,
            "acceptance": null,
            "execution_timeout_seconds": null,
            "result_target": null,
            "payload_sha256": null,
            "claimed_at_ms": null,
            "terminal_report_sha256": null,
            "executor": null
        });
        std::fs::write(&path, serde_json::to_string(&v4_json).unwrap()).unwrap();

        let loaded = ActiveAttempt::load(&path).unwrap().unwrap();
        assert_eq!(loaded.schema_version, ACTIVE_ATTEMPT_SCHEMA_VERSION);
        assert_eq!(loaded.phase, AttemptPhase::ClaimIntent);
        assert!(loaded.executor.is_none());
    }
}
