mod common;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{ActiveAttempt, AttemptPhase, DispatchProof, ExecutionAdapter};
use common::mock_server::{MockRequest, MockResponse, MockServer};
use uuid::Uuid;

struct SettingsGuard {
    path: PathBuf,
    original_bytes: Option<Vec<u8>>,
}

impl SettingsGuard {
    pub fn add_trusted_workspace(workspace_path: &Path) -> Result<Self, std::io::Error> {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/home/sentimentalk".into());
        let settings_path = PathBuf::from(home).join(".gemini/antigravity-cli/settings.json");
        let original_bytes = if settings_path.exists() {
            Some(std::fs::read(&settings_path)?)
        } else {
            None
        };

        let mut val: serde_json::Value = if let Some(ref b) = original_bytes {
            serde_json::from_slice(b).unwrap_or_else(|_| serde_json::json!({}))
        } else {
            serde_json::json!({})
        };

        let canonical = std::fs::canonicalize(workspace_path)
            .unwrap_or_else(|_| workspace_path.to_path_buf())
            .display()
            .to_string();

        if let Some(trusted) = val
            .get_mut("trustedWorkspaces")
            .and_then(|v| v.as_array_mut())
        {
            if !trusted.iter().any(|t| t.as_str() == Some(&canonical)) {
                trusted.push(serde_json::Value::String(canonical));
            }
        } else {
            val["trustedWorkspaces"] = serde_json::json!([canonical]);
        }

        if let Some(parent) = settings_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&settings_path, serde_json::to_string_pretty(&val)?)?;

        Ok(Self {
            path: settings_path,
            original_bytes,
        })
    }
}

impl Drop for SettingsGuard {
    fn drop(&mut self) {
        if let Some(ref orig) = self.original_bytes {
            let _ = std::fs::write(&self.path, orig);
        } else {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

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

    let exec_cmd = if let Some(cmd) = custom_cmd {
        cmd.to_string()
    } else {
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
        shim_path.to_str().unwrap().to_string()
    };

    let mut config = LocalConfig::new(server_origin.to_string()).unwrap();
    config.targets.insert(
        "tgt_dogfood".into(),
        LocalTarget {
            workspace_id: "ws_dogfood".into(),
            alias: "dogfood-target".into(),
            kind: "coding".into(),
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

async fn drive_until_phase<A: ExecutionAdapter + 'static, F>(
    paths: &ConnectorPaths,
    adapter: Arc<A>,
    predicate: F,
    max_steps: usize,
) -> Result<ActiveAttempt, String>
where
    F: Fn(AttemptPhase) -> bool,
{
    for step in 0..max_steps {
        if let Ok(Some(active)) = ActiveAttempt::load(&paths.active_attempt_file()) {
            if predicate(active.phase) {
                return Ok(active);
            }
        }
        if let Err(e) = run_daemon(paths, adapter.clone(), Some(1)).await {
            return Err(format!("daemon step failed at step {step}: {e}"));
        }
        if let Ok(Some(active)) = ActiveAttempt::load(&paths.active_attempt_file()) {
            if predicate(active.phase) {
                return Ok(active);
            }
        }
    }
    Err(format!(
        "Timed out waiting for predicate after {max_steps} steps. Current attempt: {:?}",
        ActiveAttempt::load(&paths.active_attempt_file())
    ))
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

/// Slice V1.7j Acceptance: Real Orca + Real AGY End-to-End Verification
#[tokio::test]
async fn test_dogfood_real_agy() {
    if std::env::var("CEO_REAL_ORCA_DOGFOOD").is_err() {
        println!("[DOGFOOD] CEO_REAL_ORCA_DOGFOOD not set; skipping real AGY dogfood test.");
        return;
    }

    if !check_orca_available().await {
        panic!("[DOGFOOD] CEO_REAL_ORCA_DOGFOOD is set but Orca is not available or ready!");
    }

    let agent_cmd = std::env::var("CEO_REAL_AGENT_COMMAND").unwrap_or_else(|_| "agy".to_string());
    println!("[DOGFOOD] Using real agent command: {agent_cmd}");

    let scratch_parent = tempfile::tempdir().unwrap();
    let scratch_repo = scratch_parent.path().join("real-agy-repo");
    std::fs::create_dir_all(&scratch_repo).unwrap();

    let git_init = std::process::Command::new("git")
        .args(["init"])
        .current_dir(&scratch_repo)
        .status()
        .expect("git init must succeed");
    assert!(git_init.success());

    // Settings guard snapshot and add scratch repo to trustedWorkspaces
    let _settings_guard = SettingsGuard::add_trusted_workspace(&scratch_repo)
        .expect("Failed to register scratch repo in AGY settings.json");

    let repo_canon = scratch_repo.canonicalize().unwrap().display().to_string();

    // =========================================================================
    // Real AGY Run 1: Normal Execution (write file with unique token)
    // =========================================================================
    println!("\n=== [DOGFOOD REAL AGY] Starting Run 1: Normal Execution ===");
    {
        let server = MockServer::start().await;
        let (_temp, paths, _cred, _config) = setup_dogfood_env_with_cmd(
            &server.origin(),
            &repo_canon,
            "normal",
            "agy",
            Some(&agent_cmd),
        );

        let job_id = format!("job-{}", Uuid::new_v4());
        let claim_token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let token = format!("V17_REAL_{}", Uuid::new_v4());

        let job_claimed = Arc::new(AtomicBool::new(false));
        let job_claimed_clone = job_claimed.clone();
        let jid = job_id.clone();
        let tok = token.clone();

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
                            "prompt": format!("Create a file named v17-real-acceptance.txt containing exactly:\n\n{tok}"),
                            "acceptance": "v17-real-acceptance.txt must exist with the specified content",
                            "timeout_seconds": 90,
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

        // Step 1: Drive daemon until Dispatched or Waiting to capture in-flight state
        println!("[DOGFOOD REAL AGY] Driving daemon to capture in-flight state...");
        let in_flight = drive_until_phase(
            &paths,
            adapter.clone(),
            |p| matches!(p, AttemptPhase::Dispatched | AttemptPhase::Waiting),
            20,
        )
        .await
        .expect("real AGY attempt must reach Dispatched or Waiting");

        println!(
            "[DOGFOOD REAL AGY] In-flight attempt phase: {:?}",
            in_flight.phase
        );
        let exec = in_flight
            .executor
            .as_ref()
            .expect("real AGY attempt must have executor state at proof checkpoint");

        println!(
            "[DOGFOOD REAL AGY] In-flight proof: {:?}, provider: {:?}, observation: {:?}, agent_id: {:?}",
            exec.dispatch_proof, exec.dispatch_provider, exec.dispatch_observation, exec.agent_id
        );
        assert_eq!(
            exec.agent_id.as_deref(),
            Some("agy"),
            "agent_id must be 'agy'"
        );

        match (
            exec.dispatch_provider.as_deref(),
            exec.dispatch_observation.as_deref(),
            exec.dispatch_proof,
        ) {
            (
                Some("unsupported"),
                Some("unsupported"),
                Some(DispatchProof::AcceptedUnobservable),
            ) => {
                // Truthful unsupported observation
            }
            (_, _, Some(DispatchProof::TurnStarted)) => {
                // Genuine TurnStarted observation
            }
            other => {
                panic!(
                    "Unexpected dispatch proof or observation metadata: {:?}",
                    other
                );
            }
        }

        // Step 2: Resume daemon until completion and cleanup
        println!("[DOGFOOD REAL AGY] Resuming daemon to completion...");
        let daemon_res = run_daemon(&paths, adapter, Some(30)).await;
        println!("[DOGFOOD REAL AGY] Daemon result: {daemon_res:?}");
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
            "[DOGFOOD REAL AGY] Normal execution report:\n{}",
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

        // Verify file written by real AGY matches exact token
        let target_file = scratch_repo.join("v17-real-acceptance.txt");
        assert!(
            target_file.exists(),
            "AGY must have created v17-real-acceptance.txt in scratch repo"
        );
        let content = std::fs::read_to_string(&target_file).unwrap();
        assert_eq!(
            content.trim(),
            token,
            "v17-real-acceptance.txt must contain exactly the expected token"
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
        println!("[DOGFOOD REAL AGY] Normal execution verified: COMPLETED / UNVERIFIED / File verified / Cleaned up.");
    }

    // =========================================================================
    // Real AGY Run 2: Timeout Execution (30s timeout -> TIMED_OUT via adapter.wait)
    // =========================================================================
    println!("\n=== [DOGFOOD REAL AGY] Starting Run 2: Timeout Execution ===");
    {
        let server = MockServer::start().await;
        let (_temp, paths, _cred, _config) = setup_dogfood_env_with_cmd(
            &server.origin(),
            &repo_canon,
            "timeout",
            "agy",
            Some(&agent_cmd),
        );

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
                            "prompt": "Run the shell command `sleep 60`. Wait for it to finish before completing the task.",
                            "acceptance": "Should time out before finishing",
                            "timeout_seconds": 30, // 30s timeout
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
        println!("[DOGFOOD REAL AGY] Driving daemon to Waiting phase for timeout run...");
        let waiting_attempt =
            drive_until_phase(&paths, adapter.clone(), |p| p == AttemptPhase::Waiting, 20)
                .await
                .expect("real AGY timeout attempt must reach Waiting");

        let exec = waiting_attempt
            .executor
            .as_ref()
            .expect("executor must exist at Waiting");
        assert_eq!(
            exec.agent_id.as_deref(),
            Some("agy"),
            "agent_id must be 'agy'"
        );
        assert!(
            matches!(
                exec.dispatch_proof,
                Some(DispatchProof::AcceptedUnobservable) | Some(DispatchProof::TurnStarted)
            ),
            "Waiting attempt must have valid dispatch proof"
        );

        let deadline = exec
            .execution_deadline_ms
            .expect("execution_deadline_ms must be set");
        let now = chrono::Utc::now().timestamp_millis();
        assert!(
            deadline > now,
            "execution_deadline_ms must be in the future"
        );
        assert!(
            deadline - now >= 15_000,
            "Must have meaningful remaining budget, remaining: {}ms",
            deadline - now
        );

        println!(
            "[DOGFOOD REAL AGY] Driving Waiting phase to exercise adapter.wait until timeout..."
        );
        let outcome_attempt = drive_until_phase(
            &paths,
            adapter.clone(),
            |p| p == AttemptPhase::OutcomeRecorded,
            5,
        )
        .await
        .expect("must reach OutcomeRecorded after timeout wait");

        let exec_outcome = outcome_attempt
            .executor
            .as_ref()
            .expect("executor must exist at OutcomeRecorded");
        assert_eq!(
            exec_outcome.runtime_completion_kind.as_deref(),
            Some("timed_out"),
            "runtime_completion_kind must be timed_out"
        );

        println!("[DOGFOOD REAL AGY] Finishing cleanup and report delivery...");
        let daemon_res = run_daemon(&paths, adapter, Some(10)).await;
        println!("[DOGFOOD REAL AGY] Timeout run daemon result: {daemon_res:?}");
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
            "[DOGFOOD REAL AGY] Timeout execution report:\n{}",
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
            "Agent terminal must be cleanly removed from active inventory after timeout"
        );
        println!(
            "[DOGFOOD REAL AGY] Timeout execution verified: TIMED_OUT / UNVERIFIED / Cleaned up."
        );
    }
}
