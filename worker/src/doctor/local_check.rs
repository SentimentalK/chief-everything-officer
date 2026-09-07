use crate::config::WorkerConfig;
use crate::doctor::session_doctor::run_preflight_static_checks;
use std::ffi::CString;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;
use thiserror::Error;

#[derive(Error, Debug, Clone)]
pub enum LocalCheckError {
    #[error("Workspace error: {0}")]
    WorkspaceUnusable(String),
    #[error("Rule file error: {0}")]
    RuleInvalid(String),
    #[error("Executor binary error: {0}")]
    ExecutorUnexecutable(String),
    #[error("Configuration file error: {0}")]
    ConfigCorrupted(String),
}

impl LocalCheckError {
    pub fn error_code(&self) -> &'static str {
        match self {
            LocalCheckError::WorkspaceUnusable(_) => "WORKSPACE_UNUSABLE",
            LocalCheckError::RuleInvalid(_) => "DOCTOR_PREFLIGHT_FAILED",
            LocalCheckError::ExecutorUnexecutable(_) => "EXECUTOR_UNEXECUTABLE",
            LocalCheckError::ConfigCorrupted(_) => "CONFIG_CORRUPTED",
        }
    }
}

pub fn run_fast_local_precheck(
    workspace: &Path,
    _config: &WorkerConfig,
    resolved_executor: Option<&Path>,
) -> Result<(), LocalCheckError> {
    // 1. Workspace checks: must exist and be writable
    if !workspace.exists() {
        return Err(LocalCheckError::WorkspaceUnusable(format!(
            "Workspace directory does not exist: {}",
            workspace.display()
        )));
    }
    if !workspace.is_dir() {
        return Err(LocalCheckError::WorkspaceUnusable(format!(
            "Workspace path is not a directory: {}",
            workspace.display()
        )));
    }

    let ceo_tmp = workspace.join(".ceo").join("tmp");
    if let Err(e) = fs::create_dir_all(&ceo_tmp) {
        return Err(LocalCheckError::WorkspaceUnusable(format!(
            "Failed to create workspace .ceo/tmp directory: {}",
            e
        )));
    }

    let probe_file = ceo_tmp.join(format!(".write_probe_{}", uuid::Uuid::new_v4()));
    match File::create(&probe_file).and_then(|mut f| f.write_all(b"probe").and_then(|_| f.flush()))
    {
        Ok(_) => {
            let _ = fs::remove_file(&probe_file);
        }
        Err(e) => {
            return Err(LocalCheckError::WorkspaceUnusable(format!(
                "Workspace is not writable at {}: {}",
                probe_file.display(),
                e
            )));
        }
    }

    // 2. Required rule check: AGENTS.md must exist and contain valid rule_marker
    if let Err(e) = run_preflight_static_checks(workspace) {
        return Err(LocalCheckError::RuleInvalid(e));
    }

    // 3. Executor binary check: must exist and be executable
    match resolved_executor {
        Some(bin_path) => {
            if !bin_path.exists() {
                return Err(LocalCheckError::ExecutorUnexecutable(format!(
                    "Executor binary not found at {}",
                    bin_path.display()
                )));
            }
            if !bin_path.is_file() {
                return Err(LocalCheckError::ExecutorUnexecutable(format!(
                    "Executor binary path is not a file: {}",
                    bin_path.display()
                )));
            }

            if let Ok(c_str) = CString::new(bin_path.to_string_lossy().as_bytes()) {
                let is_executable = unsafe { libc::access(c_str.as_ptr(), libc::X_OK) == 0 };
                if !is_executable {
                    return Err(LocalCheckError::ExecutorUnexecutable(format!(
                        "Executor binary at {} lacks execution permission (X_OK)",
                        bin_path.display()
                    )));
                }
            }
        }
        None => {
            return Err(LocalCheckError::ExecutorUnexecutable(
                "Executor binary could not be resolved in PATH or specified location".to_string(),
            ));
        }
    }

    // 4. Critical config files validation (if they exist, they must be readable and valid JSON)
    let home_dir = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let home = Path::new(&home_dir);

    let check_json_file = |p: &Path| -> Result<(), LocalCheckError> {
        if p.exists() {
            let content = fs::read(p).map_err(|e| {
                LocalCheckError::ConfigCorrupted(format!(
                    "Failed to read existing config at {}: {}",
                    p.display(),
                    e
                ))
            })?;
            serde_json::from_slice::<serde_json::Value>(&content).map_err(|e| {
                LocalCheckError::ConfigCorrupted(format!(
                    "Config file at {} is corrupted / invalid JSON: {}",
                    p.display(),
                    e
                ))
            })?;
        }
        Ok(())
    };

    check_json_file(
        &home
            .join(".gemini")
            .join("antigravity-cli")
            .join("settings.json"),
    )?;
    check_json_file(&home.join(".gemini").join("config").join("config.json"))?;

    Ok(())
}
