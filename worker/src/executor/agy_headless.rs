use crate::executor::adapter_trait::{
    ExecutionRequest, ExecutorAdapter, ExecutorError, ExecutorMetadata, ManagedProcess,
};
use crate::executor::process::GroupManagedProcess;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

pub struct AgyHeadlessAdapter {
    executable: PathBuf,
}

impl AgyHeadlessAdapter {
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }

    pub fn build_command_args(&self, request: &ExecutionRequest) -> Vec<String> {
        let mut args = vec![
            "--input-format".to_string(),
            "stream-json".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--mode".to_string(),
            "accept-edits".to_string(),
            "--dangerously-skip-permissions".to_string(),
            "--sandbox".to_string(),
            "--log-file".to_string(),
            request
                .attempt_dir
                .join("agy.log")
                .to_string_lossy()
                .to_string(),
        ];

        let model = request.model.unwrap_or("gemini-3.8-flash-medium");
        args.push("--model".to_string());
        args.push(model.to_string());

        args
    }

    fn resolve_binary(&self) -> Option<PathBuf> {
        if self.executable.is_absolute() && self.executable.exists() {
            return Some(self.executable.clone());
        }
        if let Ok(paths) = std::env::var("PATH") {
            for path in std::env::split_paths(&paths) {
                let candidate = path.join(&self.executable);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

impl ExecutorAdapter for AgyHeadlessAdapter {
    fn executor_type(&self) -> &'static str {
        "agy_headless"
    }

    fn default_version(&self) -> &'static str {
        "official-cli"
    }

    fn preflight_check(&self) -> Result<ExecutorMetadata, ExecutorError> {
        let binary_path = match self.resolve_binary() {
            Some(p) => p,
            None => {
                return Err(ExecutorError::NeedsUserAction {
                    message: format!(
                        "Google Antigravity CLI ('{}') is not installed or not found in PATH.",
                        self.executable.display()
                    ),
                    action_required: "Install agy CLI via: curl -fsSL https://antigravity.google/cli/install.sh | bash, and run 'agy' in an interactive terminal to complete authentication. Documentation: https://antigravity.google/docs/cli/install/".to_string(),
                });
            }
        };

        // Try executing `--version` synchronously
        let version_output = std::process::Command::new(&binary_path)
            .arg("--version")
            .output();

        let version_str = match version_output {
            Ok(output) if output.status.success() => {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            }
            Ok(output) => {
                let err_msg = String::from_utf8_lossy(&output.stderr).trim().to_string();
                return Err(ExecutorError::NeedsUserAction {
                    message: format!("Google Antigravity CLI failed --version check: {}", err_msg),
                    action_required:
                        "Verify agy installation and run 'agy' to complete initial authentication."
                            .to_string(),
                });
            }
            Err(e) => {
                return Err(ExecutorError::NeedsUserAction {
                    message: format!("Failed to execute Google Antigravity CLI: {}", e),
                    action_required: "Verify binary permissions and PATH configuration."
                        .to_string(),
                });
            }
        };

        Ok(ExecutorMetadata {
            executor_type: self.executor_type().to_string(),
            version: version_str,
            binary_path: Some(binary_path),
            ready: true,
            details: None,
        })
    }

    fn spawn_execution(
        &self,
        request: &ExecutionRequest,
    ) -> Result<Box<dyn ManagedProcess>, ExecutorError> {
        let binary_path = self.resolve_binary().ok_or_else(|| {
            ExecutorError::NeedsUserAction {
                message: format!(
                    "Google Antigravity CLI ('{}') is not installed or not found in PATH.",
                    self.executable.display()
                ),
                action_required: "Install agy CLI via: curl -fsSL https://antigravity.google/cli/install.sh | bash, and run 'agy' in an interactive terminal to complete authentication.".to_string(),
            }
        })?;

        let mut cmd = Command::new(&binary_path);
        for arg in self.build_command_args(request) {
            cmd.arg(arg);
        }
        cmd.current_dir(request.workspace_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Confine logs and temp files to workspace
        let ceo_tmp = request.workspace_dir.join(".ceo").join("tmp");
        std::fs::create_dir_all(&ceo_tmp)?;
        cmd.env("TMPDIR", &ceo_tmp);

        #[cfg(target_os = "linux")]
        unsafe {
            cmd.pre_exec(|| {
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }

        let child = cmd.spawn()?;
        let pgid = child.id().map(|pid| pid as i32);

        Ok(Box::new(GroupManagedProcess::new(child, pgid)))
    }
}
