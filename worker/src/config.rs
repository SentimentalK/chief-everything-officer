use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("Environment variable error: {0}")]
    EnvError(String),
    #[error("Invalid path: {0}")]
    InvalidPath(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerConfig {
    pub tools_dir: PathBuf,
    pub workspace_dir: PathBuf,
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
        let default_agent = PathBuf::from(&home)
            .join(".gemini")
            .join("antigravity")
            .join("bin")
            .join("agentapi");

        Self {
            tools_dir: default_tools,
            workspace_dir: default_workspace,
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

        if let Ok(dir) = std::env::var("CEO_TOOLS_DIR") {
            config.tools_dir = PathBuf::from(dir);
        }
        if let Ok(dir) = std::env::var("CEO_WORKSPACE_DIR") {
            config.workspace_dir = PathBuf::from(dir);
        }
        if let Ok(bin) = std::env::var("CEO_AGENT_BIN") {
            config.agent_executable = PathBuf::from(bin);
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

    pub fn job_dir(&self, job_id: &str) -> PathBuf {
        self.workspace_dir.join("jobs").join(job_id)
    }

    pub fn attempt_dir(&self, job_id: &str, attempt_id: &str) -> PathBuf {
        self.job_dir(job_id).join("attempts").join(attempt_id)
    }
}
