use rand::RngCore;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

use crate::client::{ClientError, ConnectorClient, ConnectorTargetProjection};
use crate::config::{ConfigError, LocalConfig};
use crate::credential::{CredentialError, DeviceCredential};
use crate::enrollment::{now_utc_ms, PendingEnrollmentSession};
use crate::local_state::{remove_durable, ExecutionLock};
use crate::outbox::{flush_outbox, OutboxError, OutboxRecord, OUTBOX_SCHEMA_VERSION};
use crate::paths::ConnectorPaths;
use crate::scheduler::{
    ActiveAttempt, ExecutionAdapter, SchedulerError, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use crate::targets::verify_local_repository;

#[derive(Error, Debug)]
pub enum DaemonError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("Scheduler error: {0}")]
    Scheduler(#[from] SchedulerError),
    #[error("Outbox error: {0}")]
    Outbox(#[from] OutboxError),
    #[error("Connector daemon is already running for this profile (daemon.lock held)")]
    AlreadyRunning,
    #[error("Device not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
    #[error("Authentication required: Device credential was revoked or rejected by server")]
    AuthRequired,
    #[error("Active attempt requires execution adapter not present in V1.6 (EXECUTION_ADAPTER_REQUIRED)")]
    ExecutionAdapterRequired,
    #[error("Durable state recovery required: {0} (RECOVERY_REQUIRED)")]
    RecoveryRequired(String),
}

fn generate_claim_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let mut hex = String::with_capacity(64);
    for b in bytes {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

pub async fn run_daemon(
    paths: &ConnectorPaths,
    adapter: Arc<dyn ExecutionAdapter>,
    max_iterations: Option<usize>,
) -> Result<(), DaemonError> {
    paths.ensure_dirs()?;

    // 1. Acquire resident daemon.lock
    let _daemon_lock = match ExecutionLock::acquire(&paths.daemon_lock_file()) {
        Ok(lock) => lock,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(DaemonError::AlreadyRunning)
        }
        Err(e) => return Err(DaemonError::Io(e)),
    };

    println!("Acquired daemon lock. Starting connector recovery sequence...");

    // 2. Load config and credential
    let mut config = LocalConfig::load(&paths.config_file())?
        .ok_or_else(|| DaemonError::RecoveryRequired("Missing config.json".into()))?;

    let cred = DeviceCredential::load(&paths.credential_file())?.ok_or(DaemonError::NotLoggedIn)?;

    let client = ConnectorClient::new(&cred.server_origin)?;

    // 3. Reconcile enrollment & credential coexistence
    if let Ok(Some(sess)) = PendingEnrollmentSession::load(&paths.enrollment_file()) {
        if sess.server_origin == cred.server_origin
            && sess.reserved_device_id == cred.device_id
            && sess.reserved_credential_id == cred.credential_id
        {
            let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
            let _ = remove_durable(&paths.enrollment_file());
        }
    }

    // 4. Verify server identity
    match client.identity(&cred).await {
        Ok(ident) => {
            if ident.device.id != cred.device_id || ident.credential.id != cred.credential_id {
                return Err(DaemonError::RecoveryRequired(format!(
                    "Identity mismatch: server device '{}', credential '{}'",
                    ident.device.id, ident.credential.id
                )));
            }
        }
        Err(ClientError::Unauthorized) => return Err(DaemonError::AuthRequired),
        Err(e) => eprintln!("Warning: server identity probe failed: {}", e),
    }

    // 5. Active Attempt Recovery
    if let Some(mut active) = ActiveAttempt::load(&paths.active_attempt_file())? {
        println!(
            "Recovering in-flight attempt '{}' in phase '{}'...",
            active.attempt_id, active.phase
        );

        // Verify attempt matches current device/server
        if active.server_origin != cred.server_origin || active.device_id != cred.device_id {
            return Err(DaemonError::RecoveryRequired(format!(
                "Active attempt bound to device '{}' / origin '{}', but current credential is '{}' / '{}'",
                active.device_id, active.server_origin, cred.device_id, cred.server_origin
            )));
        }

        match active.phase.as_str() {
            "claim_intent" => {
                // Replay claim with exact same IDs
                match client
                    .claim_job(
                        &cred,
                        &active.job_id,
                        &active.attempt_id,
                        &active.claim_token,
                    )
                    .await
                {
                    Ok(resp) => {
                        // Verify full intent identity
                        if resp.job.job_id != active.job_id
                            || resp.job.workspace_id != active.workspace_id
                            || resp.job.target_id != active.target_id
                            || resp.attempt.attempt_id != active.attempt_id
                        {
                            return Err(DaemonError::RecoveryRequired(
                                "Claim response intent identity mismatch".into(),
                            ));
                        }

                        let payload_hash = ActiveAttempt::compute_payload_sha256(
                            &resp.job.job_id,
                            &resp.job.workspace_id,
                            &resp.job.target_id,
                            resp.job.resource_id.as_deref(),
                            &resp.job.prompt,
                            resp.job.acceptance.as_deref(),
                            resp.job.execution_timeout_seconds,
                            resp.job.result_target.as_deref(),
                        );

                        active.phase = "claimed".into();
                        active.resource_id = resp.job.resource_id;
                        active.prompt = Some(resp.job.prompt);
                        active.acceptance = resp.job.acceptance;
                        active.execution_timeout_seconds = Some(resp.job.execution_timeout_seconds);
                        active.result_target = resp.job.result_target;
                        active.payload_sha256 = Some(payload_hash);
                        active.claimed_at_ms = Some(resp.attempt.claimed_at_ms);

                        let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                        active.save(&paths.active_attempt_file())?;
                        println!("Claim intent successfully reconciled to claimed.");
                    }
                    Err(ClientError::JobError { ref code, .. })
                        if code == "JOB_ALREADY_CLAIMED"
                            || code == "JOB_EXPIRED"
                            || code == "JOB_NOT_FOUND" =>
                    {
                        let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                        remove_durable(&paths.active_attempt_file())?;
                        println!("Job was consumed by another worker or expired. Cleared local claim intent.");
                    }
                    Err(ClientError::JobError {
                        ref code,
                        ref message,
                    }) if code == "IDEMPOTENCY_CONFLICT" => {
                        active.phase = "recovery_required".into();
                        let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                        active.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(format!(
                            "Idempotency conflict: {message}"
                        )));
                    }
                    Err(e) => {
                        eprintln!(
                            "Transport/server error during claim intent recovery: {}. Will retry.",
                            e
                        );
                    }
                }
            }
            "finalized_local" => {
                let hist_file = paths.history_file(&active.job_id, &active.attempt_id);
                let outbox_file = paths.outbox_file(&active.job_id, &active.attempt_id);

                if hist_file.exists() {
                    // Delivery already succeeded, finish active attempt removal
                    let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                    remove_durable(&paths.active_attempt_file())?;
                    println!("Active attempt was already delivered. Completed local active attempt cleanup.");
                } else if outbox_file.exists() {
                    // Flush outbox
                    let _ = flush_outbox(paths, &client, &cred).await;
                } else {
                    return Err(DaemonError::RecoveryRequired(
                        "Attempt in finalized_local but neither outbox record nor history file exists".into(),
                    ));
                }
            }
            "claimed" | "start_intent" | "started" | "dispatch_intent" | "running" => {
                if !adapter.is_ready().await {
                    eprintln!(
                        "Attempt '{}' is held in phase '{}' waiting for execution adapter.",
                        active.attempt_id, active.phase
                    );
                } else {
                    // Test execution adapter flow
                    let target = config.targets.get(&active.target_id).cloned();
                    if let Some(target) = target {
                        match adapter.execute(&active, &target).await {
                            Ok(report_val) => {
                                let mut hasher = Sha256::new();
                                hasher.update(serde_json::to_vec(&report_val).unwrap());
                                let digest = format!("{:x}", hasher.finalize());

                                let outbox_rec = OutboxRecord {
                                    schema_version: OUTBOX_SCHEMA_VERSION,
                                    server_origin: cred.server_origin.clone(),
                                    device_id: cred.device_id.clone(),
                                    job_id: active.job_id.clone(),
                                    attempt_id: active.attempt_id.clone(),
                                    claim_token: active.claim_token.clone(),
                                    report: report_val,
                                    created_at_ms: now_utc_ms(),
                                };

                                let outbox_file =
                                    paths.outbox_file(&active.job_id, &active.attempt_id);
                                outbox_rec.save(&outbox_file)?;

                                active.phase = "finalized_local".into();
                                active.terminal_report_sha256 = Some(digest);
                                active.save(&paths.active_attempt_file())?;

                                let _ = flush_outbox(paths, &client, &cred).await;
                            }
                            Err(e) => {
                                eprintln!("Execution adapter failed: {}", e);
                            }
                        }
                    }
                }
            }
            "recovery_required" => {
                return Err(DaemonError::RecoveryRequired(
                    "Active attempt is marked recovery_required".into(),
                ));
            }
            other => {
                return Err(DaemonError::RecoveryRequired(format!(
                    "Unknown attempt phase '{other}'"
                )));
            }
        }
    }

    // 6. Flush Outbox before entering idle loop
    let _ = flush_outbox(paths, &client, &cred).await;

    println!("Connector daemon entering idle loop...");

    let mut iterations = 0;
    loop {
        if let Some(max) = max_iterations {
            if iterations >= max {
                break;
            }
        }
        iterations += 1;

        // Atomically reload config and control
        if let Some(latest_cfg) = LocalConfig::load(&paths.config_file())? {
            config = latest_cfg;
        }

        let paused = if paths.control_file().exists() {
            if let Ok(content) = fs::read_to_string(paths.control_file()) {
                serde_json::from_str::<serde_json::Value>(&content)
                    .ok()
                    .and_then(|v| v.get("paused").and_then(|p| p.as_bool()))
                    .unwrap_or(false)
            } else {
                false
            }
        } else {
            false
        };

        if paused {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        // Concurrency = 1 guard: if active attempt exists, do not claim new jobs
        if paths.active_attempt_file().exists() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        // Outbox guard: flush outbox before new work
        if paths.outbox_dir().exists() && fs::read_dir(paths.outbox_dir())?.next().is_some() {
            let _ = flush_outbox(paths, &client, &cred).await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        // Fresh Server Target Snapshot query
        let server_targets: Vec<ConnectorTargetProjection> =
            match client.list_targets(&cred, None).await {
                Ok(t) => t,
                Err(ClientError::Unauthorized) => return Err(DaemonError::AuthRequired),
                Err(e) => {
                    eprintln!("Failed to refresh target snapshot: {}. Backing off...", e);
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };

        let mut target_snapshot: std::collections::BTreeMap<String, ConnectorTargetProjection> =
            std::collections::BTreeMap::new();
        for st in server_targets {
            target_snapshot.insert(st.target_id.clone(), st);
        }

        // Query pending jobs
        let pending = match client.pending_jobs(&cred, Some(20)).await {
            Ok(p) => p,
            Err(ClientError::Unauthorized) => return Err(DaemonError::AuthRequired),
            Err(e) => {
                eprintln!("Failed to poll pending jobs: {}. Backing off...", e);
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        // Find eligible candidate
        let mut selected_candidate = None;
        for cand in &pending {
            // 1. Is target mapped in local config?
            let local_t = match config.targets.get(&cand.target_id) {
                Some(t) => t,
                None => continue,
            };

            // 2. Does target exist in fresh Server Target snapshot?
            let server_t = match target_snapshot.get(&cand.target_id) {
                Some(t) => t,
                None => continue,
            };

            // 3. Match workspace and kind
            if server_t.workspace_id != local_t.workspace_id || server_t.kind != local_t.kind {
                continue;
            }

            // 4. Target enabled?
            if server_t.disabled {
                continue;
            }

            // 5. This device binding active?
            if server_t
                .this_device_binding
                .as_ref()
                .map(|b| !b.enabled)
                .unwrap_or(true)
            {
                continue;
            }

            // 6. Local directory exists?
            let local_dir = Path::new(&local_t.local_path);
            if !local_dir.exists() || !local_dir.is_dir() {
                continue;
            }

            // 7. Repository verification if applicable
            if let Some(ref repo) = server_t.repository {
                if verify_local_repository(local_dir, repo).is_err() {
                    continue;
                }
            }

            // 8. Execution adapter readiness check
            if !adapter.is_ready().await {
                // In V1.6 production: adapter is UnavailableExecutionAdapter (is_ready = false).
                // Observe pending job, but DO NOT claim!
                continue;
            }

            selected_candidate = Some(cand.clone());
            break;
        }

        if let Some(cand) = selected_candidate {
            let attempt_id = format!("att-{}", Uuid::new_v4());
            let claim_token = generate_claim_token();

            // Acquire state.lock to serialize candidate selection and claim intent writing
            let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;

            // Revalidate: no active attempt exists and target still mapped
            if paths.active_attempt_file().exists() || !config.targets.contains_key(&cand.target_id)
            {
                continue;
            }

            let attempt = ActiveAttempt {
                schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
                server_origin: cred.server_origin.clone(),
                device_id: cred.device_id.clone(),
                job_id: cand.job_id.clone(),
                workspace_id: cand.workspace_id.clone(),
                target_id: cand.target_id.clone(),
                attempt_id: attempt_id.clone(),
                claim_token: claim_token.clone(),
                phase: "claim_intent".into(),
                resource_id: None,
                prompt: None,
                acceptance: None,
                execution_timeout_seconds: None,
                result_target: None,
                payload_sha256: None,
                claimed_at_ms: None,
                terminal_report_sha256: None,
            };

            // Fsync claim intent BEFORE network call!
            attempt.save(&paths.active_attempt_file())?;
            drop(_lock);

            // Dispatch claim request
            match client
                .claim_job(&cred, &cand.job_id, &attempt_id, &claim_token)
                .await
            {
                Ok(resp) => {
                    // Verify full intent identity
                    if resp.job.job_id != cand.job_id
                        || resp.job.workspace_id != cand.workspace_id
                        || resp.job.target_id != cand.target_id
                        || resp.attempt.attempt_id != attempt_id
                    {
                        eprintln!("Full intent identity mismatch in claim response! Marking recovery_required.");
                        let mut att = ActiveAttempt::load(&paths.active_attempt_file())?.unwrap();
                        att.phase = "recovery_required".into();
                        att.save(&paths.active_attempt_file())?;
                        continue;
                    }

                    let payload_hash = ActiveAttempt::compute_payload_sha256(
                        &resp.job.job_id,
                        &resp.job.workspace_id,
                        &resp.job.target_id,
                        resp.job.resource_id.as_deref(),
                        &resp.job.prompt,
                        resp.job.acceptance.as_deref(),
                        resp.job.execution_timeout_seconds,
                        resp.job.result_target.as_deref(),
                    );

                    let mut att = ActiveAttempt::load(&paths.active_attempt_file())?.unwrap();
                    att.phase = "claimed".into();
                    att.resource_id = resp.job.resource_id;
                    att.prompt = Some(resp.job.prompt);
                    att.acceptance = resp.job.acceptance;
                    att.execution_timeout_seconds = Some(resp.job.execution_timeout_seconds);
                    att.result_target = resp.job.result_target;
                    att.payload_sha256 = Some(payload_hash);
                    att.claimed_at_ms = Some(resp.attempt.claimed_at_ms);

                    let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                    att.save(&paths.active_attempt_file())?;
                    println!(
                        "Successfully claimed job '{}' (attempt '{}').",
                        cand.job_id, attempt_id
                    );
                }
                Err(ClientError::JobError { ref code, .. })
                    if code == "JOB_ALREADY_CLAIMED"
                        || code == "JOB_EXPIRED"
                        || code == "JOB_NOT_FOUND" =>
                {
                    let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                    remove_durable(&paths.active_attempt_file())?;
                }
                Err(ClientError::JobError {
                    ref code,
                    ref message,
                }) if code == "IDEMPOTENCY_CONFLICT" => {
                    let mut att = ActiveAttempt::load(&paths.active_attempt_file())?.unwrap();
                    att.phase = "recovery_required".into();
                    let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                    att.save(&paths.active_attempt_file())?;
                    eprintln!("Idempotency conflict claiming job: {}", message);
                }
                Err(e) => {
                    eprintln!(
                        "Network/server error claiming job '{}': {}. Retaining claim intent.",
                        cand.job_id, e
                    );
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    Ok(())
}
