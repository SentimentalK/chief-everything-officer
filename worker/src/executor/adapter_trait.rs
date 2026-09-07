use std::path::{Path, PathBuf};
use std::process::ExitStatus;
use thiserror::Error;
use tokio::process::{ChildStderr, ChildStdout};

#[derive(Error, Debug)]
pub enum ExecutorError {
    #[error("Adapter unsupported: {0}")]
    Unsupported(String),
    #[error("Executor needs user action: {message}. Action required: {action_required}")]
    NeedsUserAction {
        message: String,
        action_required: String,
    },
    #[error("Process launch failed: {0}")]
    LaunchFailed(#[from] std::io::Error),
    #[error("Execution timed out after {0} seconds")]
    Timeout(u64),
    #[error("Process error: {0}")]
    ProcessError(String),
}

#[derive(Debug, Clone)]
pub struct ExecutorMetadata {
    pub executor_type: String,
    pub version: String,
    pub binary_path: Option<PathBuf>,
    pub ready: bool,
    pub details: Option<String>,
}

pub struct ExecutionRequest<'a> {
    pub job_id: &'a str,
    pub attempt_id: &'a str,
    pub workspace_dir: &'a Path,
    pub attempt_dir: &'a Path,
    pub prompt_file: &'a Path,
    pub model: Option<&'a str>,
}

pub trait ManagedProcess: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn take_stdout(&mut self) -> Option<ChildStdout>;
    fn take_stderr(&mut self) -> Option<ChildStderr>;
    fn send_input_line<'a>(
        &'a mut self,
        line: &'a str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), std::io::Error>> + Send + 'a>>;
    fn close_stdin(&mut self) -> Result<(), std::io::Error>;
    fn kill_group(&mut self) -> Result<(), std::io::Error>;
    fn force_kill_group(&mut self) -> Result<(), std::io::Error>;
    fn wait(
        &mut self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ExitStatus, std::io::Error>> + Send + '_>,
    >;
}

pub trait ExecutorAdapter: Send + Sync {
    fn executor_type(&self) -> &'static str;
    fn default_version(&self) -> &'static str;
    fn preflight_check(&self) -> Result<ExecutorMetadata, ExecutorError>;
    fn spawn_execution(
        &self,
        request: &ExecutionRequest,
    ) -> Result<Box<dyn ManagedProcess>, ExecutorError>;
}
