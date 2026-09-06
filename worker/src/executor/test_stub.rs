use crate::executor::adapter_trait::{
    ExecutionRequest, ExecutorAdapter, ExecutorError, ExecutorMetadata, ManagedProcess,
};
use crate::executor::process::GroupManagedProcess;
use std::path::PathBuf;
use std::process::Stdio;
use tokio::process::Command;

pub struct TestStubAdapter {
    executable: PathBuf,
}

impl TestStubAdapter {
    pub fn new(executable: PathBuf) -> Self {
        Self { executable }
    }
}

impl ExecutorAdapter for TestStubAdapter {
    fn executor_type(&self) -> &'static str {
        "test_stub"
    }

    fn default_version(&self) -> &'static str {
        "stub-0.1.0"
    }

    fn preflight_check(&self) -> Result<ExecutorMetadata, ExecutorError> {
        if !self.executable.exists() {
            return Err(ExecutorError::LaunchFailed(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("Test stub script not found at {:?}", self.executable),
            )));
        }

        Ok(ExecutorMetadata {
            executor_type: self.executor_type().to_string(),
            version: self.default_version().to_string(),
            binary_path: Some(self.executable.clone()),
            ready: true,
            details: Some("Hermetic test stub executor".to_string()),
        })
    }

    fn spawn_execution(
        &self,
        request: &ExecutionRequest,
    ) -> Result<Box<dyn ManagedProcess>, ExecutorError> {
        let exe = if self.executable.is_relative() {
            std::env::current_dir()
                .map(|cd| cd.join(&self.executable))
                .unwrap_or_else(|_| self.executable.clone())
        } else {
            self.executable.clone()
        };
        let mut cmd = Command::new(&exe);
        cmd.arg("--input")
            .arg(request.input_json_path)
            .arg("--output-dir")
            .arg(request.attempt_dir)
            .arg("--run-script")
            .arg(request.run_script_path)
            .current_dir(request.attempt_dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

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
