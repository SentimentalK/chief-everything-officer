use crate::doctor::{run_doctor, DoctorError, DoctorReport, DoctorStatus};
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use thiserror::Error;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Error, Debug)]
pub enum SetupError {
    #[error("Setup script timed out after {0} seconds")]
    Timeout(u64),
    #[error("Setup execution failed: {0}")]
    IoError(#[from] std::io::Error),
    #[error("Setup script exited with code {0}: {1}")]
    NonZeroExit(i32, String),
    #[error("Doctor check failed after setup: {0}")]
    DoctorFailed(#[from] DoctorError),
    #[error("Capability not ready after setup. Status: {0:?}")]
    NotReadyAfterSetup(DoctorStatus),
}

pub async fn run_setup(
    capability_dir: &Path,
    timeout_secs: u64,
) -> Result<DoctorReport, SetupError> {
    let setup_path = capability_dir.join("setup");

    let child = Command::new(&setup_path)
        .current_dir(capability_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let fut = child.wait_with_output();
    let output = timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .map_err(|_| SetupError::Timeout(timeout_secs))??;

    if !output.status.success() {
        let code = output.status.code().unwrap_or(-1);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(SetupError::NonZeroExit(
            code,
            format!("stderr: {}\nstdout: {}", stderr.trim(), stdout.trim()),
        ));
    }

    // Re-run doctor to verify environment
    let report = run_doctor(capability_dir).await?;
    if report.status != DoctorStatus::Ready {
        return Err(SetupError::NotReadyAfterSetup(report.status));
    }

    Ok(report)
}
