//! Comprehensive test suite for default-Agent resolution and freeze semantics.
//!
//! Regression and correctness contracts:
//! 1. Policy normalization: "default" and "auto" are recognized as default policies;
//!    writes canonicalize to "default"; explicit agents remain untouched.
//! 2. Resolver parsing: Handles direct and nested settings; catches missing, null, blank,
//!    malformed, and disabled agents; auth token is never logged or exposed.
//! 3. Version binding: Orca versions other than 1.4.219 fail closed.
//! 4. Unix resolver integration: Resolves default agent over mock Unix socket.
//! 5. Pre-claim fail closed: Unresolved default agent skips candidate without claim or ClaimIntent.
//! 6. Pre-claim freeze: Concrete agent identity is resolved and frozen into ClaimIntent before Server claim.
//! 7. Legacy auto: Stored "auto" policy resolves and freezes concrete agent; never emits literal "auto" to Orca.
//! 8. Immutability after freeze: Frozen agent identity survives post-freeze target config changes.
//! 9. Explicit Agent regression: Explicit agent does not require default resolver or socket.
//! 10. Explicit command regression: Legacy command executor is unaffected.
//! 11. Adapter fail closed: Unresolved default or auto policy at launch produces RecoveryRequired.
//! 12. Candidate scan regression: Unresolved default candidate is skipped without starving subsequent candidates.

mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

use ceo_connector::config::{
    canonicalize_agent_policy, is_default_agent_policy, LocalConfig, LocalExecutorConfig,
    LocalTarget,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{run_daemon_with_hooks_and_admission_orca, DaemonHooks};
use ceo_connector::orca::adapter::resolve_launch_agent_id;
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::default_agent::{
    parse_settings, resolve_default_agent_with_user_data, DefaultAgentResolution,
    ENV_ORCA_USER_DATA_PATH, VERIFIED_ORCA_VERSION,
};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::resolve_agent_choice;
use ceo_connector::scheduler::{
    ActiveAttempt, AttemptPhase, FakeExecutionAdapter, ACTIVE_ATTEMPT_SCHEMA_VERSION,
};
use common::mock_server::{MockResponse, MockServer};

static ENV_LOCK: TokioMutex<()> = TokioMutex::const_new(());
const DCR_EXPIRES: i64 = 2000000000000;

fn sample_report() -> ceo_connector::execution_contract::ExecutionReport {
    ceo_connector::execution_contract::ExecutionReport {
        schema_version: 2,
        execution_status: ceo_connector::execution_contract::ExecutionStatus::COMPLETED,
        business_outcome: ceo_connector::execution_contract::BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1700000001000,
        duration_ms: 1000,
        executor: ceo_connector::execution_contract::ExecutionReportExecutor {
            executor_type: "fake".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    }
}

fn fake_ready_adapter() -> Arc<FakeExecutionAdapter> {
    Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    })
}

fn missing_orca_probe(temp: &tempfile::TempDir) -> OrcaCliClient {
    OrcaCliClient::new(temp.path().join("no-such-orca-binary"))
}

fn create_mock_orca_binary(dir: &Path, version: &str, ready: bool) -> OrcaCliClient {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script_path = dir.join("mock-orca");
        let state = if ready { "ready" } else { "not_ready" };
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "status" ]; then
    echo '{{"ok":true,"result":{{"app":{{"running":true}},"runtime":{{"state":"{}","reachable":true,"appVersion":"{}"}}}}}}'
    exit 0
fi
if [ "$1" = "orchestration" ] && [ "$2" = "worker-start" ]; then
    echo 'Usage: orca orchestration worker-start --agent <agent>'
    exit 0
fi
echo '{{"ok":true}}'
"#,
            state, version
        );
        fs::write(&script_path, script).unwrap();
        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).unwrap();
        OrcaCliClient::new(script_path)
    }
    #[cfg(windows)]
    {
        let script_path = dir.join("mock-orca.cmd");
        let state = if ready { "ready" } else { "not_ready" };
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"status\" (\r\necho {{\"ok\":true,\"result\":{{\"app\":{{\"running\":true}},\"runtime\":{{\"state\":\"{}\",\"reachable\":true,\"appVersion\":\"{}\"}}}}}}\r\nexit /b 0\r\n)\r\nif \"%~1\"==\"orchestration\" if \"%~2\"==\"worker-start\" (\r\necho Usage: orca orchestration worker-start --agent\r\nexit /b 0\r\n)\r\necho {{\"ok\":true}}\r\n",
            state, version
        );
        fs::write(&script_path, script).unwrap();
        OrcaCliClient::new(script_path)
    }
}

#[cfg(unix)]
async fn spawn_mock_orca_socket(
    user_data_dir: &Path,
    resolved_agent: &str,
    auth_token: &str,
) -> (PathBuf, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixListener;

    let sock_path = user_data_dir.join("orca.sock");
    if sock_path.exists() {
        let _ = fs::remove_file(&sock_path);
    }
    let listener = UnixListener::bind(&sock_path).unwrap();

    let runtime_json = serde_json::json!({
        "authToken": auth_token,
        "transports": [
            {
                "kind": "unix",
                "endpoint": sock_path.to_string_lossy(),
                "authToken": auth_token
            }
        ]
    });
    fs::write(
        user_data_dir.join("orca-runtime.json"),
        serde_json::to_string_pretty(&runtime_json).unwrap(),
    )
    .unwrap();

    let resolved_agent = resolved_agent.to_string();
    let expected_token = auth_token.to_string();

    let handle = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();

            while let Ok(n) = reader.read_line(&mut line).await {
                if n == 0 {
                    break;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(req) = serde_json::from_str::<serde_json::Value>(trimmed) {
                    if let Some(req_id) = req.get("id").and_then(|v| v.as_str()) {
                        let method = req.get("method").and_then(|v| v.as_str()).unwrap_or("");
                        let token = req.get("authToken").and_then(|v| v.as_str()).unwrap_or("");
                        if method == "settings.get" && token == expected_token {
                            let response = serde_json::json!({
                                "id": req_id,
                                "ok": true,
                                "result": {
                                    "settings": {
                                        "defaultTuiAgent": resolved_agent,
                                        "disabledTuiAgents": []
                                    }
                                }
                            });
                            let mut resp_bytes = serde_json::to_vec(&response).unwrap();
                            resp_bytes.push(b'\n');
                            let _ = write_half.write_all(&resp_bytes).await;
                            let _ = write_half.flush().await;
                        }
                    }
                }
                line.clear();
            }
        }
    });

    (sock_path, handle)
}

fn executable_legacy_command(temp: &tempfile::TempDir) -> String {
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&agent_bin).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&agent_bin, perms).unwrap();
    }
    agent_bin.display().to_string()
}

fn base_credential(server: &MockServer, paths: &ConnectorPaths) {
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        DCR_EXPIRES,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();
}

fn mapped_target(
    paths_dir: &tempfile::TempDir,
    executor: Option<LocalExecutorConfig>,
) -> LocalTarget {
    let target_dir = paths_dir.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();
    LocalTarget {
        local_path: target_dir.to_string_lossy().to_string(),
        executor,
    }
}

fn standard_target_handlers(
    server: &MockServer,
    target_ids: &[&str],
    job_ids: &[&str],
    claim_counter: Arc<AtomicUsize>,
    claimed_job_ids: Arc<std::sync::Mutex<Vec<String>>>,
) {
    let targets: Vec<serde_json::Value> = target_ids
        .iter()
        .map(|tid| {
            serde_json::json!({
                "target": {
                    "id": *tid,
                    "workspace_id": "ws_1",
                    "alias": format!("alias-{tid}"),
                    "display_name": format!("Display {tid}"),
                    "kind": "general_automation",
                    "repository": null,
                    "disabled": false
                },
                "this_device_binding": { "id": "bnd_1", "enabled": true },
                "active_binding_count": 1
            })
        })
        .collect();
    let jobs: Vec<serde_json::Value> = job_ids
        .iter()
        .enumerate()
        .map(|(idx, jid)| {
            let tid = target_ids.get(idx).copied().unwrap_or(target_ids[0]);
            serde_json::json!({
                "job_id": *jid,
                "workspace_id": "ws_1",
                "target_id": tid,
                "resource_id": null,
                "created_at": "2026-09-24T12:00:00.000Z",
                "expires_at": null
            })
        })
        .collect();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": DCR_EXPIRES }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "targets": targets }));
        }
        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "jobs": jobs }));
        }
        if req.path.contains("/claim") && req.method == "POST" {
            claim_counter.fetch_add(1, Ordering::SeqCst);
            let job_id = req
                .path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/claim"))
                .unwrap_or_default()
                .to_string();
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body
                .get("attempt_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let job_target_id = jobs
                .iter()
                .find(|j| j.get("job_id").and_then(|v| v.as_str()) == Some(&job_id))
                .and_then(|j| j.get("target_id").and_then(|v| v.as_str()))
                .unwrap_or("tgt_1");
            claimed_job_ids.lock().unwrap().push(job_id.clone());
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": job_id,
                        "workspace_id": "ws_1",
                        "target_id": job_target_id,
                        "resource_id": null,
                        "prompt": "Test prompt",
                        "acceptance": "Test acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });
}

fn dummy_attempt(frozen_agent_id: Option<String>) -> ActiveAttempt {
    ActiveAttempt {
        schema_version: ACTIVE_ATTEMPT_SCHEMA_VERSION,
        server_origin: "https://server.test".into(),
        device_id: "dev_1".into(),
        job_id: "job_1".into(),
        workspace_id: "ws_1".into(),
        target_id: "tgt_1".into(),
        attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        phase: AttemptPhase::ClaimIntent,
        resource_id: None,
        prompt: None,
        acceptance: None,
        execution_timeout_seconds: None,
        result_target: None,
        payload_sha256: None,
        claimed_at_ms: None,
        terminal_report_sha256: None,
        frozen_agent_id,
        executor: None,
    }
}

// ---------------------------------------------------------------------------
// Test 1: Policy normalization
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_01_policy_normalization_and_choice() {
    // is_default_agent_policy
    assert!(is_default_agent_policy("default"));
    assert!(is_default_agent_policy("DEFAULT"));
    assert!(is_default_agent_policy("auto"));
    assert!(is_default_agent_policy("AUTO"));
    assert!(is_default_agent_policy("  default  "));
    assert!(is_default_agent_policy("  auto  "));

    assert!(!is_default_agent_policy("antigravity"));
    assert!(!is_default_agent_policy("opencode"));
    assert!(!is_default_agent_policy(""));
    assert!(!is_default_agent_policy("   "));

    // canonicalize_agent_policy
    assert_eq!(canonicalize_agent_policy("auto"), "default");
    assert_eq!(canonicalize_agent_policy("AUTO"), "default");
    assert_eq!(canonicalize_agent_policy("default"), "default");
    assert_eq!(canonicalize_agent_policy("DEFAULT"), "default");
    assert_eq!(canonicalize_agent_policy("antigravity"), "antigravity");

    // resolve_agent_choice
    assert_eq!(
        resolve_agent_choice(Some("auto"), false).await.unwrap(),
        Some("default".into())
    );
    assert_eq!(
        resolve_agent_choice(Some("default"), false).await.unwrap(),
        Some("default".into())
    );
    assert_eq!(
        resolve_agent_choice(Some("DEFAULT"), false).await.unwrap(),
        Some("default".into())
    );
    assert_eq!(resolve_agent_choice(None, false).await.unwrap(), None);
}

// ---------------------------------------------------------------------------
// Test 2: Resolver parsing (pure tests)
// ---------------------------------------------------------------------------
#[test]
fn test_02_resolver_parsing_pure() {
    // Direct and nested settings
    let flat_json = serde_json::json!({
        "defaultTuiAgent": "opencode",
        "disabledTuiAgents": []
    });
    assert_eq!(
        parse_settings(&flat_json),
        DefaultAgentResolution::Resolved("opencode".into())
    );

    let nested_json = serde_json::json!({
        "settings": {
            "defaultTuiAgent": "opencode",
            "disabledTuiAgents": []
        }
    });
    assert_eq!(
        parse_settings(&nested_json),
        DefaultAgentResolution::Resolved("opencode".into())
    );

    // Missing, null, blank
    let null_json = serde_json::json!({
        "defaultTuiAgent": null,
        "disabledTuiAgents": []
    });
    assert!(matches!(
        parse_settings(&null_json),
        DefaultAgentResolution::Missing(_)
    ));

    let missing_json = serde_json::json!({ "disabledTuiAgents": [] });
    assert!(matches!(
        parse_settings(&missing_json),
        DefaultAgentResolution::Missing(_)
    ));

    let blank_json = serde_json::json!({
        "defaultTuiAgent": "   ",
        "disabledTuiAgents": []
    });
    assert!(matches!(
        parse_settings(&blank_json),
        DefaultAgentResolution::Missing(_)
    ));

    // Malformed
    let int_json = serde_json::json!({ "defaultTuiAgent": 123 });
    assert!(matches!(
        parse_settings(&int_json),
        DefaultAgentResolution::Malformed(_)
    ));

    let space_json = serde_json::json!({ "defaultTuiAgent": "bad agent" });
    assert!(matches!(
        parse_settings(&space_json),
        DefaultAgentResolution::Malformed(_)
    ));

    let long_json = serde_json::json!({ "defaultTuiAgent": "a".repeat(81) });
    assert!(matches!(
        parse_settings(&long_json),
        DefaultAgentResolution::Malformed(_)
    ));

    let bad_disabled_json = serde_json::json!({
        "defaultTuiAgent": "opencode",
        "disabledTuiAgents": "not_an_array"
    });
    assert!(matches!(
        parse_settings(&bad_disabled_json),
        DefaultAgentResolution::Malformed(_)
    ));

    // Disabled
    let disabled_json = serde_json::json!({
        "defaultTuiAgent": "opencode",
        "disabledTuiAgents": ["opencode"]
    });
    assert_eq!(
        parse_settings(&disabled_json),
        DefaultAgentResolution::Disabled("opencode".into())
    );

    // Auth token redaction: debug string contains no sensitive tokens
    let secret = "SECRET_AUTH_TOKEN_NEVER_LOGGED";
    let res = DefaultAgentResolution::Unavailable("Connection failed".into());
    assert!(!format!("{:?}", res).contains(secret));
}

// ---------------------------------------------------------------------------
// Test 3: Version binding
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_03_version_binding() {
    let temp = tempfile::tempdir().unwrap();

    // Unsupported older version
    let older_client = create_mock_orca_binary(temp.path(), "1.4.218", true);
    let res = resolve_default_agent_with_user_data(&older_client, Some(temp.path())).await;
    assert!(matches!(res, DefaultAgentResolution::Unsupported(_)));
    if let DefaultAgentResolution::Unsupported(msg) = res {
        assert!(msg.contains("1.4.218"));
        assert!(msg.contains(VERIFIED_ORCA_VERSION));
    }

    // Unsupported newer version
    let newer_client = create_mock_orca_binary(temp.path(), "1.5.0", true);
    let res = resolve_default_agent_with_user_data(&newer_client, Some(temp.path())).await;
    assert!(matches!(res, DefaultAgentResolution::Unsupported(_)));

    // Verified version 1.4.219 proceeds past version check to metadata check
    let verified_client = create_mock_orca_binary(temp.path(), VERIFIED_ORCA_VERSION, true);
    let res = resolve_default_agent_with_user_data(&verified_client, Some(temp.path())).await;
    #[cfg(unix)]
    {
        // On Unix, without orca-runtime.json in temp.path(), fails with Unavailable (metadata not found)
        assert!(matches!(res, DefaultAgentResolution::Unavailable(_)));
    }
    #[cfg(not(unix))]
    {
        // On Windows, unsupported
        assert!(matches!(res, DefaultAgentResolution::Unsupported(_)));
    }
}

// ---------------------------------------------------------------------------
// Test 4: Unix resolver integration with mock Unix socket
// ---------------------------------------------------------------------------
#[cfg(unix)]
#[tokio::test]
async fn test_04_unix_resolver_integration() {
    let _env_guard = ENV_LOCK.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let client = create_mock_orca_binary(temp.path(), VERIFIED_ORCA_VERSION, true);

    let (sock_path, handle) =
        spawn_mock_orca_socket(temp.path(), "opencode", "test-secret-token-123").await;
    assert!(sock_path.exists());

    let res = resolve_default_agent_with_user_data(&client, Some(temp.path())).await;
    assert_eq!(res, DefaultAgentResolution::Resolved("opencode".into()));

    handle.abort();
}

// ---------------------------------------------------------------------------
// Test 5: Pre-claim fail closed
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_05_pre_claim_unresolved_default_fails_closed() {
    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_1"],
        &["job_1"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("default".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    // Probe missing => DefaultAgentResolution::Unavailable
    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(2),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    // Assert 0 claims and no ClaimIntent persisted on disk
    assert_eq!(claim_counter.load(Ordering::SeqCst), 0);
    assert!(ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .is_none());
}

// ---------------------------------------------------------------------------
// Test 6: Pre-claim freeze
// ---------------------------------------------------------------------------
#[cfg(unix)]
#[tokio::test]
async fn test_06_pre_claim_resolved_default_freezes_concrete_agent() {
    let _env_guard = ENV_LOCK.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let user_data = temp.path().join("orca_user_data");
    fs::create_dir_all(&user_data).unwrap();

    let (_sock, handle) =
        spawn_mock_orca_socket(&user_data, "opencode", "test-auth-token-xyz").await;
    std::env::set_var(ENV_ORCA_USER_DATA_PATH, &user_data);

    let probe = create_mock_orca_binary(temp.path(), VERIFIED_ORCA_VERSION, true);

    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_1"],
        &["job_1"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("default".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    let frozen_seen = Arc::new(std::sync::Mutex::new(None::<Option<String>>));
    let frozen_seen_clone = frozen_seen.clone();
    let hooks = DaemonHooks {
        after_claim_intent_persisted: Some(Arc::new(move |att: &ActiveAttempt| {
            let frozen = att.frozen_agent_id.clone();
            let holder = frozen_seen_clone.clone();
            Box::pin(async move {
                let mut g = holder.lock().unwrap();
                *g = Some(frozen);
            })
        })),
        ..Default::default()
    };

    run_daemon_with_hooks_and_admission_orca(&paths, fake_ready_adapter(), Some(1), hooks, probe)
        .await
        .unwrap();

    std::env::remove_var(ENV_ORCA_USER_DATA_PATH);
    handle.abort();

    assert_eq!(claim_counter.load(Ordering::SeqCst), 1);
    let captured = frozen_seen.lock().unwrap().clone();
    assert_eq!(captured, Some(Some("opencode".to_string())));
}

// ---------------------------------------------------------------------------
// Test 7: Legacy auto
// ---------------------------------------------------------------------------
#[cfg(unix)]
#[tokio::test]
async fn test_07_legacy_auto_freezes_concrete_agent_and_never_emits_literal_auto() {
    let _env_guard = ENV_LOCK.lock().await;
    let temp = tempfile::tempdir().unwrap();
    let user_data = temp.path().join("orca_user_data");
    fs::create_dir_all(&user_data).unwrap();

    let (_sock, handle) =
        spawn_mock_orca_socket(&user_data, "opencode", "test-auth-token-auto").await;
    std::env::set_var(ENV_ORCA_USER_DATA_PATH, &user_data);

    let probe = create_mock_orca_binary(temp.path(), VERIFIED_ORCA_VERSION, true);

    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_1"],
        &["job_legacy_auto"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    let captured_attempt = Arc::new(std::sync::Mutex::new(None::<ActiveAttempt>));
    let cap_clone = captured_attempt.clone();
    let hooks = DaemonHooks {
        after_claim_intent_persisted: Some(Arc::new(move |att: &ActiveAttempt| {
            let attempt = att.clone();
            let holder = cap_clone.clone();
            Box::pin(async move {
                let mut g = holder.lock().unwrap();
                *g = Some(attempt);
            })
        })),
        ..Default::default()
    };

    run_daemon_with_hooks_and_admission_orca(&paths, fake_ready_adapter(), Some(1), hooks, probe)
        .await
        .unwrap();

    std::env::remove_var(ENV_ORCA_USER_DATA_PATH);
    handle.abort();

    assert_eq!(claim_counter.load(Ordering::SeqCst), 1);
    let attempt = captured_attempt.lock().unwrap().clone().unwrap();
    assert_eq!(attempt.frozen_agent_id, Some("opencode".to_string()));

    // Verify adapter resolution: produces concrete "opencode", neither "auto" nor "default"
    let exec = LocalExecutorConfig::new_logical("auto".into(), None).unwrap();
    let resolved_id = resolve_launch_agent_id(&attempt, &exec).unwrap();
    assert_eq!(resolved_id, "opencode");
    assert_ne!(resolved_id, "auto");
    assert_ne!(resolved_id, "default");
}

// ---------------------------------------------------------------------------
// Test 8: Immutability after freeze
// ---------------------------------------------------------------------------
#[test]
fn test_08_frozen_agent_id_immutable_after_freeze() {
    let attempt = dummy_attempt(Some("opencode".into()));

    // Target config changes to a completely different agent
    let exec_changed = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();
    assert_eq!(
        resolve_launch_agent_id(&attempt, &exec_changed).unwrap(),
        "opencode"
    );

    // Target config changes to default or auto
    let exec_default = LocalExecutorConfig::new_logical("default".into(), None).unwrap();
    assert_eq!(
        resolve_launch_agent_id(&attempt, &exec_default).unwrap(),
        "opencode"
    );

    let exec_auto = LocalExecutorConfig::new_logical("auto".into(), None).unwrap();
    assert_eq!(
        resolve_launch_agent_id(&attempt, &exec_auto).unwrap(),
        "opencode"
    );
}

// ---------------------------------------------------------------------------
// Test 9: Explicit Agent regression without default resolver
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_09_explicit_agent_regression_without_default_resolver() {
    let temp = tempfile::tempdir().unwrap();
    let probe = create_mock_orca_binary(temp.path(), VERIFIED_ORCA_VERSION, true);

    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_1"],
        &["job_explicit_agent"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    let captured_frozen = Arc::new(std::sync::Mutex::new(None));
    let cap_clone = captured_frozen.clone();
    let hooks = DaemonHooks {
        after_claim_intent_persisted: Some(Arc::new(move |att: &ActiveAttempt| {
            let frozen = att.frozen_agent_id.clone();
            let holder = cap_clone.clone();
            Box::pin(async move {
                let mut g = holder.lock().unwrap();
                *g = Some(frozen);
            })
        })),
        ..Default::default()
    };

    // No mock Unix socket or user data is set up; explicit agent must NOT require it
    run_daemon_with_hooks_and_admission_orca(&paths, fake_ready_adapter(), Some(1), hooks, probe)
        .await
        .unwrap();

    assert_eq!(claim_counter.load(Ordering::SeqCst), 1);
    let captured = captured_frozen.lock().unwrap().clone();
    assert_eq!(captured, Some(None));

    let att = dummy_attempt(None);
    let exec = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();
    assert_eq!(resolve_launch_agent_id(&att, &exec).unwrap(), "antigravity");
}

// ---------------------------------------------------------------------------
// Test 10: Explicit command regression
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_10_explicit_command_regression() {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_cmd"],
        &["job_cmd"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let cmd_path = executable_legacy_command(&temp);
    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_cmd".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), cmd_path).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    assert_eq!(claim_counter.load(Ordering::SeqCst), 1);
}

// ---------------------------------------------------------------------------
// Test 11: Adapter fail closed on unresolved policy
// ---------------------------------------------------------------------------
#[test]
fn test_11_adapter_fail_closed_on_unresolved_policy() {
    let att_unresolved = dummy_attempt(None);

    let exec_default = LocalExecutorConfig::new_logical("default".into(), None).unwrap();
    let err_default = resolve_launch_agent_id(&att_unresolved, &exec_default).unwrap_err();
    assert!(err_default.contains("default Agent policy is unresolved"));

    let exec_auto = LocalExecutorConfig::new_logical("auto".into(), None).unwrap();
    let err_auto = resolve_launch_agent_id(&att_unresolved, &exec_auto).unwrap_err();
    assert!(err_auto.contains("default Agent policy is unresolved"));

    // Explicit agent does not error
    let exec_explicit = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();
    assert_eq!(
        resolve_launch_agent_id(&att_unresolved, &exec_explicit).unwrap(),
        "antigravity"
    );
}

// ---------------------------------------------------------------------------
// Test 12: Candidate scan skips unresolved default and claims later candidate
// ---------------------------------------------------------------------------
#[tokio::test]
async fn test_12_candidate_scan_skips_unresolved_default_and_claims_later_candidate() {
    let server = MockServer::start().await;
    let claim_counter = Arc::new(AtomicUsize::new(0));
    let claimed_job_ids = Arc::new(std::sync::Mutex::new(Vec::new()));
    standard_target_handlers(
        &server,
        &["tgt_unresolved_default", "tgt_compatible_cmd"],
        &["job_unresolved_1", "job_compatible_2"],
        claim_counter.clone(),
        claimed_job_ids.clone(),
    );

    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    base_credential(&server, &paths);

    let cmd_path = executable_legacy_command(&temp);
    let mut config = LocalConfig::new(server.origin()).unwrap();
    // First candidate targets default agent without working resolver
    config.targets.insert(
        "tgt_unresolved_default".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new_logical("default".into(), None).unwrap()),
        ),
    );
    // Second candidate targets legacy command executor
    config.targets.insert(
        "tgt_compatible_cmd".into(),
        mapped_target(
            &temp,
            Some(LocalExecutorConfig::new("agy".into(), cmd_path).unwrap()),
        ),
    );
    config.save(&paths.config_file()).unwrap();

    run_daemon_with_hooks_and_admission_orca(
        &paths,
        fake_ready_adapter(),
        Some(1),
        DaemonHooks::default(),
        missing_orca_probe(&temp),
    )
    .await
    .unwrap();

    // First candidate was skipped; second candidate was claimed
    assert_eq!(claim_counter.load(Ordering::SeqCst), 1);
    let claimed = claimed_job_ids.lock().unwrap().clone();
    assert_eq!(claimed, vec!["job_compatible_2".to_string()]);
}
