//! Load a finalized local Bridge attempt and report it to the Server once.
//!
//! This command never claims, starts, reruns, or mutates receipt/history/state.

use crate::bridge::client::{
    claim_token_ok, job_id_ok, public_state_for_execution_status, uuid_ok, worker_id_ok,
    BridgeClient, ClientError,
};
use crate::bridge::config::{load_api_key, BridgeConfig};
use crate::bridge::protocol::{
    ExecutionReportBody, ExecutionReportError, ExecutionReportOk, ExecutionReportRequest,
};
use crate::bridge::state::{
    self, AttemptHistoryRecord, BridgeBinding, BridgeState, LOCAL_BINDING_MISMATCH,
    LOCAL_STATE_INVALID,
};
use crate::config::{is_subpath, safe_attempt_dir};
use crate::local_state::ExecutionLock;
use crate::receipt::TaskReceipt;
use crate::verifier::BusinessOutcome;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;

const MAX_REPORT_REQUEST_BYTES: usize = 8 * 1024;
const MAX_ERROR_MESSAGE_BYTES: usize = 2 * 1024;
const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const ALLOWED_EXECUTION: &[&str] = &[
    "COMPLETED",
    "FAILED",
    "TIMED_OUT",
    "CANCELLED",
    "BLOCKED",
    "INTERRUPTED",
];

#[derive(Debug)]
pub enum ReportError {
    InvalidId(&'static str),
    Config(String),
    Busy(String),
    Local { code: &'static str, message: String },
    Client(ClientError),
}

impl fmt::Display for ReportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReportError::InvalidId(field) => write!(f, "invalid {field}"),
            ReportError::Config(m) => write!(f, "config error: {m}"),
            ReportError::Busy(m) => write!(f, "workspace busy: {m}"),
            ReportError::Local { code, message } => write!(f, "{code}: {message}"),
            ReportError::Client(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for ReportError {}

fn local(code: &'static str, message: impl Into<String>) -> ReportError {
    ReportError::Local {
        code,
        message: message.into(),
    }
}

pub fn print_error(err: &ReportError) {
    eprintln!("{err}");
    if let ReportError::Client(c) = err {
        if c.outcome_unknown {
            eprintln!("Report outcome is unknown; rerun the same command.");
            eprintln!("The task will not be executed again.");
        }
    }
}

fn expected_binding(cfg: &BridgeConfig, workspace_ref: &str, workspace: &Path) -> BridgeBinding {
    BridgeBinding {
        server_origin: cfg.server_base.as_str().trim_end_matches('/').to_string(),
        user_id: cfg.expected_identity.user_id.clone(),
        workspace_id: cfg.expected_identity.workspace_id.clone(),
        workspace_ref: workspace_ref.to_string(),
        canonical_workspace: workspace.to_path_buf(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

fn read_workspace_file(workspace: &Path, path: &Path) -> Result<Vec<u8>, ReportError> {
    state::reject_symlink_target(path).map_err(|e| local("PATH_INVALID", e.to_string()))?;
    let meta = std::fs::symlink_metadata(path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            local("FILE_MISSING", "required local file is missing")
        } else {
            local("PATH_INVALID", e.to_string())
        }
    })?;
    if !meta.file_type().is_file() {
        return Err(local("PATH_INVALID", "path is not a regular file"));
    }
    let canon = path
        .canonicalize()
        .map_err(|e| local("PATH_INVALID", e.to_string()))?;
    if !is_subpath(workspace, &canon) {
        return Err(local(
            "PATH_INVALID",
            "resolved path is outside the workspace",
        ));
    }
    std::fs::read(path).map_err(|e| local("FILE_MISSING", e.to_string()))
}

fn validate_ids(job_id: &str, attempt_id: &str) -> Result<(), ReportError> {
    if !job_id_ok(job_id) {
        return Err(ReportError::InvalidId("job_id"));
    }
    if !uuid_ok(attempt_id) {
        return Err(ReportError::InvalidId("attempt_id"));
    }
    Ok(())
}

fn stage_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn error_code_ok(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| matches!(b, b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn validate_report_contract(req: &ExecutionReportRequest) -> Result<(), ReportError> {
    if !worker_id_ok(&req.worker_id) {
        return Err(local("INVALID_REPORT", "worker_id is not a wrk-<uuid>"));
    }
    if !uuid_ok(&req.attempt_id) {
        return Err(local("INVALID_REPORT", "attempt_id is not a UUID"));
    }
    if !claim_token_ok(&req.claim_token) {
        return Err(local(
            "INVALID_REPORT",
            "claim token is not 64 lowercase hex",
        ));
    }
    if req.report.schema_version != 1 {
        return Err(local("INVALID_REPORT", "schema_version must be 1"));
    }
    if !ALLOWED_EXECUTION.contains(&req.report.execution_status.as_str()) {
        return Err(local(
            "UNSUPPORTED_STATUS",
            "execution_status is not reportable",
        ));
    }
    if public_state_for_execution_status(&req.report.execution_status).is_none() {
        return Err(local(
            "UNSUPPORTED_STATUS",
            "execution_status is not reportable",
        ));
    }
    match req.report.business_outcome.as_str() {
        "UNVERIFIED" | "FAILED" | "NOT_STARTED" => {}
        "VERIFIED" => return Err(local("VERIFIED_REJECTED", "VERIFIED is not reportable")),
        _ => {
            return Err(local(
                "INVALID_REPORT",
                "business_outcome is not reportable",
            ))
        }
    }
    if req.report.finished_at_ms < 0 || req.report.finished_at_ms > JS_MAX_SAFE_INTEGER {
        return Err(local(
            "INVALID_REPORT",
            "finished_at_ms is not a nonnegative safe integer",
        ));
    }
    if req.report.receipt_sha256.len() != 64
        || !req
            .report
            .receipt_sha256
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(local(
            "INVALID_REPORT",
            "receipt_sha256 is not 64 lowercase hex",
        ));
    }
    if let Some(err) = &req.report.error {
        if !stage_ok(&err.stage) {
            return Err(local("INVALID_REPORT", "error.stage is invalid"));
        }
        if !error_code_ok(&err.code) {
            return Err(local("INVALID_REPORT", "error.code is invalid"));
        }
        if err.message.trim().is_empty() {
            return Err(local("INVALID_REPORT", "error.message is empty"));
        }
        if err.message.len() > MAX_ERROR_MESSAGE_BYTES {
            return Err(local("INVALID_REPORT", "error.message exceeds 2 KiB"));
        }
    }
    let body = serde_json::to_vec(req)
        .map_err(|_| local("INVALID_REPORT", "report request could not be encoded"))?;
    if body.len() > MAX_REPORT_REQUEST_BYTES {
        return Err(local("INVALID_REPORT", "report request exceeds 8 KiB"));
    }
    Ok(())
}

fn workspace_matches(receipt_ws: &str, canonical: &Path) -> bool {
    let p = Path::new(receipt_ws);
    if p == canonical {
        return true;
    }
    match p.canonicalize() {
        Ok(c) => c == canonical,
        Err(_) => false,
    }
}

fn recovery_marked(receipt: &TaskReceipt) -> bool {
    let from_error = receipt
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    let from_stop = receipt
        .bridge_context
        .as_ref()
        .and_then(|bc| bc.stop_reason.as_ref())
        .map(|s| s.code.as_str())
        .unwrap_or("");
    matches!(
        from_error,
        "PROCESS_STOP_UNCONFIRMED" | "LOCAL_STATE_WRITE_FAILED"
    ) || matches!(
        from_stop,
        "PROCESS_STOP_UNCONFIRMED" | "LOCAL_STATE_WRITE_FAILED"
    )
}

fn map_business_outcome(outcome: BusinessOutcome) -> Result<&'static str, ReportError> {
    match outcome {
        BusinessOutcome::Unverified => Ok("UNVERIFIED"),
        BusinessOutcome::Failed => Ok("FAILED"),
        BusinessOutcome::NotStarted => Ok("NOT_STARTED"),
        BusinessOutcome::Verified => Err(local("VERIFIED_REJECTED", "VERIFIED is not reportable")),
    }
}

/// Read and validate the persisted local result, then build the exact report request.
pub fn load_saved_report(
    config: &BridgeConfig,
    workspace_ref: &str,
    job_id: &str,
    attempt_id: &str,
) -> Result<ExecutionReportRequest, ReportError> {
    validate_ids(job_id, attempt_id)?;
    let workspace = config
        .resolve_workspace(workspace_ref)
        .cloned()
        .ok_or_else(|| {
            ReportError::Config(format!("workspace_ref {workspace_ref:?} is not configured"))
        })?;
    state::reject_control_ancestor_symlinks(&workspace)
        .map_err(|e| local("PATH_INVALID", e.to_string()))?;

    let binding = expected_binding(config, workspace_ref, &workspace);
    let state_path = state::state_path(&workspace);
    let state = match BridgeState::load(&state_path, &binding) {
        Ok(s) => s,
        Err(state::StateError::Io(_, msg)) if msg.contains("No such file") => {
            return Err(local("LOCAL_STATE_MISSING", "bridge state is missing"));
        }
        Err(state::StateError::BindingMismatch(m)) => {
            return Err(local(LOCAL_BINDING_MISMATCH, m));
        }
        Err(state::StateError::Invalid(m)) => return Err(local(LOCAL_STATE_INVALID, m)),
        Err(e) => return Err(local(LOCAL_STATE_INVALID, e.to_string())),
    };
    if state.active.is_some() {
        return Err(local(
            "ACTIVE_ATTEMPT",
            "an active attempt is still recorded; stop bridge run first",
        ));
    }

    let history_path = state::history_record_path(&workspace, job_id, attempt_id);
    match std::fs::symlink_metadata(&history_path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(local("HISTORY_MISSING", "history record is missing"));
        }
        Err(e) => return Err(local("HISTORY_INVALID", e.to_string())),
    }
    let history_bytes = read_workspace_file(&workspace, &history_path)?;
    let history: AttemptHistoryRecord = serde_json::from_slice(&history_bytes)
        .map_err(|_| local("HISTORY_INVALID", "history record is not valid JSON"))?;
    validate_history_for_report(&history).map_err(|e| local("HISTORY_INVALID", e))?;

    if history.server_origin != binding.server_origin
        || history.user_id != binding.user_id
        || history.workspace_id != binding.workspace_id
        || history.workspace_ref != binding.workspace_ref
    {
        return Err(local(
            LOCAL_BINDING_MISMATCH,
            "history identity does not match the configured binding",
        ));
    }
    if history.worker_id != state.worker_id {
        return Err(local(
            LOCAL_BINDING_MISMATCH,
            "history worker_id does not match local state",
        ));
    }
    if history.job_id != job_id || history.attempt_id != attempt_id {
        return Err(local(
            "IDENTITY_MISMATCH",
            "history job/attempt does not match the command",
        ));
    }
    if !claim_token_ok(&history.claim_token) {
        return Err(local("INVALID_REPORT", "history claim token is invalid"));
    }

    let attempt_dir = safe_attempt_dir(&workspace, job_id, attempt_id)
        .map_err(|e| local("PATH_INVALID", e.to_string()))?;
    let receipt_path = attempt_dir.join("receipt.json");
    match std::fs::symlink_metadata(&receipt_path) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(local("RECEIPT_MISSING", "receipt is missing"));
        }
        Err(e) => return Err(local("RECEIPT_INVALID", e.to_string())),
    }
    let receipt_bytes = read_workspace_file(&workspace, &receipt_path)?;
    let receipt_sha = sha256_hex(&receipt_bytes);
    if receipt_sha != history.receipt_sha256 {
        return Err(local(
            "RECEIPT_HASH_MISMATCH",
            "receipt bytes do not match history.receipt_sha256",
        ));
    }
    let receipt: TaskReceipt = serde_json::from_slice(&receipt_bytes)
        .map_err(|_| local("RECEIPT_INVALID", "receipt is not valid JSON"))?;
    if receipt.job_id != job_id || receipt.attempt_id != attempt_id {
        return Err(local(
            "IDENTITY_MISMATCH",
            "receipt job/attempt does not match the command",
        ));
    }
    if !workspace_matches(&receipt.workspace, &workspace) {
        return Err(local(
            LOCAL_BINDING_MISMATCH,
            "receipt workspace does not match the canonical workspace",
        ));
    }
    let Some(bc) = receipt.bridge_context.as_ref() else {
        return Err(local(
            "RECEIPT_INVALID",
            "receipt has no bridge context and cannot be reported",
        ));
    };
    if bc.server_origin != history.server_origin
        || bc.user_id != history.user_id
        || bc.workspace_id != history.workspace_id
        || bc.workspace_ref != history.workspace_ref
        || bc.worker_id != history.worker_id
        || bc.job_id != history.job_id
        || bc.attempt_id != history.attempt_id
    {
        return Err(local(
            LOCAL_BINDING_MISMATCH,
            "receipt bridge context does not match history",
        ));
    }
    if bc.source_prompt_sha256 != history.source_prompt_sha256
        || bc.acceptance_sha256 != history.acceptance_sha256
    {
        return Err(local(
            "IDENTITY_MISMATCH",
            "receipt prompt/acceptance hashes do not match history",
        ));
    }
    if bc.task_dispatch_intent != history.task_dispatch_intent {
        return Err(local(
            "IDENTITY_MISMATCH",
            "receipt dispatch intent does not match history",
        ));
    }
    if recovery_marked(&receipt) {
        return Err(local(
            "RECOVERY_REQUIRED",
            "receipt is marked PROCESS_STOP_UNCONFIRMED or LOCAL_STATE_WRITE_FAILED",
        ));
    }
    if !ALLOWED_EXECUTION.contains(&receipt.execution_status.as_str()) {
        return Err(local(
            "UNSUPPORTED_STATUS",
            "execution_status is not reportable",
        ));
    }
    let business_outcome = map_business_outcome(receipt.business_outcome)?;
    let finished_at_ms = receipt.timestamps.finished_at.timestamp_millis();
    let error = receipt.error.as_ref().map(|e| ExecutionReportError {
        stage: e.stage.clone(),
        code: e.code.clone(),
        message: e.message.clone(),
    });
    let request = ExecutionReportRequest {
        worker_id: history.worker_id.clone(),
        attempt_id: history.attempt_id.clone(),
        claim_token: history.claim_token.clone(),
        report: ExecutionReportBody {
            schema_version: 1,
            execution_status: receipt.execution_status.clone(),
            business_outcome: business_outcome.to_string(),
            finished_at_ms,
            receipt_sha256: receipt_sha,
            error,
        },
    };
    validate_report_contract(&request)?;
    Ok(request)
}

/// Verify remote identity, then send the locally constructed report exactly once.
pub async fn report_saved_attempt(
    config_path: &Path,
    workspace_ref: &str,
    job_id: &str,
    attempt_id: &str,
) -> Result<ExecutionReportOk, ReportError> {
    validate_ids(job_id, attempt_id)?;
    let cfg = BridgeConfig::load(config_path).map_err(|e| ReportError::Config(e.to_string()))?;
    let workspace = cfg
        .resolve_workspace(workspace_ref)
        .cloned()
        .ok_or_else(|| {
            ReportError::Config(format!("workspace_ref {workspace_ref:?} is not configured"))
        })?;
    state::reject_control_ancestor_symlinks(&workspace)
        .map_err(|e| local("PATH_INVALID", e.to_string()))?;
    let _lock = ExecutionLock::acquire(&workspace).map_err(|e| ReportError::Busy(e.to_string()))?;
    let request = load_saved_report(&cfg, workspace_ref, job_id, attempt_id)?;
    let api_key =
        load_api_key(&cfg.api_key_file).map_err(|e| ReportError::Config(e.to_string()))?;
    let client =
        BridgeClient::new(cfg.server_base.clone(), api_key).map_err(ReportError::Client)?;
    client
        .verify_identity(
            &cfg.expected_identity.user_id,
            &cfg.expected_identity.workspace_id,
        )
        .await
        .map_err(ReportError::Client)?;
    client
        .report_execution(job_id, &request)
        .await
        .map_err(ReportError::Client)
}

fn validate_history_for_report(history: &AttemptHistoryRecord) -> Result<(), String> {
    if history.schema_version != state::HISTORY_SCHEMA_VERSION {
        return Err(format!(
            "history schema_version {} is unsupported",
            history.schema_version
        ));
    }
    if !worker_id_ok(&history.worker_id) {
        return Err("history worker_id is invalid".to_string());
    }
    if !job_id_ok(&history.job_id) || !uuid_ok(&history.attempt_id) {
        return Err("history job/attempt is invalid".to_string());
    }
    if !claim_token_ok(&history.claim_token) {
        return Err("history claim token is invalid".to_string());
    }
    for (name, h) in [
        ("source_prompt_sha256", &history.source_prompt_sha256),
        ("acceptance_sha256", &history.acceptance_sha256),
        ("envelope_sha256", &history.envelope_sha256),
        ("receipt_sha256", &history.receipt_sha256),
    ] {
        if h.len() != 64 || !h.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
            return Err(format!("history {name} is not 64 lowercase hex"));
        }
    }
    Ok(())
}
