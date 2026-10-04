use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use tempfile::TempDir;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget, CONFIG_SCHEMA_VERSION};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::execution_admission::{
    AgentLaunchSurface, ExecutionCompatibilityProbe, OrcaRuntimeReadiness, ProjectRunnableStatus,
    ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE,
};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::projects::{
    build_project_display_items_with_probe, render_project_list, render_project_show,
    ProjectDisplayItem,
};

mod common;
use common::mock_server::{MockResponse, MockServer};

struct CountingMockProbe {
    pub readiness: OrcaRuntimeReadiness,
    pub surface: AgentLaunchSurface,
    pub readiness_probes: AtomicU32,
    pub surface_probes: AtomicU32,
}

impl CountingMockProbe {
    fn new(readiness: OrcaRuntimeReadiness, surface: AgentLaunchSurface) -> Self {
        Self {
            readiness,
            surface,
            readiness_probes: AtomicU32::new(0),
            surface_probes: AtomicU32::new(0),
        }
    }
}

#[async_trait::async_trait]
impl ExecutionCompatibilityProbe for CountingMockProbe {
    async fn supports_agent_session_launch(&self) -> bool {
        self.surface == AgentLaunchSurface::Available
    }

    async fn probe_agent_launch_surface(&self) -> AgentLaunchSurface {
        self.surface_probes.fetch_add(1, Ordering::SeqCst);
        self.surface
    }

    async fn probe_runtime_readiness(&self) -> OrcaRuntimeReadiness {
        self.readiness_probes.fetch_add(1, Ordering::SeqCst);
        self.readiness.clone()
    }
}

fn init_git_repo(path: &Path, origin_url: Option<&str>) {
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

    if let Some(url) = origin_url {
        let _ = Command::new("git")
            .args(["remote", "add", "origin", url])
            .current_dir(path)
            .status();
    }
}

fn setup_test_profile(server_origin: &str) -> (TempDir, ConnectorPaths) {
    let temp = TempDir::new().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("dot-ceo"));
    paths.ensure_dirs().unwrap();

    let cred = DeviceCredential {
        schema_version: 1,
        server_origin: server_origin.to_string(),
        user_id: "user_test_123".to_string(),
        device_id: "dev_test_123".to_string(),
        credential_id: "crd_test_123".to_string(),
        secret: "secret_123".to_string(),
        expires_at_ms: chrono::Utc::now().timestamp_millis() + 86400000,
    };
    cred.save(&paths.credential_file()).unwrap();

    let cfg = LocalConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        server_url: server_origin.to_string(),
        targets: std::collections::BTreeMap::new(),
    };
    cfg.save(&paths.config_file()).unwrap();

    (temp, paths)
}

#[tokio::test]
async fn test_structural_ready_logical_ready_orca_supported_launch_is_runnable() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_logical_1",
                            "workspace_id": "ws_1",
                            "alias": "my-logical-proj",
                            "display_name": "My Logical Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_logical_1".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];

    // Structural status is READY
    assert_eq!(item.status, "READY");

    // Runnable verdict is runnable
    let runnable = item.runnable.as_ref().expect("runnable assessment present");
    assert_eq!(runnable.status, ProjectRunnableStatus::Runnable);
    assert!(runnable.is_runnable());
    assert_eq!(runnable.code, None);
    assert_eq!(runnable.reason, None);

    // Human rendering distinction
    let list_human = render_project_list(&items, false);
    assert!(list_human.contains("Config:     READY"));
    assert!(list_human.contains("Runnable:   yes"));

    let show_human = render_project_show(item, false);
    assert!(show_human.contains("Config:          READY"));
    assert!(show_human.contains("Runnable:        yes"));

    // JSON preserves backward-compatible fields and adds runnable
    let json_val = serde_json::to_value(item).unwrap();
    assert_eq!(json_val["status"], "READY");
    assert_eq!(json_val["runnable"]["status"], "runnable");
}

#[tokio::test]
async fn test_structural_ready_logical_unsupported_launch_is_not_runnable() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_logical_2",
                            "workspace_id": "ws_1",
                            "alias": "my-logical-proj-2",
                            "display_name": "My Logical Project 2",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_logical_2".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe =
        CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Unavailable);

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    let item = &items[0];

    // Structural status is READY
    assert_eq!(item.status, "READY");

    // Runnable verdict is NOT runnable with the same code used by admission/Doctor
    let runnable = item.runnable.as_ref().expect("runnable assessment present");
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert!(!runnable.is_runnable());
    assert_eq!(
        runnable.code.as_deref(),
        Some(ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE)
    );

    let list_human = render_project_list(&items, false);
    assert!(list_human.contains("Config:     READY"));
    assert!(list_human.contains(&format!(
        "Runnable:   no ({ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE})"
    )));

    let show_human = render_project_show(item, false);
    assert!(show_human.contains("Config:          READY"));
    assert!(show_human.contains(&format!(
        "Runnable:        no ({ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE})"
    )));
    assert!(show_human.contains("Reason:          installed Orca version does not expose the required orchestration Agent launch surface"));
}

#[tokio::test]
async fn test_structural_ready_explicit_command_runnable_when_orca_ready() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    let agent_bin = _temp.path().join("real-agent-bin");
    fs::write(&agent_bin, b"#!/bin/sh\nexit 0\n").unwrap();

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_cmd_1",
                            "workspace_id": "ws_1",
                            "alias": "my-cmd-proj",
                            "display_name": "My Command Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_cmd_1".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(
                LocalExecutorConfig::new("custom_agent".into(), agent_bin.display().to_string())
                    .unwrap(),
            ),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(
        OrcaRuntimeReadiness::Ready,
        AgentLaunchSurface::Unavailable, // Not consulted for explicit command
    );

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    let item = &items[0];

    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::Runnable);
    assert!(runnable.is_runnable());
}

#[tokio::test]
async fn test_missing_or_non_executable_explicit_command_is_not_runnable() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_missing_cmd",
                            "workspace_id": "ws_1",
                            "alias": "missing-cmd-proj",
                            "display_name": "Missing Command Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_missing_cmd".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(
                LocalExecutorConfig::new(
                    "custom_agent".into(),
                    "definitely-not-a-real-executable-xyz999".into(),
                )
                .unwrap(),
            ),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    let item = &items[0];

    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert_eq!(runnable.code.as_deref(), Some("COMMAND_UNAVAILABLE"));
}

#[tokio::test]
async fn test_structural_non_ready_is_not_runnable_regardless_of_executor() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [
                        {
                            "target": {
                                "id": "tgt_unbound",
                                "workspace_id": "ws_1",
                                "alias": "unbound-proj",
                                "display_name": "Unbound Project",
                                "kind": "ordinary",
                                "repository": null,
                                "disabled": false,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": { "id": "bnd_1", "enabled": false },
                            "active_binding_count": 0
                        },
                        {
                            "target": {
                                "id": "tgt_disabled",
                                "workspace_id": "ws_1",
                                "alias": "disabled-proj",
                                "display_name": "Disabled Project",
                                "kind": "ordinary",
                                "repository": null,
                                "disabled": true,
                                "is_default_agent_runtime": false
                            },
                            "this_device_binding": { "id": "bnd_2", "enabled": true },
                            "active_binding_count": 1
                        }
                    ]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    assert_eq!(items.len(), 2);

    for item in &items {
        assert_ne!(item.status, "READY");
        let runnable = item.runnable.as_ref().unwrap();
        assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
        assert!(!runnable.is_runnable());
        assert_eq!(runnable.code.as_deref(), Some(item.status.as_str()));
    }
}

#[tokio::test]
async fn test_explicit_orca_runtime_non_ready_is_not_runnable() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_orca_down",
                            "workspace_id": "ws_1",
                            "alias": "orca-down-proj",
                            "display_name": "Orca Down Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_orca_down".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(
        OrcaRuntimeReadiness::NotReady {
            code: "ORCA_NOT_RUNNING".to_string(),
            reason: "Orca desktop app is not running".to_string(),
        },
        AgentLaunchSurface::Available,
    );

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    let item = &items[0];

    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert!(!runnable.is_runnable());
    assert_eq!(runnable.code.as_deref(), Some("ORCA_NOT_RUNNING"));
}

#[tokio::test]
async fn test_orca_probe_error_or_indeterminate_is_unknown() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_orca_unknown",
                            "workspace_id": "ws_1",
                            "alias": "orca-unknown-proj",
                            "display_name": "Orca Unknown Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_orca_unknown".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(
        OrcaRuntimeReadiness::ProbeFailed {
            code: "PROBE_FAILED".to_string(),
            reason: "connection timeout".to_string(),
        },
        AgentLaunchSurface::Unknown,
    );

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    let item = &items[0];

    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::Unknown);
    assert!(!runnable.is_runnable());
    assert_eq!(runnable.code.as_deref(), Some("PROBE_FAILED"));

    let list_human = render_project_list(&items, false);
    assert!(list_human.contains("Config:     READY"));
    assert!(list_human.contains("Runnable:   unknown (PROBE_FAILED)"));
}

#[tokio::test]
async fn test_probe_reuse_no_n_times_per_project_regression() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let mut server_targets = Vec::new();
    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();

    for i in 1..=5 {
        let tid = format!("tgt_reuse_{i}");
        let repo_dir = _temp.path().join(format!("repo-{i}"));
        init_git_repo(
            &repo_dir,
            Some(&format!("https://github.com/org/repo-{i}.git")),
        );

        server_targets.push(serde_json::json!({
            "target": {
                "id": tid,
                "workspace_id": "ws_1",
                "alias": format!("reuse-proj-{i}"),
                "display_name": format!("Reuse Project {i}"),
                "kind": "ordinary",
                "repository": { "provider": "github", "external_id": format!("{i}"), "full_name": format!("org/repo-{i}") },
                "disabled": false,
                "is_default_agent_runtime": false
            },
            "this_device_binding": { "id": format!("bnd_{i}"), "enabled": true },
            "active_binding_count": 1
        }));

        cfg.targets.insert(
            format!("tgt_reuse_{i}"),
            LocalTarget {
                local_path: repo_dir.display().to_string(),
                executor: Some(
                    LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap(),
                ),
            },
        );
    }
    cfg.save(&paths.config_file()).unwrap();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(200, &serde_json::json!({ "targets": server_targets }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);

    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();
    assert_eq!(items.len(), 5);

    // Verify probe was called exactly ONCE despite 5 projects!
    assert_eq!(
        probe.readiness_probes.load(Ordering::SeqCst),
        1,
        "runtime readiness must be probed exactly once and reused across projects"
    );
    assert_eq!(
        probe.surface_probes.load(Ordering::SeqCst),
        1,
        "launch surface must be probed exactly once and reused across projects"
    );

    // All items evaluated as runnable
    for item in &items {
        assert_eq!(item.status, "READY");
        assert_eq!(
            item.runnable.as_ref().map(|r| r.status),
            Some(ProjectRunnableStatus::Runnable)
        );
    }
}

#[test]
fn test_human_list_show_clearly_distinguish_structural_from_runnable() {
    let item_ready_runnable = ProjectDisplayItem {
        target_id: "tgt_1".to_string(),
        name: "Project Ready Runnable".to_string(),
        alias: Some("ready-runnable".to_string()),
        kind: Some("ordinary".to_string()),
        local_path: Some("/path/1".to_string()),
        status: "READY".to_string(),
        disabled: false,
        is_default_agent_runtime: false,
        active_binding_count: 1,
        repository: Some("org/repo1".to_string()),
        agent_id: Some("antigravity".to_string()),
        model: None,
        runnable: Some(ceo_connector::execution_admission::ProjectRunnableAssessment::runnable()),
    };

    let item_ready_not_runnable = ProjectDisplayItem {
        target_id: "tgt_2".to_string(),
        name: "Project Ready Not Runnable".to_string(),
        alias: Some("ready-not-runnable".to_string()),
        kind: Some("ordinary".to_string()),
        local_path: Some("/path/2".to_string()),
        status: "READY".to_string(),
        disabled: false,
        is_default_agent_runtime: false,
        active_binding_count: 1,
        repository: Some("org/repo2".to_string()),
        agent_id: Some("antigravity".to_string()),
        model: None,
        runnable: Some(
            ceo_connector::execution_admission::ProjectRunnableAssessment::not_runnable(
                ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE,
                "installed Orca version does not expose the required orchestration Agent launch surface",
            ),
        ),
    };

    // 1. List rendering distinction
    let list_out = render_project_list(
        &[item_ready_runnable.clone(), item_ready_not_runnable.clone()],
        false,
    );
    // Config line is present and separate from Runnable
    assert!(list_out.contains("  Config:     READY\n  Runnable:   yes\n"));
    assert!(list_out.contains(&format!(
        "  Config:     READY\n  Runnable:   no ({ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE})\n"
    )));
    // Confirm Status: READY is NOT rendered alone
    assert!(!list_out.contains("  Status:     READY\n"));

    // 2. Show rendering distinction
    let show_runnable = render_project_show(&item_ready_runnable, false);
    assert!(show_runnable.contains("  Config:          READY\n"));
    assert!(show_runnable.contains("  Runnable:        yes\n"));

    let show_not_runnable = render_project_show(&item_ready_not_runnable, false);
    assert!(show_not_runnable.contains("  Config:          READY\n"));
    assert!(show_not_runnable.contains(&format!(
        "  Runnable:        no ({ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE})\n"
    )));
    assert!(show_not_runnable.contains("  Reason:          installed Orca version does not expose the required orchestration Agent launch surface\n"));
}

#[test]
fn test_json_preserves_prior_fields_and_adds_runnable_data() {
    let item = ProjectDisplayItem {
        target_id: "tgt_preserve_1".to_string(),
        name: "Preserve Test".to_string(),
        alias: Some("preserve-alias".to_string()),
        kind: Some("coding".to_string()),
        local_path: Some("/tmp/path".to_string()),
        status: "READY".to_string(),
        disabled: false,
        is_default_agent_runtime: true,
        active_binding_count: 2,
        repository: Some("org/repo-preserve".to_string()),
        agent_id: Some("cursor".to_string()),
        model: Some("claude-sonnet".to_string()),
        runnable: Some(
            ceo_connector::execution_admission::ProjectRunnableAssessment::not_runnable(
                "ORCA_NOT_RUNNING",
                "Orca desktop app is not running",
            ),
        ),
    };

    let json_val = serde_json::to_value(&item).unwrap();

    // Verify all pre-existing fields are preserved with their exact names and types
    assert_eq!(json_val["target_id"], "tgt_preserve_1");
    assert_eq!(json_val["name"], "Preserve Test");
    assert_eq!(json_val["alias"], "preserve-alias");
    assert_eq!(json_val["kind"], "coding");
    assert_eq!(json_val["local_path"], "/tmp/path");
    assert_eq!(json_val["status"], "READY");
    assert_eq!(json_val["disabled"], false);
    assert_eq!(json_val["is_default_agent_runtime"], true);
    assert_eq!(json_val["active_binding_count"], 2);
    assert_eq!(json_val["repository"], "org/repo-preserve");
    assert_eq!(json_val["agent_id"], "cursor");
    assert_eq!(json_val["model"], "claude-sonnet");

    // Verify additive runnable structure
    assert_eq!(json_val["runnable"]["status"], "not_runnable");
    assert_eq!(json_val["runnable"]["code"], "ORCA_NOT_RUNNING");
    assert_eq!(
        json_val["runnable"]["reason"],
        "Orca desktop app is not running"
    );

    // Backward-compatibility deserialization: older JSON without runnable must deserialize cleanly
    let mut old_json = json_val.clone();
    old_json.as_object_mut().unwrap().remove("runnable");
    let deserialized_old: ProjectDisplayItem = serde_json::from_value(old_json).unwrap();
    assert_eq!(deserialized_old.target_id, "tgt_preserve_1");
    assert_eq!(deserialized_old.status, "READY");
    assert_eq!(deserialized_old.runnable, None);
}

#[tokio::test]
async fn test_orca_status_missing_result_is_not_runnable_daemon_match() {
    use ceo_connector::execution_admission::evaluate_orca_status_response;
    use ceo_connector::orca::types::OrcaStatusResponse;

    // 1. Shared canonical helper proof: ok=true, result=None must not be Ready
    let raw_status = OrcaStatusResponse {
        ok: true,
        result: None,
    };
    let canonical_readiness = evaluate_orca_status_response(&raw_status);
    assert_eq!(
        canonical_readiness,
        OrcaRuntimeReadiness::NotReady {
            code: "ORCA_STATUS_MISSING_RESULT".to_string(),
            reason: "Orca status reported ok=true but result payload is missing".to_string(),
        }
    );
    assert!(!canonical_readiness.is_ready());

    // 2. Integration proof: project runnability with this status reports not_runnable
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_missing_res_1",
                            "workspace_id": "ws_1",
                            "alias": "missing-res-proj",
                            "display_name": "Missing Result Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_missing_res_1".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    let probe = CountingMockProbe::new(canonical_readiness, AgentLaunchSurface::Available);
    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();

    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::NotRunnable);
    assert_eq!(runnable.code.as_deref(), Some("ORCA_STATUS_MISSING_RESULT"));
    assert_eq!(
        runnable.reason.as_deref(),
        Some("Orca status reported ok=true but result payload is missing")
    );

    // Launch surface probe must NOT be called when runtime is not ready
    assert_eq!(probe.surface_probes.load(Ordering::SeqCst), 0);
    assert_eq!(probe.readiness_probes.load(Ordering::SeqCst), 1);

    // Human rendering
    let human_show = render_project_show(item, false);
    assert!(human_show.contains("  Config:          READY\n"));
    assert!(human_show.contains("  Runnable:        no (ORCA_STATUS_MISSING_RESULT)\n"));
    assert!(human_show.contains(
        "  Reason:          Orca status reported ok=true but result payload is missing\n"
    ));
}

#[tokio::test]
async fn test_explicit_command_only_project_set_skips_launch_surface_probe() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let temp_dir = tempfile::tempdir().unwrap();
    let agent_bin = temp_dir.path().join("my-agent");
    fs::write(&agent_bin, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&agent_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let mut server_targets = Vec::new();

    for i in 1..=3 {
        let tid = format!("tgt_cmd_only_{i}");
        let repo_dir = _temp.path().join(format!("cmd-repo-{i}"));
        init_git_repo(
            &repo_dir,
            Some(&format!("https://github.com/org/cmd-repo-{i}.git")),
        );

        server_targets.push(serde_json::json!({
            "target": {
                "id": tid,
                "workspace_id": "ws_1",
                "alias": format!("cmd-proj-{i}"),
                "display_name": format!("Cmd Project {i}"),
                "kind": "ordinary",
                "repository": { "provider": "github", "external_id": format!("{i}"), "full_name": format!("org/cmd-repo-{i}") },
                "disabled": false,
                "is_default_agent_runtime": false
            },
            "this_device_binding": { "id": format!("bnd_{i}"), "enabled": true },
            "active_binding_count": 1
        }));

        cfg.targets.insert(
            format!("tgt_cmd_only_{i}"),
            LocalTarget {
                local_path: repo_dir.display().to_string(),
                executor: Some(
                    LocalExecutorConfig::new("custom".into(), agent_bin.display().to_string())
                        .unwrap(),
                ),
            },
        );
    }
    cfg.save(&paths.config_file()).unwrap();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(200, &serde_json::json!({ "targets": server_targets }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);
    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();

    assert_eq!(items.len(), 3);
    for item in &items {
        assert_eq!(item.status, "READY");
        assert_eq!(
            item.runnable.as_ref().map(|r| r.status),
            Some(ProjectRunnableStatus::Runnable)
        );
    }

    // Readiness probed once
    assert_eq!(probe.readiness_probes.load(Ordering::SeqCst), 1);
    // Launch surface probe MUST BE SKIPPED (0 calls) for explicit-command-only project set!
    assert_eq!(
        probe.surface_probes.load(Ordering::SeqCst),
        0,
        "explicit command only project set must never invoke launch surface probe"
    );
}

#[tokio::test]
async fn test_mixed_projects_invoke_readiness_once_and_launch_surface_at_most_once() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let temp_dir = tempfile::tempdir().unwrap();
    let agent_bin = temp_dir.path().join("my-agent");
    fs::write(&agent_bin, b"#!/bin/sh\nexit 0\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&agent_bin, fs::Permissions::from_mode(0o755)).unwrap();
    }

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let mut server_targets = Vec::new();

    // 2 explicit command projects, 2 logical projects
    for i in 1..=4 {
        let tid = format!("tgt_mixed_{i}");
        let repo_dir = _temp.path().join(format!("mixed-repo-{i}"));
        init_git_repo(
            &repo_dir,
            Some(&format!("https://github.com/org/mixed-repo-{i}.git")),
        );

        server_targets.push(serde_json::json!({
            "target": {
                "id": tid,
                "workspace_id": "ws_1",
                "alias": format!("mixed-proj-{i}"),
                "display_name": format!("Mixed Project {i}"),
                "kind": "ordinary",
                "repository": { "provider": "github", "external_id": format!("{i}"), "full_name": format!("org/mixed-repo-{i}") },
                "disabled": false,
                "is_default_agent_runtime": false
            },
            "this_device_binding": { "id": format!("bnd_{i}"), "enabled": true },
            "active_binding_count": 1
        }));

        let exec = if i <= 2 {
            LocalExecutorConfig::new("custom".into(), agent_bin.display().to_string()).unwrap()
        } else {
            LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()
        };

        cfg.targets.insert(
            format!("tgt_mixed_{i}"),
            LocalTarget {
                local_path: repo_dir.display().to_string(),
                executor: Some(exec),
            },
        );
    }
    cfg.save(&paths.config_file()).unwrap();

    server.add_handler(move |req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(200, &serde_json::json!({ "targets": server_targets }));
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Available);
    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();

    assert_eq!(items.len(), 4);
    for item in &items {
        assert_eq!(item.status, "READY");
        assert_eq!(
            item.runnable.as_ref().map(|r| r.status),
            Some(ProjectRunnableStatus::Runnable)
        );
    }

    // Readiness probed once
    assert_eq!(probe.readiness_probes.load(Ordering::SeqCst), 1);
    // Launch surface probed AT MOST ONCE (exactly 1 time across all 4 mixed projects)
    assert_eq!(
        probe.surface_probes.load(Ordering::SeqCst),
        1,
        "mixed project set must probe launch surface at most once"
    );
}

#[tokio::test]
async fn test_logical_launch_probe_failure_renders_unknown_never_false_verdict() {
    let server = MockServer::start().await;
    let (_temp, paths) = setup_test_profile(&server.origin());

    let repo_dir = _temp.path().join("my-repo");
    init_git_repo(&repo_dir, Some("https://github.com/org/repo.git"));

    server.add_handler(|req| {
        if req.method == "GET" && req.path.contains("/api/connector/targets") {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_indeterminate_1",
                            "workspace_id": "ws_1",
                            "alias": "indeterminate-proj",
                            "display_name": "Indeterminate Project",
                            "kind": "ordinary",
                            "repository": { "provider": "github", "external_id": "123", "full_name": "org/repo" },
                            "disabled": false,
                            "is_default_agent_runtime": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let mut cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    cfg.targets.insert(
        "tgt_indeterminate_1".to_string(),
        LocalTarget {
            local_path: repo_dir.display().to_string(),
            executor: Some(LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap()),
        },
    );
    cfg.save(&paths.config_file()).unwrap();

    // Launch surface probe is Unknown (indeterminate probe failure)
    let probe = CountingMockProbe::new(OrcaRuntimeReadiness::Ready, AgentLaunchSurface::Unknown);
    let items = build_project_display_items_with_probe(&paths, Some(&probe))
        .await
        .unwrap();

    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.status, "READY");
    let runnable = item.runnable.as_ref().unwrap();
    assert_eq!(runnable.status, ProjectRunnableStatus::Unknown);
    assert!(!runnable.is_runnable());
    assert_eq!(runnable.code.as_deref(), Some("PROBE_FAILED"));

    // Verify human rendering displays 'unknown (PROBE_FAILED)', NOT 'no (ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE)'
    let human_show = render_project_show(item, false);
    assert!(human_show.contains("  Config:          READY\n"));
    assert!(human_show.contains("  Runnable:        unknown (PROBE_FAILED)\n"));
    assert!(!human_show.contains("no (ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE)"));

    let human_list = render_project_list(&items, false);
    assert!(human_list.contains("  Config:     READY\n  Runnable:   unknown (PROBE_FAILED)\n"));
    assert!(!human_list.contains("no (ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE)"));
}
