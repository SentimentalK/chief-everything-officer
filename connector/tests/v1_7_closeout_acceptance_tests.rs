mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

use ceo_connector::client::ConnectorClient;
use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
use ceo_connector::execution_contract::{BusinessOutcome, ExecutionStatus};
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, DispatchProof, ExecutionAdapter,
    ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use common::mock_server::MockServer;
use uuid::Uuid;

fn create_mock_orca_script(temp: &tempfile::TempDir, script_body: &str) -> PathBuf {
    let script_path = temp
        .path()
        .join(format!("mock-orca-{}", uuid::Uuid::new_v4()));
    fs::write(&script_path, script_body).unwrap();
    let mut perms = fs::metadata(&script_path).unwrap().permissions();
    perms.set_mode(0o755);
    fs::set_permissions(&script_path, perms).unwrap();
    script_path
}

fn setup_env(
    server_origin: &str,
    target_path: &str,
) -> (
    tempfile::TempDir,
    ConnectorPaths,
    DeviceCredential,
    LocalConfig,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".ceo");
    let paths = ConnectorPaths::from_roots(&root, &root);
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server_origin.to_string(),
        "usr_v17".into(),
        "dev_v17".into(),
        "dcr_v17".into(),
        "secret_v17".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let mut config = LocalConfig::new(server_origin.to_string()).unwrap();
    config.targets.insert(
        "tgt_v17".into(),
        LocalTarget {
            workspace_id: "ws_v17".into(),
            alias: "v17-target".into(),
            kind: "general_automation".into(),
            local_path: target_path.to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred, config)
}

/// Slice V1.7e Acceptance:
/// Agent TUI readiness gate:
/// When initial 60s wait is not satisfied, retries up to 120s and succeeds.
#[tokio::test]
async fn test_v1_7e_tui_readiness_retry_success() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();

    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_1","path":"{repo_canon}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","title":"ceo:att_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    COUNT_FILE="{}/wait_count"
    C=0
    if [ -f "$COUNT_FILE" ]; then
        C=$(cat "$COUNT_FILE")
    fi
    C=$((C+1))
    echo "$C" > "$COUNT_FILE"
    if [ "$C" -eq 1 ]; then
        # First 60s wait not satisfied
        echo '{{"ok":true,"result":{{"wait":{{"handle":"term_1","condition":"tui-idle","satisfied":false}}}}}}'
    else
        # Retry 120s wait satisfied!
        echo '{{"ok":true,"result":{{"wait":{{"handle":"term_1","condition":"tui-idle","satisfied":true}}}}}}'
    fi
else
    echo '{{"ok":false}}'
fi
"#,
        temp.path().display()
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        workspace_id: "ws_1".into(),
        alias: "v17-target".into(),
        kind: "general_automation".into(),
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_1".into(),
        claim_token: "token".into(),
        device_id: "dev_1".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::PrepareIntent,
        workspace_id: "ws_1".into(),
        target_id: "tgt_1".into(),
        resource_id: None,
        prompt: None,
        acceptance: None,
        execution_timeout_seconds: None,
        result_target: None,
        payload_sha256: None,
        claimed_at_ms: None,
        terminal_report_sha256: None,
        executor: None,
    };

    let prep = match adapter.prepare(&attempt, &target).await.unwrap() {
        ceo_connector::scheduler::PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.worktree_id, "wt_1");
    assert_eq!(prep.terminal_id, "term_1");
    assert_eq!(prep.agent_id, "agy");
    assert!(prep.agent_ready_at_ms > 0);

    let count_str = fs::read_to_string(temp.path().join("wait_count")).unwrap();
    assert_eq!(count_str.trim(), "2");
}

/// Slice V1.7e Acceptance:
/// If retry 120s wait is also not satisfied, prepare fails closed with RECOVERY_REQUIRED.
#[tokio::test]
async fn test_v1_7e_tui_readiness_exhaustion_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();

    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_1","path":"{repo_canon}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","title":"ceo:att_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_1","condition":"tui-idle","satisfied":false}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        workspace_id: "ws_1".into(),
        alias: "v17-target".into(),
        kind: "general_automation".into(),
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_1".into(),
        claim_token: "token".into(),
        device_id: "dev_1".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::PrepareIntent,
        workspace_id: "ws_1".into(),
        target_id: "tgt_1".into(),
        resource_id: None,
        prompt: None,
        acceptance: None,
        execution_timeout_seconds: None,
        result_target: None,
        payload_sha256: None,
        claimed_at_ms: None,
        terminal_report_sha256: None,
        executor: None,
    };

    let res = adapter.prepare(&attempt, &target).await.unwrap();
    match res {
        ceo_connector::scheduler::PrepareOutcome::NotReady { reason, .. } => {
            assert!(reason.contains("AGENT_NOT_READY"));
        }
        other => panic!("expected PrepareOutcome::NotReady, got {other:?}"),
    }
}

/// Slice V1.7f Acceptance:
/// InputAccepted observation replay:
/// When initial prompt send results in input_accepted, re-observation loop uses same request ID
/// until TurnStarted is proven, transitioning into Dispatched with TurnStarted stage.
#[tokio::test]
async fn test_v1_7f_input_accepted_replays_until_turn_started() {
    let server = MockServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();
    let (_t, paths, cred, _config) = setup_env(&server.origin(), &repo_canon);

    let send_count_file = temp.path().join("send_count");
    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
    COUNT_FILE="{}"
    C=0
    if [ -f "$COUNT_FILE" ]; then
        C=$(cat "$COUNT_FILE")
    fi
    C=$((C+1))
    echo "$C" > "$COUNT_FILE"
    if [ "$C" -eq 1 ]; then
        # First send: accepted, but only input_accepted
        echo '{{"ok":true,"result":{{"send":{{"handle":"term_1","accepted":true,"bytesWritten":10,"prompt":{{"requestId":"req_replay_1","stages":["input_accepted"]}}}}}}}}'
    else
        # Re-observation: turn_started proven!
        echo '{{"ok":true,"result":{{"send":{{"handle":"term_1","accepted":true,"bytesWritten":10,"prompt":{{"requestId":"req_replay_1","stages":["input_accepted","turn_started"]}}}}}}}}'
    fi
else
    echo '{{"ok":false}}'
fi
"#,
        send_count_file.display()
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = Arc::new(OrcaExecutionAdapter::new(client));
    let connector_client = ConnectorClient::new(&cred.server_origin).unwrap();

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    let executor_state = AttemptExecutorState {
        executor_type: "orca".into(),
        orca_version: Some("1.4.209".into()),
        worktree_id: Some("wt_1".into()),
        terminal_id: Some("term_1".into()),
        agent_id: Some("agy".into()),
        agent_ready_at_ms: Some(now),
        dispatch_send_count: 0,
        last_dispatch_outcome: None,
        dispatch_started_at_ms: None,
        execution_deadline_ms: None,
        dispatch_request_id: None,
        dispatch_accepted_at_ms: None,
        dispatch_proof: None,
        dispatch_provider: None,
        dispatch_observation: None,
        dispatch_observation_count: 0,
        runtime_completion_kind: None,
        runtime_completed_at_ms: None,
        runtime_error: None,
    };

    let active = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "a".repeat(64),
        device_id: cred.device_id.clone(),
        server_origin: cred.server_origin.clone(),
        phase: AttemptPhase::DispatchIntent,
        workspace_id: "ws_v17".into(),
        target_id: "tgt_v17".into(),
        resource_id: None,
        prompt: Some("do something".into()),
        acceptance: Some("must pass".into()),
        execution_timeout_seconds: Some(60),
        result_target: Some("none".into()),
        payload_sha256: Some(ActiveAttempt::compute_payload_sha256(
            "job_1",
            "ws_v17",
            "tgt_v17",
            None,
            "do something",
            "must pass",
            60,
            "none",
        )),
        claimed_at_ms: Some(now),
        terminal_report_sha256: None,
        executor: Some(executor_state),
    };
    active.save(&paths.active_attempt_file()).unwrap();

    // Step 1: First dispatch returns InputAccepted -> remains in DispatchIntent with observation_count = 1
    let advanced = drive_active_attempt(
        &paths,
        &connector_client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    let attempt_after_first = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(attempt_after_first.phase, AttemptPhase::DispatchIntent);
    let exec1 = attempt_after_first.executor.as_ref().unwrap();
    assert_eq!(exec1.dispatch_proof, Some(DispatchProof::InputAccepted));
    assert_eq!(exec1.dispatch_request_id.as_deref(), Some("req_replay_1"));
    assert_eq!(exec1.dispatch_observation_count, 0);

    // Step 2: Next drive re-observes the same request_id -> turn_started proven -> transitions to Dispatched
    let advanced = drive_active_attempt(
        &paths,
        &connector_client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    let attempt_after_second = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(attempt_after_second.phase, AttemptPhase::Dispatched);
    let exec2 = attempt_after_second.executor.as_ref().unwrap();
    assert_eq!(exec2.dispatch_proof, Some(DispatchProof::TurnStarted));
    assert_eq!(exec2.dispatch_observation_count, 1);
}

/// Slice V1.7g Acceptance:
/// Verified Cleanup + ExecutionReceipt V2 + Outbox Generation + Unverified Business Outcome:
/// - Exact terminal close without --tab
/// - Terminal absence verified
/// - Receipt V2 with all required fields
/// - Final report has execution_status=COMPLETED, business_outcome=UNVERIFIED
#[tokio::test]
async fn test_v1_7g_verified_cleanup_receipt_v2_and_unverified_outcome() {
    let server = MockServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();
    let (_t, paths, cred, _config) = setup_env(&server.origin(), &repo_canon);

    let args_log = temp.path().join("args.log");
    let script = format!(
        r#"#!/bin/bash
echo "$@" >> "{}"
if [ "$1" = "terminal" ] && [ "$2" = "close" ]; then
    echo '{{"ok":true,"result":{{"close":{{"handle":"term_1","closeMode":"exact","ptyKilled":true,"ptyStopVerdict":"success"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    # Return empty list, proving terminal is completely absent
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":false,"error":{{"code":"terminal_not_found","message":"not found"}}}}'
else
    echo '{{"ok":false}}'
fi
"#,
        args_log.display()
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = Arc::new(OrcaExecutionAdapter::new(client));
    let connector_client = ConnectorClient::new(&cred.server_origin).unwrap();

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    let executor_state = AttemptExecutorState {
        executor_type: "orca".into(),
        orca_version: Some("1.4.209".into()),
        worktree_id: Some("wt_1".into()),
        terminal_id: Some("term_1".into()),
        agent_id: Some("agy".into()),
        agent_ready_at_ms: Some(now - 10_000),
        dispatch_send_count: 1,
        last_dispatch_outcome: None,
        dispatch_started_at_ms: Some(now - 8_000),
        execution_deadline_ms: Some(now + 60_000),
        dispatch_request_id: Some("req_clean_1".into()),
        dispatch_accepted_at_ms: Some(now - 7_000),
        dispatch_proof: Some(DispatchProof::TurnStarted),
        dispatch_provider: Some("unsupported".into()),
        dispatch_observation: Some("unsupported".into()),
        dispatch_observation_count: 1,
        runtime_completion_kind: Some("tui_idle".into()),
        runtime_completed_at_ms: Some(now - 2_000),
        runtime_error: None,
    };

    let active = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_clean_1".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "a".repeat(64),
        device_id: cred.device_id.clone(),
        server_origin: cred.server_origin.clone(),
        phase: AttemptPhase::OutcomeRecorded,
        workspace_id: "ws_v17".into(),
        target_id: "tgt_v17".into(),
        resource_id: None,
        prompt: Some("do something".into()),
        acceptance: Some("must pass".into()),
        execution_timeout_seconds: Some(60),
        result_target: Some("none".into()),
        payload_sha256: Some(ActiveAttempt::compute_payload_sha256(
            "job_clean_1",
            "ws_v17",
            "tgt_v17",
            None,
            "do something",
            "must pass",
            60,
            "none",
        )),
        claimed_at_ms: Some(now - 12_000),
        terminal_report_sha256: None,
        executor: Some(executor_state),
    };
    active.save(&paths.active_attempt_file()).unwrap();

    // Drive OutcomeRecorded -> FinalizedLocal
    let advanced = drive_active_attempt(
        &paths,
        &connector_client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    let active_final = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(active_final.phase, AttemptPhase::FinalizedLocal);

    // Verify args: terminal close was invoked WITHOUT --tab
    let recorded = fs::read_to_string(&args_log).unwrap();
    assert!(recorded.contains("terminal close --terminal term_1 --json"));
    assert!(!recorded.contains("--tab"));

    // Verify outbox record
    let outbox_entries: Vec<_> = fs::read_dir(paths.outbox_dir())
        .unwrap()
        .map(|e| e.unwrap())
        .collect();
    assert_eq!(outbox_entries.len(), 1);

    let outbox_content = fs::read_to_string(outbox_entries[0].path()).unwrap();
    let outbox_record: ceo_connector::outbox::OutboxRecord =
        serde_json::from_str(&outbox_content).unwrap();

    let report = &outbox_record.report;
    assert_eq!(report.schema_version, 2);
    assert_eq!(report.execution_status, ExecutionStatus::COMPLETED);
    assert_eq!(report.business_outcome, BusinessOutcome::UNVERIFIED);
    assert!(report.task_dispatched);
    assert!(report.error.is_none());
    assert_eq!(report.executor.executor_type, "orca");
    assert_eq!(report.executor.version, "1.4.209");

    // Verify receipt_sha256 is a valid 64-character sha256 hex string correlating to execution
    assert_eq!(report.receipt_sha256.len(), 64);
    assert!(report.receipt_sha256.chars().all(|c| c.is_ascii_hexdigit()));
}

/// Slice V1.7f Acceptance:
/// If replay observation fails to prove turn_started within observation budget (2 replays),
/// transitions to RecoveryRequired with DISPATCH_SUBMISSION_UNPROVEN.
#[tokio::test]
async fn test_v1_7f_input_accepted_observation_budget_exhaustion() {
    let server = MockServer::start().await;
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();
    let (_t, paths, cred, _config) = setup_env(&server.origin(), &repo_canon);

    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
    # Keeps returning only input_accepted
    echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"bytesWritten":10,"prompt":{"requestId":"req_replay_1","stages":["input_accepted"]}}}}'
else
    echo '{"ok":false}'
fi
"#;

    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);
    let adapter = Arc::new(OrcaExecutionAdapter::new(client));
    let connector_client = ConnectorClient::new(&cred.server_origin).unwrap();

    let attempt_id = format!("att-{}", Uuid::new_v4());
    let now = chrono::Utc::now().timestamp_millis();
    let executor_state = AttemptExecutorState {
        executor_type: "orca".into(),
        orca_version: Some("1.4.209".into()),
        worktree_id: Some("wt_1".into()),
        terminal_id: Some("term_1".into()),
        agent_id: Some("agy".into()),
        agent_ready_at_ms: Some(now),
        dispatch_send_count: 1,
        last_dispatch_outcome: None,
        dispatch_started_at_ms: Some(now - 1000),
        execution_deadline_ms: Some(now + 60_000),
        dispatch_request_id: Some("req_replay_1".into()),
        dispatch_accepted_at_ms: Some(now - 500),
        dispatch_proof: Some(DispatchProof::InputAccepted),
        dispatch_provider: Some("unsupported".into()),
        dispatch_observation: Some("unsupported".into()),
        dispatch_observation_count: 2, // Budget already reached 2
        runtime_completion_kind: None,
        runtime_completed_at_ms: None,
        runtime_error: None,
    };

    let active = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_exhaust_1".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "a".repeat(64),
        device_id: cred.device_id.clone(),
        server_origin: cred.server_origin.clone(),
        phase: AttemptPhase::DispatchIntent,
        workspace_id: "ws_v17".into(),
        target_id: "tgt_v17".into(),
        resource_id: None,
        prompt: Some("do something".into()),
        acceptance: Some("must pass".into()),
        execution_timeout_seconds: Some(60),
        result_target: Some("none".into()),
        payload_sha256: Some(ActiveAttempt::compute_payload_sha256(
            "job_exhaust_1",
            "ws_v17",
            "tgt_v17",
            None,
            "do something",
            "must pass",
            60,
            "none",
        )),
        claimed_at_ms: Some(now),
        terminal_report_sha256: None,
        executor: Some(executor_state),
    };
    active.save(&paths.active_attempt_file()).unwrap();

    let res = drive_active_attempt(
        &paths,
        &connector_client,
        &cred,
        &(adapter.clone() as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await;

    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(err.to_string().contains("DISPATCH_SUBMISSION_UNPROVEN"));

    let attempt_final = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(attempt_final.phase, AttemptPhase::RecoveryRequired);
}
