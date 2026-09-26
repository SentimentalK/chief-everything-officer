mod common;

use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::{run_daemon_with_hooks, DaemonError, DaemonHooks};
use ceo_connector::enrollment::logout_flow;
use ceo_connector::execution_contract::{
    BusinessOutcome, ExecutionReport, ExecutionReportExecutor, ExecutionStatus,
};
use ceo_connector::local_state::ExecutionLock;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::FakeExecutionAdapter;
use ceo_connector::targets::{target_remove, TargetError};
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

async fn setup_race_environment(server: &MockServer) -> (tempfile::TempDir, ConnectorPaths) {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let target_dir = temp.path().join("repo");
    fs::create_dir_all(&target_dir).unwrap();

    let cred = DeviceCredential::new(
        server.origin(),
        "usr_race".into(),
        "dev_race".into(),
        "dcr_race".into(),
        "secret".into(),
        2000000000000,
    )
    .unwrap();
    cred.save(&paths.credential_file()).unwrap();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_race".into(),
        LocalTarget {
            workspace_id: "ws_race".into(),
            alias: "race-tgt".into(),
            kind: "general_automation".into(),
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(LocalExecutorConfig::new("agy".into(), "agy".into()).unwrap()),
        },
    );
    config.save(&paths.config_file()).unwrap();

    (temp, paths)
}

#[tokio::test]
async fn race_remove_wins_prevents_claim() {
    let server = MockServer::start().await;
    let claim_count = Arc::new(AtomicUsize::new(0));
    let claim_count_clone = claim_count.clone();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_race",
                    "device": { "id": "dev_race", "display_name": "Race Device", "platform": "linux" },
                    "credential": { "id": "dcr_race", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_race",
                            "workspace_id": "ws_race",
                            "alias": "race-tgt",
                            "display_name": "Race Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "dtb_race", "enabled": true },
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
                        "job_id": "job_race",
                        "workspace_id": "ws_race",
                        "target_id": "tgt_race",
                        "resource_id": null,
                        "created_at": "2026-09-24T19:00:00.000Z",
                        "expires_at": null
                    }]
                }),
            );
        }
        if req.path == "/api/connector/targets/tgt_race/unbind" && req.method == "POST" {
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        if req.path == "/api/connector/jobs/job_race/claim" && req.method == "POST" {
            claim_count_clone.fetch_add(1, Ordering::SeqCst);
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body.get("attempt_id").unwrap().as_str().unwrap().to_string();
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T19:00:01.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T19:00:01.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": "job_race",
                        "workspace_id": "ws_race",
                        "target_id": "tgt_race",
                        "resource_id": null,
                        "prompt": "Test",
                        "acceptance": "Test",
                        "timeout_seconds": 600,
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

    let (_temp, paths) = setup_race_environment(&server).await;

    let adapter = Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    });

    let paths_clone = paths.clone();
    let hooks = DaemonHooks {
        after_candidate_selected: Some(Arc::new(move |cand| {
            let paths = paths_clone.clone();
            let target_id = cand.target_id.clone();
            Box::pin(async move {
                // target_remove wins state.lock while daemon candidate was selected!
                target_remove(&paths, &target_id)
                    .await
                    .expect("target_remove should succeed");
            })
        })),
        ..Default::default()
    };

    let res = run_daemon_with_hooks(&paths, adapter, Some(1), hooks).await;
    assert!(res.is_ok());

    // Daemon re-evaluated state.lock, saw target removed from config, skipped claim!
    assert_eq!(claim_count.load(Ordering::SeqCst), 0);
    assert!(!paths.active_attempt_file().exists());

    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(!config.targets.contains_key("tgt_race"));
}

#[tokio::test]
async fn race_daemon_wins_rejects_target_remove() {
    let server = MockServer::start().await;
    let claim_count = Arc::new(AtomicUsize::new(0));
    let claim_count_clone = claim_count.clone();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_race",
                    "device": { "id": "dev_race", "display_name": "Race Device", "platform": "linux" },
                    "credential": { "id": "dcr_race", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_race",
                            "workspace_id": "ws_race",
                            "alias": "race-tgt",
                            "display_name": "Race Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "dtb_race", "enabled": true },
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
                        "job_id": "job_race",
                        "workspace_id": "ws_race",
                        "target_id": "tgt_race",
                        "resource_id": null,
                        "created_at": "2026-09-24T19:00:00.000Z",
                        "expires_at": null
                    }]
                }),
            );
        }
        if req.path == "/api/connector/jobs/job_race/claim" && req.method == "POST" {
            claim_count_clone.fetch_add(1, Ordering::SeqCst);
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body.get("attempt_id").unwrap().as_str().unwrap().to_string();
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T19:00:01.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T19:00:01.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": "job_race",
                        "workspace_id": "ws_race",
                        "target_id": "tgt_race",
                        "resource_id": null,
                        "prompt": "Test",
                        "acceptance": "Test",
                        "timeout_seconds": 600,
                        "result_target": "none"
                    }
                }),
            );
        }
        if req.path == "/api/connector/jobs/job_race/start" && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T19:00:02.000Z"
                }),
            );
        }
        if req.path == "/api/connector/jobs/job_race/report" && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-09-24T19:00:03.000Z"
                }),
            );
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = setup_race_environment(&server).await;

    let adapter = Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    });

    let paths_clone = paths.clone();
    let target_remove_err = Arc::new(std::sync::Mutex::new(None));
    let target_remove_err_clone = target_remove_err.clone();

    let hooks = DaemonHooks {
        after_claim_intent_persisted: Some(Arc::new(move |attempt| {
            let paths = paths_clone.clone();
            let target_id = attempt.target_id.clone();
            let target_remove_err = target_remove_err_clone.clone();
            Box::pin(async move {
                // Daemon wrote claim_intent first! target_remove runs concurrently:
                let err = target_remove(&paths, &target_id).await.unwrap_err();
                *target_remove_err.lock().unwrap() = Some(err);
            })
        })),
        ..Default::default()
    };

    let res = run_daemon_with_hooks(&paths, adapter, Some(1), hooks).await;
    assert!(res.is_ok());

    let recorded_err = target_remove_err
        .lock()
        .unwrap()
        .take()
        .expect("error recorded");
    assert!(matches!(recorded_err, TargetError::TargetInUse(t) if t == "tgt_race"));

    assert_eq!(claim_count.load(Ordering::SeqCst), 1);
    let config = LocalConfig::load(&paths.config_file()).unwrap().unwrap();
    assert!(config.targets.contains_key("tgt_race"));
}

#[tokio::test]
async fn race_logout_wins_prevents_active_attempt() {
    let server = MockServer::start().await;
    let claim_count = Arc::new(AtomicUsize::new(0));
    let claim_count_clone = claim_count.clone();

    server.add_handler(move |req| {
        if req.path == "/api/connector/identity" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "user_id": "usr_race",
                    "device": { "id": "dev_race", "display_name": "Race Device", "platform": "linux" },
                    "credential": { "id": "dcr_race", "expires_at_ms": 2000000000000i64 }
                }),
            );
        }
        if req.path == "/api/connector/targets" && req.method == "GET" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "targets": [{
                        "target": {
                            "id": "tgt_race",
                            "workspace_id": "ws_race",
                            "alias": "race-tgt",
                            "display_name": "Race Target",
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "dtb_race", "enabled": true },
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
                        "job_id": "job_race",
                        "workspace_id": "ws_race",
                        "target_id": "tgt_race",
                        "resource_id": null,
                        "created_at": "2026-09-24T19:00:00.000Z",
                        "expires_at": null
                    }]
                }),
            );
        }
        if req.path == "/api/connector/device/revoke" && req.method == "POST" {
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        if req.path == "/api/connector/jobs/job_race/claim" && req.method == "POST" {
            claim_count_clone.fetch_add(1, Ordering::SeqCst);
            return MockResponse::json(200, &serde_json::json!({ "ok": true }));
        }
        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    let (_temp, paths) = setup_race_environment(&server).await;

    let adapter = Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    });

    let paths_clone = paths.clone();
    let hooks = DaemonHooks {
        after_candidate_selected: Some(Arc::new(move |_cand| {
            let paths = paths_clone.clone();
            Box::pin(async move {
                // logout wins state.lock while daemon candidate was selected!
                logout_flow(&paths)
                    .await
                    .expect("logout_flow should succeed");
            })
        })),
        ..Default::default()
    };

    let res = run_daemon_with_hooks(&paths, adapter, Some(1), hooks).await;
    assert!(matches!(res, Err(DaemonError::AuthRequired)));

    assert_eq!(claim_count.load(Ordering::SeqCst), 0);
    assert!(!paths.active_attempt_file().exists());
    assert!(!paths.credential_file().exists());
}

#[tokio::test]
async fn concurrent_daemon_lock_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let paths = ConnectorPaths::from_roots(temp.path().join("config"), temp.path().join("state"));
    paths.ensure_dirs().unwrap();

    let _held_lock = ExecutionLock::acquire(&paths.daemon_lock_file()).unwrap();

    let adapter = Arc::new(FakeExecutionAdapter {
        ready: true,
        report_to_produce: sample_report(),
    });

    let res = run_daemon_with_hooks(&paths, adapter, Some(1), DaemonHooks::default()).await;
    assert!(matches!(res, Err(DaemonError::AlreadyRunning)));
}
