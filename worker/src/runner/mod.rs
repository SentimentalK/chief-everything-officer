pub mod control;

pub use control::{
    control_channel, BridgeReceiptContext, ExecGate, ExecutionPermit, RunnerControls, RunnerSignal,
    StopReason,
};

use crate::bridge::state::ProcessIdentity;
use crate::config::{attempt_dir, job_dir, snapshot_prompt, validate_id, WorkerConfig};
use crate::doctor::{
    invalidate_cache, load_cache, run_fast_local_precheck, run_preflight_static_checks, save_cache,
    DoctorCacheRecord, DoctorMetricsRecord, DoctorProbeContext, FingerprintBuilder, ModelUsageInfo,
    SessionDoctorReport,
};
use crate::executor::adapter_trait::ManagedProcess;
use crate::executor::process::pgid_has_live_members;
use crate::executor::{create_executor, ExecutionRequest, ExecutorError};
use crate::observability::{
    EventLogger, JobStage, LogSource, ProcessLogger, StatusTracker, StreamEventDispatcher,
};
use crate::receipt::{
    CachedDoctorMetrics, CurrentDoctorMetrics, ExecutorInfo, LogSummary, ReceiptError, TaskReceipt,
    TimestampsInfo,
};
use crate::verifier::{ArtifactClaim, BusinessOutcome, GenericVerifier, WorkspaceSnapshot};
use chrono::{DateTime, Utc};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant};
use thiserror::Error;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum RunnerError {
    #[error("Job ID '{0}' already exists. Refusing to overwrite or re-execute.")]
    JobAlreadyExists(String),
    #[error("Attempt {0} already has a final receipt; refusing to re-execute.")]
    AttemptAlreadyFinalized(String),
    #[error("Configuration error: {0}")]
    ConfigError(#[from] crate::config::ConfigError),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Doctor failed: {0}")]
    DoctorFailed(String),
    #[error("Failed to persist task receipt to disk: {0}")]
    ReceiptPersistFailed(std::io::Error),
}

/// Reads the kernel boot id (stable across a single boot) from /proc.
fn read_boot_id() -> Option<String> {
    let s = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    let t = s.trim().to_string();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// Assembles a process identity from a live child (PID/PGID + starttime + boot).
/// A missing boot id makes the identity unusable for recovery (None).
fn make_process_identity(pid: Option<u32>, pgid: Option<i32>) -> Option<ProcessIdentity> {
    let boot_id = read_boot_id()?;
    Some(ProcessIdentity {
        pid: pid?,
        pgid,
        start_time: pid.and_then(crate::observability::status::get_process_start_time),
        boot_id,
    })
}

/// Structured, evidence-bearing result of terminating a managed process group.
/// Each field is true only when that step was *confirmed*, not merely attempted.
/// A false field means the caller cannot prove the group/drain stopped and must
/// not claim a clean completion or continue as if the process were gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TeardownReport {
    /// No live (non-zombie) member of the process group remains.
    pub group_confirmed_empty: bool,
    /// The leader child was reaped via `wait()`.
    pub leader_reaped: bool,
    /// All stdout/stderr drain tasks finished (joined or aborted+awaited).
    pub drains_ended: bool,
}

impl TeardownReport {
    pub fn fully_stopped(&self) -> bool {
        self.group_confirmed_empty && self.leader_reaped && self.drains_ended
    }
}

/// Absolute teardown budget for a managed process group. All teardown waits
/// (grace for a graceful exit, leader reaping, drain joins) share one hard
/// deadline measured from the instant teardown begins, so separate waits never
/// stack into an unbounded total.
const TEARDOWN_GRACE: Duration = Duration::from_secs(3);
const TEARDOWN_HARD: Duration = Duration::from_secs(5);

/// Joins a drain task within `budget`, aborting it (and awaiting the abort) on
/// timeout. The JoinHandle is never dropped into a detached background task.
/// Returns true only when the drain task actually finished.
async fn join_or_abort(handle: JoinHandle<()>, budget: Duration) -> bool {
    let mut h = handle;
    let sleep = tokio::time::sleep(budget);
    tokio::pin!(sleep);
    tokio::select! {
        _ = &mut h => true,
        _ = &mut sleep => {
            h.abort();
            let _ = h.await;
            false
        }
    }
}

/// Two-phase, bounded termination of a managed process group plus its log
/// drains under a single shared budget: close stdin → SIGTERM the whole PGID →
/// up to [`TEARDOWN_GRACE`] for the group to empty (the leader reaped via the
/// non-blocking [`ManagedProcess::try_wait`] while it drains) → SIGKILL any
/// remainder → up to [`TEARDOWN_HARD`] to reap the leader, confirm the group
/// empty, and join the drain tasks (aborting + awaiting on timeout, never
/// detaching). Every step that cannot be confirmed is reported so the caller
/// never treats the process as gone or the attempt as cleanly complete. A
/// kernel-uninterruptible process is simply unconfirmed — never faked as gone.
async fn teardown_managed(
    child: &mut Box<dyn ManagedProcess>,
    drains: &mut Vec<JoinHandle<()>>,
) -> TeardownReport {
    use tokio::time::timeout;
    let started = tokio::time::Instant::now();
    let grace_deadline = started + TEARDOWN_GRACE;
    let hard_deadline = started + TEARDOWN_HARD;

    let _ = child.close_stdin();
    let _ = child.kill_group(); // graceful SIGTERM to the whole group.

    let mut force_killed = false;
    let mut leader_reaped = false;
    loop {
        // Reap the leader as soon as it exits, without blocking on a wait.
        if !leader_reaped {
            // Reap as soon as it exits; a None (still running) or reap error
            // (not confirmed) simply keeps us observing.
            if let Ok(Some(_)) = child.try_wait() {
                leader_reaped = true;
            }
        }
        let group_empty = match child.pgid() {
            Some(pg) => match pgid_has_live_members(pg) {
                Ok(has) => !has,
                Err(_) => false, // scan fault -> cannot confirm empty
            },
            None => false, // no recorded pgid -> cannot confirm empty
        };
        if leader_reaped && group_empty {
            break;
        }
        let now = tokio::time::Instant::now();
        if now >= hard_deadline {
            break;
        }
        // Escalate to SIGKILL once the grace period has elapsed while members
        // are still live; do not wait out a polite SIGTERM forever.
        if !force_killed && now >= grace_deadline {
            let _ = child.force_kill_group();
            force_killed = true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Reap the leader within the remaining hard budget if it has not exited yet.
    if !leader_reaped {
        let remain = hard_deadline.saturating_duration_since(tokio::time::Instant::now());
        leader_reaped = matches!(timeout(remain, child.wait()).await, Ok(Ok(_)));
    }
    // Confirm the group is truly empty after reaping (scan faults are unknown,
    // never treated as empty).
    let group_confirmed_empty = if leader_reaped {
        match child.pgid() {
            Some(pg) => pgid_has_live_members(pg).map(|has| !has).unwrap_or(false),
            None => false,
        }
    } else {
        false
    };
    // Join the drain tasks under the same absolute hard budget, aborting +
    // awaiting on timeout so no drain is ever detached into the background.
    let mut drains_ended = true;
    for handle in drains.drain(..) {
        let remain = hard_deadline.saturating_duration_since(tokio::time::Instant::now());
        if !join_or_abort(handle, remain).await {
            drains_ended = false;
        }
    }
    TeardownReport {
        group_confirmed_empty,
        leader_reaped,
        drains_ended,
    }
}

/// Stop confirmation precedes business-result classification: once a managed
/// process has been spawned, no outcome is recorded until teardown confirms the
/// group/leader/drains are stopped. If they cannot be confirmed stopped, the
/// intended outcome — whatever the business result looked like — is overridden
/// to `PROCESS_STOP_UNCONFIRMED` so the attempt is kept for recovery.
/// `dispatched` is the effective dispatch intent (true once the business prompt
/// may have been sent).
fn apply_teardown_evidence(
    outcome: AttemptOutcome,
    report: &TeardownReport,
    dispatched: bool,
) -> AttemptOutcome {
    if report.fully_stopped() {
        return outcome;
    }
    AttemptOutcome::Stopped {
        stop_reason: StopReason::ProcessStopUnconfirmed,
        dispatched,
        executor: outcome.executor(),
    }
}

struct FinalizeParams<'a> {
    job_id: &'a str,
    attempt_id: &'a str,
    workspace: &'a Path,
    prompt_file: &'a Path,
    prompt_sha256: &'a str,
    started_at: DateTime<Utc>,
    attempt_dir: &'a Path,
    status_tracker: &'a StatusTracker,
    event_logger: &'a EventLogger,
    stdout_logger: &'a ProcessLogger,
    stderr_logger: &'a ProcessLogger,
    log_paths: HashMap<String, String>,
    doctor_report: Option<SessionDoctorReport>,
    doctor_cache_hit: bool,
    local_check_duration_ms: u64,
    current_doctor_metrics: Option<CurrentDoctorMetrics>,
    cached_doctor_metrics: Option<CachedDoctorMetrics>,
    dispatch_happened: bool,
    bridge_context: Option<BridgeReceiptContext>,
}

enum AttemptOutcome {
    Success {
        executor: ExecutorInfo,
        artifacts: Vec<ArtifactClaim>,
        business_outcome: BusinessOutcome,
    },
    Blocked {
        stage: String,
        code: String,
        message: String,
        executor: ExecutorInfo,
    },
    Failed {
        stage: String,
        code: String,
        message: String,
        business_outcome: BusinessOutcome,
        executor: ExecutorInfo,
        artifacts: Vec<ArtifactClaim>,
    },
    Timeout {
        duration_secs: u64,
        executor: ExecutorInfo,
    },
    Stopped {
        stop_reason: StopReason,
        dispatched: bool,
        executor: ExecutorInfo,
    },
}

impl AttemptOutcome {
    fn executor(&self) -> ExecutorInfo {
        match self {
            AttemptOutcome::Success { executor, .. }
            | AttemptOutcome::Blocked { executor, .. }
            | AttemptOutcome::Failed { executor, .. }
            | AttemptOutcome::Timeout { executor, .. }
            | AttemptOutcome::Stopped { executor, .. } => executor.clone(),
        }
    }
}

#[derive(Clone)]
pub struct Runner {
    config: WorkerConfig,
    echo_tx: Option<mpsc::Sender<String>>,
}

impl Runner {
    pub fn new(config: WorkerConfig, echo_tx: Option<mpsc::Sender<String>>) -> Self {
        Self { config, echo_tx }
    }

    /// The unified finalization entry for any attempt whose [`ManagedProcess`]
    /// was actually spawned: run the bounded teardown of the process group and
    /// drains, then finalize. If teardown cannot confirm the group stopped, the
    /// intended outcome (whatever the business result looked like) is overridden
    /// to `PROCESS_STOP_UNCONFIRMED` — a clean result or an ordinary FAILED is
    /// never recorded while an old process may still be running. No exit that
    /// has a live child may force-kill and return without this stop
    /// confirmation.
    async fn finalize_after_teardown(
        &self,
        params: FinalizeParams<'_>,
        outcome: AttemptOutcome,
        child: &mut Box<dyn ManagedProcess>,
        drains: &mut Vec<JoinHandle<()>>,
    ) -> Result<TaskReceipt, RunnerError> {
        let report = teardown_managed(child, drains).await;
        let outcome = apply_teardown_evidence(outcome, &report, params.dispatch_happened);
        self.finalize_attempt(params, outcome)
    }

    fn finalize_attempt(
        &self,
        params: FinalizeParams<'_>,
        outcome: AttemptOutcome,
    ) -> Result<TaskReceipt, RunnerError> {
        let finished_at = Utc::now();
        let duration_ms = (finished_at - params.started_at).num_milliseconds().max(0) as u64;

        let stdout_snippet = params.stdout_logger.get_tail_snippet(10);
        let stderr_snippet = params.stderr_logger.get_tail_snippet(10);
        let dropped_lines_count =
            params.stdout_logger.dropped_lines_count() + params.stderr_logger.dropped_lines_count();
        let log_truncated =
            params.stdout_logger.is_truncated() || params.stderr_logger.is_truncated();

        let logs = LogSummary {
            events_path: params
                .attempt_dir
                .join("events.jsonl")
                .to_string_lossy()
                .to_string(),
            stdout_path: params
                .attempt_dir
                .join("stdout.log")
                .to_string_lossy()
                .to_string(),
            stderr_path: params
                .attempt_dir
                .join("stderr.log")
                .to_string_lossy()
                .to_string(),
            stdout_snippet,
            stderr_snippet,
            dropped_lines_count,
            log_truncated,
        };

        let stop_snapshot: Option<StopReason> = match &outcome {
            AttemptOutcome::Stopped { stop_reason, .. } => Some(stop_reason.clone()),
            _ => None,
        };

        let (exec_status, business_outcome, executor, artifacts, receipt_error, job_stage) =
            match outcome {
                AttemptOutcome::Success {
                    executor,
                    artifacts,
                    business_outcome,
                } => (
                    "COMPLETED".to_string(),
                    business_outcome,
                    executor,
                    artifacts,
                    None,
                    JobStage::Completed,
                ),
                AttemptOutcome::Blocked {
                    stage,
                    code,
                    message,
                    executor,
                } => (
                    "BLOCKED".to_string(),
                    BusinessOutcome::NotStarted,
                    executor,
                    Vec::new(),
                    Some(ReceiptError {
                        stage,
                        code,
                        message,
                    }),
                    JobStage::Blocked,
                ),
                AttemptOutcome::Failed {
                    stage,
                    code,
                    message,
                    business_outcome,
                    executor,
                    artifacts,
                } => (
                    "FAILED".to_string(),
                    business_outcome,
                    executor,
                    artifacts,
                    Some(ReceiptError {
                        stage,
                        code,
                        message,
                    }),
                    JobStage::Failed,
                ),
                AttemptOutcome::Timeout {
                    duration_secs,
                    executor,
                } => (
                    "TIMED_OUT".to_string(),
                    BusinessOutcome::Failed,
                    executor,
                    Vec::new(),
                    Some(ReceiptError {
                        stage: "execution".to_string(),
                        code: "TIMEOUT".to_string(),
                        message: format!("Execution timed out after {} seconds", duration_secs),
                    }),
                    JobStage::Failed,
                ),
                AttemptOutcome::Stopped {
                    stop_reason,
                    dispatched,
                    executor,
                } => {
                    let unverified = if dispatched {
                        BusinessOutcome::Unverified
                    } else {
                        BusinessOutcome::NotStarted
                    };
                    let (status, business, stage) = match stop_reason {
                        StopReason::UserRequested => {
                            ("CANCELLED".to_string(), unverified, JobStage::Cancelled)
                        }
                        StopReason::TaskTimedOut if dispatched => (
                            "TIMED_OUT".to_string(),
                            BusinessOutcome::Unverified,
                            JobStage::Failed,
                        ),
                        _ => ("INTERRUPTED".to_string(), unverified, JobStage::Interrupted),
                    };
                    (
                        status,
                        business,
                        executor,
                        Vec::new(),
                        Some(ReceiptError {
                            stage: "execution".to_string(),
                            code: stop_reason.code().to_string(),
                            message: "execution stopped under lease/control".to_string(),
                        }),
                        stage,
                    )
                }
            };

        let receipt = TaskReceipt {
            job_id: params.job_id.to_string(),
            attempt_id: params.attempt_id.to_string(),
            workspace: params.workspace.to_string_lossy().to_string(),
            prompt_file: params.prompt_file.to_string_lossy().to_string(),
            prompt_sha256: params.prompt_sha256.to_string(),
            execution_status: exec_status,
            business_outcome,
            executor,
            doctor: params.doctor_report,
            doctor_cache_hit: params.doctor_cache_hit,
            local_check_duration_ms: params.local_check_duration_ms,
            current_doctor_metrics: params.current_doctor_metrics,
            cached_doctor_metrics: params.cached_doctor_metrics,
            timestamps: TimestampsInfo {
                started_at: params.started_at,
                finished_at,
                duration_ms,
            },
            artifacts,
            logs,
            error: receipt_error.clone(),
            bridge_context: params.bridge_context.as_ref().map(|t| {
                let mut bc = t.clone();
                bc.task_dispatch_intent = params.dispatch_happened;
                bc.stop_reason = stop_snapshot.map(|s| s.as_safe_error());
                bc
            }),
        };

        let receipt_path = params.attempt_dir.join("receipt.json");
        if let Err(e) = receipt.persist_to_file(&receipt_path) {
            eprintln!(
                "FATAL: Failed to persist task receipt to disk at {}: {}",
                receipt_path.display(),
                e
            );
            return Err(RunnerError::ReceiptPersistFailed(e));
        }

        let artifact_paths = receipt.artifacts.iter().map(|a| a.path.clone()).collect();
        let _ = params.status_tracker.update_stage(
            job_stage,
            receipt_error.map(|re| format!("{}: {}", re.code, re.message)),
            params.log_paths,
            artifact_paths,
        );

        params.event_logger.log_event(
            "task",
            "receipt_finalized",
            LogSource::System,
            serde_json::json!({
                "job_id": receipt.job_id,
                "attempt_id": receipt.attempt_id,
                "status": receipt.execution_status,
                "business_outcome": receipt.business_outcome,
                "doctor_cache_hit": receipt.doctor_cache_hit,
                "artifacts_count": receipt.artifacts.len(),
            }),
        );

        Ok(receipt)
    }

    pub async fn run_task(
        &self,
        workspace: &Path,
        prompt_file: &Path,
        job_id_opt: Option<String>,
        timeout_secs: Option<u64>,
    ) -> Result<TaskReceipt, RunnerError> {
        self.run_task_with_options(workspace, prompt_file, job_id_opt, timeout_secs, false)
            .await
    }

    pub async fn run_task_with_options(
        &self,
        workspace: &Path,
        prompt_file: &Path,
        job_id_opt: Option<String>,
        timeout_secs: Option<u64>,
        force_doctor: bool,
    ) -> Result<TaskReceipt, RunnerError> {
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;

        // 1. Determine job_id & attempt_id (local mode generates its own).
        let job_id = match job_id_opt {
            Some(id) => {
                validate_id("job_id", &id)?;
                id
            }
            None => Uuid::new_v4().to_string(),
        };

        let target_job_dir = job_dir(&canonical_workspace, &job_id);
        if target_job_dir.exists() {
            return Err(RunnerError::JobAlreadyExists(job_id));
        }

        let attempt_id = Uuid::new_v4().to_string();
        let timeout = timeout_secs.unwrap_or(self.config.task_timeout_secs);
        self.run_attempt(
            &canonical_workspace,
            prompt_file,
            job_id,
            attempt_id,
            timeout,
            force_doctor,
            ExecGate::Local,
            None,
        )
        .await
    }

    /// Runs an attempt already assigned its job/attempt identity, optionally
    /// under a bridge [`ExecGate`]. Local mode (`ExecGate::Local`, no bridge
    /// context) reproduces the historical `run_task_with_options` behavior; the
    /// bridge mode enforces the process-identity and start-permit gates.
    #[allow(clippy::too_many_arguments)]
    async fn run_attempt(
        &self,
        workspace: &Path,
        prompt_file: &Path,
        job_id: String,
        attempt_id: String,
        timeout_secs: u64,
        force_doctor: bool,
        mut gate: ExecGate,
        bridge_ctx: Option<BridgeReceiptContext>,
    ) -> Result<TaskReceipt, RunnerError> {
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;

        let current_attempt_dir = attempt_dir(&canonical_workspace, &job_id, &attempt_id);
        fs::create_dir_all(&current_attempt_dir)?;
        let target_job_dir = job_dir(&canonical_workspace, &job_id);

        let started_at = Utc::now();
        let status_tracker = StatusTracker::new(&target_job_dir, &job_id, &attempt_id);
        let event_logger = EventLogger::new(&current_attempt_dir, &job_id, &attempt_id);
        let stdout_logger = ProcessLogger::new(
            &current_attempt_dir,
            "stdout.log",
            LogSource::Launcher,
            self.echo_tx.clone(),
        );
        let stderr_logger = ProcessLogger::new(
            &current_attempt_dir,
            "stderr.log",
            LogSource::System,
            self.echo_tx.clone(),
        );

        let mut log_paths = HashMap::new();
        log_paths.insert(
            "events".to_string(),
            current_attempt_dir
                .join("events.jsonl")
                .to_string_lossy()
                .to_string(),
        );
        log_paths.insert(
            "stdout".to_string(),
            current_attempt_dir
                .join("stdout.log")
                .to_string_lossy()
                .to_string(),
        );
        log_paths.insert(
            "stderr".to_string(),
            current_attempt_dir
                .join("stderr.log")
                .to_string_lossy()
                .to_string(),
        );

        let _ = status_tracker.update_stage(JobStage::Doctor, None, log_paths.clone(), Vec::new());
        event_logger.log_event(
            "task",
            "attempt_created",
            LogSource::System,
            serde_json::json!({
                "job_id": job_id,
                "attempt_id": attempt_id,
                "workspace": canonical_workspace.to_string_lossy(),
            }),
        );

        let finalize_params = FinalizeParams {
            job_id: &job_id,
            attempt_id: &attempt_id,
            workspace: &canonical_workspace,
            prompt_file,
            prompt_sha256: "",
            started_at,
            attempt_dir: &current_attempt_dir,
            status_tracker: &status_tracker,
            event_logger: &event_logger,
            stdout_logger: &stdout_logger,
            stderr_logger: &stderr_logger,
            log_paths: log_paths.clone(),
            doctor_report: None,
            doctor_cache_hit: false,
            local_check_duration_ms: 0,
            current_doctor_metrics: None,
            cached_doctor_metrics: None,
            dispatch_happened: false,
            bridge_context: bridge_ctx,
        };

        // 2. Snapshot task prompt
        let prompt_snapshot_path = current_attempt_dir.join("prompt.snapshot.md");
        let (prompt_content, prompt_sha256) =
            match snapshot_prompt(prompt_file, &prompt_snapshot_path) {
                Ok(res) => res,
                Err(e) => {
                    return self.finalize_attempt(
                        finalize_params,
                        AttemptOutcome::Blocked {
                            stage: "preflight".to_string(),
                            code: "PROMPT_READ_ERROR".to_string(),
                            message: format!("Failed to read prompt file: {}", e),
                            executor: ExecutorInfo {
                                executor_type: self.config.executor_type.to_string(),
                                version: "unknown".to_string(),
                                conversation_id: None,
                            },
                        },
                    );
                }
            };

        let mut finalize_params = finalize_params;
        finalize_params.prompt_sha256 = &prompt_sha256;

        // 3. Adapter preflight check
        let adapter = create_executor(&self.config);
        let executor_meta = match adapter.preflight_check() {
            Ok(meta) => meta,
            Err(ExecutorError::NeedsUserAction {
                message,
                action_required,
            }) => {
                let full_msg = format!("{}. Action required: {}", message, action_required);
                event_logger.log_event(
                    "preflight",
                    "needs_user_action",
                    LogSource::System,
                    serde_json::json!({ "error": full_msg }),
                );
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "NEEDS_USER_ACTION".to_string(),
                        message: full_msg,
                        executor: ExecutorInfo {
                            executor_type: self.config.executor_type.to_string(),
                            version: "unknown".to_string(),
                            conversation_id: None,
                        },
                    },
                );
            }
            Err(e) => {
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "ADAPTER_UNSUPPORTED".to_string(),
                        message: e.to_string(),
                        executor: ExecutorInfo {
                            executor_type: self.config.executor_type.to_string(),
                            version: "unknown".to_string(),
                            conversation_id: None,
                        },
                    },
                );
            }
        };

        let mut executor_info = ExecutorInfo {
            executor_type: executor_meta.executor_type,
            version: executor_meta.version,
            conversation_id: None,
        };

        // 4. Strict Local Pre-Check (Zero-Model)
        let local_check_start = Instant::now();
        let local_check_res = run_fast_local_precheck(
            &canonical_workspace,
            &self.config,
            executor_meta.binary_path.as_deref(),
        );
        let local_check_duration_ms = local_check_start.elapsed().as_millis() as u64;
        finalize_params.local_check_duration_ms = local_check_duration_ms;

        if let Err(e) = local_check_res {
            event_logger.log_event(
                "preflight",
                "local_precheck_failed",
                LogSource::System,
                serde_json::json!({ "error": e.to_string(), "code": e.error_code() }),
            );
            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Blocked {
                    stage: "local_precheck".to_string(),
                    code: e.error_code().to_string(),
                    message: e.to_string(),
                    executor: executor_info,
                },
            );
        }

        // 5. Baseline snapshot of workspace
        let baseline = WorkspaceSnapshot::capture(&canonical_workspace);

        // 6. Static preflight check on workspace AGENTS.md
        let preflight = match run_preflight_static_checks(&canonical_workspace) {
            Ok(p) => p,
            Err(err_msg) => {
                event_logger.log_event(
                    "preflight",
                    "static_check_failed",
                    LogSource::System,
                    serde_json::json!({ "error": err_msg }),
                );
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "DOCTOR_PREFLIGHT_FAILED".to_string(),
                        message: err_msg,
                        executor: executor_info,
                    },
                );
            }
        };

        // 7. Setup Doctor probe context
        let doctor_ctx = match DoctorProbeContext::new(
            &canonical_workspace,
            &current_attempt_dir,
            &attempt_id,
            preflight,
        ) {
            Ok(ctx) => ctx,
            Err(e) => {
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "doctor_setup".to_string(),
                        code: "DOCTOR_SETUP_FAILED".to_string(),
                        message: format!("Failed to create doctor fixture: {}", e),
                        executor: executor_info,
                    },
                );
            }
        };

        // 8. Build F_before Environment Fingerprint
        let exec_request = ExecutionRequest {
            job_id: &job_id,
            attempt_id: &attempt_id,
            workspace_dir: &canonical_workspace,
            attempt_dir: &current_attempt_dir,
            prompt_file,
            model: self.config.agent_model.as_deref(),
        };
        let launch_config = adapter.get_launch_config(&exec_request);
        let doctor_prompt = doctor_ctx.build_probe_prompt();
        let f_before = FingerprintBuilder::build(
            &canonical_workspace,
            &self.config,
            &launch_config,
            DoctorProbeContext::PROMPT_TEMPLATE,
        );

        // 9. Evaluate Doctor Cache
        let mut cached_doctor_record = None;
        let mut doctor_cache_hit = false;

        if !force_doctor && f_before.cache_eligible {
            if let Some(cache) = load_cache(&canonical_workspace) {
                if cache.is_valid(&f_before.fingerprint_hash, Utc::now()) {
                    doctor_cache_hit = true;
                    cached_doctor_record = Some(cache);
                }
            }
        }

        // 10. Spawn child process
        let mut child = match adapter.spawn_execution(&exec_request) {
            Ok(proc) => proc,
            Err(e) => {
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "spawn".to_string(),
                        code: "PROCESS_SPAWN_FAILED".to_string(),
                        message: e.to_string(),
                        executor: executor_info,
                    },
                );
            }
        };

        // Setup Single-Reader Event Dispatcher on stdout and background drain on stderr
        let (event_tx, mut event_rx) = mpsc::channel::<serde_json::Value>(100);
        let events_path = current_attempt_dir.join("events.jsonl");
        let dispatcher = StreamEventDispatcher::new(events_path, stdout_logger.clone(), event_tx);

        let mut drain_handles: Vec<JoinHandle<()>> = Vec::new();
        if let Some(stdout) = child.take_stdout() {
            drain_handles.push(tokio::spawn(dispatcher.run(stdout)));
        }
        if let Some(stderr) = child.take_stderr() {
            let stderr_drain = stderr_logger.clone();
            drain_handles.push(tokio::spawn(async move {
                stderr_drain.drain_stream(stderr).await;
            }));
        }

        // In Bridge mode, report the spawned process group and wait for the
        // controller to persist its identity before the Doctor prompt may go
        // out. If the controller stops us here (or is gone), tear down and
        // finalize before returning.
        if let Some(identity) = make_process_identity(child.pid(), child.pgid()) {
            if let Err(stop) = gate
                .signal_and_ack(RunnerSignal::ProcessSpawned(identity))
                .await
            {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Stopped {
                            stop_reason: stop,
                            dispatched: false,
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }
        }
        if let Some(stop) = gate.current_stop() {
            return self
                .finalize_after_teardown(
                    finalize_params,
                    AttemptOutcome::Stopped {
                        stop_reason: stop,
                        dispatched: false,
                        executor: executor_info.clone(),
                    },
                    &mut child,
                    &mut drain_handles,
                )
                .await;
        }

        // 11. Handle Doctor Phase
        if doctor_cache_hit {
            let cached_rec = cached_doctor_record.unwrap();
            finalize_params.doctor_cache_hit = true;
            finalize_params.doctor_report = Some(cached_rec.doctor_report.clone());
            finalize_params.current_doctor_metrics = Some(CurrentDoctorMetrics {
                duration_ms: 0,
                model_usage: None,
            });
            finalize_params.cached_doctor_metrics = Some(CachedDoctorMetrics {
                checked_at: cached_rec.checked_at,
                duration_ms: cached_rec.metrics.duration_ms,
                model_usage: cached_rec.metrics.model_usage.clone(),
            });

            event_logger.log_event(
                "doctor",
                "cache_hit",
                LogSource::System,
                serde_json::json!({
                    "fingerprint": f_before.fingerprint_hash,
                    "checked_at": cached_rec.checked_at,
                    "cached_duration_ms": cached_rec.metrics.duration_ms,
                }),
            );
        } else {
            // Execute Turn 1: Full Doctor Probe
            finalize_params.doctor_cache_hit = false;
            let _ =
                status_tracker.update_stage(JobStage::Doctor, None, log_paths.clone(), Vec::new());
            event_logger.log_event(
                "doctor",
                "turn_start",
                LogSource::System,
                serde_json::json!({ "stage": "doctor", "fingerprint": f_before.fingerprint_hash }),
            );

            let doctor_start = Instant::now();
            let doctor_msg = serde_json::json!({
                "event": "user",
                "message": { "content": doctor_prompt }
            });
            if let Err(e) = child.send_input_line(&doctor_msg.to_string()).await {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Blocked {
                            stage: "doctor".to_string(),
                            code: "STDIN_WRITE_FAILED".to_string(),
                            message: format!("Failed to send doctor message to child stdin: {}", e),
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }

            let doctor_timeout = Duration::from_secs(self.config.doctor_timeout_secs);
            let doctor_deadline = tokio::time::Instant::now() + doctor_timeout;

            let mut doctor_agent_response = String::new();
            let mut doctor_result_status = String::new();
            let mut doctor_turn_finished = false;
            let mut doctor_model_usage = None;
            let mut doctor_stopped: Option<StopReason> = None;
            let mut doctor_lease_tick =
                tokio::time::interval(std::time::Duration::from_millis(100));
            doctor_lease_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

            loop {
                tokio::select! {
                    maybe_event = event_rx.recv() => {
                        match maybe_event {
                            Some(val) => {
                                if let Some(cid) = val.get("conversation_id").and_then(|c| c.as_str()) {
                                    if executor_info.conversation_id.is_none() {
                                        executor_info.conversation_id = Some(cid.to_string());
                                    }
                                }
                                if let Some(ev_type) = val.get("event").and_then(|e| e.as_str()) {
                                    if ev_type == "step_update" {
                                        if let Some(delta) = val.get("step_update")
                                            .and_then(|s| s.get("text_delta"))
                                            .and_then(|t| t.as_str()) {
                                            doctor_agent_response.push_str(delta);
                                        }
                                    } else if ev_type == "result" {
                                        if let Some(res) = val.get("result") {
                                            doctor_result_status = res.get("status")
                                                .and_then(|s| s.as_str())
                                                .unwrap_or("UNKNOWN")
                                                .to_string();
                                            if let Some(resp) = res.get("response").and_then(|r| r.as_str()) {
                                                if !resp.is_empty() {
                                                    doctor_agent_response = resp.to_string();
                                                }
                                            }
                                            doctor_model_usage = ModelUsageInfo::from_json_value(res.get("usage"));
                                        }
                                        doctor_turn_finished = true;
                                        break;
                                    }
                                }
                            }
                            None => {
                                break;
                            }
                        }
                    }
                    _ = tokio::time::sleep_until(doctor_deadline) => {
                        return self
                            .finalize_after_teardown(
                                finalize_params,
                                AttemptOutcome::Blocked {
                                    stage: "doctor".to_string(),
                                    code: "DOCTOR_TIMEOUT".to_string(),
                                    message: format!("Doctor preflight timed out after {}s", self.config.doctor_timeout_secs),
                                    executor: executor_info.clone(),
                                },
                                &mut child,
                                &mut drain_handles,
                            )
                            .await;
                    }
                    _ = doctor_lease_tick.tick(), if gate.is_bridge() => {
                        if let Some(stop) = gate.current_stop() {
                            doctor_stopped = Some(stop);
                            break;
                        }
                    }
                }
            }

            if let Some(stop) = doctor_stopped {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Stopped {
                            stop_reason: stop,
                            dispatched: false,
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }

            if !doctor_turn_finished {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Blocked {
                            stage: "doctor".to_string(),
                            code: "DOCTOR_STREAM_TERMINATED".to_string(),
                            message: "Process or stream terminated prematurely during doctor check"
                                .to_string(),
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }

            // Evaluate Doctor Turn
            let doctor_report =
                doctor_ctx.evaluate_turn(&doctor_agent_response, &doctor_result_status);
            let doctor_duration_ms = doctor_start.elapsed().as_millis() as u64;
            finalize_params.doctor_report = Some(doctor_report.clone());
            finalize_params.current_doctor_metrics = Some(CurrentDoctorMetrics {
                duration_ms: doctor_duration_ms,
                model_usage: doctor_model_usage.clone(),
            });

            if !doctor_report.ready {
                let _ = invalidate_cache(&canonical_workspace);
                let err_msg = doctor_report
                    .error
                    .unwrap_or_else(|| "Doctor checks failed".to_string());
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Blocked {
                            stage: "doctor".to_string(),
                            code: "DOCTOR_VERIFICATION_FAILED".to_string(),
                            message: err_msg,
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }

            // Before/After Consistency Verification
            let f_after = FingerprintBuilder::build(
                &canonical_workspace,
                &self.config,
                &launch_config,
                DoctorProbeContext::PROMPT_TEMPLATE,
            );

            if f_before.fingerprint_hash != f_after.fingerprint_hash {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Blocked {
                            stage: "doctor".to_string(),
                            code: "CONFIG_CHANGED_DURING_DOCTOR".to_string(),
                            message: "Environment configuration changed during Doctor execution"
                                .to_string(),
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }

            // Save Cache if eligible
            if f_after.cache_eligible {
                let mut subitem_hashes = BTreeMap::new();
                subitem_hashes.insert(
                    "cli_settings".to_string(),
                    f_after
                        .components
                        .cli_settings
                        .content_sha256
                        .clone()
                        .unwrap_or_default(),
                );
                for r in &f_after.components.workspace_rules {
                    subitem_hashes
                        .insert(r.path.clone(), r.content_sha256.clone().unwrap_or_default());
                }

                let cache_rec = DoctorCacheRecord::new(
                    f_after.fingerprint_hash.clone(),
                    Utc::now(),
                    doctor_report.clone(),
                    DoctorMetricsRecord {
                        duration_ms: doctor_duration_ms,
                        model_usage: doctor_model_usage,
                    },
                    subitem_hashes,
                );

                if let Err(e) = save_cache(&canonical_workspace, &cache_rec) {
                    eprintln!(
                        "Notice: Failed to save doctor cache at {}: {}",
                        canonical_workspace.display(),
                        e
                    );
                }
            }

            event_logger.log_event(
                "doctor",
                "turn_passed",
                LogSource::System,
                serde_json::json!({
                    "ready": true,
                    "duration_ms": doctor_duration_ms,
                    "cache_eligible": f_after.cache_eligible,
                }),
            );
        }

        // 12. Execute Task Prompt
        let _ =
            status_tracker.update_stage(JobStage::Execution, None, log_paths.clone(), Vec::new());
        event_logger.log_event(
            "task",
            "turn_start",
            LogSource::System,
            serde_json::json!({ "stage": "task" }),
        );

        // Bridge gate: report PreparedForTask, await the start permit, then
        // re-check stop/deadline before the business prompt may be written.
        // A loss of the controller here is a stop, never an implicit approval.
        if gate.is_bridge() {
            if let Err(stop) = gate.signal_and_ack(RunnerSignal::PreparedForTask).await {
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Stopped {
                            stop_reason: stop,
                            dispatched: false,
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }
            match gate.await_permit().await {
                Ok(Some(deadline)) => {
                    // Permit granted: the controller committed DispatchIntent
                    // (shared marker set + persisted) before sending the permit.
                    // From here a stop is Unverified, never NotStarted, even if
                    // the business send itself was never observed.
                    finalize_params.dispatch_happened = true;
                    if gate.past_execution_stop(deadline) {
                        return self
                            .finalize_after_teardown(
                                finalize_params,
                                AttemptOutcome::Stopped {
                                    stop_reason: StopReason::LeaseExpired {
                                        reason: Some("EXECUTION_DEADLINE_EXCEEDED".to_string()),
                                    },
                                    dispatched: true,
                                    executor: executor_info.clone(),
                                },
                                &mut child,
                                &mut drain_handles,
                            )
                            .await;
                    }
                }
                Ok(None) => {}
                Err(stop) => {
                    // Permit never arrived (a stop preceded it). The controller
                    // may still have committed dispatch intent right before it
                    // stopped: honor the one-way shared marker rather than
                    // assuming NotStarted. This effective intent drives both the
                    // business classification and the recorded task_dispatch_intent.
                    let dispatched = gate.dispatch_intent() || finalize_params.dispatch_happened;
                    finalize_params.dispatch_happened = dispatched;
                    return self
                        .finalize_after_teardown(
                            finalize_params,
                            AttemptOutcome::Stopped {
                                stop_reason: stop,
                                dispatched,
                                executor: executor_info.clone(),
                            },
                            &mut child,
                            &mut drain_handles,
                        )
                        .await;
                }
            }
            if let Some(stop) = gate.current_stop() {
                // Reachable only after the permit was granted (dispatch intent
                // committed), so a stop here is Unverified, never NotStarted.
                return self
                    .finalize_after_teardown(
                        finalize_params,
                        AttemptOutcome::Stopped {
                            stop_reason: stop,
                            dispatched: true,
                            executor: executor_info.clone(),
                        },
                        &mut child,
                        &mut drain_handles,
                    )
                    .await;
            }
        }

        let task_msg = serde_json::json!({
            "event": "user",
            "message": { "content": prompt_content }
        });
        // The business prompt may (now) be sent. Mark dispatch so a later stop
        // maps to UNVERIFIED, never NOT_STARTED, and never resends.
        finalize_params.dispatch_happened = true;
        if let Err(e) = child.send_input_line(&task_msg.to_string()).await {
            return self
                .finalize_after_teardown(
                    finalize_params,
                    AttemptOutcome::Failed {
                        stage: "task".to_string(),
                        code: "STDIN_WRITE_FAILED".to_string(),
                        message: format!("Failed to send task prompt to child stdin: {}", e),
                        business_outcome: BusinessOutcome::Failed,
                        executor: executor_info.clone(),
                        artifacts: Vec::new(),
                    },
                    &mut child,
                    &mut drain_handles,
                )
                .await;
        }

        // Listen for Task completion
        let task_timeout_duration = Duration::from_secs(timeout_secs);
        let task_deadline = tokio::time::Instant::now() + task_timeout_duration;

        let mut task_agent_response = String::new();
        let mut task_result_status = String::new();
        let mut task_turn_finished = false;
        let mut task_authorized_permission_failure = false;
        let mut task_stopped: Option<StopReason> = None;
        let mut lease_tick = tokio::time::interval(std::time::Duration::from_millis(100));
        lease_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                maybe_event = event_rx.recv() => {
                    match maybe_event {
                        Some(val) => {
                            if let Some(cid) = val.get("conversation_id").and_then(|c| c.as_str()) {
                                if executor_info.conversation_id.is_none() {
                                    executor_info.conversation_id = Some(cid.to_string());
                                }
                            }
                            if let Some(ev_type) = val.get("event").and_then(|e| e.as_str()) {
                                if ev_type == "step_update" {
                                    if let Some(delta) = val.get("step_update")
                                        .and_then(|s| s.get("text_delta"))
                                        .and_then(|t| t.as_str()) {
                                        task_agent_response.push_str(delta);
                                    }
                                    // Check for structured tool errors indicating authorized path denial
                                    if let Some(step) = val.get("step_update") {
                                        if let Some(tool_info) = step.get("tool_info") {
                                            if let Some(err) = tool_info.get("error") {
                                                let err_msg = err.get("message").and_then(|m| m.as_str()).unwrap_or_default();
                                                if (err_msg.contains("permission check failed") || err_msg.contains("user denied permission"))
                                                    && (err_msg.contains(&canonical_workspace.to_string_lossy().to_string()) || err_msg.contains("/tmp")) {
                                                    task_authorized_permission_failure = true;
                                                }
                                            }
                                        }
                                    }
                                } else if ev_type == "result" {
                                    if let Some(res) = val.get("result") {
                                        task_result_status = res.get("status")
                                            .and_then(|s| s.as_str())
                                            .unwrap_or("UNKNOWN")
                                            .to_string();
                                        if let Some(resp) = res.get("response").and_then(|r| r.as_str()) {
                                            if !resp.is_empty() {
                                                task_agent_response = resp.to_string();
                                            }
                                        }
                                    }
                                    task_turn_finished = true;
                                    break;
                                }
                            }
                        }
                        None => {
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep_until(task_deadline) => {
                    return self
                        .finalize_after_teardown(
                            finalize_params,
                            AttemptOutcome::Timeout {
                                duration_secs: timeout_secs,
                                executor: executor_info.clone(),
                            },
                            &mut child,
                            &mut drain_handles,
                        )
                        .await;
                }
                _ = lease_tick.tick(), if gate.is_bridge() => {
                    if let Some(stop) = gate.current_stop() {
                        task_stopped = Some(stop);
                        break;
                    }
                }
            }
        }

        // Teardown & graceful child exit (bounded two-phase; joins drains).
        let teardown = teardown_managed(&mut child, &mut drain_handles).await;

        // Classify the business outcome only after stop confirmation. Any exit
        // below funnels through `apply_teardown_evidence`: when teardown could
        // not confirm the process group stopped, the business result — a clean
        // success, an ordinary FAILED, or a stop — is never recorded as-is; it
        // is overridden to PROCESS_STOP_UNCONFIRMED so the attempt is kept for
        // recovery. Dispatch has happened here (the business prompt was sent),
        // so the escalation preserves dispatch intent as true.
        let base_outcome = if let Some(stop) = task_stopped {
            AttemptOutcome::Stopped {
                stop_reason: stop,
                dispatched: true,
                executor: executor_info.clone(),
            }
        } else if !task_turn_finished || !task_result_status.eq_ignore_ascii_case("success") {
            let stderr_tail = stderr_logger.get_tail_snippet(10);
            let combined_err = format!("{} {}", task_agent_response, stderr_tail);

            if task_authorized_permission_failure
                || combined_err.contains("sandbox configuration error")
                || combined_err.contains("jetski: no output produced")
            {
                let _ = invalidate_cache(&canonical_workspace);
                event_logger.log_event(
                    "doctor",
                    "cache_invalidated",
                    LogSource::System,
                    serde_json::json!({ "reason": "authorized_capability_or_sandbox_failure" }),
                );
            }

            AttemptOutcome::Failed {
                stage: "task".to_string(),
                code: "TASK_EXECUTION_FAILED".to_string(),
                message: format!(
                    "Task turn finished with non-success status: {}",
                    task_result_status
                ),
                business_outcome: BusinessOutcome::Failed,
                executor: executor_info.clone(),
                artifacts: Vec::new(),
            }
        } else {
            // 13. Verification of Artifacts (clean business success path).
            let verification = GenericVerifier::verify_attempt(
                &canonical_workspace,
                &current_attempt_dir,
                &baseline,
                &task_agent_response,
            );
            AttemptOutcome::Success {
                executor: executor_info.clone(),
                artifacts: verification.verified_artifacts,
                business_outcome: verification.outcome,
            }
        };

        let outcome = apply_teardown_evidence(base_outcome, &teardown, true);
        self.finalize_attempt(finalize_params, outcome)
    }

    /// Runs a fresh attempt under bridge control, reusing the same pipeline as
    /// local mode (no second Doctor/verification path). The caller (bridge
    /// controller) must already hold the execution lock, must use a fresh
    /// attempt id, and must hand over the runner-side [`RunnerControls`].
    /// Refuses to re-run an attempt that already has a final receipt.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_managed(
        &self,
        workspace: &Path,
        job_id: &str,
        attempt_id: &str,
        prompt_file: &Path,
        timeout_secs: u64,
        force_doctor: bool,
        controls: RunnerControls,
        context: BridgeReceiptContext,
    ) -> Result<TaskReceipt, RunnerError> {
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;
        validate_id("job_id", job_id)?;
        validate_id("attempt_id", attempt_id)?;
        let ad = attempt_dir(&canonical_workspace, job_id, attempt_id);
        if ad.join("receipt.json").exists() {
            return Err(RunnerError::AttemptAlreadyFinalized(attempt_id.to_string()));
        }
        self.run_attempt(
            &canonical_workspace,
            prompt_file,
            job_id.to_string(),
            attempt_id.to_string(),
            timeout_secs,
            force_doctor,
            ExecGate::Bridge(controls),
            Some(context),
        )
        .await
    }

    pub async fn run_standalone_doctor(
        &self,
        workspace: &Path,
    ) -> Result<SessionDoctorReport, RunnerError> {
        self.run_standalone_doctor_with_options(workspace, false)
            .await
    }

    pub async fn run_standalone_doctor_with_options(
        &self,
        workspace: &Path,
        force: bool,
    ) -> Result<SessionDoctorReport, RunnerError> {
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;

        // Preflight static checks
        let preflight = match run_preflight_static_checks(&canonical_workspace) {
            Ok(p) => p,
            Err(e) => {
                return Ok(SessionDoctorReport {
                    ready: false,
                    rule_marker: None,
                    agents_md_hash: "".to_string(),
                    checks: vec![crate::doctor::DoctorCheckItem {
                        name: "static_preflight".to_string(),
                        passed: false,
                        message: e.clone(),
                    }],
                    error: Some(e),
                });
            }
        };

        // Create standalone doctor attempt dir
        let timestamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let doctor_dir = canonical_workspace
            .join(".ceo")
            .join("doctor")
            .join(&timestamp);
        fs::create_dir_all(&doctor_dir)?;

        let doctor_ctx =
            DoctorProbeContext::new(&canonical_workspace, &doctor_dir, &timestamp, preflight)?;

        let adapter = create_executor(&self.config);
        let exec_request = ExecutionRequest {
            job_id: "doctor",
            attempt_id: &timestamp,
            workspace_dir: &canonical_workspace,
            attempt_dir: &doctor_dir,
            prompt_file: &canonical_workspace.join("AGENTS.md"),
            model: self.config.agent_model.as_deref(),
        };

        // Check local precheck first
        let executor_meta = adapter.preflight_check().ok();
        let local_res = run_fast_local_precheck(
            &canonical_workspace,
            &self.config,
            executor_meta
                .as_ref()
                .and_then(|m| m.binary_path.as_deref()),
        );
        if let Err(e) = local_res {
            return Ok(SessionDoctorReport {
                ready: false,
                rule_marker: Some(doctor_ctx.expected_marker),
                agents_md_hash: doctor_ctx.agents_md_hash,
                checks: vec![crate::doctor::DoctorCheckItem {
                    name: "local_precheck".to_string(),
                    passed: false,
                    message: e.to_string(),
                }],
                error: Some(e.to_string()),
            });
        }

        // Check cache if !force
        let launch_config = adapter.get_launch_config(&exec_request);
        let doctor_prompt = doctor_ctx.build_probe_prompt();
        let f_before = FingerprintBuilder::build(
            &canonical_workspace,
            &self.config,
            &launch_config,
            DoctorProbeContext::PROMPT_TEMPLATE,
        );

        if !force && f_before.cache_eligible {
            if let Some(cached) = load_cache(&canonical_workspace) {
                if cached.is_valid(&f_before.fingerprint_hash, Utc::now()) {
                    return Ok(cached.doctor_report);
                }
            }
        }

        let mut child = match adapter.spawn_execution(&exec_request) {
            Ok(proc) => proc,
            Err(e) => {
                return Ok(SessionDoctorReport {
                    ready: false,
                    rule_marker: Some(doctor_ctx.expected_marker),
                    agents_md_hash: doctor_ctx.agents_md_hash,
                    checks: vec![crate::doctor::DoctorCheckItem {
                        name: "spawn_execution".to_string(),
                        passed: false,
                        message: e.to_string(),
                    }],
                    error: Some(e.to_string()),
                });
            }
        };

        let (event_tx, mut event_rx) = mpsc::channel::<serde_json::Value>(100);
        let stdout_logger = ProcessLogger::new(&doctor_dir, "stdout.log", LogSource::Doctor, None);
        let dispatcher =
            StreamEventDispatcher::new(doctor_dir.join("events.jsonl"), stdout_logger, event_tx);

        let mut doctor_drains: Vec<JoinHandle<()>> = Vec::new();
        if let Some(stdout) = child.take_stdout() {
            doctor_drains.push(tokio::spawn(dispatcher.run(stdout)));
        }

        let doctor_start = Instant::now();
        let doctor_msg = serde_json::json!({
            "event": "user",
            "message": { "content": doctor_prompt }
        });
        let _ = child.send_input_line(&doctor_msg.to_string()).await;

        let doctor_deadline =
            tokio::time::Instant::now() + Duration::from_secs(self.config.doctor_timeout_secs);
        let mut doctor_response = String::new();
        let mut result_status = String::new();
        let mut model_usage = None;

        loop {
            tokio::select! {
                maybe_event = event_rx.recv() => {
                    match maybe_event {
                        Some(val) => {
                            if let Some(ev_type) = val.get("event").and_then(|e| e.as_str()) {
                                if ev_type == "step_update" {
                                    if let Some(delta) = val.get("step_update")
                                        .and_then(|s| s.get("text_delta"))
                                        .and_then(|t| t.as_str()) {
                                        doctor_response.push_str(delta);
                                    }
                                } else if ev_type == "result" {
                                    if let Some(res) = val.get("result") {
                                        result_status = res.get("status").and_then(|s| s.as_str()).unwrap_or("UNKNOWN").to_string();
                                        if let Some(resp) = res.get("response").and_then(|r| r.as_str()) {
                                            if !resp.is_empty() {
                                                doctor_response = resp.to_string();
                                            }
                                        }
                                        model_usage = ModelUsageInfo::from_json_value(res.get("usage"));
                                    }
                                    break;
                                }
                            }
                        }
                        None => break,
                    }
                }
                _ = tokio::time::sleep_until(doctor_deadline) => {
                    // Timeout: fall through to the shared bounded teardown,
                    // which SIGTERMs, escalates and confirms the group stopped.
                    break;
                }
            }
        }

        // Confirm the spawned doctor process group is fully stopped via the same
        // bounded teardown every managed-process exit uses (never a bare
        // force-kill + drop). An unconfirmed stop means the standalone doctor is
        // not clean: report it as not-ready rather than claiming success.
        let teardown = teardown_managed(&mut child, &mut doctor_drains).await;
        if !teardown.fully_stopped() {
            return Ok(SessionDoctorReport {
                ready: false,
                rule_marker: Some(doctor_ctx.expected_marker),
                agents_md_hash: doctor_ctx.agents_md_hash,
                checks: vec![crate::doctor::DoctorCheckItem {
                    name: "stop_confirmation".to_string(),
                    passed: false,
                    message: "Doctor process could not be confirmed stopped".to_string(),
                }],
                error: Some("Doctor process could not be confirmed stopped".to_string()),
            });
        }

        let report = doctor_ctx.evaluate_turn(&doctor_response, &result_status);
        let doctor_duration_ms = doctor_start.elapsed().as_millis() as u64;

        if report.ready {
            let f_after = FingerprintBuilder::build(
                &canonical_workspace,
                &self.config,
                &launch_config,
                DoctorProbeContext::PROMPT_TEMPLATE,
            );

            if f_before.fingerprint_hash == f_after.fingerprint_hash && f_after.cache_eligible {
                let mut subitem_hashes = BTreeMap::new();
                subitem_hashes.insert(
                    "cli_settings".to_string(),
                    f_after
                        .components
                        .cli_settings
                        .content_sha256
                        .clone()
                        .unwrap_or_default(),
                );
                for r in &f_after.components.workspace_rules {
                    subitem_hashes
                        .insert(r.path.clone(), r.content_sha256.clone().unwrap_or_default());
                }

                let cache_rec = DoctorCacheRecord::new(
                    f_after.fingerprint_hash.clone(),
                    Utc::now(),
                    report.clone(),
                    DoctorMetricsRecord {
                        duration_ms: doctor_duration_ms,
                        model_usage,
                    },
                    subitem_hashes,
                );
                let _ = save_cache(&canonical_workspace, &cache_rec);
            }
        }

        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teardown_report_fully_stopped_requires_all_confirmed() {
        let full = TeardownReport {
            group_confirmed_empty: true,
            leader_reaped: true,
            drains_ended: true,
        };
        assert!(full.fully_stopped());
        // Each unconfirmed step alone means not fully stopped.
        assert!(!TeardownReport {
            group_confirmed_empty: false,
            ..full
        }
        .fully_stopped());
        assert!(!TeardownReport {
            leader_reaped: false,
            ..full
        }
        .fully_stopped());
        assert!(!TeardownReport {
            drains_ended: false,
            ..full
        }
        .fully_stopped());
    }

    fn stub_executor() -> ExecutorInfo {
        use crate::receipt::ExecutorInfo;
        ExecutorInfo {
            executor_type: "test_stub".to_string(),
            version: "v".to_string(),
            conversation_id: None,
        }
    }

    #[test]
    fn apply_teardown_evidence_keeps_outcome_when_fully_stopped() {
        let full = TeardownReport {
            group_confirmed_empty: true,
            leader_reaped: true,
            drains_ended: true,
        };
        // A confirmed stop keeps the intended outcome (dispatch preserved).
        let outcome = AttemptOutcome::Success {
            executor: stub_executor(),
            artifacts: Vec::new(),
            business_outcome: crate::verifier::BusinessOutcome::Verified,
        };
        match apply_teardown_evidence(outcome, &full, true) {
            AttemptOutcome::Success { .. } => {}
            other => {
                let _ = other;
                panic!("expected unchanged Success")
            }
        }
        let stopped = AttemptOutcome::Stopped {
            stop_reason: StopReason::UserRequested,
            dispatched: false,
            executor: stub_executor(),
        };
        assert!(matches!(
            apply_teardown_evidence(stopped, &full, false),
            AttemptOutcome::Stopped { .. }
        ));
    }

    #[test]
    fn apply_teardown_evidence_escalates_unconfirmed_stop_over_business_result() {
        let partial = TeardownReport {
            group_confirmed_empty: false,
            leader_reaped: false,
            drains_ended: true,
        };
        // A business FAILED whose process group could not be confirmed stopped
        // must NOT surface as an ordinary, continuable FAILED: it becomes
        // PROCESS_STOP_UNCONFIRMED (kept for recovery), preserving dispatch.
        let failed = AttemptOutcome::Failed {
            stage: "task".to_string(),
            code: "TASK_EXECUTION_FAILED".to_string(),
            message: "non-success".to_string(),
            business_outcome: crate::verifier::BusinessOutcome::Failed,
            executor: stub_executor(),
            artifacts: Vec::new(),
        };
        match apply_teardown_evidence(failed, &partial, true) {
            AttemptOutcome::Stopped {
                stop_reason,
                dispatched,
                ..
            } => {
                assert_eq!(stop_reason, StopReason::ProcessStopUnconfirmed);
                assert!(dispatched);
            }
            other => {
                let _ = other;
                panic!("expected escalated unconfirmed stop")
            }
        }
        // A clean success under an unconfirmed stop also escalates (never a
        // clean completion while an old process may still be running).
        let success = AttemptOutcome::Success {
            executor: stub_executor(),
            artifacts: Vec::new(),
            business_outcome: crate::verifier::BusinessOutcome::Verified,
        };
        match apply_teardown_evidence(success, &partial, true) {
            AttemptOutcome::Stopped {
                stop_reason,
                dispatched,
                ..
            } => {
                assert_eq!(stop_reason, StopReason::ProcessStopUnconfirmed);
                assert!(dispatched);
            }
            other => {
                let _ = other;
                panic!("expected escalated unconfirmed stop")
            }
        }
    }

    /// Spawns a real `/bin/sh` child (new process group, stdout piped) running
    /// `script`. Used to exercise `teardown_managed` against an actual process
    /// group rather than a hand-constructed report.
    fn spawn_real_group(
        script: &str,
    ) -> (Box<dyn ManagedProcess>, Option<tokio::process::ChildStdout>) {
        use crate::executor::process::GroupManagedProcess;
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("spawn sh group");
        let pgid = child.id().map(|p| p as i32);
        let stdout = child.stdout.take();
        (Box::new(GroupManagedProcess::new(child, pgid)), stdout)
    }

    #[tokio::test]
    async fn teardown_escalates_sigkill_and_reaps_leader_within_budget() {
        // A group that ignores SIGTERM and keeps writing to stdout: teardown
        // must escalate to SIGKILL, reap the leader, confirm the group empty and
        // drain the (now-closed) stdout — all inside one ~5 s hard budget, not
        // per-step waits that stack.
        let (mut child, stdout) = spawn_real_group(
            r#"trap "" TERM; i=0; while true; do echo "tick $i"; i=$((i+1)); sleep 0.02; done"#,
        );
        let mut drains: Vec<JoinHandle<()>> = Vec::new();
        if let Some(stdout) = stdout {
            drains.push(tokio::spawn(async move {
                let mut r = tokio::io::BufReader::new(stdout);
                let mut sink = tokio::io::sink();
                let _ = tokio::io::copy(&mut r, &mut sink).await;
            }));
        }
        let t0 = std::time::Instant::now();
        let report = teardown_managed(&mut child, &mut drains).await;
        let elapsed = t0.elapsed();
        // Unified budget: hard deadline 5 s. Give generous CI margin.
        assert!(
            elapsed < Duration::from_secs(8),
            "teardown exceeded unified budget: {elapsed:?}"
        );
        assert!(report.leader_reaped, "leader not reaped: {report:?}");
        assert!(
            report.group_confirmed_empty,
            "group not confirmed empty after SIGKILL: {report:?}"
        );
        // The stdout drain should have ended once the group was killed (EOF).
        assert!(report.drains_ended, "stdout drain did not end: {report:?}");
        // No live member of the group remains after teardown.
        let pg = child.pgid().expect("pgid recorded");
        let still_live = crate::executor::process::pgid_has_live_members(pg).unwrap_or(true);
        assert!(!still_live, "group still has live members after teardown");
    }

    #[tokio::test]
    async fn teardown_aborts_never_ending_drain_within_budget() {
        // A child that exits immediately (so the group empties and the leader is
        // reaped fast), but with a drain that never observes EOF. teardown must
        // abort + await that drain inside the remaining hard budget, report
        // drains_ended == false, and never leave it detached.
        let (mut child, _stdout) = spawn_real_group("exit 0");
        // Wait a moment for it to fully exit and be reapable.
        let mut drains: Vec<JoinHandle<()>> = Vec::new();
        drains.push(tokio::spawn(async {
            // Never-ending drain that never sees EOF.
            loop {
                tokio::time::sleep(Duration::from_secs(60)).await;
            }
        }));
        let t0 = std::time::Instant::now();
        let report = teardown_managed(&mut child, &mut drains).await;
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_secs(8),
            "drain abort exceeded unified budget: {elapsed:?}"
        );
        assert!(report.leader_reaped, "leader not reaped: {report:?}");
        assert!(
            report.group_confirmed_empty,
            "group not confirmed empty: {report:?}"
        );
        assert!(
            !report.drains_ended,
            "never-ending drain must be reported as not ended"
        );
        assert!(
            drains.is_empty(),
            "drain handle must have been consumed/aborted"
        );
    }

    /// Sets up a managed workspace (AGENTS.md rule marker + stub mode) plus a
    /// prompt, and returns (workspace, prompt_file, stub bin).
    fn managed_workspace(
        root: &std::path::Path,
    ) -> (std::path::PathBuf, std::path::PathBuf, std::path::PathBuf) {
        use std::fs;
        let ws = root.join("workspace");
        fs::create_dir_all(&ws).unwrap();
        fs::write(
            ws.join("AGENTS.md"),
            "# Guidelines\n\n<!-- ceo:metadata rule_marker: \"MKT-RUN\" -->\n\nrespect.\n",
        )
        .unwrap();
        fs::write(ws.join(".stub_mode"), "normal").unwrap();
        let prompt = root.join("prompt.md");
        fs::write(&prompt, "bridge managed task\n").unwrap();
        let bin = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("test_stub.sh");
        (ws, prompt, bin)
    }

    /// A user stop requested *after* the controller grants the execution permit
    /// (i.e. after DispatchIntent is committed) must record dispatch intent as
    /// true and classify the stop as Unverified (CANCELLED), never NotStarted —
    /// the runner is never demoted to NotStarted once the permit was granted.
    #[allow(clippy::field_reassign_with_default)]
    #[tokio::test]
    async fn bridge_gated_stop_after_permit_preserves_dispatch_intent() {
        use crate::bridge::lease::{Clock, ManualClock};
        use crate::config::{ExecutorType, WorkerConfig};
        use crate::runner::control::{control_channel, RunnerSignal};
        use std::sync::Arc;
        use std::time::Duration as StdDuration;
        use tempfile::tempdir;

        let temp = tempdir().unwrap();
        let (ws, prompt, bin) = managed_workspace(temp.path());

        let mut config = WorkerConfig::default();
        config.workspace_dir = ws.clone();
        config.executor_type = ExecutorType::TestStub;
        config.agent_executable = bin;

        let clock: Arc<dyn Clock> = Arc::new(ManualClock::default());
        let job_id = "job-bridge-stop";
        let attempt_id = "attempt-bridge-stop-1";
        let hex64 = "a".repeat(64);

        let context = BridgeReceiptContext {
            server_origin: "https://ceo.example".to_string(),
            user_id: "usr_1".to_string(),
            workspace_id: "ws_1".to_string(),
            workspace_ref: "tools".to_string(),
            worker_id: "wrk-test".to_string(),
            job_id: job_id.to_string(),
            attempt_id: attempt_id.to_string(),
            source_prompt_sha256: hex64.clone(),
            acceptance_sha256: hex64,
            task_dispatch_intent: false,
            stop_reason: None,
        };

        let (runner_controls, ctl) = control_channel(clock.clone());
        let crate::runner::control::ControllerHandles {
            mut signals_rx,
            permit_tx,
            stop_tx,
            clock: _c,
            dispatch_intent,
        } = ctl;

        let runner = Runner::new(config.clone(), None);
        let run = tokio::spawn(async move {
            runner
                .run_managed(
                    &ws,
                    job_id,
                    attempt_id,
                    &prompt,
                    60,
                    false,
                    runner_controls,
                    context,
                )
                .await
        });

        // Play the controller: ack ProcessSpawned and PreparedForTask.
        let mut got = 0usize;
        while got < 2 {
            let (signal, ack) = signals_rx.recv().await.expect("runner must send signals");
            match signal {
                RunnerSignal::ProcessSpawned(_) => {
                    let _ = ack.send(());
                    got += 1;
                }
                RunnerSignal::PreparedForTask => {
                    let _ = ack.send(());
                    got += 1;
                }
            }
        }
        // Commit dispatch intent (shared marker) and grant the permit, then
        // request a user stop right after.
        dispatch_intent.store(true, std::sync::atomic::Ordering::SeqCst);
        permit_tx
            .send(crate::runner::control::ExecutionPermit {
                execution_deadline: clock.now_boot().unwrap() + StdDuration::from_secs(300),
            })
            .unwrap();
        let _ = stop_tx.send(Some(StopReason::UserRequested));

        let receipt = match run.await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => panic!("runner returned an error: {e}"),
            Err(e) => panic!("runner task join failed: {e}"),
        };
        assert_eq!(receipt.execution_status, "CANCELLED");
        let bc = receipt.bridge_context.expect("bridge context present");
        assert!(
            bc.task_dispatch_intent,
            "dispatch intent must remain true once the permit was granted"
        );
        assert_eq!(
            receipt.business_outcome,
            crate::verifier::BusinessOutcome::Unverified
        );
    }
}
