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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
struct RecordedRequest {
    target: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}

enum Action {
    Respond {
        status: u16,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// Accept + read the request, then close without answering.
    DropConnection,
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

/// Builds a client whose API key comes from a real, mode-0600 key file.
fn client(url: &str) -> BridgeClient {
    let dir = tempfile::tempdir().unwrap();
    let key_path = dir.path().join("key");
    std::fs::write(&key_path, "test-secret-key\n").unwrap();
    std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
    let key = load_api_key(&key_path).unwrap();
    BridgeClient::new(url.parse().unwrap(), key).unwrap()
}

const IDENTITY_OK: &str =
    r#"{"user_id":"usr_alice","workspace_id":"ws_alpha","deployment_mode":"single_user"}"#;

fn pending_json(body: &str) -> String {
    format!(r#"{{"ok":true,"jobs":[{body}],"next_cursor":"1788-1","has_more":true}}"#)
}

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
    assert_eq!(p.jobs[0].job_id, "job-123e4567-e89b-12d3-a456-426614174001");
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
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
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
    let req = LeaseOperationRequest {
        worker_id: "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d".into(),
        attempt_id: "123e4567-e89b-12d3-a456-4266141740ab".into(),
        lease_token: "a".repeat(64),
    };
    let e = c
        .start("job-123e4567-e89b-12d3-a456-426614174001", &req)
        .await
        .unwrap_err();
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
}

#[tokio::test]
async fn claim_sends_exact_protocol_fields_and_keeps_claimed_not_running() {
    let server = spawn_server(Box::new(|_| {
        json_response(
            r#"{"ok":true,"replayed":false,"server_time":"2026-09-07T00:00:00Z","job":{"job_id":"job-123e4567-e89b-12d3-a456-426614174001","workspace_ref":"tools","resource_id":null,"prompt":"p","acceptance":"a","timeout_seconds":120},"execution":{"worker_id":"wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d","attempt_id":"123e4567-e89b-12d3-a456-4266141740ab","phase":"claimed","claimed_at":"2026-09-07T00:00:00Z","start_deadline":"2026-09-07T00:05:00Z","started_at":null,"lease_expires_at":"2026-09-07T00:01:30Z","execution_deadline":null}}"#,
        )
    }))
    .await;
    let c = client(&server.url);
    let claim = ClaimRequest {
        worker_id: "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d".into(),
        attempt_id: "123e4567-e89b-12d3-a456-4266141740ab".into(),
        workspace_ref: "tools".into(),
        lease_token: "a".repeat(64),
    };
    let ok = c
        .claim("job-123e4567-e89b-12d3-a456-426614174001", &claim)
        .await
        .unwrap();
    assert!(!ok.replayed);
    let phase = ok
        .execution
        .as_ref()
        .map(|e| e.phase.as_str())
        .unwrap_or("");
    assert_eq!(
        phase, "claimed",
        "a claim must never be reported as running"
    );

    let req = server.recorded.lock().clone();
    let hit = req
        .iter()
        .find(|r| r.target.contains("/claim"))
        .expect("claim called");
    let body: serde_json::Value = serde_json::from_slice(&hit.body).unwrap();
    assert_eq!(
        body["worker_id"],
        "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"
    );
    assert_eq!(body["attempt_id"], "123e4567-e89b-12d3-a456-4266141740ab");
    assert_eq!(body["workspace_ref"], "tools");
    assert_eq!(body["lease_token"], "a".repeat(64));
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
    let claim = ClaimRequest {
        worker_id: "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d".into(),
        attempt_id: "123e4567-e89b-12d3-a456-4266141740ab".into(),
        workspace_ref: "tools".into(),
        lease_token: "a".repeat(64),
    };
    let e = c
        .claim("job-123e4567-e89b-12d3-a456-426614174001", &claim)
        .await
        .unwrap_err();
    assert!(matches!(e.kind, ErrorKind::Transport(_)));
    assert!(e.outcome_unknown, "a dropped write must be outcome-unknown");
    let req = server.recorded.lock().clone();
    assert_eq!(
        req.iter().filter(|r| r.target.contains("/claim")).count(),
        1
    );
}

#[tokio::test]
async fn server_error_display_never_leaks_the_key() {
    let server = spawn_server(Box::new(|_| Action::Respond {
        status: 503,
        headers: vec![("content-type".into(), "application/json".into())],
        body: br#"{"ok":false,"code":"QUEUE_UNAVAILABLE","message":"backend down"}"#.to_vec(),
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
