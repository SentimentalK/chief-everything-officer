use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use ceo_connector::config::{LocalExecutorConfig, LocalTarget};
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::receipt::ExecutionReceipt;
use ceo_connector::orca::types::*;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptPhase, DispatchOutcome, ExecutionAdapter, WaitOutcome,
    ACTIVE_ATTEMPT_SCHEMA_VERSION,
};

#[test]
fn test_parse_real_fixtures() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/orca");

    // 1. Status fixture
    let status_str = fs::read_to_string(base.join("status.json")).unwrap();
    let status: OrcaStatusResponse = serde_json::from_str(&status_str).unwrap();
    assert!(status.ok);
    let s_res = status.result.unwrap();
    assert!(s_res.app.running);
    assert_eq!(s_res.runtime.state, "ready");
    assert_eq!(s_res.runtime.app_version.as_deref(), Some("1.4.209"));

    // 2. Worktrees fixture
    let wt_str = fs::read_to_string(base.join("worktrees.json")).unwrap();
    let wt: OrcaWorktreeListResponse = serde_json::from_str(&wt_str).unwrap();
    assert!(wt.ok);
    let w_res = wt.result.unwrap();
    assert_eq!(w_res.worktrees.len(), 1);
    assert_eq!(
        w_res.worktrees[0].id,
        "52984381-30b0-4c5b-b23b-fd2fc2474049::/home/user/repo"
    );

    // 2b. Worktree Show fixture
    let wts_str = fs::read_to_string(base.join("worktree_show.json")).unwrap();
    let wts: OrcaWorktreeShowResponse = serde_json::from_str(&wts_str).unwrap();
    assert!(wts.ok);
    let wts_res = wts.result.unwrap();
    assert_eq!(
        wts_res.worktree.id,
        "52984381-30b0-4c5b-b23b-fd2fc2474049::/home/user/repo"
    );
    assert_eq!(wts_res.worktree.path, "/home/user/repo");

    // 2c. Repo Add fixture
    let ra_str = fs::read_to_string(base.join("repo_add.json")).unwrap();
    let ra: OrcaRepoAddResponse = serde_json::from_str(&ra_str).unwrap();
    assert!(ra.ok);
    let ra_res = ra.result.unwrap();
    assert_eq!(ra_res.repo.path, "/home/user/repo");

    // 3. Terminal Create fixture
    let tc_str = fs::read_to_string(base.join("terminal_create.json")).unwrap();
    let tc: OrcaTerminalCreateResponse = serde_json::from_str(&tc_str).unwrap();
    assert!(tc.ok);
    let tc_res = tc.result.unwrap();
    assert_eq!(
        tc_res.terminal.handle,
        "term_593ff419-ea4d-45eb-9ac0-f4d37b91ac38"
    );
    assert_eq!(
        tc_res.terminal.title.as_deref(),
        Some("ceo:att-00000000-0000-0000-0000-000000000001")
    );

    // 4. Terminal Send fixture
    let ts_str = fs::read_to_string(base.join("terminal_send.json")).unwrap();
    let ts: OrcaTerminalSendResponse = serde_json::from_str(&ts_str).unwrap();
    assert!(ts.ok);
    let ts_res = ts.result.unwrap();
    let send_part = ts_res.send.unwrap();
    assert!(send_part.accepted);
    let prompt = send_part.prompt.unwrap();
    assert_eq!(
        prompt.request_id.as_deref(),
        Some("c2808464-44e4-4a4e-9e7f-a31cd9d81d12")
    );
    assert_eq!(
        prompt.stages.as_ref().unwrap(),
        &vec!["input_accepted".to_string()]
    );

    // 5. Terminal Wait fixture
    let tw_str = fs::read_to_string(base.join("terminal_wait_idle.json")).unwrap();
    let tw: OrcaTerminalWaitResponse = serde_json::from_str(&tw_str).unwrap();
    assert!(tw.ok);
    let tw_res = tw.result.unwrap();
    let wait_part = tw_res.wait.unwrap();
    assert!(wait_part.satisfied);
    assert_eq!(wait_part.condition.as_deref(), Some("tui-idle"));

    // 6. Terminal Close fixture
    let tcl_str = fs::read_to_string(base.join("terminal_close.json")).unwrap();
    let tcl: OrcaTerminalCloseResponse = serde_json::from_str(&tcl_str).unwrap();
    assert!(tcl.ok);
    let tcl_res = tcl.result.unwrap();
    assert_eq!(
        tcl_res.close.unwrap().handle,
        "term_593ff419-ea4d-45eb-9ac0-f4d37b91ac38"
    );
}

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

#[tokio::test]
async fn test_orca_cli_client_invocation() {
    let temp = tempfile::tempdir().unwrap();
    let args_log = temp.path().join("args.log");

    let script = format!(
        r#"#!/bin/bash
echo "$@" >> "{}"
if [ "$1" = "status" ]; then
    echo '{{"ok":true,"result":{{"app":{{"running":true}},"runtime":{{"state":"ready","reachable":true,"appVersion":"1.4.209"}}}}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"worktrees":[{{"id":"wt_1","path":"/path/to/repo"}}]}}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_1","path":"/path/to/repo"}}}}}}'
elif [ "$1" = "repo" ] && [ "$2" = "add" ]; then
    echo '{{"ok":true,"result":{{"repo":{{"id":"repo_1","path":"/path/to/repo"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","title":"ceo:att_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
    echo '{{"ok":true,"result":{{"send":{{"handle":"term_1","accepted":true,"bytesWritten":10,"prompt":{{"requestId":"req_123","stages":["input_accepted"]}}}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_1","condition":"tui-idle","satisfied":true,"elapsedMs":100}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "close" ]; then
    echo '{{"ok":true,"result":{{"close":{{"handle":"term_1","closeMode":"exact","ptyKilled":true}}}}}}'
else
    echo '{{"ok":false,"error":{{"code":"unknown_command"}}}}'
fi
"#,
        args_log.display()
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);

    // Test status
    let status = client.status().await.unwrap();
    assert!(status.ok);
    assert_eq!(
        status.result.unwrap().runtime.app_version.as_deref(),
        Some("1.4.209")
    );

    // Test list_worktrees
    let wts = client.list_worktrees().await.unwrap();
    assert_eq!(wts.len(), 1);
    assert_eq!(wts[0].id, "wt_1");

    // Test show_worktree_by_path
    let wt = client
        .show_worktree_by_path(Path::new("/path/to/repo"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wt.id, "wt_1");
    assert_eq!(wt.path, "/path/to/repo");

    // Test add_repo
    let repo = client.add_repo(Path::new("/path/to/repo")).await.unwrap();
    assert_eq!(repo.id, "repo_1");
    assert_eq!(repo.path, "/path/to/repo");

    // Test create_terminal
    let tc = client
        .create_terminal("wt_1", "ceo:att_1", None, None)
        .await
        .unwrap();
    assert_eq!(tc.handle, "term_1");

    // Test send_terminal_prompt with retry_request_id and wait_submit_seconds
    let ts = client
        .send_terminal_prompt("term_1", "echo hi", Some("req_retry_001"), Some(10))
        .await
        .unwrap();
    assert!(ts.ok);
    assert_eq!(
        ts.result
            .unwrap()
            .send
            .unwrap()
            .prompt
            .unwrap()
            .request_id
            .as_deref(),
        Some("req_123")
    );

    // Verify logged args include --retry-request req_retry_001 and --wait-submit 10
    let recorded_args = fs::read_to_string(&args_log).unwrap();
    assert!(recorded_args.contains("--retry-request req_retry_001"));
    assert!(recorded_args.contains("--wait-submit 10"));
    assert!(recorded_args.contains("worktree show --worktree path:/path/to/repo --json"));
    assert!(recorded_args.contains("repo add --path /path/to/repo --json"));

    // Test wait_terminal_tui_idle
    let tw = client
        .wait_terminal_tui_idle("term_1", Duration::from_millis(500))
        .await
        .unwrap();
    assert!(tw.ok);
    assert!(tw.result.unwrap().wait.unwrap().satisfied);

    // Test close_terminal
    client.close_terminal("term_1").await.unwrap();
}

#[tokio::test]
async fn test_orca_cli_timeout_handling() {
    let temp = tempfile::tempdir().unwrap();
    let script = r#"#!/bin/bash
sleep 2
echo '{"ok":true}'
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin).with_timeout(Duration::from_millis(100));

    let res = client.status().await;
    assert!(res.is_err());
    match res.unwrap_err() {
        ceo_connector::orca::client::OrcaError::Timeout(d) => {
            assert_eq!(d, Duration::from_millis(100));
        }
        other => panic!("Expected timeout error, got {other:?}"),
    }
}

#[tokio::test]
async fn test_orca_cli_error_response() {
    let temp = tempfile::tempdir().unwrap();
    let script = r#"#!/bin/bash
echo '{"ok":false,"error":{"code":"not_found","message":"target terminal not found"}}'
exit 1
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);

    let res = client.close_terminal("nonexistent").await;
    assert!(res.is_err());
    let err = res.unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("not_found: target terminal not found"),
        "Unexpected error message: {msg}"
    );
}

#[test]
fn test_execution_receipt_hashing_and_exclusion() {
    let receipt1 = ExecutionReceipt {
        schema_version: ExecutionReceipt::SCHEMA_VERSION,
        job_id: "job_123".into(),
        attempt_id: "att_456".into(),
        target_id: "tgt_789".into(),
        orca_version: "1.4.209".into(),
        worktree_id: Some("wt_789".into()),
        terminal_id: Some("term_abc".into()),
        agent_id: Some("agy".into()),
        agent_ready_at_ms: Some(1727220000000),
        dispatch_request_id: Some("req_xyz".into()),
        dispatch_stage: Some("turn_started".into()),
        task_dispatched: true,
        runtime_completion_kind: Some("tui_idle".into()),
        dispatch_started_at_ms: Some(1727220000000),
        runtime_completed_at_ms: Some(1727220001000),
        terminal_cleanup_verified: true,
        terminal_closed_at_ms: Some(1727220002000),
    };

    let receipt2 = receipt1.clone();

    let hash1 = receipt1.compute_sha256();
    let hash2 = receipt2.compute_sha256();

    assert_eq!(hash1, hash2);
    assert_eq!(hash1.len(), 64);

    let serialized = serde_json::to_string(&receipt1).unwrap();
    // Verify prompt, tokens, credentials never appear
    assert!(!serialized.contains("prompt"));
    assert!(!serialized.contains("token"));
    assert!(!serialized.contains("secret"));
}

#[tokio::test]
async fn test_fake_orca_deterministic_prompt_and_acceptance_formatting_and_secret_exclusion() {
    let temp = tempfile::tempdir().unwrap();
    let invocations_log = temp.path().join("invocations.log");
    let args_log = temp.path().join("args.log");

    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
    echo "SEND_CALLED" >> "{}"
    echo "$@" >> "{}"
    echo '{{"ok":true,"result":{{"send":{{"handle":"term_1","accepted":true,"bytesWritten":42,"prompt":{{"requestId":"req_send_123","stages":["input_accepted"]}}}}}}}}'
else
    echo '{{"ok":false,"error":{{"code":"unsupported"}}}}'
fi
"#,
        invocations_log.display(),
        args_log.display()
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let prompt_literal = "GENERATE_REPORT_FOR_Q3_TASK_LITERAL";
    let acceptance_literal = "REPORT_MUST_BE_IN_CSV_FORMAT_LITERAL";
    let secret_claim_token = "SECRET_CLAIM_TOKEN_999999";

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_xyz".into(),
        attempt_id: "att_xyz".into(),
        claim_token: secret_claim_token.into(),
        device_id: "dev_xyz".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::Prepared,
        workspace_id: "ws_xyz".into(),
        target_id: "tgt_xyz".into(),
        resource_id: None,
        prompt: Some(prompt_literal.into()),
        acceptance: Some(acceptance_literal.into()),
        execution_timeout_seconds: Some(60),
        result_target: Some("none".into()),
        payload_sha256: None,
        claimed_at_ms: None,
        terminal_report_sha256: None,
        executor: None,
    };

    let outcome = adapter.dispatch(&attempt, "term_1", None).await.unwrap();
    match outcome {
        DispatchOutcome::Accepted { request_id, .. } => {
            assert_eq!(request_id, "req_send_123");
        }
        other => panic!("Expected accepted dispatch outcome, got {other:?}"),
    }

    let invocations = fs::read_to_string(&invocations_log).unwrap();
    // Proves exactly one terminal send
    assert_eq!(invocations.lines().count(), 1);

    let recorded = fs::read_to_string(&args_log).unwrap();
    let expected_prompt =
        format!("TASK\n\n{prompt_literal}\n\nACCEPTANCE CRITERIA\n\n{acceptance_literal}");
    assert!(recorded.contains(&expected_prompt));

    assert!(!recorded.contains("SECRET_CLAIM_TOKEN"));
    assert!(!recorded.contains("dev_xyz"));
    assert!(!recorded.contains("127.0.0.1:4000"));
}

#[tokio::test]
async fn test_fake_orca_worktree_reconciliation_zero_creates_and_validates() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();
    let args_log = temp.path().join("args.log");
    let marker_file = temp.path().join("repo_added");

    let script = format!(
        r#"#!/bin/bash
echo "$@" >> "{}"
if [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    if [ -f "{}" ]; then
        echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_123","path":"{}"}}}}}}'
    else
        echo '{{"ok":false,"error":{{"code":"not_found"}}}}'
    fi
elif [ "$1" = "repo" ] && [ "$2" = "add" ]; then
    touch "{}"
    echo '{{"ok":true,"result":{{"repo":{{"id":"repo_123","path":"{}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"terminals":[]}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_new_123","title":"ceo:att_123"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"satisfied":true}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#,
        args_log.display(),
        marker_file.display(),
        repo_canon,
        marker_file.display(),
        repo_canon,
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        workspace_id: "ws_1".into(),
        alias: "repo".into(),
        kind: "repo".into(),
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_123".into(),
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

    let prep = adapter.prepare(&attempt, &target).await.unwrap();
    assert_eq!(prep.worktree_id, "wt_123");
    assert_eq!(prep.terminal_id, "term_new_123");
    assert_eq!(prep.agent_id, "agy");

    let recorded = fs::read_to_string(&args_log).unwrap();
    assert!(recorded.contains("repo add"));
    assert!(recorded.contains("--command agy"));
}

#[tokio::test]
async fn test_fake_orca_missing_executor_fails_closed() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();

    let script = r#"#!/bin/bash
echo '{"ok":true}'
"#;

    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        workspace_id: "ws_1".into(),
        alias: "repo".into(),
        kind: "repo".into(),
        local_path: repo_canon,
        executor: None,
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_123".into(),
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

    let res = adapter.prepare(&attempt, &target).await;
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert!(err.contains("no agent executor configured"));
}

#[tokio::test]
async fn test_fake_orca_terminal_adoption_wrong_worktree_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = repo_dir.canonicalize().unwrap().display().to_string();

    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_target_1","path":"{repo_canon}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    # Terminal matching title ceo:att_123 exists, but in wt_OTHER!
    echo '{{"ok":true,"result":{{"terminals":[{{"handle":"term_other_worktree","title":"ceo:att_123","worktreeId":"wt_OTHER"}}]}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_created_target","title":"ceo:att_123","worktreeId":"wt_target_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"satisfied":true}}}}}}'
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
        alias: "repo".into(),
        kind: "repo".into(),
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_123".into(),
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

    let prep = adapter.prepare(&attempt, &target).await.unwrap();
    assert_eq!(prep.worktree_id, "wt_target_1");
    // Must NOT adopt term_other_worktree
    assert_eq!(prep.terminal_id, "term_created_target");
}

#[tokio::test]
async fn test_fake_orca_dispatch_classification_tightening() {
    let temp = tempfile::tempdir().unwrap();

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_1".into(),
        attempt_id: "att_1".into(),
        claim_token: "token".into(),
        device_id: "dev_1".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::DispatchIntent,
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

    // 1. accepted = false -> KnownRejectedBeforeAcceptance
    let script1 = r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":false,"prompt":{"requestId":null}}}}'
"#;
    let bin1 = create_mock_orca_script(&temp, script1);
    let client1 = OrcaCliClient::new(bin1);
    let adapter1 = OrcaExecutionAdapter::new(client1);

    let outcome1 = adapter1.dispatch(&attempt, "term_1", None).await.unwrap();
    match outcome1 {
        DispatchOutcome::KnownRejectedBeforeAcceptance { .. } => {}
        other => panic!("Expected KnownRejectedBeforeAcceptance, got {other:?}"),
    }

    // 2. accepted = true with missing requestId -> AmbiguousTransportFailure
    let script2 = r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"prompt":{"requestId":null}}}}'
"#;
    let bin2 = create_mock_orca_script(&temp, script2);
    let client2 = OrcaCliClient::new(bin2);
    let adapter2 = OrcaExecutionAdapter::new(client2);

    let outcome2 = adapter2.dispatch(&attempt, "term_1", None).await.unwrap();
    match outcome2 {
        DispatchOutcome::AmbiguousTransportFailure { error } => {
            assert!(error.contains("missing"));
        }
        other => panic!("Expected AmbiguousTransportFailure, got {other:?}"),
    }

    // 3. Command failed with error -> AmbiguousTransportFailure
    let script3 = r#"#!/bin/bash
echo '{"ok":false,"error":{"code":"internal_failure","message":"pipe broke"}}'
exit 1
"#;
    let bin3 = create_mock_orca_script(&temp, script3);
    let client3 = OrcaCliClient::new(bin3);
    let adapter3 = OrcaExecutionAdapter::new(client3);

    let outcome3 = adapter3.dispatch(&attempt, "term_1", None).await.unwrap();
    match outcome3 {
        DispatchOutcome::AmbiguousTransportFailure { error } => {
            assert!(error.contains("internal_failure"));
        }
        other => panic!("Expected AmbiguousTransportFailure, got {other:?}"),
    }
}

#[tokio::test]
async fn test_fake_orca_wait_classification() {
    let temp = tempfile::tempdir().unwrap();

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "j".into(),
        attempt_id: "a".into(),
        claim_token: "t".into(),
        device_id: "d".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::Waiting,
        workspace_id: "w".into(),
        target_id: "tg".into(),
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

    // 1. Terminal wait satisfied=false -> WaitOutcome::TimedOut
    let script_to = r#"#!/bin/bash
echo '{"ok":true,"result":{"wait":{"handle":"term_1","condition":"tui-idle","satisfied":false,"elapsedMs":50}}}'
"#;
    let bin_to = create_mock_orca_script(&temp, script_to);
    let client_to = OrcaCliClient::new(bin_to);
    let adapter_to = OrcaExecutionAdapter::new(client_to);

    let outcome_to = adapter_to
        .wait(&attempt, "term_1", Duration::from_millis(50))
        .await
        .unwrap();
    match outcome_to {
        WaitOutcome::TimedOut { elapsed_ms } => {
            assert_eq!(elapsed_ms, 50);
        }
        other => panic!("Expected TimedOut, got {other:?}"),
    }

    // 2. Terminal exited/missing -> WaitOutcome::Interrupted
    let script_exit = r#"#!/bin/bash
echo '{"ok":false,"error":{"code":"terminal_exited","message":"terminal process exited"}}'
exit 1
"#;
    let bin_exit = create_mock_orca_script(&temp, script_exit);
    let client_exit = OrcaCliClient::new(bin_exit);
    let adapter_exit = OrcaExecutionAdapter::new(client_exit);

    let outcome_exit = adapter_exit
        .wait(&attempt, "term_1", Duration::from_secs(5))
        .await
        .unwrap();
    match outcome_exit {
        WaitOutcome::Interrupted { reason } => {
            assert!(reason.contains("terminal_exited"));
        }
        other => panic!("Expected Interrupted, got {other:?}"),
    }

    // 3. Unknown fatal error -> fail closed (Err, no timeout invented)
    let script_err = r#"#!/bin/bash
echo '{"ok":false,"error":{"code":"unknown_fatal","message":"catastrophic bus error"}}'
exit 1
"#;
    let bin_err = create_mock_orca_script(&temp, script_err);
    let client_err = OrcaCliClient::new(bin_err);
    let adapter_err = OrcaExecutionAdapter::new(client_err);

    let outcome_err = adapter_err
        .wait(&attempt, "term_1", Duration::from_secs(5))
        .await;
    assert!(outcome_err.is_err());
    let msg = outcome_err.unwrap_err();
    assert!(
        msg.contains("catastrophic bus error") || msg.contains("unknown_fatal"),
        "Unexpected msg: {msg}"
    );
}
