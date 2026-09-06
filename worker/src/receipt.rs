use crate::verifier::BusinessOutcome;
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
pub struct SubmissionInfo {
    pub status: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptInfo {
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampsInfo {
    pub started_at: DateTime<Utc>,
    pub finished_at: DateTime<Utc>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactRef {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
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
pub struct VerificationSummary {
    pub valid: bool,
    pub url_matched: bool,
    pub schema_conforming: bool,
    pub artifact_fresh: bool,
    pub transcript_status: String,
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
    pub capability_id: String,
    pub manifest_revision: u32,
    pub execution_status: String,
    pub agent_session_state: String,
    pub business_outcome: BusinessOutcome,
    pub executor: ExecutorInfo,
    pub submission: SubmissionInfo,
    pub script: ScriptInfo,
    pub timestamps: TimestampsInfo,
    pub artifacts: Vec<ArtifactRef>,
    pub logs: LogSummary,
    pub verification: Option<VerificationSummary>,
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
