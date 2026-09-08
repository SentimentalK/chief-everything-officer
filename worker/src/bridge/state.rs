//! Bridge local control state: what the worker has decided to execute and what
//! it must not lose across a crash.
//!
//! Only *unforgettable execution decisions* live here. We deliberately do not
//! add SQLite, a second pending queue, or a persisted discovery cursor: on
//! restart the worker re-discovers from `0-0` and re-claims. What must survive
//! is the active attempt (its id, token, phase, dispatch intent, and confirmed
//! claim payload) plus the binding/worker identity.
//!
//! Control records live under `<workspace>/.ceo/bridge` (0700) with 0600 files,
//! distinct from the existing Runner job/receipt layout under `.ceo/jobs`, so
//! the verifier never treats bridge control files as task artifacts. API keys
//! are never stored here. The lease token is kept only in the 0600 control
//! state/history for same-attempt retry, and never enters receipts, stdout,
//! events, or Agent prompts.
//!
//! 0700/0600 only stop other OS users from reading these records; it does not
//! claim isolation from an Agent running as the same UID. Executors must never
//! read or mutate `.ceo/bridge` or the execution lock.

use serde::{Deserialize, Serialize};
use std::fmt;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

use crate::config::{ceo_dir, validate_id};
use crate::local_state::atomic_write_json;

pub const STATE_SCHEMA_VERSION: u32 = 1;

/// Failure codes surfaced (redacted-safe) by local-state handling.
pub const LOCAL_STATE_INVALID: &str = "LOCAL_STATE_INVALID";
pub const LOCAL_BINDING_MISMATCH: &str = "LOCAL_BINDING_MISMATCH";
pub const LOCAL_JOB_CONFLICT: &str = "LOCAL_JOB_CONFLICT";
pub const RECOVERY_REQUIRED: &str = "RECOVERY_REQUIRED";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

pub fn bridge_dir(workspace: &Path) -> PathBuf {
    ceo_dir(workspace).join("bridge")
}

pub fn state_path(workspace: &Path) -> PathBuf {
    bridge_dir(workspace).join("state.json")
}

/// Directory storing per-attempt control-history records.
pub fn history_dir(workspace: &Path) -> PathBuf {
    bridge_dir(workspace).join("history")
}

pub fn history_record_path(workspace: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    history_dir(workspace).join(format!("{job_id}.{attempt_id}.json"))
}

/// Directory holding the versioned prompt envelope for a request.
pub fn request_dir(workspace: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    bridge_dir(workspace)
        .join("requests")
        .join(job_id)
        .join(attempt_id)
}

pub fn prompt_path(workspace: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    request_dir(workspace, job_id, attempt_id).join("prompt.md")
}

/// Ensures `.ceo/bridge` and its subdirs exist with 0700 permissions. The
/// directory mode is clamped on every call so later runs repair drift, but we
/// never delete or relocate an existing control directory.
pub fn ensure_control_dirs(workspace: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    for dir in [
        bridge_dir(workspace),
        bridge_dir(workspace).join("requests"),
        history_dir(workspace),
    ] {
        std::fs::create_dir_all(&dir)?;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Rejects a control path whose final component is a symlink, so writes never
/// silently follow a link planted outside the intended location. Callers must
/// additionally verify the whole `.ceo/bridge` canonical path stays inside the
/// canonical workspace.
pub fn reject_symlink_target(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("control path is a symlink: {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error, PartialEq, Eq)]
pub enum StateError {
    #[error("{0}: {1}")]
    Io(String, String),
    #[error("{LOCAL_STATE_INVALID}: {0}")]
    Invalid(String),
    #[error("{LOCAL_BINDING_MISMATCH}: {0}")]
    BindingMismatch(String),
}

impl StateError {
    pub fn io(path: &Path, e: &std::io::Error) -> StateError {
        StateError::Io(path.display().to_string(), e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The immutable identity/binding a worker process was launched with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeBinding {
    pub server_origin: String,
    pub user_id: String,
    pub workspace_id: String,
    pub workspace_ref: String,
    pub canonical_workspace: PathBuf,
}

/// Execution phase of the active attempt as persisted locally. This is the
/// worker's own record of how far it committed, not the server's phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalPhase {
    /// Decided to claim; not yet sent (or claim outcome unknown).
    ClaimIntent,
    /// Server confirmed the claim (fresh or replay).
    Claimed,
    /// A controlled Runner is being started; no business prompt before Start.
    RunnerIntent,
    /// StartIntent persisted; the Server `start` call is (about to be) issued.
    StartIntent,
    /// DispatchIntent persisted: the business prompt may have been (partially)
    /// written; never auto-resume past this point.
    DispatchIntent,
    /// The Runner is executing the task under a confirmed lease.
    Running,
    /// Recovery is required before any further execution; do not auto-recover.
    RecoveryRequired,
}

/// Full confirmed claim payload (what the Server returned). The sha256 of the
/// canonical JSON serialization lets a reload verify the payload was not
/// corrupted or replaced in place. `resource_id` is present-but-nullable.
#[derive(Clone, Serialize, Deserialize)]
pub struct ClaimPayload {
    pub workspace_ref: String,
    pub resource_id: Option<String>,
    pub prompt: String,
    pub acceptance: String,
    pub timeout_seconds: i64,
    /// sha256 over the canonical JSON of the five fields above.
    pub payload_sha256: String,
}

impl fmt::Debug for ClaimPayload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaimPayload")
            .field("workspace_ref", &self.workspace_ref)
            .field("resource_id", &self.resource_id)
            .field("prompt", &"[redacted]")
            .field("acceptance", &"[redacted]")
            .field("timeout_seconds", &self.timeout_seconds)
            .field("payload_sha256", &self.payload_sha256)
            .finish()
    }
}

impl ClaimPayload {
    fn canonical_json(&self) -> String {
        serde_json::to_string(&serde_json::json!({
            "workspace_ref": self.workspace_ref,
            "resource_id": self.resource_id,
            "prompt": self.prompt,
            "acceptance": self.acceptance,
            "timeout_seconds": self.timeout_seconds,
        }))
        .expect("claim payload canonical json serializes")
    }

    fn sha256_of(&self) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.canonical_json().as_bytes());
        format!("{:x}", h.finalize())
    }

    /// Builds from the server's `ClaimedJob`, hashing the canonical JSON.
    pub fn from_wire(job: &crate::bridge::protocol::ClaimedJob) -> ClaimPayload {
        let mut p = ClaimPayload {
            workspace_ref: job.workspace_ref.clone(),
            resource_id: job.resource_id.clone(),
            prompt: job.prompt.clone(),
            acceptance: job.acceptance.clone(),
            timeout_seconds: job.timeout_seconds,
            payload_sha256: String::new(),
        };
        p.payload_sha256 = p.sha256_of();
        p
    }

    /// Verifies the stored sha256 still matches the stored fields.
    pub fn verify_integrity(&self) -> bool {
        !self.payload_sha256.is_empty() && self.sha256_of() == self.payload_sha256
    }
}

/// Identity of a launched process group. A PID alone is never treated as a
/// process identity: the boot_id plus `/proc/<pid>/stat` starttime disambiguate
/// a reused PID across boots or execs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProcessIdentity {
    pub pid: u32,
    pub pgid: Option<i32>,
    pub start_time: Option<u64>,
    pub boot_id: String,
}

/// Safe error code/reason that may be written into control state (sanitized;
/// never includes raw response bodies or tokens).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SafeStopError {
    pub code: String,
    pub reason: Option<String>,
}

/// The currently-active attempt the worker is executing or recovering.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActiveAttempt {
    pub job_id: String,
    pub attempt_id: String,
    /// 0600-only secret for same-attempt retry. Never Debug-printed.
    pub lease_token: String,
    pub phase: LocalPhase,
    /// Confirmed claim payload; absent before the first claim success.
    pub claim: Option<ClaimPayload>,
    /// boot_id of the worker that launched the Runner, if any.
    pub runner_boot_id: Option<String>,
    /// Optional process-group identity of the launched Runner/Executor.
    pub process: Option<ProcessIdentity>,
    /// True once DispatchIntent is persisted: the business prompt may have been
    /// sent, so the attempt must never be auto-resumed.
    pub task_dispatch_intent: bool,
    pub stop_error: Option<SafeStopError>,
}

impl fmt::Debug for ActiveAttempt {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ActiveAttempt")
            .field("job_id", &self.job_id)
            .field("attempt_id", &self.attempt_id)
            .field("lease_token", &"[redacted]")
            .field("phase", &self.phase)
            .field("claim", &self.claim)
            .field("runner_boot_id", &self.runner_boot_id)
            .field("process", &self.process)
            .field("task_dispatch_intent", &self.task_dispatch_intent)
            .field("stop_error", &self.stop_error)
            .finish()
    }
}

impl ActiveAttempt {
    fn validate(&self) -> Result<(), String> {
        validate_id("job_id", &self.job_id).map_err(|e| e.to_string())?;
        validate_id("attempt_id", &self.attempt_id).map_err(|e| e.to_string())?;
        if self.lease_token.trim().is_empty() {
            return Err("active attempt is missing lease_token".to_string());
        }
        if matches!(self.phase, LocalPhase::DispatchIntent | LocalPhase::Running)
            && !self.task_dispatch_intent
        {
            return Err(format!(
                "phase {:?} requires task_dispatch_intent",
                self.phase
            ));
        }
        if self.task_dispatch_intent
            && matches!(
                self.phase,
                LocalPhase::ClaimIntent | LocalPhase::Claimed | LocalPhase::RunnerIntent
            )
        {
            return Err(format!(
                "task_dispatch_intent set before phase {:?}",
                self.phase
            ));
        }
        if let Some(p) = &self.process {
            if p.boot_id.trim().is_empty() {
                return Err("process identity missing boot_id".to_string());
            }
        }
        if let Some(c) = &self.claim {
            if !c.verify_integrity() {
                return Err("claim payload hash mismatch".to_string());
            }
        }
        Ok(())
    }
}

/// The persisted bridge control state for one canonical workspace.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeState {
    pub schema_version: u32,
    pub binding: BridgeBinding,
    /// `wrk-<uuid>`; created once and stable across restarts.
    pub worker_id: String,
    pub active: Option<ActiveAttempt>,
}

impl fmt::Debug for BridgeState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BridgeState")
            .field("schema_version", &self.schema_version)
            .field("binding", &self.binding)
            .field("worker_id", &self.worker_id)
            .field("active", &self.active)
            .finish()
    }
}

impl BridgeState {
    /// Fresh state for a new workspace binding. Generates a stable worker_id
    /// once; callers must persist this before any claim.
    pub fn new(binding: BridgeBinding) -> BridgeState {
        let worker_id = format!("wrk-{}", Uuid::new_v4());
        BridgeState {
            schema_version: STATE_SCHEMA_VERSION,
            binding,
            worker_id,
            active: None,
        }
    }

    /// Loads and structurally validates state from `path`. On any parse error,
    /// invalid version, missing field, missing token, inconsistent phase, or
    /// binding mismatch, returns `Err` — never silently re-initializes.
    pub fn load(path: &Path, expected_binding: &BridgeBinding) -> Result<BridgeState, StateError> {
        let text = std::fs::read_to_string(path).map_err(|e| StateError::io(path, &e))?;
        let st: BridgeState = serde_json::from_str(&text)
            .map_err(|e| StateError::Invalid(format!("parse error: {e}")))?;
        st.validate(expected_binding)?;
        Ok(st)
    }

    fn validate(&self, expected: &BridgeBinding) -> Result<(), StateError> {
        if self.schema_version != STATE_SCHEMA_VERSION {
            return Err(StateError::Invalid(format!(
                "unsupported schema_version {}",
                self.schema_version
            )));
        }
        if !self.worker_id.starts_with("wrk-") {
            return Err(StateError::Invalid("worker_id malformed".to_string()));
        }
        if self.binding != *expected {
            return Err(StateError::BindingMismatch(
                "binding does not match configured identity/workspace".to_string(),
            ));
        }
        if let Some(active) = &self.active {
            active.validate().map_err(StateError::Invalid)?;
        }
        Ok(())
    }

    pub fn persist(&self, workspace: &Path) -> Result<(), StateError> {
        ensure_control_dirs(workspace).map_err(|e| StateError::io(&state_path(workspace), &e))?;
        let p = state_path(workspace);
        reject_symlink_target(&p).map_err(|e| StateError::io(&p, &e))?;
        atomic_write_json(&p, self).map_err(|e| StateError::io(&p, &e))
    }
}

/// Reads persisted state when present, or builds a fresh one for a first run.
/// A corrupt existing state is an error; it is never treated as empty.
pub fn try_load_or_fresh(
    workspace: &Path,
    binding: &BridgeBinding,
) -> Result<BridgeState, StateError> {
    let p = state_path(workspace);
    match BridgeState::load(&p, binding) {
        Ok(st) => Ok(st),
        Err(StateError::Io(_, ref msg)) if msg.contains("No such file") => {
            Ok(BridgeState::new(binding.clone()))
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Worker/attempt id helpers
// ---------------------------------------------------------------------------

pub fn new_attempt_id() -> String {
    Uuid::new_v4().to_string()
}

/// Generates a 32-byte random lease token as 64 lowercase hex characters,
/// reading `/dev/urandom` with `read_exact`. Fails (rather than falling back to
/// timestamps or a PRNG) if randomness is unavailable.
pub fn generate_lease_token() -> Result<String, std::io::Error> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    let mut f = std::fs::File::open("/dev/urandom")?;
    f.read_exact(&mut buf)?;
    let mut out = String::with_capacity(64);
    for b in buf {
        out.push_str(&format!("{:02x}", b));
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// History records
// ---------------------------------------------------------------------------

/// A per-attempt control-history record written (0600) at local completion so a
/// restart can tell "already finalized" from "needs recovery". Carries the
/// token only inside the 0600 control tree; it never reaches the receipt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AttemptHistoryRecord {
    pub job_id: String,
    pub attempt_id: String,
    pub worker_id: String,
    /// sha256 over the finalized receipt bytes (so we refuse to overwrite an
    /// inconsistent history with a different receipt).
    pub receipt_sha256: String,
    pub finalized_at: String,
}

impl AttemptHistoryRecord {
    pub fn persist(&self, workspace: &Path) -> Result<(), StateError> {
        ensure_control_dirs(workspace).map_err(|e| StateError::io(&state_path(workspace), &e))?;
        let p = history_record_path(workspace, &self.job_id, &self.attempt_id);
        reject_symlink_target(&p).map_err(|e| StateError::io(&p, &e))?;
        atomic_write_json(&p, self).map_err(|e| StateError::io(&p, &e))
    }

    pub fn load(
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
    ) -> Result<Option<Self>, StateError> {
        let p = history_record_path(workspace, job_id, attempt_id);
        let text = match std::fs::read_to_string(&p) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(StateError::io(&p, &e)),
        };
        let rec: AttemptHistoryRecord = serde_json::from_str(&text)
            .map_err(|e| StateError::Invalid(format!("history parse error: {e}")))?;
        Ok(Some(rec))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_state::atomic_write_json;

    fn binding(ws: &Path) -> BridgeBinding {
        BridgeBinding {
            server_origin: "https://ceo.example".to_string(),
            user_id: "usr_1".to_string(),
            workspace_id: "ws_1".to_string(),
            workspace_ref: "tools".to_string(),
            canonical_workspace: ws.to_path_buf(),
        }
    }

    fn sample_state(ws: &Path) -> BridgeState {
        BridgeState::new(binding(ws))
    }

    #[test]
    fn load_missing_is_io_not_found() {
        let t = tempfile::tempdir().unwrap();
        let p = state_path(t.path());
        let err = BridgeState::load(&p, &binding(t.path())).unwrap_err();
        match err {
            StateError::Io(_, msg) => assert!(msg.contains("No such file"), "{msg}"),
            other => panic!("expected Io NotFound, got {other:?}"),
        }
    }

    #[test]
    fn worker_id_stable_and_versioned() {
        let t = tempfile::tempdir().unwrap();
        let st = sample_state(t.path());
        assert_eq!(st.schema_version, 1);
        assert!(st.worker_id.starts_with("wrk-"));
        // round-trip preserves worker_id
        let p = state_path(t.path());
        atomic_write_json(&p, &st).unwrap();
        let loaded = BridgeState::load(&p, &binding(t.path())).unwrap();
        assert_eq!(loaded.worker_id, st.worker_id);
    }

    #[test]
    fn corrupt_state_is_not_reinitialized() {
        let t = tempfile::tempdir().unwrap();
        let p = state_path(t.path());
        ensure_control_dirs(t.path()).unwrap();
        std::fs::write(&p, "{not json").unwrap();
        let err = BridgeState::load(&p, &binding(t.path())).unwrap_err();
        assert!(matches!(err, StateError::Invalid(_)));
    }

    #[test]
    fn binding_mismatch_rejected() {
        let t = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let st = sample_state(other.path());
        let p = state_path(other.path());
        atomic_write_json(&p, &st).unwrap();
        // load against a different canonical workspace -> binding mismatch
        let err = BridgeState::load(&p, &binding(t.path())).unwrap_err();
        assert!(matches!(err, StateError::BindingMismatch(_)));
    }

    #[test]
    fn running_requires_dispatch_intent() {
        let st = ActiveAttempt {
            job_id: "job1".to_string(),
            attempt_id: new_attempt_id(),
            lease_token: "ab".repeat(32),
            phase: LocalPhase::Running,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        };
        assert!(st.validate().is_err());
    }

    #[test]
    fn claim_payload_integrity() {
        let payload = ClaimPayload {
            workspace_ref: "tools".to_string(),
            resource_id: None,
            prompt: "do x".to_string(),
            acceptance: "x done".to_string(),
            timeout_seconds: 300,
            payload_sha256: String::new(),
        };
        let mut p = payload.clone();
        p.payload_sha256 = p.sha256_of();
        assert!(p.verify_integrity());
        let mut tampered = p.clone();
        tampered.prompt = "do y".to_string();
        assert!(!tampered.verify_integrity());
    }

    #[test]
    fn token_never_in_debug() {
        let a = ActiveAttempt {
            job_id: "j".to_string(),
            attempt_id: new_attempt_id(),
            lease_token: "secret-token-value".to_string(),
            phase: LocalPhase::Claimed,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        };
        let dbg = format!("{a:?}");
        assert!(!dbg.contains("secret-token-value"));
    }
}
