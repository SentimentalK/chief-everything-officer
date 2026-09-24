use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::Path;
use thiserror::Error;

use crate::config::LocalTarget;
use crate::execution_contract::ExecutionReport;
use crate::local_state::atomic_write_json;

pub const ACTIVE_ATTEMPT_SCHEMA_VERSION: u32 = 1;

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
    #[error("Corrupt active attempt state: {0}")]
    CorruptState(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptPhase {
    ClaimIntent,
    Claimed,
    StartIntent,
    Started,
    Running,
    FinalizedLocal,
    RecoveryRequired,
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

        if self.attempt_id.is_empty()
            || !self.attempt_id.starts_with("att-")
            || self.attempt_id.len() > 128
        {
            return Err(SchedulerError::CorruptState(format!(
                "invalid attempt_id format: '{}'",
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
            | AttemptPhase::Running => {
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
            AttemptPhase::RecoveryRequired => {
                // Remains blocking
            }
        }

        Ok(())
    }

    pub fn load(path: &Path) -> Result<Option<Self>, SchedulerError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let attempt: ActiveAttempt = serde_json::from_str(&content)?;
        attempt.validate()?;
        Ok(Some(attempt))
    }

    pub fn save(&self, path: &Path) -> Result<(), SchedulerError> {
        self.validate()?;
        atomic_write_json(path, self)?;
        Ok(())
    }
}

/// Boundary trait for job execution adapters.
/// V1.6 uses `UnavailableExecutionAdapter` (never claims).
/// Tests use `FakeExecutionAdapter`.
/// V1.7 implements `OrcaExecutionAdapter`.
#[async_trait]
pub trait ExecutionAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    async fn is_ready(&self) -> bool;
    async fn execute(
        &self,
        attempt: &ActiveAttempt,
        target: &LocalTarget,
    ) -> Result<ExecutionReport, String>;
}

/// Production V1.6 execution adapter: explicitly not ready, preventing premature claim.
pub struct UnavailableExecutionAdapter;

#[async_trait]
impl ExecutionAdapter for UnavailableExecutionAdapter {
    fn name(&self) -> &'static str {
        "unavailable"
    }

    async fn is_ready(&self) -> bool {
        false
    }

    async fn execute(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<ExecutionReport, String> {
        Err("Execution adapter not available in V1.6 (deferred to V1.7)".into())
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

    async fn execute(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<ExecutionReport, String> {
        Ok(self.report_to_produce.clone())
    }
}
