mod common;

use std::collections::HashSet;
use std::fs;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ceo_connector::config::{LocalConfig, LocalExecutorConfig, LocalTarget};
use ceo_connector::credential::DeviceCredential;
use ceo_connector::daemon::run_daemon;
use ceo_connector::local_state::atomic_write_json;
use ceo_connector::paths::ConnectorPaths;
use ceo_connector::scheduler::{
    ActiveAttempt, CleanupOutcome, DispatchOutcome, DispatchReconciliation, ExecutionAdapter,
    FakeExecutionAdapter, InterruptOutcome, PrepareOutcome, PreparedExecution,
    UnavailableExecutionAdapter, WaitOutcome,
};
use common::mock_server::{MockResponse, MockServer};

/// Shared claim log: every `job_id` the mock server observed a `/claim` POST
/// for, in arrival order.
type ClaimLog = Arc<Mutex<Vec<String>>>;

/// Minimal stable device-scoped job detail for the daemon's Waiting-phase
/// operator-cancel poll (state `active` => never terminal-cancelled).
fn job_detail_json(job_id: &str, target_id: &str) -> serde_json::Value {
    serde_json::json!({
        "job_id": job_id,
        "request_id": "req_mock",
        "target_id": target_id,
        "target_alias": "mock-alias",
        "state": "active",
        "execution_status": null,
        "business_outcome": null,
        "created_at": "2026-10-17T00:00:00.000Z",
        "expires_at": null,
        "resource_id": null,
        "result_target": "none",
        "execution_timeout_seconds": 3600
    })
}

/// Starts a mock Server exposing a fixed `(job_id, target_id)` queue with
/// real target-queue semantics: a job leaves `pending_jobs` once claimed.
async fn start_parallel_mock_server(
    jobs: &[(&'static str, &'static str)],
    claims: ClaimLog,
) -> MockServer {
    let server = MockServer::start().await;
    let jobs = Arc::new(jobs.to_vec());
    let claims_for_handler = claims.clone();
    let jobs_for_handler = jobs.clone();

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
            let targets: Vec<serde_json::Value> = jobs_for_handler
                .iter()
                .map(|(_, tid)| {
                    serde_json::json!({
                        "target": {
                            "id": tid,
                            "workspace_id": "ws_1",
                            "alias": format!("alias-{tid}"),
                            "display_name": format!("Display {tid}"),
                            "kind": "general_automation",
                            "repository": null,
                            "disabled": false
                        },
                        "this_device_binding": { "id": "bnd_1", "enabled": true },
                        "active_binding_count": 1
                    })
                })
                .collect();
            return MockResponse::json(200, &serde_json::json!({ "targets": targets }));
        }

        if req.path.starts_with("/api/connector/jobs/pending") && req.method == "GET" {
            let claimed = claims_for_handler.lock().unwrap();
            let pending: Vec<serde_json::Value> = jobs_for_handler
                .iter()
                .filter(|(jid, _)| !claimed.contains(&jid.to_string()))
                .map(|(jid, tid)| {
                    serde_json::json!({
                        "job_id": jid,
                        "workspace_id": "ws_1",
                        "target_id": tid,
                        "resource_id": null,
                        "created_at": "2026-10-17T00:00:00.000Z",
                        "expires_at": null
                    })
                })
                .collect();
            return MockResponse::json(200, &serde_json::json!({ "jobs": pending }));
        }

        if req.method == "GET" {
            if let Some((jid, tid)) = jobs_for_handler
                .iter()
                .find(|(jid, _)| req.path == format!("/api/connector/jobs/{jid}"))
            {
                return MockResponse::json(200, &job_detail_json(jid, tid));
            }
        }

        if req.path.contains("/claim") && req.method == "POST" {
            let job_id = req
                .path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/claim"))
                .unwrap_or_default()
                .to_string();
            claims_for_handler.lock().unwrap().push(job_id.clone());
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body
                .get("attempt_id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let target_id = jobs_for_handler
                .iter()
                .find(|(jid, _)| *jid == job_id)
                .map(|(_, tid)| *tid)
                .unwrap_or("tgt_unknown");
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-10-17T00:00:00.000Z",
                    "attempt": {
                        "attempt_id": att_id,
                        "phase": "claimed",
                        "claimed_at": "2026-10-17T00:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": job_id,
                        "workspace_id": "ws_1",
                        "target_id": target_id,
                        "resource_id": null,
                        "prompt": "Test prompt",
                        "acceptance": "Test acceptance",
                        "timeout_seconds": 3600,
                        "result_target": "none"
                    }
                }),
            );
        }

        if req.path.contains("/start") && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-10-17T00:00:01.000Z"
                }),
            );
        }

        if req.path.contains("/report") && req.method == "POST" {
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": false,
                    "server_time": "2026-10-17T00:00:02.000Z"
                }),
            );
        }

        MockResponse {
            status: 0,
            headers: vec![],
            body: vec![],
        }
    });

    server
}

/// Execution adapter whose `wait()` parks every Project behind a shared
/// barrier: the blocking target only leaves `wait()` once every other
/// expected target has ALSO entered `wait()`. A linear (single active
/// attempt blocking the polling loop) implementation can never fill the
/// barrier for the second Project and fails the bounded wait.
struct ParallelBarrierAdapter {
    /// Target ids expected to run concurrently.
    expected: Vec<String>,
    /// The target whose `wait()` call blocks until the barrier fills.
    blocking_target: String,
    /// Target ids currently parked inside `wait()`.
    in_wait: Arc<Mutex<HashSet<String>>>,
    /// Peak number of attempts simultaneously inside `wait()`.
    peak_concurrent: Arc<AtomicUsize>,
    /// True once a full barrier has been observed (later rounds never block).
    barrier_disarmed: Arc<std::sync::atomic::AtomicBool>,
    /// Claim log snapshot taken the moment the barrier fully filled.
    claims_at_full_barrier: Arc<Mutex<Vec<String>>>,
    claims: ClaimLog,
}

#[async_trait::async_trait]
impl ExecutionAdapter for ParallelBarrierAdapter {
    fn name(&self) -> &'static str {
        "parallel-barrier"
    }

    async fn is_ready(&self) -> bool {
        true
    }

    async fn prepare(
        &self,
        attempt: &ActiveAttempt,
        _target: &LocalTarget,
        _execution_prompt: &str,
    ) -> Result<PrepareOutcome, String> {
        Ok(PrepareOutcome::Ready(PreparedExecution {
            orca_version: "1.4.209".into(),
            worktree_id: format!("wt_{}", attempt.target_id),
            terminal_id: format!("term_{}", attempt.attempt_id),
            agent_id: "fake_agent".into(),
            agent_ready_at_ms: Some(chrono::Utc::now().timestamp_millis()),
            dispatch: None,
        }))
    }

    async fn reconcile_dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        Ok(DispatchReconciliation::DefinitelyNotDispatched)
    }

    async fn dispatch(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
        _prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        Ok(DispatchOutcome::Accepted {
            request_id: "req_barrier".into(),
            accepted_at_ms: chrono::Utc::now().timestamp_millis(),
            turn_started: true,
        })
    }

    async fn wait(
        &self,
        attempt: &ActiveAttempt,
        _terminal_id: &str,
        _remaining_timeout: Duration,
    ) -> Result<WaitOutcome, String> {
        let target = attempt.target_id.clone();
        {
            let mut in_wait = self.in_wait.lock().unwrap();
            in_wait.insert(target.clone());
            let parked = in_wait.len();
            self.peak_concurrent.fetch_max(parked, Ordering::SeqCst);
        }

        if target == self.blocking_target && !self.barrier_disarmed.load(Ordering::SeqCst) {
            // Block until every expected target has also entered wait()
            // (bounded: a linear-execution regression fails loudly here).
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            loop {
                let full = {
                    let in_wait = self.in_wait.lock().unwrap();
                    self.expected.iter().all(|t| in_wait.contains(t))
                };
                if full {
                    self.barrier_disarmed.store(true, Ordering::SeqCst);
                    let snapshot = self.claims.lock().unwrap().clone();
                    *self.claims_at_full_barrier.lock().unwrap() = snapshot;
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        } else {
            // Non-blocking targets register their presence and yield one
            // tick so the blocking target can observe the full barrier.
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        self.in_wait.lock().unwrap().remove(&target);
        Ok(WaitOutcome::TuiIdle { elapsed_ms: 100 })
    }

    async fn interrupt(
        &self,
        _attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<InterruptOutcome, String> {
        Ok(InterruptOutcome::Sent)
    }

    async fn close(&self, _terminal_id: &str) -> CleanupOutcome {
        CleanupOutcome::VerifiedClosed {
            closed_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}

/// Builds a two-Project environment (tgt_proj_1 / tgt_proj_2) with legacy
/// explicit-command executors so the daemon never probes the real Orca CLI.
fn setup_two_project_env(
    server: &MockServer,
) -> (tempfile::TempDir, ConnectorPaths, DeviceCredential) {
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

    // Legacy explicit command executors are admission-gated on local
    // executable discovery; point the command at a locally existing file.
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    let agent_cmd = agent_bin.display().to_string();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    for (target_id, dir_name) in [("tgt_proj_1", "proj_1"), ("tgt_proj_2", "proj_2")] {
        let target_dir = temp.path().join(dir_name);
        fs::create_dir_all(&target_dir).unwrap();
        config.targets.insert(
            target_id.into(),
            LocalTarget {
                local_path: target_dir.to_string_lossy().to_string(),
                executor: Some(LocalExecutorConfig::new("agy".into(), agent_cmd.clone()).unwrap()),
            },
        );
    }
    config.save(&paths.config_file()).unwrap();

    (temp, paths, cred)
}

/// Runs the daemon (unbounded) until every expected history record exists and
/// no active attempt remains, then aborts the daemon task.
async fn run_daemon_until_quiescent(
    paths: &ConnectorPaths,
    adapter: Arc<ParallelBarrierAdapter>,
    expected_history_count: usize,
) {
    let paths_for_daemon = paths.clone();
    let daemon = tokio::spawn(async move {
        run_daemon(
            &paths_for_daemon,
            adapter as Arc<dyn ExecutionAdapter>,
            None,
        )
        .await
    });

    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let attempts = ActiveAttempt::list_all(paths).unwrap_or_default();
        let history_count = fs::read_dir(paths.history_dir())
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok())
                    .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("json"))
                    .count()
            })
            .unwrap_or(0);
        if attempts.is_empty() && history_count >= expected_history_count {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "daemon did not reach a quiescent state within 60s (active attempts: {attempts:?}, history records: {history_count})"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    daemon.abort();
}

/// Sanitized history records keyed by job id.
fn read_history_statuses(paths: &ConnectorPaths) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(paths.history_dir()) {
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&path) {
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                    let job_id = val
                        .get("job_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let status = val
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    out.push((job_id, status));
                }
            }
        }
    }
    out.sort();
    out
}

/// PROJECT-056 acceptance: two Projects on one Device execute their jobs in
/// parallel. `tgt_proj_1`'s `wait()` blocks until `tgt_proj_2` has ALSO been
/// claimed, prepared, started and parked inside `wait()`; under the old
/// linear execution this barrier deadlocks.
#[tokio::test]
async fn cross_project_jobs_execute_in_parallel_without_linear_blocking() {
    let claims: ClaimLog = Arc::new(Mutex::new(Vec::new()));
    let server = start_parallel_mock_server(
        &[("job_proj_1", "tgt_proj_1"), ("job_proj_2", "tgt_proj_2")],
        claims.clone(),
    )
    .await;

    let (_temp, paths, _cred) = setup_two_project_env(&server);

    let adapter = Arc::new(ParallelBarrierAdapter {
        expected: vec!["tgt_proj_1".to_string(), "tgt_proj_2".to_string()],
        blocking_target: "tgt_proj_1".to_string(),
        in_wait: Arc::new(Mutex::new(HashSet::new())),
        peak_concurrent: Arc::new(AtomicUsize::new(0)),
        barrier_disarmed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        claims_at_full_barrier: Arc::new(Mutex::new(Vec::new())),
        claims: claims.clone(),
    });

    run_daemon_until_quiescent(&paths, adapter.clone(), 2).await;

    // Both Projects claimed their jobs (in pending order).
    assert_eq!(
        claims.lock().unwrap().as_slice(),
        ["job_proj_1", "job_proj_2"]
    );

    // Both jobs were started on the Server.
    let started: HashSet<String> = server
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.path.contains("/start"))
        .filter_map(|r| {
            r.path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/start"))
                .map(|s| s.to_string())
        })
        .collect();
    assert_eq!(
        started,
        HashSet::from(["job_proj_1".to_string(), "job_proj_2".to_string()])
    );

    // Both reports were delivered with execution_status COMPLETED.
    let reported: HashSet<(String, String)> = server
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.path.contains("/report"))
        .filter_map(|r| {
            let job_id = r
                .path
                .strip_prefix("/api/connector/jobs/")
                .and_then(|rest| rest.strip_suffix("/report"))?
                .to_string();
            let body: serde_json::Value = serde_json::from_slice(&r.body).ok()?;
            let status = body
                .get("report")?
                .get("execution_status")
                .and_then(|v| v.as_str())?
                .to_string();
            Some((job_id, status))
        })
        .collect();
    assert_eq!(
        reported,
        HashSet::from([
            ("job_proj_1".to_string(), "COMPLETED".to_string()),
            ("job_proj_2".to_string(), "COMPLETED".to_string()),
        ])
    );

    // The barrier itself proved simultaneity: both Projects were inside
    // wait() at the same time.
    assert_eq!(
        adapter.peak_concurrent.load(Ordering::SeqCst),
        2,
        "peak concurrent wait() count must be 2 (parallel execution)"
    );

    // Terminal cleanup: no active attempt remains anywhere.
    assert!(
        ActiveAttempt::list_all(&paths).unwrap().is_empty(),
        "all active attempts must be durably cleaned up"
    );
    assert!(!paths.active_attempt_file().exists());

    // Both sanitized history records exist and are completed.
    assert_eq!(
        read_history_statuses(&paths),
        vec![
            ("job_proj_1".to_string(), "completed".to_string()),
            ("job_proj_2".to_string(), "completed".to_string()),
        ]
    );
}

/// PROJECT-056 acceptance: within one Project execution stays strictly
/// serial (job_1b is NOT claimed while job_1a runs), while a different
/// Project's job (job_2a) runs in parallel with job_1a.
#[tokio::test]
async fn same_project_second_job_waits_serially_while_other_project_runs_in_parallel() {
    let claims: ClaimLog = Arc::new(Mutex::new(Vec::new()));
    let server = start_parallel_mock_server(
        &[
            ("job_1a", "tgt_proj_1"),
            ("job_1b", "tgt_proj_1"),
            ("job_2a", "tgt_proj_2"),
        ],
        claims.clone(),
    )
    .await;

    let (_temp, paths, _cred) = setup_two_project_env(&server);

    let adapter = Arc::new(ParallelBarrierAdapter {
        expected: vec!["tgt_proj_1".to_string(), "tgt_proj_2".to_string()],
        blocking_target: "tgt_proj_1".to_string(),
        in_wait: Arc::new(Mutex::new(HashSet::new())),
        peak_concurrent: Arc::new(AtomicUsize::new(0)),
        barrier_disarmed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        claims_at_full_barrier: Arc::new(Mutex::new(Vec::new())),
        claims: claims.clone(),
    });

    run_daemon_until_quiescent(&paths, adapter.clone(), 3).await;

    // At the moment both Projects were simultaneously inside wait(), only
    // job_1a (tgt_proj_1) and job_2a (tgt_proj_2) had been claimed — the
    // same-Project job_1b stayed queued on the Server.
    let claims_at_barrier = adapter.claims_at_full_barrier.lock().unwrap().clone();
    assert_eq!(
        claims_at_barrier.as_slice(),
        ["job_1a", "job_2a"],
        "job_1b must not be claimed while job_1a is still running"
    );

    // Peak simultaneity is exactly 2 (one slot per Project).
    assert_eq!(adapter.peak_concurrent.load(Ordering::SeqCst), 2);

    // Eventually all three jobs complete; job_1b is claimed strictly after
    // job_1a finished (serial within tgt_proj_1).
    assert_eq!(
        claims.lock().unwrap().as_slice(),
        ["job_1a", "job_2a", "job_1b"]
    );

    assert!(
        ActiveAttempt::list_all(&paths).unwrap().is_empty(),
        "all active attempts must be durably cleaned up"
    );

    assert_eq!(
        read_history_statuses(&paths),
        vec![
            ("job_1a".to_string(), "completed".to_string()),
            ("job_1b".to_string(), "completed".to_string()),
            ("job_2a".to_string(), "completed".to_string()),
        ]
    );
}

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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    // Legacy explicit command executors are admission-gated on local
    // executable discovery; point the command at a locally existing file.
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    let agent_cmd = agent_bin.display().to_string();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(
                ceo_connector::config::LocalExecutorConfig::new("agy".into(), agent_cmd).unwrap(),
            ),
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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    // Legacy explicit command executors are admission-gated on local
    // executable discovery; point the command at a locally existing file.
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    let agent_cmd = agent_bin.display().to_string();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(
                ceo_connector::config::LocalExecutorConfig::new("agy".into(), agent_cmd).unwrap(),
            ),
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

async fn run_claim_mismatch_case(
    mismatch_modifier: impl Fn(&mut serde_json::Value) + Send + Sync + 'static,
) {
    let server = MockServer::start().await;
    let adapter_executed = Arc::new(AtomicUsize::new(0));
    let adapter_executed_clone = adapter_executed.clone();
    let modifier = Arc::new(mismatch_modifier);

    let modifier_clone = modifier.clone();
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
                        "job_id": "job_mismatch_test",
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
            let body: serde_json::Value = req.json().unwrap();
            let att_id = body
                .get("attempt_id")
                .unwrap()
                .as_str()
                .unwrap()
                .to_string();

            let mut resp = serde_json::json!({
                "ok": true,
                "replayed": false,
                "server_time": "2026-09-24T12:00:00.000Z",
                "attempt": {
                    "attempt_id": att_id,
                    "phase": "claimed",
                    "claimed_at": "2026-09-24T12:00:00.000Z",
                    "started_at": null
                },
                "job": {
                    "job_id": "job_mismatch_test",
                    "workspace_id": "ws_1",
                    "target_id": "tgt_1",
                    "resource_id": null,
                    "prompt": "Test prompt",
                    "acceptance": "Test acceptance",
                    "timeout_seconds": 3600,
                    "result_target": "none"
                }
            });

            modifier_clone(&mut resp);
            return MockResponse::json(200, &resp);
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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    // Legacy explicit command executors are admission-gated on local
    // executable discovery; point the command at a locally existing file.
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    let agent_cmd = agent_bin.display().to_string();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(
                ceo_connector::config::LocalExecutorConfig::new("agy".into(), agent_cmd).unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    struct CountingAdapter {
        counter: Arc<AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl ceo_connector::scheduler::ExecutionAdapter for CountingAdapter {
        fn name(&self) -> &'static str {
            "counting"
        }
        async fn is_ready(&self) -> bool {
            true
        }
        async fn prepare(
            &self,
            _attempt: &ActiveAttempt,
            _target: &LocalTarget,
            _execution_prompt: &str,
        ) -> Result<ceo_connector::scheduler::PrepareOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn reconcile_dispatch(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
        ) -> Result<ceo_connector::scheduler::DispatchReconciliation, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Ok(ceo_connector::scheduler::DispatchReconciliation::DefinitelyNotDispatched)
        }
        async fn dispatch(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
            _prompt_text: &str,
        ) -> Result<ceo_connector::scheduler::DispatchOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn wait(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
            _remaining_timeout: std::time::Duration,
        ) -> Result<ceo_connector::scheduler::WaitOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn interrupt(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
        ) -> Result<ceo_connector::scheduler::InterruptOutcome, String> {
            Ok(ceo_connector::scheduler::InterruptOutcome::Sent)
        }
        async fn close(&self, _terminal_id: &str) -> ceo_connector::scheduler::CleanupOutcome {
            ceo_connector::scheduler::CleanupOutcome::AlreadyAbsent {
                verified_at_ms: chrono::Utc::now().timestamp_millis(),
            }
        }
    }

    let adapter = Arc::new(CountingAdapter {
        counter: adapter_executed_clone,
    });

    // Run daemon: candidate selected, claim intent saved, /claim returns mismatch, fails closed
    let run_res = run_daemon(&paths, adapter, Some(1)).await;
    assert!(
        run_res.is_err(),
        "Daemon should return RecoveryRequired error"
    );

    // Active attempt remains on disk
    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("Active attempt must remain on disk");
    // In recovery_required phase
    assert_eq!(
        active.phase,
        ceo_connector::scheduler::AttemptPhase::RecoveryRequired
    );
    assert_eq!(active.job_id, "job_mismatch_test");
    // No execution adapter invocation
    assert_eq!(adapter_executed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn claim_mismatch_wrong_job_id() {
    run_claim_mismatch_case(|resp| {
        resp["job"]["job_id"] = serde_json::json!("job_wrong");
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_wrong_workspace_id() {
    run_claim_mismatch_case(|resp| {
        resp["job"]["workspace_id"] = serde_json::json!("ws_wrong");
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_wrong_target_id() {
    run_claim_mismatch_case(|resp| {
        resp["job"]["target_id"] = serde_json::json!("tgt_wrong");
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_wrong_attempt_id() {
    run_claim_mismatch_case(|resp| {
        resp["attempt"]["attempt_id"] =
            serde_json::json!("att-00000000-0000-0000-0000-000000000099");
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_wrong_phase() {
    run_claim_mismatch_case(|resp| {
        resp["attempt"]["phase"] = serde_json::json!("completed");
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_ok_false() {
    run_claim_mismatch_case(|resp| {
        resp["ok"] = serde_json::json!(false);
    })
    .await;
}

#[tokio::test]
async fn claim_mismatch_invalid_claimed_at() {
    run_claim_mismatch_case(|resp| {
        resp["attempt"]["claimed_at"] = serde_json::json!("invalid-date-string");
    })
    .await;
}

#[tokio::test]
async fn lost_response_replay_mismatch_persists_recovery_required_no_second_attempt() {
    let server = MockServer::start().await;
    let claim_calls = Arc::new(AtomicUsize::new(0));
    let claim_calls_clone = claim_calls.clone();
    let adapter_executed = Arc::new(AtomicUsize::new(0));
    let adapter_executed_clone = adapter_executed.clone();

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

        if req.path.contains("/claim") && req.method == "POST" {
            claim_calls_clone.fetch_add(1, Ordering::SeqCst);
            // Server claims to have replayed, but returns a mismatched attempt_id!
            return MockResponse::json(
                200,
                &serde_json::json!({
                    "ok": true,
                    "replayed": true,
                    "server_time": "2026-09-24T12:00:00.000Z",
                    "attempt": {
                        "attempt_id": "att-00000000-0000-0000-0000-000000000099", // MISMATCH
                        "phase": "claimed",
                        "claimed_at": "2026-09-24T12:00:00.000Z",
                        "started_at": null
                    },
                    "job": {
                        "job_id": "job_replay_mismatch",
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

    let target_dir = temp.path().join("local_tgt");
    fs::create_dir_all(&target_dir).unwrap();

    // Legacy explicit command executors are admission-gated on local
    // executable discovery; point the command at a locally existing file.
    let agent_bin = temp.path().join("fake-agent");
    fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
    let agent_cmd = agent_bin.display().to_string();

    let mut config = LocalConfig::new(server.origin()).unwrap();
    config.targets.insert(
        "tgt_1".into(),
        LocalTarget {
            local_path: target_dir.to_string_lossy().to_string(),
            executor: Some(
                ceo_connector::config::LocalExecutorConfig::new("agy".into(), agent_cmd).unwrap(),
            ),
        },
    );
    config.save(&paths.config_file()).unwrap();

    // Plant active attempt in claim_intent
    let original_attempt_id = "att-00000000-0000-0000-0000-000000000001";
    atomic_write_json(
        &paths.active_attempt_file(),
        &serde_json::json!({
            "schema_version": ceo_connector::scheduler::ACTIVE_ATTEMPT_SCHEMA_VERSION,
            "server_origin": server.origin(),
            "device_id": "dev_1",
            "job_id": "job_replay_mismatch",
            "workspace_id": "ws_1",
            "target_id": "tgt_1",
            "attempt_id": original_attempt_id,
            "claim_token": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "phase": "claim_intent"
        }),
    )
    .unwrap();

    struct CountingAdapter {
        counter: Arc<AtomicUsize>,
    }
    #[async_trait::async_trait]
    impl ceo_connector::scheduler::ExecutionAdapter for CountingAdapter {
        fn name(&self) -> &'static str {
            "counting"
        }
        async fn is_ready(&self) -> bool {
            true
        }
        async fn prepare(
            &self,
            _attempt: &ActiveAttempt,
            _target: &LocalTarget,
            _execution_prompt: &str,
        ) -> Result<ceo_connector::scheduler::PrepareOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn reconcile_dispatch(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
        ) -> Result<ceo_connector::scheduler::DispatchReconciliation, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Ok(ceo_connector::scheduler::DispatchReconciliation::DefinitelyNotDispatched)
        }
        async fn dispatch(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
            _prompt_text: &str,
        ) -> Result<ceo_connector::scheduler::DispatchOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn wait(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
            _remaining_timeout: std::time::Duration,
        ) -> Result<ceo_connector::scheduler::WaitOutcome, String> {
            self.counter.fetch_add(1, Ordering::SeqCst);
            Err("should not execute".into())
        }
        async fn interrupt(
            &self,
            _attempt: &ActiveAttempt,
            _terminal_id: &str,
        ) -> Result<ceo_connector::scheduler::InterruptOutcome, String> {
            Ok(ceo_connector::scheduler::InterruptOutcome::Sent)
        }
        async fn close(&self, _terminal_id: &str) -> ceo_connector::scheduler::CleanupOutcome {
            ceo_connector::scheduler::CleanupOutcome::AlreadyAbsent {
                verified_at_ms: chrono::Utc::now().timestamp_millis(),
            }
        }
    }

    let adapter = Arc::new(CountingAdapter {
        counter: adapter_executed_clone,
    });

    let run_res = run_daemon(&paths, adapter, Some(1)).await;
    assert!(run_res.is_err(), "Daemon must fail with RecoveryRequired");

    // Verify recovery state persisted
    let active = ActiveAttempt::load(&paths.active_attempt_file())
        .unwrap()
        .expect("Active attempt must remain on disk");
    assert_eq!(
        active.phase,
        ceo_connector::scheduler::AttemptPhase::RecoveryRequired
    );
    // Preserves original attempt_id (no second attempt created)
    assert_eq!(active.attempt_id, original_attempt_id);
    assert_eq!(claim_calls.load(Ordering::SeqCst), 1);
    assert_eq!(adapter_executed.load(Ordering::SeqCst), 0);
}
