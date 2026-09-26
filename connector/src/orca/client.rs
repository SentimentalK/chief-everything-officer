use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::types::*;

pub const MAX_CLI_BUFFER_BYTES: usize = 512 * 1024;
pub const DEFAULT_OPERATION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone)]
pub struct OrcaCommandOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Error, Debug)]
pub enum OrcaError {
    #[error("Orca executable not found or IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Orca CLI timeout after {0:?}")]
    Timeout(Duration),
    #[error("Orca CLI returned exit code {code:?}: {stderr}")]
    CommandFailed { code: Option<i32>, stderr: String },
    #[error("Failed to parse Orca JSON output: {0}. Raw output: {1}")]
    JsonParse(serde_json::Error, String),
    #[error("Orca protocol error: {0}. Raw output: {1}")]
    Protocol(String, String),
    #[error("Orca reported error: {code}: {message}")]
    Orca {
        code: String,
        message: String,
        data: Option<serde_json::Value>,
    },
}

impl OrcaError {
    pub fn error_code(&self) -> Option<&str> {
        match self {
            OrcaError::Orca { code, .. } => Some(code.as_str()),
            _ => None,
        }
    }

    pub fn is_code(&self, target_code: &str) -> bool {
        self.error_code() == Some(target_code)
    }
}

pub fn parse_orca_json<T: DeserializeOwned>(output: OrcaCommandOutput) -> Result<T, OrcaError> {
    let trimmed = output.stdout.trim();
    if trimmed.is_empty() {
        return Err(OrcaError::CommandFailed {
            code: output.exit_code,
            stderr: output.stderr,
        });
    }

    let value: serde_json::Value = serde_json::from_str(trimmed)
        .map_err(|e| OrcaError::JsonParse(e, output.stdout.clone()))?;

    let ok = value.get("ok").and_then(|v| v.as_bool()).ok_or_else(|| {
        OrcaError::Protocol(
            "missing or non-boolean top-level 'ok' field in response envelope".into(),
            output.stdout.clone(),
        )
    })?;

    if !ok {
        let failure: OrcaFailureEnvelope = serde_json::from_value(value).map_err(|e| {
            OrcaError::Protocol(
                format!("failed to deserialize OrcaFailureEnvelope: {e}"),
                output.stdout.clone(),
            )
        })?;
        return Err(OrcaError::Orca {
            code: failure.error.code,
            message: failure.error.message,
            data: failure.error.data,
        });
    }

    serde_json::from_value(value).map_err(|e| OrcaError::JsonParse(e, output.stdout))
}

#[derive(Clone, Debug)]
pub struct OrcaCliClient {
    bin_path: PathBuf,
    default_timeout: Duration,
}

impl Default for OrcaCliClient {
    fn default() -> Self {
        Self::new("orca")
    }
}

impl OrcaCliClient {
    pub fn new(bin_path: impl Into<PathBuf>) -> Self {
        Self {
            bin_path: bin_path.into(),
            default_timeout: DEFAULT_OPERATION_TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.default_timeout = timeout;
        self
    }

    pub async fn execute_command(
        &self,
        args: &[&str],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<OrcaCommandOutput, OrcaError> {
        let mut cmd = Command::new(&self.bin_path);
        cmd.args(args);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = {
            let mut attempts = 0;
            loop {
                match cmd.spawn() {
                    Ok(c) => break c,
                    Err(e) if e.raw_os_error() == Some(26) && attempts < 5 => {
                        attempts += 1;
                        tokio::time::sleep(Duration::from_millis(5 * attempts)).await;
                    }
                    Err(e) => return Err(e.into()),
                }
            }
        };

        let stdout_handle = child.stdout.take().expect("stdout handle");
        let stderr_handle = child.stderr.take().expect("stderr handle");

        let timeout_fut = tokio::time::sleep(timeout);
        tokio::pin!(timeout_fut);

        let mut stdout_buf = Vec::new();
        let mut stderr_buf = Vec::new();

        tokio::select! {
            _ = &mut timeout_fut => {
                let _ = child.kill().await;
                Err(OrcaError::Timeout(timeout))
            }
            res = async {
                let mut stdout_take = stdout_handle.take(MAX_CLI_BUFFER_BYTES as u64);
                let mut stderr_take = stderr_handle.take(MAX_CLI_BUFFER_BYTES as u64);
                let (r1, r2) = tokio::join!(
                    stdout_take.read_to_end(&mut stdout_buf),
                    stderr_take.read_to_end(&mut stderr_buf),
                );
                r1?;
                r2?;
                child.wait().await
            } => {
                let status = res?;
                let stdout_str = String::from_utf8_lossy(&stdout_buf).to_string();
                let stderr_str = String::from_utf8_lossy(&stderr_buf).to_string();

                Ok(OrcaCommandOutput {
                    exit_code: status.code(),
                    stdout: stdout_str,
                    stderr: stderr_str,
                })
            }
        }
    }

    pub async fn status(&self) -> Result<OrcaStatusResponse, OrcaError> {
        let output = self
            .execute_command(&["status", "--json"], None, self.default_timeout)
            .await?;
        parse_orca_json(output)
    }

    pub async fn list_worktrees(&self) -> Result<Vec<OrcaWorktreeItem>, OrcaError> {
        let output = self
            .execute_command(&["worktree", "list", "--json"], None, self.default_timeout)
            .await?;
        let resp: OrcaWorktreeListResponse = parse_orca_json(output)?;
        Ok(resp.result.map(|r| r.worktrees).unwrap_or_default())
    }

    pub async fn show_worktree_by_path(
        &self,
        canonical_target_path: &Path,
    ) -> Result<Option<OrcaWorktreeItem>, OrcaError> {
        let selector = format!("path:{}", canonical_target_path.display());
        let res = self
            .execute_command(
                &["worktree", "show", "--worktree", &selector, "--json"],
                None,
                self.default_timeout,
            )
            .await;

        match res {
            Ok(output) => match parse_orca_json::<OrcaWorktreeShowResponse>(output) {
                Ok(resp) => Ok(resp.result.map(|r| r.worktree)),
                Err(OrcaError::Orca { ref code, .. })
                    if code == "selector_not_found" || code == "not_found" =>
                {
                    Ok(None)
                }
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        }
    }

    pub async fn add_repo(&self, path: &Path) -> Result<OrcaRepoItem, OrcaError> {
        let path_str = path.display().to_string();
        let output = self
            .execute_command(
                &["repo", "add", "--path", &path_str, "--json"],
                None,
                self.default_timeout,
            )
            .await?;
        let resp: OrcaRepoAddResponse = parse_orca_json(output)?;
        resp.result.map(|r| r.repo).ok_or_else(|| {
            OrcaError::Protocol(
                "repo add returned ok=true but missing repo object".into(),
                String::new(),
            )
        })
    }

    pub async fn list_terminals_result(
        &self,
        worktree_selector: Option<&str>,
    ) -> Result<OrcaTerminalListResult, OrcaError> {
        let mut args = vec!["terminal", "list", "--json"];
        let selector_binding;
        if let Some(w) = worktree_selector {
            selector_binding = format!("--worktree={w}");
            args.push(&selector_binding);
        }
        let output = self
            .execute_command(&args, None, self.default_timeout)
            .await?;
        let resp: OrcaTerminalListResponse = parse_orca_json(output)?;
        resp.result.ok_or_else(|| {
            OrcaError::Protocol(
                "terminal list returned ok=true but missing result".into(),
                String::new(),
            )
        })
    }

    pub async fn list_terminals(
        &self,
        worktree_selector: Option<&str>,
    ) -> Result<Vec<OrcaTerminalItem>, OrcaError> {
        let res = self.list_terminals_result(worktree_selector).await?;
        Ok(res.terminals)
    }

    pub async fn show_terminal(
        &self,
        terminal_handle: &str,
    ) -> Result<Option<OrcaTerminalItem>, OrcaError> {
        let args = vec!["terminal", "show", "--terminal", terminal_handle, "--json"];
        let output = self
            .execute_command(&args, None, self.default_timeout)
            .await?;
        match parse_orca_json::<OrcaTerminalShowResponse>(output) {
            Ok(resp) => Ok(resp.result.map(|r| r.terminal)),
            Err(OrcaError::Orca { ref code, .. })
                if code == "terminal_not_found" || code == "selector_not_found" =>
            {
                Ok(None)
            }
            Err(e) => Err(e),
        }
    }

    pub async fn create_terminal(
        &self,
        worktree_selector: &str,
        title: &str,
        command: Option<&str>,
        cwd: Option<&Path>,
    ) -> Result<OrcaTerminalItem, OrcaError> {
        let mut args = vec![
            "terminal",
            "create",
            "--worktree",
            worktree_selector,
            "--title",
            title,
            "--json",
        ];
        if let Some(cmd) = command {
            args.push("--command");
            args.push(cmd);
        }
        let output = self
            .execute_command(&args, cwd, self.default_timeout)
            .await?;
        let resp: OrcaTerminalCreateResponse = parse_orca_json(output)?;
        resp.result.map(|r| r.terminal).ok_or_else(|| {
            OrcaError::Protocol(
                "terminal create returned missing terminal object".into(),
                String::new(),
            )
        })
    }

    pub async fn send_terminal_prompt(
        &self,
        terminal_handle: &str,
        text: &str,
        retry_request_id: Option<&str>,
        wait_submit_seconds: Option<u32>,
    ) -> Result<OrcaTerminalSendResponse, OrcaError> {
        let mut args = vec![
            "terminal",
            "send",
            "--terminal",
            terminal_handle,
            "--text",
            text,
            "--enter",
            "--json",
        ];
        let wait_submit_str;
        if let Some(secs) = wait_submit_seconds {
            wait_submit_str = secs.to_string();
            args.push("--wait-submit");
            args.push(&wait_submit_str);
        }
        if let Some(req_id) = retry_request_id {
            args.push("--retry-request");
            args.push(req_id);
        }

        let output = self
            .execute_command(&args, None, self.default_timeout)
            .await?;
        parse_orca_json(output)
    }

    pub async fn wait_terminal_tui_idle(
        &self,
        terminal_handle: &str,
        timeout: Duration,
    ) -> Result<OrcaTerminalWaitResponse, OrcaError> {
        let timeout_ms = timeout.as_millis().to_string();
        let args = vec![
            "terminal",
            "wait",
            "--terminal",
            terminal_handle,
            "--for",
            "tui-idle",
            "--timeout-ms",
            &timeout_ms,
            "--json",
        ];
        // Allow a slight buffer on top of --timeout-ms for the CLI process execution
        let cli_timeout = timeout + Duration::from_secs(5);
        let output = self.execute_command(&args, None, cli_timeout).await?;
        parse_orca_json(output)
    }

    pub async fn close_terminal(
        &self,
        terminal_handle: &str,
    ) -> Result<OrcaTerminalCloseResponse, OrcaError> {
        let args = vec!["terminal", "close", "--terminal", terminal_handle, "--json"];
        let output = self
            .execute_command(&args, None, self.default_timeout)
            .await?;
        parse_orca_json(output)
    }
}
