//! Client behaviours against an isolated local HTTP server. No real server or
//! Redis is involved here; the cross-language acceptance in CI exercises the
//! compiled `bridge check` against a real Server + Redis.

use ceo_worker::bridge::client::{BridgeClient, ClientError, ErrorKind};
use ceo_worker::bridge::config::load_api_key;
use ceo_worker::bridge::protocol::{
    AssignmentClaimRequest, AssignmentStartRequest, ExecutionReportBody, ExecutionReportRequest,
};
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
fn claim_job_json() -> String {
    format!(
        r#"{{"job_id":"{JOB}","workspace_ref":"tools","resource_id":null,"prompt":"do the thing","acceptance":"thing done","timeout_seconds":120,"delivery":{{"type":"none"}}}}"#
    )
}

fn pending_json(body: &str) -> String {
    format!(r#"{{"ok":true,"jobs":[{body}],"next_cursor":"1788-1","has_more":true}}"#)
}

fn count_hits(server: &Server, needle: &str) -> usize {
    server
        .recorded
        .lock()
        .iter()
        .filter(|r| r.target.contains(needle))
        .count()
}

fn sent_claim_token(server: &Server, needle: &str) -> bool {
    server
        .recorded
        .lock()
        .iter()
        .filter(|r| r.target.contains(needle))
        .any(|r| {
            serde_json::from_slice::<serde_json::Value>(&r.body)
                .map(|v| v["claim_token"] == serde_json::Value::String(TOKEN.into()))
                .unwrap_or(false)
        })
}

fn assignment_claim_request() -> AssignmentClaimRequest {
    AssignmentClaimRequest {
        worker_id: WRK.into(),
        attempt_id: ATT.into(),
        workspace_ref: "tools".into(),
        claim_token: TOKEN.into(),
    }
}

fn assignment_start_request() -> AssignmentStartRequest {
    AssignmentStartRequest {
        worker_id: WRK.into(),
        attempt_id: ATT.into(),
        claim_token: TOKEN.into(),
    }
}

fn assignment_claimed_exec_json() -> String {
    format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","started_at":null}}"#
    )
}

fn assignment_running_exec_json() -> String {
    format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2026-09-07T00:00:00Z","started_at":"2026-09-07T00:00:02Z"}}"#
    )
}

fn assignment_claim_ok_claimed() -> String {
    format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        assignment_claimed_exec_json()
    )
}

fn assignment_claim_ok_replayed_running() -> String {
    format!(
        r#"{{"ok":true,"replayed":true,"server_time":"2026-09-07T00:00:05Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        assignment_running_exec_json()
    )
}

fn assignment_start_ok_running(replayed: bool) -> String {
    format!(
        r#"{{"ok":true,"replayed":{replayed},"server_time":"2026-09-07T00:00:05Z","execution":{}}}"#,
        assignment_running_exec_json()
    )
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
async fn assignment_mismatch_reason_preserved_through_server_error() {
    let server = spawn_server(Box::new(|_| Action::Respond {
        status: 409,
        headers: vec![("content-type".into(), "application/json".into())],
        body: br#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","message":"Assignment clock regression.","details":{"reason":"CLOCK_REGRESSION"}}"#.to_vec(),
    }))
    .await;
    let c = client(&server.url);
    let e = c
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
    match e.kind {
        ErrorKind::Server {
            status,
            code,
            reason,
        } => {
            assert_eq!(status, 409);
            assert_eq!(code, "ASSIGNMENT_MISMATCH");
            assert_eq!(reason.as_deref(), Some("CLOCK_REGRESSION"));
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
async fn write_transport_fault_marks_outcome_unknown_and_does_not_resend() {
    let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
    let c = client(&server.url);
    let e = c
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
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
        .claim_assignment(JOB, &assignment_claim_request())
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
        .start_assignment(JOB, &assignment_start_request())
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
        c.claim_assignment(JOB, &assignment_claim_request())
            .await
            .unwrap_err()
    } else {
        c.start_assignment(JOB, &assignment_start_request())
            .await
            .unwrap_err()
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
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","message":"m"}"#,
        ),
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

// ---------------------------------------------------------------------------
// Confirmed-rejection classification (through real claim/start/heartbeat)
// ---------------------------------------------------------------------------

/// Dispatches a single write call and returns its error.
async fn run_write(c: &BridgeClient, which: &str) -> ClientError {
    match which {
        "claim" => c
            .claim_assignment(JOB, &assignment_claim_request())
            .await
            .unwrap_err(),
        "start" => c
            .start_assignment(JOB, &assignment_start_request())
            .await
            .unwrap_err(),
        other => panic!("unexpected write path {other}"),
    }
}

fn write_needle(which: &str) -> &str {
    match which {
        "claim" => "/claim",
        "start" => "/start",
        _ => panic!("unexpected write path"),
    }
}

/// Asserts that serving `action` on a write path yields a Server error carrying
/// exactly the expected HTTP status + safe code, the given outcome_unknown, and
/// exactly one request (never a silent re-send).
async fn assert_server_business_error(
    action: Action,
    which: &str,
    status: u16,
    code: &str,
    outcome_unknown: bool,
) {
    let server = spawn_server(Box::new(move |_| action.clone())).await;
    let e = run_write(&client(&server.url), which).await;
    match &e.kind {
        ErrorKind::Server {
            status: s, code: c, ..
        } => {
            assert_eq!(*s, status, "HTTP status mismatch for {which}");
            assert_eq!(c, code, "safe code mismatch for {which}");
        }
        other => panic!("expected Server error on {which}, got {other:?}"),
    }
    assert_eq!(
        e.outcome_unknown, outcome_unknown,
        "outcome_unknown wrong for {which}"
    );
    assert_eq!(
        count_hits(&server, write_needle(which)),
        1,
        "{which} must not be silently re-sent"
    );
}

/// 4.1: every valid status/code pairing with an explicit `ok:false` is a
/// confirmed rejection through the real client write paths.
#[tokio::test]
async fn confirmed_rejection_valid_pairings() {
    let cases: &[(u16, &str)] = &[
        (400, "INVALID_INPUT"),
        (404, "JOB_NOT_FOUND"),
        (409, "JOB_EXPIRED"),
        (409, "JOB_ALREADY_CLAIMED"),
        (409, "IDEMPOTENCY_CONFLICT"),
        (409, "JOB_NOT_CLAIMED"),
        (409, "ASSIGNMENT_MISMATCH"),
        (409, "WORKSPACE_MISMATCH"),
        (503, "BRIDGE_DISABLED"),
    ];
    for &(status, code) in cases {
        let body = format!(r#"{{"ok":false,"code":"{code}"}}"#);
        assert_server_business_error(status_json(status, &body), "claim", status, code, false)
            .await;
    }
}

/// Confirmed rejection is also reached through start(), which
/// shares the same write classification as claim().
#[tokio::test]
async fn confirmed_rejection_through_start() {
    assert_server_business_error(
        status_json(503, r#"{"ok":false,"code":"BRIDGE_DISABLED"}"#),
        "start",
        503,
        "BRIDGE_DISABLED",
        false,
    )
    .await;
}

/// 4.2: a status/code pairing not on the confirmed table is never a confirmed
/// rejection, even with `ok:false`. The safe code is still kept for diagnostics
/// but the write outcome stays unknown.
#[tokio::test]
async fn mismatched_pairings_leave_write_outcome_unknown() {
    let cases: &[(u16, &str)] = &[
        (502, "BRIDGE_DISABLED"),
        (504, "BRIDGE_DISABLED"),
        (400, "ASSIGNMENT_MISMATCH"),
        (404, "INVALID_INPUT"),
        (409, "BRIDGE_DISABLED"),
        (503, "ASSIGNMENT_MISMATCH"),
        (503, "QUEUE_UNAVAILABLE"),
    ];
    for &(status, code) in cases {
        let body = format!(r#"{{"ok":false,"code":"{code}"}}"#);
        assert_server_business_error(status_json(status, &body), "claim", status, code, true).await;
    }
}

/// 4.3: an envelope that does not explicitly carry `ok:false` never confirms a
/// rejection, even on a valid status/code pairing.
#[tokio::test]
async fn ambiguous_envelope_leaves_write_outcome_unknown() {
    // 503 + BRIDGE_DISABLED with every non-explicit `ok` variant.
    let cases: &[(&str, u16, &str)] = &[
        (r#"{"code":"BRIDGE_DISABLED"}"#, 503, "BRIDGE_DISABLED"),
        (
            r#"{"ok":null,"code":"BRIDGE_DISABLED"}"#,
            503,
            "BRIDGE_DISABLED",
        ),
        (
            r#"{"ok":true,"code":"BRIDGE_DISABLED"}"#,
            503,
            "BRIDGE_DISABLED",
        ),
        // ok as a string is a structural parse failure: code falls back.
        (
            r#"{"ok":"false","code":"BRIDGE_DISABLED"}"#,
            503,
            "HTTP_503",
        ),
        (r#"not json"#, 503, "HTTP_503"),
    ];
    for &(body, status, code) in cases {
        assert_server_business_error(status_json(status, body), "claim", status, code, true).await;
    }

    // Not a Bridge-only rule: a valid 409 pairing with a missing `ok` is also
    // not a confirmed rejection.
    assert_server_business_error(
        status_json(409, r#"{"code":"ASSIGNMENT_MISMATCH"}"#),
        "start",
        409,
        "ASSIGNMENT_MISMATCH",
        true,
    )
    .await;
}

/// Read requests never report outcome_unknown, regardless of how a business
/// error would be classified on the write side.
#[tokio::test]
async fn reads_ignore_write_rejection_classification() {
    // A confirmed rejection envelope on a read path stays outcome_unknown=false.
    let s1 = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","message":"m"}"#,
        )
    }))
    .await;
    let e = client(&s1.url).pending("tools", "0-0").await.unwrap_err();
    assert!(!e.outcome_unknown, "a read is never outcome-unknown");

    // An ambiguous envelope on a read path is likewise never outcome-unknown.
    let s2 = spawn_server(Box::new(|_| {
        status_json(503, r#"{"code":"BRIDGE_DISABLED"}"#)
    }))
    .await;
    let e = client(&s2.url).pending("tools", "0-0").await.unwrap_err();
    assert!(!e.outcome_unknown, "a read is never outcome-unknown");
}

#[tokio::test]
async fn write_attempt_token_not_replaced_on_business_error() {
    let server = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","message":"m"}"#,
        )
    }))
    .await;
    let e = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(!e.outcome_unknown);
    assert_eq!(count_hits(&server, "/claim"), 1);
    assert!(
        sent_claim_token(&server, "/claim"),
        "the original claim token must be sent verbatim"
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
    let e = c
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
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
    let e = c
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
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
        .claim_assignment(JOB, &assignment_claim_request())
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
            r#"{{"ok":false,"code":"ASSIGNMENT_MISMATCH","details":{{"reason":"{secret_reason}"}},"message":"{secret_msg}"}}"#
        ),
    )))
    .await;
    let e = client(&s2.url)
        .claim_assignment(JOB, &assignment_claim_request())
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
        .claim_assignment(JOB, &assignment_claim_request())
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
        .claim_assignment(JOB, &assignment_claim_request())
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
async fn assignment_debug_redact_secrets() {
    // Request Debug must not print the claim token.
    let req_dbg = format!("{:?}", assignment_start_request());
    assert!(!req_dbg.contains(TOKEN), "claim token leaked in Debug");
    let claim_req_dbg = format!("{:?}", assignment_claim_request());
    assert!(
        !claim_req_dbg.contains(TOKEN),
        "claim token leaked in Debug"
    );

    // A successful claim's Debug must not print prompt/acceptance content.
    let server = spawn_server(Box::new(move |_| {
        json_response(&assignment_claim_ok_claimed())
    }))
    .await;
    let ok = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap();
    let dbg = format!("{ok:?}");
    assert!(!dbg.contains("do the thing"), "prompt leaked in Debug");
    assert!(!dbg.contains("thing done"), "acceptance leaked in Debug");
}

// ---------------------------------------------------------------------------
// Persistent Assignment Protocol Tests (Step 3.1)
// ---------------------------------------------------------------------------

// 7.2 Success paths
#[tokio::test]
async fn claim_assignment_sends_exact_protocol_fields_and_accepts_claimed() {
    let server = spawn_server(Box::new(|_| json_response(&assignment_claim_ok_claimed()))).await;
    let ok = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap();

    assert_eq!(ok.execution.phase, "claimed");
    assert_eq!(ok.execution.started_at, None);
    assert!(!ok.replayed);
    assert_eq!(count_hits(&server, "/claim"), 1);

    let recorded = server.recorded.lock();
    let req = recorded
        .iter()
        .find(|r| r.target.contains("/claim"))
        .unwrap();
    assert_eq!(req.target, format!("/api/worker/jobs/{JOB}/claim"));
    assert_eq!(
        req.headers.get("authorization").map(|s| s.as_str()),
        Some("Bearer test-secret-key")
    );

    let val: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
    let obj = val.as_object().unwrap();
    let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
    keys.sort();
    assert_eq!(
        keys,
        vec!["attempt_id", "claim_token", "worker_id", "workspace_ref"]
    );
    assert_eq!(obj["worker_id"], WRK);
    assert_eq!(obj["attempt_id"], ATT);
    assert_eq!(obj["workspace_ref"], "tools");
    assert_eq!(obj["claim_token"], TOKEN);
    assert!(!obj.contains_key("lease_token"));
    assert!(!obj.contains_key("user_id"));
    assert!(!obj.contains_key("workspace_id"));
    drop(recorded);
    assert!(
        sent_claim_token(&server, "/claim"),
        "the claim token must be sent verbatim"
    );
}

#[tokio::test]
async fn claim_assignment_replayed_running_is_accepted() {
    let server = spawn_server(Box::new(|_| {
        json_response(&assignment_claim_ok_replayed_running())
    }))
    .await;
    let ok = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap();

    assert!(ok.replayed);
    assert_eq!(ok.execution.phase, "running");
    assert_eq!(
        ok.execution.started_at.as_deref(),
        Some("2026-09-07T00:00:02Z")
    );
}

#[tokio::test]
async fn start_assignment_sends_exact_protocol_fields_and_accepts_running() {
    let server = spawn_server(Box::new(|_| {
        json_response(&assignment_start_ok_running(false))
    }))
    .await;
    let ok = client(&server.url)
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap();

    assert_eq!(ok.execution.phase, "running");
    assert_eq!(
        ok.execution.started_at.as_deref(),
        Some("2026-09-07T00:00:02Z")
    );
    assert!(!ok.replayed);
    assert_eq!(count_hits(&server, "/start"), 1);

    {
        let recorded = server.recorded.lock();
        let req = recorded
            .iter()
            .find(|r| r.target.contains("/start"))
            .unwrap();
        assert_eq!(req.target, format!("/api/worker/jobs/{JOB}/start"));
        let val: serde_json::Value = serde_json::from_slice(&req.body).unwrap();
        let obj = val.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(keys, vec!["attempt_id", "claim_token", "worker_id"]);
        assert_eq!(obj["worker_id"], WRK);
        assert_eq!(obj["attempt_id"], ATT);
        assert_eq!(obj["claim_token"], TOKEN);
        assert!(!obj.contains_key("workspace_ref"));
        assert!(!obj.contains_key("lease_token"));
    }
    assert!(
        sent_claim_token(&server, "/start"),
        "the claim token must be sent verbatim"
    );

    // Also accepts replayed start
    let server2 = spawn_server(Box::new(|_| {
        json_response(&assignment_start_ok_running(true))
    }))
    .await;
    let ok2 = client(&server2.url)
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap();
    assert!(ok2.replayed);
    assert_eq!(ok2.execution.phase, "running");
}

// 7.3 Response validation matrix (mutations return outcome_unknown = true)
#[tokio::test]
async fn assignment_started_at_missing_key_rejected() {
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z"}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{bad_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_claimed_with_non_null_started_at_rejected() {
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","started_at":"2026-09-07T00:00:02Z"}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{bad_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_running_with_null_started_at_rejected() {
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2026-09-07T00:00:00Z","started_at":null}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:05Z","execution":{bad_exec}}}"#
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_running_with_started_at_earlier_than_claimed_at_rejected() {
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2026-09-07T00:00:05Z","started_at":"2026-09-07T00:00:02Z"}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:05Z","execution":{bad_exec}}}"#
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_invalid_timestamp_formats_rejected() {
    // Bad server_time
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"not-a-timestamp","job":{},"execution":{}}}"#,
        claim_job_json(),
        assignment_claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));

    // Bad claimed_at
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"not-rfc3339","started_at":null}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{bad_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_invalid_phase_rejected() {
    let bad_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"pending","claimed_at":"2026-09-07T00:00:00Z","started_at":null}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{bad_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_claim_fresh_running_rejected() {
    // replayed: false with running phase must be rejected
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:05Z","job":{},"execution":{}}}"#,
        claim_job_json(),
        assignment_running_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_start_claimed_rejected() {
    // start returning claimed phase must be rejected
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","execution":{}}}"#,
        assignment_claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_associations_mismatch_rejected() {
    // Job ID mismatch
    let other_job_json = r#"{"job_id":"job-99999999-9999-9999-9999-999999999999","workspace_ref":"tools","resource_id":null,"prompt":"p","acceptance":"a","timeout_seconds":120}"#;
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{other_job_json},"execution":{}}}"#,
        assignment_claimed_exec_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);

    // Workspace alias mismatch
    let other_ws_job = format!(
        r#"{{"job_id":"{JOB}","workspace_ref":"otherws","resource_id":null,"prompt":"p","acceptance":"a","timeout_seconds":120}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{other_ws_job},"execution":{}}}"#,
        assignment_claimed_exec_json()
    );
    let server2 = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err2 = client(&server2.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err2.outcome_unknown);

    // Worker ID mismatch
    let other_worker_exec = format!(
        r#"{{"worker_id":"wrk-99999999-9999-9999-9999-999999999999","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","started_at":null}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{other_worker_exec}}}"#,
        claim_job_json()
    );
    let server3 = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err3 = client(&server3.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err3.outcome_unknown);

    // Attempt ID mismatch
    let other_att_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"99999999-9999-9999-9999-999999999999","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","started_at":null}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{other_att_exec}}}"#,
        claim_job_json()
    );
    let server4 = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err4 = client(&server4.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err4.outcome_unknown);
}

#[tokio::test]
async fn assignment_execution_with_legacy_lease_fields_rejected() {
    // Execution has old start_deadline / lease_expires_at / execution_deadline:
    // our strict deserializer must reject unexpected fields.
    let legacy_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","started_at":null,"start_deadline":"2026-09-07T00:05:00Z","lease_expires_at":"2026-09-07T00:01:30Z"}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{legacy_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err.outcome_unknown);
    assert!(matches!(err.kind, ErrorKind::Protocol(_)));
}

#[tokio::test]
async fn assignment_ancient_timestamps_accepted() {
    // Persistent assignments have no lease expiry; an ancient claimed_at / started_at is valid
    let ancient_exec = format!(
        r#"{{"worker_id":"{WRK}","attempt_id":"{ATT}","phase":"running","claimed_at":"2020-01-01T00:00:00Z","started_at":"2020-01-01T01:00:00Z"}}"#
    );
    let resp = format!(
        r#"{{"ok":true,"replayed":true,"server_time":"2026-09-07T00:00:00Z","job":{},"execution":{ancient_exec}}}"#,
        claim_job_json()
    );
    let server = spawn_server(Box::new(move |_| json_response(&resp))).await;
    let ok = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap();
    assert!(ok.replayed);
    assert_eq!(ok.execution.claimed_at, "2020-01-01T00:00:00Z");
}

// 7.4 Error, timeout, secret redaction, and retry boundaries
#[tokio::test]
async fn assignment_mismatch_confirmed_rejection() {
    let server = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","message":"already assigned"}"#,
        )
    }))
    .await;
    let err = client(&server.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(
        !err.outcome_unknown,
        "409 ASSIGNMENT_MISMATCH is a confirmed rejection"
    );
    match err.kind {
        ErrorKind::Server { status, code, .. } => {
            assert_eq!(status, 409);
            assert_eq!(code, "ASSIGNMENT_MISMATCH");
        }
        other => panic!("expected server error, got {other:?}"),
    }
}

#[tokio::test]
async fn assignment_reason_sanitization() {
    // Known reason (CORRUPT_RECORD) is preserved
    let s1 = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","details":{"reason":"CORRUPT_RECORD"},"message":"raw db error"}"#,
        )
    }))
    .await;
    let err = client(&s1.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    match &err.kind {
        ErrorKind::Server { reason, .. } => {
            assert_eq!(reason.as_deref(), Some("CORRUPT_RECORD"));
        }
        other => panic!("expected server error, got {other:?}"),
    }
    assert!(!err.to_string().contains("raw db error"));

    // Unknown reason is sanitized
    let s2 = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"ASSIGNMENT_MISMATCH","details":{"reason":"UNKNOWN_SECRET_REASON"},"message":"raw db error"}"#,
        )
    }))
    .await;
    let err2 = client(&s2.url)
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    match &err2.kind {
        ErrorKind::Server { reason, .. } => {
            assert_eq!(reason, &None);
        }
        other => panic!("expected server error, got {other:?}"),
    }
    assert!(!err2.to_string().contains("UNKNOWN_SECRET_REASON"));
    assert!(!format!("{err2:?}").contains("UNKNOWN_SECRET_REASON"));
}

#[tokio::test]
async fn assignment_transport_faults_mark_outcome_unknown_and_do_not_resend() {
    // Drop connection
    let s1 = spawn_server(Box::new(|_| Action::DropConnection)).await;
    let c1 = client(&s1.url);
    let err1 = c1
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err1.outcome_unknown);
    assert_eq!(count_hits(&s1, "/claim"), 1);

    // Silent timeout
    let s2 = spawn_server(Box::new(|_| Action::HoldSilent)).await;
    let c2 = client_with(
        &s2.url,
        Duration::from_millis(200),
        Duration::from_millis(600),
    );
    let err2 = c2
        .claim_assignment(JOB, &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(err2.outcome_unknown);
    assert_eq!(count_hits(&s2, "/claim"), 1);

    // Headers then stop timeout
    let s3 = spawn_server(Box::new(|_| Action::HeadersThenStop)).await;
    let c3 = client_with(
        &s3.url,
        Duration::from_millis(200),
        Duration::from_millis(600),
    );
    let err3 = c3
        .start_assignment(JOB, &assignment_start_request())
        .await
        .unwrap_err();
    assert!(err3.outcome_unknown);
    assert_eq!(count_hits(&s3, "/start"), 1);
}

#[tokio::test]
async fn assignment_requests_redact_secrets_in_debug() {
    let claim_dbg = format!("{:?}", assignment_claim_request());
    assert!(!claim_dbg.contains(TOKEN));
    assert!(claim_dbg.contains("[redacted]"));

    let start_dbg = format!("{:?}", assignment_start_request());
    assert!(!start_dbg.contains(TOKEN));
    assert!(start_dbg.contains("[redacted]"));
}

// 7.5 Pre-send rejections (outcome_unknown = false, hits = 0)
#[tokio::test]
async fn assignment_pre_send_validation_rejections() {
    let server = spawn_server(Box::new(|_| json_response(&assignment_claim_ok_claimed()))).await;
    let c = client(&server.url);

    // Invalid job_id
    let err = c
        .claim_assignment("invalid-job-id", &assignment_claim_request())
        .await
        .unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);

    // Invalid worker_id
    let mut bad_req = assignment_claim_request();
    bad_req.worker_id = "wrk-invalid".into();
    let err = c.claim_assignment(JOB, &bad_req).await.unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);

    // Invalid attempt_id
    let mut bad_req = assignment_claim_request();
    bad_req.attempt_id = "not-a-uuid".into();
    let err = c.claim_assignment(JOB, &bad_req).await.unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);

    // Invalid workspace_ref
    let mut bad_req = assignment_claim_request();
    bad_req.workspace_ref = "invalid workspace with spaces".into();
    let err = c.claim_assignment(JOB, &bad_req).await.unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);

    // Invalid claim_token (uppercase or bad len)
    let mut bad_req = assignment_claim_request();
    bad_req.claim_token = "AAAABBBBCCCCDDDDEEEEFFFF0000111122223333444455556666777788889999".into();
    let err = c.claim_assignment(JOB, &bad_req).await.unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);

    // Start pre-send checks
    let mut bad_start = assignment_start_request();
    bad_start.claim_token = "too-short".into();
    let err = c.start_assignment(JOB, &bad_start).await.unwrap_err();
    assert!(!err.outcome_unknown);
    assert_eq!(server.recorded.lock().len(), 0);
}

fn report_request() -> ExecutionReportRequest {
    ExecutionReportRequest {
        worker_id: WRK.into(),
        attempt_id: ATT.into(),
        claim_token: TOKEN.into(),
        report: ExecutionReportBody {
            schema_version: 2,
            execution_status: "COMPLETED".into(),
            business_outcome: "UNVERIFIED".into(),
            task_dispatched: true,
            finished_at_ms: 1_780_000_000_000,
            duration_ms: 1234,
            executor: ceo_worker::bridge::protocol::ExecutionReportExecutor {
                r#type: "test_stub".into(),
                version: "1.0.0".into(),
            },
            receipt_sha256: "b".repeat(64),
            error: None,
        },
    }
}

fn report_ok_json(replayed: bool) -> String {
    format!(
        r#"{{"ok":true,"job_id":"{JOB}","attempt_id":"{ATT}","state":"completed","report_received":true,"received_at":"2026-09-13T00:00:00.000Z","replayed":{replayed}}}"#
    )
}

#[tokio::test]
async fn report_accepts_first_confirmation_and_replay() {
    let server = spawn_server(Box::new(|_| json_response(&report_ok_json(false)))).await;
    let ok = client(&server.url)
        .report_execution(JOB, &report_request())
        .await
        .unwrap();
    assert!(ok.ok);
    assert!(ok.report_received);
    assert!(!ok.replayed);
    assert_eq!(ok.job_id, JOB);
    assert_eq!(ok.attempt_id, ATT);
    assert_eq!(ok.state, "completed");
    assert_eq!(count_hits(&server, "/report"), 1);
    assert!(sent_claim_token(&server, "/report"));

    let replay_server = spawn_server(Box::new(|_| json_response(&report_ok_json(true)))).await;
    let replay = client(&replay_server.url)
        .report_execution(JOB, &report_request())
        .await
        .unwrap();
    assert!(replay.replayed);
    assert!(replay.report_received);
}

#[tokio::test]
async fn report_drop_after_accept_is_outcome_unknown_and_sends_once() {
    let server = spawn_server(Box::new(|_| Action::DropConnection)).await;
    let e = client(&server.url)
        .report_execution(JOB, &report_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Transport(_)));
    assert!(e.outcome_unknown);
    assert_eq!(count_hits(&server, "/report"), 1);
}

#[tokio::test]
async fn report_conflict_is_confirmed_and_not_retried() {
    let server = spawn_server(Box::new(|_| {
        status_json(
            409,
            r#"{"ok":false,"code":"REPORT_CONFLICT","message":"A different execution report was already accepted."}"#,
        )
    }))
    .await;
    let e = client(&server.url)
        .report_execution(JOB, &report_request())
        .await
        .unwrap_err();
    match e.kind {
        ErrorKind::Server { status, code, .. } => {
            assert_eq!(status, 409);
            assert_eq!(code, "REPORT_CONFLICT");
        }
        other => panic!("expected REPORT_CONFLICT, got {other:?}"),
    }
    assert!(!e.outcome_unknown);
    assert_eq!(count_hits(&server, "/report"), 1);
}

#[tokio::test]
async fn report_http_200_with_invalid_confirmation_is_not_success() {
    let cases = vec![
        r#"{"ok":true}"#.to_string(),
        format!(
            r#"{{"ok":true,"job_id":"{JOB}","attempt_id":"123e4567-e89b-12d3-a456-426614174099","state":"completed","report_received":true,"received_at":"2026-09-13T00:00:00.000Z","replayed":false}}"#
        ),
        format!(
            r#"{{"ok":true,"job_id":"{JOB}","attempt_id":"{ATT}","state":"failed","report_received":true,"received_at":"2026-09-13T00:00:00.000Z","replayed":false}}"#
        ),
        format!(
            r#"{{"ok":true,"job_id":"{JOB}","attempt_id":"{ATT}","state":"completed","report_received":false,"received_at":"2026-09-13T00:00:00.000Z","replayed":false}}"#
        ),
    ];
    for body in cases {
        let payload = body.to_string();
        let server = spawn_server(Box::new(move |_| json_response(&payload))).await;
        let e = client(&server.url)
            .report_execution(JOB, &report_request())
            .await
            .unwrap_err();
        assert!(matches!(e.kind, ErrorKind::Protocol(_)), "{body}");
        assert!(e.outcome_unknown, "{body}");
        assert_eq!(count_hits(&server, "/report"), 1);
    }
}

#[tokio::test]
async fn report_redirect_is_not_followed() {
    let target = spawn_server(Box::new(|_| json_response(&report_ok_json(false)))).await;
    let target_url = target.url.clone();
    let first = spawn_server(Box::new(move |_| Action::Respond {
        status: 302,
        headers: vec![("location".into(), target_url.clone())],
        body: vec![],
    }))
    .await;
    let e = client(&first.url)
        .report_execution(JOB, &report_request())
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Redirect(302)));
    assert!(e.outcome_unknown);
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(target.recorded.lock().len(), 0);
}

#[test]
fn claimed_job_delivery_contract_deserialization() {
    use ceo_worker::bridge::protocol::{ClaimedJob, TaskDeliverySpec};

    // 1. Valid None delivery
    let json_none = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "none" }
    });
    let job_none: ClaimedJob = serde_json::from_value(json_none).unwrap();
    assert_eq!(job_none.delivery, TaskDeliverySpec::None);

    // 2. Valid Agent delivery
    let json_agent = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "agent", "instructions": "post to discord" }
    });
    let job_agent: ClaimedJob = serde_json::from_value(json_agent).unwrap();
    assert_eq!(
        job_agent.delivery,
        TaskDeliverySpec::Agent {
            instructions: "post to discord".to_string()
        }
    );

    // 3. Outer unknown field tolerance
    let json_outer_extra = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "none" },
        "future_server_field": "preserved"
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_outer_extra).is_ok());

    // 4. Missing delivery is rejected
    let json_missing_delivery = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_missing_delivery).is_err());

    // 5. Unknown delivery type is rejected
    let json_bad_type = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "webhook" }
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_bad_type).is_err());

    // 6. Delivery inner extra fields rejected (strict deny_unknown_fields)
    let json_delivery_extra = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "none", "extra": true }
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_delivery_extra).is_err());

    // 7. Agent delivery blank / empty instructions rejected
    let json_agent_empty = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "agent", "instructions": "" }
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_agent_empty).is_err());

    let json_agent_whitespace = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "agent", "instructions": "   \n\t " }
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_agent_whitespace).is_err());

    // 8. Agent delivery oversized instructions (> 8 KiB) rejected
    let json_agent_oversized = serde_json::json!({
        "job_id": JOB,
        "workspace_ref": "tools",
        "resource_id": null,
        "prompt": "prompt",
        "acceptance": "acceptance",
        "timeout_seconds": 120,
        "delivery": { "type": "agent", "instructions": "a".repeat(8193) }
    });
    assert!(serde_json::from_value::<ClaimedJob>(json_agent_oversized).is_err());
}
