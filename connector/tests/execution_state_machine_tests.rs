mod common;

use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ceo_connector::client::ConnectorClient;
use ceo_connector::config::{
    normalize_server_origin, LocalConfig, LocalExecutorConfig, LocalTarget,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
use ceo_connector::execution_contract::{
    BusinessOutcome, ExecutionReport, ExecutionReportError, ExecutionStatus,
};
use ceo_connector::local_state::ExecutionLock;
use ceo_connector::outbox::{OutboxRecord, OUTBOX_SCHEMA_VERSION};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, CleanupOutcome, DispatchOutcome,
    DispatchReconciliation, ExecutionAdapter, InterruptOutcome, PrepareOutcome, PreparedExecution,
    WaitOutcome, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use common::mock_server::{MockResponse, MockServer};
use uuid::Uuid;

#[derive(Clone, Default)]
struct MockAdapter {
    pub ready: bool,
    pub prepare_result: Option<Result<PrepareOutcome, String>>,
    pub reconcile_result: Option<Result<DispatchReconciliation, String>>,
    pub dispatch_result: Option<Result<DispatchOutcome, String>>,
    pub wait_result: Option<Result<WaitOutcome, String>>,
    pub close_result: Option<CleanupOutcome>,

    pub prepare_calls: Arc<AtomicUsize>,
    pub reconcile_calls: Arc<AtomicUsize>,
    pub dispatch_calls: Arc<AtomicUsize>,
    pub wait_calls: Arc<AtomicUsize>,
    pub close_calls: Arc<AtomicUsize>,
    pub interrupt_calls: Arc<AtomicUsize>,

    pub on_wait: Option<Arc<dyn Fn() + Send + Sync>>,
    pub wait_seq: Arc<std::sync::Mutex<Vec<Result<WaitOutcome, String>>>>,
}

#[async_trait]
impl ExecutionAdapter for MockAdapter {
    fn name(&self) -> &'static str {
        "mock-orca"
    }

    async fn is_ready(&self) -> bool {
        self.ready
    }

    async fn prepare(
        &self,
        attempt: &ActiveAttempt,
        _target: &LocalTarget,
    ) -> Result<PrepareOutcome, String> {
        self.prepare_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(ref res) = self.prepare_result {
            res.clone()
        } else {
            Ok(PrepareOutcome::Ready(PreparedExecution {
                worktree_id: format!("wt_{}", attempt.attempt_id),
                terminal_id: format!("term_{}", attempt.attempt_id),
                orca_version: "1.4.209".into(),
                agent_id: "agy".into(),
                agent_ready_at_ms: Some(chrono::Utc::now().timestamp_millis()),
            }))
        }
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        self.reconcile_calls.fetch_add(1, Ordering::SeqCst);
        self.reconcile_result
            .clone()
            .unwrap_or(Ok(DispatchReconciliation::DefinitelyNotDispatched))
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        self.dispatch_result.clone().unwrap_or_else(|| {
            Ok(DispatchOutcome::Accepted {
                request_id: "req_mock_123".into(),
                accepted_at_ms: chrono::Utc::now().timestamp_millis(),
                turn_started: true,
            })
        })
    }

    async fn wait(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _remaining_timeout: Duration,
    ) -> Result<WaitOutcome, String> {
        self.wait_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(ref cb) = self.on_wait {
            cb();
        }
        if let Ok(mut seq) = self.wait_seq.lock() {
            if !seq.is_empty() {
                return seq.remove(0);
            }
        }
        self.wait_result
            .clone()
            .unwrap_or(Ok(WaitOutcome::TuiIdle { elapsed_ms: 100 }))
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
        self.close_calls.fetch_add(1, Ordering::SeqCst);
        self.close_result
            .clone()
            .unwrap_or(CleanupOutcome::VerifiedClosed {
                closed_at_ms: chrono::Utc::now().timestamp_millis(),
            })
    }
}

fn setup_test_env(
    raw_server_origin: &str,
) -> (
    tempfile::TempDir,
    ConnectorPaths,
    DeviceCredential,
    LocalConfig,
) {
    let server_origin = normalize_server_origin(raw_server_origin).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
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
    fs::create_dir_all(&target_dir).unwrap();

    let mut config = LocalConfig::new(server_origin).unwrap();
    config.targets.insert(
        "tgt_mock".to_string(),
        LocalTarget {
            workspace_id: "ws_mock".to_string(),
            alias: "mock-target".to_string(),
            kind: "general_automation".to_string(),
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred, config)
}

fn make_default_executor(kind: &str, ver: &str) -> AttemptExecutorState {
    AttemptExecutorState {
        executor_type: kind.to_string(),
        orca_version: Some(ver.to_string()),
        worktree_id: None,
        terminal_id: None,
        agent_id: Some("agy".to_string()),
        agent_ready_at_ms: Some(1727220000000),
        dispatch_send_count: 0,
        last_dispatch_outcome: None,
        dispatch_started_at_ms: None,
        execution_deadline_ms: None,
        dispatch_request_id: None,
        dispatch_accepted_at_ms: None,
        dispatch_turn_started: false,
        dispatch_baseline_state_started_at: None,
        turn_started_observed: false,
        runtime_completion_kind: None,
        runtime_completed_at_ms: None,
        runtime_error: None,
    }
}

fn make_test_attempt(
    cred: &DeviceCredential,
    attempt_id: String,
    phase: AttemptPhase,
    result_target: &str,
    executor: Option<AttemptExecutorState>,
) -> ActiveAttempt {
    make_test_attempt_with_resource(cred, attempt_id, phase, result_target, None, executor)
}

fn make_test_attempt_with_resource(
    cred: &DeviceCredential,
    attempt_id: String,
    phase: AttemptPhase,
    result_target: &str,
    resource_id: Option<&str>,
    executor: Option<AttemptExecutorState>,
) -> ActiveAttempt {
    let job_id = "job_mock_1".to_string();
    let workspace_id = "ws_mock".to_string();
    let target_id = "tgt_mock".to_string();
    let prompt = "Create a simple calculator".to_string();
    let acceptance = "Calculator should add numbers".to_string();
    let timeout = 60u32;
    let payload_sha256 = ActiveAttempt::compute_payload_sha256(
        &job_id,
        &workspace_id,
        &target_id,
        resource_id,
        &prompt,
        &acceptance,
        timeout,
        result_target,
    );

    ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id,
        attempt_id,
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        device_id: cred.device_id.clone(),
        server_origin: cred.server_origin.clone(),
        phase,
        workspace_id,
        target_id,
        resource_id: resource_id.map(|s| s.to_string()),
        prompt: Some(prompt),
        acceptance: Some(acceptance),
        execution_timeout_seconds: Some(timeout),
        result_target: Some(result_target.to_string()),
        payload_sha256: Some(payload_sha256),
        claimed_at_ms: Some(1727000000000),
        terminal_report_sha256: None,
        executor,
    }
}

/// 1. Happy Path Execution:
/// Claimed -> /start -> Prepare -> Dispatch -> Wait (tui-idle) -> OutcomeRecorded -> Outbox delivery
#[tokio::test]
async fn test_happy_path_execution_to_outbox() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_uuid = Uuid::new_v4();
    let attempt_id = format!("att-{}", attempt_uuid);
    let attempt_id_clone = attempt_id.clone();

    let start_called = Arc::new(AtomicUsize::new(0));
    let report_called = Arc::new(AtomicUsize::new(0));
    let start_called_clone = start_called.clone();
    let report_called_clone = report_called.clone();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_mock", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_mock", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }

        if req.path.contains("/start") && req.method == "POST" {
            start_called_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": attempt_id_clone,
                        "phase": "started",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            );
        }

        if req.path == "/api/connector/reports" && req.method == "POST" {
            report_called_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:10.000Z",
                    "attempt": {
                        "attempt_id": attempt_id_clone,
                        "phase": "finished",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            );
        }

        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let active = make_test_attempt(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Claimed,
        "none",
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Drive step-by-step through entire lifecycle to FinalizedLocal:
    loop {
        let current = ActiveAttempt::load(&paths.active_attempt_file())
            .unwrap()
            .unwrap();
        if current.phase == AttemptPhase::FinalizedLocal {
            break;
        }
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
    }

    // Verify invocations across all stages
    assert_eq!(start_called.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 1);

    // Verify outbox record created
    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::COMPLETED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::UNVERIFIED);
    assert!(record.report.task_dispatched);
    assert!(record.report.error.is_none());
}

/// 2. V1.8 result_target = "resource" execution & collection:
/// Successfully completes lifecycle, writes /start, collects managed-result.json, and persists into outbox.
#[tokio::test]
async fn test_resource_result_target_executes_and_collects_managed_result() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let start_called = Arc::new(AtomicUsize::new(0));
    let start_called_clone = start_called.clone();

    server.add_handler(move |req| {
        if req.path.contains("/start") {
            start_called_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": "any",
                        "phase": "started",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Claimed,
        "resource",
        Some("res_mock_1"),
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let paths_clone = paths.clone();
    let attempt_id_clone = attempt_id.clone();
    let adapter = Arc::new(MockAdapter {
        ready: true,
        on_wait: Some(Arc::new(move || {
            let result_file = paths_clone.managed_result_file(&attempt_id_clone);
            fs::create_dir_all(result_file.parent().unwrap()).unwrap();
            let envelope = serde_json::json!({
                "schema_version": 1,
                "job_id": "job_mock_1",
                "attempt_id": attempt_id_clone,
                "resource_id": "res_mock_1",
                "summary": "Updated resource content",
                "operations": [
                    {
                        "op": "upsert_content",
                        "content": "new body"
                    }
                ]
            });
            fs::write(&result_file, serde_json::to_vec(&envelope).unwrap()).unwrap();
        })),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    loop {
        let current = ActiveAttempt::load(&paths.active_attempt_file())
            .unwrap()
            .unwrap();
        if current.phase == AttemptPhase::FinalizedLocal {
            break;
        }
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
    }

    assert_eq!(start_called.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 1);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::COMPLETED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::UNVERIFIED);
    assert!(record.report.task_dispatched);
    assert!(record.report.error.is_none());

    let res = record
        .managed_result
        .expect("managed result must be attached");
    assert_eq!(res.resource_id, "res_mock_1");
    assert_eq!(res.summary, "Updated resource content");
    assert!(record.managed_result_sha256.is_some());
}

/// 2b. V1.8 result_target = "resource" missing result fails closed:
/// If runtime finishes with tui_idle but managed-result.json is missing, execution marks FAILED.
#[tokio::test]
async fn test_resource_result_target_missing_result_fails_closed() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let start_called = Arc::new(AtomicUsize::new(0));
    let start_called_clone = start_called.clone();

    server.add_handler(move |req| {
        if req.path.contains("/start") {
            start_called_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": "any",
                        "phase": "started",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Claimed,
        "resource",
        Some("res_mock_1"),
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    loop {
        let current = ActiveAttempt::load(&paths.active_attempt_file())
            .unwrap()
            .unwrap();
        if current.phase == AttemptPhase::FinalizedLocal {
            break;
        }
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
    }

    assert_eq!(start_called.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 0);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::FAILED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::FAILED);
    assert!(record.report.task_dispatched);
    assert!(record.managed_result.is_none());

    let err = record.report.error.expect("expected error details");
    assert_eq!(err.code, "RESULT_MISSING");
    assert_eq!(err.stage, "result");
}

/// 3. OutcomeRecorded Crash Recovery:
/// Restart at OutcomeRecorded phase must NOT call wait() or dispatch() again; reconstructs report from durable state.
#[tokio::test]
async fn test_outcome_recorded_crash_recovery_skips_wait_and_dispatch() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(1727000000000);
    executor_state.execution_deadline_ms = Some(1727000060000);
    executor_state.dispatch_request_id = Some("req_mock".into());
    executor_state.dispatch_send_count = 1;
    executor_state.runtime_completion_kind = Some("tui_idle".into());
    executor_state.runtime_completed_at_ms = Some(1727000010000);

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::OutcomeRecorded,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
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

    // Verify wait and dispatch were NEVER called
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    // Terminal close is called
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 1);

    // Outbox record was created
    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::COMPLETED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::UNVERIFIED);
}

/// 4. Durable Execution Deadline Across Restart:
/// If deadline expired before/during recovery, mark TIMED_OUT immediately without waiting.
#[tokio::test]
async fn test_durable_deadline_expired_marks_timed_out_without_waiting() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(now - 60_000);
    executor_state.execution_deadline_ms = Some(now - 1_000); // 1s in the past!
    executor_state.dispatch_request_id = Some("req_mock".into());
    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Waiting,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Waiting with expired deadline -> marks OutcomeRecorded
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

    // Adapter wait was NOT invoked because remaining budget was <= 0
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 0);

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::OutcomeRecorded);
    let exec = a.executor.unwrap();
    assert_eq!(exec.runtime_completion_kind.as_deref(), Some("timed_out"));

    // Step 3: OutcomeRecorded -> writes outbox
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

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::TIMED_OUT);
    assert_eq!(record.report.business_outcome, BusinessOutcome::UNVERIFIED);
}

/// 5. Dispatch Retry Budget & Terminal Rejection:
/// Two rejected sends exhaust the max-2 send budget. Transitions to FinalizedLocal with BLOCKED outbox.
#[tokio::test]
async fn test_dispatch_retry_budget_exhaustion_fails_closed() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(chrono::Utc::now().timestamp_millis());
    executor_state.execution_deadline_ms = Some(chrono::Utc::now().timestamp_millis() + 60_000);
    executor_state.dispatch_send_count = 2; // Budget of 2 already exhausted!
    executor_state.last_dispatch_outcome = Some("known_rejected".into());

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Prepared,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        reconcile_result: Some(Ok(DispatchReconciliation::DefinitelyNotDispatched)),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Prepared -> DispatchIntent
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

    // Step 2: DispatchIntent checks send_count >= 2 -> transitions to FinalizedLocal and writes BLOCKED outbox
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

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::OutcomeRecorded);

    // Step: OutcomeRecorded -> FinalizedLocal with verified cleanup
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

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::FinalizedLocal);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();
    assert_eq!(record.report.execution_status, ExecutionStatus::BLOCKED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::NOT_STARTED);
    assert!(!record.report.task_dispatched);
    assert_eq!(
        record.report.error.as_ref().map(|e| e.code.as_str()),
        Some("DISPATCH_REJECTED")
    );
}

/// 6. Ambiguous Dispatch Fails Closed:
/// When dispatch reconcile returns Ambiguous and send count > 0, fail closed to RECOVERY_REQUIRED.
#[tokio::test]
async fn test_ambiguous_dispatch_fails_closed() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(chrono::Utc::now().timestamp_millis());
    executor_state.execution_deadline_ms = Some(chrono::Utc::now().timestamp_millis() + 60_000);
    executor_state.dispatch_send_count = 1;
    executor_state.dispatch_request_id = None;

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Prepared,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        reconcile_result: Some(Ok(DispatchReconciliation::Ambiguous)),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Prepared -> DispatchIntent
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

    // Step 2: DispatchIntent reconcile returns Ambiguous -> RecoveryRequired
    let res = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;

    assert!(res.is_err());
    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::RecoveryRequired);
}

/// 7. Zero Lock Contention Across External I/O:
/// Verify state.lock can be acquired concurrently by another thread while adapter wait() is ongoing.
#[tokio::test]
async fn test_zero_lock_contention_during_adapter_wait() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(chrono::Utc::now().timestamp_millis());
    executor_state.execution_deadline_ms = Some(chrono::Utc::now().timestamp_millis() + 60_000);
    executor_state.dispatch_request_id = Some("req_mock".into());
    executor_state.dispatch_send_count = 1;

    // Start in Waiting phase so adapter.wait() is directly invoked
    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Waiting,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let paths_clone = paths.clone();
    let lock_acquired_during_wait = Arc::new(AtomicBool::new(false));
    let lock_acquired_clone = lock_acquired_during_wait.clone();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        on_wait: Some(Arc::new(move || {
            // While inside adapter.wait(), test that state.lock can be acquired!
            let lock_res = ExecutionLock::acquire(&paths_clone.state_lock_file());
            if lock_res.is_ok() {
                lock_acquired_clone.store(true, Ordering::SeqCst);
            }
        })),
        ..Default::default()
    });
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

    assert!(
        lock_acquired_during_wait.load(Ordering::SeqCst),
        "state.lock must NOT be held while adapter.wait() is running!"
    );
}

/// 8. Prepare Crash & Terminal Adoption:
/// If a terminal with marker "ceo:<attempt_id>" exists, prepare adopts it cleanly.
#[tokio::test]
async fn test_prepare_terminal_adoption() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let active = make_test_attempt(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Claimed,
        "none",
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    // Adapter returns existing adopted terminal ID
    let adapter = Arc::new(MockAdapter {
        ready: true,
        prepare_result: Some(Ok(PrepareOutcome::Ready(PreparedExecution {
            worktree_id: "wt_existing".into(),
            terminal_id: "term_adopted_123".into(),
            orca_version: "1.4.209".into(),
            agent_id: "agy".into(),
            agent_ready_at_ms: Some(1727220000000),
        }))),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Claimed -> PrepareIntent
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

    // Step 2: PrepareIntent -> calls adapter.prepare() -> Prepared
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

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::Prepared);
    assert_eq!(
        a.executor.as_ref().unwrap().terminal_id.as_deref(),
        Some("term_adopted_123")
    );
    assert_eq!(
        a.executor.as_ref().unwrap().worktree_id.as_deref(),
        Some("wt_existing")
    );
}

/// 9. Legacy "running" fails closed on both V1 and V2 schema:
/// Never transitions to Started; maps directly to RecoveryRequired; zero prepare/dispatch/wait invocations.
#[tokio::test]
async fn test_legacy_running_migration_fails_closed_without_execution() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let prompt = "task prompt".to_string();
    let acceptance = "task acceptance".to_string();
    let payload_sha256 = ActiveAttempt::compute_payload_sha256(
        "job_1",
        "ws_1",
        "tgt_1",
        None,
        &prompt,
        &acceptance,
        60,
        "none",
    );

    // Case A: V1 JSON with phase "running"
    let v1_json = serde_json::json!({
        "schema_version": 1,
        "server_origin": cred.server_origin,
        "device_id": cred.device_id,
        "job_id": "job_1",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": attempt_id,
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "running",
        "prompt": prompt,
        "acceptance": acceptance,
        "execution_timeout_seconds": 60,
        "result_target": "none",
        "payload_sha256": payload_sha256,
        "claimed_at_ms": 1727000000000i64
    });
    fs::write(
        paths.active_attempt_file(),
        serde_json::to_string(&v1_json).unwrap(),
    )
    .unwrap();

    let load_v1_err = ActiveAttempt::load(&paths.active_attempt_file()).unwrap_err();
    assert!(matches!(
        load_v1_err,
        ceo_connector::scheduler::SchedulerError::UnsupportedSchemaVersion(1)
    ));

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let res = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;
    assert!(res.is_err());
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.wait_calls.load(Ordering::SeqCst), 0);

    // Case B: V2 JSON fails with UnsupportedSchemaVersion(2)
    let v2_json = serde_json::json!({
        "schema_version": 2,
        "server_origin": cred.server_origin,
        "device_id": cred.device_id,
        "job_id": "job_1",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": attempt_id,
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "running",
        "prompt": prompt,
        "acceptance": acceptance,
        "execution_timeout_seconds": 60,
        "result_target": "none",
        "payload_sha256": payload_sha256,
        "claimed_at_ms": 1727000000000i64,
        "executor": null
    });
    fs::write(
        paths.active_attempt_file(),
        serde_json::to_string(&v2_json).unwrap(),
    )
    .unwrap();

    let load_v2_err = ActiveAttempt::load(&paths.active_attempt_file()).unwrap_err();
    assert!(matches!(
        load_v2_err,
        ceo_connector::scheduler::SchedulerError::UnsupportedSchemaVersion(2)
    ));

    let res_v2 = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;
    assert!(res_v2.is_err());
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);
}

/// 10. Interrupted runtime outcome semantics:
/// Maps to INTERRUPTED / UNVERIFIED / task_dispatched=true with TERMINAL_INTERRUPTED error details.
#[tokio::test]
async fn test_interrupted_runtime_outcome_semantics() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(now);
    executor_state.execution_deadline_ms = Some(now + 60_000);
    executor_state.dispatch_request_id = Some("req_mock".into());
    executor_state.dispatch_send_count = 1;

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Waiting,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        wait_result: Some(Ok(WaitOutcome::Interrupted {
            reason: "terminal exited unexpectedly".into(),
        })),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Waiting -> OutcomeRecorded
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

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::OutcomeRecorded);
    let exec = a.executor.as_ref().unwrap();
    assert_eq!(exec.runtime_completion_kind.as_deref(), Some("interrupted"));

    // Step 2: OutcomeRecorded -> writes outbox -> FinalizedLocal
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

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::FAILED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::FAILED);
    assert!(record.report.task_dispatched);
    let err = record.report.error.expect("expected error details");
    assert_eq!(err.stage, "runtime");
    assert_eq!(err.code, "TERMINAL_EXITED");
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 0);
}

/// 11. /start Permanent Error Fails Closed:
/// When Server returns permanent errors (e.g. INVALID_ATTEMPT_PHASE), Connector transitions to RecoveryRequired.
#[tokio::test]
async fn test_start_permanent_error_fails_closed_to_recovery_required() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    server.add_handler(move |req| {
        if req.path.contains("/start") {
            MockResponse::json(
                400,
                &serde_json::json!({
                    "ok": false,
                    "error": { "code": "INVALID_ATTEMPT_PHASE", "message": "Job phase is not claimed" }
                }),
            )
        } else {
            MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
        }
    });

    let active = make_test_attempt(&cred, attempt_id, AttemptPhase::StartIntent, "none", None);
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let res = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;
    assert!(res.is_err());

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::RecoveryRequired);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 0);
}

/// 12. /start Malformed ACK Fails Closed:
/// When Server returns invalid server_time, Connector transitions to RecoveryRequired.
#[tokio::test]
async fn test_start_malformed_timestamp_fails_closed() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    server.add_handler(move |req| {
        if req.path.contains("/start") {
            MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "invalid_date_format",
                    "attempt": {
                        "attempt_id": "att_1",
                        "phase": "started",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            )
        } else {
            MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
        }
    });

    let active = make_test_attempt(&cred, attempt_id, AttemptPhase::StartIntent, "none", None);
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    let res = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;
    assert!(res.is_err());

    let a = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a.phase, AttemptPhase::RecoveryRequired);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 0);
}

/// 13. Proven Rejection Two-Send Flow and Terminal BLOCKED:
/// First rejected send allows exactly one retry; second rejected send exhausts budget
/// and transitions directly to FinalizedLocal with BLOCKED outbox (not recovery_required).
#[tokio::test]
async fn test_proven_rejection_allows_one_retry_then_exhausts_to_blocked() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(chrono::Utc::now().timestamp_millis());
    executor_state.execution_deadline_ms = Some(chrono::Utc::now().timestamp_millis() + 60_000);
    executor_state.dispatch_send_count = 0;

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Prepared,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        reconcile_result: Some(Ok(DispatchReconciliation::DefinitelyNotDispatched)),
        dispatch_result: Some(Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
            reason: "pty busy".into(),
        })),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Drive 1: Prepared -> DispatchIntent
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

    // Drive 2: DispatchIntent (Send #1) -> dispatch rejected -> remains in DispatchIntent with send_count = 1, outcome = known_rejected
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

    let a1 = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a1.phase, AttemptPhase::DispatchIntent);
    assert_eq!(a1.executor.as_ref().unwrap().dispatch_send_count, 1);
    assert_eq!(
        a1.executor
            .as_ref()
            .unwrap()
            .last_dispatch_outcome
            .as_deref(),
        Some("known_rejected")
    );

    // Drive 3: DispatchIntent (Send #2 - Retry within budget) -> dispatch rejected -> remains in DispatchIntent with send_count = 2, outcome = known_rejected
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

    let a2 = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a2.phase, AttemptPhase::DispatchIntent);
    assert_eq!(a2.executor.as_ref().unwrap().dispatch_send_count, 2);

    // Drive 4: DispatchIntent (Send #3 - Budget exhausted) -> sees send_count >= 2 -> terminal BLOCKED outbox -> FinalizedLocal
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

    let a3 = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a3.phase, AttemptPhase::OutcomeRecorded);

    // Step: OutcomeRecorded -> FinalizedLocal with verified cleanup
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

    let a3 = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(a3.phase, AttemptPhase::FinalizedLocal);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();
    assert_eq!(record.report.execution_status, ExecutionStatus::BLOCKED);
    assert_eq!(record.report.business_outcome, BusinessOutcome::NOT_STARTED);
    assert!(!record.report.task_dispatched);
    assert_eq!(
        record.report.error.as_ref().map(|e| e.code.as_str()),
        Some("DISPATCH_REJECTED")
    );
}

#[tokio::test]
async fn test_timeout_fallback_with_valid_managed_result() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-123";

    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(1727000000000);
    executor_state.execution_deadline_ms = Some(1727000060000);
    executor_state.dispatch_request_id = Some("req_mock".into());
    executor_state.dispatch_send_count = 1;
    executor_state.runtime_completion_kind = Some("timed_out".into());
    executor_state.runtime_completed_at_ms = Some(1727000070000);

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::OutcomeRecorded,
        "resource",
        Some(resource_id),
        Some(executor_state),
    );
    let job_id = active.job_id.clone();
    active.save(&paths.active_attempt_file()).unwrap();

    // Write valid managed result before outcome recorded runs
    let result_file = paths.managed_result_file(&attempt_id);
    let valid_envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Extracted youtube transcript",
        "operations": [
            {
                "op": "upsert_content",
                "content": "Full video transcript content here"
            }
        ]
    });
    fs::create_dir_all(result_file.parent().unwrap()).unwrap();
    fs::write(
        &result_file,
        serde_json::to_string(&valid_envelope).unwrap(),
    )
    .unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
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

    // Terminal was closed because timeout fallback succeeded as COMPLETED
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter.interrupt_calls.load(Ordering::SeqCst), 0);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::COMPLETED);
    assert!(record.managed_result.is_some());

    // Preserved result and meta file must exist
    let pres_res = paths.preserved_managed_result_file(&job_id, &attempt_id);
    let pres_meta = paths.preserved_managed_result_meta_file(&job_id, &attempt_id);
    assert!(pres_res.exists());
    assert!(pres_meta.exists());
}

#[tokio::test]
async fn test_timeout_without_managed_result() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-456";

    let mut executor_state = make_default_executor("orca", "1.4.209");
    executor_state.worktree_id = Some("wt_mock".into());
    executor_state.terminal_id = Some("term_mock".into());
    executor_state.dispatch_started_at_ms = Some(1727000000000);
    executor_state.execution_deadline_ms = Some(1727000060000);
    executor_state.dispatch_request_id = Some("req_mock".into());
    executor_state.dispatch_send_count = 1;
    executor_state.runtime_completion_kind = Some("timed_out".into());
    executor_state.runtime_completed_at_ms = Some(1727000070000);

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::OutcomeRecorded,
        "resource",
        Some(resource_id),
        Some(executor_state),
    );
    let job_id = active.job_id.clone();
    active.save(&paths.active_attempt_file()).unwrap();

    // Ensure runtime attempt dir exists
    let runtime_dir = paths.attempt_runtime_dir(&attempt_id);
    fs::create_dir_all(&runtime_dir).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
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

    // Terminal was NOT closed; interrupt was called!
    assert_eq!(adapter.close_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.interrupt_calls.load(Ordering::SeqCst), 1);

    let outbox_entries = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(outbox_entries.len(), 1);
    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let record: OutboxRecord = serde_json::from_str(&outbox_content).unwrap();

    assert_eq!(record.report.execution_status, ExecutionStatus::TIMED_OUT);
    assert!(record.managed_result.is_none());

    // Mock report server endpoint
    let report_path = format!("/api/connector/jobs/{job_id}/report");
    server.add_handler(move |req| {
        if req.path == report_path && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-27T16:00:00.000Z"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Deliver outbox
    ceo_connector::outbox::flush_outbox(&paths, &client, &cred)
        .await
        .unwrap();

    // History record must record "timed_out"
    let hist_file = paths.history_file(&job_id, &attempt_id);
    assert!(hist_file.exists());
    let hist_str = fs::read_to_string(hist_file).unwrap();
    let hist: ceo_connector::outbox::SanitizedHistoryRecord =
        serde_json::from_str(&hist_str).unwrap();
    assert_eq!(hist.status, "timed_out");

    // Runtime dir must NOT be deleted on TIMED_OUT!
    assert!(runtime_dir.exists());
}

#[tokio::test]
async fn test_explicit_redelivery_flow() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let job_id = "job_redeliver_test";
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-789";

    // Set up preserved result and meta
    let pres_res = paths.preserved_managed_result_file(job_id, &attempt_id);
    let pres_meta = paths.preserved_managed_result_meta_file(job_id, &attempt_id);

    let valid_envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Manual correction of transcript",
        "operations": [
            {
                "op": "upsert_content",
                "content": "Corrected transcript content"
            }
        ]
    });
    let meta = ceo_connector::redelivery::PreservedResultMeta {
        server_origin: cred.server_origin.clone(),
        device_id: cred.device_id.clone(),
        job_id: job_id.into(),
        attempt_id: attempt_id.clone(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        resource_id: Some(resource_id.into()),
    };

    ceo_connector::local_state::atomic_write_json(&pres_res, &valid_envelope).unwrap();
    ceo_connector::local_state::atomic_write_json(&pres_meta, &meta).unwrap();

    // Mock result endpoint on server expecting delivery_mode: explicit_redelivery
    let result_path = format!("/api/connector/jobs/{job_id}/result");
    let resource_id_clone = resource_id.to_string();
    server.add_handler(move |req| {
        if req.path == result_path && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            assert_eq!(
                body.get("delivery_mode").and_then(|v| v.as_str()),
                Some("explicit_redelivery")
            );
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-27T16:00:00.000Z",
                    "resource_id": resource_id_clone,
                    "commit": "git-commit-hash-abc"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let res = ceo_connector::redelivery::run_redeliver(&paths, job_id, Some(&attempt_id)).await;
    assert!(res.is_ok(), "redelivery failed: {:?}", res);
}

#[tokio::test]
async fn test_advisory_readiness_unsatisfied_persists_none_ready_at_and_advances_to_dispatch() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_uuid = Uuid::new_v4();
    let attempt_id = format!("att-{}", attempt_uuid);
    let attempt_id_clone = attempt_id.clone();

    server.add_handler(move |req| {
        if req.path.contains("/start") && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": attempt_id_clone,
                        "phase": "started",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": "2026-09-24T12:00:01.000Z"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let active = make_test_attempt(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Claimed,
        "none",
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    // MockAdapter returns PrepareOutcome::Ready with agent_ready_at_ms = None (advisory miss)
    let adapter = Arc::new(MockAdapter {
        ready: true,
        prepare_result: Some(Ok(PrepareOutcome::Ready(PreparedExecution {
            worktree_id: "wt_adv".into(),
            terminal_id: "term_adv".into(),
            orca_version: "1.4.209".into(),
            agent_id: "agy".into(),
            agent_ready_at_ms: None,
        }))),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Claimed -> PrepareIntent
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::PrepareIntent);

    // Step 2: PrepareIntent -> Prepared with agent_ready_at_ms = None!
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::Prepared);
    assert_eq!(cur.executor.as_ref().unwrap().agent_ready_at_ms, None);
    // CRITICAL: save & validate must succeed with agent_ready_at_ms = None!
    assert!(cur.save(&paths.active_attempt_file()).is_ok());

    // Step 3: Prepared -> DispatchIntent
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::DispatchIntent);
    assert_eq!(cur.executor.as_ref().unwrap().agent_ready_at_ms, None);

    // Step 4: DispatchIntent -> Dispatched (relying on send accepted)
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::Dispatched);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_pre_turn_tui_idle_is_ignored_until_turn_started() {
    let (_temp, paths, cred, _config) = setup_test_env("http://127.0.0.1:4000");
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();

    let mut executor = make_default_executor("orca", "1.4.209");
    executor.worktree_id = Some("wt_test".into());
    executor.terminal_id = Some("term_test".into());
    executor.dispatch_request_id = Some("req_123".into());

    executor.dispatch_started_at_ms = Some(now - 1000);
    executor.execution_deadline_ms = Some(now + 10_000);
    executor.dispatch_turn_started = false;
    executor.turn_started_observed = false;

    let active = make_test_attempt(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Waiting,
        "none",
        Some(executor),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        wait_seq: Arc::new(std::sync::Mutex::new(vec![
            Ok(WaitOutcome::TuiIdle { elapsed_ms: 50 }), // Pre-turn: ignored!
            Ok(WaitOutcome::WorkingObserved { elapsed_ms: 50 }), // Turn start observed!
            Ok(WaitOutcome::TuiIdle { elapsed_ms: 50 }), // Now accepted as completion!
        ])),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::OutcomeRecorded);
    let exec = cur.executor.as_ref().unwrap();
    assert_eq!(exec.runtime_completion_kind.as_deref(), Some("tui_idle"));
    assert!(exec.turn_started_observed);
    assert!(exec.runtime_error.is_none());
}

#[tokio::test]
async fn test_partial_managed_result_ignored_until_finalized_then_immediately_completes() {
    let (_temp, paths, cred, _config) = setup_test_env("http://127.0.0.1:4000");
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res_barrier".to_string();
    let now = chrono::Utc::now().timestamp_millis();

    paths.ensure_attempt_runtime_dir(&attempt_id).unwrap();
    let result_file = paths.managed_result_file(&attempt_id);

    // Initially, write invalid/partial content
    fs::write(
        &result_file,
        "{ \"schema_version\": 1, \"job_id\": \"incomplete",
    )
    .unwrap();

    let mut executor = make_default_executor("orca", "1.4.209");
    executor.worktree_id = Some("wt_test".into());
    executor.terminal_id = Some("term_test".into());
    executor.dispatch_request_id = Some("req_barrier".into());

    executor.dispatch_started_at_ms = Some(now - 1000);
    executor.execution_deadline_ms = Some(now + 10_000);
    executor.dispatch_turn_started = true;

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Waiting,
        "resource",
        Some(&resource_id),
        Some(executor),
    );
    let job_id = active.job_id.clone();
    active.save(&paths.active_attempt_file()).unwrap();

    let rf_clone = result_file.clone();
    let j_clone = job_id.clone();
    let a_clone = attempt_id.clone();
    let r_clone = resource_id.clone();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        on_wait: Some(Arc::new(move || {
            // During wait tick, finalize the result file with valid content
            let valid = serde_json::json!({
                "schema_version": 1,
                "job_id": j_clone,
                "attempt_id": a_clone,
                "resource_id": r_clone,
                "summary": "Completed successfully",
                "operations": [
                    {
                        "op": "upsert_content",
                        "content": "Acquired content"
                    }
                ]
            });
            fs::write(&rf_clone, serde_json::to_string(&valid).unwrap()).unwrap();
        })),
        wait_seq: Arc::new(std::sync::Mutex::new(vec![
            Ok(WaitOutcome::TimedOut { elapsed_ms: 100 }), // First tick: invalid JSON, ignored; tick triggers finalize
        ])),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::OutcomeRecorded);
    let exec = cur.executor.as_ref().unwrap();
    assert_eq!(
        exec.runtime_completion_kind.as_deref(),
        Some("managed_result")
    );
    assert!(exec.runtime_error.is_none());

    // Verify preserved result exists
    let pres_res = paths.preserved_managed_result_file(&cur.job_id, &attempt_id);
    assert!(pres_res.exists());
}

#[tokio::test]
async fn test_capture_immutability_runtime_mutation_after_barrier_does_not_affect_outcome() {
    let (_temp, paths, cred, _config) = setup_test_env("http://127.0.0.1:4000");
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res_immut".to_string();
    let now = chrono::Utc::now().timestamp_millis();

    paths.ensure_attempt_runtime_dir(&attempt_id).unwrap();
    let result_file = paths.managed_result_file(&attempt_id);

    let mut executor = make_default_executor("orca", "1.4.209");
    executor.worktree_id = Some("wt_test".into());
    executor.terminal_id = Some("term_test".into());
    executor.dispatch_request_id = Some("req_immut".into());
    executor.dispatch_started_at_ms = Some(now - 1000);
    executor.execution_deadline_ms = Some(now + 10_000);
    executor.dispatch_turn_started = true;

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Waiting,
        "resource",
        Some(&resource_id),
        Some(executor),
    );
    let job_id = active.job_id.clone();
    active.save(&paths.active_attempt_file()).unwrap();

    let valid = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Original pristine result",
        "operations": [
            {
                "op": "upsert_content",
                "content": "Pristine content"
            }
        ]
    });
    fs::write(&result_file, serde_json::to_string(&valid).unwrap()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Drive Waiting -> detects managed_result barrier and advances to OutcomeRecorded
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::OutcomeRecorded);

    // Mutate or remove the original runtime scratch file!
    fs::remove_file(&result_file).unwrap();

    // Drive OutcomeRecorded -> uses preserved result without failing
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::FinalizedLocal);
}

#[tokio::test]
async fn test_agent_done_resource_job_with_missing_result_fails_and_retains_terminal() {
    let (_temp, paths, cred, _config) = setup_test_env("http://127.0.0.1:4000");
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res_missing".to_string();
    let now = chrono::Utc::now().timestamp_millis();

    let mut executor = make_default_executor("orca", "1.4.209");
    executor.worktree_id = Some("wt_test".into());
    executor.terminal_id = Some("term_missing".into());
    executor.dispatch_request_id = Some("req_missing".into());

    executor.dispatch_started_at_ms = Some(now - 1000);
    executor.execution_deadline_ms = Some(now + 10_000);
    executor.dispatch_turn_started = true;

    let active = make_test_attempt_with_resource(
        &cred,
        attempt_id.clone(),
        AttemptPhase::Waiting,
        "resource",
        Some(&resource_id),
        Some(executor),
    );

    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        wait_seq: Arc::new(std::sync::Mutex::new(vec![Ok(WaitOutcome::AgentDone {
            elapsed_ms: 100,
        })])),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Drive Waiting -> AgentDone without result file -> OutcomeRecorded with RESULT_MISSING
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::OutcomeRecorded);
    let exec = cur.executor.as_ref().unwrap();
    assert_eq!(exec.runtime_completion_kind.as_deref(), Some("agent_done"));
    assert_eq!(
        exec.runtime_error.as_ref().map(|e| e.code.as_str()),
        Some("RESULT_MISSING")
    );

    // Drive OutcomeRecorded -> FAILED -> Terminal NOT closed
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(cur.phase, AttemptPhase::FinalizedLocal);
    assert_eq!(
        adapter.close_calls.load(Ordering::SeqCst),
        0,
        "Terminal must be retained for user inspection on FAILED"
    );
}

#[tokio::test]
async fn test_redelivery_authority_decoupled_from_active_attempt_and_late_runtime_result_succeeds()
{
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());
    let client = ConnectorClient::new(&server.origin()).unwrap();
    let adapter = Arc::new(MockAdapter::default());

    let job_a_id = "job_redeliver_decoupled_a";
    let att_a_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-late-456";
    let claim_token_a = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // 1. Claim Job A as resource job
    let mut attempt_a = make_test_attempt_with_resource(
        &cred,
        att_a_id.clone(),
        AttemptPhase::ClaimIntent,
        "resource",
        Some(resource_id),
        None,
    );
    attempt_a.job_id = job_a_id.to_string();
    attempt_a.workspace_id = "ws_test".to_string();
    attempt_a.target_id = "tgt_test".to_string();
    attempt_a.claim_token = claim_token_a.to_string();
    attempt_a.prompt = Some("prompt".into());
    attempt_a.acceptance = Some("acceptance".into());
    attempt_a.execution_timeout_seconds = Some(3600);
    attempt_a.payload_sha256 = Some(ActiveAttempt::compute_payload_sha256(
        job_a_id,
        "ws_test",
        "tgt_test",
        Some(resource_id),
        "prompt",
        "acceptance",
        3600,
        "resource",
    ));
    attempt_a.save(&paths.active_attempt_file()).unwrap();

    let att_a_id_clone = att_a_id.clone();
    let resource_id_clone = resource_id.to_string();
    server.add_handler(move |req| {
        if req.path.contains("/claim") && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_a_id_clone,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "claim_expires_at": "2026-09-24T13:00:00.000Z"
                    },
                    "job": {
                        "job_id": job_a_id,
                        "workspace_id": "ws_test",
                        "target_id": "tgt_test",
                        "resource_id": resource_id_clone,
                        "prompt": "prompt",
                        "acceptance": "acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "resource"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Drive ClaimIntent -> reconciles to Claimed.
    // Assert PreservedResultMeta was durably written BEFORE/ON Claimed transition!
    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let meta_file_a = paths.preserved_managed_result_meta_file(job_a_id, &att_a_id);
    assert!(
        meta_file_a.exists(),
        "Redelivery authority meta must be durably persisted on Claimed phase"
    );

    // Simulate Job A failed with RESULT_MISSING, outbox delivered, active-attempt deleted
    paths.ensure_attempt_runtime_dir(&att_a_id).unwrap();
    let report = ExecutionReport {
        schema_version: 2,
        execution_status: ExecutionStatus::FAILED,
        business_outcome: BusinessOutcome::FAILED,
        task_dispatched: true,
        finished_at_ms: chrono::Utc::now().timestamp_millis(),
        duration_ms: 5000,
        executor: ceo_connector::execution_contract::ExecutionReportExecutor {
            executor_type: "orca".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "receipt_a".into(),
        error: Some(ExecutionReportError {
            stage: "result".into(),
            code: "RESULT_MISSING".into(),
            message: "managed-result.json was not found".into(),
        }),
    };
    let outbox_record = OutboxRecord {
        schema_version: OUTBOX_SCHEMA_VERSION,
        created_at_ms: chrono::Utc::now().timestamp_millis(),
        server_origin: cred.server_origin.clone(),
        device_id: cred.device_id.clone(),
        job_id: job_a_id.to_string(),
        attempt_id: att_a_id.clone(),
        claim_token: claim_token_a.to_string(),
        report,
        managed_result: None,
        managed_result_sha256: None,
    };
    let outbox_file = paths.outbox_file(job_a_id, &att_a_id);
    ceo_connector::local_state::atomic_write_json(&outbox_file, &outbox_record).unwrap();

    // Transition active-attempt to FinalizedLocal so outbox delivery can finalize it
    let mut cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    cur.phase = AttemptPhase::FinalizedLocal;
    cur.terminal_report_sha256 = Some(ceo_connector::outbox::compute_report_sha256(
        &outbox_record.report,
    ));
    cur.save(&paths.active_attempt_file()).unwrap();

    let server_report_received = Arc::new(AtomicBool::new(false));
    let srr = server_report_received.clone();
    server.add_handler(move |req| {
        if req.path.contains("/report") && req.method == "POST" {
            srr.store(true, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    ceo_connector::outbox::deliver_outbox_record(
        &paths,
        &client,
        &cred,
        &outbox_file,
        &outbox_record,
    )
    .await
    .unwrap();

    // Verify active-attempt is unlinked for Job A, but runtime dir and meta are retained
    assert!(!paths.active_attempt_file().exists());
    assert!(meta_file_a.exists());
    assert!(paths.attempt_runtime_dir(&att_a_id).exists());

    // 2. Now simulate Job B is claimed and becomes current active-attempt!
    let job_b_id = "job_redeliver_decoupled_b";
    let att_b_id = format!("att-{}", Uuid::new_v4());
    let mut attempt_b = make_test_attempt_with_resource(
        &cred,
        att_b_id.clone(),
        AttemptPhase::Claimed,
        "none",
        None,
        None,
    );
    attempt_b.job_id = job_b_id.to_string();
    attempt_b.claim_token =
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into();
    attempt_b.payload_sha256 = Some(ActiveAttempt::compute_payload_sha256(
        job_b_id,
        &attempt_b.workspace_id,
        &attempt_b.target_id,
        None,
        attempt_b.prompt.as_deref().unwrap(),
        attempt_b.acceptance.as_deref().unwrap(),
        attempt_b.execution_timeout_seconds.unwrap(),
        "none",
    ));
    attempt_b.save(&paths.active_attempt_file()).unwrap();

    // 3. User resumes agent in Job A's retained terminal -> late managed-result.json appears!
    let runtime_res_file_a = paths.managed_result_file(&att_a_id);
    let valid_envelope_a = serde_json::json!({
        "schema_version": 1,
        "job_id": job_a_id,
        "attempt_id": att_a_id,
        "resource_id": resource_id,
        "summary": "Late extraction of transcript after continue",
        "operations": [
            {
                "op": "upsert_content",
                "content": "Full video transcript recovered successfully"
            }
        ]
    });
    ceo_connector::local_state::atomic_write_json(&runtime_res_file_a, &valid_envelope_a).unwrap();

    // 4. Mock redelivery endpoint expecting explicit_redelivery with Job A's claim token
    let explicit_redelivery_called = Arc::new(AtomicBool::new(false));
    let erc = explicit_redelivery_called.clone();
    let job_a_result_path = format!("/api/connector/jobs/{job_a_id}/result");
    let resource_id_clone2 = resource_id.to_string();
    let expected_claim_token = claim_token_a.to_string();
    server.add_handler(move |req| {
        if req.path == job_a_result_path && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            assert_eq!(
                body.get("claim_token").and_then(|v| v.as_str()),
                Some(expected_claim_token.as_str())
            );
            assert_eq!(
                body.get("delivery_mode").and_then(|v| v.as_str()),
                Some("explicit_redelivery")
            );
            erc.store(true, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-27T18:00:00.000Z",
                    "resource_id": resource_id_clone2,
                    "commit": "git-commit-hash-late-a"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    // Run redelivery on Job A while Job B is active!
    let redeliver_res = ceo_connector::redelivery::run_redeliver(&paths, job_a_id, None).await;
    assert!(
        redeliver_res.is_ok(),
        "Redelivery failed: {:?}",
        redeliver_res
    );
    assert!(explicit_redelivery_called.load(Ordering::SeqCst));

    // Verify late runtime result was promoted/snapshotted to results/
    let pres_res_a = paths.preserved_managed_result_file(job_a_id, &att_a_id);
    assert!(pres_res_a.exists());

    // Verify Job B is completely untouched as active-attempt
    let active_cur = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(active_cur.job_id, job_b_id);
    assert_eq!(active_cur.attempt_id, att_b_id);
}

#[tokio::test]
async fn test_redelivery_runtime_candidate_precedence_and_snapshot_replacement() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let job_id = "job_redeliver_precedence";
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-precedence-999";
    let claim_token = "tok123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // Setup PreservedResultMeta
    let meta = ceo_connector::redelivery::PreservedResultMeta {
        server_origin: cred.server_origin.clone(),
        device_id: cred.device_id.clone(),
        job_id: job_id.into(),
        attempt_id: attempt_id.clone(),
        claim_token: claim_token.into(),
        resource_id: Some(resource_id.into()),
    };
    let meta_file = paths.preserved_managed_result_meta_file(job_id, &attempt_id);
    ceo_connector::local_state::atomic_write_json(&meta_file, &meta).unwrap();

    // 1. Place old snapshot in results/
    let pres_res = paths.preserved_managed_result_file(job_id, &attempt_id);
    let old_envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Old snapshot content",
        "operations": [
            {
                "op": "upsert_content",
                "content": "Old stale content"
            }
        ]
    });
    ceo_connector::local_state::atomic_write_json(&pres_res, &old_envelope).unwrap();

    // 2. Place corrected candidate in runtime/
    paths.ensure_attempt_runtime_dir(&attempt_id).unwrap();
    let runtime_res = paths.managed_result_file(&attempt_id);
    let corrected_envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Human corrected content",
        "operations": [
            {
                "op": "upsert_content",
                "content": "New corrected content with high accuracy"
            }
        ]
    });
    ceo_connector::local_state::atomic_write_json(&runtime_res, &corrected_envelope).unwrap();

    // 3. Mock server checks that the CORRECTED content is submitted
    let server_saw_corrected = Arc::new(AtomicBool::new(false));
    let ssc = server_saw_corrected.clone();
    let result_path = format!("/api/connector/jobs/{job_id}/result");
    let resource_id_clone = resource_id.to_string();
    server.add_handler(move |req| {
        if req.path == result_path && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            let summary = body.pointer("/result/summary").and_then(|v| v.as_str());
            assert_eq!(summary, Some("Human corrected content"));
            ssc.store(true, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-27T18:00:00.000Z",
                    "resource_id": resource_id_clone,
                    "commit": "git-commit-hash-corrected"
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let res = ceo_connector::redelivery::run_redeliver(&paths, job_id, None).await;
    assert!(res.is_ok(), "Redelivery failed: {:?}", res);
    assert!(server_saw_corrected.load(Ordering::SeqCst));

    // 4. Assert preserved snapshot was replaced with the corrected content
    let updated_snapshot: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&pres_res).unwrap()).unwrap();
    assert_eq!(
        updated_snapshot.get("summary").and_then(|v| v.as_str()),
        Some("Human corrected content")
    );
}

#[tokio::test]
async fn test_redelivery_invalid_runtime_result_strict_failure_no_silent_fallback() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let job_id = "job_redeliver_invalid_fail_closed";
    let attempt_id = format!("att-{}", Uuid::new_v4());
    let resource_id = "res-invalid-fail";
    let claim_token = "tok123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // Setup PreservedResultMeta
    let meta = ceo_connector::redelivery::PreservedResultMeta {
        server_origin: cred.server_origin.clone(),
        device_id: cred.device_id.clone(),
        job_id: job_id.into(),
        attempt_id: attempt_id.clone(),
        claim_token: claim_token.into(),
        resource_id: Some(resource_id.into()),
    };
    let meta_file = paths.preserved_managed_result_meta_file(job_id, &attempt_id);
    ceo_connector::local_state::atomic_write_json(&meta_file, &meta).unwrap();

    // 1. Place old valid snapshot in results/
    let pres_res = paths.preserved_managed_result_file(job_id, &attempt_id);
    let old_envelope = serde_json::json!({
        "schema_version": 1,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "resource_id": resource_id,
        "summary": "Old valid snapshot",
        "operations": [{ "op": "upsert_content", "content": "Old valid content" }]
    });
    ceo_connector::local_state::atomic_write_json(&pres_res, &old_envelope).unwrap();

    // 2. Place corrupted/invalid candidate in runtime/
    paths.ensure_attempt_runtime_dir(&attempt_id).unwrap();
    let runtime_res = paths.managed_result_file(&attempt_id);
    std::fs::write(&runtime_res, b"{ corrupt json: [").unwrap();

    // 3. Mock server must receive ZERO calls!
    let network_called = Arc::new(AtomicBool::new(false));
    let nc = network_called.clone();
    server.add_handler(move |_req| {
        nc.store(true, Ordering::SeqCst);
        MockResponse::json(500, &serde_json::json!({ "error": "should not be called" }))
    });

    let res = ceo_connector::redelivery::run_redeliver(&paths, job_id, None).await;
    assert!(res.is_err(), "Must fail when runtime result is invalid");
    let err_msg = res.unwrap_err();
    assert!(
        err_msg.contains("Invalid runtime managed result"),
        "Error message should indicate invalid runtime candidate, got: {err_msg}"
    );
    assert!(
        !network_called.load(Ordering::SeqCst),
        "Must NOT make network calls or fall back silently to old preserved result"
    );
}

#[tokio::test]
async fn test_non_resource_job_does_not_persist_redelivery_meta() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());
    let client = ConnectorClient::new(&server.origin()).unwrap();
    let adapter = Arc::new(MockAdapter::default());

    let job_id = "job_freestyle_no_meta";
    let att_id = format!("att-{}", Uuid::new_v4());

    // Claim non-resource (freestyle) job: result_target: "none", resource_id: None
    let mut attempt = make_test_attempt_with_resource(
        &cred,
        att_id.clone(),
        AttemptPhase::ClaimIntent,
        "none",
        None,
        None,
    );
    attempt.job_id = job_id.to_string();
    attempt.workspace_id = "ws_test".to_string();
    attempt.target_id = "tgt_test".to_string();
    attempt.claim_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into();
    attempt.prompt = Some("prompt".into());
    attempt.acceptance = Some("acceptance".into());
    attempt.execution_timeout_seconds = Some(3600);
    attempt.payload_sha256 = Some(ActiveAttempt::compute_payload_sha256(
        job_id,
        "ws_test",
        "tgt_test",
        None,
        "prompt",
        "acceptance",
        3600,
        "none",
    ));
    attempt.save(&paths.active_attempt_file()).unwrap();

    let att_id_clone = att_id.clone();
    server.add_handler(move |req| {
        if req.path.contains("/claim") && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_id_clone,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "claim_expires_at": "2026-09-24T13:00:00.000Z"
                    },
                    "job": {
                        "job_id": job_id,
                        "workspace_id": "ws_test",
                        "target_id": "tgt_test",
                        "resource_id": null,
                        "prompt": "prompt",
                        "acceptance": "acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();

    let meta_file = paths.preserved_managed_result_meta_file(job_id, &att_id);
    assert!(
        !meta_file.exists(),
        "Non-resource jobs must NOT persist redelivery metadata"
    );
}
