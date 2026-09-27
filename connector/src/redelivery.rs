use serde::{Deserialize, Serialize};
use std::fs;

use crate::client::ConnectorClient;
use crate::credential::DeviceCredential;
use crate::managed_result::read_and_validate_from_file;
use crate::paths::ConnectorPaths;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreservedResultMeta {
    pub server_origin: String,
    pub device_id: String,
    pub job_id: String,
    pub attempt_id: String,
    pub claim_token: String,
    pub resource_id: Option<String>,
}

pub async fn run_redeliver(
    paths: &ConnectorPaths,
    job_id: &str,
    specified_attempt_id: Option<&str>,
) -> Result<(), String> {
    let results_dir = paths.results_dir();
    if !results_dir.exists() {
        return Err(format!(
            "Results directory does not exist: {}",
            results_dir.display()
        ));
    }

    let attempt_id = if let Some(att) = specified_attempt_id {
        att.to_string()
    } else {
        // Scan results_dir for {job_id}.*.meta.json
        let prefix = format!("{job_id}.");
        let suffix = ".meta.json";
        let mut matching_attempts = Vec::new();

        let entries =
            fs::read_dir(&results_dir).map_err(|e| format!("Failed to read results dir: {e}"))?;
        for entry in entries {
            let entry = entry.map_err(|e| format!("Directory entry error: {e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&prefix) && name.ends_with(suffix) {
                let inner = &name[prefix.len()..name.len() - suffix.len()];
                if !inner.is_empty() {
                    matching_attempts.push(inner.to_string());
                }
            }
        }

        if matching_attempts.is_empty() {
            return Err(format!(
                "No preserved result metadata found for job '{job_id}' in {}",
                results_dir.display()
            ));
        }
        if matching_attempts.len() > 1 {
            return Err(format!(
                "Multiple attempts found for job '{job_id}' ({:?}). Please specify --attempt <attempt_id>",
                matching_attempts
            ));
        }
        matching_attempts.remove(0)
    };

    let meta_path = paths.preserved_managed_result_meta_file(job_id, &attempt_id);
    if !meta_path.exists() {
        return Err(format!(
            "Preserved metadata file not found: {}",
            meta_path.display()
        ));
    }

    let meta_content =
        fs::read_to_string(&meta_path).map_err(|e| format!("Failed to read meta file: {e}"))?;
    let meta: PreservedResultMeta =
        serde_json::from_str(&meta_content).map_err(|e| format!("Corrupt meta file: {e}"))?;

    let result_path = paths.preserved_managed_result_file(job_id, &attempt_id);
    if !result_path.exists() {
        return Err(format!(
            "Preserved result file not found: {}",
            result_path.display()
        ));
    }

    let (envelope, sha256) = read_and_validate_from_file(
        &result_path,
        &meta.job_id,
        &meta.attempt_id,
        meta.resource_id.as_deref(),
    )
    .map_err(|e| format!("Invalid managed result: {e}"))?;

    let cred = DeviceCredential::load(&paths.credential_file())
        .map_err(|e| format!("Failed to load device credential: {e}"))?
        .ok_or_else(|| "No device credential found (run login first)".to_string())?;

    if cred.server_origin != meta.server_origin || cred.device_id != meta.device_id {
        return Err(format!(
            "Credential mismatch: credential is for device '{}' on '{}', but result is for device '{}' on '{}'",
            cred.device_id, cred.server_origin, meta.device_id, meta.server_origin
        ));
    }

    let client = ConnectorClient::new(&meta.server_origin)
        .map_err(|e| format!("Failed to create client: {e}"))?;
    println!(
        "Submitting redelivery for job '{}', attempt '{}' (delivery_mode: explicit_redelivery)...",
        meta.job_id, meta.attempt_id
    );

    let resp = client
        .submit_job_result(
            &cred,
            &meta.job_id,
            &meta.attempt_id,
            &meta.claim_token,
            &envelope,
            &sha256,
            Some("explicit_redelivery"),
        )
        .await
        .map_err(|e| format!("Server rejected redelivery: {e}"))?;

    println!("Managed result redelivered successfully.");
    println!("  Resource ID: {}", resp.resource_id);
    println!("  Commit:      {}", resp.commit);
    println!("  Server Time: {}", resp.server_time);
    if resp.replayed {
        println!("  Note: Result was replayed (identical digest).");
    }

    Ok(())
}
