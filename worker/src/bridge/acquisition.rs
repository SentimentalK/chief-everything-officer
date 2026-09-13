//! Task acquisition: checks local Doctor readiness, persists claim intent,
//! calls the persistent assignment API, and persists the confirmed task payload
//! before execution.

use std::path::Path;
use tokio::sync::watch;

use crate::bridge::client::{BridgeClient, ClientError, ErrorKind};
use crate::bridge::protocol::AssignmentClaimRequest;
use crate::bridge::state::{
    self, ActiveAttempt, BridgeState, ClaimPayload, LocalPhase, StateError,
};
use crate::runner::{Runner, RunnerError, StopReason};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquireOutcome {
    Claimed,
    NotReady,
    Stopped(StopReason),
    NoLongerPending,
}

#[derive(Debug, thiserror::Error)]
pub enum AcquireError {
    #[error("local state error: {0}")]
    State(#[from] StateError),

    #[error("local conflict: {0}")]
    Conflict(String),

    #[error("doctor verification error: {0}")]
    Doctor(#[from] RunnerError),

    #[error("bridge client error: {0}")]
    Client(#[from] ClientError),

    #[error("recovery required: {0}")]
    RecoveryRequired(String),
}

fn check_stop(stop_rx: &watch::Receiver<Option<StopReason>>) -> Option<StopReason> {
    if let Some(reason) = stop_rx.borrow().as_ref() {
        return Some(reason.clone());
    }
    let rx = stop_rx.clone();
    if rx.has_changed().is_err() {
        return Some(StopReason::ControllerGone);
    }
    None
}

/// Acquires one task: verifies local readiness, saves attempt identity and claim
/// token before sending a claim, invokes the persistent assignment API, and
/// saves the confirmed payload before returning.
pub async fn acquire_one(
    runner: &Runner,
    client: &BridgeClient,
    workspace: &Path,
    state: &mut BridgeState,
    job_id: &str,
    stop_rx: &watch::Receiver<Option<StopReason>>,
) -> Result<AcquireOutcome, AcquireError> {
    // 1. Validate workspace against configured state binding
    let canonical = workspace
        .canonicalize()
        .map_err(|e| StateError::io(workspace, &e))?;
    if state.binding.canonical_workspace != canonical {
        return Err(AcquireError::State(StateError::BindingMismatch(format!(
            "workspace {} does not match state binding canonical workspace {}",
            canonical.display(),
            state.binding.canonical_workspace.display()
        ))));
    }
    crate::config::validate_id("job_id", job_id)
        .map_err(|e| AcquireError::State(StateError::Invalid(e.to_string())))?;

    // 2. Inspect existing state before doing work (Table 6.1)
    if let Some(active) = &state.active {
        if active.job_id != job_id {
            return Err(AcquireError::Conflict(format!(
                "another active job {} is present",
                active.job_id
            )));
        }
        match active.phase {
            LocalPhase::ClaimIntent => {
                // Same job, ClaimIntent: reuse persisted attempt and token
            }
            LocalPhase::Claimed => {
                // Same job, Claimed: reuse saved payload, no claim HTTP request
                if let Some(reason) = check_stop(stop_rx) {
                    return Ok(AcquireOutcome::Stopped(reason));
                }
                let report = runner
                    .run_standalone_doctor_with_options(workspace, false)
                    .await
                    .map_err(AcquireError::Doctor)?;
                if !report.ready {
                    return Ok(AcquireOutcome::NotReady);
                }
                if let Some(reason) = check_stop(stop_rx) {
                    return Ok(AcquireOutcome::Stopped(reason));
                }
                return Ok(AcquireOutcome::Claimed);
            }
            _ => {
                // Any later execution or recovery phase
                return Err(AcquireError::RecoveryRequired(format!(
                    "active attempt {} for job {} is in phase {:?}; recovery required",
                    active.attempt_id, active.job_id, active.phase
                )));
            }
        }
    } else {
        // No active attempt: check if job already has attempt evidence
        if state::job_dir_has_attempts(workspace, job_id)
            || state::history_dir_has_job(workspace, job_id)
        {
            return Err(AcquireError::Conflict(format!(
                "job {job_id} already has local attempt evidence"
            )));
        }
    }

    // 3. Check stop before Doctor (Section 6.2)
    if let Some(reason) = check_stop(stop_rx) {
        return Ok(AcquireOutcome::Stopped(reason));
    }

    // 4. Run Doctor readiness
    let report = runner
        .run_standalone_doctor_with_options(workspace, false)
        .await
        .map_err(AcquireError::Doctor)?;
    if !report.ready {
        return Ok(AcquireOutcome::NotReady);
    }

    // 5. Check stop after Doctor before preparing or sending claim
    if let Some(reason) = check_stop(stop_rx) {
        return Ok(AcquireOutcome::Stopped(reason));
    }

    // 6. Persist a new claim intent if no active attempt exists (Section 6.3)
    if state.active.is_none() {
        let attempt_id = state::new_attempt_id();
        let claim_token =
            state::generate_claim_token().map_err(|e| StateError::io(workspace, &e))?;
        let active = ActiveAttempt {
            job_id: job_id.to_string(),
            attempt_id,
            claim_token,
            phase: LocalPhase::ClaimIntent,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        };
        let mut next = state.clone();
        next.active = Some(active);
        next.persist(workspace).map_err(AcquireError::State)?;
        *state = next;
    }

    // 7. Send one claim request (Section 6.4)
    let active = state.active.as_ref().expect("active attempt must exist");
    let req = AssignmentClaimRequest {
        worker_id: state.worker_id.clone(),
        attempt_id: active.attempt_id.clone(),
        workspace_ref: state.binding.workspace_ref.clone(),
        claim_token: active.claim_token.clone(),
    };

    match client.claim_assignment(job_id, &req).await {
        Ok(ok) => {
            // Section 6.5: Handle a successful response
            if ok.execution.phase == "running" {
                let payload = ClaimPayload::from_wire(&ok.job);
                let mut next = state.clone();
                if let Some(a) = &mut next.active {
                    a.phase = LocalPhase::RecoveryRequired;
                    a.claim = Some(payload);
                    a.process = None;
                    a.task_dispatch_intent = false;
                }
                next.persist(workspace).map_err(AcquireError::State)?;
                *state = next;
                return Err(AcquireError::RecoveryRequired(format!(
                    "claim returned execution phase running for job {job_id}"
                )));
            }

            let payload = ClaimPayload::from_wire(&ok.job);
            let mut next = state.clone();
            if let Some(a) = &mut next.active {
                a.phase = LocalPhase::Claimed;
                a.claim = Some(payload);
                a.process = None;
                a.task_dispatch_intent = false;
            }
            next.persist(workspace).map_err(AcquireError::State)?;
            *state = next;

            // Return Claimed, or Stopped if cancellation arrived meanwhile.
            // Returning Stopped after success must leave the saved claimed task intact.
            if let Some(reason) = check_stop(stop_rx) {
                return Ok(AcquireOutcome::Stopped(reason));
            }
            Ok(AcquireOutcome::Claimed)
        }
        Err(client_err) => {
            // Section 6.6: Handle errors
            if !client_err.outcome_unknown {
                if let ErrorKind::Server { ref code, .. } = client_err.kind {
                    if matches!(
                        code.as_str(),
                        "JOB_ALREADY_CLAIMED" | "JOB_EXPIRED" | "JOB_NOT_FOUND"
                    ) {
                        let mut next = state.clone();
                        next.active = None;
                        next.persist(workspace).map_err(AcquireError::State)?;
                        *state = next;
                        return Ok(AcquireOutcome::NoLongerPending);
                    }
                }
            }
            Err(AcquireError::Client(client_err))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::config::load_api_key;
    use crate::bridge::state::{bridge_dir, state_path, BridgeBinding};
    use crate::config::{ExecutorType, WorkerConfig};
    use parking_lot::Mutex;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;
    use tempfile::tempdir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use url::Url;

    const JOB: &str = "job-123e4567-e89b-12d3-a456-426614174001";
    const API_KEY_VAL: &str = "secret-test-api-key-12345678901234567890";

    #[derive(Clone)]
    struct RecordedRequest {
        #[allow(dead_code)]
        target: String,
        #[allow(dead_code)]
        headers: BTreeMap<String, String>,
        body: Vec<u8>,
    }

    #[derive(Clone)]
    enum Action {
        Respond {
            status: u16,
            headers: Vec<(String, String)>,
            body: Vec<u8>,
        },
        DropConnection,
    }

    type Handler = Box<dyn Fn(&RecordedRequest) -> Action + Send + Sync>;

    struct TestServer {
        url: String,
        recorded: Arc<Mutex<Vec<RecordedRequest>>>,
    }

    async fn spawn_server(handler: Handler) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let recorded: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
        let handler = Arc::new(handler);
        let rec = recorded.clone();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let rec = rec.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut buf = [0u8; 2048];
                    let header_end = loop {
                        let n = match sock.read(&mut buf).await {
                            Ok(0) => return,
                            Ok(n) => n,
                            Err(_) => return,
                        };
                        head.extend_from_slice(&buf[..n]);
                        if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                            break pos;
                        }
                    };
                    let head_str = String::from_utf8_lossy(&head[..header_end]);
                    let mut lines = head_str.lines();
                    let req_line = lines.next().unwrap_or("");
                    let target = req_line.split_whitespace().nth(1).unwrap_or("").to_string();
                    let mut headers = BTreeMap::new();
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                        }
                    }
                    let content_len = headers
                        .get("content-length")
                        .and_then(|v| v.parse::<usize>().ok())
                        .unwrap_or(0);
                    let mut body = head[header_end + 4..].to_vec();
                    while body.len() < content_len {
                        let n = match sock.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(_) => break,
                        };
                        body.extend_from_slice(&buf[..n]);
                    }
                    let recorded_req = RecordedRequest {
                        target,
                        headers,
                        body,
                    };
                    let action = handler(&recorded_req);
                    rec.lock().push(recorded_req);

                    match action {
                        Action::Respond {
                            status,
                            headers: resp_hdrs,
                            body: resp_body,
                        } => {
                            let mut resp = format!("HTTP/1.1 {status} Reason\r\n");
                            for (k, v) in resp_hdrs {
                                resp.push_str(&format!("{k}: {v}\r\n"));
                            }
                            resp.push_str(&format!("content-length: {}\r\n", resp_body.len()));
                            resp.push_str("connection: close\r\n\r\n");
                            let _ = sock.write_all(resp.as_bytes()).await;
                            let _ = sock.write_all(&resp_body).await;
                            let _ = sock.flush().await;
                        }
                        Action::DropConnection => {
                            let _ = sock.shutdown().await;
                        }
                    }
                });
            }
        });
        TestServer {
            url: format!("http://{addr}"),
            recorded,
        }
    }

    fn write_key_file(dir: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let p = dir.join("api_key");
        fs::write(&p, API_KEY_VAL).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o600)).unwrap();
        p
    }

    fn test_client(server_url: &str, key_path: &Path) -> BridgeClient {
        let key = load_api_key(key_path).unwrap();
        BridgeClient::new_with_timeouts(
            Url::parse(server_url).unwrap(),
            key,
            Duration::from_millis(500),
            Duration::from_millis(1500),
        )
        .unwrap()
    }

    fn setup_workspace(temp: &Path, doctor_ready: bool) -> (PathBuf, BridgeBinding, Runner) {
        let ws = temp.join("workspace");
        fs::create_dir_all(&ws).unwrap();

        if doctor_ready {
            let agents = "# Guidelines\n\n<!-- ceo:metadata rule_marker: \"ACQ-TEST\" -->\n\n1. Respect boundaries.\n";
            fs::write(ws.join("AGENTS.md"), agents).unwrap();
            fs::write(ws.join(".stub_mode"), "normal").unwrap();
        }

        let canonical = ws.canonicalize().unwrap();
        let binding = BridgeBinding {
            server_origin: "http://127.0.0.1:0".to_string(),
            user_id: "usr_1".to_string(),
            workspace_id: "ws_1".to_string(),
            workspace_ref: "tools".to_string(),
            canonical_workspace: canonical.clone(),
        };

        let stub = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("test_stub.sh");

        let config = WorkerConfig {
            workspace_dir: canonical.clone(),
            executor_type: ExecutorType::TestStub,
            agent_executable: stub,
            doctor_timeout_secs: 5,
            task_timeout_secs: 5,
            ..Default::default()
        };

        let runner = Runner::new(config, None);
        (canonical, binding, runner)
    }

    fn make_claimed_response(job_id: &str, attempt_id: &str, worker_id: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "ok": true,
            "replayed": false,
            "server_time": "2026-09-12T18:00:00Z",
            "job": {
                "job_id": job_id,
                "workspace_ref": "tools",
                "resource_id": null,
                "prompt": "Create output artifact",
                "acceptance": "Artifact must exist",
                "timeout_seconds": 120,
                "delivery": { "type": "none" }
            },
            "execution": {
                "worker_id": worker_id,
                "attempt_id": attempt_id,
                "phase": "claimed",
                "claimed_at": "2026-09-12T18:00:00Z",
                "started_at": null
            }
        }))
        .unwrap()
    }

    // --- TEST A: Readiness prevents acquisition ---
    #[tokio::test]
    async fn test_readiness_prevents_acquisition_when_doctor_not_ready() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), false); // no AGENTS.md -> doctor not ready
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding);
        let (_stop_tx, stop_rx) = watch::channel(None);

        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::NotReady);
        assert_eq!(server.recorded.lock().len(), 0);
        assert!(state.active.is_none());
    }

    #[tokio::test]
    async fn test_readiness_prevents_acquisition_when_stop_pre_existing() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding);
        let (_stop_tx, stop_rx) = watch::channel(Some(StopReason::UserRequested));

        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::Stopped(StopReason::UserRequested));
        assert_eq!(server.recorded.lock().len(), 0);
        assert!(state.active.is_none());
    }

    // --- TEST B: Intent exists before the request ---
    #[tokio::test]
    async fn test_intent_exists_before_request() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());
        let ws_clone = ws.clone();

        let server = spawn_server(Box::new(move |req| {
            // When claim arrives, inspect the state file on disk
            let raw: serde_json::Value =
                serde_json::from_str(&fs::read_to_string(state_path(&ws_clone)).unwrap()).unwrap();
            let act = raw.get("active").unwrap();
            assert_eq!(act.get("phase").unwrap().as_str().unwrap(), "claim_intent");
            assert_eq!(act.get("job_id").unwrap().as_str().unwrap(), JOB);
            assert!(act.get("claim").unwrap().is_null());
            assert!(act.get("process").unwrap().is_null());
            assert!(!act.get("task_dispatch_intent").unwrap().as_bool().unwrap());

            let req_body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(act.get("attempt_id"), req_body.get("attempt_id"));
            assert_eq!(act.get("claim_token"), req_body.get("claim_token"));

            let attempt_id = req_body.get("attempt_id").unwrap().as_str().unwrap();
            let worker_id = req_body.get("worker_id").unwrap().as_str().unwrap();
            Action::Respond {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: make_claimed_response(JOB, attempt_id, worker_id),
            }
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding.clone());
        let (_stop_tx, stop_rx) = watch::channel(None);

        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::Claimed);
        assert_eq!(server.recorded.lock().len(), 1);

        // Reload state from disk and verify Claimed and payload integrity
        let reloaded = BridgeState::load(&state_path(&ws), &binding).unwrap();
        let act = reloaded.active.unwrap();
        assert_eq!(act.phase, LocalPhase::Claimed);
        let claim = act.claim.unwrap();
        assert!(claim.verify_integrity());
        assert_eq!(claim.workspace_ref, "tools");
        assert_eq!(claim.prompt, "Create output artifact");
    }

    // --- TEST C: Failed initial persistence sends nothing ---
    #[tokio::test]
    async fn test_failed_initial_persistence_sends_nothing() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        // Create .ceo/bridge as a regular file so ensure_control_dirs / state write fails
        let bdir = bridge_dir(&ws);
        fs::create_dir_all(bdir.parent().unwrap()).unwrap();
        fs::write(&bdir, "not-a-directory").unwrap();

        let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding);
        let (_stop_tx, stop_rx) = watch::channel(None);

        let res = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx).await;

        assert!(matches!(res, Err(AcquireError::State(_))));
        assert_eq!(server.recorded.lock().len(), 0);
    }

    // --- TEST D: Lost response preserves retry identity ---
    #[tokio::test]
    async fn test_lost_response_preserves_retry_identity() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let call_count = Arc::new(Mutex::new(0usize));
        let count_clone = call_count.clone();

        let server = spawn_server(Box::new(move |req| {
            let mut c = count_clone.lock();
            *c += 1;
            if *c == 1 {
                Action::DropConnection
            } else {
                let req_body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
                let attempt_id = req_body.get("attempt_id").unwrap().as_str().unwrap();
                let worker_id = req_body.get("worker_id").unwrap().as_str().unwrap();
                Action::Respond {
                    status: 200,
                    headers: vec![("content-type".into(), "application/json".into())],
                    body: make_claimed_response(JOB, attempt_id, worker_id),
                }
            }
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding.clone());
        let (_stop_tx, stop_rx) = watch::channel(None);

        // First attempt: connection dropped
        let err = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap_err();

        match err {
            AcquireError::Client(ce) => assert!(ce.outcome_unknown),
            other => panic!("expected Client with outcome_unknown, got {other:?}"),
        }

        let first_active = state.active.clone().unwrap();
        assert_eq!(first_active.phase, LocalPhase::ClaimIntent);

        // Second attempt: replay succeeds with exact same attempt_id and token
        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::Claimed);
        let second_active = state.active.clone().unwrap();
        assert_eq!(second_active.attempt_id, first_active.attempt_id);
        assert_eq!(second_active.claim_token, first_active.claim_token);
        assert_eq!(second_active.phase, LocalPhase::Claimed);

        let reqs = server.recorded.lock();
        assert_eq!(reqs.len(), 2);
        let body1: serde_json::Value = serde_json::from_slice(&reqs[0].body).unwrap();
        let body2: serde_json::Value = serde_json::from_slice(&reqs[1].body).unwrap();
        assert_eq!(body1["attempt_id"], body2["attempt_id"]);
        assert_eq!(body1["claim_token"], body2["claim_token"]);
        assert_eq!(body1["worker_id"], body2["worker_id"]);
    }

    // --- TEST E: Confirmed claim cannot be used before persistence ---
    #[tokio::test]
    async fn test_confirmed_claim_cannot_be_used_before_persistence() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());
        let ws_clone = ws.clone();

        let server = spawn_server(Box::new(move |req| {
            // Replace state.json with a directory so atomic_write_json fails when persisting Claimed
            let sp = state_path(&ws_clone);
            let _ = fs::remove_file(&sp);
            let _ = fs::create_dir(&sp);

            let req_body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            let attempt_id = req_body.get("attempt_id").unwrap().as_str().unwrap();
            let worker_id = req_body.get("worker_id").unwrap().as_str().unwrap();
            Action::Respond {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: make_claimed_response(JOB, attempt_id, worker_id),
            }
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding);
        let (_stop_tx, stop_rx) = watch::channel(None);

        let res = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx).await;

        // Cleanup directory
        let _ = fs::remove_dir(state_path(&ws));

        assert!(matches!(res, Err(AcquireError::State(_))));
        // In-memory state must remain ClaimIntent (not Claimed)
        assert_eq!(
            state.active.as_ref().unwrap().phase,
            LocalPhase::ClaimIntent
        );
    }

    // --- TEST F: Saved claim does not claim again ---
    #[tokio::test]
    async fn test_saved_claim_does_not_claim_again() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
        let client = test_client(&server.url, &key_path);

        let mut state = BridgeState::new(binding);
        let claim_payload = ClaimPayload::from_wire(&crate::bridge::protocol::ClaimedJob {
            job_id: JOB.to_string(),
            workspace_ref: "tools".to_string(),
            resource_id: None,
            prompt: "P".to_string(),
            acceptance: "A".to_string(),
            timeout_seconds: 60,
            delivery: crate::bridge::protocol::TaskDeliverySpec::None,
        });

        state.active = Some(ActiveAttempt {
            job_id: JOB.to_string(),
            attempt_id: state::new_attempt_id(),
            claim_token: state::generate_claim_token().unwrap(),
            phase: LocalPhase::Claimed,
            claim: Some(claim_payload),
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        });
        state.persist(&ws).unwrap();

        let (_stop_tx, stop_rx) = watch::channel(None);
        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::Claimed);
        assert_eq!(server.recorded.lock().len(), 0);
    }

    // --- TEST G: Error and recovery boundaries ---
    #[tokio::test]
    async fn test_error_boundary_already_claimed_clears_intent() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::Respond {
            status: 409,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&serde_json::json!({
                "ok": false,
                "code": "JOB_ALREADY_CLAIMED"
            }))
            .unwrap(),
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding.clone());
        let (_stop_tx, stop_rx) = watch::channel(None);

        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::NoLongerPending);
        assert!(state.active.is_none());
        let reloaded = BridgeState::load(&state_path(&ws), &binding).unwrap();
        assert!(reloaded.active.is_none());
    }

    #[tokio::test]
    async fn test_error_boundary_assignment_mismatch_preserves_intent() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::Respond {
            status: 409,
            headers: vec![("content-type".into(), "application/json".into())],
            body: serde_json::to_vec(&serde_json::json!({
                "ok": false,
                "code": "ASSIGNMENT_MISMATCH"
            }))
            .unwrap(),
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding);
        let (_stop_tx, stop_rx) = watch::channel(None);

        let err = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap_err();

        assert!(matches!(err, AcquireError::Client(_)));
        assert_eq!(
            state.active.as_ref().unwrap().phase,
            LocalPhase::ClaimIntent
        );
    }

    #[tokio::test]
    async fn test_error_boundary_replayed_running_saves_recovery_required() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|req| {
            let req_body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            let attempt_id = req_body.get("attempt_id").unwrap().as_str().unwrap();
            let worker_id = req_body.get("worker_id").unwrap().as_str().unwrap();
            Action::Respond {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: serde_json::to_vec(&serde_json::json!({
                    "ok": true,
                    "replayed": true,
                    "server_time": "2026-09-12T18:00:00Z",
                    "job": {
                        "job_id": JOB,
                        "workspace_ref": "tools",
                        "resource_id": null,
                        "prompt": "Create output artifact",
                        "acceptance": "Artifact must exist",
                        "timeout_seconds": 120,
                        "delivery": { "type": "none" }
                    },
                    "execution": {
                        "worker_id": worker_id,
                        "attempt_id": attempt_id,
                        "phase": "running",
                        "claimed_at": "2026-09-12T18:00:00Z",
                        "started_at": "2026-09-12T18:00:01Z"
                    }
                }))
                .unwrap(),
            }
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding.clone());
        let (_stop_tx, stop_rx) = watch::channel(None);

        let err = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap_err();

        assert!(matches!(err, AcquireError::RecoveryRequired(_)));
        let reloaded = BridgeState::load(&state_path(&ws), &binding).unwrap();
        let act = reloaded.active.unwrap();
        assert_eq!(act.phase, LocalPhase::RecoveryRequired);
        assert!(act.claim.is_some());
    }

    #[tokio::test]
    async fn test_error_boundary_another_active_job_conflict() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
        let client = test_client(&server.url, &key_path);

        let mut state = BridgeState::new(binding);
        state.active = Some(ActiveAttempt {
            job_id: "other-job-123".to_string(),
            attempt_id: state::new_attempt_id(),
            claim_token: state::generate_claim_token().unwrap(),
            phase: LocalPhase::ClaimIntent,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        });

        let (_stop_tx, stop_rx) = watch::channel(None);
        let res = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx).await;

        assert!(matches!(res, Err(AcquireError::Conflict(msg)) if msg.contains("other-job-123")));
        assert_eq!(server.recorded.lock().len(), 0);
    }

    #[tokio::test]
    async fn test_error_boundary_stop_during_successful_claim_preserves_payload() {
        let temp = tempdir().unwrap();
        let (ws, binding, runner) = setup_workspace(temp.path(), true);
        let key_path = write_key_file(temp.path());

        let (stop_tx, stop_rx) = watch::channel(None);
        let stop_tx = Arc::new(stop_tx);

        let server = spawn_server(Box::new(move |req| {
            // Signal stop while claim request is in flight
            let _ = stop_tx.send(Some(StopReason::UserRequested));

            let req_body: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
            let attempt_id = req_body.get("attempt_id").unwrap().as_str().unwrap();
            let worker_id = req_body.get("worker_id").unwrap().as_str().unwrap();
            Action::Respond {
                status: 200,
                headers: vec![("content-type".into(), "application/json".into())],
                body: make_claimed_response(JOB, attempt_id, worker_id),
            }
        }))
        .await;

        let client = test_client(&server.url, &key_path);
        let mut state = BridgeState::new(binding.clone());

        let outcome = acquire_one(&runner, &client, &ws, &mut state, JOB, &stop_rx)
            .await
            .unwrap();

        assert_eq!(outcome, AcquireOutcome::Stopped(StopReason::UserRequested));
        // Preserved confirmed claim payload intact on disk
        let reloaded = BridgeState::load(&state_path(&ws), &binding).unwrap();
        let act = reloaded.active.unwrap();
        assert_eq!(act.phase, LocalPhase::Claimed);
        assert!(act.claim.unwrap().verify_integrity());
    }
}
