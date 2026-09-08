//! Client behaviours against an isolated local HTTP server. No real server or
//! Redis is involved here; the cross-language acceptance in CI exercises the
//! compiled `bridge check` against a real Server + Redis.

use ceo_worker::bridge::client::{BridgeClient, ErrorKind};
use ceo_worker::bridge::config::load_api_key;
use ceo_worker::bridge::protocol::{ClaimRequest, LeaseOperationRequest};
use parking_lot::Mutex;
use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const WRK: &str = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const ATT: &str = "123e4567-e89b-12d3-a456-4266141740ab";
const JOB: &str = "job-123e4567-e89b-12d3-a456-426614174001";
const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[derive(Clone)]
struct RecordedRequest {
    target: String,
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
    /// Accept + read the request, then close without answering.
    DropConnection,
    /// Accept + read the request, then hold the socket open without sending any
    /// bytes for a while (server received the request but never replied).
    HoldSilent,
    /// Write the response headers then stop (never finish the body).
    HeadersThenStop,
}

type Handler = Box<dyn Fn(&RecordedRequest) -> Action + Send + Sync>;

struct Server {
    url: String,
    recorded: Arc<Mutex<Vec<RecordedRequest>>>,
}

async fn spawn_server(handler: Handler) -> Server {
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
                    let have = header_end;
                    if head.len() < have + content_len {
                        let need = have + content_len - head.len();
                        let mut rest = vec![0u8; need];
                        let mut read = 0;
                        while read < need {
                            let n = sock.read(&mut rest[read..]).await.unwrap_or(0);
                            if n == 0 {
                                break;
                            }
                            read += n;
                        }
                        body.extend_from_slice(&rest[..read]);
                    } else {
                        body.extend_from_slice(&head[have..have + content_len]);
                    }
                }
                let target = request_line
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let req = RecordedRequest {
                    target,
                    headers,
                    body,
                };
                rec.lock().push(req.clone());
                match (handler.as_ref())(&req) {
                    Action::DropConnection => {
                        let _ = sock.shutdown().await;
                    }
                    Action::HoldSilent => {
                        // Never respond; hold the connection open briefly so the
                        // client observes a timeout rather than a clean close.
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let _ = sock.shutdown().await;
                    }
                    Action::HeadersThenStop => {
                        let head = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 100000\r\n\r\n";
                        let _ = sock.write_all(head.as_bytes()).await;
                        let _ = sock.flush().await;
                        // Never send the body; hold open so the client times out.
                        tokio::time::sleep(Duration::from_secs(4)).await;
                        let _ = sock.shutdown().await;
                    }
                    Action::Respond {
                        status,
                        headers,
                        body,
                    } => {
                        let mut out = format!("HTTP/1.1 {status} OK\r\n");
                        for (k, v) in headers {
                            out.push_str(&format!("{k}: {v}\r\n"));
                        }
                        out.push_str(&format!("content-length: {}\r\n\r\n", body.len()));
                        let _ = sock.write_all(out.as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                        let _ = sock.flush().await;
                    }
                }
            });
        }
    });
    Server {
        url: format!("http://127.0.0.1:{}/", addr.port()),
        recorded,
    }
}

fn json_response(body: &str) -> Action {
    Action::Respond {
        status: 200,
        headers: vec![("content-type".into(), "application/json".into())],
        body: body.as_bytes().to_vec(),
    }
}

fn status_json(status: u16, body: &str) -> Action {
    Action::Respond {
        status,
        headers: vec![("content-type".into(), "application/json".into())],
        body: body.as_bytes().to_vec(),
    }
}

/// Builds a client whose API key comes from a real, mode-0600 key file.
fn client(url: &str) -> BridgeClient {
    client_with(url, Duration::from_secs(3), Duration::from_secs(8))
}

fn client_with(url: &str, connect: Duration, total: Duration) -> BridgeClient {
    let dir = tempfile::tempdir().unwrap();
    let key_path = dir.path().join("key");
    std::fs::write(&key_path, "test-secret-key\n").unwrap();
    std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let key = load_api_key(&key_path).unwrap();
    BridgeClient::new_with_timeouts(url.parse().unwrap(), key, connect, total).unwrap()
}

const IDENTITY_OK: &str =
    r#"{"user_id":"usr_alice","workspace_id":"ws_alpha","deployment_mode":"single_user"}"#;

const CLAIMED_TIMES: &str = r#""claimed_at":"2026-09-07T00:00:00Z","start_deadline":"2026-09-07T00:05:00Z","lease_expires_at":"2026-09-07T00:01:30Z""#;

/// A valid claimed-phase execution sub-object for the standard worker/attempt.
fn claimed_exec_json() -> String {
    format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed",{CLAIMED_TIMES},"started_at":null,"execution_deadline":null}}"#
    )
}

/// A valid running-phase execution for the standard worker/attempt (started at
/// +2 s, execution_deadline = started + 120 s).
fn running_exec_json() -> String {
    format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2026-09-07T00:00:00Z","start_deadline":"2026-09-07T00:05:00Z","started_at":"2026-09-07T00:00:02Z","lease_expires_at":"2026-09-07T00:01:32Z","execution_deadline":"2026-09-07T00:02:02Z"}}"#
    )
}

fn claim_job_json() -> String {
    format!(
        r#"{{"job_id":"{JOB}","workspace_ref":"tools","resource_id":null,"prompt":"do the thing","acceptance":"thing done","timeout_seconds":120}}"#
    )
}

/// A fully valid fresh (replayed=false, claimed) claim response.
fn claim_ok_claimed() -> String {
    format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        claimed_exec_json()
    )
}

fn pending_json(body: &str) -> String {
    format!(r#"{{"ok":true,"jobs":[{body}],"next_cursor":"1788-1","has_more":true}}"#)
}

fn claim_request() -> ClaimRequest {
    ClaimRequest {
        worker_id: WRK.into(),
        attempt_id: ATT.into(),
        workspace_ref: "tools".into(),
        lease_token: TOKEN.into(),
    }
}

fn lease_request() -> LeaseOperationRequest {
    LeaseOperationRequest {
        worker_id: WRK.into(),
        attempt_id: ATT.into(),
        lease_token: TOKEN.into(),
    }
}

fn count_hits(server: &Server, needle: &str) -> usize {
    server
        .recorded
        .lock()
        .iter()
        .filter(|r| r.target.contains(needle))
        .count()
}

fn sent_token(server: &Server, needle: &str) -> bool {
    server
        .recorded
        .lock()
        .iter()
        .filter(|r| r.target.contains(needle))
        .any(|r| {
            serde_json::from_slice::<serde_json::Value>(&r.body)
                .map(|v| v["lease_token"] == serde_json::Value::String(TOKEN.into()))
                .unwrap_or(false)
        })
}

// ---------------------------------------------------------------------------
// Normal (valid) client behaviours
// ---------------------------------------------------------------------------

#[tokio::test]
async fn pending_parses_discovered_jobs_and_sends_bearer_key() {
    let server = spawn_server(Box::new(move |_req| {
        json_response(&pending_json(
            r#"{"job_id":"job-123e4567-e89b-12d3-a456-426614174001","workspace_ref":"tools","resource_id":null,"created_at":"2026-09-07T00:00:00Z","expires_at":"2026-09-14T00:00:00Z"}"#,
        ))
    }))
    .await;
    let c = client(&server.url);
    let p = c.pending("tools", "0-0").await.unwrap();
    assert_eq!(p.jobs.len(), 1);
    assert_eq!(p.jobs[0].job_id, JOB);
    assert_eq!(p.next_cursor, "1788-1");
    assert!(p.has_more);
    let req = server.recorded.lock().clone();
    let hit = req
        .iter()
        .find(|r| r.target.contains("/api/worker/jobs/pending"))
        .expect("pending called");
    assert_eq!(
        hit.headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer test-secret-key")
    );
}

#[tokio::test]
async fn identity_and_mismatch() {
    let server = spawn_server(Box::new(|_| json_response(IDENTITY_OK))).await;
    let c = client(&server.url);
    assert_eq!(c.identity().await.unwrap().user_id, "usr_alice");
    c.verify_identity("usr_alice", "ws_alpha").await.unwrap();
    let err = c.verify_identity("usr_bob", "ws_alpha").await.unwrap_err();
    assert!(matches!(err.kind, ErrorKind::IdentityMismatch { .. }));
    assert!(!err.outcome_unknown);
}

#[tokio::test]
async fn unauthorized_and_forbidden_classified() {
    let s401 = spawn_server(Box::new(|_| Action::Respond {
        status: 401,
        headers: vec![("content-type".into(), "application/json".into())],
        body: br#"{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}"#
            .to_vec(),
    }))
    .await;
    let e = client(&s401.url).pending("tools", "0-0").await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Unauthorized));

    let s403 = spawn_server(Box::new(|_| Action::Respond {
        status: 403,
        headers: vec![],
        body: b"forbidden".to_vec(),
    }))
    .await;
    let e = client(&s403.url).pending("tools", "0-0").await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Forbidden));
}

#[tokio::test]
async fn redirect_not_followed_and_target_gets_no_credentials() {
    let target = spawn_server(Box::new(|_| json_response(IDENTITY_OK))).await;
    let target_url = target.url.clone();
    let first = spawn_server(Box::new(move |_| Action::Respond {
        status: 302,
        headers: vec![("location".into(), target_url.clone())],
        body: vec![],
    }))
    .await;
    let e = client(&first.url).identity().await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Redirect(302)));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(target.recorded.lock().len(), 0);
}

#[tokio::test]
async fn lease_expired_reason_preserved_through_server_error() {
    let server = spawn_server(Box::new(|_| Action::Respond {
        status: 409,
        headers: vec![("content-type".into(), "application/json".into())],
        body: br#"{"ok":false,"code":"LEASE_EXPIRED","message":"Execution lease has expired.","details":{"reason":"EXECUTION_DEADLINE_EXCEEDED"}}"#.to_vec(),
    }))
    .await;
    let c = client(&server.url);
    let e = c.start(JOB, &lease_request()).await.unwrap_err();
    match e.kind {
        ErrorKind::Server {
            status,
            code,
            reason,
        } => {
            assert_eq!(status, 409);
            assert_eq!(code, "LEASE_EXPIRED");
            assert_eq!(reason.as_deref(), Some("EXECUTION_DEADLINE_EXCEEDED"));
        }
        other => panic!("expected server error, got {other:?}"),
    }
    assert!(
        !e.outcome_unknown,
        "a known 409 rejection is not outcome-unknown"
    );
}

#[tokio::test]
async fn oversized_response_is_rejected() {
    let huge = format!("{{\"pad\":{}}}", "\"y\"".repeat(400_000)); // > 256 KiB
    let server = spawn_server(Box::new(move |_| json_response(&huge))).await;
    let e = client(&server.url).identity().await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::TooLarge));
}

#[tokio::test]
async fn invalid_json_success_response_is_protocol_error() {
    let server = spawn_server(Box::new(|_| json_response("this is not json"))).await;
    let e = client(&server.url).identity().await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(!e.outcome_unknown, "a read fault is never outcome-unknown");
}

#[tokio::test]
async fn claim_sends_exact_protocol_fields_and_keeps_claimed_not_running() {
    let server = spawn_server(Box::new(move |_| json_response(&claim_ok_claimed()))).await;
    let c = client(&server.url);
    let ok = c.claim(JOB, &claim_request()).await.unwrap();
    assert!(!ok.replayed);
    assert_eq!(ok.execution.phase, "claimed");

    let req = server.recorded.lock().clone();
    let hit = req
        .iter()
        .find(|r| r.target.contains("/claim"))
        .expect("claim called");
    let body: serde_json::Value = serde_json::from_slice(&hit.body).unwrap();
    assert_eq!(body["worker_id"], WRK);
    assert_eq!(body["attempt_id"], ATT);
    assert_eq!(body["workspace_ref"], "tools");
    assert_eq!(body["lease_token"], TOKEN);
    assert_eq!(
        body.as_object().unwrap().len(),
        4,
        "client must not invent fields"
    );
}

#[tokio::test]
async fn write_transport_fault_marks_outcome_unknown_and_does_not_resend() {
    let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
    let c = client(&server.url);
    let e = c.claim(JOB, &claim_request()).await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Transport(_)));
    assert!(e.outcome_unknown, "a dropped write must be outcome-unknown");
    assert_eq!(count_hits(&server, "/claim"), 1, "no automatic re-send");
}

#[tokio::test]
async fn server_error_display_never_leaks_the_key() {
    let server = spawn_server(Box::new(|_| {
        status_json(
            503,
            r#"{"ok":false,"code":"QUEUE_UNAVAILABLE","message":"backend down"}"#,
        )
    }))
    .await;
    let e = client(&server.url)
        .pending("tools", "0-0")
        .await
        .unwrap_err();
    let rendered = e.to_string();
    assert!(rendered.contains("QUEUE_UNAVAILABLE"));
    assert!(!rendered.contains("test-secret-key"));
}

// ---------------------------------------------------------------------------
// Required-field presence & value/association validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn claim_minimal_ok_true_is_unknown_write_protocol_error() {
    let server = spawn_server(Box::new(|_| json_response(r#"{"ok":true}"#))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
    assert_eq!(count_hits(&server, "/claim"), 1);
}

#[tokio::test]
async fn start_minimal_ok_true_is_unknown_write_protocol_error() {
    let server = spawn_server(Box::new(|_| json_response(r#"{"ok":true}"#))).await;
    let e = client(&server.url)
        .start(JOB, &lease_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn heartbeat_minimal_ok_true_is_unknown_write_protocol_error() {
    let server = spawn_server(Box::new(|_| json_response(r#"{"ok":true}"#))).await;
    let e = client(&server.url)
        .heartbeat(JOB, &lease_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn pending_missing_jobs_field_is_rejected() {
    let server = spawn_server(Box::new(|_| {
        json_response(r#"{"ok":true,"next_cursor":"1788-1","has_more":true}"#)
    }))
    .await;
    let e = client(&server.url)
        .pending("tools", "0-0")
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(!e.outcome_unknown, "read fault is not outcome-unknown");
}

#[tokio::test]
async fn required_field_explicit_null_rejected() {
    // execution.worker_id explicitly null -> structure/type failure.
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":null,"attempt_id":"{ATT}","phase":"claimed",{CLAIMED_TIMES},"started_at":null,"execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn missing_execution_deadline_key_rejected_even_though_nullable() {
    // execution_deadline is nullable but must still be present as a key.
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed",{CLAIMED_TIMES},"started_at":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn invalid_phase_is_unknown_write_protocol_error() {
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"bogus",{CLAIMED_TIMES},"started_at":null,"execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn claim_running_when_not_replayed_rejected() {
    // A fresh claim (replayed=false) must not be reported as running.
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:30Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        running_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn identity_mismatch_in_claim_rejected() {
    // worker_id differs from the request.
    let other = "wrk-ffffffff-ffff-ffff-ffff-ffffffffffff";
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{other}","attempt_id":"{ATT}","phase":"claimed",{CLAIMED_TIMES},"started_at":null,"execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    let rendered = e.to_string();
    assert!(rendered.contains("identity mismatch"), "{rendered}");
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn job_mismatch_in_claim_rejected() {
    let other_job = "job-00000000-0000-0000-0000-000000000000";
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{{"job_id":"{other_job}","workspace_ref":"tools","resource_id":null,"prompt":"x","acceptance":"y","timeout_seconds":120}},"execution":{}}}"#,
        claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn workspace_ref_mismatch_in_claim_rejected() {
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{{"job_id":"{JOB}","workspace_ref":"development","resource_id":null,"prompt":"x","acceptance":"y","timeout_seconds":120}},"execution":{}}}"#,
        claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn claim_replayed_running_is_accepted() {
    // An idempotent replay may legally return a running execution.
    let body = format!(
        r#"{{"ok":true,"replayed":true,"server_time":"2026-09-07T00:00:30Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        running_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let ok = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap();
    assert!(ok.replayed);
    assert_eq!(ok.execution.phase, "running");
}

#[tokio::test]
async fn lease_times_that_do_not_parse_are_rejected() {
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"not-a-time","start_deadline":"2026-09-07T00:05:00Z","started_at":null,"lease_expires_at":"2026-09-07T00:01:30Z","execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn lease_time_ordering_violation_rejected() {
    // lease_expires_at later than start_deadline -> invalid ordering.
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","start_deadline":"2026-09-07T00:00:30Z","started_at":null,"lease_expires_at":"2026-09-07T00:05:00Z","execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn claimed_execution_with_started_at_rejected() {
    let body = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed",{CLAIMED_TIMES},"started_at":"2026-09-07T00:00:02Z","execution_deadline":null}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn execution_deadline_not_started_plus_timeout_rejected() {
    // running with an execution_deadline that is not started_at + 120 s.
    let body = format!(
        r#"{{"ok":true,"replayed":true,"server_time":"2026-09-07T00:00:30Z","job":{},"execution":{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2026-09-07T00:00:00Z","start_deadline":"2026-09-07T00:05:00Z","started_at":"2026-09-07T00:00:02Z","lease_expires_at":"2026-09-07T00:01:32Z","execution_deadline":"2026-09-07T00:03:02Z"}}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn start_must_return_running() {
    // A claimed phase is not a valid start response.
    let body = format!(
        r#"{{"ok":true,"replayed":true,"server_time":"2026-09-07T00:00:00Z","execution":{}}}"#,
        claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&body))).await;
    let e = client(&server.url)
        .start(JOB, &lease_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
    assert!(e.outcome_unknown);
}

#[tokio::test]
async fn heartbeat_accepts_both_claimed_and_running() {
    let server = spawn_server(Box::new(|_| {
        json_response(&format!(
            r#"{{"ok":true,"server_time":"2026-09-07T00:00:00Z","execution":{}}}"#,
            claimed_exec_json()
        ))
    }))
    .await;
    client(&server.url)
        .heartbeat(JOB, &lease_request())
        .await
        .expect("claimed heartbeat ok");

    let server2 = spawn_server(Box::new(|_| {
        json_response(&format!(
            r#"{{"ok":true,"server_time":"2026-09-07T00:00:30Z","execution":{}}}"#,
            running_exec_json()
        ))
    }))
    .await;
    let ok = client(&server2.url)
        .heartbeat(JOB, &lease_request())
        .await
        .expect("running heartbeat ok");
    assert_eq!(ok.execution.phase, "running");
}

#[tokio::test]
async fn pending_cursor_regression_rejected() {
    let server = spawn_server(Box::new(|_| {
        json_response(r#"{"ok":true,"jobs":[],"next_cursor":"0-0","has_more":false}"#)
    }))
    .await;
    // after = "100-5" but next_cursor = "0-0" -> regression.
    let e = client(&server.url)
        .pending("tools", "100-5")
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn pending_has_more_without_cursor_advance_rejected() {
    let server = spawn_server(Box::new(|_| {
        json_response(r#"{"ok":true,"jobs":[],"next_cursor":"100-5","has_more":true}"#)
    }))
    .await;
    let e = client(&server.url)
        .pending("tools", "100-5")
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Protocol(_)));
}

// ---------------------------------------------------------------------------
// outcome_unknown matrix
// ---------------------------------------------------------------------------

async fn assert_write_outcome(action: Action, path: &str, want: bool) {
    let cell = Arc::new(Mutex::new(Some(action)));
    let cell2 = cell.clone();
    let server = spawn_server(Box::new(move |_| {
        cell2.lock().take().unwrap_or(Action::DropConnection)
    }))
    .await;
    let c = client(&server.url);
    let e = if path == "/claim" {
        c.claim(JOB, &claim_request()).await.unwrap_err()
    } else {
        c.start(JOB, &lease_request()).await.unwrap_err()
    };
    assert_eq!(e.outcome_unknown, want, "outcome_unknown wrong for {path}");
    // Each write path produces exactly one request (no auto-retry).
    assert_eq!(
        count_hits(&server, if path == "/claim" { "/claim" } else { "/start" }),
        1
    );
}

#[tokio::test]
async fn outcome_unknown_matrix_for_writes() {
    let queue = |code: &'static str| {
        status_json(
            503,
            &format!(r#"{{"ok":false,"code":"{code}","message":"m"}}"#),
        )
    };
    assert_write_outcome(queue("QUEUE_UNAVAILABLE"), "/claim", true).await;
    assert_write_outcome(queue("BRIDGE_DISABLED"), "/claim", false).await;
    assert_write_outcome(status_json(502, "{}"), "/start", true).await;
    assert_write_outcome(status_json(504, "{}"), "/start", true).await;
    assert_write_outcome(
        status_json(409, r#"{"ok":false,"code":"LEASE_MISMATCH","message":"m"}"#),
        "/claim",
        false,
    )
    .await;
    assert_write_outcome(status_json(401, "{}"), "/claim", false).await;
    assert_write_outcome(status_json(403, "{}"), "/claim", false).await;

    // Oversized write response.
    let huge = format!("{{\"pad\":{}}}", "\"y\"".repeat(400_000));
    assert_write_outcome(json_response(&huge), "/claim", true).await;
    // Write with an invalid (but 2xx) success body.
    assert_write_outcome(json_response(r#"{"ok":true}"#), "/claim", true).await;
}

#[tokio::test]
async fn read_faults_are_never_outcome_unknown() {
    let s1 = spawn_server(Box::new(|_| {
        status_json(
            503,
            r#"{"ok":false,"code":"QUEUE_UNAVAILABLE","message":"m"}"#,
        )
    }))
    .await;
    let e = client(&s1.url).pending("tools", "0-0").await.unwrap_err();
    assert!(!e.outcome_unknown);

    let s2 = spawn_server(Box::new(|_| json_response("not json"))).await;
    let e = client(&s2.url).pending("tools", "0-0").await.unwrap_err();
    assert!(!e.outcome_unknown);
}

#[tokio::test]
async fn write_attempt_token_not_replaced_on_business_error() {
    let server = spawn_server(Box::new(|_| {
        status_json(409, r#"{"ok":false,"code":"LEASE_MISMATCH","message":"m"}"#)
    }))
    .await;
    let e = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(!e.outcome_unknown);
    assert_eq!(count_hits(&server, "/claim"), 1);
    assert!(
        sent_token(&server, "/claim"),
        "the original lease token must be sent verbatim"
    );
}

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn server_receives_request_but_sends_no_headers_times_out() {
    let server = spawn_server(Box::new(|_| Action::HoldSilent)).await;
    let c = client_with(
        &server.url,
        Duration::from_millis(200),
        Duration::from_millis(600),
    );
    let e = c.claim(JOB, &claim_request()).await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Transport(_)));
    assert!(e.outcome_unknown, "write timeout is outcome-unknown");
    assert_eq!(count_hits(&server, "/claim"), 1);
}

#[tokio::test]
async fn server_sends_headers_then_stops_body_times_out() {
    let server = spawn_server(Box::new(|_| Action::HeadersThenStop)).await;
    let c = client_with(
        &server.url,
        Duration::from_millis(200),
        Duration::from_millis(600),
    );
    let e = c.start(JOB, &lease_request()).await.unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Transport(_)));
    assert!(e.outcome_unknown, "write timeout is outcome-unknown");
    assert_eq!(count_hits(&server, "/start"), 1);
}

// ---------------------------------------------------------------------------
// Error / secret sanitisation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unknown_code_reason_message_and_typed_values_never_leak() {
    let secret_code = "HUNTER2CODE_SECRET";
    let secret_reason = "HUNTER2REASON_SECRET";
    let secret_msg = "HUNTER2MESSAGE_SECRET";

    // Unknown code: an unrecognised code string must not be echoed.
    let s1 = spawn_server(Box::new(move |_| {
        status_json(
            400,
            &format!(r#"{{"ok":false,"code":"{secret_code}","message":"{secret_msg}"}}"#),
        )
    }))
    .await;
    let e = client(&s1.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Server { .. }));
    for out in [e.to_string(), format!("{:?}", e.kind)] {
        assert!(!out.contains(secret_code), "leaked code: {out}");
        assert!(!out.contains(secret_msg), "leaked message: {out}");
    }
    assert!(!format!("{e:?}").contains(secret_code));

    // Unknown reason must be dropped.
    let s2 = spawn_server(Box::new(move |_| status_json(
        409,
        &format!(
            r#"{{"ok":false,"code":"LEASE_MISMATCH","details":{{"reason":"{secret_reason}"}},"message":"{secret_msg}"}}"#
        ),
    )))
    .await;
    let e = client(&s2.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    for out in [e.to_string(), format!("{:?}", e)] {
        assert!(!out.contains(secret_reason), "leaked reason: {out}");
        assert!(!out.contains(secret_msg), "leaked message: {out}");
    }

    // Expected-boolean field given a string containing a secret.
    let s3 = spawn_server(Box::new(move |_| {
        status_json(200, &format!(r#"{{"ok":"{secret_msg}","replayed":false}}"#))
    }))
    .await;
    let e = client(&s3.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    for out in [e.to_string(), format!("{:?}", e)] {
        assert!(!out.contains(secret_msg), "leaked via type error: {out}");
    }

    // Expected-object field given a string containing a secret (execution).
    let s4 = spawn_server(Box::new(move |_| status_json(
        200,
        &format!(r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","execution":"{secret_msg}"}}"#),
    )))
    .await;
    let e = client(&s4.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap_err();
    for out in [e.to_string(), format!("{:?}", e)] {
        assert!(
            !out.contains(secret_msg),
            "leaked via structure error: {out}"
        );
    }
}

#[tokio::test]
async fn lease_and_claim_debug_redact_secrets() {
    // Request Debug must not print the lease token.
    let req_dbg = format!("{:?}", lease_request());
    assert!(!req_dbg.contains(TOKEN), "lease token leaked in Debug");
    let claim_req_dbg = format!("{:?}", claim_request());
    assert!(
        !claim_req_dbg.contains(TOKEN),
        "lease token leaked in Debug"
    );

    // A successful claim's Debug must not print prompt/acceptance content.
    let server = spawn_server(Box::new(move |_| json_response(&claim_ok_claimed()))).await;
    let ok = client(&server.url)
        .claim(JOB, &claim_request())
        .await
        .unwrap();
    let dbg = format!("{ok:?}");
    assert!(!dbg.contains("do the thing"), "prompt leaked in Debug");
    assert!(!dbg.contains("thing done"), "acceptance leaked in Debug");
}
