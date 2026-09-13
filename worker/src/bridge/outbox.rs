//! Durable pending execution-report payloads under `.ceo/bridge/outbox`.
//!
//! An outbox record stores the exact `ExecutionReportRequest` decided at local
//! finalization. Delivery (5.3) retries that payload; it never re-interprets
//! receipt/history into a different report.

use crate::bridge::client::{claim_token_ok, job_id_ok, uuid_ok, worker_id_ok};
use crate::bridge::protocol::ExecutionReportRequest;
use crate::bridge::report::validate_report_contract;
use crate::bridge::state::{
    self, outbox_dir, outbox_record_path, BridgeBinding, LOCAL_BINDING_MISMATCH,
    LOCAL_STATE_INVALID,
};
use crate::local_state::atomic_write_json;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

pub const OUTBOX_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub enum OutboxError {
    Missing,
    Invalid(String),
    BindingMismatch(String),
    Io(String),
}

impl fmt::Display for OutboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OutboxError::Missing => write!(f, "pending report is missing"),
            OutboxError::Invalid(m) => write!(f, "{LOCAL_STATE_INVALID}: {m}"),
            OutboxError::BindingMismatch(m) => write!(f, "{LOCAL_BINDING_MISMATCH}: {m}"),
            OutboxError::Io(m) => write!(f, "outbox io: {m}"),
        }
    }
}

impl std::error::Error for OutboxError {}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PendingReportRecord {
    pub schema_version: u32,
    pub server_origin: String,
    pub user_id: String,
    pub workspace_id: String,
    pub workspace_ref: String,
    pub job_id: String,
    pub attempt_id: String,
    pub worker_id: String,
    pub receipt_sha256: String,
    pub request: ExecutionReportRequest,
    pub created_at: String,
}

impl fmt::Debug for PendingReportRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingReportRecord")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("user_id", &self.user_id)
            .field("workspace_id", &self.workspace_id)
            .field("workspace_ref", &self.workspace_ref)
            .field("job_id", &self.job_id)
            .field("attempt_id", &self.attempt_id)
            .field("worker_id", &self.worker_id)
            .field("receipt_sha256", &self.receipt_sha256)
            .field("request", &self.request)
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl PendingReportRecord {
    pub fn from_request(
        binding: &BridgeBinding,
        job_id: &str,
        request: ExecutionReportRequest,
    ) -> Result<Self, OutboxError> {
        let rec = PendingReportRecord {
            schema_version: OUTBOX_SCHEMA_VERSION,
            server_origin: binding.server_origin.clone(),
            user_id: binding.user_id.clone(),
            workspace_id: binding.workspace_id.clone(),
            workspace_ref: binding.workspace_ref.clone(),
            job_id: job_id.to_string(),
            attempt_id: request.attempt_id.clone(),
            worker_id: request.worker_id.clone(),
            receipt_sha256: request.report.receipt_sha256.clone(),
            request,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        rec.validate(Some(binding))?;
        Ok(rec)
    }

    fn validate(&self, expected: Option<&BridgeBinding>) -> Result<(), OutboxError> {
        if self.schema_version != OUTBOX_SCHEMA_VERSION {
            return Err(OutboxError::Invalid(format!(
                "unsupported outbox schema_version {}",
                self.schema_version
            )));
        }
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            return Err(OutboxError::Invalid(
                "created_at is not RFC3339".to_string(),
            ));
        }
        if !job_id_ok(&self.job_id) {
            return Err(OutboxError::Invalid("job_id is invalid".to_string()));
        }
        if !uuid_ok(&self.attempt_id) {
            return Err(OutboxError::Invalid("attempt_id is invalid".to_string()));
        }
        if !worker_id_ok(&self.worker_id) {
            return Err(OutboxError::Invalid("worker_id is invalid".to_string()));
        }
        if !claim_token_ok(&self.request.claim_token) {
            return Err(OutboxError::Invalid("claim token is invalid".to_string()));
        }
        if self.request.worker_id != self.worker_id {
            return Err(OutboxError::Invalid(
                "request worker_id does not match the record".to_string(),
            ));
        }
        if self.request.attempt_id != self.attempt_id {
            return Err(OutboxError::Invalid(
                "request attempt_id does not match the record".to_string(),
            ));
        }
        if self.request.report.receipt_sha256 != self.receipt_sha256 {
            return Err(OutboxError::Invalid(
                "request receipt_sha256 does not match the record".to_string(),
            ));
        }
        if let Some(binding) = expected {
            if self.server_origin != binding.server_origin
                || self.user_id != binding.user_id
                || self.workspace_id != binding.workspace_id
                || self.workspace_ref != binding.workspace_ref
            {
                return Err(OutboxError::BindingMismatch(
                    "pending report identity does not match the configured binding".to_string(),
                ));
            }
        }
        validate_report_contract(&self.request).map_err(|e| OutboxError::Invalid(e.to_string()))?;
        Ok(())
    }

    pub fn persist(&self, workspace: &Path) -> Result<(), OutboxError> {
        self.validate(None)?;
        state::ensure_control_dirs(workspace).map_err(|e| OutboxError::Io(e.to_string()))?;
        let p = outbox_record_path(workspace, &self.job_id, &self.attempt_id);
        state::reject_symlink_target(&p).map_err(|e| OutboxError::Io(e.to_string()))?;
        atomic_write_json(&p, self).map_err(|e| OutboxError::Io(e.to_string()))
    }

    pub fn load(
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
        binding: &BridgeBinding,
    ) -> Result<Self, OutboxError> {
        match Self::try_load(workspace, job_id, attempt_id, binding)? {
            Some(rec) => Ok(rec),
            None => Err(OutboxError::Missing),
        }
    }

    pub fn try_load(
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
        binding: &BridgeBinding,
    ) -> Result<Option<Self>, OutboxError> {
        if !job_id_ok(job_id) || !uuid_ok(attempt_id) {
            return Err(OutboxError::Invalid(
                "job/attempt id is invalid".to_string(),
            ));
        }
        state::reject_control_ancestor_symlinks(workspace)
            .map_err(|e| OutboxError::Io(e.to_string()))?;
        let p = outbox_record_path(workspace, job_id, attempt_id);
        state::reject_symlink_target(&p).map_err(|e| OutboxError::Io(e.to_string()))?;
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(OutboxError::Io(e.to_string())),
        };
        let rec: PendingReportRecord = serde_json::from_str(&text)
            .map_err(|e| OutboxError::Invalid(format!("pending report parse error: {e}")))?;
        rec.validate(Some(binding))?;
        if rec.job_id != job_id || rec.attempt_id != attempt_id {
            return Err(OutboxError::Invalid(
                "pending report identity does not match the path".to_string(),
            ));
        }
        Ok(Some(rec))
    }
}

/// Lists every pending record. Unexpected or corrupt files fail closed.
pub fn list_pending(
    workspace: &Path,
    binding: &BridgeBinding,
) -> Result<Vec<PendingReportRecord>, OutboxError> {
    state::reject_control_ancestor_symlinks(workspace)
        .map_err(|e| OutboxError::Io(e.to_string()))?;
    let dir = outbox_dir(workspace);
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(OutboxError::Io(e.to_string())),
    };
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| OutboxError::Io(e.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Some((job_id, attempt_id)) = parse_outbox_name(&name) else {
            return Err(OutboxError::Invalid(format!(
                "unexpected pending filename {name}"
            )));
        };
        let rec = PendingReportRecord::load(workspace, &job_id, &attempt_id, binding)?;
        out.push(rec);
    }
    out.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.job_id.cmp(&b.job_id))
            .then_with(|| a.attempt_id.cmp(&b.attempt_id))
    });
    Ok(out)
}

fn parse_outbox_name(name: &str) -> Option<(String, String)> {
    let stem = name.strip_suffix(".json")?;
    let (job, attempt) = stem.split_once('.')?;
    if job_id_ok(job) && uuid_ok(attempt) {
        Some((job.to_string(), attempt.to_string()))
    } else {
        None
    }
}
