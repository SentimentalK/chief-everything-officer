mod common;

use std::fs;
use std::process::Command;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{run_doctor, DiagnosticSeverity};
use ceo_connector::paths::ConnectorPaths;
use common::mock_server::{MockResponse, MockServer};

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
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
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
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
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
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
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
            workspace_id: "ws_1".into(),
            alias: "disabled-target".into(),
            kind: "general_automation".into(),
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
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
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
            workspace_id: "ws_1".into(),
            alias: "healthy-target".into(),
            kind: "coding".into(),
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(report.overall_passed);

    // Git executable detected
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Git Executable" && c.severity == DiagnosticSeverity::Pass));

    // Target healthy & repo matched
    assert!(report
        .checks
        .iter()
        .any(|c| c.name == "Target 'healthy-target'" && c.severity == DiagnosticSeverity::Pass));
}
