//! PROJECT-039: bounded operator-cancel convergence for server-connected
//! project mutations.
//!
//! When the server proves the exact local active attempt is terminal
//! CANCELLED, a stale `active-attempt.json` marker must converge durably and
//! let the project mutation proceed without manual file deletion or a daemon
//! run. Every ambiguous/offline/non-cancelled case stays fail-closed
//! TARGET_IN_USE with the local marker preserved. Daemon recovery and the
//! project path share one exact-cancel owner
//! (`crate::attempt_convergence`), so both produce the identical sanitized
//! operator-cancel history digest.

mod common;

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

use ceo_connector::client::ConnectorClient;
use ceo_connector::config::{
    normalize_server_origin, LocalConfig, LocalExecutorConfig, LocalTarget,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
use ceo_connector::outbox::operator_cancel_digest;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::{project_set, ProjectError};
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, ExecutionAdapter, PrepareOutcome,
    ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use ceo_connector::targets::TargetError;
use common::mock_server::{MockResponse, MockServer};
use uuid::Uuid;

// ---------------------------------------------------------------- fixtures

fn setup_test_env(
    raw_server_origin: &str,
) -> (tempfile::TempDir, ConnectorPaths, DeviceCredential) {
    let server_origin = normalize_server_origin(raw_server_origin).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server_origin.clone(),
        "usr_1".into(),
        "dev_mock".to_string(),
        "dcr_mock".to_string(),
        "sec_mock".to_string(),
        2_000_000_000_000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let target_dir = temp.path().join("mock_target_dir");
    std::fs::create_dir_all(&target_dir).unwrap();

    let mut config = LocalConfig::new(server_origin).unwrap();
    config.targets.insert(
        "tgt_mock".to_string(),
        LocalTarget {
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred)
}

fn make_waiting_attempt(cred: &DeviceCredential, attempt_id: String) -> ActiveAttempt {
    let job_id = "job_mock_1".to_string();
    let workspace_id = "ws_mock".to_string();
    let target_id = "tgt_mock".to_string();
    let prompt = "Do the thing".to_string();
    let acceptance = "It is done".to_string();
    let timeout = 60u32;
    let result_target = "none";
    let payload_sha256 = ActiveAttempt::compute_payload_sha256(
        &job_id,
        &workspace_id,
        &target_id,
        None,
        &prompt,
        &acceptance,
        timeout,
        result_target,
    );
    let now = chrono::Utc::now().timestamp_millis();
    let executor = AttemptExecutorState {
        executor_type: "orca".to_string(),
        orca_version: Some("1.4.209".to_string()),
        worktree_id: Some("wt_mock".to_string()),
        terminal_id: Some("term_mock".to_string()),
        agent_id: Some("agy".to_string()),
        agent_ready_at_ms: Some(now),
        dispatch_send_count: 1,
        last_dispatch_outcome: None,
        dispatch_started_at_ms: Some(now),
        execution_deadline_ms: Some(now + 60_000),
        dispatch_request_id: Some("req_mock".to_string()),
        dispatch_accepted_at_ms: Some(now),
        dispatch_turn_started: true,
        dispatch_baseline_state_started_at: None,
        turn_started_observed: true,
        structured_lifecycle_observed: true,
        runtime_completion_kind: None,
        runtime_completed_at_ms: None,
        runtime_error: None,
    };

    ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id,
        attempt_id,
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        device_id: cred.device_id.clone(),
        server_origin: cred.server_origin.clone(),
        phase: AttemptPhase::Waiting,
        workspace_id,
        target_id,
        resource_id: None,
        prompt: Some(prompt),
        acceptance: Some(acceptance),
        execution_timeout_seconds: Some(timeout),
        result_target: Some(result_target.to_string()),
        payload_sha256: Some(payload_sha256),
        claimed_at_ms: Some(now),
        terminal_report_sha256: None,
        frozen_agent_id: None,
        executor: Some(executor),
    }
}

fn job_detail_json(
    job_id: &str,
    state: &str,
    execution_status: Option<&str>,
    execution_attempt_id: Option<&str>,
) -> serde_json::Value {
    let mut detail = serde_json::json!({
        "job_id": job_id,
        "request_id": "req-1",
        "target_id": "tgt_mock",
        "target_alias": "mock-target",
        "state": state,
        "execution_status": execution_status,
        "business_outcome": execution_status,
        "created_at": "2026-09-29T00:00:00.000Z",
        "expires_at": null,
        "resource_id": null,
        "result_target": "none",
        "execution_timeout_seconds": 60
    });
    if let Some(attempt_id) = execution_attempt_id {
        detail["execution"] = serde_json::json!({
            "attempt_id": attempt_id,
            "phase": "claimed",
            "claimed_at": "2026-09-29T00:00:05.000Z",
            "started_at": null
        });
    }
    detail
}

fn serve_job_detail(server: &MockServer, detail: serde_json::Value) {
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.starts_with("/api/connector/jobs/job_mock_1") {
            return MockResponse::json(200, &detail);
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });
}

fn init_git_repo(path: &Path) {
    fs::create_dir_all(path).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .current_dir(path)
        .status()
        .unwrap()
        .success());
}

// ------------------------------------------------- project_set convergence

#[tokio::test]
async fn project_set_converges_when_server_cancelled_exact_attempt() {
    let server = MockServer::start().await;
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let detail = job_detail_json(
        "job_mock_1",
        "terminal",
        Some("CANCELLED"),
        Some(&attempt_id),
    );
    // Only the job detail is served: selector resolution falls back to the
    // direct-ID mapping in local config, so all guarded calls hit /jobs.
    serve_job_detail(&server, detail);

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let active = make_waiting_attempt(&cred, attempt_id.clone());
    active.save(&paths.active_attempt_file()).unwrap();

    let git_dir = paths
        .root_dir
        .parent()
        .unwrap()
        .join("replacement_checkout");
    init_git_repo(&git_dir);

    project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap();

    // The stale marker is gone without manual deletion.
    assert!(!paths.active_attempt_file().exists());

    // Durable sanitized operator-cancel history (same owner as the daemon).
    let hist_path = paths.history_file("job_mock_1", &attempt_id);
    let parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&hist_path).unwrap()).unwrap();
    assert_eq!(parsed["status"], "cancelled");
    assert_eq!(parsed["receipt_sha256"], serde_json::Value::Null);
    assert_eq!(
        parsed["terminal_report_sha256"],
        serde_json::Value::String(operator_cancel_digest("job_mock_1", &attempt_id))
    );

    // The mutation proceeded: local path updated on the existing executor.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let target = cfg.targets.get("tgt_mock").unwrap();
    assert_eq!(target.local_path, git_dir.to_string_lossy().to_string());
    assert_eq!(target.executor.as_ref().unwrap().agent_id, "agy");
}

#[tokio::test]
async fn project_set_fails_closed_on_server_attempt_identity_mismatch() {
    let server = MockServer::start().await;
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let detail = job_detail_json(
        "job_mock_1",
        "terminal",
        Some("CANCELLED"),
        Some("att-99999999-9999-9999-9999-999999999999"),
    );
    serve_job_detail(&server, detail);

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let active = make_waiting_attempt(&cred, attempt_id.clone());
    active.save(&paths.active_attempt_file()).unwrap();

    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-mismatch-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);

    let err = project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap_err();
    match &err {
        ProjectError::Target(TargetError::TargetInUseUnconverged { target_id, reason }) => {
            assert_eq!(target_id, "tgt_mock");
            assert!(
                reason.contains("server attempt") && reason.contains("local attempt"),
                "reason must be actionable, got: {reason}"
            );
        }
        other => panic!("expected fail-closed TargetInUseUnconverged, got: {other:?}"),
    }

    // Fail closed: marker preserved byte-for-byte in phase, no history.
    let still = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("marker must remain");
    assert_eq!(still.attempt_id, attempt_id);
    assert_eq!(still.phase, AttemptPhase::Waiting);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn project_set_fails_closed_on_non_terminal_job() {
    let server = MockServer::start().await;
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let detail = job_detail_json("job_mock_1", "running", None, Some(&attempt_id));
    serve_job_detail(&server, detail);

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let active = make_waiting_attempt(&cred, attempt_id.clone());
    active.save(&paths.active_attempt_file()).unwrap();

    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-nonterminal-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);

    let err = project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        err,
        ProjectError::Target(TargetError::TargetInUseUnconverged { .. })
    ));

    let still = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("marker must remain");
    assert_eq!(still.phase, AttemptPhase::Waiting);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn project_set_fails_closed_on_non_cancelled_terminal() {
    // A terminal FAILED job (with the exact attempt) may never be blindly
    // cleared by the convergence path: only operator CANCELLED converges.
    let server = MockServer::start().await;
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let detail = job_detail_json("job_mock_1", "terminal", Some("FAILED"), Some(&attempt_id));
    serve_job_detail(&server, detail);

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let mut active = make_waiting_attempt(&cred, attempt_id.clone());
    active.phase = AttemptPhase::RecoveryRequired;
    active.save(&paths.active_attempt_file()).unwrap();

    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-failed-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);

    let err = project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        err,
        ProjectError::Target(TargetError::TargetInUseUnconverged { .. })
    ));

    let still = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("marker must remain");
    assert_eq!(still.attempt_id, attempt_id);
    assert_eq!(still.phase, AttemptPhase::RecoveryRequired);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn project_set_fails_closed_when_server_unavailable() {
    let server = MockServer::start().await;
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.starts_with("/api/connector/jobs/job_mock_1") {
            return MockResponse {
                status: 503,
                headers: vec![],
                body: vec![],
            };
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let active = make_waiting_attempt(&cred, attempt_id.clone());
    active.save(&paths.active_attempt_file()).unwrap();

    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-offline-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);

    let err = project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(matches!(
        err,
        ProjectError::Target(TargetError::TargetInUseUnconverged { .. })
    ));

    let still = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("marker must remain");
    assert_eq!(still.attempt_id, attempt_id);
    assert_eq!(still.phase, AttemptPhase::Waiting);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn project_set_without_marker_keeps_behavior_and_adds_no_reads() {
    let server = MockServer::start().await;
    let seen = Arc::new(AtomicU32::new(0));
    let seen_c = seen.clone();
    // Serve nothing at all: no marker means zero reconciliation reads, and
    // selector resolution falls back to the local direct-ID mapping.
    server.add_handler(move |req| {
        if req.method == "GET" && req.path.starts_with("/api/connector/jobs/job_mock_1") {
            seen_c.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &job_detail_json("job_mock_1", "terminal", Some("CANCELLED"), None),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths, _cred) = setup_test_env(&server.origin());
    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-clean-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);

    project_set(
        &paths,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap();

    // The guarded mutation must never have reconciled anything server-side.
    assert_eq!(seen.load(Ordering::SeqCst), 0);

    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(
        cfg.targets.get("tgt_mock").unwrap().local_path,
        git_dir.to_string_lossy().to_string()
    );
}

// ---------------------------------- shared exact-cancel owner regression

#[derive(Default)]
struct NoopAdapter;

#[async_trait::async_trait]
impl ExecutionAdapter for NoopAdapter {
    fn name(&self) -> &'static str {
        "noop"
    }

    async fn is_ready(&self) -> bool {
        true
    }

    async fn prepare(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<PrepareOutcome, String> {
        Ok(PrepareOutcome::Ready(
            ceo_connector::scheduler::PreparedExecution {
                worktree_id: "wt".into(),
                terminal_id: "term".into(),
                orca_version: "1.4.209".into(),
                agent_id: "agy".into(),
                agent_ready_at_ms: None,
            },
        ))
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<ceo_connector::scheduler::DispatchReconciliation, String> {
        Ok(ceo_connector::scheduler::DispatchReconciliation::DefinitelyNotDispatched)
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<ceo_connector::scheduler::DispatchOutcome, String> {
        Ok(ceo_connector::scheduler::DispatchOutcome::Accepted {
            request_id: "req_mock".into(),
            accepted_at_ms: chrono::Utc::now().timestamp_millis(),
            turn_started: true,
        })
    }

    async fn wait(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _timeout: std::time::Duration,
    ) -> Result<ceo_connector::scheduler::WaitOutcome, String> {
        Ok(ceo_connector::scheduler::WaitOutcome::TuiIdle { elapsed_ms: 1 })
    }

    async fn interrupt(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<ceo_connector::scheduler::InterruptOutcome, String> {
        Ok(ceo_connector::scheduler::InterruptOutcome::Sent)
    }

    async fn close(&self, _terminal_id: &str) -> ceo_connector::scheduler::CleanupOutcome {
        ceo_connector::scheduler::CleanupOutcome::AlreadyAbsent {
            verified_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

#[tokio::test]
async fn daemon_recovery_and_project_convergence_share_exact_cancel_owner() {
    // The same mock truth serves both consumers of the shared owner.
    let server = MockServer::start().await;
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let detail = job_detail_json(
        "job_mock_1",
        "terminal",
        Some("CANCELLED"),
        Some(&attempt_id),
    );
    serve_job_detail(&server, detail);

    // Flow 1: the daemon recovery path drives a recovery_required attempt.
    let (_daemon_temp, paths_daemon, cred_daemon) = setup_test_env(&server.origin());
    let mut active = make_waiting_attempt(&cred_daemon, attempt_id.clone());
    active.phase = AttemptPhase::RecoveryRequired;
    active.save(&paths_daemon.active_attempt_file()).unwrap();

    let advanced = drive_active_attempt(
        &paths_daemon,
        &ConnectorClient::new(&cred_daemon.server_origin).unwrap(),
        &cred_daemon,
        &(Arc::new(NoopAdapter) as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    // Flow 2: project-side convergence for the same (job, attempt) truth.
    let (_project_temp, paths_project, cred_project) = setup_test_env(&server.origin());
    let mut project_marker = make_waiting_attempt(&cred_project, attempt_id.clone());
    project_marker.phase = AttemptPhase::Waiting;
    project_marker
        .save(&paths_project.active_attempt_file())
        .unwrap();
    let git_dir = std::env::temp_dir().join(format!("ceo-cvg-shared-{}", Uuid::new_v4()));
    init_git_repo(&git_dir);
    project_set(
        &paths_project,
        "tgt_mock",
        Some(&git_dir.to_string_lossy()),
        None,
        None,
    )
    .await
    .unwrap();

    // No marker survives on either path...
    assert!(!paths_daemon.active_attempt_file().exists());
    assert!(!paths_project.active_attempt_file().exists());

    // ...and BOTH wrote the sanitized operator-cancel history record from
    // the single shared owner: one exact-cancel truth, not separate tables.
    let daemon_hist: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(paths_daemon.history_file("job_mock_1", &attempt_id)).unwrap(),
    )
    .unwrap();
    let project_hist: serde_json::Value = serde_json::from_str(
        &fs::read_to_string(paths_project.history_file("job_mock_1", &attempt_id)).unwrap(),
    )
    .unwrap();

    let expected_digest = operator_cancel_digest("job_mock_1", &attempt_id);
    assert_eq!(daemon_hist["terminal_report_sha256"], expected_digest);
    assert_eq!(project_hist["terminal_report_sha256"], expected_digest);
    for field in [
        "schema_version",
        "job_id",
        "attempt_id",
        "target_id",
        "status",
    ] {
        assert_eq!(daemon_hist[field], project_hist[field]);
    }
    assert_eq!(daemon_hist["status"], "cancelled");
    assert_eq!(project_hist["status"], "cancelled");
}
