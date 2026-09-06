use crate::config::WorkerConfig;
use crate::doctor::{run_doctor, DoctorStatus};
use crate::manifest::{CapabilityManifest, TaskInput, TaskInputParams};
use crate::observability::{EventLogger, JobStage, LogSource, ProcessLogger, StatusTracker};
use crate::receipt::{
    ArtifactRef, ExecutorInfo, LogSummary, ReceiptError, ScriptInfo, SubmissionInfo, TaskReceipt,
    TimestampsInfo, VerificationSummary,
};
use crate::setup::run_setup;
use crate::verifier::{BusinessOutcome, Verifier};
use chrono::Utc;
use std::collections::HashMap;
use std::fs;
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;
use tokio::sync::mpsc;
use tokio::time::sleep;

#[derive(Error, Debug)]
pub enum RunnerError {
    #[error("Job ID {0} already exists. Refusing to overwrite or re-execute.")]
    JobAlreadyExists(String),
    #[error("Failed to initialize job directory: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Preflight check failed: {0}")]
    PreflightError(String),
    #[error("Manifest error: {0}")]
    ManifestError(#[from] crate::manifest::ManifestError),
    #[error("Capability environment check failed: {0}")]
    EnvironmentBlocked(String),
    #[error("Setup failed: {0}")]
    SetupFailed(#[from] crate::setup::SetupError),
    #[error("Execution timeout: reached {0} seconds")]
    Timeout(u64),
    #[error("Verification error: {0}")]
    VerificationError(#[from] crate::verifier::VerificationError),
}

pub struct Runner {
    config: WorkerConfig,
    echo_tx: Option<mpsc::Sender<String>>,
}

impl Runner {
    pub fn new(config: WorkerConfig, echo_tx: Option<mpsc::Sender<String>>) -> Self {
        Self { config, echo_tx }
    }

    pub async fn run_job(
        &self,
        capability_id: &str,
        url: &str,
        custom_job_id: Option<String>,
    ) -> Result<TaskReceipt, RunnerError> {
        let job_id = custom_job_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let attempt_id = uuid::Uuid::new_v4().to_string();
        let started_at = Utc::now();

        // 1. Atomic job directory registration (prevent concurrent duplicate job_id)
        let job_dir = self.config.job_dir(&job_id);
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

        // Create attempt directory
        let attempt_dir = self.config.attempt_dir(&job_id, &attempt_id);
        fs::create_dir_all(&attempt_dir)?;

        // Initialize status and observability
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

        // 2. Load and validate capability manifest
        let cap_dir = self.config.capability_dir(capability_id);
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
                let _ = status_tracker.update_stage(
                    JobStage::Failed,
                    Some(err_msg.clone()),
                    log_paths.clone(),
                    vec![],
                );
                return Err(RunnerError::ManifestError(e));
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
            let _ = status_tracker.update_stage(
                JobStage::Failed,
                Some(err_msg.clone()),
                log_paths.clone(),
                vec![],
            );
            return Err(RunnerError::ManifestError(e));
        }

        // 3. Write input.json to attempt dir
        let input_json_path = attempt_dir.join("input.json");
        let input_bytes = serde_json::to_vec_pretty(&task_input)
            .map_err(|e| RunnerError::IoError(std::io::Error::other(e)))?;
        fs::write(&input_json_path, input_bytes)?;

        // 4. Preflight adapter check: If configured with agentapi, reject immediately without side effects!
        let agent_bin_str = self.config.agent_executable.to_string_lossy();
        if agent_bin_str.ends_with("agentapi") {
            let err_msg = "ADAPTER_UNSUPPORTED: Antigravity agentapi lacks workspace binding, status querying, and targeted cancellation. Submission rejected before process creation.".to_string();
            event_logger.log(
                "preflight",
                "adapter_unsupported",
                "system",
                serde_json::json!({"error": &err_msg}),
            );
            let _ = status_tracker.update_stage(
                JobStage::Failed,
                Some(err_msg.clone()),
                log_paths.clone(),
                vec![],
            );

            let receipt = TaskReceipt {
                job_id: job_id.clone(),
                attempt_id: attempt_id.clone(),
                capability_id: capability_id.to_string(),
                manifest_revision: manifest.manifest_revision,
                execution_status: "BLOCKED".to_string(),
                agent_session_state: "Unsupported".to_string(),
                business_outcome: BusinessOutcome::Interrupted,
                executor: ExecutorInfo {
                    executor_type: "antigravity-agentapi".to_string(),
                    version: "2.11.0".to_string(),
                    conversation_id: None,
                },
                submission: SubmissionInfo {
                    status: "RejectedPreflight".to_string(),
                    exit_code: None,
                },
                script: ScriptInfo { exit_code: None },
                timestamps: TimestampsInfo {
                    started_at,
                    finished_at: Utc::now(),
                    duration_ms: (Utc::now() - started_at).num_milliseconds().max(0) as u64,
                },
                artifacts: vec![],
                logs: LogSummary {
                    events_path: attempt_dir
                        .join("events.jsonl")
                        .to_string_lossy()
                        .to_string(),
                    stdout_path: attempt_dir.join("stdout.log").to_string_lossy().to_string(),
                    stderr_path: attempt_dir.join("stderr.log").to_string_lossy().to_string(),
                    stdout_snippet: "".to_string(),
                    stderr_snippet: "".to_string(),
                    dropped_lines_count: 0,
                    log_truncated: false,
                },
                verification: None,
                error: Some(ReceiptError {
                    stage: "preflight".to_string(),
                    code: "ADAPTER_UNSUPPORTED".to_string(),
                    message: err_msg.clone(),
                }),
            };

            let receipt_path = attempt_dir.join("receipt.json");
            receipt.persist_to_file(&receipt_path)?;
            return Ok(receipt);
        }

        // 5. Doctor evaluation
        stdout_logger.log_line(&format!(
            "Running doctor checks for capability '{}'...",
            capability_id
        ));
        let doctor_report = run_doctor(&cap_dir).await.map_err(|e| {
            let msg = format!("Doctor script error: {}", e);
            event_logger.log(
                "doctor",
                "doctor_failed",
                "doctor",
                serde_json::json!({"error": &msg}),
            );
            RunnerError::EnvironmentBlocked(msg)
        })?;

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
                stdout_logger.log_line("Environment needs setup. Running capability setup...");
                event_logger.log("setup", "setup_started", "setup", serde_json::json!({}));

                run_setup(&cap_dir, self.config.setup_timeout_secs)
                    .await
                    .map_err(|e| {
                        let msg = format!("Setup failed: {}", e);
                        event_logger.log(
                            "setup",
                            "setup_failed",
                            "setup",
                            serde_json::json!({"error": &msg}),
                        );
                        let _ = status_tracker.update_stage(
                            JobStage::Failed,
                            Some(msg.clone()),
                            log_paths.clone(),
                            vec![],
                        );
                        RunnerError::SetupFailed(e)
                    })?;

                event_logger.log("setup", "setup_completed", "setup", serde_json::json!({}));
                stdout_logger.log_line("Capability setup completed successfully.");
            } else {
                let msg = "Capability requires setup but auto_setup is disabled.".to_string();
                event_logger.log(
                    "doctor",
                    "setup_required",
                    "doctor",
                    serde_json::json!({"actions": doctor_report.actions}),
                );
                let _ = status_tracker.update_stage(
                    JobStage::Failed,
                    Some(msg.clone()),
                    log_paths.clone(),
                    vec![],
                );
                return Err(RunnerError::EnvironmentBlocked(msg));
            }
        } else if doctor_report.status != DoctorStatus::Ready {
            let msg = format!(
                "Environment blocked: {:?}. Actions: {:?}",
                doctor_report.status, doctor_report.actions
            );
            event_logger.log("doctor", "environment_blocked", "doctor", serde_json::json!({"status": format!("{:?}", doctor_report.status), "actions": doctor_report.actions}));
            let _ = status_tracker.update_stage(
                JobStage::Failed,
                Some(msg.clone()),
                log_paths.clone(),
                vec![],
            );
            return Err(RunnerError::EnvironmentBlocked(msg));
        }

        // 6. Submission & Execution
        let _ = status_tracker.update_stage(JobStage::Submission, None, log_paths.clone(), vec![]);
        event_logger.log(
            "submission",
            "launching_process",
            "launcher",
            serde_json::json!({
                "executable": self.config.agent_executable.to_string_lossy(),
            }),
        );

        let run_script = cap_dir.join("run");
        let mut child = Command::new(&self.config.agent_executable)
            .arg("--input")
            .arg(&input_json_path)
            .arg("--output-dir")
            .arg(&attempt_dir)
            .arg("--run-script")
            .arg(&run_script)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        let child_stdout = child.stdout.take();
        let child_stderr = child.stderr.take();

        // Spawn async reader tasks for stdout & stderr (draining pipes continuously to avoid deadlock)
        let stdout_handle = {
            let logger = stdout_logger;
            tokio::spawn(async move {
                if let Some(stream) = child_stdout {
                    logger.drain_stream(stream).await;
                }
            })
        };

        let stderr_handle = {
            let logger = stderr_logger;
            tokio::spawn(async move {
                if let Some(stream) = child_stderr {
                    logger.drain_stream(stream).await;
                }
            })
        };

        // Wait for submission launcher
        let submission_res = tokio::time::timeout(
            Duration::from_secs(self.config.submission_timeout_secs),
            child.wait(),
        )
        .await;

        let submission_exit_code = match submission_res {
            Ok(Ok(status)) => status.code().unwrap_or(0),
            Ok(Err(_)) => -1,
            Err(_) => {
                let _ = child.kill().await;
                -2 // Timeout
            }
        };

        event_logger.log(
            "submission",
            "launcher_exited",
            "launcher",
            serde_json::json!({ "exit_code": submission_exit_code }),
        );

        let _ = status_tracker.update_stage(JobStage::Execution, None, log_paths.clone(), vec![]);

        // 7. Wait/poll for completion.json up to execution_timeout_secs
        let completion_path = attempt_dir.join("completion.json");
        let start_exec_wait = Utc::now();
        let timeout_duration = Duration::from_secs(self.config.execution_timeout_secs);
        let mut completed = false;

        while Utc::now() - start_exec_wait < chrono::Duration::from_std(timeout_duration).unwrap() {
            if completion_path.exists() {
                completed = true;
                break;
            }
            sleep(Duration::from_millis(200)).await;
        }

        let _ = stdout_handle.await;
        let _ = stderr_handle.await;

        if !completed {
            let msg = format!(
                "Execution timed out after {} seconds waiting for completion.json",
                self.config.execution_timeout_secs
            );
            event_logger.log(
                "execution",
                "timeout",
                "system",
                serde_json::json!({"error": &msg}),
            );
            let _ = status_tracker.update_stage(
                JobStage::Failed,
                Some(msg.clone()),
                log_paths.clone(),
                vec![],
            );

            let receipt = TaskReceipt {
                job_id: job_id.clone(),
                attempt_id: attempt_id.clone(),
                capability_id: capability_id.to_string(),
                manifest_revision: manifest.manifest_revision,
                execution_status: "FAILED".to_string(),
                agent_session_state: "TimeoutBackgroundActive".to_string(),
                business_outcome: BusinessOutcome::Interrupted,
                executor: ExecutorInfo {
                    executor_type: "mock-stub".to_string(),
                    version: "0.1.0".to_string(),
                    conversation_id: None,
                },
                submission: SubmissionInfo {
                    status: "Submitted".to_string(),
                    exit_code: Some(submission_exit_code),
                },
                script: ScriptInfo { exit_code: None },
                timestamps: TimestampsInfo {
                    started_at,
                    finished_at: Utc::now(),
                    duration_ms: (Utc::now() - started_at).num_milliseconds().max(0) as u64,
                },
                artifacts: vec![],
                logs: LogSummary {
                    events_path: attempt_dir
                        .join("events.jsonl")
                        .to_string_lossy()
                        .to_string(),
                    stdout_path: attempt_dir.join("stdout.log").to_string_lossy().to_string(),
                    stderr_path: attempt_dir.join("stderr.log").to_string_lossy().to_string(),
                    stdout_snippet: "".to_string(),
                    stderr_snippet: "".to_string(),
                    dropped_lines_count: 0,
                    log_truncated: false,
                },
                verification: None,
                error: Some(ReceiptError {
                    stage: "execution".to_string(),
                    code: "TIMEOUT".to_string(),
                    message: msg,
                }),
            };
            receipt.persist_to_file(&attempt_dir.join("receipt.json"))?;
            return Ok(receipt);
        }

        // 8. Verification
        let _ =
            status_tracker.update_stage(JobStage::Verification, None, log_paths.clone(), vec![]);
        event_logger.log(
            "verification",
            "verifying_artifacts",
            "verifier",
            serde_json::json!({}),
        );

        let (completion_report, raw_resolved, business_outcome) = match Verifier::verify_completion(
            &attempt_dir,
            &job_id,
            &attempt_id,
            url,
            &manifest.output_schema,
        ) {
            Ok(res) => res,
            Err(e) => {
                let msg = format!("Verification failed: {}", e);
                event_logger.log(
                    "verification",
                    "verification_failed",
                    "verifier",
                    serde_json::json!({"error": &msg}),
                );
                let _ = status_tracker.update_stage(
                    JobStage::Failed,
                    Some(msg.clone()),
                    log_paths.clone(),
                    vec![],
                );

                let receipt = TaskReceipt {
                    job_id: job_id.clone(),
                    attempt_id: attempt_id.clone(),
                    capability_id: capability_id.to_string(),
                    manifest_revision: manifest.manifest_revision,
                    execution_status: "FAILED".to_string(),
                    agent_session_state: "Completed".to_string(),
                    business_outcome: BusinessOutcome::VerificationFailed,
                    executor: ExecutorInfo {
                        executor_type: "mock-stub".to_string(),
                        version: "0.1.0".to_string(),
                        conversation_id: None,
                    },
                    submission: SubmissionInfo {
                        status: "Submitted".to_string(),
                        exit_code: Some(submission_exit_code),
                    },
                    script: ScriptInfo { exit_code: None },
                    timestamps: TimestampsInfo {
                        started_at,
                        finished_at: Utc::now(),
                        duration_ms: (Utc::now() - started_at).num_milliseconds().max(0) as u64,
                    },
                    artifacts: vec![],
                    logs: LogSummary {
                        events_path: attempt_dir
                            .join("events.jsonl")
                            .to_string_lossy()
                            .to_string(),
                        stdout_path: attempt_dir.join("stdout.log").to_string_lossy().to_string(),
                        stderr_path: attempt_dir.join("stderr.log").to_string_lossy().to_string(),
                        stdout_snippet: "".to_string(),
                        stderr_snippet: "".to_string(),
                        dropped_lines_count: 0,
                        log_truncated: false,
                    },
                    verification: None,
                    error: Some(ReceiptError {
                        stage: "verification".to_string(),
                        code: "VERIFICATION_FAILED".to_string(),
                        message: msg,
                    }),
                };
                receipt.persist_to_file(&attempt_dir.join("receipt.json"))?;
                return Ok(receipt);
            }
        };

        // 9. Build final TaskReceipt
        let mut artifacts = vec![];
        let mut artifact_paths = vec![];
        if let Some(art) = &completion_report.artifact {
            let art_path = attempt_dir.join(&art.file_name);
            artifacts.push(ArtifactRef {
                name: art.file_name.clone(),
                path: art_path.to_string_lossy().to_string(),
                size_bytes: art.size_bytes,
                sha256: art.sha256.clone(),
            });
            artifact_paths.push(art_path.to_string_lossy().to_string());
        }

        let exec_status = if business_outcome == BusinessOutcome::ExtractionFailed {
            "FAILED".to_string()
        } else {
            "COMPLETED".to_string()
        };

        let receipt_err = completion_report.error.map(|e| ReceiptError {
            stage: e.stage,
            code: e.code,
            message: e.message,
        });

        let verification_summary = raw_resolved.map(|r| VerificationSummary {
            valid: true,
            url_matched: true,
            schema_conforming: true,
            artifact_fresh: true,
            transcript_status: r.transcript_status,
        });

        let receipt = TaskReceipt {
            job_id: job_id.clone(),
            attempt_id: attempt_id.clone(),
            capability_id: capability_id.to_string(),
            manifest_revision: manifest.manifest_revision,
            execution_status: exec_status.clone(),
            agent_session_state: "Completed".to_string(),
            business_outcome,
            executor: ExecutorInfo {
                executor_type: "mock-stub".to_string(),
                version: "0.1.0".to_string(),
                conversation_id: None,
            },
            submission: SubmissionInfo {
                status: "Submitted".to_string(),
                exit_code: Some(submission_exit_code),
            },
            script: ScriptInfo {
                exit_code: Some(completion_report.script_exit_code),
            },
            timestamps: TimestampsInfo {
                started_at,
                finished_at: Utc::now(),
                duration_ms: (Utc::now() - started_at).num_milliseconds().max(0) as u64,
            },
            artifacts,
            logs: LogSummary {
                events_path: attempt_dir
                    .join("events.jsonl")
                    .to_string_lossy()
                    .to_string(),
                stdout_path: attempt_dir.join("stdout.log").to_string_lossy().to_string(),
                stderr_path: attempt_dir.join("stderr.log").to_string_lossy().to_string(),
                stdout_snippet: "".to_string(),
                stderr_snippet: "".to_string(),
                dropped_lines_count: 0,
                log_truncated: false,
            },
            verification: verification_summary,
            error: receipt_err,
        };

        let receipt_path = attempt_dir.join("receipt.json");
        receipt.persist_to_file(&receipt_path)?;

        let final_stage = if exec_status == "COMPLETED" {
            JobStage::Completed
        } else {
            JobStage::Failed
        };

        let _ = status_tracker.update_stage(final_stage, None, log_paths, artifact_paths);
        event_logger.log(
            "completion",
            "receipt_finalized",
            "receipt",
            serde_json::json!({
                "status": exec_status,
                "outcome": format!("{:?}", business_outcome),
            }),
        );

        Ok(receipt)
    }
}
