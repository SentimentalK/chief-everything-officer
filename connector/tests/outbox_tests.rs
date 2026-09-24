mod common;

use std::sync::Arc;

use ceo_connector::client::ConnectorClient;
use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::outbox::{deliver_outbox_record, OutboxError, OutboxRecord};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::UnavailableExecutionAdapter;
use common::mock_server::{MockResponse, MockServer};

#[tokio::test]
async fn outbox_device_mismatch_prevents_delivery() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let client = ConnectorClient::new("http://127.0.0.1:4000").unwrap();
    let cred = DeviceCredential::new(
        "http://127.0.0.1:4000".into(),
        "usr_1".into(),
        "dev_current".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();

    let record = OutboxRecord {
        schema_version: 1,
        server_origin: "http://127.0.0.1:4000".into(),
        device_id: "dev_other".into(), // MISMATCH
        job_id: "job_1".into(),
        attempt_id: "att_1".into(),
        claim_token: "tok_1".into(),
        report: serde_json::json!({ "execution_status": "success" }),
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_1", "att_1");
    record.save(&outbox_file).unwrap();

    let err = deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap_err();

    assert!(matches!(err, OutboxError::IdentityMismatch { .. }));
    assert!(outbox_file.exists()); // Record retained!
}

#[tokio::test]
async fn report_delivery_terminal_cleanup() {
    let server = MockServer::start().await;
    server.add_handler(|req| {
        if req.path == "/api/connector/jobs/job_10/report" && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "job_id": "job_10",
                    "attempt_id": "att_10",
                    "status": "terminal",
                    "terminal": true,
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
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let client = ConnectorClient::new(&server.origin()).unwrap();
    let cred = DeviceCredential::new(
        server.origin(),
        "usr_1".into(),
        "dev_1".into(),
        "dcr_1".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();

    let record = OutboxRecord {
        schema_version: 1,
        server_origin: server.origin(),
        device_id: "dev_1".into(),
        job_id: "job_10".into(),
        attempt_id: "att_10".into(),
        claim_token: "tok_10".into(),
        report: serde_json::json!({
            "execution_status": "success",
            "receipt_sha256": "abc123hash",
            "duration_ms": 1250
        }),
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_10", "att_10");
    record.save(&outbox_file).unwrap();

    // Plant active attempt
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_10",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att_10",
            "claim_token": "tok_10",
            "phase": "finalized_local",
            "terminal_report_sha256": "digest123"
        }),
    )
    .unwrap();

    deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap();

    // 1. Sanitized history record exists
    let hist_file = paths.history_file("job_10", "att_10");
    assert!(hist_file.exists());
    let hist_content = std::fs::read_to_string(&hist_file).unwrap();
    assert!(hist_content.contains("abc123hash"));
    assert!(!hist_content.contains("tok_10")); // No claim token!

    // 2. Outbox record removed
    assert!(!outbox_file.exists());

    // 3. Active attempt removed
    assert!(!paths.active_attempt_file().exists());
}

#[tokio::test]
async fn crash_recovery_after_outbox_unlink_clears_active_attempt() {
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

    let config = LocalConfig::new(server.origin()).unwrap();
    config.save(&paths.config_file()).unwrap();

    // Simulate crash state:
    // - history record was already written
    // - outbox record was already unlinked
    // - process crashed before active-attempt.json was unlinked
    let hist_file = paths.history_file("job_crashed", "att_crashed");
    atomic_write_json(
        &hist_file,
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_crashed",
            "attempt_id": "att_crashed",
            "target_id": "tgt_1",
            "status": "terminal",
            "recorded_at_ms": 1000
        }),
    )
    .unwrap();

    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_crashed",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att_crashed",
            "claim_token": "tok_crashed",
            "phase": "finalized_local"
        }),
    )
    .unwrap();

    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(1)).await.unwrap();

    // Startup recovery reconciled active attempt cleanup from history!
    assert!(!paths.active_attempt_file().exists());
}
