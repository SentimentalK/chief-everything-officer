#![cfg(unix)]
// Unix-only integration suite: the Orca CLI fixtures are driven by bash shims
// (shebang scripts + chmod). Not compiled on Windows.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

mod common;

use ceo_connector::config::{LocalExecutorConfig, LocalTarget};
use ceo_connector::orca::adapter::{validate_tui_idle_wait, ValidatedWait};
use ceo_connector::orca::client::{parse_orca_json, OrcaCliClient, OrcaCommandOutput, OrcaError};
use ceo_connector::orca::receipt::ExecutionReceipt;
use ceo_connector::orca::types::*;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptExecutorState, AttemptPhase, CleanupOutcome, DispatchOutcome,
    ExecutionAdapter, PrepareOutcome, SchedulerError, WaitOutcome, ACTIVE_ATTEMPT_SCHEMA_VERSION,
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

    let prompt_text = ceo_connector::execution_contract::build_execution_prompt(
        attempt.prompt.as_deref(),
        attempt.acceptance.as_deref(),
        None,
    );
    let outcome = adapter
        .dispatch(&attempt, "term_1", &prompt_text)
        .await
        .unwrap();
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
    let expected_prompt = format!("任务\n\n{prompt_literal}\n\n验收标准\n\n{acceptance_literal}");
    assert!(recorded.contains(&expected_prompt));
    assert!(recorded.contains("执行上下文"));

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
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_new_123","title":"ceo:att_123"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_new_123","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_new_123","condition":"tui-idle","satisfied":true}}}}}}'
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

    let prep = match adapter.prepare(&attempt, &target).await.unwrap() {
        ceo_connector::scheduler::PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.worktree_id, "wt_123");
    assert_eq!(prep.terminal_id, "term_new_123");
    assert_eq!(prep.agent_id, "agy");

    let recorded = fs::read_to_string(&args_log).unwrap();
    assert!(recorded.contains("repo add"));
    assert!(recorded.contains("--command agy"));
}

#[tokio::test]
async fn test_real_orca_agent_aware_launch_antigravity_not_literal_command() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = fs::canonicalize(&repo_dir)
        .unwrap()
        .to_string_lossy()
        .to_string();

    let args_log = temp.path().join("args.log");
    let script = format!(
        r#"#!/bin/bash
echo "$@" >> "{}"
if [ "$1" = "status" ]; then
    echo '{{"ok":true,"result":{{"app":{{"running":true}},"runtime":{{"state":"ready","reachable":true,"appVersion":"1.4.219"}}}}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_123","path":"{}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "orchestration" ] && [ "$2" = "worker-start" ]; then
    echo '{{"ok":true,"result":{{"runId":"run_1","taskId":"task_1","state":"ready","effects":[{{"kind":"terminal","role":"agent","id":"term_worker_agy"}}]}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_worker_agy","condition":"tui-idle","satisfied":true,"elapsedMs":50}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_worker_agy","title":"ceo:att_123:antigravity","worktreeId":"wt_123"}}}}}}'
else
    echo '{{"ok":false,"error":{{"code":"unknown_command"}}}}'
fi
"#,
        args_log.display(),
        repo_canon
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
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

    let prep = match adapter.prepare(&attempt, &target).await.unwrap() {
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.worktree_id, "wt_123");
    assert_eq!(prep.terminal_id, "term_worker_agy");
    assert_eq!(prep.agent_id, "antigravity");

    let recorded = fs::read_to_string(&args_log).unwrap();
    // Proven: worker-start called with logical agent antigravity
    assert!(
        recorded.contains("orchestration worker-start"),
        "must call orchestration worker-start, log:\n{recorded}"
    );
    assert!(
        recorded.contains("--agent antigravity"),
        "must pass --agent antigravity, log:\n{recorded}"
    );
    // Proven: NEVER executed literal "antigravity" command or terminal create --command antigravity
    assert!(
        !recorded.contains("terminal create --command antigravity"),
        "must NOT create terminal with literal command 'antigravity'"
    );
    assert!(
        !recorded.contains("--command"),
        "normal path must not pass --command"
    );
}

#[tokio::test]
async fn test_real_orca_agent_aware_launch_auto_omits_agent_and_never_literal_command() {
    let temp = tempfile::tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    let repo_canon = fs::canonicalize(&repo_dir)
        .unwrap()
        .to_string_lossy()
        .to_string();

    let args_log = temp.path().join("args.log");
    let script = format!(
        r#"#!/bin/bash
echo "$@" >> "{}"
if [ "$1" = "status" ]; then
    echo '{{"ok":true,"result":{{"app":{{"running":true}},"runtime":{{"state":"ready","reachable":true,"appVersion":"1.4.219"}}}}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"worktree":{{"id":"wt_123","path":"{}"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "list" ]; then
    echo '{{"ok":true,"result":{{"terminals":[],"truncated":false}}}}'
elif [ "$1" = "orchestration" ] && [ "$2" = "worker-start" ]; then
    echo '{{"ok":true,"result":{{"runId":"run_1","taskId":"task_1","state":"ready","effects":[{{"kind":"terminal","role":"agent","id":"term_worker_auto"}}]}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_worker_auto","condition":"tui-idle","satisfied":true,"elapsedMs":50}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_worker_auto","title":"ceo:att_123:auto","worktreeId":"wt_123"}}}}}}'
else
    echo '{{"ok":false,"error":{{"code":"unknown_command"}}}}'
fi
"#,
        args_log.display(),
        repo_canon
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
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

    let prep = match adapter.prepare(&attempt, &target).await.unwrap() {
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.worktree_id, "wt_123");
    assert_eq!(prep.terminal_id, "term_worker_auto");
    assert_eq!(prep.agent_id, "auto");

    let recorded = fs::read_to_string(&args_log).unwrap();
    // Proven: worker-start called
    assert!(
        recorded.contains("orchestration worker-start"),
        "must call orchestration worker-start, log:\n{recorded}"
    );
    // Proven: --agent is completely omitted for auto
    assert!(
        !recorded.contains("--agent"),
        "must omit --agent for auto, log:\n{recorded}"
    );
    // Proven: NEVER executed literal "auto" command or terminal create --command auto
    assert!(
        !recorded.contains("terminal create --command auto"),
        "must NOT create terminal with literal command 'auto'"
    );
    assert!(
        !recorded.contains("--command"),
        "normal path must not pass --command"
    );
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
    echo '{{"ok":true,"result":{{"terminals":[{{"handle":"term_other_worktree","title":"ceo:att_123","worktreeId":"wt_OTHER"}}],"truncated":false}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_created_target","title":"ceo:att_123","worktreeId":"wt_target_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_created_target","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_created_target","condition":"tui-idle","satisfied":true}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
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

    let prep = match adapter.prepare(&attempt, &target).await.unwrap() {
        ceo_connector::scheduler::PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
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

    let outcome1 = adapter1
        .dispatch(&attempt, "term_1", "test prompt")
        .await
        .unwrap();
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

    let outcome2 = adapter2
        .dispatch(&attempt, "term_1", "test prompt")
        .await
        .unwrap();
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

    let outcome3 = adapter3
        .dispatch(&attempt, "term_1", "test prompt")
        .await
        .unwrap();
    match outcome3 {
        DispatchOutcome::AmbiguousTransportFailure { error } => {
            assert!(error.contains("internal_failure"));
        }
        other => panic!("Expected AmbiguousTransportFailure, got {other:?}"),
    }
}

#[tokio::test]
async fn test_dispatch_turn_started_requires_explicit_stage_not_unsupported() {
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

    let attempt_ref = &attempt;
    let run_dispatch = |script: &'static str| {
        let bin = create_mock_orca_script(&temp, script);
        let client = OrcaCliClient::new(bin);
        let adapter = OrcaExecutionAdapter::new(client);
        async move {
            adapter
                .dispatch(attempt_ref, "term_1", "test prompt")
                .await
                .unwrap()
        }
    };

    // 1. Explicit turn_started stage => turn_started=true
    let outcome = run_dispatch(
        r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"prompt":{"requestId":"req_turn","stages":["input_accepted","turn_started"]}}}}'
"#,
    )
    .await;
    match outcome {
        DispatchOutcome::Accepted {
            request_id,
            turn_started,
            ..
        } => {
            assert_eq!(request_id, "req_turn");
            assert!(turn_started);
        }
        other => panic!("Expected Accepted, got {other:?}"),
    }

    // 2. observation=unsupported alone => turn_started=false (request identity preserved)
    let outcome = run_dispatch(
        r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"prompt":{"requestId":"req_obs_unsup","stages":["input_accepted"],"observation":"unsupported"}}}}'
"#,
    )
    .await;
    match outcome {
        DispatchOutcome::Accepted {
            request_id,
            turn_started,
            ..
        } => {
            assert_eq!(request_id, "req_obs_unsup");
            assert!(!turn_started);
        }
        other => panic!("Expected Accepted, got {other:?}"),
    }

    // 3. provider=unsupported alone => turn_started=false
    let outcome = run_dispatch(
        r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"prompt":{"requestId":"req_prov_unsup","stages":["input_accepted"],"provider":"unsupported"}}}}'
"#,
    )
    .await;
    match outcome {
        DispatchOutcome::Accepted {
            request_id,
            turn_started,
            ..
        } => {
            assert_eq!(request_id, "req_prov_unsup");
            assert!(!turn_started);
        }
        other => panic!("Expected Accepted, got {other:?}"),
    }

    // 4. OpenCode-style: unsupported observation+provider, no stages => turn_started=false
    let outcome = run_dispatch(
        r#"#!/bin/bash
echo '{"ok":true,"result":{"send":{"handle":"term_1","accepted":true,"prompt":{"requestId":"req_opencode","provider":"unsupported","observation":"unsupported","processIncarnation":"inc_1","generation":15}}}}'
"#,
    )
    .await;
    match outcome {
        DispatchOutcome::Accepted {
            request_id,
            turn_started,
            ..
        } => {
            assert_eq!(request_id, "req_opencode");
            assert!(!turn_started);
        }
        other => panic!("Expected Accepted, got {other:?}"),
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

#[test]
fn test_parse_orca_json_discriminator_first() {
    // 1. ok: false with exit code 0 or 1 MUST return Err(OrcaError::Orca)
    // even when T has optional fields (like OrcaTerminalListResponse)
    let failure_output = OrcaCommandOutput {
        exit_code: Some(1),
        stdout:
            r#"{"ok":false,"error":{"code":"runtime_unavailable","message":"daemon not running"}}"#
                .to_string(),
        stderr: String::new(),
    };
    let parsed: Result<OrcaTerminalListResponse, OrcaError> = parse_orca_json(failure_output);
    match parsed {
        Err(OrcaError::Orca { code, message, .. }) => {
            assert_eq!(code, "runtime_unavailable");
            assert_eq!(message, "daemon not running");
        }
        other => panic!("Expected OrcaError::Orca, got {other:?}"),
    }

    // 2. ok: true with exit code 1 (Orca wait unsatisfied) must parse as success T
    let unsatisfied_wait_output = OrcaCommandOutput {
        exit_code: Some(1),
        stdout: r#"{"ok":true,"result":{"wait":{"handle":"term_1","condition":"tui-idle","satisfied":false,"elapsedMs":5000}}}"#.to_string(),
        stderr: String::new(),
    };
    let parsed_wait: OrcaTerminalWaitResponse = parse_orca_json(unsatisfied_wait_output).unwrap();
    assert!(parsed_wait.ok);
    let wait_res = parsed_wait.result.unwrap().wait.unwrap();
    assert!(!wait_res.satisfied);
    assert_eq!(wait_res.elapsed_ms, Some(5000));

    // 3. Missing or non-boolean ok field must return Protocol error
    let missing_ok = OrcaCommandOutput {
        exit_code: Some(0),
        stdout: r#"{"result":{"something":"val"}}"#.to_string(),
        stderr: String::new(),
    };
    let parsed_missing: Result<OrcaTerminalListResponse, OrcaError> = parse_orca_json(missing_ok);
    assert!(matches!(parsed_missing, Err(OrcaError::Protocol(_, _))));

    let string_ok = OrcaCommandOutput {
        exit_code: Some(0),
        stdout: r#"{"ok":"true","result":{}}"#.to_string(),
        stderr: String::new(),
    };
    let parsed_string: Result<OrcaTerminalListResponse, OrcaError> = parse_orca_json(string_ok);
    assert!(matches!(parsed_string, Err(OrcaError::Protocol(_, _))));

    // 4. Empty stdout must return CommandFailed
    let empty_output = OrcaCommandOutput {
        exit_code: Some(127),
        stdout: "   \n".to_string(),
        stderr: "command not found".to_string(),
    };
    let parsed_empty: Result<OrcaTerminalListResponse, OrcaError> = parse_orca_json(empty_output);
    match parsed_empty {
        Err(OrcaError::CommandFailed { code, stderr }) => {
            assert_eq!(code, Some(127));
            assert_eq!(stderr, "command not found");
        }
        other => panic!("Expected CommandFailed, got {other:?}"),
    }
}

#[tokio::test]
async fn test_cleanup_outcome_variants() {
    let temp = tempfile::tempdir().unwrap();

    // 1. pty_stop_verdict == unverifiable -> CleanupOutcome::RecoveryRequired(TERMINAL_STOP_UNVERIFIABLE)
    let script_unv = r#"#!/bin/bash
if [[ "$*" == *"terminal close"* ]]; then
  echo '{"ok":true,"result":{"close":{"handle":"term_1","ptyKilled":false,"ptyStopVerdict":"unverifiable"}}}'
  exit 0
fi
"#;
    let bin_unv = create_mock_orca_script(&temp, script_unv);
    let client_unv = OrcaCliClient::new(bin_unv);
    let adapter_unv = OrcaExecutionAdapter::new(client_unv);
    let outcome_unv = adapter_unv.close("term_1").await;
    match outcome_unv {
        CleanupOutcome::RecoveryRequired { code, message } => {
            assert_eq!(code, "TERMINAL_STOP_UNVERIFIABLE");
            assert!(
                message.contains("unverifiable"),
                "Expected 'unverifiable' in message: {message}"
            );
        }
        other => panic!("Expected RecoveryRequired, got {other:?}"),
    }

    // 2. terminal_handle_stale on close -> CleanupOutcome::RecoveryRequired(TERMINAL_HANDLE_STALE)
    let script_stale = r#"#!/bin/bash
if [[ "$*" == *"terminal close"* ]]; then
  echo '{"ok":false,"error":{"code":"terminal_handle_stale","message":"handle stale"}}'
  exit 1
fi
"#;
    let bin_stale = create_mock_orca_script(&temp, script_stale);
    let client_stale = OrcaCliClient::new(bin_stale);
    let adapter_stale = OrcaExecutionAdapter::new(client_stale);
    let outcome_stale = adapter_stale.close("term_1").await;
    match outcome_stale {
        CleanupOutcome::RecoveryRequired { code, message } => {
            assert_eq!(code, "TERMINAL_HANDLE_STALE");
            assert!(
                message.contains("stale"),
                "Expected 'stale' in message: {message}"
            );
        }
        other => panic!("Expected RecoveryRequired, got {other:?}"),
    }

    // 3. Successful close: close ok with pty_killed=true, inventory empty -> VerifiedClosed
    let script_success = r#"#!/bin/bash
if [[ "$*" == *"terminal close"* ]]; then
  echo '{"ok":true,"result":{"close":{"handle":"term_1","ptyKilled":true}}}'
  exit 0
fi
if [[ "$*" == *"terminal list"* ]]; then
  echo '{"ok":true,"result":{"terminals":[],"truncated":false}}'
  exit 0
fi
"#;
    let bin_success = create_mock_orca_script(&temp, script_success);
    let client_success = OrcaCliClient::new(bin_success);
    let adapter_success = OrcaExecutionAdapter::new(client_success);
    let outcome_success = adapter_success.close("term_1").await;
    assert!(matches!(
        outcome_success,
        CleanupOutcome::VerifiedClosed { .. }
    ));
}

#[test]
fn test_validate_tui_idle_wait_protocol() {
    // 1. ok = false
    let resp_not_ok = OrcaTerminalWaitResponse {
        ok: false,
        result: None,
        error: None,
    };
    assert!(validate_tui_idle_wait("term_1", &resp_not_ok).is_err());

    // 2. missing result
    let resp_no_res = OrcaTerminalWaitResponse {
        ok: true,
        result: None,
        error: None,
    };
    assert!(validate_tui_idle_wait("term_1", &resp_no_res).is_err());

    // 3. handle mismatch
    let resp_mismatch = OrcaTerminalWaitResponse {
        ok: true,
        result: Some(OrcaTerminalWaitResult {
            wait: Some(OrcaWaitPart {
                handle: Some("term_different".into()),
                condition: Some("tui-idle".into()),
                satisfied: true,
                elapsed_ms: Some(150),
            }),
        }),
        error: None,
    };
    let err = validate_tui_idle_wait("term_1", &resp_mismatch).unwrap_err();
    assert!(err.contains("handle mismatch"));

    // 4. condition mismatch
    let resp_cond_mismatch = OrcaTerminalWaitResponse {
        ok: true,
        result: Some(OrcaTerminalWaitResult {
            wait: Some(OrcaWaitPart {
                handle: Some("term_1".into()),
                condition: Some("prompt-ready".into()),
                satisfied: true,
                elapsed_ms: Some(150),
            }),
        }),
        error: None,
    };
    let err = validate_tui_idle_wait("term_1", &resp_cond_mismatch).unwrap_err();
    assert!(err.contains("condition mismatch"));

    // 5. satisfied true
    let resp_satisfied = OrcaTerminalWaitResponse {
        ok: true,
        result: Some(OrcaTerminalWaitResult {
            wait: Some(OrcaWaitPart {
                handle: Some("term_1".into()),
                condition: Some("tui-idle".into()),
                satisfied: true,
                elapsed_ms: Some(250),
            }),
        }),
        error: None,
    };
    assert_eq!(
        validate_tui_idle_wait("term_1", &resp_satisfied).unwrap(),
        ValidatedWait::Satisfied { elapsed_ms: 250 }
    );

    // 6. satisfied false
    let resp_unsatisfied = OrcaTerminalWaitResponse {
        ok: true,
        result: Some(OrcaTerminalWaitResult {
            wait: Some(OrcaWaitPart {
                handle: Some("term_1".into()),
                condition: Some("tui-idle".into()),
                satisfied: false,
                elapsed_ms: Some(300),
            }),
        }),
        error: None,
    };
    assert_eq!(
        validate_tui_idle_wait("term_1", &resp_unsatisfied).unwrap(),
        ValidatedWait::Unsatisfied { elapsed_ms: 300 }
    );
}

#[test]
fn test_active_attempt_v4_schema_and_rejection_of_legacy() {
    let temp = tempfile::tempdir().unwrap();
    let state_file = temp.path().join("attempt.json");

    // Case 1: V1 fails with UnsupportedSchemaVersion(1)
    let v1_json = serde_json::json!({
        "schema_version": 1,
        "server_origin": "http://127.0.0.1:4000",
        "device_id": "dev_test",
        "job_id": "job_1",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": "att-4654f590-7d68-4560-a548-d3e75e5264b3",
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "claimed"
    });
    fs::write(&state_file, serde_json::to_string(&v1_json).unwrap()).unwrap();
    assert!(matches!(
        ActiveAttempt::load(&state_file).unwrap_err(),
        SchedulerError::UnsupportedSchemaVersion(1)
    ));

    // Case 2: V2 fails with UnsupportedSchemaVersion(2)
    let v2_json = serde_json::json!({
        "schema_version": 2,
        "server_origin": "http://127.0.0.1:4000",
        "device_id": "dev_test",
        "job_id": "job_1",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": "att-4654f590-7d68-4560-a548-d3e75e5264b3",
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "claimed"
    });
    fs::write(&state_file, serde_json::to_string(&v2_json).unwrap()).unwrap();
    assert!(matches!(
        ActiveAttempt::load(&state_file).unwrap_err(),
        SchedulerError::UnsupportedSchemaVersion(2)
    ));

    // Case 3: V3 fails with UnsupportedSchemaVersion(3)
    let v3_json = serde_json::json!({
        "schema_version": 3,
        "server_origin": "http://127.0.0.1:4000",
        "device_id": "dev_test",
        "job_id": "job_1",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": "att-4654f590-7d68-4560-a548-d3e75e5264b3",
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "claimed"
    });
    fs::write(&state_file, serde_json::to_string(&v3_json).unwrap()).unwrap();
    assert!(matches!(
        ActiveAttempt::load(&state_file).unwrap_err(),
        SchedulerError::UnsupportedSchemaVersion(3)
    ));

    // Case 4: V4 succeeds
    let prompt = "do task";
    let acceptance = "must work";
    let hash = ActiveAttempt::compute_payload_sha256(
        "job_4", "ws_1", "tgt_1", None, prompt, acceptance, 60, "none",
    );
    let v4_json = serde_json::json!({
        "schema_version": 4,
        "server_origin": "http://127.0.0.1:4000",
        "device_id": "dev_test",
        "job_id": "job_4",
        "workspace_id": "ws_1",
        "target_id": "tgt_1",
        "attempt_id": "att-4654f590-7d68-4560-a548-d3e75e5264b3",
        "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "phase": "outcome_recorded",
        "prompt": prompt,
        "acceptance": acceptance,
        "execution_timeout_seconds": 60,
        "result_target": "none",
        "payload_sha256": hash,
        "executor": {
            "type": "orca",
            "worktree_id": "wt_1",
            "terminal_id": "term_1",
            "agent_id": "agy",
            "agent_ready_at_ms": 1727000000000i64,
            "dispatch_send_count": 1,
            "dispatch_request_id": "req_1",
            "runtime_completion_kind": "tui_idle",
            "runtime_completed_at_ms": 1727000010000i64
        }
    });
    fs::write(&state_file, serde_json::to_string_pretty(&v4_json).unwrap()).unwrap();
    let loaded = ActiveAttempt::load(&state_file).unwrap().unwrap();
    assert_eq!(loaded.schema_version, ACTIVE_ATTEMPT_SCHEMA_VERSION);
    assert_eq!(loaded.phase, AttemptPhase::OutcomeRecorded);

    assert_eq!(
        loaded.executor.unwrap().dispatch_request_id.as_deref(),
        Some("req_1")
    );
}

#[tokio::test]
async fn test_cleanup_regression_matrix() {
    let temp = tempfile::tempdir().unwrap();

    async fn run_close(
        temp: &tempfile::TempDir,
        close_json: &str,
        close_exit: i32,
        list_json: &str,
    ) -> CleanupOutcome {
        let script = format!(
            r#"#!/bin/bash
if [[ "$*" == *"terminal close"* ]]; then
  echo '{close_json}'
  exit {close_exit}
fi
if [[ "$*" == *"terminal list"* ]]; then
  echo '{list_json}'
  exit 0
fi
"#
        );
        let bin = create_mock_orca_script(temp, &script);
        let client = OrcaCliClient::new(bin);
        let adapter = OrcaExecutionAdapter::new(client);
        adapter.close("term_target").await
    }

    // 1. Inventory truncated => RecoveryRequired
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_target","ptyKilled":true}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":true}}"#,
    )
    .await;
    match out {
        CleanupOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "TERMINAL_LIST_TRUNCATED")
        }
        other => panic!("Expected RecoveryRequired(TERMINAL_LIST_TRUNCATED), got {other:?}"),
    }

    // 2. Close response handle mismatch => RecoveryRequired(TERMINAL_CLOSE_CORRELATION_MISMATCH)
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_wrong","ptyKilled":true}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    match out {
        CleanupOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "TERMINAL_CLOSE_CORRELATION_MISMATCH")
        }
        other => {
            panic!("Expected RecoveryRequired(TERMINAL_CLOSE_CORRELATION_MISMATCH), got {other:?}")
        }
    }

    // 3. Normal close (pty_killed=true) + terminal absent from list => VerifiedClosed
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_target","ptyKilled":true}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    assert!(matches!(out, CleanupOutcome::VerifiedClosed { .. }));

    // 4. terminal_not_found + terminal absent from list => AlreadyAbsent
    let out = run_close(
        &temp,
        r#"{"ok":false,"error":{"code":"terminal_not_found","message":"target terminal not found"}}"#,
        1,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    assert!(matches!(out, CleanupOutcome::AlreadyAbsent { .. }));

    // 5. Terminal still in inventory after close => Retryable
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_target","ptyKilled":true}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[{"handle":"term_target","title":"ceo:test"}],"truncated":false}}"#,
    )
    .await;
    assert!(matches!(out, CleanupOutcome::Retryable { .. }));

    // 6. Close payload missing in response => RecoveryRequired(TERMINAL_CLOSE_PAYLOAD_MISSING)
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    match out {
        CleanupOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "TERMINAL_CLOSE_PAYLOAD_MISSING");
        }
        other => {
            panic!("Expected RecoveryRequired(TERMINAL_CLOSE_PAYLOAD_MISSING), got {other:?}")
        }
    }

    // 7. ptyStopVerdict is unverifiable => RecoveryRequired(TERMINAL_STOP_UNVERIFIABLE)
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_target","ptyKilled":false,"ptyStopVerdict":"unverifiable"}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    match out {
        CleanupOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "TERMINAL_STOP_UNVERIFIABLE");
        }
        other => {
            panic!("Expected RecoveryRequired(TERMINAL_STOP_UNVERIFIABLE), got {other:?}")
        }
    }

    // 8. terminal_stop_unverifiable error => RecoveryRequired(TERMINAL_STOP_UNVERIFIABLE)
    let out = run_close(
        &temp,
        r#"{"ok":false,"error":{"code":"terminal_stop_unverifiable","message":"PTY not confirmed stopped"}}"#,
        1,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    match out {
        CleanupOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "TERMINAL_STOP_UNVERIFIABLE");
        }
        other => {
            panic!("Expected RecoveryRequired(TERMINAL_STOP_UNVERIFIABLE), got {other:?}")
        }
    }

    // 9. Clean exit without active kill (ptyKilled=false, no bad verdict) + terminal absent from list => VerifiedClosed
    let out = run_close(
        &temp,
        r#"{"ok":true,"result":{"close":{"handle":"term_target","ptyKilled":false}}}"#,
        0,
        r#"{"ok":true,"result":{"terminals":[],"truncated":false}}"#,
    )
    .await;
    assert!(matches!(out, CleanupOutcome::VerifiedClosed { .. }));
}

#[tokio::test]
async fn test_dispatch_correlation_regression_matrix() {
    let temp = tempfile::tempdir().unwrap();

    let dummy_attempt = ActiveAttempt {
        schema_version: 4,
        server_origin: "http://127.0.0.1:4000".into(),
        device_id: "dev_1".into(),
        job_id: "job_1".into(),
        workspace_id: "ws_1".into(),
        target_id: "tgt_1".into(),
        attempt_id: "att_1".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        phase: AttemptPhase::DispatchIntent,
        resource_id: None,
        prompt: Some("prompt".into()),
        acceptance: Some("acceptance".into()),
        execution_timeout_seconds: Some(60),
        result_target: Some("none".into()),
        payload_sha256: Some("hash".into()),
        claimed_at_ms: Some(1727000000000),
        terminal_report_sha256: None,
        executor: Some(AttemptExecutorState {
            executor_type: "orca".into(),
            orca_version: Some("1.4.209".into()),
            worktree_id: Some("wt_1".into()),
            terminal_id: Some("term_target".into()),
            agent_id: Some("agy".into()),
            agent_ready_at_ms: Some(1727000001000),
            dispatch_send_count: 1,
            dispatch_started_at_ms: Some(1727000002000),
            execution_deadline_ms: Some(1727000062000),
            dispatch_request_id: None,
            dispatch_accepted_at_ms: None,
            dispatch_turn_started: false,
            dispatch_baseline_state_started_at: None,
            turn_started_observed: false,
            last_dispatch_outcome: None,
            runtime_completion_kind: None,
            runtime_completed_at_ms: None,
            runtime_error: None,
        }),
    };

    async fn run_dispatch(
        temp: &tempfile::TempDir,
        attempt: &ActiveAttempt,
        send_json: &str,
    ) -> DispatchOutcome {
        let script = format!(
            r#"#!/bin/bash
if [[ "$*" == *"terminal send"* ]]; then
  echo '{send_json}'
  exit 0
fi
"#
        );
        let bin = create_mock_orca_script(temp, &script);
        let client = OrcaCliClient::new(bin);
        let adapter = OrcaExecutionAdapter::new(client);
        adapter
            .dispatch(attempt, "term_target", "test prompt")
            .await
            .unwrap()
    }

    // 1. send.handle != requested terminal => DISPATCH_TERMINAL_CORRELATION_MISMATCH
    let out = run_dispatch(
        &temp,
        &dummy_attempt,
        r#"{"ok":true,"result":{"send":{"handle":"term_other","accepted":true,"prompt":{"requestId":"req_expected"}}}}"#,
    )
    .await;
    match out {
        DispatchOutcome::RecoveryRequired { code, .. } => {
            assert_eq!(code, "DISPATCH_TERMINAL_CORRELATION_MISMATCH")
        }
        other => panic!("Expected DISPATCH_TERMINAL_CORRELATION_MISMATCH, got {other:?}"),
    }

    // 2. accepted = true with requestId => Accepted
    let out = run_dispatch(
        &temp,
        &dummy_attempt,
        r#"{"ok":true,"result":{"send":{"handle":"term_target","accepted":true,"prompt":{"requestId":"req_expected"}}}}"#,
    )
    .await;
    match out {
        DispatchOutcome::Accepted { request_id, .. } => {
            assert_eq!(request_id, "req_expected");
        }
        other => panic!("Expected Accepted, got {other:?}"),
    }

    // 3. accepted = true with missing requestId => AmbiguousTransportFailure
    let out = run_dispatch(
        &temp,
        &dummy_attempt,
        r#"{"ok":true,"result":{"send":{"handle":"term_target","accepted":true,"prompt":{"requestId":null}}}}"#,
    )
    .await;
    match out {
        DispatchOutcome::AmbiguousTransportFailure { error } => {
            assert!(error.contains("missing"));
        }
        other => panic!("Expected AmbiguousTransportFailure, got {other:?}"),
    }

    // 4. accepted = false => KnownRejectedBeforeAcceptance
    let out = run_dispatch(
        &temp,
        &dummy_attempt,
        r#"{"ok":true,"result":{"send":{"handle":"term_target","accepted":false,"prompt":{"requestId":null}}}}"#,
    )
    .await;
    match out {
        DispatchOutcome::KnownRejectedBeforeAcceptance { .. } => {}
        other => panic!("Expected KnownRejectedBeforeAcceptance, got {other:?}"),
    }
}

#[tokio::test]
async fn test_readiness_satisfied_prepares_normally() {
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
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_sat","title":"ceo:att_sat:agy"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_sat","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_sat","condition":"tui-idle","satisfied":true}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_sat".into(),
        attempt_id: "att_sat".into(),
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
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.terminal_id, "term_sat");
    assert!(prep.agent_ready_at_ms.is_some());
    assert!(prep.agent_ready_at_ms.unwrap() > 0);
}

#[tokio::test]
async fn test_readiness_unsatisfied_still_prepares_with_none_ready_at() {
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
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_unsat","title":"ceo:att_unsat:agy"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_unsat","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_unsat","condition":"tui-idle","satisfied":false}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_unsat".into(),
        attempt_id: "att_unsat".into(),
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
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.terminal_id, "term_unsat");
    assert_eq!(prep.agent_ready_at_ms, None);
}

#[tokio::test]
async fn test_readiness_timeout_still_prepares_with_none_ready_at() {
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
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_to","title":"ceo:att_to:agy"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_to","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":false,"error":{{"code":"timeout","message":"terminal wait timed out"}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_to".into(),
        attempt_id: "att_to".into(),
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
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };
    assert_eq!(prep.terminal_id, "term_to");
    assert_eq!(prep.agent_ready_at_ms, None);
}

#[tokio::test]
async fn test_readiness_protocol_mismatch_fails_with_recovery_required() {
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
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_mismatch","title":"ceo:att_mismatch:agy"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_mismatch","connected":true,"writable":true}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    # Return different handle in wait result => protocol mismatch!
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_different_alien","condition":"tui-idle","satisfied":true}}}}}}'
else
    echo '{{"ok":false}}'
fi
"#
    );

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let target = LocalTarget {
        local_path: repo_canon,
        executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_mis".into(),
        attempt_id: "att_mis".into(),
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

    let outcome = adapter.prepare(&attempt, &target).await.unwrap();
    match outcome {
        PrepareOutcome::RecoveryRequired { reason, .. } => {
            assert!(reason.contains("mismatch") || reason.contains("term_different_alien"));
        }
        other => panic!("expected PrepareOutcome::RecoveryRequired, got {other:?}"),
    }
}

#[tokio::test]
async fn test_worktree_ps_deserialization_and_agent_parsing() {
    let temp = tempfile::tempdir().unwrap();
    let script = r#"#!/bin/bash
if [ "$1" = "worktree" ] && [ "$2" = "ps" ]; then
    echo '{"ok":true,"result":{"worktrees":[{"worktreeId":"wt_1","agents":[{"paneKey":"tab1:leaf1","state":"working","interrupted":false,"stateStartedAt":1727000100},{"paneKey":"tab1:leaf2","state":"done","interrupted":false,"stateStartedAt":1727000200}]}]}}'
else
    echo '{"ok":false}'
fi
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);

    let resp = client
        .worktree_ps_bounded(Duration::from_millis(800))
        .await
        .unwrap();
    assert!(resp.ok);
    let result = resp.result.unwrap();
    assert_eq!(result.worktrees.len(), 1);
    assert_eq!(result.worktrees[0].agents.len(), 2);
    assert_eq!(result.worktrees[0].agents[0].pane_key, "tab1:leaf1");
    assert_eq!(result.worktrees[0].agents[0].state, "working");
    assert_eq!(
        result.worktrees[0].agents[0].state_started_at,
        Some(1727000100)
    );
    assert_eq!(result.worktrees[0].agents[1].pane_key, "tab1:leaf2");
    assert_eq!(result.worktrees[0].agents[1].state, "done");
}

#[tokio::test]
async fn test_exact_pane_isolation_ignores_other_agents_in_same_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    # Our target terminal is tab1:leaf1
    echo '{"ok":true,"result":{"terminal":{"handle":"term_my_pane","tabId":"tab1","leafId":"leaf1"}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "ps" ]; then
    # Another agent tab1:leaf2 is done, but our pane tab1:leaf1 is NOT done (or idle/absent)
    echo '{"ok":true,"result":{"worktrees":[{"worktreeId":"wt_1","agents":[{"paneKey":"tab1:leaf2","state":"done","interrupted":false,"stateStartedAt":1727000500}]}]}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":true,"result":{"wait":{"handle":"term_my_pane","condition":"tui-idle","satisfied":false,"elapsedMs":100}}}'
else
    echo '{"ok":false}'
fi
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_iso".into(),
        attempt_id: "att_iso".into(),
        claim_token: "token".into(),
        device_id: "dev_1".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::Waiting,
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
        executor: Some(AttemptExecutorState {
            executor_type: "orca".into(),
            orca_version: Some("1.4.209".into()),
            worktree_id: Some("wt_1".into()),
            terminal_id: Some("term_my_pane".into()),
            agent_id: Some("agy".into()),
            agent_ready_at_ms: Some(1727000000),
            dispatch_send_count: 1,
            dispatch_started_at_ms: Some(1727000010),
            execution_deadline_ms: Some(1727000000 + 60_000),
            dispatch_request_id: Some("req_1".into()),
            dispatch_accepted_at_ms: Some(1727000010),
            dispatch_turn_started: true,
            dispatch_baseline_state_started_at: None,
            turn_started_observed: true,
            last_dispatch_outcome: None,
            runtime_completion_kind: None,
            runtime_completed_at_ms: None,
            runtime_error: None,
        }),
    };

    let wait_outcome = adapter
        .wait(&attempt, "term_my_pane", Duration::from_millis(500))
        .await
        .unwrap();
    // Because tab1:leaf2 done does NOT match tab1:leaf1, adapter does not return AgentDone; it falls through to tui-idle wait (which timed out)
    match wait_outcome {
        WaitOutcome::TimedOut { .. } => {}
        other => panic!("expected TimedOut because foreign pane must be ignored, got {other:?}"),
    }
}

#[tokio::test]
async fn test_worktree_ps_bounded_timeout_and_transient_failure_does_not_abort_wait() {
    let temp = tempfile::tempdir().unwrap();
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_my_pane","tabId":"tab1","leafId":"leaf1"}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "ps" ]; then
    # Simulate worktree ps failure or timeout
    echo '{"ok":false,"error":{"code":"internal_error","message":"daemon busy"}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    # Fallback to wait terminal succeeds
    echo '{"ok":true,"result":{"wait":{"handle":"term_my_pane","condition":"tui-idle","satisfied":true,"elapsedMs":50}}}'
else
    echo '{"ok":false}'
fi
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_fallback".into(),
        attempt_id: "att_fallback".into(),
        claim_token: "token".into(),
        device_id: "dev_1".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::Waiting,
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
        executor: Some(AttemptExecutorState {
            executor_type: "orca".into(),
            orca_version: Some("1.4.209".into()),
            worktree_id: Some("wt_1".into()),
            terminal_id: Some("term_my_pane".into()),
            agent_id: Some("agy".into()),
            agent_ready_at_ms: Some(1727000000),
            dispatch_send_count: 1,
            dispatch_started_at_ms: Some(1727000010),
            execution_deadline_ms: Some(1727000000 + 60_000),
            dispatch_request_id: Some("req_1".into()),
            dispatch_accepted_at_ms: Some(1727000010),
            dispatch_turn_started: true,
            dispatch_baseline_state_started_at: None,
            turn_started_observed: true,
            last_dispatch_outcome: None,
            runtime_completion_kind: None,
            runtime_completed_at_ms: None,
            runtime_error: None,
        }),
    };

    let wait_outcome = adapter
        .wait(&attempt, "term_my_pane", Duration::from_millis(500))
        .await
        .unwrap();
    match wait_outcome {
        WaitOutcome::TuiIdle { .. } => {}
        other => {
            panic!("expected TuiIdle fallback when worktree ps transiently fails, got {other:?}")
        }
    }
}

#[tokio::test]
async fn test_wait_baseline_generation_stale_done_does_not_complete() {
    let temp = tempfile::tempdir().unwrap();

    fn attempt_with_baseline(baseline: Option<i64>) -> ActiveAttempt {
        ActiveAttempt {
            schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
            job_id: "job_gen".into(),
            attempt_id: "att_gen".into(),
            claim_token: "token".into(),
            device_id: "dev_1".into(),
            server_origin: "http://127.0.0.1:4000".into(),
            phase: AttemptPhase::Waiting,
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
            executor: Some(AttemptExecutorState {
                executor_type: "orca".into(),
                orca_version: Some("1.4.209".into()),
                worktree_id: Some("wt_1".into()),
                terminal_id: Some("term_my_pane".into()),
                agent_id: Some("agy".into()),
                agent_ready_at_ms: Some(1727000000),
                dispatch_send_count: 1,
                dispatch_started_at_ms: Some(1727000010),
                execution_deadline_ms: Some(1727000000 + 60_000),
                dispatch_request_id: Some("req_1".into()),
                dispatch_accepted_at_ms: Some(1727000010),
                dispatch_turn_started: false,
                dispatch_baseline_state_started_at: baseline,
                turn_started_observed: false,
                last_dispatch_outcome: None,
                runtime_completion_kind: None,
                runtime_completed_at_ms: None,
                runtime_error: None,
            }),
        }
    }

    // Pre-dispatch (baseline) agent state: done at 1727000100.
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_my_pane","tabId":"tab1","leafId":"leaf1","connected":true}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "ps" ]; then
    echo '{"ok":true,"result":{"worktrees":[{"worktreeId":"wt_1","agents":[{"paneKey":"tab1:leaf1","state":"done","interrupted":false,"stateStartedAt":1727000100}]}]}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":true,"result":{"wait":{"handle":"term_my_pane","condition":"tui-idle","satisfied":false,"elapsedMs":100}}}'
else
    echo '{"ok":false}'
fi
"#;
    let bin = create_mock_orca_script(&temp, script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    // 1. Stale/baseline done (same stateStartedAt as baseline) must NOT
    //    complete the turn: falls through to tui-idle wait (unsatisfied).
    let attempt = attempt_with_baseline(Some(1727000100));
    let wait_outcome = adapter
        .wait(&attempt, "term_my_pane", Duration::from_millis(500))
        .await
        .unwrap();
    match wait_outcome {
        WaitOutcome::TimedOut { .. } => {}
        other => panic!("expected TimedOut for stale baseline done state, got {other:?}"),
    }

    // 2. New-generation done (different stateStartedAt) DOES complete as
    //    AgentDone even without explicit turn_started evidence.
    let attempt = attempt_with_baseline(Some(1727000100));
    let script_new_gen = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_my_pane","tabId":"tab1","leafId":"leaf1","connected":true}}}'
elif [ "$1" = "worktree" ] && [ "$2" = "ps" ]; then
    echo '{"ok":true,"result":{"worktrees":[{"worktreeId":"wt_1","agents":[{"paneKey":"tab1:leaf1","state":"done","interrupted":false,"stateStartedAt":1727000200}]}]}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":true,"result":{"wait":{"handle":"term_my_pane","condition":"tui-idle","satisfied":false,"elapsedMs":100}}}'
else
    echo '{"ok":false}'
fi
"#;
    let bin_new_gen = create_mock_orca_script(&temp, script_new_gen);
    let client_new_gen = OrcaCliClient::new(bin_new_gen);
    let adapter_new_gen = OrcaExecutionAdapter::new(client_new_gen);

    let wait_outcome = adapter_new_gen
        .wait(&attempt, "term_my_pane", Duration::from_millis(500))
        .await
        .unwrap();
    match wait_outcome {
        WaitOutcome::AgentDone { .. } => {}
        other => panic!("expected AgentDone for new-generation done state, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Bug 2 regression: Orca operator-closed / orphaned terminal tombstones.
// Orca can retain an authoritative non-live terminal object (tombstone)
// instead of returning terminal_not_found; wait/recovery must classify such
// state as interrupted immediately instead of polling until the execution
// deadline. Ambiguous/transient failures and non-writable-only states must
// NOT be treated as terminal death.
// ---------------------------------------------------------------------------

#[test]
fn test_terminal_liveness_classification() {
    // 1. Reproduced operator-close tombstone (real dogfood response shape).
    let tombstone: OrcaTerminalItem = serde_json::from_str(
        r#"{"handle":"term_1","orphaned":true,"connected":false,"writable":false,
            "exitCause":{"kind":"operator_close"},"paneRuntimeId":-1}"#,
    )
    .unwrap();
    match tombstone.liveness() {
        TerminalLiveness::DefinitelyExited { reason } => {
            assert!(reason.contains("operator_close"), "reason: {reason}");
        }
        other => panic!("expected DefinitelyExited, got {other:?}"),
    }

    // 2. orphaned=true alone (no structured exit cause) must classify as exited.
    let orphaned_only: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_2","orphaned":true}"#).unwrap();
    match orphaned_only.liveness() {
        TerminalLiveness::DefinitelyExited { reason } => {
            assert!(reason.contains("orphaned"), "reason: {reason}");
        }
        other => panic!("expected DefinitelyExited, got {other:?}"),
    }

    // 3. connected=false with an explicit exit cause (no orphaned flag) must
    //    classify as exited and include the exitCause kind.
    let exit_cause_only: OrcaTerminalItem = serde_json::from_str(
        r#"{"handle":"term_3","connected":false,"exitCause":{"kind":"operator_close"}}"#,
    )
    .unwrap();
    match exit_cause_only.liveness() {
        TerminalLiveness::DefinitelyExited { reason } => {
            assert!(reason.contains("operator_close"), "reason: {reason}");
        }
        other => panic!("expected DefinitelyExited, got {other:?}"),
    }

    // 4. Structured exited state via exitCause kind variations.
    let exited: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_4","exitCause":{"kind":"terminal_exited"}}"#)
            .unwrap();
    match exited.liveness() {
        TerminalLiveness::DefinitelyExited { reason } => {
            assert!(reason.contains("terminal_exited"), "reason: {reason}");
        }
        other => panic!("expected DefinitelyExited, got {other:?}"),
    }

    // 5. Live connected terminal classifies as Live.
    let live: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_5","connected":true}"#).unwrap();
    assert_eq!(live.liveness(), TerminalLiveness::Live);

    // 6. Non-writable alone must NOT be terminal death.
    let non_writable: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_6","writable":false}"#).unwrap();
    assert!(!matches!(
        non_writable.liveness(),
        TerminalLiveness::DefinitelyExited { .. }
    ));

    // 7. connected=false without any explicit exit cause stays ambiguous.
    let disconnected_only: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_7","connected":false}"#).unwrap();
    assert!(!matches!(
        disconnected_only.liveness(),
        TerminalLiveness::DefinitelyExited { .. }
    ));

    // 8. Legacy payload without liveness fields classifies as Unknown.
    let legacy: OrcaTerminalItem =
        serde_json::from_str(r#"{"handle":"term_8","tabId":"tab1","leafId":"leaf1"}"#).unwrap();
    assert_eq!(legacy.liveness(), TerminalLiveness::Unknown);
}

fn waiting_attempt_without_executor() -> ActiveAttempt {
    ActiveAttempt {
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
    }
}

async fn wait_with_script(script: &str) -> (WaitOutcome, String) {
    let temp = tempfile::tempdir().unwrap();
    let wait_log = temp.path().join("wait_invocations.log");
    let script = script.replace("{WAIT_LOG}", &wait_log.display().to_string());

    let bin = create_mock_orca_script(&temp, &script);
    let client = OrcaCliClient::new(bin);
    let adapter = OrcaExecutionAdapter::new(client);

    let attempt = waiting_attempt_without_executor();
    let outcome = adapter
        .wait(&attempt, "term_x", Duration::from_secs(3600))
        .await
        .unwrap();
    let invoked = fs::read_to_string(&wait_log).unwrap_or_default();
    (outcome, invoked)
}

#[tokio::test]
async fn test_wait_operator_closed_tombstone_interrupts_immediately() {
    // Full reproduced dogfood state: orphaned, disconnected, non-writable,
    // exitCause.kind=operator_close. The wait command would report
    // satisfied=true (claiming completion) but must never be reached.
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_x","title":"ceo:att","preview":"stale","orphaned":true,"connected":false,"writable":false,"exitCause":{"kind":"operator_close"},"paneRuntimeId":-1}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo "WAIT_INVOKED" >> "{WAIT_LOG}"
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":true,"elapsedMs":10}}}'
else
    echo '{"ok":false,"error":{"code":"unknown_command","message":"unexpected"}}'
fi
"#;

    let (outcome, wait_invoked) = wait_with_script(script).await;
    match outcome {
        WaitOutcome::Interrupted { reason } => {
            assert!(reason.contains("operator_close"), "reason: {reason}");
            assert!(reason.contains("term_x"), "reason: {reason}");
        }
        other => panic!("expected Interrupted, got {other:?}"),
    }
    // Interrupt must happen immediately: no bounded tui-idle polling and no
    // waiting until the execution deadline.
    assert!(!wait_invoked.contains("WAIT_INVOKED"));
}

#[tokio::test]
async fn test_wait_orphaned_only_tombstone_interrupts_immediately() {
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_x","orphaned":true}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo "WAIT_INVOKED" >> "{WAIT_LOG}"
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":true,"elapsedMs":10}}}'
else
    echo '{"ok":false,"error":{"code":"unknown_command","message":"unexpected"}}'
fi
"#;

    let (outcome, wait_invoked) = wait_with_script(script).await;
    match outcome {
        WaitOutcome::Interrupted { reason } => {
            assert!(reason.contains("orphaned"), "reason: {reason}");
        }
        other => panic!("expected Interrupted, got {other:?}"),
    }
    assert!(!wait_invoked.contains("WAIT_INVOKED"));
}

#[tokio::test]
async fn test_wait_connected_with_exit_cause_interrupts_immediately() {
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_x","connected":false,"exitCause":{"kind":"operator_close","message":"user closed the pane"}}}}'
else
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":true,"elapsedMs":10}}}'
fi
"#;

    let (outcome, _wait_invoked) = wait_with_script(script).await;
    match outcome {
        WaitOutcome::Interrupted { reason } => {
            assert!(reason.contains("operator_close"), "reason: {reason}");
        }
        other => panic!("expected Interrupted, got {other:?}"),
    }
}

#[tokio::test]
async fn test_wait_live_connected_terminal_continues_existing_wait_behavior() {
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_x","connected":true,"tabId":"tab1","leafId":"leaf1"}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo "WAIT_INVOKED" >> "{WAIT_LOG}"
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":true,"elapsedMs":100}}}'
else
    echo '{"ok":false,"error":{"code":"internal_error","message":"daemon busy"}}'
fi
"#;

    let (outcome, wait_invoked) = wait_with_script(script).await;
    match outcome {
        WaitOutcome::TuiIdle { .. } => {}
        other => panic!("expected TuiIdle for live terminal, got {other:?}"),
    }
    assert!(wait_invoked.contains("WAIT_INVOKED"));
}

#[tokio::test]
async fn test_wait_non_writable_alone_is_not_interrupted() {
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":true,"result":{"terminal":{"handle":"term_x","writable":false}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":true,"elapsedMs":100}}}'
else
    echo '{"ok":false}'
fi
"#;

    let (outcome, _wait_invoked) = wait_with_script(script).await;
    assert_eq!(outcome, WaitOutcome::TuiIdle { elapsed_ms: 100 });
}

#[tokio::test]
async fn test_wait_transient_show_failure_is_not_falsely_interrupted() {
    // Show transport/garbage failure must retain ambiguous/bounded behavior;
    // the existing bounded tui-idle observation continues.
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo 'totally not json' >&2
    exit 1
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":true,"result":{"wait":{"handle":"term_x","condition":"tui-idle","satisfied":false,"elapsedMs":1500}}}'
else
    echo '{"ok":false}'
fi
"#;

    let (outcome, _wait_invoked) = wait_with_script(script).await;
    assert!(matches!(outcome, WaitOutcome::TimedOut { .. }));
}

#[tokio::test]
async fn test_wait_terminal_not_found_error_path_remains_interrupted() {
    let script = r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{"ok":false,"error":{"code":"terminal_not_found","message":"no such terminal"}}'
    exit 1
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{"ok":false,"error":{"code":"terminal_not_found","message":"no such terminal"}}'
    exit 1
else
    echo '{"ok":false}'
fi
"#;

    let (outcome, _wait_invoked) = wait_with_script(script).await;
    match outcome {
        WaitOutcome::Interrupted { reason } => {
            assert!(reason.contains("terminal_not_found"), "reason: {reason}");
        }
        other => panic!("expected Interrupted, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Daemon recovery regression: a Waiting attempt whose Orca terminal was
// operator-closed while the Connector was down must converge automatically to
// the documented dogfood semantics (interrupted / TERMINAL_EXITED / FAILED)
// and clear the durable active attempt through the existing lifecycle,
// without waiting for the execution deadline.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_daemon_recovery_waiting_with_operator_closed_terminal_converges_to_interrupted() {
    use ceo_connector::client::ConnectorClient;
    use ceo_connector::credential::DeviceCredential;
    use ceo_connector::daemon::{drive_active_attempt, DaemonHooks};
    use ceo_connector::outbox::flush_outbox;
    use ceo_connector::paths::ConnectorPaths;
    use common::mock_server::{MockResponse, MockServer};

    let server = MockServer::start().await;
    let report_bodies = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let report_bodies_clone = report_bodies.clone();

    server.add_handler(move |req| {
        if req.path.contains("/report") && req.method == "POST" {
            report_bodies_clone
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(&req.body).to_string());
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-28T12:00:00.000Z"
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

    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();

    // Fake Orca: authoritative show returns the operator-closed tombstone.
    // The wait command would claim satisfied=true, but it must be
    // short-circuited immediately by the tombstone classification.
    let wait_log = temp.path().join("wait_invocations.log");
    let script = format!(
        r#"#!/bin/bash
if [ "$1" = "terminal" ] && [ "$2" = "show" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_orphan","orphaned":true,"connected":false,"writable":false,"exitCause":{{"kind":"operator_close"}},"paneRuntimeId":-1}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo "WAIT_INVOKED" >> "{}"
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_orphan","condition":"tui-idle","satisfied":true,"elapsedMs":10}}}}}}'
else
    echo '{{"ok":false,"error":{{"code":"unknown_command","message":"unexpected"}}}}'
fi
"#,
        wait_log.display()
    );
    let bin = create_mock_orca_script(&temp, &script);
    let adapter = OrcaExecutionAdapter::new(OrcaCliClient::new(bin));
    let client = ConnectorClient::new(&server.origin()).unwrap();

    // Reproduce the real observed pre-crash attempt state: already claimed,
    // prepared, dispatched, started, waiting with a 3600s execution timeout.
    let now = chrono::Utc::now().timestamp_millis();
    let attempt_id = format!("att-{}", uuid::Uuid::new_v4());
    let mut exec = AttemptExecutorState::new_orca();
    exec.orca_version = Some("1.4.209".into());
    exec.worktree_id = Some("wt_orphan".into());
    exec.terminal_id = Some("term_orphan".into());
    exec.agent_id = Some("agy".into());
    exec.agent_ready_at_ms = Some(now - 120_000);
    exec.dispatch_send_count = 1;
    exec.dispatch_started_at_ms = Some(now - 60_000);
    exec.execution_deadline_ms = Some(now + 3_600_000);
    exec.dispatch_request_id = Some("req_disp_orphan".into());
    exec.dispatch_turn_started = true;
    exec.turn_started_observed = true;

    let payload_sha256 = ActiveAttempt::compute_payload_sha256(
        "job_orphan",
        "ws_1",
        "tgt_1",
        None,
        "run the task",
        "task done",
        3600,
        "none",
    );

    let active = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        server_origin: server.origin(),
        device_id: "dev_1".into(),
        job_id: "job_orphan".into(),
        workspace_id: "ws_1".into(),
        target_id: "tgt_1".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        phase: AttemptPhase::Waiting,
        resource_id: None,
        prompt: Some("run the task".into()),
        acceptance: Some("task done".into()),
        execution_timeout_seconds: Some(3600),
        result_target: Some("none".into()),
        payload_sha256: Some(payload_sha256),
        claimed_at_ms: Some(now - 120_000),
        terminal_report_sha256: None,
        executor: Some(exec),
    };
    active.save(&paths.active_attempt_file()).unwrap();

    // Drive 1: Waiting -> adapter wait observes the tombstone -> Interrupted
    // -> OutcomeRecorded. Must NOT wait until the 3600s execution deadline.
    let advanced = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(Arc::new(adapter.clone()) as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    let current = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(current.phase, AttemptPhase::OutcomeRecorded);
    let exec = current.executor.as_ref().unwrap();
    assert_eq!(
        exec.runtime_completion_kind.as_deref(),
        Some("interrupted"),
        "must converge to runtime_completion_kind=interrupted"
    );
    let err = exec.runtime_error.as_ref().expect("runtime_error expected");
    assert_eq!(err.stage, "runtime");
    assert_eq!(err.code, "TERMINAL_EXITED");
    assert!(
        err.message.contains("operator_close"),
        "message: {}",
        err.message
    );

    // Drive 2: OutcomeRecorded -> outbox written -> FinalizedLocal + delivery.
    let advanced = drive_active_attempt(
        &paths,
        &client,
        &cred,
        &(Arc::new(adapter) as Arc<dyn ExecutionAdapter>),
        &DaemonHooks::default(),
    )
    .await
    .unwrap();
    assert!(advanced);

    // Report delivered with FAILED / FAILED / TERMINAL_EXITED semantics.
    let bodies = report_bodies.lock().unwrap().clone();
    assert!(
        !bodies.is_empty(),
        "terminal report must have been delivered"
    );
    let body = &bodies[0];
    assert!(body.contains("TERMINAL_EXITED"), "report body: {body}");
    assert!(body.contains("FAILED"), "report body: {body}");

    // Durable lifecycle cleanup: active attempt and outbox record cleared.
    assert!(!paths.active_attempt_file().exists());
    assert!(!paths.outbox_file("job_orphan", &attempt_id).exists());
    assert!(paths.history_file("job_orphan", &attempt_id).exists());

    // Flush is a no-op afterwards.
    let flushed = flush_outbox(&paths, &client, &cred).await.unwrap();
    assert_eq!(flushed, 0);

    // No bounded wait polling happened: the tombstone interrupted immediately.
    let wait_log = fs::read_to_string(&wait_log).unwrap_or_default();
    assert!(!wait_log.contains("WAIT_INVOKED"));
}
