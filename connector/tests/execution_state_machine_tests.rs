mod common;

use std::fs;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ceo_connector::client::ConnectorClient;
use ceo_connector::config::{normalize_server_origin, LocalConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
use ceo_connector::execution_contract::{BusinessOutcome, ExecutionStatus};
use ceo_connector::local_state::ExecutionLock;
use ceo_connector::outbox::OutboxRecord;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, DispatchOutcome, DispatchReconciliation,
    ExecutionAdapter, WaitOutcome, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use common::mock_server::{MockResponse, MockServer};
use uuid::Uuid;

#[derive(Clone, Default)]
struct MockAdapter {
    pub ready: bool,
    pub prepare_result: Option<Result<(String, String), String>>,
    pub reconcile_result: Option<Result<DispatchReconciliation, String>>,
    pub dispatch_result: Option<Result<DispatchOutcome, String>>,
    pub wait_result: Option<Result<WaitOutcome, String>>,
    pub close_result: Option<Result<(), String>>,

    pub prepare_calls: Arc<AtomicUsize>,
    pub reconcile_calls: Arc<AtomicUsize>,
    pub dispatch_calls: Arc<AtomicUsize>,
    pub wait_calls: Arc<AtomicUsize>,
    pub close_calls: Arc<AtomicUsize>,

    pub on_wait: Option<Arc<dyn Fn() + Send + Sync>>,
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
    ) -> Result<(String, String), String> {
        self.prepare_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(ref res) = self.prepare_result {
            res.clone()
        } else {
            Ok((
                format!("wt_{}", attempt.attempt_id),
                format!("term_{}", attempt.attempt_id),
            ))
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
        _retry_request_id: Option<&str>,
    ) -> Result<DispatchOutcome, String> {
        self.dispatch_calls.fetch_add(1, Ordering::SeqCst);
        self.dispatch_result.clone().unwrap_or_else(|| {
            Ok(DispatchOutcome::Accepted {
                request_id: "req_mock_123".into(),
                accepted_at_ms: chrono::Utc::now().timestamp_millis(),
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
        self.wait_result
            .clone()
            .unwrap_or(Ok(WaitOutcome::TuiIdle { elapsed_ms: 100 }))
    }

    async fn close(&self, _terminal_id: &str) -> Result<(), String> {
        self.close_calls.fetch_add(1, Ordering::SeqCst);
        self.close_result.clone().unwrap_or(Ok(()))
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
        dispatch_send_count: 0,
        dispatch_started_at_ms: None,
        execution_deadline_ms: None,
        dispatch_request_id: None,
        dispatch_accepted_at_ms: None,
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
        None,
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
        resource_id: None,
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

/// 2. Unsupported result_target = "resource" guard:
/// Blocks before /start, creates terminal BLOCKED report with executor.type = "ceo-connector", zero Orca calls.
#[tokio::test]
async fn test_unsupported_result_target_blocks_before_start() {
    let server = MockServer::start().await;
    let (_temp, paths, cred, _config) = setup_test_env(&server.origin());

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let start_called = Arc::new(AtomicUsize::new(0));
    let start_called_clone = start_called.clone();

    server.add_handler(move |req| {
        if req.path.contains("/start") {
            start_called_clone.fetch_add(1, Ordering::SeqCst);
        }
        MockResponse::json(200, &serde_json::json!({ "ok": true }))
    });

    let active = make_test_attempt(&cred, attempt_id, AttemptPhase::Claimed, "resource", None);
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Drive active attempt: should block immediately
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

    // Verify /start was NEVER called and adapter was NOT invoked
    assert_eq!(start_called.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.prepare_calls.load(Ordering::SeqCst), 0);
    assert_eq!(adapter.dispatch_calls.load(Ordering::SeqCst), 0);

    // Verify outbox was written with BLOCKED / NOT_STARTED / RESULT_TARGET_UNSUPPORTED
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
    assert_eq!(record.report.executor.executor_type, "ceo-connector");

    let err = record.report.error.expect("expected error details");
    assert_eq!(err.code, "RESULT_TARGET_UNSUPPORTED");
    assert_eq!(err.stage, "orchestration");
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
    executor_state.dispatch_send_count = 1;

    let active = make_test_attempt(
        &cred,
        attempt_id,
        AttemptPhase::Dispatched,
        "none",
        Some(executor_state),
    );
    active.save(&paths.active_attempt_file()).unwrap();

    let adapter = Arc::new(MockAdapter {
        ready: true,
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Dispatched -> Waiting
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

    // Step 2: Waiting with expired deadline -> marks OutcomeRecorded
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
    assert_eq!(record.report.business_outcome, BusinessOutcome::FAILED);
}

/// 5. Dispatch Retry Budget & Fail-Closed:
/// Two rejected sends exhaust the max-2 send budget. Next retry transitions to RECOVERY_REQUIRED.
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

    // Step 2: DispatchIntent checks send_count >= 2 -> transitions to RecoveryRequired and fails
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
        AttemptPhase::Started,
        "none",
        None,
    );
    active.save(&paths.active_attempt_file()).unwrap();

    // Adapter returns existing adopted terminal ID
    let adapter = Arc::new(MockAdapter {
        ready: true,
        prepare_result: Some(Ok(("wt_existing".into(), "term_adopted_123".into()))),
        ..Default::default()
    });
    let client = ConnectorClient::new(&cred.server_origin).unwrap();

    // Step 1: Started -> PrepareIntent
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
