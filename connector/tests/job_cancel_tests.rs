//! Wave 2B: operator job cancel — client contract, CLI parsing/rendering,
//! live-runner interruption, and late-report/cancel race precedence.

mod common;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::cli::{Cli, Commands, JobSubcommands};
use ceo_connector::client::{CancelJobResponse, ConnectorClient};
use ceo_connector::config::{
    normalize_server_origin, LocalConfig, LocalExecutorConfig, LocalTarget,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
use ceo_connector::execution_contract::{BusinessOutcome, ExecutionReport, ExecutionStatus};
use ceo_connector::jobs::render_job_cancel;
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::outbox::{deliver_outbox_record, OutboxRecord};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, CleanupOutcome, DispatchOutcome,
    DispatchReconciliation, ExecutionAdapter, InterruptOutcome, PrepareOutcome, PreparedExecution,
    WaitOutcome, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use clap::Parser;
use common::mock_server::{MockResponse, MockServer};
use uuid::Uuid;

// ---------------------------------------------------------------- fixtures

fn cancelled_job_detail_json(job_id: &str) -> serde_json::Value {
    serde_json::json!({
        "job_id": job_id,
        "request_id": "req-1",
        "target_id": "tgt_mock",
        "target_alias": "mock-target",
        "state": "terminal",
        "execution_status": "CANCELLED",
        "business_outcome": "NOT_STARTED",
        "created_at": "2026-09-29T00:00:00.000Z",
        "expires_at": null,
        "resource_id": null,
        "result_target": "none",
        "execution_timeout_seconds": 60
    })
}

fn sample_report() -> ExecutionReport {
    ExecutionReport {
        schema_version: 2,
        execution_status: ExecutionStatus::COMPLETED,
        business_outcome: BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1700000001000,
        duration_ms: 1000,
        executor: ceo_connector::execution_contract::ExecutionReportExecutor {
            executor_type: "agent".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    }
}

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
        executor: Some(executor),
    }
}

#[derive(Default, Clone)]
struct MockAdapter {
    pub interrupt_calls: Arc<AtomicUsize>,
    pub wait_calls: Arc<AtomicUsize>,
}

#[async_trait::async_trait]
impl ExecutionAdapter for MockAdapter {
    fn name(&self) -> &'static str {
        "mock-orca"
    }

    async fn is_ready(&self) -> bool {
        true
    }

    async fn prepare(
        &self,
        _attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<PrepareOutcome, String> {
        Ok(PrepareOutcome::Ready(PreparedExecution {
            worktree_id: "wt".into(),
            terminal_id: "term".into(),
            orca_version: "1.4.209".into(),
            agent_id: "agy".into(),
            agent_ready_at_ms: None,
        }))
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        Ok(DispatchReconciliation::DefinitelyNotDispatched)
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        Ok(DispatchOutcome::Accepted {
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
    ) -> Result<WaitOutcome, String> {
        self.wait_calls.fetch_add(1, Ordering::SeqCst);
        Ok(WaitOutcome::TuiIdle { elapsed_ms: 1 })
    }

    async fn interrupt(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<InterruptOutcome, String> {
        self.interrupt_calls.fetch_add(1, Ordering::SeqCst);
        Ok(InterruptOutcome::Sent)
    }

    async fn close(&self, _terminal_id: &str) -> CleanupOutcome {
        CleanupOutcome::AlreadyAbsent {
            verified_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

// ------------------------------------------------------- client + contract

#[tokio::test]
async fn cancel_job_client_parses_typed_response() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.method == "POST" && req.path == "/api/connector/jobs/job-abc/cancel" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "job_id": "job-abc",
                    "previous_state": "running",
                    "state": "terminal",
                    "execution_status": "CANCELLED",
                    "business_outcome": "NOT_STARTED",
                    "action": "cancelled",
                    "attempt_id": "att-1",
                    "message": "Running attempt terminalized by operator cancel."
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let client = ConnectorClient::new(&server.origin()).unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "sec".into(),
        2_000_000_000_000,
    )
    .unwrap();

    let res = client.cancel_job(&cred, "job-abc").await.unwrap();
    assert_eq!(res.job_id, "job-abc");
    assert_eq!(res.previous_state, "running");
    assert_eq!(res.state, "terminal");
    assert_eq!(res.execution_status.as_deref(), Some("CANCELLED"));
    assert_eq!(res.action, "cancelled");
    assert_eq!(res.attempt_id.as_deref(), Some("att-1"));

    // Exactly one POST to the cancel endpoint, empty JSON body.
    let reqs = server.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!(reqs[0].method, "POST");
    assert!(reqs[0].path.ends_with("/cancel"));
}

#[tokio::test]
async fn cancel_job_client_maps_404_to_job_not_found() {
    let server = MockServer::start().await;
    let client = ConnectorClient::new(&server.origin()).unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "sec".into(),
        2_000_000_000_000,
    )
    .unwrap();

    let err = client.cancel_job(&cred, "job-missing").await.unwrap_err();
    match err {
        ceo_connector::client::ClientError::JobError { code, .. } => {
            assert_eq!(code, "JOB_NOT_FOUND");
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

// ------------------------------------------------------------ CLI parsing

#[test]
fn cli_parses_job_cancel() {
    let cli = Cli::try_parse_from(["ceo-connector", "job", "cancel", "job-327cac97"]).unwrap();
    match cli.command {
        Commands::Job {
            sub: JobSubcommands::Cancel { job_id, json },
        } => {
            assert_eq!(job_id, "job-327cac97");
            assert!(!json);
        }
        other => panic!("unexpected parse: {other:?}"),
    }

    let cli = Cli::try_parse_from(["ceo-connector", "job", "cancel", "job-1", "--json"]).unwrap();
    match cli.command {
        Commands::Job {
            sub: JobSubcommands::Cancel { job_id, json },
        } => {
            assert_eq!(job_id, "job-1");
            assert!(json);
        }
        other => panic!("unexpected parse: {other:?}"),
    }
}

// ---------------------------------------------------------- CLI rendering

#[test]
fn render_job_cancel_cancelled_block() {
    let res = CancelJobResponse {
        job_id: "job-abc".into(),
        previous_state: "running".into(),
        state: "terminal".into(),
        execution_status: Some("CANCELLED".into()),
        business_outcome: Some("NOT_STARTED".into()),
        action: "cancelled".into(),
        attempt_id: Some("att-1".into()),
        message: "Running attempt terminalized by operator cancel.".into(),
    };
    let out = render_job_cancel(&res);
    assert!(out.contains("Job cancel\n"));
    assert!(out.contains("ID: job-abc"));
    assert!(out.contains("Previous state: running"));
    assert!(out.contains("State: terminal"));
    assert!(out.contains("Execution status: CANCELLED"));
    assert!(out.contains("Attempt: att-1"));
    assert!(out.contains("Result: cancelled"));
    assert!(!out.contains("|")); // vertical block, never a wide table
}

#[test]
fn render_job_cancel_already_terminal_block() {
    let res = CancelJobResponse {
        job_id: "job-abc".into(),
        previous_state: "terminal".into(),
        state: "terminal".into(),
        execution_status: Some("COMPLETED".into()),
        business_outcome: Some("VERIFIED".into()),
        action: "already_terminal".into(),
        attempt_id: Some("att-1".into()),
        message: "Job already terminal (COMPLETED); history preserved.".into(),
    };
    let out = render_job_cancel(&res);
    assert!(out.contains("Result: already terminal; history preserved"));
    assert!(out.contains("Execution status: COMPLETED"));
}

#[test]
fn render_job_cancel_already_cancelled_block() {
    let res = CancelJobResponse {
        job_id: "job-abc".into(),
        previous_state: "terminal".into(),
        state: "terminal".into(),
        execution_status: Some("CANCELLED".into()),
        business_outcome: Some("NOT_STARTED".into()),
        action: "already_cancelled".into(),
        attempt_id: None,
        message: "Job was already operator-cancelled.".into(),
    };
    let out = render_job_cancel(&res);
    assert!(out.contains("Result: already cancelled (no change)"));
    assert!(out.contains("Attempt: <none>"));
}

// ------------------------------------------- live runner observes cancel

#[tokio::test]
async fn live_waiting_attempt_observes_operator_cancel_and_interrupts() {
    let server = MockServer::start().await;
    let detail = cancelled_job_detail_json("job_mock_1");
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

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let active = make_waiting_attempt(&cred, attempt_id.clone());
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter::default());
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let advanced = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    // Live runner interrupted through the existing adapter path.
    assert_eq!(adapter.interrupt_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 0);

    // Local active attempt converged (stale/running cleanup).
    assert!(!paths.active_attempt_file().exists());

    // Sanitized history records the operator-cancelled outcome.
    let hist = paths.history_file("job_mock_1", &attempt_id);
    let content = std::fs::read_to_string(&hist).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&content).unwrap();
    assert_eq!(parsed["status"], "cancelled");
    assert_eq!(parsed["receipt_sha256"], serde_json::Value::Null);
    assert!(parsed["terminal_report_sha256"].is_string());
}

fn cancelled_job_detail_json_with_attempt(job_id: &str, attempt_id: &str) -> serde_json::Value {
    let mut detail = cancelled_job_detail_json(job_id);
    detail["execution"] = serde_json::json!({
        "attempt_id": attempt_id,
        "phase": "claimed",
        "claimed_at": "2026-09-29T00:00:05.000Z",
        "started_at": null
    });
    detail
}

// ------------------------- recovery_required -> server-cancel convergence

async fn drive_recovery_required_attempt(
    server: &MockServer,
    attempt_id: &str,
) -> (
    tempfile::TempDir,
    ConnectorPaths,
    Result<bool, ceo_connector::daemon::DaemonError>,
) {
    let (temp, paths, cred) = setup_test_env(&server.origin());
    let mut active = make_waiting_attempt(&cred, attempt_id.to_string());
    active.phase = AttemptPhase::RecoveryRequired;
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter::default());
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let res = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;
    (temp, paths, res)
}

#[tokio::test]
async fn recovery_required_converges_when_server_cancelled_exact_attempt() {
    let server = MockServer::start().await;
    let attempt_id = "att-7a8140bc-1dec-43be-90fe-91eab39864eb".to_string();
    let detail = cancelled_job_detail_json_with_attempt("job_mock_1", &attempt_id);
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

    let (_temp, paths, res) = drive_recovery_required_attempt(&server, &attempt_id).await;
    let advanced = res.unwrap();
    assert!(advanced);

    // Local durable active attempt cleaned up without manual deletion.
    assert!(!paths.active_attempt_file().exists());

    // Reuses operator-cancel finalization semantics: sanitized cancelled history.
    let hist = paths.history_file("job_mock_1", &attempt_id);
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&hist).unwrap()).unwrap();
    assert_eq!(parsed["status"], "cancelled");
    assert_eq!(parsed["receipt_sha256"], serde_json::Value::Null);
    assert!(parsed["terminal_report_sha256"].is_string());
}

#[tokio::test]
async fn recovery_required_stays_blocked_on_server_attempt_mismatch() {
    let server = MockServer::start().await;
    let detail =
        cancelled_job_detail_json_with_attempt("job_mock_1", "att-other-0000-0000-000000000000");
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

    let attempt_id = "att-7a8140bc-1dec-43be-90fe-91eab39864eb".to_string();
    let (_temp, paths, res) = drive_recovery_required_attempt(&server, &attempt_id).await;
    match res.unwrap_err() {
        ceo_connector::daemon::DaemonError::RecoveryRequired(_) => {}
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }

    // Fail closed: attempt remains durable, no cancellation history written.
    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("active attempt must remain blocked");
    assert_eq!(active.attempt_id, attempt_id);
    assert_eq!(active.phase, AttemptPhase::RecoveryRequired);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn recovery_required_stays_blocked_on_non_cancelled_terminal() {
    let server = MockServer::start().await;
    let attempt_id = "att-7a8140bc-1dec-43be-90fe-91eab39864eb".to_string();
    let mut detail = cancelled_job_detail_json_with_attempt("job_mock_1", &attempt_id);
    detail["execution_status"] = serde_json::json!("COMPLETED");
    detail["business_outcome"] = serde_json::json!("VERIFIED");
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

    let (_temp, paths, res) = drive_recovery_required_attempt(&server, &attempt_id).await;
    match res.unwrap_err() {
        ceo_connector::daemon::DaemonError::RecoveryRequired(_) => {}
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }

    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("active attempt must remain blocked");
    assert_eq!(active.attempt_id, attempt_id);
    assert_eq!(active.phase, AttemptPhase::RecoveryRequired);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn recovery_required_stays_blocked_when_attempt_identity_ambiguous() {
    let server = MockServer::start().await;
    // Terminal CANCELLED but missing execution part: attempt identity is
    // ambiguous, so the local attempt must stay blocked.
    let detail = cancelled_job_detail_json("job_mock_1");
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

    let attempt_id = "att-7a8140bc-1dec-43be-90fe-91eab39864eb".to_string();
    let (_temp, paths, res) = drive_recovery_required_attempt(&server, &attempt_id).await;
    match res.unwrap_err() {
        ceo_connector::daemon::DaemonError::RecoveryRequired(_) => {}
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }

    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("active attempt must remain blocked");
    assert_eq!(active.attempt_id, attempt_id);
    assert_eq!(active.phase, AttemptPhase::RecoveryRequired);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

#[tokio::test]
async fn recovery_required_stays_blocked_on_transport_failure() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
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

    let attempt_id = "att-7a8140bc-1dec-43be-90fe-91eab39864eb".to_string();
    let (_temp, paths, res) = drive_recovery_required_attempt(&server, &attempt_id).await;
    match res.unwrap_err() {
        ceo_connector::daemon::DaemonError::RecoveryRequired(_) => {}
        other => panic!("expected RecoveryRequired, got {other:?}"),
    }

    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("active attempt must remain blocked");
    assert_eq!(active.attempt_id, attempt_id);
    assert_eq!(active.phase, AttemptPhase::RecoveryRequired);
    assert!(!paths.history_file("job_mock_1", &attempt_id).exists());
}

// ------------------------------------ late report vs operator cancel race

#[tokio::test]
async fn late_report_after_operator_cancel_converges_without_overwrite() {
    let server = MockServer::start().await;
    let detail = cancelled_job_detail_json("job_mock_1");
    server.add_handler(move |req| {
        if req.method == "POST" && req.path.contains("/report") {
            // Server authoritatively cancelled: late report must conflict.
            return MockResponse::json(
                409,
                &serde_json::json!({
                    "error": "REPORT_CONFLICT",
                    "message": "Job is already terminal."
                }),
            );
        }
        if req.method == "GET" && req.path.starts_with("/api/connector/jobs/job_mock_1") {
            return MockResponse::json(200, &detail);
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths, cred) = setup_test_env(&server.origin());
    let attempt_id = "att-00000000-0000-0000-0000-000000000010".to_string();

    let report = sample_report();
    let record = OutboxRecord {
        schema_version: ceo_connector::outbox::OUTBOX_SCHEMA_VERSION,
        server_origin: server.origin(),
        device_id: "dev_mock".into(),
        job_id: "job_mock_1".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        report,
        managed_result: None,
        managed_result_sha256: None,
        created_at_ms: 1000,
    };
    let outbox_file = paths.outbox_file("job_mock_1", &attempt_id);
    record.save(&outbox_file).unwrap();

    // Plant the finalized-local active attempt so target_id correlation works.
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_mock",
            "job_id": "job_mock_1",
            "workspace_id": "ws_mock",
            "target_id": "tgt_mock",
            "attempt_id": attempt_id,
            "claim_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "finalized_local",
            "terminal_report_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "executor": null
        }),
    )
    .unwrap();

    let client = ConnectorClient::new(&cred.server_origin).unwrap();
    deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap();

    // The late report is dropped in favor of the authoritative cancel...
    assert!(!outbox_file.exists());
    assert!(!paths.active_attempt_file().exists());

    // ...and a cancelled history record is persisted instead of COMPLETED.
    let hist = paths.history_file("job_mock_1", &attempt_id);
    let parsed: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&hist).unwrap()).unwrap();
    assert_eq!(parsed["status"], "cancelled");
}
