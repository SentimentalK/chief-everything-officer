mod common;

use ceo_connector::config::{LocalConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::enrollment::logout_flow;
use ceo_connector::local_state::{atomic_write_json, ExecutionLock};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::targets::{target_remove, TargetError};
use common::mock_server::{MockResponse, MockServer};

#[tokio::test]
async fn state_lock_prevents_target_remove_during_claim_intent() {
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

    let mut config = LocalConfig::new("http://127.0.0.1:4000".into()).unwrap();
    config.targets.insert(
        "tgt_race".into(),
        LocalTarget {
            workspace_id: "ws_1".into(),
            alias: "race-tgt".into(),
            kind: "general_automation".into(),
            local_path: temp.path().to_string_lossy().to_string(),
        },
    );
    config.save(&paths.config_file()).unwrap();

    // 1. Simulate daemon holding state.lock and persisting claim_intent
    let lock = ExecutionLock::acquire(&paths.state_lock_file()).unwrap();

    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "server_origin": "http://127.0.0.1:4000",
            "device_id": "dev_1",
            "job_id": "job_1",
            "workspace_id": "ws_1",
            "target_id": "tgt_race",
            "attempt_id": "att_1",
            "claim_token": "tok_1",
            "phase": "claim_intent"
        }),
    )
    .unwrap();

    drop(lock);

    // 2. Now CLI tries to remove tgt_race -> must be rejected with TargetInUse!
    let err = target_remove(&paths, "tgt_race").await.unwrap_err();
    assert!(matches!(err, TargetError::TargetInUse(t) if t == "tgt_race"));

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key("tgt_race"));
}

#[tokio::test]
async fn state_lock_prevents_claim_during_logout() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/device/revoke" && req.method == "POST" {
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
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

    // While state.lock is held by logout, no claim intent can be written
    let logout_paths = paths.clone();
    let logout_task = tokio::spawn(async move {
        logout_flow(&logout_paths).await.unwrap();
    });

    logout_task.await.unwrap();
    assert!(!paths.credential_file().exists());
}
