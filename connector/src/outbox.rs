use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::Path;
use thiserror::Error;

use sha2::{Digest, Sha256};

use crate::client::{ClientError, ConnectorClient};
use crate::credential::DeviceCredential;
use crate::execution_contract::ExecutionReport;
use crate::local_state::{atomic_write_json, remove_durable, ExecutionLock};
use crate::paths::ConnectorPaths;
use crate::scheduler::{ActiveAttempt, AttemptPhase};

pub const OUTBOX_SCHEMA_VERSION: u32 = 1;
pub const HISTORY_SCHEMA_VERSION: u32 = 1;

pub fn compute_report_sha256(report: &ExecutionReport) -> String {
    let bytes = serde_json::to_vec(report).expect("report serialization failed");
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Error, Debug)]
pub enum OutboxError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unsupported schema version: {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("Outbox identity mismatch: expected server '{expected_server}' / device '{expected_device}', but got '{actual_server}' / '{actual_device}' (RECOVERY_REQUIRED)")]
    IdentityMismatch {
        expected_server: String,
        expected_device: String,
        actual_server: String,
        actual_device: String,
    },
    #[error("Invalid report contract: {0}")]
    InvalidReport(String),
    #[error("Authentication required / 401 Unauthorized")]
    AuthRequired,
    #[error("Terminal conflict or invalid report lifecycle: {0} (RECOVERY_REQUIRED)")]
    RecoveryRequired(String),
    #[error("Retryable delivery failure: {0}")]
    Retryable(String),
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OutboxRecord {
    pub schema_version: u32,
    pub server_origin: String,
    pub device_id: String,
    pub job_id: String,
    pub attempt_id: String,
    pub claim_token: String,
    pub report: ExecutionReport,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_result: Option<crate::managed_result::ManagedResultEnvelope>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed_result_sha256: Option<String>,
    pub created_at_ms: i64,
}

impl fmt::Debug for OutboxRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OutboxRecord")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("device_id", &self.device_id)
            .field("job_id", &self.job_id)
            .field("attempt_id", &self.attempt_id)
            .field("claim_token", &"[REDACTED]")
            .field("report", &"[REDACTED]")
            .field("created_at_ms", &self.created_at_ms)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SanitizedHistoryRecord {
    pub schema_version: u32,
    pub job_id: String,
    pub attempt_id: String,
    pub target_id: String,
    pub status: String,
    pub receipt_sha256: Option<String>,
    pub duration_ms: Option<i64>,
    pub terminal_report_sha256: String,
    pub recorded_at_ms: i64,
}

impl OutboxRecord {
    pub fn load(path: &Path) -> Result<Self, OutboxError> {
        let content = fs::read_to_string(path)?;
        let record: OutboxRecord = serde_json::from_str(&content)?;
        if record.schema_version != OUTBOX_SCHEMA_VERSION {
            return Err(OutboxError::UnsupportedSchemaVersion(record.schema_version));
        }
        record
            .report
            .validate()
            .map_err(|e| OutboxError::InvalidReport(e.to_string()))?;
        Ok(record)
    }

    pub fn save(&self, path: &Path) -> Result<(), OutboxError> {
        self.report
            .validate()
            .map_err(|e| OutboxError::InvalidReport(e.to_string()))?;
        atomic_write_json(path, self)?;
        Ok(())
    }
}

/// Delivers a single persisted outbox record to the server and handles terminal cleanup.
pub async fn deliver_outbox_record(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    cred: &DeviceCredential,
    outbox_file: &Path,
    record: &OutboxRecord,
) -> Result<(), OutboxError> {
    // Identity verification
    if cred.server_origin != record.server_origin || cred.device_id != record.device_id {
        return Err(OutboxError::IdentityMismatch {
            expected_server: cred.server_origin.clone(),
            expected_device: cred.device_id.clone(),
            actual_server: record.server_origin.clone(),
            actual_device: record.device_id.clone(),
        });
    }

    // Sequential delivery: Result ACK strictly before Report ACK
    if let (Some(ref result), Some(ref digest)) = (&record.managed_result, &record.managed_result_sha256) {
        let result_res = client
            .submit_job_result(
                cred,
                &record.job_id,
                &record.attempt_id,
                &record.claim_token,
                result,
                digest,
            )
            .await;

        match result_res {
            Ok(_res) => {}
            Err(ClientError::Unauthorized) => {
                return Err(OutboxError::AuthRequired);
            }
            Err(ClientError::JobError { code, message }) => {
                return Err(OutboxError::RecoveryRequired(format!("{code}: {message}")));
            }
            Err(ClientError::ServerUnavailable { status, message }) => {
                return Err(OutboxError::Retryable(format!(
                    "Server returned {status}: {message}"
                )));
            }
            Err(ClientError::Http(e)) => {
                return Err(OutboxError::Retryable(format!("HTTP error: {e}")));
            }
            Err(other) => {
                return Err(OutboxError::RecoveryRequired(format!(
                    "Unexpected client error on result submit: {other}"
                )));
            }
        }
    }

    let report_res = client
        .report_job(
            cred,
            &record.job_id,
            &record.attempt_id,
            &record.claim_token,
            &record.report,
        )
        .await;

    match report_res {
        Ok(_ack) => {
            let report_sha256 = compute_report_sha256(&record.report);

            // Success (HTTP 200 or replayed)! Perform durable terminal cleanup under state.lock
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                std::time::Duration::from_secs(5),
                std::time::Duration::from_millis(50),
            )?;

            // Verify active attempt correlation (phase finalized_local + digests match)
            let active_opt = ActiveAttempt::load(&paths.active_attempt_file()).map_err(|e| {
                OutboxError::RecoveryRequired(format!("failed to load active attempt: {e}"))
            })?;

            let target_id = if let Some(active) = active_opt {
                if active.job_id != record.job_id || active.attempt_id != record.attempt_id {
                    return Err(OutboxError::RecoveryRequired(format!(
                        "Active attempt '{}/{}' does not match outbox '{}/{}'",
                        active.job_id, active.attempt_id, record.job_id, record.attempt_id
                    )));
                }
                if active.phase != AttemptPhase::FinalizedLocal {
                    return Err(OutboxError::RecoveryRequired(format!(
                        "Active attempt phase '{:?}' is not finalized_local",
                        active.phase
                    )));
                }
                if active.terminal_report_sha256.as_deref() != Some(&report_sha256) {
                    return Err(OutboxError::RecoveryRequired(format!(
                        "Active attempt terminal_report_sha256 mismatch: active '{:?}' vs outbox '{}'",
                        active.terminal_report_sha256, report_sha256
                    )));
                }
                active.target_id
            } else {
                return Err(OutboxError::RecoveryRequired(
                    "Active attempt missing during outbox delivery cleanup".into(),
                ));
            };

            let status_str = match record.report.execution_status {
                crate::execution_contract::ExecutionStatus::COMPLETED => "completed",
                _ => "failed",
            };

            let history = SanitizedHistoryRecord {
                schema_version: HISTORY_SCHEMA_VERSION,
                job_id: record.job_id.clone(),
                attempt_id: record.attempt_id.clone(),
                target_id,
                status: status_str.to_string(),
                receipt_sha256: Some(record.report.receipt_sha256.clone()),
                duration_ms: Some(record.report.duration_ms),
                terminal_report_sha256: report_sha256,
                recorded_at_ms: chrono::Utc::now().timestamp_millis(),
            };

            // 1. Write sanitized history record
            let hist_file = paths.history_file(&record.job_id, &record.attempt_id);
            atomic_write_json(&hist_file, &history)?;

            // 2. Durably unlink outbox record
            remove_durable(outbox_file)?;

            // 3. Durably unlink active attempt
            remove_durable(&paths.active_attempt_file())?;

            // 4. Clean up attempt runtime dir if present
            let runtime_attempt_dir = paths.attempt_runtime_dir(&record.attempt_id);
            if runtime_attempt_dir.exists() {
                let _ = fs::remove_dir_all(&runtime_attempt_dir);
            }

            Ok(())
        }
        Err(ClientError::Unauthorized) => {
            // 401 Unauthorized: retain outbox, transition to AUTH_REQUIRED
            Err(OutboxError::AuthRequired)
        }
        Err(ClientError::JobError { code, message }) => {
            // Confirmed server rejections / conflict / invalid lifecycle: retain outbox and enter RECOVERY_REQUIRED
            Err(OutboxError::RecoveryRequired(format!("{code}: {message}")))
        }
        Err(ClientError::ServerUnavailable { status, message }) => {
            // 5xx / 429: retryable
            Err(OutboxError::Retryable(format!(
                "Server returned {status}: {message}"
            )))
        }
        Err(ClientError::Http(e)) => {
            // Transport / network failure: retryable
            Err(OutboxError::Retryable(format!("HTTP error: {e}")))
        }
        Err(other) => Err(OutboxError::RecoveryRequired(format!(
            "Unexpected client error: {other}"
        ))),
    }
}

/// Flushes all pending outbox records in the outbox directory.
pub async fn flush_outbox(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    cred: &DeviceCredential,
) -> Result<usize, OutboxError> {
    if !paths.outbox_dir().exists() {
        return Ok(0);
    }

    let mut delivered_count = 0;
    for entry in fs::read_dir(paths.outbox_dir())? {
        let entry = entry?;
        let path = entry.path();
        if path.is_file() && path.extension().and_then(|e| e.to_str()) == Some("json") {
            let record = OutboxRecord::load(&path)?;
            deliver_outbox_record(paths, client, cred, &path, &record).await?;
            delivered_count += 1;
        }
    }

    Ok(delivered_count)
}
