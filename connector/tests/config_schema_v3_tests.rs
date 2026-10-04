//! PROJECT-036 Slice 1B: Connector local-config authority cleanup + schema v3.
//!
//! Covers: schema v3 steady-state model (Device-owned fields only), the
//! one-time deterministic v2->v3 migration (atomicity, concurrency safety,
//! fail-closed semantics, idempotency, no Server dependency), strict
//! unknown-field policy, unknown future versions, and the merged
//! Server-authoritative display projection (including honest LOCAL_ONLY
//! rendering and clear failure when the Server catalogue is unavailable).

mod common;

use std::fs;

use ceo_connector::config::{
    ensure_config_schema_current, load_current_config, LocalConfig, LocalExecutorConfig,
    LocalTarget,
};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::local_state::ExecutionLock;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::targets::build_target_display_items;
use common::mock_server::{MockResponse, MockServer};

fn temp_paths() -> (tempfile::TempDir, ConnectorPaths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_root(temp.path().join("root"));
    paths.ensure_dirs().unwrap();
    (temp, paths)
}

fn write_file(path: &std::path::Path, contents: &str) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, contents).unwrap();
}

/// Representative schema v2 config: two targets, executor + model data, and
/// Server-owned metadata that must NOT survive the migration.
const V2_CONFIG: &str = r#"{
    "schema_version": 2,
    "server_url": "http://127.0.0.1:4000",
    "targets": {
        "tgt_alpha": {
            "workspace_id": "ws_1",
            "alias": "stale-alpha",
            "kind": "coding",
            "local_path": "/tmp/repo-alpha",
            "executor": {
                "kind": "orca_tui",
                "agent_id": "cursor",
                "command": "/path/agent -f --trust",
                "model": "gpt-5"
            }
        },
        "tgt_beta": {
            "workspace_id": "ws_2",
            "alias": "stale-beta",
            "kind": "general_automation",
            "local_path": "/tmp/repo-beta",
            "executor": {
                "kind": "orca_tui",
                "agent_id": "opencode",
                "command": "opencode"
            }
        }
    }
}"#;

// ---------------------------------------------------------------------------
// A. Schema / model
// ---------------------------------------------------------------------------

#[test]
fn fresh_config_serializes_schema_version_3() {
    let cfg = LocalConfig::new("https://ceo.example.com".into()).unwrap();
    let json: serde_json::Value = serde_json::to_value(&cfg).unwrap();
    assert_eq!(json["schema_version"], 3);
}

#[test]
fn v3_local_target_contains_only_device_owned_fields() {
    let target = LocalTarget {
        local_path: "/tmp/repo".into(),
        executor: Some(
            LocalExecutorConfig::new_with_model(
                "cursor".into(),
                "/path/agent -f --trust".into(),
                Some("gpt-5".into()),
            )
            .unwrap(),
        ),
    };
    let json: serde_json::Value = serde_json::to_value(&target).unwrap();
    let obj = json.as_object().unwrap();
    assert_eq!(obj.len(), 2, "only local_path + executor allowed");
    assert!(obj.contains_key("local_path"));
    assert!(obj.contains_key("executor"));
    assert!(obj.get("workspace_id").is_none());
    assert!(obj.get("alias").is_none());
    assert!(obj.get("kind").is_none());

    // Executor keeps its existing omit convention for an unset model.
    let exec_json: serde_json::Value = serde_json::to_value(
        LocalExecutorConfig::new("opencode".into(), "opencode".into()).unwrap(),
    )
    .unwrap();
    assert!(exec_json.get("model").is_none());
}

#[test]
fn v3_strictly_rejects_unknown_fields() {
    let bad = r#"{
        "schema_version": 3,
        "server_url": "http://127.0.0.1:4000",
        "targets": {
            "tgt_1": {
                "local_path": "/tmp/repo",
                "alias": "must_not_exist",
                "executor": null
            }
        }
    }"#;
    let res: Result<LocalConfig, _> = serde_json::from_str(bad);
    assert!(res.is_err(), "unknown fields on a v3 target must be denied");

    let bad_top = r#"{
        "schema_version": 3,
        "server_url": "http://127.0.0.1:4000",
        "targets": {},
        "migration_marker": "must_not_exist"
    }"#;
    let res: Result<LocalConfig, _> = serde_json::from_str(bad_top);
    assert!(res.is_err(), "unknown top-level fields must be denied");
}

#[test]
fn unknown_future_schema_version_fails_explicitly() {
    let (_temp, paths) = temp_paths();
    write_file(
        &paths.config_file(),
        r#"{
            "schema_version": 4,
            "server_url": "http://127.0.0.1:4000",
            "targets": {}
        }"#,
    );
    let err = ensure_config_schema_current(&paths).unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::config::ConfigError::UnsupportedSchemaVersion(4)
    ));
    // Fail closed: original file untouched.
    assert!(fs::read_to_string(paths.config_file())
        .unwrap()
        .contains("\"schema_version\": 4"));
}

// ---------------------------------------------------------------------------
// B. v2 -> v3 migration
// ---------------------------------------------------------------------------

#[test]
fn realistic_v2_config_migrates_atomically_to_v3() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);

    // No credential file, no server running: migration is purely local and
    // performs no Server Target mutation by construction.
    assert!(!paths.credential_file().exists());
    ensure_config_schema_current(&paths).unwrap();

    // On-disk file is schema v3.
    let on_disk = fs::read_to_string(paths.config_file()).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&on_disk).unwrap();
    assert_eq!(parsed["schema_version"], 3);

    // target_id map keys preserved exactly.
    let targets = parsed["targets"].as_object().unwrap();
    assert_eq!(targets.len(), 2);
    assert!(targets.contains_key("tgt_alpha"));
    assert!(targets.contains_key("tgt_beta"));

    // local_path preserved exactly.
    assert_eq!(
        parsed["targets"]["tgt_alpha"]["local_path"],
        "/tmp/repo-alpha"
    );
    assert_eq!(
        parsed["targets"]["tgt_beta"]["local_path"],
        "/tmp/repo-beta"
    );

    // Executor agent_id/command/model preserved exactly.
    let alpha_exec = &parsed["targets"]["tgt_alpha"]["executor"];
    assert_eq!(alpha_exec["agent_id"], "cursor");
    assert_eq!(alpha_exec["command"], "/path/agent -f --trust");
    assert_eq!(alpha_exec["model"], "gpt-5");
    let beta_exec = &parsed["targets"]["tgt_beta"]["executor"];
    assert_eq!(beta_exec["agent_id"], "opencode");
    assert_eq!(beta_exec["command"], "opencode");
    assert!(
        beta_exec.get("model").is_none(),
        "unset model stays omitted"
    );

    // Server-owned metadata dropped from the rewritten file.
    let dumped = serde_json::to_string(&parsed).unwrap();
    assert!(!dumped.contains("workspace_id"));
    assert!(!dumped.contains("stale-alpha"));
    assert!(!dumped.contains("stale-beta"));
    assert!(!dumped.contains("\"kind\": \"coding\""));
    assert!(!dumped.contains("\"kind\": \"general_automation\""));

    // No migration markers/progress state persisted.
    assert_eq!(parsed.as_object().unwrap().len(), 3);
    assert!(parsed.get("migration").is_none());

    // No temp siblings left behind.
    let leftovers: Vec<_> = fs::read_dir(paths.root_dir.clone())
        .unwrap()
        .filter_map(|e| {
            e.unwrap()
                .file_name()
                .to_string_lossy()
                .contains(".tmp")
                .then_some(())
        })
        .collect();
    assert!(leftovers.is_empty());
}

#[test]
fn repeated_load_after_migration_is_idempotent_v3() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);
    ensure_config_schema_current(&paths).unwrap();
    let after_first = fs::read_to_string(paths.config_file()).unwrap();

    // Steady state: repeated ensure calls do not rewrite legacy content.
    ensure_config_schema_current(&paths).unwrap();
    ensure_config_schema_current(&paths).unwrap();
    let after_more = fs::read_to_string(paths.config_file()).unwrap();
    assert_eq!(after_first, after_more, "migration must be one-shot");

    // load_current_config parses the v3 file idempotently.
    let cfg = load_current_config(&paths).unwrap().unwrap();
    assert_eq!(cfg.schema_version, 3);
    assert_eq!(cfg.targets.len(), 2);
}

#[test]
fn malformed_device_owned_state_fails_closed_and_preserves_original() {
    let (_temp, paths) = temp_paths();
    // Malformed Device-owned executor kind: v3 still needs a valid executor.
    write_file(
        &paths.config_file(),
        r#"{
            "schema_version": 2,
            "server_url": "http://127.0.0.1:4000",
            "targets": {
                "tgt_1": {
                    "workspace_id": "ws_1",
                    "alias": "stale",
                    "kind": "coding",
                    "local_path": "/tmp/repo",
                    "executor": {
                        "kind": "unsupported_kind",
                        "agent_id": "agy",
                        "command": "agy"
                    }
                }
            }
        }"#,
    );
    let original = fs::read_to_string(paths.config_file()).unwrap();

    let err = ensure_config_schema_current(&paths).unwrap_err();
    assert!(
        err.to_string().contains("unsupported executor kind"),
        "fail closed with an actionable error, got: {err}"
    );

    // The original valid v2 file is intact — no partial truncation/corruption.
    assert_eq!(fs::read_to_string(paths.config_file()).unwrap(), original);
}

#[test]
fn migration_lock_busy_fails_closed_and_preserves_original() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);
    let original = fs::read_to_string(paths.config_file()).unwrap();

    // Another process holds the state lock (concurrent mutation/migration).
    let lock = ExecutionLock::acquire(&paths.state_lock_file()).unwrap();

    let err = ensure_config_schema_current(&paths).unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::config::ConfigError::MigrationLockBusy
    ));

    // Original v2 file intact; no stale migrated snapshot was written.
    assert_eq!(fs::read_to_string(paths.config_file()).unwrap(), original);

    drop(lock);

    // After the concurrent holder releases the lock, migration succeeds.
    ensure_config_schema_current(&paths).unwrap();
    let parsed: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(paths.config_file()).unwrap()).unwrap();
    assert_eq!(parsed["schema_version"], 3);
}

#[test]
fn migration_never_clobbers_a_concurrent_newer_v3_mutation() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);

    // Deterministic interleaving proof: by the time migration re-reads the
    // file under the state lock, a concurrent process has already migrated
    // and applied a NEWER local mutation (different executor command).
    // The re-read must detect v3 and be a no-op, preserving the newer state.
    let mut newer = LocalConfig::new("http://127.0.0.1:4000".into()).unwrap();
    newer.targets.insert(
        "tgt_alpha".into(),
        LocalTarget {
            local_path: "/tmp/repo-alpha".into(),
            executor: Some(
                LocalExecutorConfig::new("cursor".into(), "/newer/command".into()).unwrap(),
            ),
        },
    );
    newer.save(&paths.config_file()).unwrap();
    let newer_on_disk = fs::read_to_string(paths.config_file()).unwrap();

    ensure_config_schema_current(&paths).unwrap();

    assert_eq!(
        fs::read_to_string(paths.config_file()).unwrap(),
        newer_on_disk,
        "stale migrated snapshot must not overwrite newer local config"
    );
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert_eq!(
        cfg.targets["tgt_alpha"]
            .executor
            .as_ref()
            .unwrap()
            .command
            .as_deref(),
        Some("/newer/command")
    );
}

#[test]
fn strict_load_rejects_legacy_files_with_actionable_error() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);

    // Steady-state parser must never silently consume legacy formats.
    let err = LocalConfig::load(&paths.config_file()).unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::config::ConfigError::LegacySchemaRequiresMigration(2)
    ));
    assert!(err.to_string().contains("migration"));
}

#[test]
fn save_rejects_legacy_schema_versions_explicitly() {
    let (_temp, paths) = temp_paths();
    let legacy = LocalConfig {
        schema_version: 2,
        server_url: "http://127.0.0.1:4000".into(),
        targets: std::collections::BTreeMap::new(),
    };
    let err = legacy.save(&paths.config_file()).unwrap_err();
    assert!(matches!(
        err,
        ceo_connector::config::ConfigError::LegacyWriteRejected(2)
    ));
    assert!(!paths.config_file().exists(), "nothing may be written");
}

// ---------------------------------------------------------------------------
// C. Authority behavior
// ---------------------------------------------------------------------------

#[test]
fn stale_v2_alias_is_never_used_after_migration() {
    let (_temp, paths) = temp_paths();
    write_file(&paths.config_file(), V2_CONFIG);
    ensure_config_schema_current(&paths).unwrap();

    // The migrated local config carries no alias at all.
    let cfg = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    for target in cfg.targets.values() {
        let json: serde_json::Value = serde_json::to_value(target).unwrap();
        assert!(json.get("alias").is_none());
        assert!(json.get("workspace_id").is_none());
        assert!(json.get("kind").is_none());
    }
    // Server alias authority for selectors is proven in
    // target_selector_tests (local config stores no alias to resolve).
}

#[tokio::test]
async fn target_list_fails_clearly_when_server_unavailable() {
    // Logged-in device whose configured server is unreachable.
    let server = MockServer::start().await; // no handlers -> request fails
    let (_temp, paths) = temp_paths();
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
        "tgt_alpha".into(),
        LocalTarget {
            local_path: "/tmp/repo-alpha".into(),
            executor: Some(LocalExecutorConfig::new("cursor".into(), "agent".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    // Must fail clearly instead of silently rendering a fabricated
    // (alias-less/empty) Target view from local state.
    let err = build_target_display_items(&paths).await.unwrap_err();
    assert!(
        matches!(err, ceo_connector::targets::TargetError::Client(_)),
        "server-unavailable must surface a clear client error, got: {err}"
    );
}

#[tokio::test]
async fn successful_catalogue_sync_prunes_stale_local_mapping_project039() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            // Catalogue does NOT contain the locally mapped target: its
            // Workspace-level Project was deleted on the Server.
            return MockResponse::json(200, &serde_json::json!({ "targets": [] }));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = temp_paths();
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

    let repo_dir = std::env::temp_dir().join(format!("ceo_v3_stale_prune_{}", std::process::id()));
    fs::create_dir_all(&repo_dir).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_stale_deleted".into(),
        LocalTarget {
            local_path: repo_dir.to_string_lossy().to_string(),
            executor: Some(
                LocalExecutorConfig::new_with_model(
                    "cursor".into(),
                    "/path/agent -f --trust".into(),
                    Some("gpt-5".into()),
                )
                .unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    // The successful authoritative catalogue sync prunes the stale mapping
    // instead of rendering a permanent ghost.
    let items = build_target_display_items(&paths).await.unwrap();
    assert!(items.is_empty(), "stale mapping must not render: {items:?}");

    let cfg_after = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(
        !cfg_after.targets.contains_key("tgt_stale_deleted"),
        "stale local mapping must be pruned by successful sync"
    );
}

#[tokio::test]
async fn catalogue_failure_never_prunes_local_mappings() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(500, &serde_json::json!({ "error": "boom" }));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = temp_paths();
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
        "tgt_keep_me".into(),
        LocalTarget {
            local_path: "/tmp/anywhere".to_string(),
            executor: None,
        },
    );
    config.save(&paths.config_file()).unwrap();

    // Catalogue unreachable: the projection fails clearly and pruning never
    // runs (offline direct-ID behavior preserved).
    let res = build_target_display_items(&paths).await;
    assert!(res.is_err());

    let cfg_after = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(
        cfg_after.targets.contains_key("tgt_keep_me"),
        "catalogue failure must never prune local mappings"
    );
}
