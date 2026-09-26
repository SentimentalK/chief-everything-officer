mod common;

use std::fs;
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
use ceo_connector::scheduler::{UnavailableExecutionAdapter, ACTIVE_ATTEMPT_SCHEMA_VERSION};
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
        managed_result: None,
        managed_result_sha256: None,
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
        attempt_id: "att-00000000-0000-0000-0000-000000000010".into(),
        claim_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        report,
        managed_result: None,
        managed_result_sha256: None,
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_10", "att-00000000-0000-0000-0000-000000000010");
    record.save(&outbox_file).unwrap();

    // Plant active attempt in finalized_local matching report digest
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_10",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-00000000-0000-0000-0000-000000000010",
            "claim_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "finalized_local",
            "terminal_report_sha256": report_sha256,
            "executor": null
        }),
    )
    .unwrap();

    deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap();

    // 1. Sanitized history record exists and has terminal_report_sha256
    let hist_file = paths.history_file("job_10", "att-00000000-0000-0000-0000-000000000010");
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
    let hist_file = paths.history_file("job_crashed", "att-00000000-0000-0000-0000-000000000099");
    atomic_write_json(
        &hist_file,
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_crashed",
            "attempt_id": "att-00000000-0000-0000-0000-000000000099",
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
            "schema_version": ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_crashed",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-00000000-0000-0000-0000-000000000099",
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "finalized_local",
            "terminal_report_sha256": digest,
            "executor": null
        }),
    )
    .unwrap();

    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(1)).await.unwrap();

    // Startup recovery reconciled active attempt cleanup from history because correlation was proven!
    assert!(!paths.active_attempt_file().exists());
}

#[tokio::test]
async fn crash_window_history_written_outbox_still_present_replays_safely() {
    let server = MockServer::start().await;
    let report_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let report_calls_clone = report_calls.clone();

    server.add_handler(move |req| {
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
        if req.path == "/api/connector/jobs/job_crash_win/report" && req.method == "POST" {
            report_calls_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            // Server responds with replayed = true
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": true,
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

    let report = sample_report();
    let report_sha256 = compute_report_sha256(&report);

    // 1. History already written
    let hist_file = paths.history_file("job_crash_win", "att-00000000-0000-0000-0000-000000000001");
    atomic_write_json(
        &hist_file,
        &serde_json::json!({
            "schema_version": 1,
            "job_id": "job_crash_win",
            "attempt_id": "att-00000000-0000-0000-0000-000000000001",
            "target_id": "tgt_1",
            "status": "completed",
            "receipt_sha256": report.receipt_sha256,
            "duration_ms": report.duration_ms,
            "terminal_report_sha256": report_sha256,
            "recorded_at_ms": 1000
        }),
    )
    .unwrap();

    // 2. Outbox still present (crash happened before unlinking outbox)
    let outbox_record = OutboxRecord {
        schema_version: 1,
        server_origin: server.origin(),
        device_id: "dev_1".into(),
        job_id: "job_crash_win".into(),
        attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        report: report.clone(),
        managed_result: None,
        managed_result_sha256: None,
        created_at_ms: 1000,
    };
    let outbox_file =
        paths.outbox_file("job_crash_win", "att-00000000-0000-0000-0000-000000000001");
    outbox_record.save(&outbox_file).unwrap();

    // 3. Active attempt still present in finalized_local
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_crash_win",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": "att-00000000-0000-0000-0000-000000000001",
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "finalized_local",
            "terminal_report_sha256": report_sha256,
            "executor": null
        }),
    )
    .unwrap();

    // Restart daemon
    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(1)).await.unwrap();

    // Assert:
    // Report was replayed safely to server
    assert_eq!(report_calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    // History remains valid and idempotent
    assert!(hist_file.exists());
    let hist_content = std::fs::read_to_string(&hist_file).unwrap();
    assert!(hist_content.contains(&report_sha256));
    // Outbox unlinked (no stranded outbox)
    assert!(!outbox_file.exists());
    // Active attempt unlinked
    assert!(!paths.active_attempt_file().exists());
}

#[test]
fn invalid_numeric_report_cannot_be_persisted_into_outbox() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let mut report = sample_report();
    report.duration_ms = -1;

    let record = OutboxRecord {
        schema_version: 1,
        server_origin: "http://127.0.0.1:4000".into(),
        device_id: "dev_1".into(),
        job_id: "job_inv".into(),
        attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        report,
        managed_result: None,
        managed_result_sha256: None,
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file("job_inv", "att-00000000-0000-0000-0000-000000000001");
    let err = record.save(&outbox_file).unwrap_err();
    assert!(matches!(err, OutboxError::InvalidReport(_)));
    assert!(!outbox_file.exists());

    // Also test > MAX_SAFE_INTEGER
    let mut report2 = sample_report();
    report2.finished_at_ms = ceo_connector::execution_contract::MAX_SAFE_INTEGER + 1;
    let record2 = OutboxRecord {
        schema_version: 1,
        server_origin: "http://127.0.0.1:4000".into(),
        device_id: "dev_1".into(),
        job_id: "job_inv2".into(),
        attempt_id: "att-00000000-0000-0000-0000-000000000001".into(),
        claim_token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        report: report2,
        managed_result: None,
        managed_result_sha256: None,
        created_at_ms: 1000,
    };
    let outbox_file2 = paths.outbox_file("job_inv2", "att-00000000-0000-0000-0000-000000000001");
    let err2 = record2.save(&outbox_file2).unwrap_err();
    assert!(matches!(err2, OutboxError::InvalidReport(_)));
    assert!(!outbox_file2.exists());
}

#[tokio::test]
async fn outbox_delivers_managed_result_before_report() {
    let server = MockServer::start().await;
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

    let attempt_id = "att-00000000-0000-0000-0000-000000000099";
    let job_id = "job_v18";
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let order_clone = order.clone();

    server.add_handler(move |req| {
        if req.path.contains("/result") && req.method == "POST" {
            order_clone.lock().unwrap().push("result");
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-26T12:00:00.000Z",
                    "resource_id": "res_1",
                    "commit": "abc123commit"
                }),
            );
        }
        if req.path.contains("/report") && req.method == "POST" {
            order_clone.lock().unwrap().push("report");
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-26T12:00:01.000Z",
                    "attempt": {
                        "attempt_id": attempt_id,
                        "phase": "finished",
                        "claimed_at": "2026-09-26T11:59:00.000Z",
                        "started_at": "2026-09-26T11:59:01.000Z"
                    }
                }),
            );
        }
        MockResponse::json(404, &serde_json::json!({ "error": "not found" }))
    });

    let report = sample_report();
    let report_sha256 = compute_report_sha256(&report);

    let managed_result = ceo_connector::managed_result::ManagedResultEnvelope {
        schema_version: 1,
        job_id: job_id.into(),
        attempt_id: attempt_id.into(),
        resource_id: "res_1".into(),
        summary: "Completed V1.8 job".into(),
        operations: vec![serde_json::json!({ "op": "replace_body", "content": "hello" })],
    };
    let payload_sha256 = managed_result.compute_canonical_sha256().unwrap();

    let record = OutboxRecord {
        schema_version: 1,
        server_origin: server.origin(),
        device_id: "dev_1".into(),
        job_id: job_id.into(),
        attempt_id: attempt_id.into(),
        claim_token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
        report,
        managed_result: Some(managed_result),
        managed_result_sha256: Some(payload_sha256),
        created_at_ms: 1000,
    };

    let outbox_file = paths.outbox_file(job_id, attempt_id);
    record.save(&outbox_file).unwrap();

    // Plant active attempt in finalized_local matching report digest
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": job_id,
            "attempt_id": attempt_id,
            "claim_token": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "phase": "finalized_local",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "resource_id": "res_1",
            "terminal_report_sha256": report_sha256
        }),
    )
    .unwrap();

    // Plant runtime directory
    let runtime_dir = paths.attempt_runtime_dir(attempt_id);
    fs::create_dir_all(&runtime_dir).unwrap();
    fs::write(runtime_dir.join("test.txt"), "temporary agent artifact").unwrap();

    deliver_outbox_record(&paths, &client, &cred, &outbox_file, &record)
        .await
        .unwrap();

    // Verify ordering: result strictly before report!
    let recorded_order = order.lock().unwrap().clone();
    assert_eq!(recorded_order, vec!["result", "report"]);

    // Verify outbox unlinked
    assert!(!outbox_file.exists());
    // Verify active attempt unlinked
    assert!(!paths.active_attempt_file().exists());
    // Verify runtime directory cleaned up
    assert!(!runtime_dir.exists());
}
