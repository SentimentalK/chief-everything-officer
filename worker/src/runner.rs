use crate::config::{validate_id, WorkerConfig};
use crate::doctor::{run_doctor, DoctorStatus};
use crate::executor::{create_executor, ExecutionRequest, ExecutorError};
use crate::manifest::{CapabilityManifest, TaskInput, TaskInputParams};
use crate::observability::{EventLogger, JobStage, LogSource, ProcessLogger, StatusTracker};
use crate::receipt::{
    ArtifactRef, ExecutorInfo, LogSummary, ReceiptError, ScriptInfo, SubmissionInfo, TaskReceipt,
    TimestampsInfo, VerificationSummary,
};
use crate::setup::run_setup;
use crate::verifier::{BusinessOutcome, Verifier};
use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use tokio::sync::mpsc;

#[derive(Error, Debug)]
pub enum RunnerError {
    #[error("Job ID '{0}' already exists. Refusing to overwrite or re-execute.")]
    JobAlreadyExists(String),
    #[error("Configuration error: {0}")]
    ConfigError(#[from] crate::config::ConfigError),
    #[error("I/O error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Failed to persist task receipt to disk: {0}")]
    ReceiptPersistFailed(std::io::Error),
}

struct FinalizeParams<'a> {
    job_id: &'a str,
    attempt_id: &'a str,
    capability_id: &'a str,
    manifest_revision: u32,
    started_at: DateTime<Utc>,
    attempt_dir: &'a Path,
    status_tracker: &'a StatusTracker,
    event_logger: &'a EventLogger,
    stdout_logger: &'a ProcessLogger,
    stderr_logger: &'a ProcessLogger,
    log_paths: HashMap<String, String>,
}

enum AttemptOutcome {
    Success {
        executor: ExecutorInfo,
        submission: SubmissionInfo,
        script: ScriptInfo,
        artifacts: Vec<ArtifactRef>,
        verification: VerificationSummary,
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
        submission: SubmissionInfo,
        script: ScriptInfo,
        artifacts: Vec<ArtifactRef>,
        verification: Option<VerificationSummary>,
    },
    Timeout {
        duration_secs: u64,
        executor: ExecutorInfo,
        submission: SubmissionInfo,
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

        let (
            exec_status,
            agent_session_state,
            business_outcome,
            executor,
            submission,
            script,
            artifacts,
            artifact_paths,
            verification,
            receipt_error,
            job_stage,
        ) = match outcome {
            AttemptOutcome::Success {
                executor,
                submission,
                script,
                artifacts,
                verification,
                business_outcome,
            } => {
                let paths = artifacts.iter().map(|a| a.path.clone()).collect();
                (
                    "COMPLETED".to_string(),
                    "Completed".to_string(),
                    business_outcome,
                    executor,
                    submission,
                    script,
                    artifacts,
                    paths,
                    Some(verification),
                    None,
                    JobStage::Completed,
                )
            }
            AttemptOutcome::Blocked {
                stage,
                code,
                message,
                executor,
            } => {
                let err = ReceiptError {
                    stage,
                    code,
                    message,
                };
                (
                    "BLOCKED".to_string(),
                    "NotStarted".to_string(),
                    BusinessOutcome::NotStarted,
                    executor,
                    SubmissionInfo {
                        status: "RejectedPreflight".to_string(),
                        exit_code: None,
                    },
                    ScriptInfo { exit_code: None },
                    vec![],
                    vec![],
                    None,
                    Some(err),
                    JobStage::Blocked,
                )
            }
            AttemptOutcome::Failed {
                stage,
                code,
                message,
                business_outcome,
                executor,
                submission,
                script,
                artifacts,
                verification,
            } => {
                let paths = artifacts.iter().map(|a| a.path.clone()).collect();
                let err = ReceiptError {
                    stage,
                    code,
                    message,
                };
                (
                    "FAILED".to_string(),
                    "Completed".to_string(),
                    business_outcome,
                    executor,
                    submission,
                    script,
                    artifacts,
                    paths,
                    verification,
                    Some(err),
                    JobStage::Failed,
                )
            }
            AttemptOutcome::Timeout {
                duration_secs,
                executor,
                submission,
            } => {
                let err = ReceiptError {
                    stage: "execution".to_string(),
                    code: "TIMEOUT".to_string(),
                    message: format!("Execution timed out after {} seconds", duration_secs),
                };
                (
                    "FAILED".to_string(),
                    "TimedOut".to_string(),
                    BusinessOutcome::Interrupted,
                    executor,
                    submission,
                    ScriptInfo { exit_code: None },
                    vec![],
                    vec![],
                    None,
                    Some(err),
                    JobStage::Failed,
                )
            }
        };

        let receipt = TaskReceipt {
            job_id: params.job_id.to_string(),
            attempt_id: params.attempt_id.to_string(),
            capability_id: params.capability_id.to_string(),
            manifest_revision: params.manifest_revision,
            execution_status: exec_status.clone(),
            agent_session_state,
            business_outcome,
            executor,
            submission,
            script,
            timestamps: TimestampsInfo {
                started_at: params.started_at,
                finished_at,
                duration_ms,
            },
            artifacts,
            logs,
            verification,
            error: receipt_error.clone(),
        };

        let receipt_path = params.attempt_dir.join("receipt.json");
        if let Err(e) = receipt.persist_to_file(&receipt_path) {
            eprintln!(
                "FATAL: Failed to write receipt.json to {:?}: {}",
                receipt_path, e
            );
            let _ = params.status_tracker.update_stage(
                JobStage::Failed,
                Some(format!("Failed to persist receipt: {}", e)),
                params.log_paths,
                vec![],
            );
            return Err(RunnerError::ReceiptPersistFailed(e));
        }

        let latest_error = receipt_error.map(|e| e.message);
        let _ = params.status_tracker.update_stage(
            job_stage,
            latest_error,
            params.log_paths,
            artifact_paths,
        );

        params.event_logger.log(
            "completion",
            "receipt_finalized",
            "system",
            serde_json::json!({
                "status": exec_status,
                "outcome": format!("{:?}", business_outcome),
            }),
        );

        Ok(receipt)
    }

    pub async fn run_job(
        &self,
        capability_id: &str,
        url: &str,
        custom_job_id: Option<String>,
    ) -> Result<TaskReceipt, RunnerError> {
        // 1. Strict ID validation
        validate_id("capability_id", capability_id)?;
        let job_id = if let Some(ref id) = custom_job_id {
            validate_id("job_id", id)?;
            id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let started_at = Utc::now();

        // 2. Atomic job directory registration
        let job_dir = self.config.safe_job_dir(&job_id)?;
        fs::create_dir_all(&self.config.workspace_dir)?;
        let jobs_root = self.config.workspace_dir.join("jobs");
        fs::create_dir_all(&jobs_root)?;

        match fs::create_dir(&job_dir) {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(RunnerError::JobAlreadyExists(job_id));
            }
            Err(e) => return Err(RunnerError::IoError(e)),
        }

        let attempt_dir = self.config.safe_attempt_dir(&job_id, &attempt_id)?;
        fs::create_dir_all(&attempt_dir)?;

        // 3. Initialize observability
        let status_tracker = StatusTracker::new(&job_dir, &job_id, &attempt_id);
        let event_logger = EventLogger::new(&attempt_dir, &job_id, &attempt_id);
        let stdout_logger = ProcessLogger::new(
            &attempt_dir,
            "stdout.log",
            LogSource::Launcher,
            self.echo_tx.clone(),
        );
        let stderr_logger = ProcessLogger::new(
            &attempt_dir,
            "stderr.log",
            LogSource::Launcher,
            self.echo_tx.clone(),
        );

        let mut log_paths = HashMap::new();
        log_paths.insert(
            "events".to_string(),
            attempt_dir
                .join("events.jsonl")
                .to_string_lossy()
                .to_string(),
        );
        log_paths.insert(
            "stdout".to_string(),
            attempt_dir.join("stdout.log").to_string_lossy().to_string(),
        );
        log_paths.insert(
            "stderr".to_string(),
            attempt_dir.join("stderr.log").to_string_lossy().to_string(),
        );

        event_logger.log(
            "init",
            "attempt_created",
            "system",
            serde_json::json!({
                "job_id": job_id,
                "attempt_id": attempt_id,
                "capability_id": capability_id,
            }),
        );

        let _ = status_tracker.update_stage(JobStage::Doctor, None, log_paths.clone(), vec![]);

        // 4. Instantiate executor
        let executor = create_executor(&self.config);
        let mut executor_info = ExecutorInfo {
            executor_type: executor.executor_type().to_string(),
            version: executor.default_version().to_string(),
            conversation_id: None,
        };

        // 5. Load and validate capability manifest
        let cap_dir = self.config.safe_capability_dir(capability_id)?;
        let manifest = match CapabilityManifest::load_from_dir(&cap_dir) {
            Ok(m) => m,
            Err(e) => {
                let err_msg = format!("Failed to load capability manifest: {}", e);
                event_logger.log(
                    "init",
                    "manifest_error",
                    "system",
                    serde_json::json!({"error": &err_msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: 0,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "manifest".to_string(),
                        code: "MANIFEST_LOAD_ERROR".to_string(),
                        message: err_msg,
                        executor: executor_info,
                    },
                );
            }
        };

        let task_input = TaskInput {
            job_id: job_id.clone(),
            attempt_id: attempt_id.clone(),
            capability_id: capability_id.to_string(),
            manifest_revision: manifest.manifest_revision,
            params: TaskInputParams {
                url: url.to_string(),
            },
        };

        if let Err(e) = manifest.validate_task_input(&task_input) {
            let err_msg = format!("Task input validation failed: {}", e);
            event_logger.log(
                "init",
                "input_invalid",
                "system",
                serde_json::json!({"error": &err_msg}),
            );
            let params = FinalizeParams {
                job_id: &job_id,
                attempt_id: &attempt_id,
                capability_id,
                manifest_revision: manifest.manifest_revision,
                started_at,
                attempt_dir: &attempt_dir,
                status_tracker: &status_tracker,
                event_logger: &event_logger,
                stdout_logger: &stdout_logger,
                stderr_logger: &stderr_logger,
                log_paths,
            };
            return self.finalize_attempt(
                params,
                AttemptOutcome::Blocked {
                    stage: "input_validation".to_string(),
                    code: "INPUT_INVALID".to_string(),
                    message: err_msg,
                    executor: executor_info,
                },
            );
        }

        // 6. Write input.json to attempt dir
        let input_json_path = attempt_dir.join("input.json");
        let input_bytes = serde_json::to_vec_pretty(&task_input)
            .map_err(|e| RunnerError::IoError(std::io::Error::other(e)))?;
        fs::write(&input_json_path, input_bytes)?;

        // 7. Executor preflight check
        match executor.preflight_check() {
            Ok(meta) => {
                executor_info.version = meta.version;
            }
            Err(ExecutorError::Unsupported(msg)) => {
                event_logger.log(
                    "preflight",
                    "adapter_unsupported",
                    "system",
                    serde_json::json!({"error": &msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "ADAPTER_UNSUPPORTED".to_string(),
                        message: msg,
                        executor: executor_info,
                    },
                );
            }
            Err(ExecutorError::NeedsUserAction {
                message,
                action_required,
            }) => {
                let full_msg = format!("{} Action required: {}", message, action_required);
                event_logger.log(
                    "preflight",
                    "needs_user_action",
                    "system",
                    serde_json::json!({"error": &full_msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "NEEDS_USER_ACTION".to_string(),
                        message: full_msg,
                        executor: executor_info,
                    },
                );
            }
            Err(e) => {
                let err_msg = format!("Executor preflight failed: {}", e);
                event_logger.log(
                    "preflight",
                    "preflight_failed",
                    "system",
                    serde_json::json!({"error": &err_msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "preflight".to_string(),
                        code: "PREFLIGHT_FAILED".to_string(),
                        message: err_msg,
                        executor: executor_info,
                    },
                );
            }
        }

        // 8. Doctor evaluation
        stdout_logger.log_line_with_source(
            LogSource::Doctor,
            &format!(
                "Running doctor checks for capability '{}'...",
                capability_id
            ),
        );
        let doctor_report = match run_doctor(&cap_dir).await {
            Ok(rep) => rep,
            Err(e) => {
                let msg = format!("Doctor script error: {}", e);
                event_logger.log(
                    "doctor",
                    "doctor_failed",
                    "doctor",
                    serde_json::json!({"error": &msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "DOCTOR_FAILED".to_string(),
                        message: msg,
                        executor: executor_info,
                    },
                );
            }
        };

        event_logger.log(
            "doctor",
            "doctor_checked",
            "doctor",
            serde_json::to_value(&doctor_report).unwrap_or_default(),
        );

        if doctor_report.status == DoctorStatus::NeedsSetup {
            if self.config.auto_setup {
                let _ =
                    status_tracker.update_stage(JobStage::Setup, None, log_paths.clone(), vec![]);
                stdout_logger.log_line_with_source(
                    LogSource::Setup,
                    "Environment needs setup. Running capability setup...",
                );
                event_logger.log("setup", "setup_started", "setup", serde_json::json!({}));

                if let Err(e) = run_setup(&cap_dir, self.config.setup_timeout_secs).await {
                    let msg = format!("Setup failed: {}", e);
                    event_logger.log(
                        "setup",
                        "setup_failed",
                        "setup",
                        serde_json::json!({"error": &msg}),
                    );
                    let params = FinalizeParams {
                        job_id: &job_id,
                        attempt_id: &attempt_id,
                        capability_id,
                        manifest_revision: manifest.manifest_revision,
                        started_at,
                        attempt_dir: &attempt_dir,
                        status_tracker: &status_tracker,
                        event_logger: &event_logger,
                        stdout_logger: &stdout_logger,
                        stderr_logger: &stderr_logger,
                        log_paths,
                    };
                    return self.finalize_attempt(
                        params,
                        AttemptOutcome::Blocked {
                            stage: "setup".to_string(),
                            code: "SETUP_FAILED".to_string(),
                            message: msg,
                            executor: executor_info,
                        },
                    );
                }

                event_logger.log("setup", "setup_completed", "setup", serde_json::json!({}));
                stdout_logger.log_line_with_source(
                    LogSource::Setup,
                    "Capability setup completed successfully.",
                );
            } else {
                let msg = "Capability requires setup but auto_setup is disabled.".to_string();
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Blocked {
                        stage: "doctor".to_string(),
                        code: "SETUP_REQUIRED".to_string(),
                        message: msg,
                        executor: executor_info,
                    },
                );
            }
        } else if doctor_report.status != DoctorStatus::Ready {
            let msg = format!(
                "Environment blocked: {:?}. Actions: {:?}",
                doctor_report.status, doctor_report.actions
            );
            event_logger.log("doctor", "environment_blocked", "doctor", serde_json::json!({"status": format!("{:?}", doctor_report.status), "actions": doctor_report.actions}));
            let params = FinalizeParams {
                job_id: &job_id,
                attempt_id: &attempt_id,
                capability_id,
                manifest_revision: manifest.manifest_revision,
                started_at,
                attempt_dir: &attempt_dir,
                status_tracker: &status_tracker,
                event_logger: &event_logger,
                stdout_logger: &stdout_logger,
                stderr_logger: &stderr_logger,
                log_paths,
            };
            return self.finalize_attempt(
                params,
                AttemptOutcome::Blocked {
                    stage: "doctor".to_string(),
                    code: "ENVIRONMENT_BLOCKED".to_string(),
                    message: msg,
                    executor: executor_info,
                },
            );
        }

        // 9. Launch process via adapter
        let _ = status_tracker.update_stage(JobStage::Submission, None, log_paths.clone(), vec![]);
        event_logger.log(
            "submission",
            "launching_process",
            "launcher",
            serde_json::json!({
                "executor": executor_info.executor_type,
            }),
        );

        let run_script = cap_dir.join("run");
        let request = ExecutionRequest {
            job_id: &job_id,
            attempt_id: &attempt_id,
            capability_id,
            attempt_dir: &attempt_dir,
            input_json_path: &input_json_path,
            run_script_path: &run_script,
            model: self.config.agent_model.as_deref(),
        };

        let mut process = match executor.spawn_execution(&request) {
            Ok(p) => p,
            Err(e) => {
                let msg = format!("Failed to spawn process: {}", e);
                event_logger.log(
                    "submission",
                    "spawn_failed",
                    "launcher",
                    serde_json::json!({"error": &msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Failed {
                        stage: "submission".to_string(),
                        code: "SPAWN_FAILED".to_string(),
                        message: msg,
                        business_outcome: BusinessOutcome::NotStarted,
                        executor: executor_info,
                        submission: SubmissionInfo {
                            status: "SpawnFailed".to_string(),
                            exit_code: None,
                        },
                        script: ScriptInfo { exit_code: None },
                        artifacts: vec![],
                        verification: None,
                    },
                );
            }
        };

        let child_stdout = process.take_stdout();
        let child_stderr = process.take_stderr();

        let stdout_logger_clone = stdout_logger.clone();
        let stdout_handle = tokio::spawn(async move {
            if let Some(stream) = child_stdout {
                stdout_logger_clone.drain_stream(stream).await;
            }
        });

        let stderr_logger_clone = stderr_logger.clone();
        let stderr_handle = tokio::spawn(async move {
            if let Some(stream) = child_stderr {
                stderr_logger_clone.drain_stream(stream).await;
            }
        });

        let _ = status_tracker.update_stage(JobStage::Execution, None, log_paths.clone(), vec![]);

        // 10. Monotonic execution wait with process group lifecycle
        let timeout_duration = Duration::from_secs(self.config.execution_timeout_secs);
        let wait_res = tokio::time::timeout(timeout_duration, process.wait()).await;

        let exit_code = match wait_res {
            Ok(Ok(status)) => status.code(),
            Ok(Err(_)) => None,
            Err(_) => {
                // Timeout! Send SIGTERM to process group, wait grace period, then SIGKILL
                let _ = process.kill_group();
                tokio::time::sleep(Duration::from_millis(500)).await;
                let _ = process.force_kill_group();

                // Bounded pipe drain (max 2 seconds)
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    let _ = tokio::join!(stdout_handle, stderr_handle);
                })
                .await;

                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Timeout {
                        duration_secs: self.config.execution_timeout_secs,
                        executor: executor_info,
                        submission: SubmissionInfo {
                            status: "TimedOut".to_string(),
                            exit_code: None,
                        },
                    },
                );
            }
        };

        // Bounded pipe drain for normal termination (max 2 seconds)
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            let _ = tokio::join!(stdout_handle, stderr_handle);
        })
        .await;

        event_logger.log(
            "execution",
            "process_exited",
            "launcher",
            serde_json::json!({ "exit_code": exit_code }),
        );

        // 11. Verification
        let _ =
            status_tracker.update_stage(JobStage::Verification, None, log_paths.clone(), vec![]);
        event_logger.log(
            "verification",
            "verifying_artifacts",
            "verifier",
            serde_json::json!({}),
        );

        let completion_res = Verifier::verify_completion(
            &attempt_dir,
            &job_id,
            &attempt_id,
            url,
            &manifest.output_schema,
        );

        let (completion_report, raw_resolved, business_outcome) = match completion_res {
            Ok(res) => res,
            Err(e) => {
                let msg = format!("Verification failed: {}", e);
                event_logger.log(
                    "verification",
                    "verification_failed",
                    "verifier",
                    serde_json::json!({"error": &msg}),
                );
                let params = FinalizeParams {
                    job_id: &job_id,
                    attempt_id: &attempt_id,
                    capability_id,
                    manifest_revision: manifest.manifest_revision,
                    started_at,
                    attempt_dir: &attempt_dir,
                    status_tracker: &status_tracker,
                    event_logger: &event_logger,
                    stdout_logger: &stdout_logger,
                    stderr_logger: &stderr_logger,
                    log_paths,
                };
                return self.finalize_attempt(
                    params,
                    AttemptOutcome::Failed {
                        stage: "verification".to_string(),
                        code: "VERIFICATION_FAILED".to_string(),
                        message: msg,
                        business_outcome: BusinessOutcome::VerificationFailed,
                        executor: executor_info,
                        submission: SubmissionInfo {
                            status: "Submitted".to_string(),
                            exit_code,
                        },
                        script: ScriptInfo { exit_code },
                        artifacts: vec![],
                        verification: None,
                    },
                );
            }
        };

        let mut artifacts = vec![];
        if let Some(art) = &completion_report.artifact {
            let art_path = attempt_dir.join(&art.file_name);
            artifacts.push(ArtifactRef {
                name: art.file_name.clone(),
                path: art_path.to_string_lossy().to_string(),
                size_bytes: art.size_bytes,
                sha256: art.sha256.clone(),
            });
        }

        let verification_summary = raw_resolved.map(|r| VerificationSummary {
            valid: true,
            url_matched: true,
            schema_conforming: true,
            artifact_fresh: true,
            transcript_status: r.transcript_status,
        });

        let params = FinalizeParams {
            job_id: &job_id,
            attempt_id: &attempt_id,
            capability_id,
            manifest_revision: manifest.manifest_revision,
            started_at,
            attempt_dir: &attempt_dir,
            status_tracker: &status_tracker,
            event_logger: &event_logger,
            stdout_logger: &stdout_logger,
            stderr_logger: &stderr_logger,
            log_paths,
        };

        if business_outcome == BusinessOutcome::ExtractionFailed {
            let (code, err_msg) = if let Some(ref err) = completion_report.error {
                (err.code.clone(), err.message.clone())
            } else {
                (
                    "EXTRACTION_FAILED".to_string(),
                    "Capability script failed during extraction".to_string(),
                )
            };

            self.finalize_attempt(
                params,
                AttemptOutcome::Failed {
                    stage: "execution".to_string(),
                    code,
                    message: err_msg,
                    business_outcome,
                    executor: executor_info,
                    submission: SubmissionInfo {
                        status: "Submitted".to_string(),
                        exit_code,
                    },
                    script: ScriptInfo {
                        exit_code: Some(completion_report.script_exit_code),
                    },
                    artifacts,
                    verification: verification_summary,
                },
            )
        } else {
            self.finalize_attempt(
                params,
                AttemptOutcome::Success {
                    executor: executor_info,
                    submission: SubmissionInfo {
                        status: "Submitted".to_string(),
                        exit_code,
                    },
                    script: ScriptInfo {
                        exit_code: Some(completion_report.script_exit_code),
                    },
                    artifacts,
                    verification: verification_summary.unwrap_or(VerificationSummary {
                        valid: true,
                        url_matched: true,
                        schema_conforming: true,
                        artifact_fresh: true,
                        transcript_status: "unknown".to_string(),
                    }),
                    business_outcome,
                },
            )
        }
    }
}
