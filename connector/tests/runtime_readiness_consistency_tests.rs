mod common;

use std::fs;
use std::process::Command;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{check_orca_cli, run_doctor_with_orca, DiagnosticSeverity};
use ceo_connector::execution_admission::ProjectRunnableStatus;
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::orca::OrcaExecutionAdapter;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::build_project_display_items_with_probe;
use ceo_connector::scheduler::ExecutionAdapter;
use common::mock_server::{MockResponse, MockServer};

fn create_mock_orca(temp: &tempfile::TempDir, status_json: &str) -> OrcaCliClient {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script_path = temp
            .path()
            .join(format!("mock-orca-{}", uuid::Uuid::new_v4()));
        let script = format!(
            r#"#!/bin/sh
if [ "$1" = "status" ]; then
    echo '{status_json}'
    exit 0
fi
echo '{{"ok":true}}'
"#
        );
        fs::write(&script_path, script).unwrap();
        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).unwrap();
        OrcaCliClient::new(script_path)
    }
    #[cfg(windows)]
    {
        let script_path = temp
            .path()
            .join(format!("mock-orca-{}.cmd", uuid::Uuid::new_v4()));
        let escaped = status_json.replace('"', "\\\"");
        let script = format!(
            "@echo off\r\nif \"%~1\"==\"status\" (\r\necho {escaped}\r\nexit /b 0\r\n)\r\necho {{\"ok\":true}}\r\n"
        );
        fs::write(&script_path, script).unwrap();
        OrcaCliClient::new(script_path)
    }
}

fn init_git_repo(path: &std::path::Path, remote_url: &str) {
    fs::create_dir_all(path).unwrap();
    let status = Command::new("git")
        .arg("init")
        .current_dir(path)
        .status()
        .unwrap();
    assert!(status.success());

    let _ = Command::new("git")
        .args(["config", "user.name", "Test"])
        .current_dir(path)
        .status();
    let _ = Command::new("git")
        .args(["config", "user.email", "test@example.com"])
        .current_dir(path)
        .status();

    fs::write(path.join("README.md"), "# Test\n").unwrap();
    let _ = Command::new("git")
        .args(["add", "."])
        .current_dir(path)
        .status();
    let _ = Command::new("git")
        .args(["commit", "-m", "init"])
        .current_dir(path)
        .status();

    let status = Command::new("git")
        .arg("remote")
        .arg("add")
        .arg("origin")
        .arg(remote_url)
        .current_dir(path)
        .status()
        .unwrap();
    assert!(status.success());
}

async fn setup_consistent_environment(
    temp: &tempfile::TempDir,
    server: &MockServer,
) -> (ConnectorPaths, String) {
    let agent_bin = temp.path().join("agent-bin");
    fs::write(&agent_bin, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&agent_bin).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&agent_bin, perms).unwrap();
    }

    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_test",
                    "device": { "id": "dev_test", "display_name": "Test Device", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_test", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }
        if req.path == "/api/connector/workspaces" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "workspaces": [] }));
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_proj_1",
                            "workspace_id": "ws_1",
                            "alias": "test-project",
                            "display_name": "Test Project",
                            "kind": "coding",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse {
            status: 404,
            headers: vec![],
            body: vec![],
        }
    });

    let paths = ConnectorPaths::from_root(temp.path().join(".ceo"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        server.origin(),
        "usr_test".into(),
        "dev_test".into(),
        "dcr_test".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let repo_dir = temp.path().join("repo");
    init_git_repo(&repo_dir, "https://github.com/org/repo.git");

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_proj_1".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(
                LocalExecutorConfig::new("custom".into(), agent_bin.display().to_string()).unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (paths, agent_bin.display().to_string())
}

#[tokio::test]
async fn test_runtime_readiness_consistency_ready() {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let (paths, _agent_bin) = setup_consistent_environment(&temp, &server).await;

    let orca_client = create_mock_orca(
        &temp,
        r#"{"ok":true,"result":{"app":{"running":true,"pid":1234},"runtime":{"state":"ready","reachable":true,"appVersion":"1.4.209"}}}"#,
    );

    // 1. Adapter readiness
    let adapter = OrcaExecutionAdapter::new(orca_client.clone());
    assert!(
        adapter.is_ready().await,
        "adapter must report is_ready = true when Orca status is ready"
    );

    // 2. Project runnability
    let items = build_project_display_items_with_probe(&paths, Some(&orca_client))
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let runnable = items[0].runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::Runnable);
    assert!(runnable.is_runnable());
    assert_eq!(runnable.code, None);

    // 3. Doctor checks
    let mut checks = Vec::new();
    check_orca_cli(&orca_client, &mut checks).await;
    let orca_check = checks
        .iter()
        .find(|c| c.name == "Orca CLI & Runtime")
        .expect("must have Orca check");
    assert_eq!(orca_check.severity, DiagnosticSeverity::Pass);
    assert!(orca_check.message.contains("Version 1.4.209"));
    assert!(orca_check.message.contains("runtime ready"));

    let doctor_report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(doctor_report.overall_passed);
    assert!(doctor_report
        .checks
        .iter()
        .any(|c| c.name == "Orca CLI & Runtime" && c.severity == DiagnosticSeverity::Pass));
}

#[tokio::test]
async fn test_runtime_readiness_consistency_missing_result() {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let (paths, _agent_bin) = setup_consistent_environment(&temp, &server).await;

    // ok=true but result is None: MUST be non-ready everywhere
    let orca_client = create_mock_orca(&temp, r#"{"ok":true}"#);

    // 1. Adapter readiness
    let adapter = OrcaExecutionAdapter::new(orca_client.clone());
    assert!(
        !adapter.is_ready().await,
        "adapter must report is_ready = false when status has ok=true, result=None"
    );

    // 2. Project runnability
    let items = build_project_display_items_with_probe(&paths, Some(&orca_client))
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let runnable = items[0].runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert!(!runnable.is_runnable());
    assert_eq!(
        runnable.code.as_deref(),
        Some("ORCA_STATUS_MISSING_RESULT"),
        "project runnability must report ORCA_STATUS_MISSING_RESULT"
    );

    // 3. Doctor checks
    let mut checks = Vec::new();
    check_orca_cli(&orca_client, &mut checks).await;
    let orca_check = checks
        .iter()
        .find(|c| c.name == "Orca CLI & Runtime")
        .expect("must have Orca check");
    assert_eq!(
        orca_check.severity,
        DiagnosticSeverity::Fail,
        "Doctor Orca check must FAIL when ok=true, result=None"
    );
    assert!(
        orca_check.message.contains("ORCA_STATUS_MISSING_RESULT"),
        "Doctor Orca check message must contain ORCA_STATUS_MISSING_RESULT: {}",
        orca_check.message
    );

    let doctor_report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(
        !doctor_report.overall_passed,
        "Doctor overall_passed must be false when Orca check fails"
    );
}

#[tokio::test]
async fn test_runtime_readiness_consistency_app_not_running() {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let (paths, _agent_bin) = setup_consistent_environment(&temp, &server).await;

    // app running = false
    let orca_client = create_mock_orca(
        &temp,
        r#"{"ok":true,"result":{"app":{"running":false},"runtime":{"state":"ready","reachable":true,"appVersion":"1.4.209"}}}"#,
    );

    // 1. Adapter readiness
    let adapter = OrcaExecutionAdapter::new(orca_client.clone());
    assert!(
        !adapter.is_ready().await,
        "adapter must report is_ready = false when app is not running"
    );

    // 2. Project runnability
    let items = build_project_display_items_with_probe(&paths, Some(&orca_client))
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let runnable = items[0].runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert!(!runnable.is_runnable());
    assert_eq!(
        runnable.code.as_deref(),
        Some("ORCA_NOT_RUNNING"),
        "project runnability must report ORCA_NOT_RUNNING"
    );

    // 3. Doctor checks
    let mut checks = Vec::new();
    check_orca_cli(&orca_client, &mut checks).await;
    let orca_check = checks
        .iter()
        .find(|c| c.name == "Orca CLI & Runtime")
        .expect("must have Orca check");
    assert_eq!(
        orca_check.severity,
        DiagnosticSeverity::Fail,
        "Doctor Orca check must FAIL when app is not running"
    );
    assert!(
        orca_check.message.contains("ORCA_NOT_RUNNING"),
        "Doctor Orca check message must contain ORCA_NOT_RUNNING: {}",
        orca_check.message
    );
    assert!(
        orca_check.message.contains("Version 1.4.209"),
        "Doctor Orca check message must preserve app version: {}",
        orca_check.message
    );

    let doctor_report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(
        !doctor_report.overall_passed,
        "Doctor overall_passed must be false when app is not running"
    );
}

#[tokio::test]
async fn test_runtime_readiness_consistency_runtime_not_ready() {
    let temp = tempfile::tempdir().unwrap();
    let server = MockServer::start().await;
    let (paths, _agent_bin) = setup_consistent_environment(&temp, &server).await;

    // runtime state = "starting" (not ready)
    let orca_client = create_mock_orca(
        &temp,
        r#"{"ok":true,"result":{"app":{"running":true,"pid":1234},"runtime":{"state":"starting","reachable":true,"appVersion":"1.4.209"}}}"#,
    );

    // 1. Adapter readiness
    let adapter = OrcaExecutionAdapter::new(orca_client.clone());
    assert!(
        !adapter.is_ready().await,
        "adapter must report is_ready = false when runtime is not ready"
    );

    // 2. Project runnability
    let items = build_project_display_items_with_probe(&paths, Some(&orca_client))
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let runnable = items[0].runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert!(!runnable.is_runnable());
    assert_eq!(
        runnable.code.as_deref(),
        Some("ORCA_RUNTIME_NOT_READY"),
        "project runnability must report ORCA_RUNTIME_NOT_READY"
    );

    // 3. Doctor checks
    let mut checks = Vec::new();
    check_orca_cli(&orca_client, &mut checks).await;
    let orca_check = checks
        .iter()
        .find(|c| c.name == "Orca CLI & Runtime")
        .expect("must have Orca check");
    assert_eq!(
        orca_check.severity,
        DiagnosticSeverity::Fail,
        "Doctor Orca check must FAIL when runtime is not ready"
    );
    assert!(
        orca_check.message.contains("ORCA_RUNTIME_NOT_READY"),
        "Doctor Orca check message must contain ORCA_RUNTIME_NOT_READY: {}",
        orca_check.message
    );
    assert!(
        orca_check.message.contains("Version 1.4.209"),
        "Doctor Orca check message must preserve app version: {}",
        orca_check.message
    );

    let doctor_report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(
        !doctor_report.overall_passed,
        "Doctor overall_passed must be false when runtime is not ready"
    );
}
