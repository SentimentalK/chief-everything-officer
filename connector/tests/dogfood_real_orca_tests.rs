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
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join(".ceo");
    let paths = ConnectorPaths::from_roots(&root, &root);
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

    let shim_path = temp.path().join("dogfood-agent-shim");
    let script_content = if mode == "timeout" {
        "#!/bin/bash\nprintf \"cursor agent →\\n\"\nread line\nprintf \"working \\u280b ...\\n\"\nsleep 60\n"
    } else {
        "#!/bin/bash\nprintf \"cursor agent →\\n\"\nread line\nprintf \"working \\u280b ...\\n\"\nsleep 1\nprintf \"cursor agent →\\n\"\nsleep 30\n"
    };
    std::fs::write(&shim_path, script_content).unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&shim_path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&shim_path, perms).unwrap();

    let mut config = LocalConfig::new(server_origin.to_string()).unwrap();
    config.targets.insert(
        "tgt_dogfood".into(),
        LocalTarget {
            workspace_id: "ws_dogfood".into(),
            alias: "dogfood-target".into(),
            kind: "coding".into(),
            local_path: target_path.to_string(),
            executor: Some(
                LocalExecutorConfig::new("agent".into(), shim_path.to_str().unwrap().into())
                    .unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred, config)
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

/// Slice V1.7i Dogfood Real Run 1 & Run 2: Real Orca + Real AGY E2E Verification
#[tokio::test]
async fn test_dogfood_real_orca_e2e_suite() {
    if !check_orca_available().await {
        return;
    }

    let repo_path = "/home/sentimentalk/codes/chief-everything-officer";

    // =========================================================================
    // Real Run 1: Normal Execution (completes to tui-idle)
    // =========================================================================
    println!("\n=== [DOGFOOD] Starting Real Run 1: Normal Execution ===");
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
                            "timeout_seconds": 180,
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

        assert_eq!(
            report.get("execution_status").and_then(|v| v.as_str()),
            Some("COMPLETED"),
            "Normal run must be COMPLETED"
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

        // Verify terminal was cleanly stopped and absent
        let client = OrcaCliClient::default();
        let active_terminals = client.list_terminals(None).await.unwrap();
        let leaked = active_terminals.iter().find(|t| {
            t.title
                .as_deref()
                .map(|s| s.starts_with("ceo:att-"))
                .unwrap_or(false)
        });
        assert!(
            leaked.is_none(),
            "Agent terminal must be cleanly removed from active inventory"
        );
        println!("[DOGFOOD] Normal execution verified: COMPLETED / UNVERIFIED / Cleaned up.");
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

        // Verify terminal was cleanly stopped and absent
        let client = OrcaCliClient::default();
        let active_terminals = client.list_terminals(None).await.unwrap();
        let leaked = active_terminals.iter().find(|t| {
            t.title
                .as_deref()
                .map(|s| s.starts_with("ceo:att-"))
                .unwrap_or(false)
        });
        assert!(
            leaked.is_none(),
            "Agent terminal must be cleanly removed from active inventory"
        );
        println!("[DOGFOOD] Timeout execution verified: TIMED_OUT / UNVERIFIED / Cleaned up.");
    }
}
