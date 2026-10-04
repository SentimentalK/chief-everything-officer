//! PROJECT-039 slice: per-Target local execution admission preflight.
//!
//! Regression contract:
//! - A locally mapped Project whose executor cannot be launched by this
//!   Device's current executor/runtime configuration must NEVER reach
//!   ClaimIntent persistence or a Server claim request.
//! - Logical-only executors (command=None) require Orca's non-orchestrating
//!   existing-worktree Agent-aware launch surface.
//! - Explicit legacy command executors require local executable discovery.
//! - Incompatible candidates are skipped, never starving later compatible
//!   candidates in the same pending batch.
//! - Admission is re-evaluated against the config reloaded under the state
//!   lock immediately before claim.

mod common;

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{
    run_daemon_with_hooks, run_daemon_with_hooks_and_admission_orca, DaemonHooks,
};
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{ActiveAttempt, AttemptPhase, FakeExecutionAdapter};
use common::mock_server::{MockResponse, MockServer};

const DCR_EXPIRES: i64 = 2000000000000;

fn sample_report() -> ceo_connector::execution_contract::ExecutionReport {
    ceo_connector::execution_contract::ExecutionReport {
        schema_version: 2,
        execution_status: ceo_connector::execution_contract::ExecutionStatus::COMPLETED,
        business_outcome: ceo_connector::execution_contract::BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1700000001000,
        duration_ms: 1000,
        executor: ceo_connector::execution_contract::ExecutionReportExecutor {
            executor_type: "fake".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    }
}

/// A deterministic probe binary that does not exist: the shared policy then
/// reports the Orca agent launch surface as unavailable (fail closed).
fn missing_orca_probe(temp: &tempfile::TempDir) -> OrcaCliClient {
    OrcaCliClient::new(temp.path().join("no-such-orca-binary"))
}

/// Creates a locally existing file and returns its absolute path as an
/// executable legacy command (executable discovery checks is_file() for
/// absolute paths).
fn executable_legacy_command(temp: &tempfile::TempDir) -> String {
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    agent_bin.display().to_string()
}

fn fake_ready_adapter() -> Arc<FakeExecutionAdapter> {
    Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    })
}

fn standard_target_handlers(
    server: &MockServer,
    target_ids: &[&str],
    job_ids: &[&str],
    claim_counter: Arc<AtomicUsize>,
    claimed_job_ids: Arc<std::sync::Mutex<Vec<String>>>,
) {
    let targets: Vec<serde_json::Value> = target_ids
        .iter()
        .map(|tid| {
            serde_json::json!({
                "target": {
                    "id": *tid,
                    "workspace_id": "ws_1",
                    "alias": format!("alias-{tid}"),
                    "display_name": format!("Display {tid}"),
                    "kind": "general_automation",
                    "repository": null,
                    "disabled": false
                },
                "this_device_binding": { "id": "bnd_1", "enabled": true },
                "active_binding_count": 1
            })
        })
        .collect();
    let first_target = target_ids[0].to_string();
    let jobs: Vec<serde_json::Value> = job_ids
        .iter()
        .map(|jid| {
            serde_json::json!({
                "job_id": *jid,
                "workspace_id": "ws_1",
                "target_id": first_target,
                "resource_id": null,
                "created_at": "2026-09-24T12:00:00.000Z",
                "expires_at": null
            })
        })
        .collect();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": DCR_EXPIRES }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "targets": targets }));
        }
        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "jobs": jobs }));
        }
        if req.path.contains("/claim") && req.method == "POST" {
            claim_counter.fetch_add(1, Ordering::SeqCst);
            // job_id is carried in the claim URL path, not the body.
            let job_id = req
                .path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/claim"))
                .unwrap_or_default()
                .to_string();
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body
                .get("attempt_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            claimed_job_ids.lock().unwrap().push(job_id.clone());
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": job_id,
                        "workspace_id": "ws_1",
                        "target_id": first_target,
                        "resource_id": null,
                        "prompt": "Test prompt",
                        "acceptance": "Test acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });
}

fn base_credential(server: &MockServer, paths: &ConnectorPaths) {
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        DCR_EXPIRES,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();
}

fn mapped_target(
    paths_dir: &tempfile::TempDir,
    executor: Option<LocalExecutorConfig>,
) -> LocalTarget {
    let target_dir = paths_dir.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();
    LocalTarget {
        local_path: target_dir.to_string_lossy().to_string(),
        executor,
    }
}

#[tokio::test]
async fn logical_only_without_agent_launch_surface_stays_unclaimed() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_logical"],
        &["job_logical_1"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_logical".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    // Global runtime is ready (adapter is_ready = true) so the ONLY thing
    // preventing the claim is the launch-surface admission policy.
    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(2),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    assert_eq!(claim_calls.load(Ordering::SeqCst), 0);
    assert!(
        !paths.active_attempt_file().exists(),
        "no ClaimIntent may be persisted for a not-locally-launchable Project"
    );
}

#[tokio::test]
async fn missing_executor_not_claimed() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_none"],
        &["job_none_1"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config
        .targets
        .insert("tgt_none".into(), mapped_target(&temp, None));
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(2),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    assert_eq!(claim_calls.load(Ordering::SeqCst), 0);
    assert!(!paths.active_attempt_file().exists());
}

#[tokio::test]
async fn compatible_legacy_command_claimed() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_legacy"],
        &["job_legacy_1"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_legacy".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), executable_legacy_command(&temp)).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
    assert_eq!(claimed_job_ids.lock().unwrap().as_slice(), ["job_legacy_1"]);

    let attempt = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("claim intent persisted and reconciled");
    assert_eq!(attempt.phase, AttemptPhase::Claimed);
    assert_eq!(attempt.job_id, "job_legacy_1");
}

#[tokio::test]
async fn incompatible_first_candidate_does_not_starve_later_compatible() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    // Pending batch: first candidate targets a logical-only Project without
    // the Orca launch surface; the later candidate is a compatible legacy
    // command Project.
    let targets: Vec<serde_json::Value> = ["tgt_bad", "tgt_good"]
        .iter()
        .map(|tid| {
            serde_json::json!({
                "target": {
                    "id": *tid,
                    "workspace_id": "ws_1",
                    "alias": format!("alias-{tid}"),
                    "display_name": format!("Display {tid}"),
                    "kind": "general_automation",
                    "repository": null,
                    "disabled": false
                },
                "this_device_binding": { "id": "bnd_1", "enabled": true },
                "active_binding_count": 1
            })
        })
        .collect();
    let jobs = vec![
        serde_json::json!({
            "job_id": "job_a_bad",
            "workspace_id": "ws_1",
            "target_id": "tgt_bad",
            "resource_id": null,
            "created_at": "2026-09-24T12:00:00.000Z",
            "expires_at": null
        }),
        serde_json::json!({
            "job_id": "job_b_good",
            "workspace_id": "ws_1",
            "target_id": "tgt_good",
            "resource_id": null,
            "created_at": "2026-09-24T12:00:00.000Z",
            "expires_at": null
        }),
    ];

    let claim_calls_local = claim_calls.clone();
    let claimed_local = claimed_job_ids.clone();
    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": DCR_EXPIRES }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "targets": targets }));
        }
        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "jobs": jobs }));
        }
        if req.path.contains("/claim") && req.method == "POST" {
            // job_id is carried in the claim URL path, not the body.
            let job_id = req
                .path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/claim"))
                .unwrap_or_default()
                .to_string();
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body
                .get("attempt_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            claim_calls_local.fetch_add(1, Ordering::SeqCst);
            claimed_local.lock().unwrap().push(job_id.clone());
            let target_id = if job_id == "job_a_bad" {
                "tgt_bad"
            } else {
                "tgt_good"
            };
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": job_id,
                        "workspace_id": "ws_1",
                        "target_id": target_id,
                        "resource_id": null,
                        "prompt": "Test prompt",
                        "acceptance": "Test acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_bad".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        ),
    );
    config.targets.insert(
        "tgt_good".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), executable_legacy_command(&temp)).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    // Only the compatible later candidate was claimed.
    assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
    let claimed = claimed_job_ids.lock().unwrap();
    assert_eq!(claimed.as_slice(), ["job_b_good"]);
    drop(claimed);

    let attempt = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("compatible candidate claimed");
    assert_eq!(attempt.job_id, "job_b_good");
}

#[tokio::test]
async fn config_incompatible_at_preclaim_reload_prevents_claim() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_1"],
        &["job_reload_1"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), executable_legacy_command(&temp)).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    // After candidate selection but before the state lock, the persisted
    // config becomes incompatible (logical-only executor while Orca lacks
    // the Agent-aware launch surface).
    let paths_for_hook = paths.clone();
    let hooks = DaemonHooks {
        after_candidate_selected: Some(Arc::new(move |_cand| {
            let paths = paths_for_hook.clone();
            Box::pin(async move {
                let mut cfg = LocalConfig::load(&paths.config_file())
                    .unwrap()
                    .expect("config exists");
                let target = cfg.targets.get_mut("tgt_1").unwrap();
                target.executor =
                    Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap());
                cfg.save(&paths.config_file()).unwrap();
            })
        })),
        ..Default::default()
    };

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        hooks,
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    // The pre-claim reload under the state lock observed the incompatible
    // executor configuration and prevented the claim entirely.
    assert_eq!(claim_calls.load(Ordering::SeqCst), 0);
    assert!(!paths.active_attempt_file().exists());
}

#[tokio::test]
async fn compatible_legacy_command_still_claims_with_default_probe() {
    // run_daemon_with_hooks keeps working for explicit legacy command
    // executors even when the default Orca probe cannot confirm the launch
    // surface (the legacy command path does not need it).
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_legacy"],
        &["job_legacy_default"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_legacy".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), executable_legacy_command(&temp)).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
    )
    .await
    .unwrap();

    assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        claimed_job_ids.lock().unwrap().as_slice(),
        ["job_legacy_default"]
    );
}

/// Lock-boundary regression: the Orca Agent-aware launch-surface probe is
/// external process I/O and must NOT be awaited while the daemon holds the
/// Connector state.lock.
///
/// The injected fake Orca CLI attempts to acquire the state.lock during the
/// daemon's pre-claim admission flow and records whether acquisition
/// succeeded. A daemon that held state.lock across the async probe would
/// starve it (flock WouldBlock) and this test would fail.
#[cfg(unix)]
#[tokio::test]
async fn orca_capability_probe_is_not_awaited_under_state_lock() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    standard_target_handlers(
        &server,
        &["tgt_logical"],
        &["job_probe_lock"],
        claim_calls.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_logical".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    // Fake Orca CLI: every probe invocation logs, then tries a
    // non-blocking exclusive flock on the Connector state.lock (the same
    // lock primitive the daemon uses via ExecutionLock). It reports the
    // Agent-aware launch surface as AVAILABLE so the candidate is admitted
    // and the daemon reaches the immediate pre-ClaimIntent re-check under
    // the lock — where the pre-repair code re-probed Orca while holding the
    // lock (which the probe would record as lock-blocked).
    let probe_log = temp.path().join("probe.log");
    let state_lock = paths.state_lock_file();
    let script = format!(
        "#!/bin/sh\nprintf 'probe\\n' >> \"{log}\"\nif command -v flock >/dev/null 2>&1; then\n  if flock -x -n \"{lock}\" true 2>/dev/null; then\n    printf 'lock-acquired\\n' >> \"{log}\"\n  else\n    printf 'lock-blocked\\n' >> \"{log}\"\n  fi\nelse\n  printf 'flock-unavailable\\n' >> \"{log}\"\nfi\necho 'usage: orca orchestration worker-start --agent <id>'\n",
        log = probe_log.display(),
        lock = state_lock.display()
    );
    let probe_bin = temp.path().join("fake-orca");
    fs::write(&probe_bin, script).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&probe_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
        OrcaCliClient::new(probe_bin),
    )
    .await
    .unwrap();

    // The probe must have executed as part of the pre-claim admission flow.
    let log = fs::read_to_string(&probe_log).unwrap();
    assert!(
        log.contains("probe"),
        "Orca capability probe did not run during the pre-claim flow"
    );
    assert!(
        !log.contains("lock-blocked"),
        "the daemon held state.lock across the async Orca capability probe (lock-blocked)"
    );
    assert!(
        log.contains("lock-acquired") || log.contains("flock-unavailable"),
        "unexpected probe log: {log}"
    );

    // With the surface available, the logical-only executor claim proceeded
    // end-to-end — proving the under-lock pre-ClaimIntent re-check ran with
    // NO further external probe.
    assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
    let attempt = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("claim intent persisted and reconciled");
    assert_eq!(attempt.phase, AttemptPhase::Claimed);
    assert_eq!(attempt.job_id, "job_probe_lock");
}
