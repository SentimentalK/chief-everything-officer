use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobStage {
    Doctor,
    Setup,
    Submission,
    Execution,
    Verification,
    Completed,
    Failed,
    UnknownInterrupted,
}

impl std::fmt::Display for JobStage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JobStage::Doctor => write!(f, "Doctor"),
            JobStage::Setup => write!(f, "Setup"),
            JobStage::Submission => write!(f, "Submission"),
            JobStage::Execution => write!(f, "Execution"),
            JobStage::Verification => write!(f, "Verification"),
            JobStage::Completed => write!(f, "Completed"),
            JobStage::Failed => write!(f, "Failed"),
            JobStage::UnknownInterrupted => write!(f, "UnknownInterrupted"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusReport {
    pub job_id: String,
    pub latest_attempt_id: String,
    pub stage: JobStage,
    pub started_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub duration_ms: u64,
    pub runner_instance_id: String,
    pub runner_pid: u32,
    pub runner_start_time: Option<u64>,
    pub latest_error: Option<String>,
    pub log_paths: HashMap<String, String>,
    pub artifact_paths: Vec<String>,
}

#[derive(Clone)]
pub struct StatusTracker {
    job_dir: PathBuf,
    status_path: PathBuf,
    job_id: String,
    attempt_id: String,
    runner_instance_id: String,
    runner_pid: u32,
    runner_start_time: Option<u64>,
    started_at: DateTime<Utc>,
}

impl StatusTracker {
    pub fn new(job_dir: &Path, job_id: &str, attempt_id: &str) -> Self {
        let status_path = job_dir.join("status.json");
        let runner_pid = std::process::id();
        let runner_start_time = get_process_start_time(runner_pid);
        let runner_instance_id = Uuid::new_v4().to_string();

        Self {
            job_dir: job_dir.to_path_buf(),
            status_path,
            job_id: job_id.to_string(),
            attempt_id: attempt_id.to_string(),
            runner_instance_id,
            runner_pid,
            runner_start_time,
            started_at: Utc::now(),
        }
    }

    pub fn runner_instance_id(&self) -> &str {
        &self.runner_instance_id
    }

    pub fn update_stage(
        &self,
        stage: JobStage,
        error: Option<String>,
        log_paths: HashMap<String, String>,
        artifact_paths: Vec<String>,
    ) -> std::io::Result<()> {
        let now = Utc::now();
        let duration_ms = (now - self.started_at).num_milliseconds().max(0) as u64;

        let report = StatusReport {
            job_id: self.job_id.clone(),
            latest_attempt_id: self.attempt_id.clone(),
            stage,
            started_at: self.started_at,
            updated_at: now,
            duration_ms,
            runner_instance_id: self.runner_instance_id.clone(),
            runner_pid: self.runner_pid,
            runner_start_time: self.runner_start_time,
            latest_error: error,
            log_paths,
            artifact_paths,
        };

        self.persist_atomic(&report)
    }

    fn persist_atomic(&self, report: &StatusReport) -> std::io::Result<()> {
        let tmp_path = self.job_dir.join(".status.json.tmp");
        let content = serde_json::to_string_pretty(report).map_err(std::io::Error::other)?;

        let mut file = File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        fs::rename(tmp_path, &self.status_path)?;
        Ok(())
    }

    pub fn load_status(job_dir: &Path) -> Result<StatusReport, std::io::Error> {
        let status_path = job_dir.join("status.json");
        let content = fs::read_to_string(&status_path)?;
        let mut report: StatusReport = serde_json::from_str(&content)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // Crash detection: If the reported stage is active (not terminal),
        // check if the runner process is actually still running and matches start time.
        if !matches!(
            report.stage,
            JobStage::Completed | JobStage::Failed | JobStage::UnknownInterrupted
        ) {
            let is_alive = check_process_alive(report.runner_pid, report.runner_start_time);
            if !is_alive {
                report.stage = JobStage::UnknownInterrupted;
                if report.latest_error.is_none() {
                    report.latest_error =
                        Some("Runner process terminated unexpectedly".to_string());
                }
            }
        }

        Ok(report)
    }
}

pub fn get_process_start_time(pid: u32) -> Option<u64> {
    #[cfg(target_os = "linux")]
    {
        let stat_path = format!("/proc/{}/stat", pid);
        if let Ok(content) = fs::read_to_string(stat_path) {
            // Field 22 (1-indexed) in /proc/[pid]/stat is starttime
            // Format has command name in parentheses, e.g. "1234 (name with spaces) S ..."
            if let Some(idx) = content.rfind(')') {
                let rest = &content[idx + 2..];
                let fields: Vec<&str> = rest.split_whitespace().collect();
                // In `rest`, field 0 is state, field 1 is ppid... field 19 is starttime (index 19 in rest)
                if fields.len() > 19 {
                    return fields[19].parse::<u64>().ok();
                }
            }
        }
    }
    let _ = pid;
    None
}

pub fn check_process_alive(pid: u32, expected_start_time: Option<u64>) -> bool {
    #[cfg(target_os = "linux")]
    {
        let proc_path = format!("/proc/{}", pid);
        if !Path::new(&proc_path).exists() {
            return false;
        }

        if let Some(expected) = expected_start_time {
            if let Some(actual) = get_process_start_time(pid) {
                return actual == expected;
            } else {
                return false;
            }
        }

        true
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        let _ = expected_start_time;
        true
    }
}
