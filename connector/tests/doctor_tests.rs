mod common;

use std::fs;
use std::process::Command;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{run_doctor, run_doctor_with_orca, DiagnosticSeverity};
use ceo_connector::orca::client::OrcaCliClient;
use ceo_connector::paths::ConnectorPaths;
use common::mock_server::{MockResponse, MockServer};

fn healthy_mock_orca(temp: &tempfile::TempDir) -> OrcaCliClient {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let script_path = temp.path().join("mock-orca");
        let script = r#"#!/bin/sh
if [ "$1" = "status" ]; then
    echo '{"ok":true,"result":{"app":{"running":true},"runtime":{"state":"ready","reachable":true,"appVersion":"1.4.209"}}}'
    exit 0
fi
echo '{"ok":true}'
"#;
        fs::write(&script_path, script).unwrap();
        let mut perms = fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&script_path, perms).unwrap();
        OrcaCliClient::new(script_path)
    }
    #[cfg(windows)]
    {
        let script_path = temp.path().join("mock-orca.cmd");
        let script = "@echo off\r\nif \"%~1\"==\"status\" (\r\necho {\"ok\":true,\"result\":{\"app\":{\"running\":true},\"runtime\":{\"state\":\"ready\",\"reachable\":true,\"appVersion\":\"1.4.209\"}}}\r\nexit /b 0\r\n)\r\necho {\"ok\":true}\r\n";
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

#[tokio::test]
async fn doctor_detects_expired_credential() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let expired_cred = DeviceCredential::new(
        "http://127.0.0.1:4000".into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        1000, // Expired
    )
    .unwrap();
    expired_cred.save(&paths.credential_file()).unwrap();

    let config = LocalConfig::new("http://127.0.0.1:4000".into()).unwrap();
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(!report.overall_passed);
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Credential Expiry" && c.severity == DiagnosticSeverity::Fail));
}

#[tokio::test]
async fn doctor_detects_server_origin_mismatch() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential::new(
        "http://127.0.0.1:4000".into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let config = LocalConfig::new("https://other.server.com".into()).unwrap();
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(!report.overall_passed);
    assert!(report
        .checks
        .iter()
        .any(|c| c.message.contains("LOCAL_CREDENTIAL_SERVER_MISMATCH")));
}

#[tokio::test]
async fn doctor_detects_missing_path_and_disabled_target() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
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
                            "id": "tgt_disabled",
                            "workspace_id": "ws_1",
                            "alias": "disabled-target",
                            "display_name": "Disabled Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": true
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 0
                    }]
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
    cred.save(&paths.credential_file()).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_disabled".into(),
        LocalTarget {
            local_path: "/nonexistent/path/for/target".into(), // Missing!
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(!report.overall_passed);

    // Assert missing path check failed
    assert!(report
        .checks
        .iter()
        .any(|c| c.name.contains("Path") && c.severity == DiagnosticSeverity::Fail));

    // Assert disabled target check failed
    assert!(report
        .checks
        .iter()
        .any(|c| c.name.contains("Status") && c.severity == DiagnosticSeverity::Fail));
}

#[tokio::test]
async fn doctor_healthy_report_detects_git_and_targets() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
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
                            "id": "tgt_healthy",
                            "workspace_id": "ws_1",
                            "alias": "healthy-target",
                            "display_name": "Healthy Target",
                            "kind": "coding",
                            "repository": {
                                "provider": "github",
                                "external_id": "1",
                                "full_name": "org/repo"
                            },
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
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
    cred.save(&paths.credential_file()).unwrap();

    let repo_dir = temp.path().join("healthy_repo");
    init_git_repo(&repo_dir, "https://github.com/org/repo.git");

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_healthy".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let orca_client = healthy_mock_orca(&temp);
    let report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(report.overall_passed);

    // Orca CLI & Runtime detected and ready
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Orca CLI & Runtime" && c.severity == DiagnosticSeverity::Pass));

    // Git executable detected
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Git Executable" && c.severity == DiagnosticSeverity::Pass));

    // Target healthy & repo matched; human check names use the
    // Server-authoritative alias, never the raw target ID.
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Target 'healthy-target'" && c.severity == DiagnosticSeverity::Pass));
    assert!(report.checks.iter().any(|c| c.name
        == "Target 'healthy-target' Executor Configuration"
        && c.severity == DiagnosticSeverity::Pass));
    assert!(!report.checks.iter().any(|c| c.name.contains("tgt_")));
}

#[tokio::test]
async fn doctor_missing_executor_next_step_uses_alias_selector() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
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
                            "id": "tgt_ceo-agent-runtime",
                            "workspace_id": "ws_1",
                            "alias": "ceo-agent-runtime",
                            "display_name": "CEO Agent Runtime",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
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
    cred.save(&paths.credential_file()).unwrap();

    let runtime_dir = temp.path().join("ceo-agent-runtime");
    fs::create_dir_all(&runtime_dir).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_ceo-agent-runtime".into(),
        LocalTarget {
            local_path: runtime_dir.to_string_lossy().to_string(),
            executor: None, // fresh device: no executor yet
        },
    );
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, false).await;
    assert!(!report.overall_passed);

    // Human check names prefer the Server-authoritative alias.
    let executor_check = report
        .checks
        .iter()
        .find(|c| c.name == "Target 'ceo-agent-runtime' Executor Configuration")
        .expect("executor check must use the human alias");
    assert_eq!(executor_check.severity, DiagnosticSeverity::Fail);
    // The next-step command uses the exact human alias selector, not a raw
    // target ID.
    assert!(executor_check
        .message
        .contains("--target-id ceo-agent-runtime"));
    assert!(!executor_check.message.contains("tgt_"));

    // JSON contract compatibility: same structure/fields, severity enum,
    // raw target IDs may still appear in advanced JSON data.
    let json_report = run_doctor(&paths, true).await;
    let serialized = serde_json::to_value(&json_report).unwrap();
    assert!(serialized["overall_passed"].is_boolean());
    for check in serialized["checks"].as_array().unwrap() {
        assert!(check["name"].is_string());
        assert!(check["severity"].is_string());
        assert!(check["message"].is_string());
    }
    assert!(json_report.checks.iter().any(
        |c| c.name.contains("Executor Configuration") && c.severity == DiagnosticSeverity::Fail
    ));
}

#[tokio::test]
async fn doctor_fully_configured_fixture_passes_with_executor() {
    // A device that completed guided setup (local official-style repo mapped,
    // bound, executor configured) passes Doctor — it no longer fails merely
    // because setup ran; only genuinely missing requirements fail.
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
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
                            "id": "tgt_healthy",
                            "workspace_id": "ws_1",
                            "alias": "healthy-target",
                            "display_name": "Healthy Target",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
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
    cred.save(&paths.credential_file()).unwrap();

    let repo_dir = temp.path().join("healthy_repo");
    init_git_repo(&repo_dir, "https://github.com/org/repo.git");

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_healthy".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let orca_client = healthy_mock_orca(&temp);
    let report = run_doctor_with_orca(&paths, true, orca_client).await;
    assert!(report.overall_passed);
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Orca CLI & Runtime" && c.severity == DiagnosticSeverity::Pass));
    // Executor configured and validated for the alias-named target.
    assert!(report.checks.iter().any(|c| c.name
        == "Target 'healthy-target' Executor Configuration"
        && c.severity == DiagnosticSeverity::Pass));
}

#[tokio::test]
async fn doctor_missing_orca_reports_fail_and_overall_passed_false() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let missing_orca_client =
        ceo_connector::orca::client::OrcaCliClient::new(temp.path().join("nonexistent_orca_bin"));

    let report =
        ceo_connector::doctor::run_doctor_with_orca(&paths, true, missing_orca_client).await;
    assert!(
        !report.overall_passed,
        "overall_passed must be false when Orca is missing"
    );
    let orca_check = report
        .checks
        .iter()
        .find(|c| c.name == "Orca CLI & Runtime")
        .expect("must contain Orca check");
    assert_eq!(
        orca_check.severity,
        DiagnosticSeverity::Fail,
        "missing Orca must be FAIL, not WARN"
    );
    assert!(
        orca_check.message.contains("not found in PATH") || orca_check.message.contains("failed")
    );
}

#[tokio::test]
async fn doctor_logical_agent_target_fails_when_pure_launch_unavailable() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_1",
                    "device": { "id": "dev_1", "display_name": "Dev", "platform": "linux-x86_64" },
                    "credential": { "id": "dcr_1", "expires_at_ms": 2000000000000i64 }
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
                            "id": "tgt_logical",
                            "workspace_id": "ws_1",
                            "alias": "logical-target",
                            "display_name": "Logical Target",
                            "kind": "coding",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
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
    cred.save(&paths.credential_file()).unwrap();

    let repo_dir = temp.path().join("logical_repo");
    fs::create_dir_all(&repo_dir).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_logical".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("auto".into(), None).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(
        !report.overall_passed,
        "Doctor must FAIL when Orca lacks pure agent launch surface for logical config"
    );

    let compat_check = report
        .checks
        .iter()
        .find(|c| c.name == "Target 'logical-target' Agent Launch Compatibility")
        .expect("must contain compatibility check");
    assert_eq!(compat_check.severity, DiagnosticSeverity::Fail);
    assert!(compat_check
        .message
        .contains("ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE"));
}

#[tokio::test]
async fn doctor_diagnostics_human_and_json_remain_ansi_free() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();

    let report = run_doctor(&paths, false).await;
    let human = ceo_connector::doctor::render_doctor_human(&report);
    assert!(
        !human.contains('\x1b'),
        "human output must not contain ANSI escape sequences"
    );

    let json_str = serde_json::to_string_pretty(&report).unwrap();
    assert!(
        !json_str.contains('\x1b'),
        "JSON output must not contain ANSI escape sequences"
    );
}
