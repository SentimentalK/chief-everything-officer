use crate::config::{attempt_dir, job_dir, snapshot_prompt, validate_id, WorkerConfig};
use crate::doctor::{run_preflight_static_checks, DoctorProbeContext, SessionDoctorReport};
use crate::executor::{create_executor, ExecutionRequest, ExecutorError};
use crate::observability::{
    EventLogger, JobStage, LogSource, ProcessLogger, StatusTracker, StreamEventDispatcher,
};
use crate::receipt::{ExecutorInfo, LogSummary, ReceiptError, TaskReceipt, TimestampsInfo};
use crate::verifier::{ArtifactClaim, BusinessOutcome, GenericVerifier, WorkspaceSnapshot};
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::mpsc;
use uuid::Uuid;

#[derive(Error, Debug)]
pub enum RunnerError {
    #[error("Job ID '{0}' already exists. Refusing to overwrite or re-execute.")]
    JobAlreadyExists(String),
    #[error("Configuration error: {0}")]
    ConfigError(#[from] crate::config::ConfigError),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Doctor failed: {0}")]
    DoctorFailed(String),
    #[error("Failed to persist task receipt to disk: {0}")]
    ReceiptPersistFailed(std::io::Error),
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
}

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
            timestamps: TimestampsInfo {
                started_at: params.started_at,
                finished_at,
                duration_ms,
            },
            artifacts,
            logs,
            error: receipt_error.clone(),
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
            receipt_error.map(|e| e.message),
            params.log_paths,
            artifact_paths,
        );

        params.event_logger.log_event(
            "completion",
            "receipt_finalized",
            LogSource::System,
            serde_json::json!({
                "status": receipt.execution_status,
                "outcome": receipt.business_outcome,
            }),
        );

        Ok(receipt)
    }

    pub async fn run_task(
        &self,
        workspace: &Path,
        prompt_file: &Path,
        custom_job_id: Option<String>,
        timeout_secs: Option<u64>,
    ) -> Result<TaskReceipt, RunnerError> {
        let started_at = Utc::now();

        // 1. Validate paths and IDs
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;
        if !canonical_workspace.is_dir() {
            return Err(RunnerError::ConfigError(
                crate::config::ConfigError::InvalidPath(format!(
                    "Workspace is not a directory: {}",
                    canonical_workspace.display()
                )),
            ));
        }

        let job_id = custom_job_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        validate_id("job_id", &job_id)?;
        let attempt_id = Uuid::new_v4().to_string();
        validate_id("attempt_id", &attempt_id)?;

        let current_job_dir = job_dir(&canonical_workspace, &job_id);
        let current_attempt_dir = attempt_dir(&canonical_workspace, &job_id, &attempt_id);

        // Atomic create job directory to prevent concurrent duplicate jobs
        if let Some(parent) = current_job_dir.parent() {
            fs::create_dir_all(parent)?;
        }
        match fs::create_dir(&current_job_dir) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(RunnerError::JobAlreadyExists(job_id));
            }
            Err(e) => return Err(RunnerError::IoError(e)),
        }

        fs::create_dir_all(&current_attempt_dir)?;

        let status_tracker = StatusTracker::new(&current_job_dir, &job_id, &attempt_id);
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
            LogSource::Launcher,
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
        };

        // 2. Snapshot prompt
        let prompt_snapshot_path = current_attempt_dir.join("prompt_snapshot.md");
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

        // 3. Baseline snapshot of workspace
        let baseline = WorkspaceSnapshot::capture(&canonical_workspace);

        // 4. Static preflight check on workspace AGENTS.md
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
                        executor: ExecutorInfo {
                            executor_type: self.config.executor_type.to_string(),
                            version: "unknown".to_string(),
                            conversation_id: None,
                        },
                    },
                );
            }
        };

        // 5. Setup Doctor probe context
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
                        executor: ExecutorInfo {
                            executor_type: self.config.executor_type.to_string(),
                            version: "unknown".to_string(),
                            conversation_id: None,
                        },
                    },
                );
            }
        };

        // 6. Executor adapter preflight
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

        // 7. Spawn child process
        let exec_request = ExecutionRequest {
            job_id: &job_id,
            attempt_id: &attempt_id,
            workspace_dir: &canonical_workspace,
            attempt_dir: &current_attempt_dir,
            prompt_file,
            model: self.config.agent_model.as_deref(),
        };

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

        // 8. Setup Single-Reader Event Dispatcher on stdout and background drain on stderr
        let (event_tx, mut event_rx) = mpsc::channel::<serde_json::Value>(100);
        let events_path = current_attempt_dir.join("events.jsonl");
        let dispatcher = StreamEventDispatcher::new(events_path, stdout_logger.clone(), event_tx);

        if let Some(stdout) = child.take_stdout() {
            tokio::spawn(dispatcher.run(stdout));
        }
        if let Some(stderr) = child.take_stderr() {
            let stderr_drain = stderr_logger.clone();
            tokio::spawn(async move {
                stderr_drain.drain_stream(stderr).await;
            });
        }

        // 9. Execute Turn 1: Doctor Probe
        let _ = status_tracker.update_stage(JobStage::Doctor, None, log_paths.clone(), Vec::new());
        event_logger.log_event(
            "doctor",
            "turn_start",
            LogSource::System,
            serde_json::json!({ "stage": "doctor" }),
        );

        let doctor_prompt = doctor_ctx.build_probe_prompt();
        let doctor_msg = serde_json::json!({
            "event": "user",
            "message": { "content": doctor_prompt }
        });
        if let Err(e) = child.send_input_line(&doctor_msg.to_string()).await {
            let _ = child.kill_group();
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

        // Listen for Turn 1 completion
        let doctor_timeout = Duration::from_secs(self.config.doctor_timeout_secs);
        let doctor_deadline = tokio::time::Instant::now() + doctor_timeout;

        let mut doctor_agent_response = String::new();
        let mut doctor_result_status = String::new();
        let mut doctor_turn_finished = false;

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
                                    }
                                    doctor_turn_finished = true;
                                    break;
                                }
                            }
                        }
                        None => {
                            // EOF on event channel before result
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep_until(doctor_deadline) => {
                    let _ = child.kill_group();
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
            }
        }

        if !doctor_turn_finished {
            let _ = child.kill_group();
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
        let doctor_report = doctor_ctx.evaluate_turn(&doctor_agent_response, &doctor_result_status);
        finalize_params.doctor_report = Some(doctor_report.clone());

        if !doctor_report.ready {
            let err_msg = doctor_report
                .error
                .unwrap_or_else(|| "Doctor checks failed".to_string());
            let _ = child.kill_group();
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

        event_logger.log_event(
            "doctor",
            "turn_passed",
            LogSource::System,
            serde_json::json!({ "ready": true }),
        );

        // 10. Execute Turn 2: Business Prompt
        let _ =
            status_tracker.update_stage(JobStage::Execution, None, log_paths.clone(), Vec::new());
        event_logger.log_event(
            "task",
            "turn_start",
            LogSource::System,
            serde_json::json!({ "stage": "task" }),
        );

        let task_msg = serde_json::json!({
            "event": "user",
            "message": { "content": prompt_content }
        });
        if let Err(e) = child.send_input_line(&task_msg.to_string()).await {
            let _ = child.kill_group();
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

        // Listen for Turn 2 completion
        let task_timeout_duration =
            Duration::from_secs(timeout_secs.unwrap_or(self.config.task_timeout_secs));
        let task_deadline = tokio::time::Instant::now() + task_timeout_duration;

        let mut task_agent_response = String::new();
        let mut task_result_status = String::new();
        let mut task_turn_finished = false;

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
                                        task_agent_response.push_str(delta);
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
                    let _ = child.kill_group();
                    return self.finalize_attempt(
                        finalize_params,
                        AttemptOutcome::Timeout {
                            duration_secs: timeout_secs.unwrap_or(self.config.task_timeout_secs),
                            executor: executor_info,
                        },
                    );
                }
            }
        }

        // 11. Teardown & Graceful Child Exit
        let _ = child.close_stdin();
        let teardown_deadline =
            tokio::time::Instant::now() + Duration::from_secs(self.config.teardown_wait_secs);

        tokio::select! {
            _ = child.wait() => {}
            _ = tokio::time::sleep_until(teardown_deadline) => {
                let _ = child.kill_group();
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = child.force_kill_group();
            }
        }

        if !task_turn_finished || !task_result_status.eq_ignore_ascii_case("success") {
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

        // 12. Verification of Artifacts
        let verification = GenericVerifier::verify_attempt(
            &canonical_workspace,
            &current_attempt_dir,
            &baseline,
            &task_agent_response,
        );

        self.finalize_attempt(
            finalize_params,
            AttemptOutcome::Success {
                executor: executor_info,
                artifacts: verification.verified_artifacts,
                business_outcome: verification.outcome,
            },
        )
    }

    pub async fn run_standalone_doctor(
        &self,
        workspace: &Path,
    ) -> Result<SessionDoctorReport, RunnerError> {
        let canonical_workspace = workspace.canonicalize().map_err(RunnerError::IoError)?;
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

        // Create standalone doctor report dir
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

        let doctor_prompt = doctor_ctx.build_probe_prompt();
        let doctor_msg = serde_json::json!({
            "event": "user",
            "message": { "content": doctor_prompt }
        });
        let _ = child.send_input_line(&doctor_msg.to_string()).await;

        let doctor_deadline =
            tokio::time::Instant::now() + Duration::from_secs(self.config.doctor_timeout_secs);
        let mut doctor_response = String::new();
        let mut result_status = String::new();

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
                    let _ = child.kill_group();
                    break;
                }
            }
        }

        let _ = child.close_stdin();
        let _ = child.kill_group();

        let report = doctor_ctx.evaluate_turn(&doctor_response, &result_status);

        // Persist report to doctor_dir/doctor_report.json
        let report_json = serde_json::to_string_pretty(&report).unwrap_or_default();
        let _ = fs::write(doctor_dir.join("doctor_report.json"), report_json);

        Ok(report)
    }
}
