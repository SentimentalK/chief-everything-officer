use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::time::Duration;

use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::receipt::ExecutionReceipt;
use ceo_connector::orca::types::*;

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
    assert_eq!(wait_part.condition, "tui-idle");

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
    let script_path = temp.path().join("mock-orca");
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
elif [ "$1" = "terminal" ] && [ "$2" = "create" ]; then
    echo '{{"ok":true,"result":{{"terminal":{{"handle":"term_1","title":"ceo:att_1"}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "send" ]; then
    echo '{{"ok":true,"result":{{"send":{{"handle":"term_1","accepted":true,"bytesWritten":10,"prompt":{{"requestId":"req_123","stages":["input_accepted"]}}}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "wait" ]; then
    echo '{{"ok":true,"result":{{"wait":{{"handle":"term_1","condition":"tui-idle","satisfied":true,"elapsedMs":100}}}}}}'
elif [ "$1" = "terminal" ] && [ "$2" = "close" ]; then
    echo '{{"ok":true,"result":{{"close":{{"handle":"term_1","closeMode":"tab","ptyKilled":false}}}}}}'
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
        status
            .result
            .unwrap()
            .runtime
            .app_version
            .as_deref(),
        Some("1.4.209")
    );

    // Test list_worktrees
    let wts = client.list_worktrees().await.unwrap();
    assert_eq!(wts.len(), 1);
    assert_eq!(wts[0].id, "wt_1");

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
    assert!(msg.contains("not_found: target terminal not found"));
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
        dispatch_request_id: Some("req_xyz".into()),
        task_dispatched: true,
        runtime_completion_kind: Some("tui_idle".into()),
        dispatch_started_at_ms: Some(1727220000000),
        runtime_completed_at_ms: Some(1727220001000),
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
