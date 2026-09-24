use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::Path;
use thiserror::Error;

use crate::config::LocalTarget;
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
    pub phase: String,
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
        acceptance: Option<&str>,
        execution_timeout_seconds: u32,
        result_target: Option<&str>,
    ) -> String {
        let mut hasher = Sha256::new();
        hasher.update(job_id.as_bytes());
        hasher.update(b":");
        hasher.update(workspace_id.as_bytes());
        hasher.update(b":");
        hasher.update(target_id.as_bytes());
        hasher.update(b":");
        hasher.update(resource_id.unwrap_or("").as_bytes());
        hasher.update(b":");
        hasher.update(prompt.as_bytes());
        hasher.update(b":");
        hasher.update(acceptance.unwrap_or("").as_bytes());
        hasher.update(b":");
        hasher.update(execution_timeout_seconds.to_string().as_bytes());
        hasher.update(b":");
        hasher.update(result_target.unwrap_or("").as_bytes());
        format!("{:x}", hasher.finalize())
    }

    pub fn load(path: &Path) -> Result<Option<Self>, SchedulerError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let attempt: ActiveAttempt = serde_json::from_str(&content)?;
        if attempt.schema_version != ACTIVE_ATTEMPT_SCHEMA_VERSION {
            return Err(SchedulerError::UnsupportedSchemaVersion(
                attempt.schema_version,
            ));
        }

        // If payload_sha256 is present, verify integrity
        if let (Some(ref expected_hash), Some(ref prompt)) =
            (&attempt.payload_sha256, &attempt.prompt)
        {
            let computed = Self::compute_payload_sha256(
                &attempt.job_id,
                &attempt.workspace_id,
                &attempt.target_id,
                attempt.resource_id.as_deref(),
                prompt,
                attempt.acceptance.as_deref(),
                attempt.execution_timeout_seconds.unwrap_or(0),
                attempt.result_target.as_deref(),
            );
            if computed != *expected_hash {
                return Err(SchedulerError::PayloadHashMismatch);
            }
        }

        Ok(Some(attempt))
    }

    pub fn save(&self, path: &Path) -> Result<(), SchedulerError> {
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
    ) -> Result<serde_json::Value, String>;
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
    ) -> Result<serde_json::Value, String> {
        Err("Execution adapter not available in V1.6 (deferred to V1.7)".into())
    }
}

/// Fake execution adapter for testing the scheduler state machine.
pub struct FakeExecutionAdapter {
    pub ready: bool,
    pub report_to_produce: serde_json::Value,
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
    ) -> Result<serde_json::Value, String> {
        Ok(self.report_to_produce.clone())
    }
}
