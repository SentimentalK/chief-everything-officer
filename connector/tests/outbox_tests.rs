mod common;

use std::sync::Arc;

use ceo_connector::client::ConnectorClient;
use ceo_connector::config::LocalConfig;
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::execution_contract::{
    BusinessOutcome, ExecutionReport, ExecutionReportExecutor, ExecutionStatus,
};
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::outbox::{
    compute_report_sha256, deliver_outbox_record, OutboxError, OutboxRecord,
};
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::UnavailableExecutionAdapter;
use common::mock_server::{MockResponse, MockServer};

fn sample_report() -> ExecutionReport {
    ExecutionReport {
        schema_version: 2,
        execution_status: ExecutionStatus::COMPLETED,
        business_outcome: BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1700000001000,
        duration_ms: 1000,
        executor: ExecutionReportExecutor {
            executor_type: "agent".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    }
}

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
        attempt_id: "att-1".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        report: sample_report(),
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_1", "att-1");
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
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z"
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

    let report = sample_report();
    let report_sha256 = compute_report_sha256(&report);

    let record = OutboxRecord {
        schema_version: 1,
        server_origin: server.origin(),
        device_id: "dev_1".into(),
        job_id: "job_10".into(),
        attempt_id: "att-10".into(),
        claim_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        report,
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_10", "att-10");
    record.save(&outbox_file).unwrap();

    // Plant active attempt in finalized_local matching report digest
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": 1,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_10",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-10",
            "claim_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "finalized_local",
            "terminal_report_sha256": report_sha256
        }),
    )
    .unwrap();

    deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap();

    // 1. Sanitized history record exists and has terminal_report_sha256
    let hist_file = paths.history_file("job_10", "att-10");
    assert!(hist_file.exists());
    let hist_content = std::fs::read_to_string(&hist_file).unwrap();
    assert!(hist_content.contains(&report_sha256));
    assert!(
        !hist_content.contains("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    ); // No claim token!

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

    let digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    // Simulate crash state:
    // - history record was already written with terminal_report_sha256
    // - outbox record was already unlinked
    // - process crashed before active-attempt.json was unlinked
    let hist_file = paths.history_file("job_crashed", "att-crashed");
    atomic_write_json(
        &hist_file,
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_crashed",
            "attempt_id": "att-crashed",
            "target_id": "tgt_1",
            "status": "completed",
            "receipt_sha256": digest,
            "duration_ms": 1000,
            "terminal_report_sha256": digest,
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
            "attempt_id": "att-crashed",
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "finalized_local",
            "terminal_report_sha256": digest
        }),
    )
    .unwrap();

    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(1)).await.unwrap();

    // Startup recovery reconciled active attempt cleanup from history because correlation was proven!
    assert!(!paths.active_attempt_file().exists());
}
