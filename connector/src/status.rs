use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use thiserror::Error;

use crate::config::LocalConfig;
use crate::credential::DeviceCredential;
use crate::local_state::ExecutionLock;
use crate::paths::ConnectorPaths;

#[derive(Error, Debug)]
pub enum StatusError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ConnectorStatus {
    pub logged_in: bool,
    pub server_origin: Option<String>,
    pub device_id: Option<String>,
    pub credential_expires_at_ms: Option<i64>,
    pub daemon_running: bool,
    pub paused: bool,
    pub target_count: usize,
    pub active_attempt_job_id: Option<String>,
    pub outbox_pending_count: usize,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlFile {
    pub schema_version: u32,
    #[serde(default)]
    pub paused: bool,
}

pub fn get_status(paths: &ConnectorPaths) -> Result<ConnectorStatus, StatusError> {
    let config = LocalConfig::load(&paths.config_file()).unwrap_or(None);
    let cred = DeviceCredential::load(&paths.credential_file()).unwrap_or(None);

    let daemon_running = ExecutionLock::is_locked(&paths.daemon_lock_file());

    let paused = if paths.control_file().exists() {
        if let Ok(content) = fs::read_to_string(paths.control_file()) {
            serde_json::from_str::<ControlFile>(&content)
                .map(|c| c.paused)
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    let target_count = config.as_ref().map(|c| c.targets.len()).unwrap_or(0);

    let active_attempt_job_id = if paths.active_attempt_file().exists() {
        if let Ok(content) = fs::read_to_string(paths.active_attempt_file()) {
            serde_json::from_str::<serde_json::Value>(&content)
                .ok()
                .and_then(|v| {
                    v.get("job_id")
                        .and_then(|j| j.as_str())
                        .map(|s| s.to_string())
                })
        } else {
            None
        }
    } else {
        None
    };

    let outbox_pending_count = count_files_in_dir(&paths.outbox_dir()).unwrap_or(0);

    Ok(ConnectorStatus {
        logged_in: cred.is_some(),
        server_origin: cred
            .as_ref()
            .map(|c| c.server_origin.clone())
            .or_else(|| config.as_ref().map(|c| c.server_url.clone())),
        device_id: cred.as_ref().map(|c| c.device_id.clone()),
        credential_expires_at_ms: cred.as_ref().map(|c| c.expires_at_ms),
        daemon_running,
        paused,
        target_count,
        active_attempt_job_id,
        outbox_pending_count,
    })
}

fn count_files_in_dir(path: &Path) -> std::io::Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            count += 1;
        }
    }
    Ok(count)
}

pub fn print_status(status: &ConnectorStatus, json_format: bool) {
    if json_format {
        println!("{}", serde_json::to_string_pretty(status).unwrap());
    } else {
        println!("============================================================");
        println!("  CEO Connector Status");
        println!("============================================================");
        println!("  Logged in:      {}", status.logged_in);
        if let Some(ref origin) = status.server_origin {
            println!("  Server origin:  {}", origin);
        }
        if let Some(ref dev_id) = status.device_id {
            println!("  Device ID:      {}", dev_id);
        }
        if let Some(exp) = status.credential_expires_at_ms {
            let dt = chrono::DateTime::from_timestamp_millis(exp)
                .map(|t| t.to_rfc3339())
                .unwrap_or_else(|| exp.to_string());
            println!("  Cred expires:   {}", dt);
        }
        println!("  Daemon running: {}", status.daemon_running);
        println!("  Paused:         {}", status.paused);
        println!("  Local targets:  {}", status.target_count);
        if let Some(ref job_id) = status.active_attempt_job_id {
            println!("  Active attempt: {}", job_id);
        } else {
            println!("  Active attempt: None");
        }
        println!("  Outbox pending: {}", status.outbox_pending_count);
        println!("============================================================");
    }
}
