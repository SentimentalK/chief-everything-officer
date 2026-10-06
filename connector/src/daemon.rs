use rand::RngCore;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

use crate::attempt_convergence::FinalizeLocalOperatorCancelledError;
use crate::client::{ClientError, ConnectorClient, ConnectorTargetProjection, PendingJobCandidate};
use crate::config::{load_bound_profile, ConfigError, ProfileError};
use crate::credential::{CredentialError, DeviceCredential};
use crate::enrollment::{now_utc_ms, PendingEnrollmentSession};
use crate::execution_contract::{
    BusinessOutcome, ExecutionReport, ExecutionReportError, ExecutionReportExecutor,
    ExecutionStatus, REPORT_SCHEMA_VERSION,
};
use crate::local_state::{remove_durable, ExecutionLock};
use crate::orca::receipt::ExecutionReceipt;
use crate::outbox::{
    compute_report_sha256, deliver_outbox_record, flush_outbox, flushable_outbox_files,
    OutboxError, OutboxRecord, OUTBOX_SCHEMA_VERSION,
};
use crate::paths::ConnectorPaths;
use crate::scheduler::{
    parse_timestamp_strict, validate_claim_response, ActiveAttempt, AttemptPhase, ExecutionAdapter,
    SchedulerError, ACTIVE_ATTEMPT_SCHEMA_VERSION,
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
    run_daemon_with_hooks_and_admission_orca(
        paths,
        adapter,
        max_iterations,
        hooks,
        crate::orca::client::OrcaCliClient::default(),
    )
    .await
}

/// Like [`run_daemon_with_hooks`], but takes the Orca CLI client used for the
/// shared per-Target execution admission preflight. Production uses the
/// default Orca discovery; tests inject a deterministic probe.
pub async fn run_daemon_with_hooks_and_admission_orca(
    paths: &ConnectorPaths,
    adapter: Arc<dyn ExecutionAdapter>,
    max_iterations: Option<usize>,
    hooks: DaemonHooks,
    admission_orca: crate::orca::client::OrcaCliClient,
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

    // Shared per-Target execution admission probe (PROJECT-039 slice): the
    // daemon probes the installed Orca launch surface independently of the
    // execution adapter so incompatible executor configs are filtered before
    // any ClaimIntent persistence or Server claim request.
    let admission_probe = admission_orca;

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
    if paths.active_attempt_file().exists() {
        let _ = drive_active_attempt(paths, &client, &cred, &adapter, &hooks).await?;
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

        // Concurrency = 1 guard: if active attempt exists, advance it!
        if paths.active_attempt_file().exists() {
            let _ = drive_active_attempt(paths, &client, &cred, &adapter, &hooks).await?;
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }

        // Real durable outbox records are flushed before claiming new Jobs.
        // Gating is based ONLY on actual flushable outbox records using the
        // exact same selection semantics as flush_outbox(); non-JSON entries
        // (backups, editor temp files, directories) must never starve
        // pending-job polling.
        let has_outbox = flushable_outbox_files(paths)
            .map(|records| !records.is_empty())
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
        let mut selected_candidate_frozen_agent_id: Option<String> = None;
        // Orca Agent-aware launch-surface capability snapshot for this
        // pending batch. Probing is deferred until a candidate actually
        // needs it (logical-only executor) and always happens OUTSIDE any
        // state.lock scope; the snapshot is immutable for the rest of the
        // iteration. A stale/unavailable snapshot is conservatively safe:
        // an affected Job simply stays queued for a later poll, and the
        // prepare/recovery path remains the final fail-closed backstop.
        let mut launch_surface = crate::execution_admission::AgentLaunchSurface::Unknown;
        let mut launch_surface_probed = false;
        for cand in &pending {
            // 1. Is target mapped in local config with configured executor?
            let local_t = match config.targets.get(&cand.target_id) {
                Some(t) if t.executor.is_some() => t,
                _ => continue,
            };

            // 2. Does target exist in fresh Server Target snapshot?
            let server_t = match target_snapshot.get(&cand.target_id) {
                Some(t) => t,
                None => continue,
            };

            // The Server snapshot is the sole authority for workspace
            // membership/kind/binding/disabled state (schema v3 local config
            // stores none of it); no local-vs-server metadata comparison is
            // needed or possible.

            // 3. Target enabled?
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

            // 9. Local execution admission preflight (shared policy with Doctor):
            // a Project whose executor/runtime configuration cannot be launched
            // on this Device is NOT claimable. Skip it and keep scanning the
            // pending batch so a later compatible candidate is never starved.
            //
            // Lock-boundary invariant: the Orca launch-surface probe performs
            // external Orca CLI process I/O, so it is awaited HERE — during
            // candidate scanning, before any state.lock acquisition — and the
            // resulting immutable snapshot is reused below by the purely local
            // re-check under the lock. state.lock is never held across
            // external I/O.
            if !launch_surface_probed
                && local_t
                    .executor
                    .as_ref()
                    .map(|e| e.command.is_none())
                    .unwrap_or(false)
            {
                launch_surface = if admission_probe.supports_agent_session_launch().await {
                    crate::execution_admission::AgentLaunchSurface::Available
                } else {
                    crate::execution_admission::AgentLaunchSurface::Unavailable
                };
                launch_surface_probed = true;
            }
            if let Err(incompat) =
                crate::execution_admission::evaluate_executor_compatibility_with_surface(
                    local_t.executor.as_ref(),
                    launch_surface,
                )
            {
                eprintln!(
                    "Skipping candidate for target '{}' (not locally launchable: {})",
                    cand.target_id, incompat
                );
                continue;
            }

            let mut candidate_frozen_agent_id = None;
            if let Some(exec) = local_t.executor.as_ref() {
                if exec.command.is_none() && crate::config::is_default_agent_policy(&exec.agent_id)
                {
                    match crate::orca::default_agent::resolve_default_agent(&admission_probe).await
                    {
                        crate::orca::default_agent::DefaultAgentResolution::Resolved(concrete) => {
                            candidate_frozen_agent_id = Some(concrete);
                        }
                        other => {
                            eprintln!(
                                "Skipping candidate for target '{}' (default Agent policy unresolved: {:?}). Leaving Server Job queued.",
                                cand.target_id, other
                            );
                            continue;
                        }
                    }
                }
            }

            selected_candidate = Some(cand.clone());
            selected_candidate_frozen_agent_id = candidate_frozen_agent_id;
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
            let disk_target = match disk_config.targets.get(&cand.target_id) {
                Some(t) => t,
                None => continue,
            };

            // Re-evaluate execution admission against the config reloaded
            // under the state lock, immediately before ClaimIntent
            // persistence and any Server claim request (PROJECT-039 slice).
            // This re-check is PURELY LOCAL (no `.await`, no Orca CLI
            // process, no network/adapter call): the launch-surface
            // snapshot was probed before the lock was acquired, and the
            // freshly reloaded executor config below is authoritative for
            // compatibility, so a late config change cannot bypass
            // admission. An incompatibility here leaves the Server Job
            // queued: no claim intent is persisted, no claim request is
            // made, and the Job is neither cancelled nor terminalized.
            if let Err(incompat) =
                crate::execution_admission::evaluate_executor_compatibility_with_surface(
                    disk_target.executor.as_ref(),
                    launch_surface,
                )
            {
                eprintln!(
                    "Candidate target '{}' became not locally launchable under state lock ({}). Leaving Server Job queued.",
                    cand.target_id, incompat
                );
                continue;
            }

            let disk_executor = disk_target.executor.as_ref();
            let frozen_agent_id: Option<String>;

            match disk_executor {
                Some(exec)
                    if exec.command.is_none()
                        && crate::config::is_default_agent_policy(&exec.agent_id) =>
                {
                    match selected_candidate_frozen_agent_id {
                        Some(ref concrete) => {
                            frozen_agent_id = Some(concrete.clone());
                        }
                        None => {
                            eprintln!(
                                "Candidate target '{}' changed to default Agent policy under state lock without pre-resolved concrete Agent. Leaving Server Job queued.",
                                cand.target_id
                            );
                            continue;
                        }
                    }
                }
                Some(exec) if exec.command.is_none() => {
                    // Reloaded executor became an explicit concrete Agent
                    frozen_agent_id = None;
                }
                _ => {
                    // Explicit command or no executor
                    frozen_agent_id = None;
                }
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
                frozen_agent_id,
                executor: None,
            };

            // Fsync claim intent BEFORE network call!
            attempt.save(&paths.active_attempt_file())?;
            drop(_lock);

            if let Some(ref hook) = hooks.after_claim_intent_persisted {
                hook(&attempt).await;
            }

            // Immediately drive the claim intent to network claim and execution
            let _ = drive_active_attempt(paths, &client, &cred, &adapter, &hooks).await?;
        }

        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

/// Terminalizes a local active attempt as operator-cancelled (Wave 2B).
///
/// Thin delegation to the shared owner (`crate::attempt_convergence`); the
/// daemon must never keep a separate finalization truth table.
fn finalize_local_operator_cancelled(
    paths: &ConnectorPaths,
    active: &ActiveAttempt,
) -> Result<(), DaemonError> {
    crate::attempt_convergence::finalize_local_operator_cancelled(paths, active).map_err(|err| {
        match err {
            FinalizeLocalOperatorCancelledError::Io(e) => DaemonError::Io(e),
            FinalizeLocalOperatorCancelledError::State(e) => DaemonError::Scheduler(e),
        }
    })
}

pub fn build_attempt_execution_prompt(paths: &ConnectorPaths, attempt: &ActiveAttempt) -> String {
    let managed_contract = if attempt.result_target.as_deref() == Some("resource") {
        Some(crate::execution_contract::ManagedContract {
            path: paths.managed_result_file(&attempt.attempt_id),
            job_id: attempt.job_id.clone(),
            attempt_id: attempt.attempt_id.clone(),
            resource_id: attempt.resource_id.clone().unwrap_or_default(),
        })
    } else {
        None
    };
    crate::execution_contract::build_execution_prompt(
        attempt.prompt.as_deref(),
        attempt.acceptance.as_deref(),
        managed_contract.as_ref(),
    )
}

pub async fn drive_active_attempt(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    cred: &DeviceCredential,
    adapter: &Arc<dyn ExecutionAdapter>,
    _hooks: &DaemonHooks,
) -> Result<bool, DaemonError> {
    let active_opt = ActiveAttempt::load(&paths.active_attempt_file())?;
    let active = match active_opt {
        Some(a) => a,
        None => return Ok(false),
    };

    if active.device_id != cred.device_id || active.server_origin != cred.server_origin {
        return Err(DaemonError::RecoveryRequired(format!(
            "Active attempt identity mismatch: expected server '{}' / device '{}', but got '{}' / '{}'",
            cred.server_origin, cred.device_id, active.server_origin, active.device_id
        )));
    }

    match active.phase {
        AttemptPhase::ClaimIntent => {
            // Replay claim intent
            match client
                .claim_job(
                    cred,
                    &active.job_id,
                    &active.attempt_id,
                    &active.claim_token,
                )
                .await
            {
                Ok(resp) => {
                    if let Err(e) = validate_claim_response(&active, &resp) {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        current.phase = AttemptPhase::RecoveryRequired;
                        current.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(format!(
                            "Claim replay correlation validation failed: {e}"
                        )));
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
                    let claimed_at_ms = parse_timestamp_strict(&resp.attempt.claimed_at)
                        .map_err(DaemonError::RecoveryRequired)?;

                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.resource_id = resp.job.resource_id;
                    current.prompt = Some(resp.job.prompt);
                    current.acceptance = Some(resp.job.acceptance);
                    current.execution_timeout_seconds = Some(resp.job.timeout_seconds);
                    current.result_target = Some(resp.job.result_target);
                    current.payload_sha256 = Some(payload_hash);
                    current.claimed_at_ms = Some(claimed_at_ms);

                    // For resource jobs: persist redelivery authority BEFORE committing phase = Claimed
                    crate::managed_result::durable_persist_redelivery_meta(paths, cred, &current)?;

                    current.phase = AttemptPhase::Claimed;
                    current.save(&paths.active_attempt_file())?;
                    println!("Claim intent successfully reconciled to claimed.");
                    Ok(true)
                }
                Err(ClientError::JobError { ref code, .. })
                    if code == "JOB_ALREADY_CLAIMED"
                        || code == "JOB_EXPIRED"
                        || code == "JOB_FINISHED"
                        || code == "JOB_NOT_FOUND" =>
                {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    remove_durable(&paths.active_attempt_file())?;
                    println!("Job was consumed by another worker, expired, or operator-cancelled. Cleared local claim intent.");
                    Ok(false)
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
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    Err(DaemonError::RecoveryRequired(format!(
                        "Idempotency conflict: {message}"
                    )))
                }
                Err(e) => {
                    eprintln!(
                        "Transport/server error during claim intent recovery: {}. Will retry.",
                        e
                    );
                    Ok(true)
                }
            }
        }
        AttemptPhase::Claimed => {
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            current.phase = AttemptPhase::PrepareIntent;
            current.save(&paths.active_attempt_file())?;
            Ok(true)
        }
        AttemptPhase::StartIntent => {
            match client
                .start_job(
                    cred,
                    &active.job_id,
                    &active.attempt_id,
                    &active.claim_token,
                )
                .await
            {
                Ok(ack) => {
                    let server_time_valid = parse_timestamp_strict(&ack.server_time).is_ok();
                    if !ack.ok || !server_time_valid {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        current.phase = AttemptPhase::RecoveryRequired;
                        current.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(
                            "Start job response reported ok=false or invalid server_time".into(),
                        ));
                    }

                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::Started;
                    current.save(&paths.active_attempt_file())?;
                    println!("Notified server of start for job '{}'", active.job_id);
                    Ok(true)
                }
                Err(ClientError::JobError {
                    ref code,
                    ref message,
                }) if code == "JOB_NOT_FOUND"
                    || code == "ATTEMPT_NOT_FOUND"
                    || code == "JOB_NOT_ACTIVE"
                    || code == "IDENTITY_MISMATCH"
                    || code == "CORRUPT_ATTEMPT_RECORD"
                    || code == "INVALID_ATTEMPT_PHASE"
                    || code == "IDEMPOTENCY_CONFLICT"
                    || code == "ATTEMPT_MISMATCH"
                    || code == "JOB_NOT_CLAIMED" =>
                {
                    // Operator-cancel precedence (Wave 2B): if the server has
                    // authoritatively terminalized this job as CANCELLED, honor
                    // it locally instead of entering recovery churn.
                    if code == "JOB_NOT_ACTIVE"
                        || code == "INVALID_ATTEMPT_PHASE"
                        || code == "ATTEMPT_MISMATCH"
                        || code == "ATTEMPT_NOT_FOUND"
                    {
                        if let Ok(detail) = client.get_job(cred, &active.job_id, false).await {
                            if detail.state == "terminal"
                                && detail.execution_status.as_deref() == Some("CANCELLED")
                            {
                                finalize_local_operator_cancelled(paths, &active)?;
                                println!(
                                    "Job '{}' was operator-cancelled; local attempt terminalized as cancelled.",
                                    active.job_id
                                );
                                return Ok(true);
                            }
                        }
                    }
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    Err(DaemonError::RecoveryRequired(format!(
                        "Start job failed closed: {message}"
                    )))
                }
                Err(ClientError::Unauthorized) => Err(DaemonError::AuthRequired),
                Err(e) => {
                    eprintln!("Failed to notify server of start: {e}. Retrying on next loop.");
                    Ok(true)
                }
            }
        }
        AttemptPhase::Started => {
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            current.phase = AttemptPhase::Waiting;
            current.save(&paths.active_attempt_file())?;
            Ok(true)
        }
        AttemptPhase::PrepareIntent => {
            if !adapter.is_ready().await {
                eprintln!("Execution adapter not ready. Waiting...");
                return Ok(true);
            }

            let disk_config = crate::config::LocalConfig::load(&paths.config_file())?;
            let target = match disk_config
                .as_ref()
                .and_then(|c| c.targets.get(&active.target_id))
            {
                Some(t) => t.clone(),
                None => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(format!(
                        "Target '{}' no longer mapped locally",
                        active.target_id
                    )));
                }
            };

            let is_logical_agent = target
                .executor
                .as_ref()
                .map(|e| e.command.is_none())
                .unwrap_or(true);

            let now = now_utc_ms();
            let timeout_seconds = active.execution_timeout_seconds.unwrap_or(600);

            if is_logical_agent {
                let _lock = ExecutionLock::acquire_with_retry(
                    &paths.state_lock_file(),
                    Duration::from_secs(5),
                    Duration::from_millis(50),
                )?;
                let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                    Some(c) if c.attempt_id == active.attempt_id => c,
                    _ => return Ok(true),
                };
                let exec = current
                    .executor
                    .get_or_insert_with(crate::scheduler::AttemptExecutorState::new_orca);
                if exec.dispatch_started_at_ms.is_none() {
                    exec.dispatch_started_at_ms = Some(now);
                }
                if exec.execution_deadline_ms.is_none() {
                    exec.execution_deadline_ms = Some(now + timeout_seconds as i64 * 1000);
                }
                if let Some(deadline) = exec.execution_deadline_ms {
                    if now >= deadline {
                        current.phase = AttemptPhase::RecoveryRequired;
                        current.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(
                            "WORKER_START_RECONCILIATION_DEADLINE: attempt exceeded execution deadline during worker-start prepare reconciliation".into(),
                        ));
                    }
                }
                current.save(&paths.active_attempt_file())?;
            }

            let execution_prompt = build_attempt_execution_prompt(paths, &active);

            match adapter.prepare(&active, &target, &execution_prompt).await {
                Ok(crate::scheduler::PrepareOutcome::Ready(prep)) => {
                    paths.ensure_attempt_runtime_dir(&active.attempt_id)?;
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    let exec = current
                        .executor
                        .get_or_insert_with(crate::scheduler::AttemptExecutorState::new_orca);

                    exec.orca_version = Some(prep.orca_version);
                    exec.worktree_id = Some(prep.worktree_id);
                    exec.terminal_id = Some(prep.terminal_id);
                    exec.agent_id = Some(prep.agent_id);
                    exec.agent_ready_at_ms = prep.agent_ready_at_ms;

                    if let Some(dispatch_evidence) = prep.dispatch {
                        exec.dispatch_request_id = Some(dispatch_evidence.request_id);
                        exec.dispatch_accepted_at_ms = Some(dispatch_evidence.accepted_at_ms);
                        exec.dispatch_turn_started = dispatch_evidence.turn_started;
                        exec.turn_started_observed = dispatch_evidence.turn_started;
                        current.phase = AttemptPhase::StartIntent;
                        current.save(&paths.active_attempt_file())?;
                        println!(
                            "Attempt '{}' prepared and dispatched via worker-start. Advanced to StartIntent.",
                            active.attempt_id
                        );
                    } else {
                        current.phase = AttemptPhase::Prepared;
                        current.save(&paths.active_attempt_file())?;
                        println!(
                            "Attempt '{}' prepared with worktree and agent terminal.",
                            active.attempt_id
                        );
                    }
                    Ok(true)
                }
                Ok(crate::scheduler::PrepareOutcome::Retryable { execution, reason }) => {
                    if let Some(ident) = execution {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        let exec = current
                            .executor
                            .get_or_insert_with(crate::scheduler::AttemptExecutorState::new_orca);
                        exec.orca_version = Some(ident.orca_version);
                        exec.worktree_id = Some(ident.worktree_id);
                        exec.terminal_id = Some(ident.terminal_id);
                        exec.agent_id = Some(ident.agent_id);
                        current.save(&paths.active_attempt_file())?;
                    }
                    eprintln!("Execution prepare retryable: {reason}. Retrying next loop.");
                    Ok(true)
                }
                Ok(crate::scheduler::PrepareOutcome::NotReady { execution, reason }) => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    let exec = current
                        .executor
                        .get_or_insert_with(crate::scheduler::AttemptExecutorState::new_orca);
                    exec.orca_version = Some(execution.orca_version);
                    exec.worktree_id = Some(execution.worktree_id);
                    exec.terminal_id = Some(execution.terminal_id);
                    exec.agent_id = Some(execution.agent_id);
                    exec.runtime_completion_kind = Some("not_started".into());
                    exec.runtime_completed_at_ms = Some(now_utc_ms());
                    exec.runtime_error = Some(ExecutionReportError {
                        stage: "prepare".into(),
                        code: "AGENT_NOT_READY".into(),
                        message: reason,
                    });
                    current.phase = AttemptPhase::OutcomeRecorded;
                    current.save(&paths.active_attempt_file())?;
                    println!(
                        "Agent failed readiness gate for attempt '{}'. Advanced to OutcomeRecorded for verified cleanup.",
                        active.attempt_id
                    );
                    Ok(true)
                }
                Ok(crate::scheduler::PrepareOutcome::RecoveryRequired { execution, reason }) => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    if let Some(ident) = execution {
                        let exec = current
                            .executor
                            .get_or_insert_with(crate::scheduler::AttemptExecutorState::new_orca);
                        exec.orca_version = Some(ident.orca_version);
                        exec.worktree_id = Some(ident.worktree_id);
                        exec.terminal_id = Some(ident.terminal_id);
                        exec.agent_id = Some(ident.agent_id);
                    }
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    Err(DaemonError::RecoveryRequired(reason))
                }
                Err(e) => {
                    if e.contains("RECOVERY_REQUIRED") {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        current.phase = AttemptPhase::RecoveryRequired;
                        current.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(e));
                    }
                    eprintln!("Execution prepare error: {e}. Will retry.");
                    Ok(true)
                }
            }
        }
        AttemptPhase::Prepared => {
            let disk_config = crate::config::LocalConfig::load(&paths.config_file())?;
            let is_logical_agent = disk_config
                .as_ref()
                .and_then(|c| c.targets.get(&active.target_id))
                .and_then(|t| t.executor.as_ref())
                .map(|e| e.command.is_none())
                .unwrap_or(true);

            if is_logical_agent {
                if !active.has_positive_dispatch() {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(
                        "LEGACY_IN_FLIGHT_LOGICAL_ATTEMPT: logical agent attempt found in Prepared without positive dispatch evidence; failing closed to prevent double-dispatch".into(),
                    ));
                } else {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::StartIntent;
                    current.save(&paths.active_attempt_file())?;
                    return Ok(true);
                }
            }

            let now = now_utc_ms();
            let timeout_seconds = active.execution_timeout_seconds.unwrap_or(600);
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            if let Some(ref mut exec) = current.executor {
                if exec.dispatch_started_at_ms.is_none() {
                    exec.dispatch_started_at_ms = Some(now);
                }
                if exec.execution_deadline_ms.is_none() {
                    exec.execution_deadline_ms = Some(now + timeout_seconds as i64 * 1000);
                }
            }
            current.phase = AttemptPhase::DispatchIntent;
            current.save(&paths.active_attempt_file())?;
            Ok(true)
        }
        AttemptPhase::DispatchIntent => {
            let disk_config = crate::config::LocalConfig::load(&paths.config_file())?;
            let is_logical_agent = disk_config
                .as_ref()
                .and_then(|c| c.targets.get(&active.target_id))
                .and_then(|t| t.executor.as_ref())
                .map(|e| e.command.is_none())
                .unwrap_or(true);

            if is_logical_agent {
                if !active.has_positive_dispatch() {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(
                        "LEGACY_IN_FLIGHT_LOGICAL_ATTEMPT: logical agent attempt found in DispatchIntent without positive dispatch evidence; failing closed to prevent double-dispatch".into(),
                    ));
                } else {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::StartIntent;
                    current.save(&paths.active_attempt_file())?;
                    return Ok(true);
                }
            }

            let terminal_id = match active
                .executor
                .as_ref()
                .and_then(|e| e.terminal_id.as_ref())
            {
                Some(tid) => tid.clone(),
                None => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(
                        "Dispatch intent missing terminal_id".into(),
                    ));
                }
            };

            // Reconcile dispatch state
            let reconciliation = match adapter.reconcile_dispatch(&active, &terminal_id).await {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("Error during dispatch reconciliation: {e}");
                    return Ok(true);
                }
            };

            match reconciliation {
                crate::scheduler::DispatchReconciliation::Accepted { request_id } => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    if let Some(ref mut exec) = current.executor {
                        exec.dispatch_request_id = Some(request_id);
                        if exec.dispatch_accepted_at_ms.is_none() {
                            exec.dispatch_accepted_at_ms = Some(now_utc_ms());
                        }
                    }
                    current.phase = AttemptPhase::Dispatched;
                    current.save(&paths.active_attempt_file())?;
                    Ok(true)
                }
                crate::scheduler::DispatchReconciliation::DefinitelyNotDispatched => {
                    let send_count = active
                        .executor
                        .as_ref()
                        .map(|e| e.dispatch_send_count)
                        .unwrap_or(0);
                    let last_outcome = active
                        .executor
                        .as_ref()
                        .and_then(|e| e.last_dispatch_outcome.as_deref());

                    if last_outcome == Some("ambiguous") {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        current.phase = AttemptPhase::RecoveryRequired;
                        current.save(&paths.active_attempt_file())?;
                        return Err(DaemonError::RecoveryRequired(
                            "Prior dispatch outcome was ambiguous; cannot safely issue fresh send without manual recovery".into(),
                        ));
                    }

                    if send_count >= 2 {
                        let _lock = ExecutionLock::acquire_with_retry(
                            &paths.state_lock_file(),
                            Duration::from_secs(5),
                            Duration::from_millis(50),
                        )?;
                        let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                            Some(c) if c.attempt_id == active.attempt_id => c,
                            _ => return Ok(true),
                        };
                        if let Some(ref mut exec) = current.executor {
                            exec.runtime_completion_kind = Some("not_started".into());
                            exec.runtime_completed_at_ms = Some(now_utc_ms());
                            exec.runtime_error = Some(ExecutionReportError {
                                stage: "dispatch".into(),
                                code: "DISPATCH_REJECTED".into(),
                                message: "Exhausted maximum dispatch retry budget (proven rejected before acceptance)".into(),
                            });
                        }
                        current.phase = AttemptPhase::OutcomeRecorded;
                        current.save(&paths.active_attempt_file())?;

                        println!(
                            "Dispatch retry budget exhausted for attempt '{}'; marked not_started and advanced to OutcomeRecorded for verified cleanup",
                            active.attempt_id
                        );
                        return Ok(true);
                    }

                    // Increment send count durable before dispatch!
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    let baseline_state_started_at = adapter
                        .get_agent_status_baseline(&terminal_id)
                        .await
                        .unwrap_or(None);
                    if let Some(ref mut exec) = current.executor {
                        exec.dispatch_send_count += 1;
                        exec.dispatch_baseline_state_started_at = baseline_state_started_at;
                    }
                    current.save(&paths.active_attempt_file())?;
                    drop(_lock);

                    let prompt_text = build_attempt_execution_prompt(paths, &active);

                    let outcome = match adapter.dispatch(&active, &terminal_id, &prompt_text).await
                    {
                        Ok(o) => o,
                        Err(e) => {
                            eprintln!("Dispatch execution error: {e}");
                            return Ok(true);
                        }
                    };

                    match outcome {
                        crate::scheduler::DispatchOutcome::Accepted {
                            request_id,
                            accepted_at_ms,
                            turn_started,
                        } => {
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            if let Some(ref mut exec) = current.executor {
                                exec.dispatch_request_id = Some(request_id);
                                exec.dispatch_accepted_at_ms = Some(accepted_at_ms);
                                exec.dispatch_turn_started = turn_started;
                                exec.last_dispatch_outcome = None;
                            }
                            current.phase = AttemptPhase::Dispatched;
                            current.save(&paths.active_attempt_file())?;
                            Ok(true)
                        }
                        crate::scheduler::DispatchOutcome::KnownRejectedBeforeAcceptance {
                            reason,
                        } => {
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            if let Some(ref mut exec) = current.executor {
                                exec.last_dispatch_outcome = Some("known_rejected".into());
                            }
                            current.save(&paths.active_attempt_file())?;
                            eprintln!("Dispatch rejected before acceptance: {reason}. Intent remains for retry/budget check.");
                            Ok(true)
                        }
                        crate::scheduler::DispatchOutcome::RecoveryRequired { code, message } => {
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            current.phase = AttemptPhase::RecoveryRequired;
                            current.save(&paths.active_attempt_file())?;
                            Err(DaemonError::RecoveryRequired(format!("{code}: {message}")))
                        }
                        crate::scheduler::DispatchOutcome::AmbiguousTransportFailure { error } => {
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            if let Some(ref mut exec) = current.executor {
                                exec.last_dispatch_outcome = Some("ambiguous".into());
                            }
                            current.save(&paths.active_attempt_file())?;
                            eprintln!("Ambiguous transport failure during dispatch: {error}. Intent remains for reconciliation.");
                            Ok(true)
                        }
                    }
                }
                crate::scheduler::DispatchReconciliation::Ambiguous => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    Err(DaemonError::RecoveryRequired(
                        "Ambiguous dispatch state detected: RECOVERY_REQUIRED".into(),
                    ))
                }
            }
        }
        AttemptPhase::Dispatched => {
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            current.phase = AttemptPhase::StartIntent;
            current.save(&paths.active_attempt_file())?;
            Ok(true)
        }
        AttemptPhase::Waiting => {
            let terminal_id = match active
                .executor
                .as_ref()
                .and_then(|e| e.terminal_id.as_ref())
            {
                Some(tid) => tid.clone(),
                None => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(
                        "Waiting phase missing terminal_id".into(),
                    ));
                }
            };

            let dispatch_request_id = active
                .executor
                .as_ref()
                .and_then(|e| e.dispatch_request_id.as_ref());
            if dispatch_request_id.is_none() {
                let _lock = ExecutionLock::acquire_with_retry(
                    &paths.state_lock_file(),
                    Duration::from_secs(5),
                    Duration::from_millis(50),
                )?;
                let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                    Some(c) if c.attempt_id == active.attempt_id => c,
                    _ => return Ok(true),
                };
                current.phase = AttemptPhase::RecoveryRequired;
                current.save(&paths.active_attempt_file())?;
                return Err(DaemonError::RecoveryRequired(
                    "Waiting phase requires dispatch_request_id".into(),
                ));
            }

            let deadline_ms = match active
                .executor
                .as_ref()
                .and_then(|e| e.execution_deadline_ms)
            {
                Some(dl) => dl,
                None => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(
                        "Waiting phase missing execution_deadline_ms".into(),
                    ));
                }
            };

            let mut turn_started_observed = active
                .executor
                .as_ref()
                .map(|e| e.turn_started_observed)
                .unwrap_or(false);
            // Durable monotonic flag: once positive structured Agent lifecycle
            // observation has been seen for this Attempt (at minimum
            // WorkingObserved for the current pane/generation), generic
            // terminal idle must never terminalize it. Successful completion
            // in this mode requires authoritative AgentDone evidence
            // (state=done, interrupted=false, new generation) from Orca.
            let mut structured_lifecycle_observed = active
                .executor
                .as_ref()
                .map(|e| e.structured_lifecycle_observed)
                .unwrap_or(false);

            let mut completion_kind: Option<String> = None;
            let mut completion_err: Option<ExecutionReportError> = None;

            while now_utc_ms() < deadline_ms {
                // Operator-cancel observation (Wave 2B): poll the server's
                // device-scoped read model each tick. If the job has been
                // authoritatively cancelled, interrupt the live attempt through
                // the existing Orca adapter path and terminalize locally.
                // Poll failures are tolerated (best-effort; loop continues).
                match client.get_job(cred, &active.job_id, false).await {
                    Ok(detail)
                        if detail.state == "terminal"
                            && detail.execution_status.as_deref() == Some("CANCELLED") =>
                    {
                        let _ = adapter.interrupt(&active, &terminal_id).await;
                        finalize_local_operator_cancelled(paths, &active)?;
                        println!(
                            "Job '{}' was operator-cancelled while running; attempt interrupted and terminalized locally.",
                            active.job_id
                        );
                        return Ok(true);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!(
                            "Operator-cancel poll failed for job '{}' (tolerated): {}",
                            active.job_id, e
                        );
                    }
                }

                if active.result_target.as_deref() == Some("resource")
                    && crate::managed_result::durable_capture_managed_result(paths, cred, &active)
                        .is_ok()
                {
                    println!(
                            "Attempt '{}' resource managed-result barrier detected. Advancing to OutcomeRecorded.",
                            active.attempt_id
                        );
                    completion_kind = Some("managed_result".to_string());
                    completion_err = None;
                    break;
                }

                // Check B: Adapter observation tick (~1500ms bounded)
                let remaining_ms = (deadline_ms - now_utc_ms()).max(0);
                if remaining_ms == 0 {
                    break;
                }
                let tick_timeout = Duration::from_millis((remaining_ms as u64).min(1500));
                let wait_outcome = adapter
                    .wait(&active, &terminal_id, tick_timeout)
                    .await
                    .map_err(|e| DaemonError::RecoveryRequired(format!("Wait failure: {e}")))?;

                match wait_outcome {
                    crate::scheduler::WaitOutcome::WorkingObserved { .. } => {
                        if !turn_started_observed || !structured_lifecycle_observed {
                            turn_started_observed = true;
                            structured_lifecycle_observed = true;
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            if let Some(ref mut exec) = current.executor {
                                exec.turn_started_observed = true;
                                exec.structured_lifecycle_observed = true;
                            }
                            current.save(&paths.active_attempt_file())?;
                            println!(
                                "Attempt '{}' agent working state observed; structured Agent lifecycle observation recorded (tui-idle fallback disabled).",
                                active.attempt_id
                            );
                        }
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    crate::scheduler::WaitOutcome::AgentSeen { .. } => {
                        if !structured_lifecycle_observed {
                            structured_lifecycle_observed = true;
                            let _lock = ExecutionLock::acquire_with_retry(
                                &paths.state_lock_file(),
                                Duration::from_secs(5),
                                Duration::from_millis(50),
                            )?;
                            let mut current =
                                match ActiveAttempt::load(&paths.active_attempt_file())? {
                                    Some(c) if c.attempt_id == active.attempt_id => c,
                                    _ => return Ok(true),
                                };
                            if let Some(ref mut exec) = current.executor {
                                exec.structured_lifecycle_observed = true;
                            }
                            current.save(&paths.active_attempt_file())?;
                            println!(
                                "Attempt '{}' structured Agent lifecycle observation recorded; generic terminal idle must not terminalize.",
                                active.attempt_id
                            );
                        }
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                    crate::scheduler::WaitOutcome::AgentDone { .. } => {
                        // Correctness rule: a structured Agent done observation
                        // with a new generation but NO prior durable positive
                        // turn-start evidence for the dispatched turn
                        // (turn_started_observed=false) is NOT sufficient proof
                        // that the dispatched task ran. Treat it as pre-turn
                        // /non-terminal evidence: record that structured
                        // lifecycle observation is available and keep waiting
                        // inside the durable execution deadline (never close
                        // the terminal here). Only after WorkingObserved has
                        // been durably recorded may an authoritative
                        // new-generation done + interrupted=false complete.
                        if !turn_started_observed {
                            if !structured_lifecycle_observed {
                                structured_lifecycle_observed = true;
                                let _lock = ExecutionLock::acquire_with_retry(
                                    &paths.state_lock_file(),
                                    Duration::from_secs(5),
                                    Duration::from_millis(50),
                                )?;
                                let mut current =
                                    match ActiveAttempt::load(&paths.active_attempt_file())? {
                                        Some(c) if c.attempt_id == active.attempt_id => c,
                                        _ => return Ok(true),
                                    };
                                if let Some(ref mut exec) = current.executor {
                                    exec.structured_lifecycle_observed = true;
                                }
                                current.save(&paths.active_attempt_file())?;
                            }
                            println!(
                                "Pre-turn AgentDone observed for attempt '{}' without positive turn-start evidence; waiting for turn start.",
                                active.attempt_id
                            );
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            continue;
                        }
                        if active.result_target.as_deref() == Some("resource") {
                            match crate::managed_result::durable_capture_managed_result(
                                paths, cred, &active,
                            ) {
                                Ok(_) => {
                                    completion_kind = Some("agent_done".to_string());
                                    completion_err = None;
                                    break;
                                }
                                Err(crate::managed_result::ManagedResultError::Io(err))
                                    if err.kind() == std::io::ErrorKind::NotFound =>
                                {
                                    completion_kind = Some("agent_done".to_string());
                                    completion_err = Some(ExecutionReportError {
                                        stage: "result".into(),
                                        code: "RESULT_MISSING".into(),
                                        message: "Agent reported done but managed-result.json was not found".into(),
                                    });
                                    break;
                                }
                                Err(other) => {
                                    completion_kind = Some("agent_done".to_string());
                                    completion_err = Some(ExecutionReportError {
                                        stage: "result".into(),
                                        code: "RESULT_INVALID".into(),
                                        message: other.to_string(),
                                    });
                                    break;
                                }
                            }
                        } else {
                            completion_kind = Some("agent_done".to_string());
                            completion_err = None;
                            break;
                        }
                    }
                    crate::scheduler::WaitOutcome::TuiIdle { .. } => {
                        if structured_lifecycle_observed {
                            // Structured Agent lifecycle evidence outranks
                            // generic terminal idle: after a working state was
                            // observed for this pane/generation, a TuiIdle must
                            // never terminalize the attempt (never close the
                            // terminal). Only authoritative AgentDone may
                            // complete here; otherwise wait inside the durable
                            // deadline.
                            println!(
                                "Post-working tui-idle observed for attempt '{}' with structured Agent lifecycle observation; waiting for authoritative AgentDone.",
                                active.attempt_id
                            );
                            tokio::time::sleep(Duration::from_millis(300)).await;
                            continue;
                        }

                        let is_turn_started = active
                            .executor
                            .as_ref()
                            .map(|e| e.dispatch_turn_started)
                            .unwrap_or(false)
                            || turn_started_observed;

                        if is_turn_started {
                            if active.result_target.as_deref() == Some("resource") {
                                match crate::managed_result::durable_capture_managed_result(
                                    paths, cred, &active,
                                ) {
                                    Ok(_) => {
                                        completion_kind = Some("tui_idle".to_string());
                                        completion_err = None;
                                        break;
                                    }
                                    Err(crate::managed_result::ManagedResultError::Io(err))
                                        if err.kind() == std::io::ErrorKind::NotFound =>
                                    {
                                        completion_kind = Some("tui_idle".to_string());
                                        completion_err = Some(ExecutionReportError {
                                            stage: "result".into(),
                                            code: "RESULT_MISSING".into(),
                                            message: "Agent reported tui-idle but managed-result.json was not found".into(),
                                        });
                                        break;
                                    }
                                    Err(other) => {
                                        completion_kind = Some("tui_idle".to_string());
                                        completion_err = Some(ExecutionReportError {
                                            stage: "result".into(),
                                            code: "RESULT_INVALID".into(),
                                            message: other.to_string(),
                                        });
                                        break;
                                    }
                                }
                            } else {
                                completion_kind = Some("tui_idle".to_string());
                                completion_err = None;
                                break;
                            }
                        } else {
                            println!(
                                "Pre-turn tui-idle observed for attempt '{}'; waiting for turn start.",
                                active.attempt_id
                            );
                            tokio::time::sleep(Duration::from_millis(300)).await;
                        }
                    }
                    crate::scheduler::WaitOutcome::Interrupted { reason } => {
                        completion_kind = Some("interrupted".to_string());
                        completion_err = Some(ExecutionReportError {
                            stage: "runtime".into(),
                            code: "TERMINAL_EXITED".into(),
                            message: reason,
                        });
                        break;
                    }
                    crate::scheduler::WaitOutcome::TimedOut { .. } => {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                    }
                }
            }

            let (kind, err) = match completion_kind {
                Some(k) => (k, completion_err),
                None => {
                    if active.result_target.as_deref() == Some("resource") {
                        match crate::managed_result::durable_capture_managed_result(
                            paths, cred, &active,
                        ) {
                            Ok(_) => {
                                println!(
                                    "Attempt '{}' execution deadline reached, but valid managed-result was captured.",
                                    active.attempt_id
                                );
                                ("timed_out".to_string(), None)
                            }
                            Err(_) => (
                                "timed_out".to_string(),
                                Some(ExecutionReportError {
                                    stage: "runtime".into(),
                                    code: "EXECUTION_TIMEOUT".into(),
                                    message: "Execution exceeded durable timeout deadline".into(),
                                }),
                            ),
                        }
                    } else {
                        (
                            "timed_out".to_string(),
                            Some(ExecutionReportError {
                                stage: "runtime".into(),
                                code: "EXECUTION_TIMEOUT".into(),
                                message: "Execution exceeded durable timeout deadline".into(),
                            }),
                        )
                    }
                }
            };

            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            if let Some(ref mut exec) = current.executor {
                exec.runtime_completion_kind = Some(kind);
                exec.runtime_completed_at_ms = Some(now_utc_ms());
                exec.runtime_error = err;
            }
            current.phase = AttemptPhase::OutcomeRecorded;
            current.save(&paths.active_attempt_file())?;
            println!(
                "Attempt '{}' runtime completed. Phase advanced to OutcomeRecorded.",
                active.attempt_id
            );
            Ok(true)
        }
        AttemptPhase::OutcomeRecorded => {
            let exec_state = active.executor.as_ref().ok_or_else(|| {
                DaemonError::RecoveryRequired("OutcomeRecorded phase missing executor state".into())
            })?;

            let task_dispatched = exec_state.dispatch_request_id.is_some();

            // Defensively ensure redelivery authority is preserved for resource jobs
            let _ = crate::managed_result::durable_persist_redelivery_meta(paths, cred, &active);

            let (status, outcome, err, managed_result, managed_result_sha256) = match exec_state
                .runtime_completion_kind
                .as_deref()
            {
                Some("managed_result") | Some("agent_done") | Some("tui_idle") => {
                    if let Some(ref e) = exec_state.runtime_error {
                        (
                            ExecutionStatus::FAILED,
                            BusinessOutcome::FAILED,
                            Some(e.clone()),
                            None,
                            None,
                        )
                    } else if active.result_target.as_deref() == Some("resource") {
                        let pres_res =
                            paths.preserved_managed_result_file(&active.job_id, &active.attempt_id);
                        let expected_resource_id = active.resource_id.as_deref();
                        let (envelope, sha256) = if pres_res.exists() {
                            match crate::managed_result::read_and_validate_from_file(
                                &pres_res,
                                &active.job_id,
                                &active.attempt_id,
                                expected_resource_id,
                            ) {
                                Ok(res) => res,
                                Err(_) => {
                                    let captured =
                                        crate::managed_result::durable_capture_managed_result(
                                            paths, cred, &active,
                                        )
                                        .map_err(|e| {
                                            DaemonError::RecoveryRequired(format!(
                                                "Failed to read managed result: {e}"
                                            ))
                                        })?;
                                    (captured.envelope, captured.payload_sha256)
                                }
                            }
                        } else {
                            let captured = crate::managed_result::durable_capture_managed_result(
                                paths, cred, &active,
                            )
                            .map_err(|e| {
                                DaemonError::RecoveryRequired(format!(
                                    "Failed to capture managed result: {e}"
                                ))
                            })?;
                            (captured.envelope, captured.payload_sha256)
                        };

                        (
                            ExecutionStatus::COMPLETED,
                            BusinessOutcome::UNVERIFIED,
                            None,
                            Some(envelope),
                            Some(sha256),
                        )
                    } else {
                        (
                            ExecutionStatus::COMPLETED,
                            BusinessOutcome::UNVERIFIED,
                            None,
                            None,
                            None,
                        )
                    }
                }
                Some("timed_out") => {
                    if active.result_target.as_deref() == Some("resource") {
                        let pres_res =
                            paths.preserved_managed_result_file(&active.job_id, &active.attempt_id);
                        let expected_resource_id = active.resource_id.as_deref();
                        let captured = if pres_res.exists() {
                            crate::managed_result::read_and_validate_from_file(
                                &pres_res,
                                &active.job_id,
                                &active.attempt_id,
                                expected_resource_id,
                            )
                            .ok()
                        } else {
                            crate::managed_result::durable_capture_managed_result(
                                paths, cred, &active,
                            )
                            .ok()
                            .map(|c| (c.envelope, c.payload_sha256))
                        };

                        if let Some((envelope, sha256)) = captured {
                            (
                                ExecutionStatus::COMPLETED,
                                BusinessOutcome::UNVERIFIED,
                                None,
                                Some(envelope),
                                Some(sha256),
                            )
                        } else {
                            (
                                ExecutionStatus::TIMED_OUT,
                                BusinessOutcome::UNVERIFIED,
                                exec_state.runtime_error.clone().or_else(|| {
                                    Some(ExecutionReportError {
                                        stage: "runtime".into(),
                                        code: "EXECUTION_TIMEOUT".into(),
                                        message: "Execution timed out".into(),
                                    })
                                }),
                                None,
                                None,
                            )
                        }
                    } else {
                        (
                            ExecutionStatus::TIMED_OUT,
                            BusinessOutcome::UNVERIFIED,
                            exec_state.runtime_error.clone().or_else(|| {
                                Some(ExecutionReportError {
                                    stage: "runtime".into(),
                                    code: "EXECUTION_TIMEOUT".into(),
                                    message: "Execution timed out".into(),
                                })
                            }),
                            None,
                            None,
                        )
                    }
                }
                Some("interrupted") => (
                    ExecutionStatus::FAILED,
                    BusinessOutcome::FAILED,
                    exec_state.runtime_error.clone().or_else(|| {
                        Some(ExecutionReportError {
                            stage: "runtime".into(),
                            code: "TERMINAL_EXITED".into(),
                            message: "Execution interrupted".into(),
                        })
                    }),
                    None,
                    None,
                ),
                Some("not_started") => (
                    ExecutionStatus::BLOCKED,
                    BusinessOutcome::NOT_STARTED,
                    exec_state.runtime_error.clone().or_else(|| {
                        Some(ExecutionReportError {
                            stage: "orchestration".into(),
                            code: "EXECUTION_NOT_STARTED".into(),
                            message: "Execution blocked before agent dispatch".into(),
                        })
                    }),
                    None,
                    None,
                ),
                other => {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                        Some(c) if c.attempt_id == active.attempt_id => c,
                        _ => return Ok(true),
                    };
                    current.phase = AttemptPhase::RecoveryRequired;
                    current.save(&paths.active_attempt_file())?;
                    return Err(DaemonError::RecoveryRequired(format!(
                        "Unknown runtime_completion_kind: {other:?}"
                    )));
                }
            };

            // Terminal handling: only close on COMPLETED; interrupt on TIMED_OUT; retain session on FAILED/TIMED_OUT
            let (terminal_cleanup_verified, terminal_closed_at_ms) = match status {
                ExecutionStatus::COMPLETED => {
                    if let Some(tid) = exec_state.terminal_id.as_deref() {
                        match adapter.close(tid).await {
                            crate::scheduler::CleanupOutcome::VerifiedClosed { closed_at_ms } => {
                                (true, Some(closed_at_ms))
                            }
                            crate::scheduler::CleanupOutcome::AlreadyAbsent { verified_at_ms } => {
                                (true, Some(verified_at_ms))
                            }
                            crate::scheduler::CleanupOutcome::Retryable { reason } => {
                                eprintln!(
                                    "Terminal cleanup retryable: {reason}. Will retry next loop."
                                );
                                return Ok(true);
                            }
                            crate::scheduler::CleanupOutcome::RecoveryRequired {
                                code,
                                message,
                            } => {
                                let _lock = ExecutionLock::acquire_with_retry(
                                    &paths.state_lock_file(),
                                    Duration::from_secs(5),
                                    Duration::from_millis(50),
                                )?;
                                let mut current =
                                    match ActiveAttempt::load(&paths.active_attempt_file())? {
                                        Some(c) if c.attempt_id == active.attempt_id => c,
                                        _ => return Ok(true),
                                    };
                                current.phase = AttemptPhase::RecoveryRequired;
                                current.save(&paths.active_attempt_file())?;
                                return Err(DaemonError::RecoveryRequired(format!(
                                    "{code}: {message}"
                                )));
                            }
                        }
                    } else {
                        (true, None)
                    }
                }
                ExecutionStatus::TIMED_OUT => {
                    if let Some(tid) = exec_state.terminal_id.as_deref() {
                        if let Err(e) = adapter.interrupt(&active, tid).await {
                            eprintln!("Warning: failed to send interrupt to terminal {tid}: {e}");
                        }
                    }
                    (false, None)
                }
                _ => {
                    // Retain terminal session for user inspection in Orca
                    (false, None)
                }
            };

            let started_ms = exec_state.dispatch_started_at_ms.unwrap_or_else(now_utc_ms);
            let completed_ms = exec_state
                .runtime_completed_at_ms
                .unwrap_or_else(now_utc_ms);
            let duration_ms = if task_dispatched {
                (completed_ms - started_ms).max(0)
            } else {
                0
            };

            let orca_version = exec_state
                .orca_version
                .clone()
                .unwrap_or_else(|| "unknown".into());

            let receipt = ExecutionReceipt {
                schema_version: ExecutionReceipt::SCHEMA_VERSION,
                job_id: active.job_id.clone(),
                attempt_id: active.attempt_id.clone(),
                target_id: active.target_id.clone(),
                orca_version: orca_version.clone(),
                worktree_id: exec_state.worktree_id.clone(),
                terminal_id: exec_state.terminal_id.clone(),
                agent_id: exec_state.agent_id.clone(),
                agent_ready_at_ms: exec_state.agent_ready_at_ms,
                dispatch_request_id: exec_state.dispatch_request_id.clone(),
                task_dispatched,
                runtime_completion_kind: exec_state.runtime_completion_kind.clone(),
                dispatch_started_at_ms: exec_state.dispatch_started_at_ms,
                runtime_completed_at_ms: exec_state.runtime_completed_at_ms,
                terminal_cleanup_verified,
                terminal_closed_at_ms,
            };
            let receipt_sha256 = receipt.compute_sha256();

            let report = ExecutionReport {
                schema_version: REPORT_SCHEMA_VERSION,
                execution_status: status,
                business_outcome: outcome,
                task_dispatched,
                finished_at_ms: completed_ms,
                duration_ms,
                error: err,
                executor: ExecutionReportExecutor {
                    executor_type: exec_state.executor_type.clone(),
                    version: orca_version,
                },
                receipt_sha256,
            };
            report
                .validate()
                .map_err(|e| DaemonError::RecoveryRequired(e.to_string()))?;
            let digest = compute_report_sha256(&report);

            let outbox_rec = OutboxRecord {
                schema_version: OUTBOX_SCHEMA_VERSION,
                server_origin: cred.server_origin.clone(),
                device_id: cred.device_id.clone(),
                job_id: active.job_id.clone(),
                attempt_id: active.attempt_id.clone(),
                claim_token: active.claim_token.clone(),
                report,
                managed_result,
                managed_result_sha256,
                created_at_ms: now_utc_ms(),
            };
            let outbox_file = paths.outbox_file(&active.job_id, &active.attempt_id);
            outbox_rec
                .save(&outbox_file)
                .map_err(|e| DaemonError::RecoveryRequired(e.to_string()))?;

            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            current.phase = AttemptPhase::FinalizedLocal;
            current.terminal_report_sha256 = Some(digest);
            current.save(&paths.active_attempt_file())?;
            drop(_lock);

            let _ = flush_outbox(paths, client, cred).await;
            Ok(true)
        }
        AttemptPhase::FinalizedLocal => {
            let hist_file = paths.history_file(&active.job_id, &active.attempt_id);
            let outbox_file = paths.outbox_file(&active.job_id, &active.attempt_id);

            if outbox_file.exists() {
                let outbox = OutboxRecord::load(&outbox_file).map_err(|e| {
                    DaemonError::RecoveryRequired(format!("failed to load outbox: {e}"))
                })?;
                let digest = compute_report_sha256(&outbox.report);
                if outbox.job_id == active.job_id
                    && outbox.attempt_id == active.attempt_id
                    && Some(&digest) == active.terminal_report_sha256.as_ref()
                {
                    match deliver_outbox_record(paths, client, cred, &outbox_file, &outbox).await {
                        Ok(()) => {
                            println!("Successfully delivered outbox record and completed cleanup.");
                            Ok(true)
                        }
                        Err(crate::outbox::OutboxError::AuthRequired) => {
                            Err(DaemonError::AuthRequired)
                        }
                        Err(crate::outbox::OutboxError::RecoveryRequired(msg)) => {
                            Err(DaemonError::RecoveryRequired(msg))
                        }
                        Err(crate::outbox::OutboxError::Retryable(msg)) => {
                            eprintln!("Retryable error delivering outbox: {msg}");
                            Ok(true)
                        }
                        Err(e) => Err(DaemonError::RecoveryRequired(e.to_string())),
                    }
                } else {
                    Err(DaemonError::RecoveryRequired(
                        "Outbox record does not match active attempt correlation".into(),
                    ))
                }
            } else if hist_file.exists() {
                let hist_content = fs::read_to_string(&hist_file)?;
                let hist: crate::outbox::SanitizedHistoryRecord =
                    serde_json::from_str(&hist_content)?;
                if hist.job_id == active.job_id
                    && hist.attempt_id == active.attempt_id
                    && hist.target_id == active.target_id
                    && Some(&hist.terminal_report_sha256) == active.terminal_report_sha256.as_ref()
                {
                    let _lock = ExecutionLock::acquire_with_retry(
                        &paths.state_lock_file(),
                        Duration::from_secs(5),
                        Duration::from_millis(50),
                    )?;
                    remove_durable(&paths.active_attempt_file())?;
                    println!("Active attempt was already delivered. Completed local active attempt cleanup.");
                    Ok(false)
                } else {
                    Err(DaemonError::RecoveryRequired(
                        "History record does not match active attempt correlation".into(),
                    ))
                }
            } else {
                Err(DaemonError::RecoveryRequired(
                    "Attempt in finalized_local but neither valid history nor outbox file exists"
                        .into(),
                ))
            }
        }
        AttemptPhase::RecoveryRequired => {
            // Bounded convergence repair: a locally persisted recovery_required
            // attempt (e.g. prepare failed after the Server authoritatively
            // cancelled the job) would otherwise block this device forever.
            // Converge through the shared owner
            // (`crate::attempt_convergence::reconcile_active_attempt_with_
            // server_operator_cancel`), which this project-side convergence
            // also reuses. Any other server state, missing/ambiguous attempt
            // identity, transport failure, or attempt mismatch remains
            // fail-closed recovery_required.
            let reason = match crate::attempt_convergence::reconcile_active_attempt_with_server_operator_cancel(
                paths, client, cred,
            )
            .await
            {
                crate::attempt_convergence::OperatorCancelReconciliation::Finalized => {
                    println!(
                        "Job '{}' was operator-cancelled on the server; local recovery_required attempt terminalized as cancelled.",
                        active.job_id
                    );
                    return Ok(true);
                }
                // The marker was already converged by another path; nothing
                // left to drive on this pass.
                crate::attempt_convergence::OperatorCancelReconciliation::NoMarker => {
                    return Ok(true)
                }
                crate::attempt_convergence::OperatorCancelReconciliation::Blocked { reason } => {
                    reason
                }
            };
            Err(DaemonError::RecoveryRequired(format!(
                "Active attempt is in recovery_required phase: {reason}"
            )))
        }
        AttemptPhase::LegacyRunning => {
            let _lock = ExecutionLock::acquire_with_retry(
                &paths.state_lock_file(),
                Duration::from_secs(5),
                Duration::from_millis(50),
            )?;
            let mut current = match ActiveAttempt::load(&paths.active_attempt_file())? {
                Some(c) if c.attempt_id == active.attempt_id => c,
                _ => return Ok(true),
            };
            current.phase = AttemptPhase::RecoveryRequired;
            current.save(&paths.active_attempt_file())?;
            Err(DaemonError::RecoveryRequired(
                "Legacy running attempt migrated to recovery_required".into(),
            ))
        }
    }
}
