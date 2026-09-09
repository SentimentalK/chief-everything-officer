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

/// Escalates to ProcessStopUnconfirmed when teardown could not be confirmed, so
/// the caller never records a clean stop or continues as if the process were
/// gone after an unconfirmed termination.
fn teardown_stop(report: &TeardownReport, intended: StopReason) -> StopReason {
    if report.fully_stopped() {
        intended
    } else {
        StopReason::ProcessStopUnconfirmed
    }
}

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

/// Two-phase, bounded termination of the managed process group plus its log
/// drains under a single budget: close stdin → SIGTERM the whole PGID → up to
/// 3 s for the group to empty (leader reaped while it drains) → SIGKILL any
/// remainder → up to 2 s to reap the leader and confirm the group empty → join
/// the drain tasks (aborting+awaiting on timeout, never detaching). Every step
/// that cannot be confirmed is reported so the caller never treats the process
/// as gone or the attempt as cleanly complete.
async fn teardown_managed(
    child: &mut Box<dyn ManagedProcess>,
    drains: &mut Vec<JoinHandle<()>>,
) -> TeardownReport {
    use tokio::time::timeout;
    let _ = child.close_stdin();
    // Phase 1: graceful SIGTERM to the group; wait up to 3 s for it to empty.
    let _ = child.kill_group();
    for _ in 0..60 {
        let empty = match child.pgid() {
            Some(pg) => match pgid_has_live_members(pg) {
                Ok(has) => !has,
                Err(_) => false, // scan fault -> cannot confirm empty
            },
            None => false, // no recorded pgid -> cannot confirm empty
        };
        if empty {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // Phase 2: SIGKILL anything that ignored SIGTERM, then reap the leader.
    let _ = child.force_kill_group();
    let leader_reaped = matches!(
        timeout(Duration::from_secs(2), child.wait()).await,
        Ok(Ok(_))
    );
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
    // Join the drain tasks (bounded), aborting + awaiting on timeout so no drain
    // task is ever detached into the background.
    let mut drains_ended = true;
    for handle in drains.drain(..) {
        if !join_or_abort(handle, Duration::from_secs(2)).await {
            drains_ended = false;
        }
    }
    TeardownReport {
        group_confirmed_empty,
        leader_reaped,
        drains_ended,
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

#[derive(Clone)]
pub struct Runner {
    config: WorkerConfig,
    echo_tx: Option<mpsc::Sender<String>>,
}

impl Runner {
    pub fn new(config: WorkerConfig, echo_tx: Option<mpsc::Sender<String>>) -> Self {
        Self { config, echo_tx }
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
                let executor = executor_info.clone();
                teardown_managed(&mut child, &mut drain_handles).await;
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Stopped {
                        stop_reason: stop,
                        dispatched: false,
                        executor,
                    },
                );
            }
        }
        if let Some(stop) = gate.current_stop() {
            let executor = executor_info.clone();
            teardown_managed(&mut child, &mut drain_handles).await;
            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Stopped {
                    stop_reason: stop,
                    dispatched: false,
                    executor,
                },
            );
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
                let _ = child.force_kill_group();
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "STDIN_WRITE_FAILED".to_string(),
                        message: format!("Failed to send doctor message to child stdin: {}", e),
                        executor: executor_info,
                    },
                );
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
                        let _ = child.force_kill_group();
                        return self.finalize_attempt(
                            finalize_params,
                            AttemptOutcome::Blocked {
                                stage: "doctor".to_string(),
                                code: "DOCTOR_TIMEOUT".to_string(),
                                message: format!("Doctor preflight timed out after {}s", self.config.doctor_timeout_secs),
                                executor: executor_info,
                            },
                        );
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
                teardown_managed(&mut child, &mut drain_handles).await;
                let executor = executor_info.clone();
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Stopped {
                        stop_reason: stop,
                        dispatched: false,
                        executor,
                    },
                );
            }

            if !doctor_turn_finished {
                let _ = child.force_kill_group();
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "DOCTOR_STREAM_TERMINATED".to_string(),
                        message: "Process or stream terminated prematurely during doctor check"
                            .to_string(),
                        executor: executor_info,
                    },
                );
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
                let _ = child.force_kill_group();
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "DOCTOR_VERIFICATION_FAILED".to_string(),
                        message: err_msg,
                        executor: executor_info,
                    },
                );
            }

            // Before/After Consistency Verification
            let f_after = FingerprintBuilder::build(
                &canonical_workspace,
                &self.config,
                &launch_config,
                DoctorProbeContext::PROMPT_TEMPLATE,
            );

            if f_before.fingerprint_hash != f_after.fingerprint_hash {
                let _ = child.force_kill_group();
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "CONFIG_CHANGED_DURING_DOCTOR".to_string(),
                        message: "Environment configuration changed during Doctor execution"
                            .to_string(),
                        executor: executor_info,
                    },
                );
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
                let executor = executor_info.clone();
                teardown_managed(&mut child, &mut drain_handles).await;
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Stopped {
                        stop_reason: stop,
                        dispatched: false,
                        executor,
                    },
                );
            }
            match gate.await_permit().await {
                Ok(Some(deadline)) => {
                    if gate.past_execution_stop(deadline) {
                        let executor = executor_info.clone();
                        teardown_managed(&mut child, &mut drain_handles).await;
                        return self.finalize_attempt(
                            finalize_params,
                            AttemptOutcome::Stopped {
                                stop_reason: StopReason::LeaseExpired {
                                    reason: Some("EXECUTION_DEADLINE_EXCEEDED".to_string()),
                                },
                                dispatched: false,
                                executor,
                            },
                        );
                    }
                }
                Ok(None) => {}
                Err(stop) => {
                    let executor = executor_info.clone();
                    teardown_managed(&mut child, &mut drain_handles).await;
                    return self.finalize_attempt(
                        finalize_params,
                        AttemptOutcome::Stopped {
                            stop_reason: stop,
                            dispatched: false,
                            executor,
                        },
                    );
                }
            }
            if let Some(stop) = gate.current_stop() {
                let executor = executor_info.clone();
                teardown_managed(&mut child, &mut drain_handles).await;
                return self.finalize_attempt(
                    finalize_params,
                    AttemptOutcome::Stopped {
                        stop_reason: stop,
                        dispatched: false,
                        executor,
                    },
                );
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
            let _ = child.force_kill_group();
            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Failed {
                    stage: "task".to_string(),
                    code: "STDIN_WRITE_FAILED".to_string(),
                    message: format!("Failed to send task prompt to child stdin: {}", e),
                    business_outcome: BusinessOutcome::Failed,
                    executor: executor_info,
                    artifacts: Vec::new(),
                },
            );
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
                    let _ = child.force_kill_group();
                    return self.finalize_attempt(
                        finalize_params,
                        AttemptOutcome::Timeout {
                            duration_secs: timeout_secs,
                            executor: executor_info,
                        },
                    );
                }
                _ = lease_tick.tick(), if gate.is_bridge() => {
                    if let Some(stop) = gate.current_stop() {
                        task_stopped = Some(stop);
                        break;
                    }
                }
            }
        }

        // Teardown & Graceful Child Exit (bounded two-phase; joins drains).
        let teardown = teardown_managed(&mut child, &mut drain_handles).await;

        if let Some(stop) = task_stopped {
            let executor = executor_info.clone();
            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Stopped {
                    stop_reason: teardown_stop(&teardown, stop),
                    dispatched: true,
                    executor,
                },
            );
        }

        if !task_turn_finished || !task_result_status.eq_ignore_ascii_case("success") {
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

            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Failed {
                    stage: "task".to_string(),
                    code: "TASK_EXECUTION_FAILED".to_string(),
                    message: format!(
                        "Task turn finished with non-success status: {}",
                        task_result_status
                    ),
                    business_outcome: BusinessOutcome::Failed,
                    executor: executor_info,
                    artifacts: Vec::new(),
                },
            );
        }

        // 13. Verification of Artifacts
        let verification = GenericVerifier::verify_attempt(
            &canonical_workspace,
            &current_attempt_dir,
            &baseline,
            &task_agent_response,
        );

        if !teardown.fully_stopped() {
            // The business turn finished, but the process group / drains could
            // not be confirmed stopped. Never write a clean completion: the
            // outcome is unverified under ProcessStopUnconfirmed.
            let executor = executor_info.clone();
            return self.finalize_attempt(
                finalize_params,
                AttemptOutcome::Stopped {
                    stop_reason: StopReason::ProcessStopUnconfirmed,
                    dispatched: true,
                    executor,
                },
            );
        }

        self.finalize_attempt(
            finalize_params,
            AttemptOutcome::Success {
                executor: executor_info,
                artifacts: verification.verified_artifacts,
                business_outcome: verification.outcome,
            },
        )
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

        if let Some(stdout) = child.take_stdout() {
            tokio::spawn(dispatcher.run(stdout));
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
                _ = child.wait() => break,
                _ = tokio::time::sleep_until(doctor_deadline) => {
                    let _ = child.force_kill_group();
                    break;
                }
            }
        }

        let _ = child.close_stdin();
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

    #[test]
    fn teardown_stop_escalates_when_unconfirmed() {
        let full = TeardownReport {
            group_confirmed_empty: true,
            leader_reaped: true,
            drains_ended: true,
        };
        let intended = StopReason::UserRequested;
        assert_eq!(teardown_stop(&full, intended.clone()), intended);
        let partial = TeardownReport {
            group_confirmed_empty: false,
            ..full
        };
        assert_eq!(
            teardown_stop(&partial, intended),
            StopReason::ProcessStopUnconfirmed
        );
    }
}
