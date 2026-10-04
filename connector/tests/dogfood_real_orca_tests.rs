#![cfg(unix)]
// Unix-only integration suite: the Orca CLI fixtures are driven by bash shims
// (shebang scripts + chmod). Not compiled on Windows.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::paths::ConnectorPaths;
use common::mock_server::{MockRequest, MockResponse, MockServer};
use uuid::Uuid;

use ceo_connector::scheduler::{
    ActiveAttempt, AttemptPhase, ExecutionAdapter, PrepareOutcome, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};

fn setup_dogfood_env_with_cmd(
    server_origin: &str,
    target_path: &str,
    mode: &str,
    agent_id: &str,
    custom_cmd: Option<&str>,
) -> (
    tempfile::TempDir,
    ConnectorPaths,
    DeviceCredential,
    LocalConfig,
) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".ceo");
    let paths = ConnectorPaths::from_root(&root);
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server_origin.to_string(),
        "usr_dogfood".into(),
        "dev_dogfood".into(),
        "dcr_dogfood".into(),
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        chrono::Utc::now().timestamp_millis() + 86_400_000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let exec_cmd = if let Some(cmd) = custom_cmd {
        cmd.to_string()
    } else {
        let shim_path = temp.path().join("dogfood-agent-shim");
        let script_content = if mode == "timeout" {
            "#!/bin/bash\nprintf \"cursor agent →\\n\"\nread line\nprintf \"working \\u280b ...\\n\"\nsleep 60\n"
        } else {
            // "normal" mode: agent consumes the prompt, goes idle briefly,
            // then stays alive well past the 25s job deadline so the
            // retained-terminal inspection below is deterministic.
            "#!/bin/bash\nprintf \"cursor agent →\\n\"\nread line\nprintf \"working \\u280b ...\\n\"\nsleep 1\nprintf \"cursor agent →\\n\"\nsleep 90\n"
        };
        std::fs::write(&shim_path, script_content).unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&shim_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shim_path, perms).unwrap();
        shim_path.to_str().unwrap().to_string()
    };

    let mut config = LocalConfig::new(server_origin.to_string()).unwrap();
    config.targets.insert(
        "tgt_dogfood".into(),
        LocalTarget {
            local_path: target_path.to_string(),
            executor: Some(LocalExecutorConfig::new(agent_id.into(), exec_cmd).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred, config)
}

fn setup_dogfood_env(
    server_origin: &str,
    target_path: &str,
    mode: &str,
) -> (
    tempfile::TempDir,
    ConnectorPaths,
    DeviceCredential,
    LocalConfig,
) {
    setup_dogfood_env_with_cmd(server_origin, target_path, mode, "synthetic", None)
}

async fn check_orca_available() -> bool {
    let client = OrcaCliClient::default();
    let status_ok = match client.status().await {
        Ok(s) => {
            s.ok && s
                .result
                .map(|r| r.app.running && r.runtime.state == "ready")
                .unwrap_or(false)
        }
        Err(_) => false,
    };
    if !status_ok {
        eprintln!(
            "[DOGFOOD] Orca daemon is not running or ready. Skipping real Orca dogfood test."
        );
        return false;
    }

    true
}

/// Real Orca + Synthetic TUI Agent integration test
#[tokio::test]
async fn test_dogfood_real_orca_synthetic_agent_suite() {
    if !check_orca_available().await {
        return;
    }

    let repo_path = "/home/sentimentalk/codes/chief-everything-officer";

    // =========================================================================
    // Real Run 1: Unobservable Synthetic Agent (pre-turn tui-idle must NOT
    // complete; only the durable deadline may end the run)
    // =========================================================================
    println!("\n=== [DOGFOOD] Starting Real Run 1: Unobservable Synthetic Agent ===");
    {
        let server = MockServer::start().await;
        let (_temp, paths, _cred, _config) =
            setup_dogfood_env(&server.origin(), repo_path, "normal");

        let job_id = format!("job-{}", Uuid::new_v4());
        let claim_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let job_claimed = Arc::new(AtomicBool::new(false));
        let job_claimed_clone = job_claimed.clone();
        let jid = job_id.clone();

        server.add_handler(move |req: &MockRequest| {
            if req.path == "/api/connector/identity" && req.method == "GET" {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "user_id": "usr_dogfood",
                        "device": { "id": "dev_dogfood", "display_name": "Dogfood Device", "platform": "linux-x86_64" },
                        "credential": { "id": "dcr_dogfood", "expires_at_ms": 2000000000000i64 }
                    }),
                );
            }

            if req.path == "/api/connector/targets" && req.method == "GET" {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "targets": [{
                            "target": {
                                "id": "tgt_dogfood",
                                "workspace_id": "ws_dogfood",
                                "alias": "dogfood-target",
                                "display_name": "Dogfood Target",
                                "kind": "coding",
                                "repository": null,
                                "disabled": false
                            },
                            "this_device_binding": {
                                "id": "bnd_dogfood",
                                "enabled": true
                            },
                            "active_binding_count": 1
                        }]
                    }),
                );
            }

            if req.method == "GET" && req.path.starts_with("/api/connector/jobs/pending") {
                if !job_claimed_clone.load(Ordering::SeqCst) {
                    return MockResponse::json(
                        200,
                        &serde_json::json!({
                            "jobs": [{
                                "job_id": jid,
                                "workspace_id": "ws_dogfood",
                                "target_id": "tgt_dogfood",
                                "resource_id": null,
                                "created_at": chrono::Utc::now().to_rfc3339(),
                                "expires_at": null,
                            }]
                        }),
                    );
                } else {
                    return MockResponse::json(200, &serde_json::json!({ "jobs": [] }));
                }
            }

            if req.method == "POST" && req.path.contains("/claim") {
                job_claimed_clone.store(true, Ordering::SeqCst);
                let body: serde_json::Value = req.json().unwrap();
                let req_attempt_id = body.get("attempt_id").and_then(|v| v.as_str()).unwrap().to_string();
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                        "attempt": {
                            "attempt_id": req_attempt_id,
                            "phase": "claimed",
                            "claimed_at": chrono::Utc::now().to_rfc3339(),
                            "started_at": null,
                        },
                        "job": {
                            "job_id": jid,
                            "workspace_id": "ws_dogfood",
                            "target_id": "tgt_dogfood",
                            "resource_id": null,
                            "prompt": "echo 'v1.7 dogfood verification' and complete normally",
                            "acceptance": "Echo command completes",
                            "timeout_seconds": 25,
                            "result_target": "none",
                        },
                        "claim_token": claim_token,
                    }),
                );
            }

            if req.method == "POST" && req.path.contains("/start") {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }

            if req.method == "POST" && req.path.contains("/report") {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }

            MockResponse {
                status: 404,
                headers: vec![],
                body: b"Not Found".to_vec(),
            }
        });

        let adapter = Arc::new(OrcaExecutionAdapter::default());
        println!("[DOGFOOD] Starting daemon for normal execution run...");
        let daemon_res = run_daemon(&paths, adapter, Some(15)).await;
        println!("[DOGFOOD] Normal run daemon result: {daemon_res:?}");
        assert!(daemon_res.is_ok());

        let reqs = server.requests();
        let report_req = reqs.iter().find(|r| r.path.contains("/report"));
        assert!(
            report_req.is_some(),
            "Server must receive normal execution report"
        );

        let report_body: serde_json::Value = report_req.unwrap().json().unwrap();
        let report = report_body.get("report").unwrap();
        println!(
            "[DOGFOOD] Normal execution report:\n{}",
            serde_json::to_string_pretty(report).unwrap()
        );

        // Conservative completion semantics (OpenCode pre-turn tui-idle bug):
        // the synthetic shim agent is unobservable (Orca reports
        // observation/provider "unsupported" and never tracks it in
        // `worktree ps`), so there is no positive turn-start evidence.
        // A satisfied tui-idle must therefore NEVER terminalize the attempt:
        // the run must only end at the durable deadline with EXECUTION_TIMEOUT,
        // never FAILED/RESULT_MISSING from a pre-turn idle.
        assert_eq!(
            report.get("execution_status").and_then(|v| v.as_str()),
            Some("TIMED_OUT"),
            "Unobservable agent run must not be completed by tui-idle; only durable timeout may end it"
        );
        assert_eq!(
            report.get("business_outcome").and_then(|v| v.as_str()),
            Some("UNVERIFIED"),
            "Business outcome must be UNVERIFIED"
        );
        assert_eq!(
            report.get("task_dispatched").and_then(|v| v.as_bool()),
            Some(true),
            "task_dispatched must be true"
        );
        let report_err = report.get("error");
        assert_eq!(
            report_err
                .and_then(|e| e.get("code"))
                .and_then(|v| v.as_str()),
            Some("EXECUTION_TIMEOUT"),
            "Timeout (not RESULT_MISSING) is the only allowed failure for a pre-turn idle"
        );

        // Verify terminal was retained for inspection per V1.8/V1.9 contract
        let client = OrcaCliClient::default();
        let active_terminals = client.list_terminals(None).await.unwrap();
        let retained = active_terminals.iter().find(|t| {
            t.title
                .as_deref()
                .map(|s| s.starts_with("ceo:att-"))
                .unwrap_or(false)
                || t.preview
                    .as_deref()
                    .map(|p| p.contains("working"))
                    .unwrap_or(false)
        });
        assert!(
            retained.is_some(),
            "Agent terminal must be retained in active inventory for user inspection on TIMED_OUT"
        );
        println!(
            "[DOGFOOD] Normal execution verified: pre-turn tui-idle did NOT complete; TIMED_OUT / UNVERIFIED / Terminal retained."
        );

        if let Some(term) = retained {
            let _ = client.close_terminal(&term.handle).await;
        }
    }

    // =========================================================================
    // Real Run 2: Timeout Execution (sleep 60 with 5s timeout -> TIMED_OUT)
    // =========================================================================
    println!("\n=== [DOGFOOD] Starting Real Run 2: Timeout Execution ===");
    {
        let server = MockServer::start().await;
        let (_temp, paths, _cred, _config) =
            setup_dogfood_env(&server.origin(), repo_path, "timeout");

        let job_id = format!("job-{}", Uuid::new_v4());
        let claim_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        let job_claimed = Arc::new(AtomicBool::new(false));
        let job_claimed_clone = job_claimed.clone();
        let jid = job_id.clone();

        server.add_handler(move |req: &MockRequest| {
            if req.path == "/api/connector/identity" && req.method == "GET" {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "user_id": "usr_dogfood",
                        "device": { "id": "dev_dogfood", "display_name": "Dogfood Device", "platform": "linux-x86_64" },
                        "credential": { "id": "dcr_dogfood", "expires_at_ms": 2000000000000i64 }
                    }),
                );
            }

            if req.path == "/api/connector/targets" && req.method == "GET" {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "targets": [{
                            "target": {
                                "id": "tgt_dogfood",
                                "workspace_id": "ws_dogfood",
                                "alias": "dogfood-target",
                                "display_name": "Dogfood Target",
                                "kind": "coding",
                                "repository": null,
                                "disabled": false
                            },
                            "this_device_binding": {
                                "id": "bnd_dogfood",
                                "enabled": true
                            },
                            "active_binding_count": 1
                        }]
                    }),
                );
            }

            if req.method == "GET" && req.path.starts_with("/api/connector/jobs/pending") {
                if !job_claimed_clone.load(Ordering::SeqCst) {
                    return MockResponse::json(
                        200,
                        &serde_json::json!({
                            "jobs": [{
                                "job_id": jid,
                                "workspace_id": "ws_dogfood",
                                "target_id": "tgt_dogfood",
                                "resource_id": null,
                                "created_at": chrono::Utc::now().to_rfc3339(),
                                "expires_at": null,
                            }]
                        }),
                    );
                } else {
                    return MockResponse::json(200, &serde_json::json!({ "jobs": [] }));
                }
            }

            if req.method == "POST" && req.path.contains("/claim") {
                job_claimed_clone.store(true, Ordering::SeqCst);
                let body: serde_json::Value = req.json().unwrap();
                let req_attempt_id = body.get("attempt_id").and_then(|v| v.as_str()).unwrap().to_string();
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                        "attempt": {
                            "attempt_id": req_attempt_id,
                            "phase": "claimed",
                            "claimed_at": chrono::Utc::now().to_rfc3339(),
                            "started_at": null,
                        },
                        "job": {
                            "job_id": jid,
                            "workspace_id": "ws_dogfood",
                            "target_id": "tgt_dogfood",
                            "resource_id": null,
                            "prompt": "sleep 60",
                            "acceptance": "Sleeps for 60 seconds",
                            "timeout_seconds": 5, // 5s timeout
                            "result_target": "none",
                        },
                        "claim_token": claim_token,
                    }),
                );
            }

            if req.method == "POST" && req.path.contains("/start") {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }

            if req.method == "POST" && req.path.contains("/report") {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": false,
                        "server_time": chrono::Utc::now().to_rfc3339(),
                    }),
                );
            }

            MockResponse {
                status: 404,
                headers: vec![],
                body: b"Not Found".to_vec(),
            }
        });

        let adapter = Arc::new(OrcaExecutionAdapter::default());
        println!("[DOGFOOD] Starting daemon for timeout execution run...");
        let daemon_res = run_daemon(&paths, adapter, Some(15)).await;
        println!("[DOGFOOD] Timeout run daemon result: {daemon_res:?}");
        assert!(daemon_res.is_ok());

        let reqs = server.requests();
        let report_req = reqs.iter().find(|r| r.path.contains("/report"));
        assert!(
            report_req.is_some(),
            "Server must receive timeout execution report"
        );

        let report_body: serde_json::Value = report_req.unwrap().json().unwrap();
        let report = report_body.get("report").unwrap();
        println!(
            "[DOGFOOD] Timeout execution report:\n{}",
            serde_json::to_string_pretty(report).unwrap()
        );

        assert_eq!(
            report.get("execution_status").and_then(|v| v.as_str()),
            Some("TIMED_OUT"),
            "Timeout run must be TIMED_OUT"
        );
        assert_eq!(
            report.get("business_outcome").and_then(|v| v.as_str()),
            Some("UNVERIFIED"),
            "Business outcome must be UNVERIFIED"
        );
        assert_eq!(
            report.get("task_dispatched").and_then(|v| v.as_bool()),
            Some(true),
            "task_dispatched must be true"
        );

        // Verify terminal was retained for inspection per V1.8/V1.9 contract
        let client = OrcaCliClient::default();
        let active_terminals = client.list_terminals(None).await.unwrap();
        let retained = active_terminals.iter().find(|t| {
            t.title
                .as_deref()
                .map(|s| s.starts_with("ceo:att-"))
                .unwrap_or(false)
                || t.preview
                    .as_deref()
                    .map(|p| p.contains("working"))
                    .unwrap_or(false)
        });
        assert!(
            retained.is_some(),
            "Agent terminal must be retained in active inventory for user inspection on TIMED_OUT"
        );
        println!(
            "[DOGFOOD] Timeout execution verified: TIMED_OUT / UNVERIFIED / Terminal retained."
        );

        if let Some(term) = retained {
            let _ = client.close_terminal(&term.handle).await;
        }
    }
}

#[tokio::test]
async fn test_real_orca_1_4_219_existing_run_replay_and_no_new_worktree() {
    if !check_orca_available().await {
        return;
    }

    let client = OrcaCliClient::default();
    let target_path = "/home/sentimentalk/codes/chief-everything-officer";

    let target_wt = client
        .show_worktree_by_path(std::path::Path::new(target_path))
        .await
        .unwrap()
        .expect("target worktree must exist in Orca");

    let worktrees_before = client.list_worktrees().await.unwrap();

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".ceo");
    let paths = ConnectorPaths::from_root(&root);
    paths.ensure_dirs().unwrap();
    let adapter = OrcaExecutionAdapter::new(client.clone()).with_paths(paths);

    let attempt_id = format!("smoke-replay-{}", &Uuid::new_v4().to_string()[..8]);
    let target = LocalTarget {
        local_path: target_path.to_string(),
        executor: Some(LocalExecutorConfig::new_logical("cursor".into(), None).unwrap()),
    };

    let attempt = ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        job_id: "job_smoke".into(),
        attempt_id: attempt_id.clone(),
        claim_token: "token".into(),
        device_id: "dev_smoke".into(),
        server_origin: "http://127.0.0.1:4000".into(),
        phase: AttemptPhase::PrepareIntent,
        workspace_id: "ws_smoke".into(),
        target_id: "tgt_smoke".into(),
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

    let anchor_wt_id = adapter
        .resolve_coordinator_anchor_worktree(&target_wt.id)
        .await;
    let coordinator_handle = adapter
        .ensure_coordinator_terminal(&anchor_wt_id, &attempt.device_id)
        .await
        .unwrap();

    let run_obj = format!("ceo:{}", attempt.attempt_id);
    let run_retry_id =
        ceo_connector::orca::derive_mutation_request_id("run-create", &attempt.attempt_id)
            .to_string();
    let worker_retry_id =
        ceo_connector::orca::derive_mutation_request_id("worker-start", &attempt.attempt_id)
            .to_string();

    let run_item = client
        .create_run(&coordinator_handle, &run_obj, Some(&run_retry_id))
        .await
        .unwrap();

    // 1. Verify defect starting condition on real Orca:
    // Run exists, 0 workers, worker-start request-show is absent
    let runs = client.list_runs().await.unwrap();
    assert_eq!(
        runs.iter()
            .filter(|r| r.objective.as_deref() == Some(&run_obj))
            .count(),
        1
    );
    let workers = client.list_workers(Some(&run_item.id)).await.unwrap();
    assert!(workers.is_empty());
    let show = client.request_show(&worker_retry_id).await.unwrap();
    assert!(show.is_absent());

    // 2. Prepare against the unique existing Run with 0 workers
    // Repaired adapter will consult request-show (absent) and safely issue worker-start with worker_retry_id
    let prep_outcome = adapter.prepare(&attempt, &target).await.unwrap();
    let prep = match prep_outcome {
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready, got {other:?}"),
    };

    // 3. Verify no new Git worktree was created
    let worktrees_after = client.list_worktrees().await.unwrap();
    assert_eq!(
        worktrees_after.len(),
        worktrees_before.len(),
        "Orca worktrees count must remain identical (never create a new Git worktree)"
    );

    // 4. Verify idempotent replay on the same attempt
    let replay_outcome = adapter.prepare(&attempt, &target).await.unwrap();
    let replay_prep = match replay_outcome {
        PrepareOutcome::Ready(p) => p,
        other => panic!("expected PrepareOutcome::Ready on replay, got {other:?}"),
    };
    assert_eq!(replay_prep.terminal_id, prep.terminal_id);

    // 5. Cleanup
    let _ = client.close_terminal(&prep.terminal_id).await;
}
