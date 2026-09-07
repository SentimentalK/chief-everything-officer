use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Error, Debug, PartialEq, Eq)]
pub enum ConfigError {
    #[error("Environment variable error: {0}")]
    EnvError(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
    #[error("Invalid ID '{0}'")]
    InvalidId(String),
}

pub fn validate_id(field_name: &str, id: &str) -> Result<(), ConfigError> {
    if id.is_empty() {
        return Err(ConfigError::InvalidId(format!(
            "{} cannot be empty",
            field_name
        )));
    }
    if id.len() > 128 {
        return Err(ConfigError::InvalidId(format!(
            "{} exceeds maximum length of 128 characters: len={}",
            field_name,
            id.len()
        )));
    }
    if id == "." || id == ".." || id.contains("..") || id.contains('/') || id.contains('\\') {
        return Err(ConfigError::InvalidId(format!(
            "{} contains path traversal elements: {:?}",
            field_name, id
        )));
    }
    for ch in id.chars() {
        if !ch.is_ascii_alphanumeric() && ch != '.' && ch != '_' && ch != '-' {
            return Err(ConfigError::InvalidId(format!(
                "{} contains invalid character {:?}. Allowed characters: [a-zA-Z0-9._-]",
                field_name, ch
            )));
        }
    }
    Ok(())
}

pub fn is_subpath(base: &Path, target: &Path) -> bool {
    let base_components: Vec<_> = base.components().collect();
    let target_components: Vec<_> = target.components().collect();
    if target_components.len() < base_components.len() {
        return false;
    }
    target_components[..base_components.len()] == base_components[..]
}

pub fn ceo_dir(workspace: &Path) -> PathBuf {
    workspace.join(".ceo")
}

pub fn jobs_dir(workspace: &Path) -> PathBuf {
    ceo_dir(workspace).join("jobs")
}

pub fn job_dir(workspace: &Path, job_id: &str) -> PathBuf {
    jobs_dir(workspace).join(job_id)
}

pub fn safe_job_dir(workspace: &Path, job_id: &str) -> Result<PathBuf, ConfigError> {
    validate_id("job_id", job_id)?;
    Ok(job_dir(workspace, job_id))
}

pub fn attempt_dir(workspace: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    job_dir(workspace, job_id).join("attempts").join(attempt_id)
}

pub fn safe_attempt_dir(
    workspace: &Path,
    job_id: &str,
    attempt_id: &str,
) -> Result<PathBuf, ConfigError> {
    validate_id("job_id", job_id)?;
    validate_id("attempt_id", attempt_id)?;
    Ok(attempt_dir(workspace, job_id, attempt_id))
}

pub fn doctor_reports_dir(workspace: &Path) -> PathBuf {
    ceo_dir(workspace).join("doctor")
}

pub fn doctor_fixtures_dir(workspace: &Path, attempt_id: &str) -> PathBuf {
    ceo_dir(workspace).join("doctor_fixtures").join(attempt_id)
}

pub fn tmp_dir(workspace: &Path) -> PathBuf {
    ceo_dir(workspace).join("tmp")
}

pub fn snapshot_prompt(
    prompt_path: &Path,
    target_path: &Path,
) -> Result<(String, String), std::io::Error> {
    let content = std::fs::read_to_string(prompt_path)?;
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let sha256 = format!("{:x}", hasher.finalize());
    if let Some(parent) = target_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target_path, &content)?;
    Ok((content, sha256))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutorType {
    AgyHeadless,
    TestStub,
    Agentapi,
}

impl std::fmt::Display for ExecutorType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecutorType::AgyHeadless => write!(f, "agy_headless"),
            ExecutorType::TestStub => write!(f, "test_stub"),
            ExecutorType::Agentapi => write!(f, "antigravity-agentapi"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    pub workspace_dir: PathBuf,
    pub executor_type: ExecutorType,
    pub agent_executable: PathBuf,
    pub agent_model: Option<String>,
    pub doctor_timeout_secs: u64,
    pub task_timeout_secs: u64,
    pub teardown_wait_secs: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        let default_workspace = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let default_agent = PathBuf::from("agy");

        Self {
            workspace_dir: default_workspace,
            executor_type: ExecutorType::AgyHeadless,
            agent_executable: default_agent,
            agent_model: None,
            doctor_timeout_secs: 30,
            task_timeout_secs: 300,
            teardown_wait_secs: 5,
        }
    }
}

impl WorkerConfig {
    pub fn from_env() -> Self {
        let mut config = Self::default();

        if let Ok(val) = std::env::var("CEO_EXECUTOR_TYPE") {
            let lower = val.to_lowercase();
            if lower == "test_stub" || lower == "stub" {
                config.executor_type = ExecutorType::TestStub;
            } else if lower == "agentapi" || lower == "antigravity-agentapi" {
                config.executor_type = ExecutorType::Agentapi;
            } else if lower == "agy" || lower == "agy_headless" {
                config.executor_type = ExecutorType::AgyHeadless;
            }
        }

        if let Ok(dir) = std::env::var("CEO_WORKSPACE_DIR") {
            config.workspace_dir = PathBuf::from(dir);
        }
        if let Ok(bin) = std::env::var("CEO_AGENT_BIN") {
            let bin_path = PathBuf::from(&bin);
            if bin.contains("agentapi") {
                config.executor_type = ExecutorType::Agentapi;
            } else if bin.contains("test_stub") {
                config.executor_type = ExecutorType::TestStub;
            }
            config.agent_executable = bin_path;
        }
        if let Ok(model) = std::env::var("CEO_AGENT_MODEL") {
            if !model.trim().is_empty() {
                config.agent_model = Some(model);
            }
        }
        if let Ok(secs) = std::env::var("CEO_DOCTOR_TIMEOUT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.doctor_timeout_secs = val;
            }
        }
        if let Ok(secs) = std::env::var("CEO_TASK_TIMEOUT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.task_timeout_secs = val;
            }
        }
        if let Ok(secs) = std::env::var("CEO_TEARDOWN_WAIT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.teardown_wait_secs = val;
            }
        }

        config
    }
}
