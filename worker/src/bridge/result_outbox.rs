//! Durable pending execution-result payloads under `.ceo/bridge/result-outbox`.
//!
//! An outbox record stores the metadata and verification details needed to deliver
//! a managed result to the CEO Server before submitting the final execution report.

use crate::bridge::client::{claim_token_ok, job_id_ok, uuid_ok, worker_id_ok};
use crate::bridge::state::{
    self, result_outbox_dir, result_outbox_record_path, BridgeBinding, LOCAL_BINDING_MISMATCH,
    LOCAL_STATE_INVALID,
};
use crate::local_state::atomic_write_json;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::Path;

pub const RESULT_OUTBOX_SCHEMA_VERSION: u32 = 1;

#[derive(Debug)]
pub enum ResultOutboxError {
    Missing,
    Invalid(String),
    BindingMismatch(String),
    Io(String),
}

impl fmt::Display for ResultOutboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ResultOutboxError::Missing => write!(f, "pending result is missing"),
            ResultOutboxError::Invalid(m) => write!(f, "{LOCAL_STATE_INVALID}: {m}"),
            ResultOutboxError::BindingMismatch(m) => write!(f, "{LOCAL_BINDING_MISMATCH}: {m}"),
            ResultOutboxError::Io(m) => write!(f, "result outbox io: {m}"),
        }
    }
}

impl std::error::Error for ResultOutboxError {}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PendingResultRecord {
    pub schema_version: u32,
    pub server_origin: String,
    pub user_id: String,
    pub workspace_id: String,
    pub workspace_ref: String,
    pub job_id: String,
    pub attempt_id: String,
    pub worker_id: String,
    pub resource_id: String,
    pub claim_token: String,
    pub result_file_path: String,
    pub result_file_sha256: String,
    pub created_at: String,
}

impl fmt::Debug for PendingResultRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingResultRecord")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("user_id", &self.user_id)
            .field("workspace_id", &self.workspace_id)
            .field("workspace_ref", &self.workspace_ref)
            .field("job_id", &self.job_id)
            .field("attempt_id", &self.attempt_id)
            .field("worker_id", &self.worker_id)
            .field("resource_id", &self.resource_id)
            .field("claim_token", &"[redacted]")
            .field("result_file_path", &self.result_file_path)
            .field("result_file_sha256", &self.result_file_sha256)
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl PendingResultRecord {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        binding: &BridgeBinding,
        worker_id: &str,
        job_id: &str,
        attempt_id: &str,
        resource_id: &str,
        claim_token: &str,
        result_file_path: &str,
        result_file_sha256: &str,
    ) -> Result<Self, ResultOutboxError> {
        let rec = PendingResultRecord {
            schema_version: RESULT_OUTBOX_SCHEMA_VERSION,
            server_origin: binding.server_origin.clone(),
            user_id: binding.user_id.clone(),
            workspace_id: binding.workspace_id.clone(),
            workspace_ref: binding.workspace_ref.clone(),
            job_id: job_id.to_string(),
            attempt_id: attempt_id.to_string(),
            worker_id: worker_id.to_string(),
            resource_id: resource_id.to_string(),
            claim_token: claim_token.to_string(),
            result_file_path: result_file_path.to_string(),
            result_file_sha256: result_file_sha256.to_string(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        rec.validate(Some(binding))?;
        Ok(rec)
    }

    pub fn validate(&self, expected: Option<&BridgeBinding>) -> Result<(), ResultOutboxError> {
        if self.schema_version != RESULT_OUTBOX_SCHEMA_VERSION {
            return Err(ResultOutboxError::Invalid(format!(
                "unsupported result outbox schema_version {}",
                self.schema_version
            )));
        }
        if chrono::DateTime::parse_from_rfc3339(&self.created_at).is_err() {
            return Err(ResultOutboxError::Invalid(
                "created_at is not RFC3339".to_string(),
            ));
        }
        if !job_id_ok(&self.job_id) {
            return Err(ResultOutboxError::Invalid("job_id is invalid".to_string()));
        }
        if !uuid_ok(&self.attempt_id) {
            return Err(ResultOutboxError::Invalid(
                "attempt_id is invalid".to_string(),
            ));
        }
        if !worker_id_ok(&self.worker_id) {
            return Err(ResultOutboxError::Invalid(
                "worker_id is invalid".to_string(),
            ));
        }
        if !claim_token_ok(&self.claim_token) {
            return Err(ResultOutboxError::Invalid(
                "claim token is invalid".to_string(),
            ));
        }
        if self.resource_id.trim().is_empty() {
            return Err(ResultOutboxError::Invalid(
                "resource_id must be non-empty".to_string(),
            ));
        }
        if self.result_file_path.trim().is_empty() {
            return Err(ResultOutboxError::Invalid(
                "result_file_path must be non-empty".to_string(),
            ));
        }
        if self.result_file_sha256.len() != 64 {
            return Err(ResultOutboxError::Invalid(
                "result_file_sha256 must be 64 hex chars".to_string(),
            ));
        }
        if let Some(binding) = expected {
            if self.server_origin != binding.server_origin
                || self.user_id != binding.user_id
                || self.workspace_id != binding.workspace_id
                || self.workspace_ref != binding.workspace_ref
            {
                return Err(ResultOutboxError::BindingMismatch(
                    "pending result identity does not match configured binding".to_string(),
                ));
            }
        }
        Ok(())
    }

    pub fn persist(&self, workspace: &Path) -> Result<(), ResultOutboxError> {
        self.validate(None)?;
        state::ensure_control_dirs(workspace).map_err(|e| ResultOutboxError::Io(e.to_string()))?;
        let p = result_outbox_record_path(workspace, &self.job_id, &self.attempt_id);
        state::reject_symlink_target(&p).map_err(|e| ResultOutboxError::Io(e.to_string()))?;
        atomic_write_json(&p, self).map_err(|e| ResultOutboxError::Io(e.to_string()))
    }

    pub fn load(
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
        binding: &BridgeBinding,
    ) -> Result<Self, ResultOutboxError> {
        match Self::try_load(workspace, job_id, attempt_id, binding)? {
            Some(rec) => Ok(rec),
            None => Err(ResultOutboxError::Missing),
        }
    }

    pub fn try_load(
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
        binding: &BridgeBinding,
    ) -> Result<Option<Self>, ResultOutboxError> {
        if !job_id_ok(job_id) || !uuid_ok(attempt_id) {
            return Err(ResultOutboxError::Invalid(
                "job/attempt id is invalid".to_string(),
            ));
        }
        state::reject_control_ancestor_symlinks(workspace)
            .map_err(|e| ResultOutboxError::Io(e.to_string()))?;
        let p = result_outbox_record_path(workspace, job_id, attempt_id);
        state::reject_symlink_target(&p).map_err(|e| ResultOutboxError::Io(e.to_string()))?;
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(ResultOutboxError::Io(e.to_string())),
        };
        let rec: PendingResultRecord = serde_json::from_str(&text)
            .map_err(|e| ResultOutboxError::Invalid(format!("pending result parse error: {e}")))?;
        rec.validate(Some(binding))?;
        if rec.job_id != job_id || rec.attempt_id != attempt_id {
            return Err(ResultOutboxError::Invalid(
                "pending result identity does not match the path".to_string(),
            ));
        }
        Ok(Some(rec))
    }
}

pub fn parse_result_outbox_name(name: &str) -> Option<(String, String)> {
    let rest = name.strip_suffix(".json")?;
    let (job_id, attempt_id) = rest.split_once('.')?;
    if !job_id_ok(job_id) || !uuid_ok(attempt_id) {
        return None;
    }
    Some((job_id.to_string(), attempt_id.to_string()))
}

/// Lists every pending result record in FIFO order.
pub fn list_pending(
    workspace: &Path,
    binding: &BridgeBinding,
) -> Result<Vec<PendingResultRecord>, ResultOutboxError> {
    state::reject_control_ancestor_symlinks(workspace)
        .map_err(|e| ResultOutboxError::Io(e.to_string()))?;
    let dir = result_outbox_dir(workspace);
    let rd = match std::fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(ResultOutboxError::Io(e.to_string())),
    };
    let mut out = Vec::new();
    for entry in rd {
        let entry = entry.map_err(|e| ResultOutboxError::Io(e.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let Some((job_id, attempt_id)) = parse_result_outbox_name(&name) else {
            return Err(ResultOutboxError::Invalid(format!(
                "unexpected pending result filename {name}"
            )));
        };
        let rec = PendingResultRecord::load(workspace, &job_id, &attempt_id, binding)?;
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
