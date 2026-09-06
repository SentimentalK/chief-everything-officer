use serde::{Deserialize, Serialize};
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
    if id == "." || id == ".." || id.contains('/') || id.contains('\\') {
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
    pub tools_dir: PathBuf,
    pub workspace_dir: PathBuf,
    pub executor_type: ExecutorType,
    pub agent_executable: PathBuf,
    pub agent_model: Option<String>,
    pub auto_setup: bool,
    pub setup_timeout_secs: u64,
    pub submission_timeout_secs: u64,
    pub execution_timeout_secs: u64,
}

impl Default for WorkerConfig {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
        let default_workspace = PathBuf::from(&home)
            .join(".local")
            .join("share")
            .join("ceo-worker")
            .join("workspace");
        let default_tools = PathBuf::from("/home/sentimentalk/codes/tools");
        let default_agent = PathBuf::from("agy");

        Self {
            tools_dir: default_tools,
            workspace_dir: default_workspace,
            executor_type: ExecutorType::AgyHeadless,
            agent_executable: default_agent,
            agent_model: None, // inherited from user Antigravity config unless explicitly specified
            auto_setup: true,
            setup_timeout_secs: 600,
            submission_timeout_secs: 30,
            execution_timeout_secs: 600,
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

        if let Ok(dir) = std::env::var("CEO_TOOLS_DIR") {
            config.tools_dir = PathBuf::from(dir);
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
        if let Ok(auto) = std::env::var("CEO_AUTO_SETUP") {
            config.auto_setup = auto != "0" && auto.to_lowercase() != "false";
        }
        if let Ok(secs) = std::env::var("CEO_SETUP_TIMEOUT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.setup_timeout_secs = val;
            }
        }
        if let Ok(secs) = std::env::var("CEO_SUBMISSION_TIMEOUT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.submission_timeout_secs = val;
            }
        }
        if let Ok(secs) = std::env::var("CEO_EXECUTION_TIMEOUT_SECS") {
            if let Ok(val) = secs.parse::<u64>() {
                config.execution_timeout_secs = val;
            }
        }

        config
    }

    pub fn capability_dir(&self, capability_id: &str) -> PathBuf {
        self.tools_dir.join("capabilities").join(capability_id)
    }

    pub fn safe_capability_dir(&self, capability_id: &str) -> Result<PathBuf, ConfigError> {
        validate_id("capability_id", capability_id)?;
        Ok(self.capability_dir(capability_id))
    }

    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.workspace_dir.join("jobs").join(job_id)
    }

    pub fn safe_job_dir(&self, job_id: &str) -> Result<PathBuf, ConfigError> {
        validate_id("job_id", job_id)?;
        Ok(self.job_dir(job_id))
    }

    pub fn attempt_dir(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.job_dir(job_id).join("attempts").join(attempt_id)
    }

    pub fn safe_attempt_dir(&self, job_id: &str, attempt_id: &str) -> Result<PathBuf, ConfigError> {
        validate_id("job_id", job_id)?;
        validate_id("attempt_id", attempt_id)?;
        Ok(self.attempt_dir(job_id, attempt_id))
    }
}
