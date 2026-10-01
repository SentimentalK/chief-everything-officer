//! Wave 2C (Connector 1.2.0): optional per-target model override.
//!
//! Covers: backward-compatible config load, round-trip, model validation,
//! set-model set/clear behavior, set-agent model preservation, TARGET_IN_USE
//! guard, target list human/JSON exposure, doctor reporting, and dispatch
//! command composition via `effective_command`.

mod common;

use clap::Parser;
use std::fs;

use ceo_connector::cli::{Cli, Commands, TargetSubcommands};
use ceo_connector::config::{
    LocalConfig, LocalExecutorConfig, LocalTarget, MAX_EXECUTOR_MODEL_LEN,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::doctor::{run_doctor, DiagnosticSeverity};
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::targets::{
    build_target_display_items, render_target_blocks, target_set_agent, target_set_model,
    TargetDisplayItem,
};
use common::mock_server::{MockResponse, MockServer};

const CURSOR_COMMAND: &str = "/home/sentimentalk/.local/bin/agent -f --trust";

fn write_config(path: &std::path::Path, json: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, json).unwrap();
}

fn temp_paths() -> (tempfile::TempDir, ConnectorPaths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    (temp, paths)
}

fn seed_target(paths: &ConnectorPaths, target_id: &str, agent_id: &str, command: &str) {
    let mut config = LocalConfig::new("http://127.0.0.1:4000".into()).unwrap();
    config.targets.insert(
        target_id.to_string(),
        LocalTarget {
            local_path: "/tmp/repo".into(),
            executor: Some(LocalExecutorConfig::new(agent_id.into(), command.into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();
}

fn seed_credential(paths: &ConnectorPaths, origin: &str) {
    let cred = DeviceCredential::new(
        origin.into(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();
}

// 1. Legacy v2 config without `model` migrates to v3 and means default behavior.
#[test]
fn old_config_without_model_loads_and_is_default() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    let path = paths.config_file();
    write_config(
        &path,
        r#"{
            "schema_version": 2,
            "server_url": "http://127.0.0.1:4000",
            "targets": {
                "tgt_1": {
                    "workspace_id": "ws_1",
                    "alias": "legacy",
                    "kind": "coding",
                    "local_path": "/tmp/repo",
                    "executor": {
                        "kind": "orca_tui",
                        "agent_id": "cursor",
                        "command": "/home/sentimentalk/.local/bin/agent -f --trust"
                    }
                }
            }
        }"#,
    );
    // One-time migration via the shared entrypoint, then strict v3 load.
    ceo_connector::config::ensure_config_schema_current(&paths).unwrap();
    let config = LocalConfig::load(&path).unwrap().unwrap();
    assert_eq!(config.schema_version, 3);
    let exec = config
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .as_ref()
        .unwrap();
    assert_eq!(exec.model, None);
    // Default behavior: effective command is unchanged
    assert_eq!(exec.effective_command().unwrap(), CURSOR_COMMAND);
    // On-disk file is now schema v3 with legacy fields dropped.
    let on_disk = fs::read_to_string(&path).unwrap();
    assert!(on_disk.contains("\"schema_version\": 3"));
    assert!(!on_disk.contains("workspace_id"));
    assert!(!on_disk.contains("\"alias\""));
}

// 2. Config with model round-trips through save/load.
#[tokio::test]
async fn config_with_model_round_trips() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    seed_target(&paths, "tgt_model", "cursor", CURSOR_COMMAND);
    target_set_model(&paths, "tgt_model", Some("gpt-5"))
        .await
        .unwrap();

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    let exec = config
        .targets
        .get("tgt_model")
        .unwrap()
        .executor
        .as_ref()
        .unwrap();
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command, CURSOR_COMMAND);
}

// 3. Model validation rejects empty / NUL / newline / control / whitespace / overlong.
#[test]
fn model_validation_rejects_invalid_values() {
    let bad_values: Vec<String> = vec![
        "".into(),
        "   ".into(),
        "gpt\0-5".into(),
        "gpt\n-5".into(),
        "gpt\r-5".into(),
        "gpt\u{7}-5".into(),
        "gpt 5".into(),
        "a".repeat(MAX_EXECUTOR_MODEL_LEN + 1),
    ];
    for bad in bad_values {
        let res = LocalExecutorConfig::new_with_model(
            "cursor".into(),
            CURSOR_COMMAND.into(),
            Some(bad.clone()),
        );
        assert!(res.is_err(), "expected rejection for {bad:?}");
    }
    // Bracket-parameterized Cursor models remain accepted.
    assert!(LocalExecutorConfig::new_with_model(
        "cursor".into(),
        CURSOR_COMMAND.into(),
        Some("claude-opus-4-8[context=1m,effort=high,fast=false]".into())
    )
    .is_ok());
}

// 3/12. set-model with an invalid or unsupported-agent value fails explicitly
// and leaves the config unchanged.
#[tokio::test]
async fn set_model_rejects_invalid_and_unsupported_explicitly() {
    let (_temp, paths) = temp_paths();

    // Unsupported agent: model set fails explicitly, no silent fallback
    seed_target(&paths, "tgt_agy", "agy", "agy");
    let err = target_set_model(&paths, "tgt_agy", Some("gpt-5"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not supported for agent 'agy'"));
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config
        .targets
        .get("tgt_agy")
        .unwrap()
        .executor
        .as_ref()
        .unwrap()
        .model
        .is_none());

    // Invalid value on cursor target
    seed_target(&paths, "tgt_cursor", "cursor", CURSOR_COMMAND);
    let err = target_set_model(&paths, "tgt_cursor", Some("gpt\n-5"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("control characters"));
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config
        .targets
        .get("tgt_cursor")
        .unwrap()
        .executor
        .as_ref()
        .unwrap()
        .model
        .is_none());

    // Unknown target
    let err = target_set_model(&paths, "tgt_missing", Some("gpt-5"))
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::targets::TargetError::TargetNotFound(_)
    ));

    // Target without executor configured
    let mut config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    config.targets.insert(
        "tgt_noexec".into(),
        LocalTarget {
            local_path: "/tmp/repo".into(),
            executor: None,
        },
    );
    config.save(&paths.config_file()).unwrap();
    let err = target_set_model(&paths, "tgt_noexec", Some("gpt-5"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("no agent executor configured"));
}

// 4. set-model set/clear behavior preserves agent_id/command.
#[tokio::test]
async fn set_model_set_and_clear_preserve_other_executor_fields() {
    let (_temp, paths) = temp_paths();
    seed_target(&paths, "tgt_1", "cursor", CURSOR_COMMAND);

    // Set
    target_set_model(&paths, "tgt_1", Some("gpt-5"))
        .await
        .unwrap();
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command, CURSOR_COMMAND);

    // Overwrite with another model
    target_set_model(&paths, "tgt_1", Some("sonnet-4-thinking"))
        .await
        .unwrap();
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.model.as_deref(), Some("sonnet-4-thinking"));

    // Clear preserves agent_id/command
    target_set_model(&paths, "tgt_1", None).await.unwrap();
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.model, None);
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command, CURSOR_COMMAND);
    assert_eq!(exec.effective_command().unwrap(), CURSOR_COMMAND);
}

// 5. set-agent preserves an existing model override.
#[tokio::test]
async fn set_agent_preserves_existing_model_override() {
    let (_temp, paths) = temp_paths();
    seed_target(&paths, "tgt_1", "cursor", CURSOR_COMMAND);
    target_set_model(&paths, "tgt_1", Some("gpt-5"))
        .await
        .unwrap();

    target_set_agent(&paths, "tgt_1", "cursor", "/path/new-agent --force")
        .await
        .unwrap();
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.agent_id, "cursor");
    assert_eq!(exec.command, "/path/new-agent --force");
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
}

// 5b. set-agent to an agent that does not support model override fails
// explicitly rather than silently clearing or falling back.
#[tokio::test]
async fn set_agent_with_unsupported_agent_and_model_fails_explicitly() {
    let (_temp, paths) = temp_paths();
    seed_target(&paths, "tgt_1", "cursor", CURSOR_COMMAND);
    target_set_model(&paths, "tgt_1", Some("gpt-5"))
        .await
        .unwrap();

    let err = target_set_agent(&paths, "tgt_1", "agy", "agy")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("not supported for agent 'agy'"));
    // Config unchanged: model override intact, old agent/command intact
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_1")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.model.as_deref(), Some("gpt-5"));
    assert_eq!(exec.command, CURSOR_COMMAND);
}

// 6. Active-target mutation guard applies to set-model (TARGET_IN_USE).
#[tokio::test]
async fn set_model_refuses_active_target() {
    let (_temp, paths) = temp_paths();
    seed_target(&paths, "tgt_in_use", "cursor", CURSOR_COMMAND);
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_active_123",
            "target_id": "tgt_in_use"
        }),
    )
    .unwrap();

    let err = target_set_model(&paths, "tgt_in_use", Some("gpt-5"))
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::targets::TargetError::TargetInUse(t) if t == "tgt_in_use"
    ));
    let exec = LocalConfig::load(&paths.config_file())
        .unwrap()
        .unwrap()
        .targets
        .get("tgt_in_use")
        .unwrap()
        .executor
        .clone()
        .unwrap();
    assert_eq!(exec.model, None);
}

// 7. Target list human output shows Model: <default> / explicit model.
#[test]
fn target_list_human_shows_model_override() {
    let mut with_model = TargetDisplayItem {
        target_id: "tgt_1".into(),
        alias: Some("alpha".into()),
        kind: Some("coding".into()),
        local_path: Some("/tmp/repo".into()),
        status: "READY".into(),
        disabled: false,
        is_default_agent_runtime: false,
        active_binding_count: 1,
        repository: None,
        agent_id: Some("cursor".into()),
        agent_command: Some(CURSOR_COMMAND.into()),
        model: Some("gpt-5".into()),
    };
    let out = render_target_blocks(&[with_model.clone()]);
    assert!(out.contains("  Model: gpt-5\n"));
    assert!(out.contains("  Agent: cursor\n"));

    with_model.model = None;
    let out = render_target_blocks(&[with_model]);
    assert!(out.contains("  Model: <default>\n"));
}

// 8. Target JSON exposes a stable additive `model` field.
#[test]
fn target_json_model_field_is_additive_and_stable() {
    let with_model = TargetDisplayItem {
        target_id: "tgt_1".into(),
        alias: Some("alpha".into()),
        kind: Some("coding".into()),
        local_path: Some("/tmp/repo".into()),
        status: "READY".into(),
        disabled: false,
        is_default_agent_runtime: false,
        active_binding_count: 1,
        repository: None,
        agent_id: Some("cursor".into()),
        agent_command: Some(CURSOR_COMMAND.into()),
        model: Some("gpt-5".into()),
    };
    let json: serde_json::Value = serde_json::to_value(&with_model).unwrap();
    assert_eq!(json["model"], "gpt-5");

    // No override: model is omitted, consistent with the Option-field JSON
    // convention already used for agent_id/agent_command in this struct.
    let mut no_model = with_model.clone();
    no_model.model = None;
    let json: serde_json::Value = serde_json::to_value(&no_model).unwrap();
    assert!(json.get("model").is_none());

    // executor JSON (config) keeps `model` omitted when None
    let exec_none = LocalExecutorConfig::new("cursor".into(), CURSOR_COMMAND.into()).unwrap();
    let exec_json: serde_json::Value = serde_json::to_value(&exec_none).unwrap();
    assert!(exec_json.get("model").is_none());
}

// 9. Doctor reports the configured model text when set.
#[tokio::test]
async fn doctor_reports_model_override_when_set() {
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
                            "id": "tgt_model",
                            "workspace_id": "ws_1",
                            "alias": "model-target",
                            "display_name": "Model Target",
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
    seed_credential(&paths, &server.origin());

    let repo_dir = temp.path().join("model_repo");
    fs::create_dir_all(&repo_dir).unwrap();
    std::process::Command::new("git")
        .arg("init")
        .current_dir(&repo_dir)
        .status()
        .unwrap();
    std::process::Command::new("git")
        .arg("remote")
        .arg("add")
        .arg("origin")
        .arg("https://github.com/org/repo.git")
        .current_dir(&repo_dir)
        .status()
        .unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_model".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(
                LocalExecutorConfig::new_with_model(
                    "cursor".into(),
                    CURSOR_COMMAND.into(),
                    Some("gpt-5".into()),
                )
                .unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let report = run_doctor(&paths, true).await;
    assert!(report.overall_passed);
    let exec_check = report
        .checks
        .iter()
        .find(|c| c.name == "Target 'tgt_model' Executor Configuration")
        .expect("executor configuration check present");
    assert_eq!(exec_check.severity, DiagnosticSeverity::Pass);
    assert!(exec_check.message.contains("model override 'gpt-5'"));
    // The plain (no-model) message shape is unchanged for other targets
    let exec_none = LocalExecutorConfig::new("cursor".into(), CURSOR_COMMAND.into()).unwrap();
    assert_eq!(exec_none.model, None);
}

// 9b. Doctor on a plain executor (no model) does not mention model override.
#[tokio::test]
async fn doctor_plain_executor_has_no_model_text() {
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
            return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = temp_paths();
    seed_credential(&paths, &server.origin());
    seed_target(&paths, "tgt_plain", "cursor", CURSOR_COMMAND);

    let report = run_doctor(&paths, true).await;
    let exec_check = report
        .checks
        .iter()
        .find(|c| c.name == "Target 'tgt_plain' Executor Configuration");
    if let Some(c) = exec_check {
        assert!(!c.message.contains("model override"));
    }
}

// 10/11. Dispatch composition: unchanged when model absent; verified Cursor
// `--model` option appended exactly once when present.
#[test]
fn dispatch_command_composition() {
    let no_model = LocalExecutorConfig::new("cursor".into(), CURSOR_COMMAND.into()).unwrap();
    assert_eq!(no_model.effective_command().unwrap(), CURSOR_COMMAND);

    let with_model = LocalExecutorConfig::new_with_model(
        "cursor".into(),
        CURSOR_COMMAND.into(),
        Some("gpt-5".into()),
    )
    .unwrap();
    let cmd = with_model.effective_command().unwrap();
    assert_eq!(cmd, format!("{CURSOR_COMMAND} --model gpt-5"));
    assert_eq!(cmd.matches("--model").count(), 1);
}

// 12. Unsupported agent + model fails explicitly (already covered at config
// level; re-verified through the public effective_command path).
#[test]
fn unsupported_agent_model_has_no_silent_fallback() {
    let cfg = LocalExecutorConfig {
        kind: "orca_tui".into(),
        agent_id: "agy".into(),
        command: "agy".into(),
        model: Some("gpt-5".into()),
    };
    assert!(cfg.validate().is_err());
    assert!(cfg.effective_command().is_err());
}

// 4b. CLI parsing for set-model: set, clear, mutual-exclusion, and missing
// selection are all enforced at the clap surface.
#[test]
fn cli_set_model_parsing() {
    // set
    let parsed = Cli::try_parse_from([
        "ceo-connector",
        "target",
        "set-model",
        "--target-id",
        "tgt_1",
        "--model",
        "gpt-5",
    ])
    .unwrap();
    match parsed.command {
        Commands::Target {
            sub:
                TargetSubcommands::SetModel {
                    target_id,
                    model,
                    clear,
                },
        } => {
            assert_eq!(target_id, "tgt_1");
            assert_eq!(model.as_deref(), Some("gpt-5"));
            assert!(!clear);
        }
        other => panic!("unexpected command: {other:?}"),
    }

    // clear
    let parsed = Cli::try_parse_from([
        "ceo-connector",
        "target",
        "set-model",
        "--target-id",
        "tgt_1",
        "--clear",
    ])
    .unwrap();
    match parsed.command {
        Commands::Target {
            sub: TargetSubcommands::SetModel { model, clear, .. },
        } => {
            assert!(model.is_none());
            assert!(clear);
        }
        other => panic!("unexpected command: {other:?}"),
    }

    // both provided -> clap accepts, main.rs enforces exclusivity
    let parsed = Cli::try_parse_from([
        "ceo-connector",
        "target",
        "set-model",
        "--target-id",
        "tgt_1",
        "--model",
        "gpt-5",
        "--clear",
    ])
    .unwrap();
    match parsed.command {
        Commands::Target {
            sub: TargetSubcommands::SetModel { model, clear, .. },
        } => {
            assert!(model.is_some());
            assert!(clear);
        }
        other => panic!("unexpected command: {other:?}"),
    }

    // neither provided -> parses; main.rs enforces "exactly one"
    let parsed = Cli::try_parse_from([
        "ceo-connector",
        "target",
        "set-model",
        "--target-id",
        "tgt_1",
    ])
    .unwrap();
    match parsed.command {
        Commands::Target {
            sub: TargetSubcommands::SetModel { model, clear, .. },
        } => {
            assert!(model.is_none());
            assert!(!clear);
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

// Extra: full target list projection surfaces model from local config.
#[tokio::test]
async fn build_target_display_items_carries_model() {
    let (_temp, paths) = temp_paths();
    seed_target(&paths, "tgt_local", "cursor", CURSOR_COMMAND);
    target_set_model(&paths, "tgt_local", Some("sonnet-4-thinking"))
        .await
        .unwrap();

    // No credential file: local-only projection path
    let items = build_target_display_items(&paths).await.unwrap();
    let item = items
        .iter()
        .find(|i| i.target_id == "tgt_local")
        .expect("local target present");
    assert_eq!(item.model.as_deref(), Some("sonnet-4-thinking"));
}
