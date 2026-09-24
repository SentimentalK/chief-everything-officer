mod common;

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::config::{LocalConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{ActiveAttempt, FakeExecutionAdapter, UnavailableExecutionAdapter};
use common::mock_server::{MockResponse, MockServer};

#[tokio::test]
async fn v1_6_observe_only_acceptance_pending_observed_zero_claims() {
    let server = MockServer::start().await;
    let pending_calls = Arc::new(AtomicUsize::new(0));
    let claim_calls = Arc::new(AtomicUsize::new(0));

    let pending_calls_clone = pending_calls.clone();
    let claim_calls_clone = claim_calls.clone();

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

        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_1",
                            "workspace_id": "ws_1",
                            "alias": "dev-target",
                            "display_name": "Dev Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": {
                            "id": "bnd_1",
                            "enabled": true
                        },
                        "active_binding_count": 1
                    }]
                }),
            );
        }

        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            pending_calls_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "jobs": [{
                        "job_id": "job_pending_100",
                        "workspace_id": "ws_1",
                        "target_id": "tgt_1",
                        "resource_id": null,
                        "created_at": "2026-09-24T12:00:00.000Z",
                        "expires_at": null
                    }]
                }),
            );
        }

        if req.path.contains("/claim") && req.method == "POST" {
            claim_calls_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": "att-1",
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": "job_pending_100",
                        "workspace_id": "ws_1",
                        "target_id": "tgt_1",
                        "resource_id": null,
                        "prompt": "Test prompt",
                        "acceptance": "Test acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            workspace_id: "ws_1".into(),
            alias: "dev-target".into(),
            kind: "general_automation".into(),
            local_path: target_dir.to_string_lossy().to_string(),
        },
    );
    config.save(&paths.config_file()).unwrap();

    // Run daemon for 2 iterations using production UnavailableExecutionAdapter (is_ready = false)
    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(2)).await.unwrap();

    // Verify: pending jobs queried >= 1, but claim count is STRICTLY 0!
    assert!(pending_calls.load(Ordering::SeqCst) >= 1);
    assert_eq!(claim_calls.load(Ordering::SeqCst), 0);
    assert!(!paths.active_attempt_file().exists());
}

#[tokio::test]
async fn claim_intent_persisted_before_network_and_lost_response_replayed() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claim_tokens_seen = Arc::new(std::sync::Mutex::new(Vec::new()));

    let claim_calls_clone = claim_calls.clone();
    let claim_tokens_clone = claim_tokens_seen.clone();

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

        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_1",
                            "workspace_id": "ws_1",
                            "alias": "dev-target",
                            "display_name": "Dev Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    }]
                }),
            );
        }

        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "jobs": [{
                        "job_id": "job_crash_1",
                        "workspace_id": "ws_1",
                        "target_id": "tgt_1",
                        "resource_id": null,
                        "created_at": "2026-09-24T12:00:00.000Z",
                        "expires_at": null
                    }]
                }),
            );
        }

        if req.path == "/api/connector/jobs/job_crash_1/claim" && req.method == "POST" {
            let body: serde_json::Value = req.json().unwrap();
            let token = body
                .get("claim_token")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            let att_id = body
                .get("attempt_id")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();
            claim_tokens_clone
                .lock()
                .unwrap()
                .push((att_id.clone(), token));

            let call_num = claim_calls_clone.fetch_add(1, Ordering::SeqCst);
            if call_num == 0 {
                // Simulate transport error / 503 on first try
                return MockResponse {
                    status: 503,
                    headers: vec![],
                    body: b"Temporary Failure".to_vec(),
                };
            } else {
                // Replay succeeds!
                return MockResponse::json(
                    200,
                    &serde_json::json!({
                        "ok": true,
                        "replayed": true,
                        "server_time": "2026-09-24T12:00:00.000Z",
                        "attempt": {
                            "attempt_id": att_id,
                            "phase": "claimed",
                            "claimed_at": "2026-09-24T12:00:00.000Z",
                            "started_at": null
                        },
                        "job": {
                            "job_id": "job_crash_1",
                            "workspace_id": "ws_1",
                            "target_id": "tgt_1",
                            "resource_id": null,
                            "prompt": "Run tasks",
                            "acceptance": "acceptance criteria",
                            "timeout_seconds": 3600,
                            "result_target": "none"
                        }
                    }),
                );
            }
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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            workspace_id: "ws_1".into(),
            alias: "dev-target".into(),
            kind: "general_automation".into(),
            local_path: target_dir.to_string_lossy().to_string(),
        },
    );
    config.save(&paths.config_file()).unwrap();

    let fake_report = ceo_connector::execution_contract::ExecutionReport {
        schema_version: 2,
        execution_status: ceo_connector::execution_contract::ExecutionStatus::COMPLETED,
        business_outcome: ceo_connector::execution_contract::BusinessOutcome::UNVERIFIED,
        task_dispatched: true,
        finished_at_ms: 1700000005000,
        duration_ms: 5000,
        executor: ceo_connector::execution_contract::ExecutionReportExecutor {
            executor_type: "fake".into(),
            version: "1.0.0".into(),
        },
        receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".into(),
        error: None,
    };

    // 1. Run with ready fake adapter for 1 iteration (first attempt fails with 503)
    let adapter = Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: fake_report,
    });
    run_daemon(&paths, adapter.clone(), Some(1)).await.unwrap();

    // Claim intent was persisted before network!
    let attempt = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .unwrap();
    assert_eq!(
        attempt.phase,
        ceo_connector::scheduler::AttemptPhase::ClaimIntent
    );
    assert_eq!(attempt.job_id, "job_crash_1");

    // 2. Restart daemon: startup recovery replays the EXACT SAME attempt_id and claim_token
    run_daemon(&paths, adapter, Some(1)).await.unwrap();

    let tokens = claim_tokens_seen.lock().unwrap();
    assert_eq!(tokens.len(), 2);
    assert_eq!(tokens[0].0, tokens[1].0); // Same attempt_id
    assert_eq!(tokens[0].1, tokens[1].1); // Same claim_token
}

#[tokio::test]
async fn pause_prevents_job_claim() {
    let server = MockServer::start().await;
    let pending_calls = Arc::new(AtomicUsize::new(0));
    let pending_calls_clone = pending_calls.clone();

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

        if req.path.starts_with("/api/connector/jobs/pending") {
            pending_calls_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "jobs": [] }));
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

    // Plant control.json with paused = true
    atomic_write_json(
        &paths.control_file(),
        &serde_json::json!({ "schema_version": 1, "paused": true }),
    )
    .unwrap();

    let adapter = Arc::new(UnavailableExecutionAdapter);
    run_daemon(&paths, adapter, Some(2)).await.unwrap();

    // When paused, pending jobs are not queried
    assert_eq!(pending_calls.load(Ordering::SeqCst), 0);
}
