//! Controller + real Runner against an isolated mock HTTP server.
//!
//! These tests drive `Worker::run` with the hermetic test_stub executor. The
//! mock speaks the persistent-assignment protocol but never puts `claim_token`
//! in a response or a failure message.

use ceo_worker::bridge::client::BridgeClient;
use ceo_worker::bridge::config::{load_api_key, BridgeConfig, ExpectedIdentity};
use ceo_worker::bridge::controller::Worker;
use ceo_worker::bridge::outbox::PendingReportRecord;
use ceo_worker::bridge::protocol::ClaimedJob;
use ceo_worker::bridge::state::{
    self, ActiveAttempt, AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase,
};
use ceo_worker::config::{ExecutorType, WorkerConfig};
use ceo_worker::receipt::TaskReceipt;
use ceo_worker::runner::{Runner, StopReason};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::watch;

const USER: &str = "usr_alice";
const WS_ID: &str = "ws_alpha";
const JOB1: &str = "job-123e4567-e89b-12d3-a456-426614174001";
const JOB2: &str = "job-123e4567-e89b-12d3-a456-426614174002";
const CLAIMED_AT: &str = "2026-09-07T00:00:00Z";
const STARTED_AT: &str = "2026-09-07T00:00:02Z";
const SERVER_TIME: &str = "2026-09-07T00:00:00Z";

#[derive(Clone, Copy)]
enum StartMode {
    Ok,
    Drop,
    HoldSilent,
}

#[derive(Clone)]
struct RecordedRequest {
    target: String,
    body: Vec<u8>,
}

enum Action {
    Respond { body: String },
    DropConnection,
    HoldSilent,
}

struct ClaimedInfo {
    job_id: String,
    attempt_id: String,
}

struct MockInner {
    recorded: Mutex<Vec<RecordedRequest>>,
    tokens: Mutex<BTreeMap<String, String>>,
    claimed: Mutex<Vec<ClaimedInfo>>,
    jobs: Vec<String>,
    start_mode: StartMode,
    isolate_after_start: bool,
    isolate: AtomicBool,
    token_mismatch: AtomicBool,
    second_claim_first_done: Mutex<Option<bool>>,
    report_drop: AtomicBool,
    reported: Mutex<Vec<String>>,
    workspace: PathBuf,
}

struct Server {
    url: String,
    inner: Arc<MockInner>,
}

fn json_headers() -> String {
    "content-type: application/json".to_string()
}

fn hex64_token(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn json_field(body: &[u8], name: &str) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()?
        .get(name)?
        .as_str()
        .map(str::to_string)
}

fn job_id_from_target(target: &str) -> Option<String> {
    let path = target.split('?').next().unwrap_or(target);
    let parts: Vec<&str> = path.split('/').collect();
    // /api/worker/jobs/{job_id}/claim|start
    if parts.len() >= 6 && parts[1] == "api" && parts[2] == "worker" && parts[3] == "jobs" {
        Some(parts[4].to_string())
    } else {
        None
    }
}

fn query_after(target: &str) -> String {
    target
        .split('?')
        .nth(1)
        .unwrap_or("")
        .split('&')
        .find_map(|p| p.strip_prefix("after="))
        .unwrap_or("0-0")
        .to_string()
}

fn pending_job_json(job_id: &str) -> String {
    format!(
        r#"{{"job_id":"{job_id}","workspace_ref":"tools","resource_id":null,"created_at":"2026-09-07T00:00:00Z","expires_at":"2026-09-14T00:00:00Z"}}"#
    )
}

fn pending_body(target: &str, jobs: &[String]) -> String {
    let after = query_after(target);
    if after == "0-0" {
        let items: Vec<String> = jobs.iter().map(|id| pending_job_json(id)).collect();
        format!(
            r#"{{"ok":true,"jobs":[{}],"next_cursor":"1788-1","has_more":false}}"#,
            items.join(",")
        )
    } else {
        r#"{"ok":true,"jobs":[],"next_cursor":"1788-1","has_more":false}"#.to_string()
    }
}

fn claimed_job_json(job_id: &str) -> String {
    format!(
        r#"{{"job_id":"{job_id}","workspace_ref":"tools","resource_id":null,"prompt":"do the thing","acceptance":"thing done","timeout_seconds":120,"result_target":"none"}}"#
    )
}

fn exec_json(worker_id: &str, attempt_id: &str, running: bool) -> String {
    if running {
        format!(
            r#"{{"worker_id":"{worker_id}","attempt_id":"{attempt_id}","phase":"running","claimed_at":"{CLAIMED_AT}","started_at":"{STARTED_AT}"}}"#
        )
    } else {
        format!(
            r#"{{"worker_id":"{worker_id}","attempt_id":"{attempt_id}","phase":"claimed","claimed_at":"{CLAIMED_AT}","started_at":null}}"#
        )
    }
}

fn claim_ok_json(job_id: &str, worker_id: &str, attempt_id: &str) -> String {
    format!(
        r#"{{"ok":true,"replayed":false,"server_time":"{SERVER_TIME}","job":{},"execution":{}}}"#,
        claimed_job_json(job_id),
        exec_json(worker_id, attempt_id, false)
    )
}

fn start_ok_json(worker_id: &str, attempt_id: &str) -> String {
    format!(
        r#"{{"ok":true,"replayed":false,"server_time":"{SERVER_TIME}","execution":{}}}"#,
        exec_json(worker_id, attempt_id, true)
    )
}

fn decide(inner: &MockInner, req: &RecordedRequest) -> Action {
    if inner.isolate.load(Ordering::SeqCst)
        && !req.target.contains("/report")
        && !req.target.starts_with("/api/identity")
    {
        return Action::DropConnection;
    }
    if req.target.starts_with("/api/identity") {
        return Action::Respond {
            body: format!(
                r#"{{"user_id":"{USER}","workspace_id":"{WS_ID}","deployment_mode":"single_user"}}"#
            ),
        };
    }
    if req.target.contains("/api/worker/jobs/pending") {
        return Action::Respond {
            body: pending_body(&req.target, &inner.jobs),
        };
    }
    if req.target.contains("/claim") {
        return handle_claim(inner, req);
    }
    if req.target.contains("/start") {
        return handle_start(inner, req);
    }
    if req.target.contains("/report") {
        return handle_report(inner, req);
    }
    Action::Respond {
        body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
    }
}

fn public_state(status: &str) -> &'static str {
    match status {
        "COMPLETED" => "completed",
        "FAILED" => "failed",
        "TIMED_OUT" => "timed_out",
        "CANCELLED" => "cancelled",
        "BLOCKED" => "blocked",
        "INTERRUPTED" => "interrupted",
        _ => "completed",
    }
}

fn handle_report(inner: &MockInner, req: &RecordedRequest) -> Action {
    if inner.report_drop.load(Ordering::SeqCst) {
        return Action::DropConnection;
    }
    let Some(job_id) = job_id_from_target(&req.target) else {
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    };
    let body: serde_json::Value = serde_json::from_slice(&req.body).unwrap_or_default();
    let attempt_id = body
        .get("attempt_id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let status = body
        .pointer("/report/execution_status")
        .and_then(|v| v.as_str())
        .unwrap_or("COMPLETED");
    inner.reported.lock().push(job_id.clone());
    Action::Respond {
        body: format!(
            r#"{{"ok":true,"job_id":"{job_id}","attempt_id":"{attempt_id}","state":"{}","report_received":true,"received_at":"2026-09-13T00:00:00.000Z","replayed":false}}"#,
            public_state(status)
        ),
    }
}

fn handle_claim(inner: &MockInner, req: &RecordedRequest) -> Action {
    let Some(job_id) = job_id_from_target(&req.target) else {
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    };
    let Some(token) = json_field(&req.body, "claim_token") else {
        inner.token_mismatch.store(true, Ordering::SeqCst);
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    };
    if !hex64_token(&token) {
        inner.token_mismatch.store(true, Ordering::SeqCst);
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    }
    let worker_id = json_field(&req.body, "worker_id").unwrap_or_default();
    let attempt_id = json_field(&req.body, "attempt_id").unwrap_or_default();

    let mut tokens = inner.tokens.lock();
    let mut claimed = inner.claimed.lock();
    if let Some(existing) = tokens.get(&job_id) {
        if existing != &token {
            inner.token_mismatch.store(true, Ordering::SeqCst);
        }
    } else {
        if !claimed.is_empty() {
            let first = &claimed[0];
            *inner.second_claim_first_done.lock() = Some(job_terminal(
                &inner.workspace,
                &first.job_id,
                &first.attempt_id,
            ));
        }
        tokens.insert(job_id.clone(), token);
        claimed.push(ClaimedInfo {
            job_id: job_id.clone(),
            attempt_id: attempt_id.clone(),
        });
    }
    drop(tokens);
    drop(claimed);

    Action::Respond {
        body: claim_ok_json(&job_id, &worker_id, &attempt_id),
    }
}

fn handle_start(inner: &MockInner, req: &RecordedRequest) -> Action {
    let Some(job_id) = job_id_from_target(&req.target) else {
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    };
    let Some(token) = json_field(&req.body, "claim_token") else {
        inner.token_mismatch.store(true, Ordering::SeqCst);
        return Action::Respond {
            body: r#"{"ok":false,"code":"INVALID_INPUT"}"#.to_string(),
        };
    };
    match inner.tokens.lock().entry(job_id.clone()) {
        std::collections::btree_map::Entry::Occupied(existing) => {
            if existing.get() != &token {
                inner.token_mismatch.store(true, Ordering::SeqCst);
            }
        }
        std::collections::btree_map::Entry::Vacant(vacant) => {
            vacant.insert(token);
        }
    }
    let worker_id = json_field(&req.body, "worker_id").unwrap_or_default();
    let attempt_id = json_field(&req.body, "attempt_id").unwrap_or_default();
    match inner.start_mode {
        StartMode::Drop => Action::DropConnection,
        StartMode::HoldSilent => Action::HoldSilent,
        StartMode::Ok => Action::Respond {
            body: start_ok_json(&worker_id, &attempt_id),
        },
    }
}

async fn spawn_server(inner: Arc<MockInner>) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let recorded = inner.clone();
    tokio::spawn(async move {
        loop {
            let (mut sock, _) = match listener.accept().await {
                Ok(v) => v,
                Err(_) => break,
            };
            let inner = recorded.clone();
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut buf = [0u8; 2048];
                let header_end = loop {
                    if let Some(pos) = head.windows(4).position(|w| w == b"\r\n\r\n") {
                        break pos + 4;
                    }
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => head.extend_from_slice(&buf[..n]),
                    }
                };
                let head_str = String::from_utf8_lossy(&head[..header_end]).to_string();
                let mut lines = head_str.split("\r\n");
                let request_line = lines.next().unwrap_or_default().to_string();
                let mut headers: BTreeMap<String, String> = BTreeMap::new();
                for l in lines {
                    if let Some((k, v)) = l.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
                let content_len: usize = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut body = Vec::new();
                if content_len > 0 {
                    let initial_body = &head[header_end..];
                    let initial_len = initial_body.len().min(content_len);
                    body.extend_from_slice(&initial_body[..initial_len]);
                    while body.len() < content_len {
                        let mut rest = vec![0u8; content_len - body.len()];
                        let n = sock.read(&mut rest).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        body.extend_from_slice(&rest[..n]);
                    }
                }
                let target = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let req = RecordedRequest { target, body };
                inner.recorded.lock().push(req.clone());
                let was_start = req.target.contains("/start");
                match decide(&inner, &req) {
                    Action::DropConnection => {
                        let _ = sock.shutdown().await;
                    }
                    Action::HoldSilent => {
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let _ = sock.shutdown().await;
                    }
                    Action::Respond { body } => {
                        let head = format!(
                            "HTTP/1.1 200 OK\r\n{}\r\ncontent-length: {}\r\n\r\n",
                            json_headers(),
                            body.len()
                        );
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.write_all(body.as_bytes()).await;
                        let _ = sock.flush().await;
                        if was_start && inner.isolate_after_start {
                            inner.isolate.store(true, Ordering::SeqCst);
                        }
                    }
                }
            });
        }
    });
    Server {
        url: format!("http://127.0.0.1:{}/", addr.port()),
        inner,
    }
}

fn count_hits(server: &Server, needle: &str) -> usize {
    server
        .inner
        .recorded
        .lock()
        .iter()
        .filter(|r| r.target.contains(needle))
        .count()
}

fn pending_after_start(server: &Server) -> usize {
    let rec = server.inner.recorded.lock();
    let Some(start_idx) = rec.iter().position(|r| r.target.contains("/start")) else {
        return 0;
    };
    rec[start_idx + 1..]
        .iter()
        .filter(|r| r.target.contains("/pending"))
        .count()
}

fn stub_bin() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("test_stub.sh")
}

fn prepare_workspace(root: &Path, stub_mode: &str) -> PathBuf {
    let ws = root.join("workspace");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(
        ws.join("AGENTS.md"),
        "# Guidelines\n\n<!-- ceo:metadata rule_marker: \"CTL-RUN\" -->\n\nrespect.\n",
    )
    .unwrap();
    std::fs::write(ws.join(".stub_mode"), stub_mode).unwrap();
    ws.canonicalize().unwrap()
}

fn write_bridge_config(dir: &Path, server_url: &str, workspace: &Path) -> PathBuf {
    let key_path = dir.join("key");
    std::fs::write(&key_path, "test-secret-key\n").unwrap();
    std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let cfg_path = dir.join("bridge.json");
    let cfg = serde_json::json!({
        "schema_version": 1,
        "server_url": server_url.trim_end_matches('/'),
        "api_key_file": key_path,
        "expected_identity": { "user_id": USER, "workspace_id": WS_ID },
        "workspaces": { "tools": workspace },
    });
    std::fs::write(&cfg_path, serde_json::to_string_pretty(&cfg).unwrap()).unwrap();
    cfg_path
}

fn find_receipt(workspace: &Path, job_id: &str) -> Option<PathBuf> {
    let attempts = workspace
        .join(".ceo")
        .join("jobs")
        .join(job_id)
        .join("attempts");
    let rd = std::fs::read_dir(attempts).ok()?;
    for entry in rd.flatten() {
        let p = entry.path().join("receipt.json");
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

fn load_receipt(workspace: &Path, job_id: &str) -> Option<TaskReceipt> {
    let p = find_receipt(workspace, job_id)?;
    serde_json::from_slice(&std::fs::read(p).ok()?).ok()
}

fn state_active_cleared(workspace: &Path) -> bool {
    let p = state::state_path(workspace);
    let Ok(text) = std::fs::read_to_string(p) else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    v.get("active").is_some_and(|a| a.is_null())
}

fn job_terminal(workspace: &Path, job_id: &str, attempt_id: &str) -> bool {
    let Some(p) = find_receipt(workspace, job_id) else {
        return false;
    };
    let Ok(receipt) = serde_json::from_slice::<TaskReceipt>(&std::fs::read(p).unwrap_or_default())
    else {
        return false;
    };
    if receipt.job_id != job_id || receipt.attempt_id != attempt_id {
        return false;
    }
    matches!(
        AttemptHistoryRecord::load(workspace, job_id, attempt_id),
        Ok(Some(_))
    ) && !state::outbox_record_path(workspace, job_id, attempt_id).is_file()
}

fn job_completed(workspace: &Path, job_id: &str) -> bool {
    let Some(receipt) = load_receipt(workspace, job_id) else {
        return false;
    };
    receipt.execution_status == "COMPLETED"
        && matches!(
            AttemptHistoryRecord::load(workspace, job_id, &receipt.attempt_id),
            Ok(Some(_))
        )
        && !state::outbox_record_path(workspace, job_id, &receipt.attempt_id).is_file()
}

fn attempt_count(workspace: &Path, job_id: &str) -> usize {
    let attempts = workspace
        .join(".ceo")
        .join("jobs")
        .join(job_id)
        .join("attempts");
    match std::fs::read_dir(attempts) {
        Ok(rd) => rd.flatten().count(),
        Err(_) => 0,
    }
}

async fn wait_until(timeout: Duration, mut pred: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    pred()
}

struct Running {
    server: Server,
    workspace: PathBuf,
    stop_tx: watch::Sender<Option<StopReason>>,
    handle: Option<tokio::task::JoinHandle<i32>>,
    _tmp: tempfile::TempDir,
}

async fn start_harness(
    jobs: Vec<String>,
    start_mode: StartMode,
    isolate_after_start: bool,
    stub_mode: &str,
) -> Running {
    start_harness_with(jobs, start_mode, isolate_after_start, stub_mode, |_, _| {}).await
}

#[allow(clippy::field_reassign_with_default)]
async fn start_harness_with(
    jobs: Vec<String>,
    start_mode: StartMode,
    isolate_after_start: bool,
    stub_mode: &str,
    seed: impl FnOnce(&Path, &str),
) -> Running {
    let tmp = tempfile::tempdir().unwrap();
    let workspace = prepare_workspace(tmp.path(), stub_mode);
    let inner = Arc::new(MockInner {
        recorded: Mutex::new(Vec::new()),
        tokens: Mutex::new(BTreeMap::new()),
        claimed: Mutex::new(Vec::new()),
        jobs,
        start_mode,
        isolate_after_start,
        isolate: AtomicBool::new(false),
        token_mismatch: AtomicBool::new(false),
        second_claim_first_done: Mutex::new(None),
        report_drop: AtomicBool::new(false),
        reported: Mutex::new(Vec::new()),
        workspace: workspace.clone(),
    });
    let server = spawn_server(inner).await;
    let cfg_path = write_bridge_config(tmp.path(), &server.url, &workspace);
    let cfg = BridgeConfig::load(&cfg_path).unwrap();
    let origin = cfg.server_base.as_str().trim_end_matches('/');
    seed(&workspace, origin);
    let key = load_api_key(&cfg.api_key_file).unwrap();
    let client = BridgeClient::new(cfg.server_base.clone(), key).unwrap();
    let mut wcfg = WorkerConfig::default();
    wcfg.workspace_dir = workspace.clone();
    wcfg.executor_type = ExecutorType::TestStub;
    wcfg.agent_executable = stub_bin();
    wcfg.doctor_timeout_secs = 30;
    let runner = Runner::new(wcfg, None);
    let expected = ExpectedIdentity {
        user_id: USER.to_string(),
        workspace_id: WS_ID.to_string(),
    };
    let mut worker = Worker::new(
        &cfg,
        expected,
        "tools",
        workspace.clone(),
        client,
        runner,
        String::new(),
    );
    let (stop_tx, stop_rx) = watch::channel(None);
    let handle = tokio::spawn(async move { worker.run(stop_rx).await });
    Running {
        server,
        workspace,
        stop_tx,
        handle: Some(handle),
        _tmp: tmp,
    }
}

async fn stop_after_success(run: &mut Running, job_ids: &[&str]) -> i32 {
    let ws = run.workspace.clone();
    let jobs: Vec<String> = job_ids.iter().map(|s| (*s).to_string()).collect();
    assert!(
        wait_until(Duration::from_secs(60), || {
            jobs.iter().all(|j| job_completed(&ws, j)) && state_active_cleared(&ws)
        })
        .await,
        "receipt+history+cleared active not observed"
    );
    let _ = run.stop_tx.send(Some(StopReason::UserRequested));
    run.handle.take().unwrap().await.unwrap()
}

fn assert_no_token_leak(server: &Server) {
    assert!(
        !server.inner.token_mismatch.load(Ordering::SeqCst),
        "claim/start token mismatch"
    );
}

#[tokio::test]
async fn start_drop_still_completes_locally() {
    let mut run = start_harness(vec![JOB1.to_string()], StartMode::Drop, false, "normal").await;
    let code = stop_after_success(&mut run, &[JOB1]).await;
    assert_eq!(code, 0);
    assert_no_token_leak(&run.server);
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt");
    assert_eq!(receipt.execution_status, "COMPLETED");
    assert!(count_hits(&run.server, "/start") >= 1);
    assert!(
        !state::outbox_record_path(&run.workspace, JOB1, &receipt.attempt_id).is_file(),
        "outbox should be ACK-cleared after automatic delivery"
    );
    assert!(count_hits(&run.server, "/report") >= 1);
    assert!(run.server.inner.reported.lock().iter().any(|j| j == JOB1));
}

#[tokio::test]
async fn cancel_during_start_does_not_dispatch() {
    let mut run = start_harness(
        vec![JOB1.to_string()],
        StartMode::HoldSilent,
        false,
        "hang_task",
    )
    .await;
    assert!(
        wait_until(Duration::from_secs(45), || count_hits(
            &run.server,
            "/start"
        ) >= 1)
        .await,
        "start was never issued"
    );
    let _ = run.stop_tx.send(Some(StopReason::UserRequested));
    let code = run.handle.take().unwrap().await.unwrap();
    assert_eq!(code, 0);
    assert_no_token_leak(&run.server);
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt after cancel");
    assert_eq!(receipt.execution_status, "CANCELLED");
    let bc = receipt.bridge_context.expect("bridge context");
    assert!(
        !bc.task_dispatch_intent,
        "permit must not have been granted during start cancel"
    );
}

#[tokio::test]
async fn network_drop_after_start_retries_pending() {
    let mut run = start_harness(vec![JOB1.to_string()], StartMode::Ok, true, "normal").await;
    let ws = run.workspace.clone();
    assert!(
        wait_until(Duration::from_secs(60), || job_completed(&ws, JOB1)
            && state_active_cleared(&ws))
        .await,
        "local completion not observed after start"
    );
    assert!(
        wait_until(Duration::from_secs(20), || pending_after_start(&run.server)
            >= 2)
        .await,
        "pending disconnect + retry not observed"
    );
    let _ = run.stop_tx.send(Some(StopReason::UserRequested));
    let code = run.handle.take().unwrap().await.unwrap();
    assert_eq!(code, 0);
    assert_no_token_leak(&run.server);
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt");
    assert_eq!(receipt.execution_status, "COMPLETED");
}

#[tokio::test]
async fn two_jobs_run_in_order() {
    let mut run = start_harness(
        vec![JOB1.to_string(), JOB2.to_string()],
        StartMode::Ok,
        false,
        "normal",
    )
    .await;
    let code = stop_after_success(&mut run, &[JOB1, JOB2]).await;
    assert_eq!(code, 0);
    assert_no_token_leak(&run.server);
    assert_eq!(
        *run.server.inner.second_claim_first_done.lock(),
        Some(true),
        "second claim arrived before the first job's receipt and history"
    );
    let r1 = load_receipt(&run.workspace, JOB1).expect("job1 receipt");
    let r2 = load_receipt(&run.workspace, JOB2).expect("job2 receipt");
    assert_eq!(r1.execution_status, "COMPLETED");
    assert_eq!(r2.execution_status, "COMPLETED");
}

#[tokio::test]
async fn startup_recovers_claimed_without_reclaim() {
    let seeded_attempt = state::new_attempt_id();
    let seeded_token = "ab".repeat(32);
    let mut run = start_harness_with(
        vec![JOB1.to_string()],
        StartMode::Ok,
        false,
        "normal",
        |ws, origin| {
            let binding = BridgeBinding {
                server_origin: origin.to_string(),
                user_id: USER.to_string(),
                workspace_id: WS_ID.to_string(),
                workspace_ref: "tools".to_string(),
                canonical_workspace: ws.to_path_buf(),
            };
            let job = ClaimedJob {
                job_id: JOB1.to_string(),
                workspace_ref: "tools".to_string(),
                resource_id: None,
                prompt: "do the thing".to_string(),
                acceptance: "thing done".to_string(),
                timeout_seconds: 120,
                result_target: ceo_worker::bridge::protocol::ResultTarget::None,
            };
            let mut st = BridgeState::new(binding);
            st.worker_id = "wrk-123e4567-e89b-12d3-a456-426614174000".to_string();
            st.active = Some(ActiveAttempt {
                job_id: JOB1.to_string(),
                attempt_id: seeded_attempt.clone(),
                claim_token: seeded_token.clone(),
                phase: LocalPhase::Claimed,
                claim: Some(ClaimPayload::from_wire(&job)),
                runner_boot_id: None,
                process: None,
                task_dispatch_intent: false,
                stop_error: None,
            });
            st.persist(ws).unwrap();
        },
    )
    .await;
    let code = stop_after_success(&mut run, &[JOB1]).await;
    assert_eq!(code, 0);
    assert_no_token_leak(&run.server);
    assert_eq!(
        count_hits(&run.server, "/claim"),
        0,
        "claimed recovery must not POST claim"
    );
    assert!(
        count_hits(&run.server, "/start") >= 1,
        "claimed recovery must POST start"
    );
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt");
    assert_eq!(receipt.execution_status, "COMPLETED");
    assert_eq!(receipt.attempt_id, seeded_attempt);
}

#[tokio::test]
#[allow(clippy::field_reassign_with_default)]
async fn startup_reconstructs_missing_outbox_without_rerun() {
    let mut run = start_harness(vec![JOB1.to_string()], StartMode::Ok, false, "normal").await;
    let code = stop_after_success(&mut run, &[JOB1]).await;
    assert_eq!(code, 0);
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt");
    let attempt = receipt.attempt_id.clone();
    let starts_before = count_hits(&run.server, "/start");
    let attempts_before = attempt_count(&run.workspace, JOB1);
    let outbox = state::outbox_record_path(&run.workspace, JOB1, &attempt);
    let _ = std::fs::remove_file(&outbox);

    let hist = AttemptHistoryRecord::load(&run.workspace, JOB1, &attempt)
        .unwrap()
        .expect("history");
    let cfg_path = run.workspace.parent().unwrap().join("bridge.json");
    let cfg = BridgeConfig::load(&cfg_path).unwrap();
    let bind = BridgeBinding {
        server_origin: cfg.server_base.as_str().trim_end_matches('/').to_string(),
        user_id: USER.to_string(),
        workspace_id: WS_ID.to_string(),
        workspace_ref: "tools".to_string(),
        canonical_workspace: run.workspace.clone(),
    };
    let mut st = BridgeState::load(&state::state_path(&run.workspace), &bind).unwrap();
    st.active = Some(ActiveAttempt {
        job_id: JOB1.to_string(),
        attempt_id: attempt.clone(),
        claim_token: hist.claim_token.clone(),
        phase: LocalPhase::DispatchIntent,
        claim: None,
        runner_boot_id: None,
        process: None,
        task_dispatch_intent: hist.task_dispatch_intent,
        stop_error: None,
    });
    st.persist(&run.workspace).unwrap();

    let key = load_api_key(&cfg.api_key_file).unwrap();
    let client = BridgeClient::new(cfg.server_base.clone(), key).unwrap();
    #[allow(clippy::field_reassign_with_default)]
    let mut wcfg = WorkerConfig::default();
    wcfg.workspace_dir = run.workspace.clone();
    wcfg.executor_type = ExecutorType::TestStub;
    wcfg.agent_executable = stub_bin();
    wcfg.doctor_timeout_secs = 30;
    let runner = Runner::new(wcfg, None);
    let expected = ExpectedIdentity {
        user_id: USER.to_string(),
        workspace_id: WS_ID.to_string(),
    };
    let mut worker = Worker::new(
        &cfg,
        expected,
        "tools",
        run.workspace.clone(),
        client,
        runner,
        String::new(),
    );
    let (stop_tx, stop_rx) = watch::channel(None);
    let handle = tokio::spawn(async move { worker.run(stop_rx).await });
    let ws = run.workspace.clone();
    let outbox_check = outbox.clone();
    assert!(
        wait_until(Duration::from_secs(20), || {
            state_active_cleared(&ws) && !outbox_check.is_file()
        })
        .await,
        "startup did not reconstruct, deliver, and clear active"
    );
    let _ = stop_tx.send(Some(StopReason::UserRequested));
    assert_eq!(handle.await.unwrap(), 0);
    assert_eq!(attempt_count(&run.workspace, JOB1), attempts_before);
    assert_eq!(count_hits(&run.server, "/start"), starts_before);
    let loaded = PendingReportRecord::try_load(&run.workspace, JOB1, &attempt, &bind).unwrap();
    assert!(loaded.is_none(), "delivered pending should be removed");
}

#[tokio::test]
#[allow(clippy::field_reassign_with_default)]
async fn restart_delivers_pending_without_rerunning_agent() {
    let mut run = start_harness(vec![JOB1.to_string()], StartMode::Ok, false, "normal").await;
    run.server.inner.report_drop.store(true, Ordering::SeqCst);
    let ws = run.workspace.clone();
    assert!(
        wait_until(Duration::from_secs(60), || {
            load_receipt(&ws, JOB1).is_some()
                && state_active_cleared(&ws)
                && count_hits(&run.server, "/report") >= 1
        })
        .await,
        "local completion with failed report not observed"
    );
    let receipt = load_receipt(&run.workspace, JOB1).expect("receipt");
    let attempt = receipt.attempt_id.clone();
    let outbox = state::outbox_record_path(&run.workspace, JOB1, &attempt);
    assert!(outbox.is_file(), "pending must remain after report drop");
    let starts_before = count_hits(&run.server, "/start");
    let attempts_before = attempt_count(&run.workspace, JOB1);
    let _ = run.stop_tx.send(Some(StopReason::UserRequested));
    assert_eq!(run.handle.take().unwrap().await.unwrap(), 0);
    assert!(outbox.is_file());

    run.server.inner.report_drop.store(false, Ordering::SeqCst);
    let cfg = BridgeConfig::load(&run.workspace.parent().unwrap().join("bridge.json")).unwrap();
    let key = load_api_key(&cfg.api_key_file).unwrap();
    let client = BridgeClient::new(cfg.server_base.clone(), key).unwrap();
    let mut wcfg = WorkerConfig::default();
    wcfg.workspace_dir = run.workspace.clone();
    wcfg.executor_type = ExecutorType::TestStub;
    wcfg.agent_executable = stub_bin();
    wcfg.doctor_timeout_secs = 30;
    let runner = Runner::new(wcfg, None);
    let mut worker = Worker::new(
        &cfg,
        ExpectedIdentity {
            user_id: USER.to_string(),
            workspace_id: WS_ID.to_string(),
        },
        "tools",
        run.workspace.clone(),
        client,
        runner,
        String::new(),
    );
    let (stop_tx, stop_rx) = watch::channel(None);
    let handle = tokio::spawn(async move { worker.run(stop_rx).await });
    let outbox_check = outbox.clone();
    assert!(
        wait_until(Duration::from_secs(20), || !outbox_check.is_file()).await,
        "restart did not deliver pending report"
    );
    let _ = stop_tx.send(Some(StopReason::UserRequested));
    assert_eq!(handle.await.unwrap(), 0);
    assert_eq!(attempt_count(&run.workspace, JOB1), attempts_before);
    assert_eq!(count_hits(&run.server, "/start"), starts_before);
    assert!(run.server.inner.reported.lock().iter().any(|j| j == JOB1));
}
