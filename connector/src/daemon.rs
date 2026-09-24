use rand::RngCore;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

use crate::client::{ClientError, ConnectorClient, ConnectorTargetProjection, PendingJobCandidate};
use crate::config::{load_bound_profile, ConfigError, ProfileError};
use crate::credential::{CredentialError, DeviceCredential};
use crate::enrollment::{now_utc_ms, PendingEnrollmentSession};
use crate::local_state::{remove_durable, ExecutionLock};
use crate::outbox::{
    compute_report_sha256, flush_outbox, OutboxError, OutboxRecord, OUTBOX_SCHEMA_VERSION,
};
use crate::paths::ConnectorPaths;
use crate::scheduler::{
    ActiveAttempt, AttemptPhase, ExecutionAdapter, SchedulerError, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use crate::targets::verify_local_repository;

#[derive(Error, Debug)]
pub enum DaemonError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
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
    #[error("Local credential server mismatch: config origin is '{expected}', but credential origin is '{actual}' (LOCAL_CREDENTIAL_SERVER_MISMATCH)")]
    LocalCredentialServerMismatch { expected: String, actual: String },
    #[error("Active attempt requires execution adapter not present in V1.6 (EXECUTION_ADAPTER_REQUIRED)")]
    ExecutionAdapterRequired,
    #[error("Durable state recovery required: {0} (RECOVERY_REQUIRED)")]
    RecoveryRequired(String),
}

use std::future::Future;
use std::pin::Pin;

pub type DaemonAsyncHook<T> =
    Arc<dyn Fn(&T) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

#[derive(Default, Clone)]
pub struct DaemonHooks {
    pub after_candidate_selected: Option<DaemonAsyncHook<PendingJobCandidate>>,
    pub after_claim_intent_persisted: Option<DaemonAsyncHook<ActiveAttempt>>,
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

fn parse_iso_or_millis(s: &str) -> Option<i64> {
    if let Ok(ts) = s.parse::<i64>() {
        return Some(ts);
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.timestamp_millis())
        .ok()
        .or_else(|| Some(chrono::Utc::now().timestamp_millis()))
}

pub async fn run_daemon(
    paths: &ConnectorPaths,
    adapter: Arc<dyn ExecutionAdapter>,
    max_iterations: Option<usize>,
) -> Result<(), DaemonError> {
    run_daemon_with_hooks(paths, adapter, max_iterations, DaemonHooks::default()).await
}

pub async fn run_daemon_with_hooks(
    paths: &ConnectorPaths,
    adapter: Arc<dyn ExecutionAdapter>,
    max_iterations: Option<usize>,
    hooks: DaemonHooks,
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

    // 2. Load bound profile (enforcing config.server_url == credential.server_origin)
    let profile = load_bound_profile(paths).map_err(|e| match e {
        ProfileError::NotLoggedIn => DaemonError::NotLoggedIn,
        ProfileError::LocalCredentialServerMismatch { expected, actual } => {
            DaemonError::LocalCredentialServerMismatch { expected, actual }
        }
        other => DaemonError::RecoveryRequired(other.to_string()),
    })?;

    let mut config = profile.config;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;

    // 3. Reconcile enrollment & credential coexistence
    if let Ok(Some(sess)) = PendingEnrollmentSession::load(&paths.enrollment_file()) {
        if sess.server_origin == cred.server_origin
            && sess.reserved_device_id == cred.device_id
            && sess.reserved_credential_id == cred.credential_id
        {
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
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
            "Recovering in-flight attempt '{}' in phase '{:?}'...",
            active.attempt_id, active.phase
        );

        // Verify attempt matches current device/server
        if active.server_origin != cred.server_origin || active.device_id != cred.device_id {
            return Err(DaemonError::RecoveryRequired(format!(
                "Active attempt bound to device '{}' / origin '{}', but current credential is '{}' / '{}'",
                active.device_id, active.server_origin, cred.device_id, cred.server_origin
            )));
        }

        match active.phase {
            AttemptPhase::ClaimIntent => {
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
                        {
                            active.phase = AttemptPhase::RecoveryRequired;
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            active.save(&paths.active_attempt_file())?;
                            return Err(DaemonError::RecoveryRequired(
                                "Server claimed job payload mismatch with local intent".into(),
                            ));
                        }

                        let payload_hash = ActiveAttempt::compute_payload_sha256(
                            &resp.job.job_id,
                            &resp.job.workspace_id,
                            &resp.job.target_id,
                            resp.job.resource_id.as_deref(),
                            &resp.job.prompt,
                            &resp.job.acceptance,
                            resp.job.timeout_seconds,
                            &resp.job.result_target,
                        );

                        active.phase = AttemptPhase::Claimed;
                        active.resource_id = resp.job.resource_id;
                        active.prompt = Some(resp.job.prompt);
                        active.acceptance = Some(resp.job.acceptance);
                        active.execution_timeout_seconds = Some(resp.job.timeout_seconds);
                        active.result_target = Some(resp.job.result_target);
                        active.payload_sha256 = Some(payload_hash);
                        active.claimed_at_ms = parse_iso_or_millis(&resp.attempt.claimed_at);

                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        active.save(&paths.active_attempt_file())?;
                        println!("Claim intent successfully reconciled to claimed.");
                    }
                    Err(ClientError::JobError { ref code, .. })
                        if code == "JOB_ALREADY_CLAIMED"
                            || code == "JOB_EXPIRED"
                            || code == "JOB_NOT_FOUND" =>
                    {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        remove_durable(&paths.active_attempt_file())?;
                        println!("Job was consumed by another worker or expired. Cleared local claim intent.");
                    }
                    Err(ClientError::JobError {
                        ref code,
                        ref message,
                    }) if code == "IDEMPOTENCY_CONFLICT" => {
                        active.phase = AttemptPhase::RecoveryRequired;
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
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
            AttemptPhase::FinalizedLocal => {
                // Item 19: Startup finalized_local recovery must prove correlation
                let hist_file = paths.history_file(&active.job_id, &active.attempt_id);
                let outbox_file = paths.outbox_file(&active.job_id, &active.attempt_id);

                if hist_file.exists() {
                    let hist_content = fs::read_to_string(&hist_file)?;
                    let hist: crate::outbox::SanitizedHistoryRecord =
                        serde_json::from_str(&hist_content)?;
                    if hist.job_id == active.job_id
                        && hist.attempt_id == active.attempt_id
                        && hist.target_id == active.target_id
                        && Some(&hist.terminal_report_sha256)
                            == active.terminal_report_sha256.as_ref()
                    {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        remove_durable(&paths.active_attempt_file())?;
                        println!("Active attempt was already delivered. Completed local active attempt cleanup.");
                    } else {
                        return Err(DaemonError::RecoveryRequired(
                            "History record does not match active attempt correlation".into(),
                        ));
                    }
                } else if outbox_file.exists() {
                    let outbox = OutboxRecord::load(&outbox_file).map_err(|e| {
                        DaemonError::RecoveryRequired(format!("failed to load outbox: {e}"))
                    })?;
                    let digest = compute_report_sha256(&outbox.report);
                    if outbox.job_id == active.job_id
                        && outbox.attempt_id == active.attempt_id
                        && Some(&digest) == active.terminal_report_sha256.as_ref()
                    {
                        let _ = flush_outbox(paths, &client, &cred).await;
                    } else {
                        return Err(DaemonError::RecoveryRequired(
                            "Outbox record does not match active attempt correlation".into(),
                        ));
                    }
                } else {
                    return Err(DaemonError::RecoveryRequired(
                        "Attempt in finalized_local but neither valid history nor outbox file exists".into(),
                    ));
                }
            }
            AttemptPhase::Claimed
            | AttemptPhase::StartIntent
            | AttemptPhase::Started
            | AttemptPhase::Running => {
                if !adapter.is_ready().await {
                    eprintln!(
                        "Attempt '{}' is held in phase '{:?}' waiting for execution adapter.",
                        active.attempt_id, active.phase
                    );
                } else {
                    let target = config.targets.get(&active.target_id).cloned();
                    if let Some(target) = target {
                        match adapter.execute(&active, &target).await {
                            Ok(report) => {
                                let digest = compute_report_sha256(&report);

                                let outbox_rec = OutboxRecord {
                                    schema_version: OUTBOX_SCHEMA_VERSION,
                                    server_origin: cred.server_origin.clone(),
                                    device_id: cred.device_id.clone(),
                                    job_id: active.job_id.clone(),
                                    attempt_id: active.attempt_id.clone(),
                                    claim_token: active.claim_token.clone(),
                                    report,
                                    created_at_ms: now_utc_ms(),
                                };

                                let outbox_file =
                                    paths.outbox_file(&active.job_id, &active.attempt_id);
                                outbox_rec
                                    .save(&outbox_file)
                                    .map_err(|e| DaemonError::RecoveryRequired(e.to_string()))?;

                                active.phase = AttemptPhase::FinalizedLocal;
                                active.terminal_report_sha256 = Some(digest);

                                let _lock = ExecutionLock::acquire_with_retry(
                                    &paths.state_lock_file(),
                                    Duration::from_secs(5),
                                    Duration::from_millis(50),
                                )?;
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
            AttemptPhase::RecoveryRequired => {
                return Err(DaemonError::RecoveryRequired(
                    "Active attempt is in recovery_required phase".into(),
                ));
            }
        }
    }

    // 6. Outbox Recovery
    let _ = flush_outbox(paths, &client, &cred).await;

    println!("Connector recovery complete. Entering main polling loop.");

    // 7. Main Polling Loop
    let mut iteration_count = 0;
    loop {
        if let Some(max) = max_iterations {
            if iteration_count >= max {
                println!(
                    "Reached maximum iterations ({}). Daemon exiting cleanly.",
                    max
                );
                return Ok(());
            }
        }
        iteration_count += 1;

        // Check if paused via control.json
        let paused = if paths.control_file().exists() {
            fs::read_to_string(paths.control_file())
                .ok()
                .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                .and_then(|v| v.get("paused").and_then(|p| p.as_bool()))
                .unwrap_or(false)
        } else {
            false
        };

        if paused {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        // Concurrency = 1 guard: if active attempt or outbox records exist, do not query pending!
        if paths.active_attempt_file().exists() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }

        let has_outbox = paths.outbox_dir().exists()
            && fs::read_dir(paths.outbox_dir())
                .map(|mut d| d.next().is_some())
                .unwrap_or(false);
        if has_outbox {
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

        // Refresh local config
        if let Ok(Some(refreshed_config)) = crate::config::LocalConfig::load(&paths.config_file()) {
            config = refreshed_config;
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
            if let Some(ref hook) = hooks.after_candidate_selected {
                hook(&cand).await;
            }

            let attempt_id = format!("att-{}", Uuid::new_v4());
            let claim_token = generate_claim_token();

            // Acquire state.lock with bounded retry (Item 12)
            let _lock = match ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(3),
                Duration::from_millis(50),
            ) {
                Ok(l) => l,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    eprintln!("State lock busy during candidate claim preparation. Retrying...");
                    continue;
                }
                Err(e) => return Err(DaemonError::Io(e)),
            };

            // Reload from disk (Item 9):
            let disk_cred = DeviceCredential::load(&paths.credential_file())?;
            let disk_config = crate::config::LocalConfig::load(&paths.config_file())?;
            let disk_active = ActiveAttempt::load(&paths.active_attempt_file())?;
            let disk_paused = if paths.control_file().exists() {
                fs::read_to_string(paths.control_file())
                    .ok()
                    .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
                    .and_then(|v| v.get("paused").and_then(|p| p.as_bool()))
                    .unwrap_or(false)
            } else {
                false
            };

            // Require credential still exists (Item 10)
            let disk_cred = match disk_cred {
                Some(c) => c,
                None => {
                    // Credential missing (logout occurred!)
                    return Err(DaemonError::AuthRequired);
                }
            };

            if disk_cred.device_id != cred.device_id
                || disk_cred.server_origin != cred.server_origin
            {
                return Err(DaemonError::AuthRequired);
            }

            let disk_config = match disk_config {
                Some(cfg) => cfg,
                None => continue,
            };

            let normalized_config_origin =
                crate::config::normalize_server_origin(&disk_config.server_url).map_err(|_e| {
                    DaemonError::LocalCredentialServerMismatch {
                        expected: disk_config.server_url.clone(),
                        actual: disk_cred.server_origin.clone(),
                    }
                })?;

            if normalized_config_origin != disk_cred.server_origin {
                return Err(DaemonError::LocalCredentialServerMismatch {
                    expected: normalized_config_origin,
                    actual: disk_cred.server_origin.clone(),
                });
            }

            if disk_paused {
                continue;
            }

            if disk_active.is_some() {
                continue;
            }

            // Require candidate target still locally mapped (Item 11)
            if !disk_config.targets.contains_key(&cand.target_id) {
                continue;
            }

            let attempt = ActiveAttempt {
                schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
                server_origin: disk_cred.server_origin.clone(),
                device_id: disk_cred.device_id.clone(),
                job_id: cand.job_id.clone(),
                workspace_id: cand.workspace_id.clone(),
                target_id: cand.target_id.clone(),
                attempt_id: attempt_id.clone(),
                claim_token: claim_token.clone(),
                phase: AttemptPhase::ClaimIntent,
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

            if let Some(ref hook) = hooks.after_claim_intent_persisted {
                hook(&attempt).await;
            }

            // Dispatch claim request
            match client
                .claim_job(&cred, &cand.job_id, &attempt_id, &claim_token)
                .await
            {
                Ok(resp) => {
                    let payload_hash = ActiveAttempt::compute_payload_sha256(
                        &resp.job.job_id,
                        &resp.job.workspace_id,
                        &resp.job.target_id,
                        resp.job.resource_id.as_deref(),
                        &resp.job.prompt,
                        &resp.job.acceptance,
                        resp.job.timeout_seconds,
                        &resp.job.result_target,
                    );

                    let mut att = attempt;
                    att.phase = AttemptPhase::Claimed;
                    att.resource_id = resp.job.resource_id;
                    att.prompt = Some(resp.job.prompt);
                    att.acceptance = Some(resp.job.acceptance);
                    att.execution_timeout_seconds = Some(resp.job.timeout_seconds);
                    att.result_target = Some(resp.job.result_target);
                    att.payload_sha256 = Some(payload_hash);
                    att.claimed_at_ms = parse_iso_or_millis(&resp.attempt.claimed_at);

                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    att.save(&paths.active_attempt_file())?;
                    println!(
                        "Successfully claimed job '{}'. Attempt '{}' now in phase 'claimed'.",
                        cand.job_id, att.attempt_id
                    );
                }
                Err(ClientError::JobError { ref code, .. })
                    if code == "JOB_ALREADY_CLAIMED"
                        || code == "JOB_EXPIRED"
                        || code == "JOB_NOT_FOUND" =>
                {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    remove_durable(&paths.active_attempt_file())?;
                    println!(
                        "Candidate job was claimed by another worker or expired. Cleared local claim intent."
                    );
                }
                Err(ClientError::JobError {
                    ref code,
                    ref message,
                }) if code == "IDEMPOTENCY_CONFLICT" => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut att = attempt;
                    att.phase = AttemptPhase::RecoveryRequired;
                    att.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(format!(
                        "Idempotency conflict: {message}"
                    )));
                }
                Err(ClientError::Unauthorized) => return Err(DaemonError::AuthRequired),
                Err(e) => {
                    eprintln!("Failed to claim job: {}. Intent remains for replay.", e);
                }
            }
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
