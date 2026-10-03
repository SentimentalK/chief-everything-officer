use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DeliveryReceipt {
    pub job_id: String,
    pub attempt_id: String,
    pub payload_sha256: String,
    pub delivered_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit: Option<String>,
}

pub fn receipt_file_path(results_dir: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    results_dir.join(format!("{job_id}.{attempt_id}.receipt.json"))
}

pub async fn run_redeliver(
    paths: &ConnectorPaths,
    specified_job_id: Option<&str>,
    specified_attempt_id: Option<&str>,
) -> Result<(), String> {
    match specified_job_id {
        Some(job_id) => run_explicit_redeliver(paths, job_id, specified_attempt_id).await,
        None => run_smart_redeliver(paths).await,
    }
}

/// Smart redelivery: scans only THIS device's preserved results for unresolved
/// legitimate candidates. Skips already delivered candidates (via local receipt
/// or server digest check). Persists local receipt after successful delivery.
/// Never mutates historical execution report files.
pub async fn run_smart_redeliver(paths: &ConnectorPaths) -> Result<(), String> {
    let results_dir = paths.results_dir();
    if !results_dir.exists() {
        println!("No pending results to redeliver.");
        return Ok(());
    }

    let cred = match DeviceCredential::load(&paths.credential_file())
        .map_err(|e| format!("Failed to load device credential: {e}"))?
    {
        Some(c) => c,
        None => return Err("No device credential found (run `ceo-connector login` first)".into()),
    };

    let entries =
        fs::read_dir(&results_dir).map_err(|e| format!("Failed to read results dir: {e}"))?;
    let mut candidates: Vec<(String, String)> = Vec::new();

    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.ends_with(".meta.json") {
            let base = &file_name[..file_name.len() - ".meta.json".len()];
            if let Some(pos) = base.find('.') {
                let job_id = &base[..pos];
                let attempt_id = &base[pos + 1..];
                if !job_id.is_empty() && !attempt_id.is_empty() {
                    candidates.push((job_id.to_string(), attempt_id.to_string()));
                }
            }
        }
    }

    if candidates.is_empty() {
        println!("No pending results to redeliver.");
        return Ok(());
    }

    // Sort for deterministic processing
    candidates.sort();

    let mut delivered_count = 0;

    for (job_id, attempt_id) in candidates {
        let meta_path = paths.preserved_managed_result_meta_file(&job_id, &attempt_id);
        if !meta_path.exists() {
            continue;
        }

        let meta_content = match fs::read_to_string(&meta_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let meta: PreservedResultMeta = match serde_json::from_str(&meta_content) {
            Ok(m) => m,
            Err(_) => continue,
        };

        // Credential and device boundary: only redeliver for this device & server
        if meta.server_origin != cred.server_origin || meta.device_id != cred.device_id {
            continue;
        }

        // Fast local receipt optimization: skip if local receipt already exists
        let receipt_path = receipt_file_path(&results_dir, &job_id, &attempt_id);
        if receipt_path.exists() {
            continue;
        }

        // Validate local managed result candidate strictly
        let runtime_result_path = paths.managed_result_file(&attempt_id);
        let preserved_result_path = paths.preserved_managed_result_file(&job_id, &attempt_id);

        let validated = if runtime_result_path.exists() {
            match read_and_validate_from_file(
                &runtime_result_path,
                &meta.job_id,
                &meta.attempt_id,
                meta.resource_id.as_deref(),
            ) {
                Ok((env, digest)) => {
                    let _ = crate::local_state::atomic_write_json(&preserved_result_path, &env);
                    Some((env, digest))
                }
                Err(_) => None,
            }
        } else if preserved_result_path.exists() {
            read_and_validate_from_file(
                &preserved_result_path,
                &meta.job_id,
                &meta.attempt_id,
                meta.resource_id.as_deref(),
            )
            .ok()
        } else {
            None
        };

        let (envelope, sha256) = match validated {
            Some(v) => v,
            None => continue, // Corrupt or missing result candidate; skip safely
        };

        let client = match ConnectorClient::new(&meta.server_origin) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Consult server state: if server already accepted this exact payload digest,
        // write local receipt marker and avoid re-submitting.
        if let Ok(detail) = client.get_job(&cred, &meta.job_id, false).await {
            if let Some(ref res_meta) = detail.result {
                if res_meta.attempt_id == meta.attempt_id && res_meta.payload_sha256 == sha256 {
                    let receipt = DeliveryReceipt {
                        job_id: meta.job_id.clone(),
                        attempt_id: meta.attempt_id.clone(),
                        payload_sha256: sha256.clone(),
                        delivered_at: chrono::Utc::now().to_rfc3339(),
                        resource_id: Some(res_meta.resource_id.clone()),
                        commit: Some(res_meta.commit.clone()),
                    };
                    let _ = crate::local_state::atomic_write_json(&receipt_path, &receipt);
                    continue;
                }
            }
        }

        // Unresolved candidate: submit smart redelivery to server
        println!(
            "Redelivering managed result for job '{}', attempt '{}'...",
            meta.job_id, meta.attempt_id
        );

        match client
            .submit_job_result(
                &cred,
                &meta.job_id,
                &meta.attempt_id,
                &meta.claim_token,
                &envelope,
                &sha256,
                Some("smart_redelivery"),
            )
            .await
        {
            Ok(resp) => {
                let receipt = DeliveryReceipt {
                    job_id: meta.job_id.clone(),
                    attempt_id: meta.attempt_id.clone(),
                    payload_sha256: sha256,
                    delivered_at: chrono::Utc::now().to_rfc3339(),
                    resource_id: Some(resp.resource_id),
                    commit: Some(resp.commit),
                };
                let _ = crate::local_state::atomic_write_json(&receipt_path, &receipt);
                delivered_count += 1;
            }
            Err(e) => {
                eprintln!(
                    "Failed to redeliver job '{}', attempt '{}': {e}",
                    meta.job_id, meta.attempt_id
                );
            }
        }
    }

    if delivered_count == 0 {
        println!("No pending results to redeliver.");
    } else {
        println!("Smart redelivery completed: {delivered_count} result(s) redelivered.");
    }

    Ok(())
}

/// Explicit redelivery: replays submission even if already delivered.
/// Persists durable local receipt. Never mutates historical execution reports.
pub async fn run_explicit_redeliver(
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

    let runtime_result_path = paths.managed_result_file(&attempt_id);
    let preserved_result_path = paths.preserved_managed_result_file(job_id, &attempt_id);

    let (envelope, sha256) = if runtime_result_path.exists() {
        let (env, digest) = read_and_validate_from_file(
            &runtime_result_path,
            &meta.job_id,
            &meta.attempt_id,
            meta.resource_id.as_deref(),
        )
        .map_err(|e| {
            format!(
                "Invalid runtime managed result in {}: {e}",
                runtime_result_path.display()
            )
        })?;

        crate::local_state::atomic_write_json(&preserved_result_path, &env)
            .map_err(|e| format!("Failed to snapshot runtime result to results storage: {e}"))?;

        (env, digest)
    } else if preserved_result_path.exists() {
        read_and_validate_from_file(
            &preserved_result_path,
            &meta.job_id,
            &meta.attempt_id,
            meta.resource_id.as_deref(),
        )
        .map_err(|e| {
            format!(
                "Invalid preserved managed result in {}: {e}",
                preserved_result_path.display()
            )
        })?
    } else {
        return Err(format!(
            "No managed result available for redelivery for job '{job_id}', attempt '{attempt_id}' (checked {} and {})",
            runtime_result_path.display(),
            preserved_result_path.display()
        ));
    };

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

    // Persist durable delivery receipt
    let receipt = DeliveryReceipt {
        job_id: meta.job_id.clone(),
        attempt_id: meta.attempt_id.clone(),
        payload_sha256: sha256,
        delivered_at: chrono::Utc::now().to_rfc3339(),
        resource_id: Some(resp.resource_id.clone()),
        commit: Some(resp.commit.clone()),
    };
    let receipt_path = receipt_file_path(&results_dir, job_id, &attempt_id);
    let _ = crate::local_state::atomic_write_json(&receipt_path, &receipt);

    println!("Managed result redelivered successfully.");
    println!("  Resource ID: {}", resp.resource_id);
    println!("  Commit:      {}", resp.commit);
    println!("  Server Time: {}", resp.server_time);
    if resp.replayed {
        println!("  Note: Result was replayed (identical digest).");
    }

    Ok(())
}
