use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Stdio;
use thiserror::Error;
use tokio::process::Command;

#[derive(Error, Debug)]
pub enum DoctorError {
    #[error("Doctor script not found or cannot execute: {0}")]
    ExecutionFailed(#[from] std::io::Error),
    #[error("Doctor script failed with exit code {0}: {1}")]
    NonZeroExit(i32, String),
    #[error("Failed to parse doctor output JSON: {0} (Raw output: {1})")]
    JsonParseError(serde_json::Error, String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DoctorStatus {
    Ready,
    NeedsSetup,
    NeedsUserAction,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorCheck {
    pub name: String,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DoctorReport {
    pub status: DoctorStatus,
    #[serde(default)]
    pub base_ready: bool,
    #[serde(default)]
    pub asr_available: bool,
    #[serde(default)]
    pub checks: Vec<DoctorCheck>,
    #[serde(default)]
    pub actions: Vec<String>,
}

pub async fn run_doctor(capability_dir: &Path) -> Result<DoctorReport, DoctorError> {
    let doctor_path = capability_dir.join("doctor");
    let output = Command::new(&doctor_path)
        .current_dir(capability_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await?;

    let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        return Err(DoctorError::NonZeroExit(
            code,
            format!(
                "stderr: {}, stdout: {}",
                stderr_str.trim(),
                stdout_str.trim()
            ),
        ));
    }

    let report: DoctorReport = serde_json::from_str(&stdout_str)
        .map_err(|e| DoctorError::JsonParseError(e, stdout_str))?;

    Ok(report)
}
