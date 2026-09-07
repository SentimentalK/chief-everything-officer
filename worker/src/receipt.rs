use crate::doctor::SessionDoctorReport;
use crate::verifier::{ArtifactClaim, BusinessOutcome};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutorInfo {
    #[serde(rename = "type")]
    pub executor_type: String,
    pub version: String,
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampsInfo {
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogSummary {
    pub events_path: String,
    pub stdout_path: String,
    pub stderr_path: String,
    pub stdout_snippet: String,
    pub stderr_snippet: String,
    pub dropped_lines_count: u64,
    pub log_truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReceiptError {
    pub stage: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskReceipt {
    pub job_id: String,
    pub attempt_id: String,
    pub workspace: String,
    pub prompt_file: String,
    pub prompt_sha256: String,
    pub execution_status: String,
    pub business_outcome: BusinessOutcome,
    pub executor: ExecutorInfo,
    pub doctor: Option<SessionDoctorReport>,
    pub timestamps: TimestampsInfo,
    pub artifacts: Vec<ArtifactClaim>,
    pub logs: LogSummary,
    pub error: Option<ReceiptError>,
}

impl TaskReceipt {
    pub fn persist_to_file(&self, path: &Path) -> std::io::Result<()> {
        let content = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;

        let tmp_path = path.with_extension("tmp");
        let mut file = File::create(&tmp_path)?;
        file.write_all(content.as_bytes())?;
        file.flush()?;
        fs::rename(tmp_path, path)?;
        Ok(())
    }
}
