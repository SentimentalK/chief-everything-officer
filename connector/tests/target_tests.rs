mod common;

use std::fs;
use std::process::Command;

use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::targets::{
    normalize_github_remote, target_add, target_bind, target_remove, TargetError,
};
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

#[test]
fn github_remote_url_normalization() {
    assert_eq!(
        normalize_github_remote("https://github.com/owner/repo.git").unwrap(),
        "owner/repo"
    );
    assert_eq!(
        normalize_github_remote("https://github.com/owner/repo").unwrap(),
        "owner/repo"
    );
    assert_eq!(
        normalize_github_remote("git@github.com:owner/repo.git").unwrap(),
        "owner/repo"
    );
    assert_eq!(
        normalize_github_remote("ssh://git@github.com/owner/repo.git").unwrap(),
        "owner/repo"
    );
    assert_eq!(
        normalize_github_remote("http://github.com/owner/repo").unwrap(),
        "owner/repo"
    );

    // Non-github
    assert!(normalize_github_remote("https://gitlab.com/owner/repo.git").is_none());
}

#[tokio::test]
async fn target_add_general_automation_and_repo_null_coding() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets/register" && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            let alias = body.get("alias").unwrap().as_str().unwrap();
            let kind = body.get("kind").unwrap().as_str().unwrap();

            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": {
                        "id": format!("tgt_{alias}"),
                        "workspace_id": "ws_123",
                        "alias": alias,
                        "display_name": "Test Target",
                        "kind": kind,
                        "repository": null,
                        "disabled": false
                    },
                    "binding": {
                        "id": "bnd_123",
                        "enabled": true
                    },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
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

    let target_dir = temp.path().join("my_target_dir");
    fs::create_dir_all(&target_dir).unwrap();

    // 1. Add general automation target
    target_add(
        &paths,
        "ws_123",
        "auto-target",
        "Automation",
        "general_automation",
        &target_dir.to_string_lossy(),
        false,
        None,
        None,
    )
    .await
    .unwrap();

    // 2. Add repo-null coding target mapping to SAME local path (duplicate paths allowed!)
    target_add(
        &paths,
        "ws_123",
        "coding-target",
        "Coding",
        "coding",
        &target_dir.to_string_lossy(),
        false,
        None,
        None,
    )
    .await
    .unwrap();

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(config.targets.len(), 2);
    // Schema v3 local state stores only Device-owned fields; the Server
    // alias is not persisted locally (alias authority is Server-only).
    let auto = config.targets.get("tgt_auto-target").unwrap();
    let coding = config.targets.get("tgt_coding-target").unwrap();
    assert!(serde_json::to_value(auto).unwrap().get("alias").is_none());
    assert!(serde_json::to_value(auto)
        .unwrap()
        .get("workspace_id")
        .is_none());
    assert!(serde_json::to_value(auto).unwrap().get("kind").is_none());
    assert_eq!(auto.local_path, coding.local_path);
}

#[tokio::test]
async fn target_add_with_workspace_repository_verification() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/workspaces" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "workspaces": [{
                        "id": "ws_org",
                        "role": "admin",
                        "workspace_repository": {
                            "provider": "github",
                            "external_id": "111",
                            "full_name": "my-org/my-repo",
                            "branch": "main"
                        }
                    }]
                }),
            );
        }

        if req.path == "/api/connector/targets/register" && req.method == "POST" {
            return MockResponse::json(
                201,
                &serde_json::json!({
                    "target": {
                        "id": "tgt_repo_target",
                        "workspace_id": "ws_org",
                        "alias": "repo-target",
                        "display_name": "Repo Target",
                        "kind": "coding",
                        "repository": {
                            "provider": "github",
                            "external_id": "111",
                            "full_name": "my-org/my-repo"
                        },
                        "disabled": false
                    },
                    "binding": {
                        "id": "bnd_repo",
                        "enabled": true
                    },
                    "target_created": true,
                    "binding_created": true,
                    "replayed": false
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

    // 1. Valid git repo matching my-org/my-repo
    let matching_repo = temp.path().join("matching_repo");
    init_git_repo(&matching_repo, "git@github.com:my-org/my-repo.git");

    target_add(
        &paths,
        "ws_org",
        "repo-target",
        "Repo Target",
        "coding",
        &matching_repo.to_string_lossy(),
        true,
        None,
        None,
    )
    .await
    .unwrap();

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key("tgt_repo_target"));

    // 2. Mismatched git repo
    let mismatched_repo = temp.path().join("mismatched_repo");
    init_git_repo(
        &mismatched_repo,
        "https://github.com/other-org/other-repo.git",
    );

    let err = target_add(
        &paths,
        "ws_org",
        "mismatched-target",
        "Mismatched",
        "coding",
        &mismatched_repo.to_string_lossy(),
        true,
        None,
        None,
    )
    .await
    .unwrap_err();

    assert!(matches!(err, TargetError::RepositoryMismatch { .. }));
}

#[tokio::test]
async fn target_bind_and_remove_lifecycle() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets/tgt_existing/bind" && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "target_id": "tgt_existing",
                    "binding_id": "bnd_new",
                    "enabled": true,
                    "replayed": false
                }),
            );
        }

        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_existing",
                            "workspace_id": "ws_1",
                            "alias": "bound-target",
                            "display_name": "Bound Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": {
                            "id": "bnd_new",
                            "enabled": true
                        },
                        "active_binding_count": 1
                    }]
                }),
            );
        }

        if req.path == "/api/connector/targets/tgt_existing/unbind" && req.method == "POST" {
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
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

    let target_dir = temp.path().join("bound_dir");
    fs::create_dir_all(&target_dir).unwrap();

    // Bind target
    target_bind(
        &paths,
        "tgt_existing",
        &target_dir.to_string_lossy(),
        None,
        None,
    )
    .await
    .unwrap();

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key("tgt_existing"));

    // Remove target
    target_remove(&paths, "tgt_existing").await.unwrap();
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!config.targets.contains_key("tgt_existing"));
}

#[tokio::test]
async fn active_target_mutation_rejected_with_target_in_use() {
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

    let mut config = LocalConfig::new("http://127.0.0.1:4000".into()).unwrap();
    config.targets.insert(
        "tgt_in_use".into(),
        ceo_connector::config::LocalTarget {
            local_path: "/path/to/repo".into(),
            executor: None,
        },
    );
    config.save(&paths.config_file()).unwrap();

    // Plant active attempt using tgt_in_use
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_active_123",
            "target_id": "tgt_in_use"
        }),
    )
    .unwrap();

    // Attempt remove tgt_in_use
    let err = target_remove(&paths, "tgt_in_use").await.unwrap_err();
    assert!(matches!(err, TargetError::TargetInUse(tid) if tid == "tgt_in_use"));

    // Mapping remains intact in config!
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key("tgt_in_use"));

    // Attempt bind tgt_in_use
    let test_dir = temp.path().join("new_dir");
    fs::create_dir_all(&test_dir).unwrap();
    let err = target_bind(
        &paths,
        "tgt_in_use",
        &test_dir.to_string_lossy(),
        None,
        None,
    )
    .await
    .unwrap_err();
    assert!(matches!(err, TargetError::TargetInUse(tid) if tid == "tgt_in_use"));

    // Attempt set-agent on tgt_in_use rejected with TARGET_IN_USE
    let err = ceo_connector::targets::target_set_agent(&paths, "tgt_in_use", "agy", "agy")
        .await
        .unwrap_err();
    assert!(matches!(err, TargetError::TargetInUse(tid) if tid == "tgt_in_use"));
}

#[tokio::test]
async fn target_set_default_runtime_success_and_replay() {
    let server = MockServer::start().await;
    let default_seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    server.add_handler({
        let seen = default_seen.clone();
        move |req| {
            // Selector resolution now consults the server catalogue first.
            if req.path == "/api/connector/targets" && req.method == "GET" {
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "targets": [{
                            "target": {
                                "id": "tgt_runtime",
                                "workspace_id": "ws_1",
                                "alias": "runtime",
                                "display_name": "Runtime Target",
                                "kind": "general_automation",
                                "repository": null,
                                "disabled": false
                            },
                            "this_device_binding": null,
                            "active_binding_count": 0
                        }]
                    }),
                );
            }
            if req.path == "/api/connector/targets/tgt_runtime/default-runtime"
                && req.method == "POST"
            {
                let mut seen = seen.lock().unwrap();
                seen.push(String::from("called"));
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "workspace_id": "ws_1",
                        "target_id": "tgt_runtime",
                        "is_default_agent_runtime": true,
                        "replayed": false,
                        "updated_at_ms": 1700000000000i64
                    }),
                );
            }
            MockResponse {
                status: 0,
                headers: vec![],
                body: vec![],
            }
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

    ceo_connector::targets::target_set_default_runtime(&paths, "tgt_runtime")
        .await
        .unwrap();

    let calls = default_seen.lock().unwrap();
    assert_eq!(calls.len(), 1);
}

#[tokio::test]
async fn target_set_default_runtime_auth_and_error_behavior() {
    // 401 maps to Unauthorized (surfaces from selector resolution or the mutation)
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(200, &serde_json::json!({ "user_id": "usr_1" }));
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(401, &serde_json::json!({ "error": "unauthorized" }));
        }
        if req.method == "POST" && req.path.contains("/default-runtime") {
            return MockResponse::json(401, &serde_json::json!({ "error": "unauthorized" }));
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

    let err = ceo_connector::targets::target_set_default_runtime(&paths, "tgt_runtime")
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        TargetError::Client(ceo_connector::client::ClientError::Unauthorized)
    ));

    // Non-owner surfaces a structured TargetError with code
    let server2 = MockServer::start().await;
    server2.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_runtime",
                            "workspace_id": "ws_1",
                            "alias": "runtime",
                            "display_name": "Runtime Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": null,
                        "active_binding_count": 0
                    }]
                }),
            );
        }
        if req.method == "POST" && req.path.contains("/default-runtime") {
            return MockResponse::json(
                403,
                &serde_json::json!({
                    "error": "DEVICE_NOT_ELIGIBLE",
                    "message": "Only workspace owners can change the workspace default agent runtime target."
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let temp2 = tempfile::tempdir().unwrap();
    let paths2 = ConnectorPaths::from_root(temp2.path().join("root"));
    paths2.ensure_dirs().unwrap();

    let cred2 = DeviceCredential::new(
        server2.origin(),
        "usr_2".into(),
        "dev_2".into(),
        "dcr_2".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred2.save(&paths2.credential_file()).unwrap();

    let err2 = ceo_connector::targets::target_set_default_runtime(&paths2, "tgt_runtime")
        .await
        .unwrap_err();
    match err2 {
        TargetError::Client(ceo_connector::client::ClientError::TargetError { code, message }) => {
            assert_eq!(code, "DEVICE_NOT_ELIGIBLE");
            assert!(message.contains("workspace owners"));
        }
        other => panic!("unexpected error: {other:?}"),
    }
}

#[tokio::test]
async fn target_list_marks_default_runtime_in_text_and_json() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [
                        {
                            "target": {
                                "id": "tgt_default",
                                "workspace_id": "ws_1",
                                "alias": "runtime",
                                "display_name": "Runtime Target",
                                "kind": "general_automation",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": true
                            },
                            "this_device_binding": {
                                "id": "bnd_1",
                                "enabled": true
                            },
                            "active_binding_count": 1
                        },
                        {
                            "target": {
                                "id": "tgt_other",
                                "workspace_id": "ws_1",
                                "alias": "other",
                                "display_name": "Other Target",
                                "kind": "coding",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": null,
                            "active_binding_count": 0
                        }
                    ]
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

    // Build the same projection the text and JSON output paths render.
    let items = ceo_connector::targets::build_target_display_items(&paths)
        .await
        .unwrap();
    assert_eq!(items.len(), 2);
    let by_id: std::collections::BTreeMap<&str, &ceo_connector::targets::TargetDisplayItem> =
        items.iter().map(|i| (i.target_id.as_str(), i)).collect();
    assert!(by_id["tgt_default"].is_default_agent_runtime);
    assert!(!by_id["tgt_other"].is_default_agent_runtime);

    // JSON output includes the boolean.
    let json = serde_json::to_string(items.first().unwrap()).unwrap();
    assert!(json.contains("\"is_default_agent_runtime\":true"));

    // Both printing paths succeed end-to-end (text marks DEFAULT_RUNTIME, JSON
    // serializes the same items).
    ceo_connector::targets::target_list(&paths, false)
        .await
        .unwrap();
    ceo_connector::targets::target_list(&paths, true)
        .await
        .unwrap();

    // No local config mapping is created by the server-only default marker.
    let config = LocalConfig::load(&paths.config_file()).unwrap();
    assert!(config.is_none_or(|c| c.targets.is_empty()));
}
