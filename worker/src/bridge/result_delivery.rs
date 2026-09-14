//! Deliver persisted managed results to the CEO Server.
//!
//! Owns retry, evidence verification, and outbox cleanup for result delivery.
//! Never deletes the underlying attempt managed-result.json evidence.

use crate::bridge::client::{BridgeClient, ClientError, ErrorKind};
use crate::bridge::protocol::{WorkerResultRequest, WorkerResultResponse};
use crate::bridge::result_outbox::{self, list_pending, PendingResultRecord};
use crate::bridge::state::{self, BridgeBinding};
use crate::local_state::remove_durable;
use crate::managed_result::validate_managed_result_file;
use crate::runner::StopReason;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::time::Duration;
use tokio::sync::watch;

const DELIVERY_BACKOFF: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

pub fn delivery_backoff(attempt_index: usize) -> Duration {
    DELIVERY_BACKOFF[attempt_index.min(DELIVERY_BACKOFF.len() - 1)]
}

#[derive(Debug, PartialEq, Eq)]
pub enum DeliveryClass {
    Retry,
    Stop,
}

pub fn classify_result_delivery_error(err: &ClientError) -> DeliveryClass {
    match &err.kind {
        ErrorKind::Unauthorized | ErrorKind::Forbidden | ErrorKind::IdentityMismatch { .. } => {
            DeliveryClass::Stop
        }
        ErrorKind::Server { code, .. }
            if matches!(
                code.as_str(),
                "JOB_NOT_FOUND"
                    | "NOT_FOUND"
                    | "ASSIGNMENT_MISMATCH"
                    | "RESULT_CONFLICT"
                    | "REPORT_CONFLICT"
                    | "INVALID_INPUT"
            ) && !err.outcome_unknown =>
        {
            DeliveryClass::Stop
        }
        ErrorKind::Protocol(_) | ErrorKind::TooLarge | ErrorKind::Redirect(_)
            if !err.outcome_unknown =>
        {
            DeliveryClass::Stop
        }
        _ if err.outcome_unknown => DeliveryClass::Retry,
        ErrorKind::Transport(_) => DeliveryClass::Retry,
        ErrorKind::Server { .. } => DeliveryClass::Retry,
        _ => DeliveryClass::Stop,
    }
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("open file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 8192];
    loop {
        let n = f.read(&mut buf).map_err(|e| format!("read file: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_pending_result_against_evidence(
    workspace: &Path,
    binding: &BridgeBinding,
    worker_id: &str,
    pending: &PendingResultRecord,
) -> Result<(), String> {
    if pending.worker_id != worker_id {
        return Err("worker_id does not match active worker".to_string());
    }
    if pending.workspace_ref != binding.workspace_ref {
        return Err("workspace_ref does not match active binding".to_string());
    }
    let expected_path = crate::config::attempt_dir(workspace, &pending.job_id, &pending.attempt_id)
        .join(crate::managed_result::MANAGED_RESULT_FILENAME);
    let res_path = Path::new(&pending.result_file_path);
    if res_path != expected_path {
        return Err(format!(
            "result file path {} does not match expected {}",
            res_path.display(),
            expected_path.display()
        ));
    }
    if !res_path.exists() {
        return Err(format!(
            "result file does not exist: {}",
            res_path.display()
        ));
    }
    let sha = sha256_file(res_path)?;
    if sha != pending.result_file_sha256 {
        return Err(format!(
            "result file sha256 mismatch (expected {}, found {})",
            pending.result_file_sha256, sha
        ));
    }
    validate_managed_result_file(res_path)
        .map_err(|e| format!("result file content invalid: {e}"))?;
    Ok(())
}

async fn send_result_once(
    client: &BridgeClient,
    pending: &PendingResultRecord,
) -> Result<WorkerResultResponse, ClientError> {
    let res_path = Path::new(&pending.result_file_path);
    let payload = validate_managed_result_file(res_path)
        .map_err(|e| ClientError::protocol(format!("read result payload: {e}")))?;

    let req = WorkerResultRequest {
        worker_id: pending.worker_id.clone(),
        attempt_id: pending.attempt_id.clone(),
        claim_token: pending.claim_token.clone(),
        payload,
    };

    client
        .post_job_result(&pending.job_id, &req, &pending.resource_id)
        .await
}

fn ack_result_cleanup(workspace: &Path, pending: &PendingResultRecord) -> std::io::Result<()> {
    let record_path =
        state::result_outbox_record_path(workspace, &pending.job_id, &pending.attempt_id);
    remove_durable(&record_path)
}

fn emit(event: &str, job_id: &str, attempt_id: &str, workspace_ref: &str, extra: &str) {
    let obj = serde_json::json!({
        "event": event,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "workspace_ref": workspace_ref,
        "local_state": extra,
    });
    println!("{}", serde_json::to_string(&obj).unwrap());
}

fn current_stop(stop_rx: &watch::Receiver<Option<StopReason>>) -> Option<StopReason> {
    if let Some(reason) = stop_rx.borrow().clone() {
        return Some(reason);
    }
    if stop_rx.has_changed().is_err() {
        return Some(StopReason::ControllerGone);
    }
    None
}

fn stop_exit_code(reason: &StopReason) -> i32 {
    match reason {
        StopReason::UserRequested => 0,
        _ => 1,
    }
}

pub async fn drain_pending_results(
    client: &BridgeClient,
    workspace: &Path,
    binding: &BridgeBinding,
    worker_id: &str,
    stop_rx: &mut watch::Receiver<Option<StopReason>>,
) -> Result<(), i32> {
    let pending = match list_pending(workspace, binding) {
        Ok(list) => list,
        Err(e) => {
            eprintln!("bridge: pending result outbox invalid on startup: {e}");
            emit(
                "bridge_stopped",
                "",
                "",
                &binding.workspace_ref,
                "result_outbox_invalid",
            );
            return Err(1);
        }
    };
    for rec in pending {
        deliver_result_one(client, workspace, binding, worker_id, &rec, stop_rx).await?;
    }
    Ok(())
}

pub async fn deliver_result_one(
    client: &BridgeClient,
    workspace: &Path,
    binding: &BridgeBinding,
    worker_id: &str,
    pending: &PendingResultRecord,
    stop_rx: &mut watch::Receiver<Option<StopReason>>,
) -> Result<(), i32> {
    let mut failures = 0usize;
    loop {
        if let Some(reason) = current_stop(stop_rx) {
            return Err(stop_exit_code(&reason));
        }
        if let Err(e) =
            validate_pending_result_against_evidence(workspace, binding, worker_id, pending)
        {
            eprintln!("bridge: pending result evidence mismatch: {e}");
            emit(
                "bridge_stopped",
                &pending.job_id,
                &pending.attempt_id,
                &binding.workspace_ref,
                "result_outbox_evidence_mismatch",
            );
            return Err(1);
        }
        match send_result_once(client, pending).await {
            Ok(ok) => {
                if let Err(e) = ack_result_cleanup(workspace, pending) {
                    eprintln!("bridge: pending result cleanup durability unknown: {e}");
                    emit(
                        "bridge_stopped",
                        &pending.job_id,
                        &pending.attempt_id,
                        &binding.workspace_ref,
                        "result_cleanup_unknown",
                    );
                    return Err(1);
                }
                emit(
                    "server_result_ingested",
                    &pending.job_id,
                    &pending.attempt_id,
                    &binding.workspace_ref,
                    &ok.commit,
                );
                return Ok(());
            }
            Err(e) => match classify_result_delivery_error(&e) {
                DeliveryClass::Retry => {
                    emit(
                        "result_delivery_retry",
                        &pending.job_id,
                        &pending.attempt_id,
                        &binding.workspace_ref,
                        if e.outcome_unknown {
                            "outcome_unknown"
                        } else {
                            "transient"
                        },
                    );
                    let delay = delivery_backoff(failures);
                    failures += 1;
                    tokio::select! {
                        biased;
                        _ = stop_rx.changed() => {
                            return Err(stop_exit_code(&current_stop(stop_rx).unwrap_or(StopReason::ControllerGone)));
                        }
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                DeliveryClass::Stop => {
                    eprintln!("bridge: result delivery stopped: {e}");
                    emit(
                        "bridge_stopped",
                        &pending.job_id,
                        &pending.attempt_id,
                        &binding.workspace_ref,
                        "delivery_conflict",
                    );
                    return Err(1);
                }
            },
        }
    }
}

pub fn has_pending_results(
    workspace: &Path,
    binding: &BridgeBinding,
) -> Result<bool, result_outbox::ResultOutboxError> {
    Ok(!list_pending(workspace, binding)?.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::config::load_api_key;
    use crate::bridge::state::{self, BridgeBinding};
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const JOB: &str = "job-123e4567-e89b-12d3-a456-426614174001";
    const ATT: &str = "123e4567-e89b-12d3-a456-4266141740ab";
    const RES: &str = "res-123e4567-e89b-12d3-a456-426614174099";
    const WRK: &str = "wrk-0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMMIT: &str = "181abe952c1045fa2f9487aa834f5e65615c10ff";
    const RECEIVED_AT: &str = "2026-09-13T10:00:00.000Z";

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    fn binding(workspace: &std::path::Path) -> BridgeBinding {
        BridgeBinding {
            server_origin: "https://ceo.example.com".to_string(),
            user_id: "usr_result".to_string(),
            workspace_id: "ws_result".to_string(),
            workspace_ref: "ceo-agent-runtime".to_string(),
            canonical_workspace: workspace.to_path_buf(),
        }
    }

    fn test_client(url: &str) -> BridgeClient {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("key");
        std::fs::write(&key_path, "test-secret-key\n").unwrap();
        std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let key = load_api_key(&key_path).unwrap();
        BridgeClient::new(url.parse().unwrap(), key).unwrap()
    }

    fn persist_pending(workspace: &std::path::Path) -> PendingResultRecord {
        state::ensure_control_dirs(workspace).unwrap();
        let attempt = crate::config::attempt_dir(workspace, JOB, ATT);
        std::fs::create_dir_all(&attempt).unwrap();
        let result_path = attempt.join(crate::managed_result::MANAGED_RESULT_FILENAME);
        let bytes = br#"{"content":"hello from extractor"}"#;
        std::fs::write(&result_path, bytes).unwrap();
        let rec = PendingResultRecord::new(
            &binding(workspace),
            WRK,
            JOB,
            ATT,
            RES,
            TOKEN,
            result_path.to_str().unwrap(),
            &sha256_hex(bytes),
        )
        .unwrap();
        rec.persist(workspace).unwrap();
        rec
    }

    fn ack_body(replayed: bool, job_id: &str) -> String {
        format!(
            r#"{{"ok":true,"job_id":"{job_id}","attempt_id":"{ATT}","result_received":true,"resource_id":"{RES}","commit":"{COMMIT}","received_at":"{RECEIVED_AT}","replayed":{replayed}}}"#
        )
    }

    async fn spawn_json_ok(body: String) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let (mut sock, _) = match listener.accept().await {
                    Ok(v) => v,
                    Err(_) => break,
                };
                let body = body.clone();
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
                    let content_len: usize = head_str
                        .lines()
                        .find_map(|l| {
                            let lower = l.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().to_string())
                        })
                        .and_then(|v| v.parse().ok())
                        .unwrap_or(0);
                    let mut rest = head[header_end..].to_vec();
                    while rest.len() < content_len {
                        let n = sock.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        rest.extend_from_slice(&buf[..n]);
                    }
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    async fn deliver_with_ack(replayed: bool) {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path();
        let pending = persist_pending(workspace);
        let url = spawn_json_ok(ack_body(replayed, JOB)).await;
        let client = test_client(&url);
        let bind = binding(workspace);
        let (_tx, mut stop_rx) = watch::channel(None);
        deliver_result_one(&client, workspace, &bind, WRK, &pending, &mut stop_rx)
            .await
            .unwrap();
        let outbox = state::result_outbox_record_path(workspace, JOB, ATT);
        assert!(!outbox.exists(), "valid ACK must delete result-outbox");
        assert!(!has_pending_results(workspace, &bind).unwrap());
    }

    #[tokio::test]
    async fn first_result_ack_replayed_false_clears_outbox() {
        deliver_with_ack(false).await;
    }

    #[tokio::test]
    async fn replayed_result_ack_clears_outbox() {
        deliver_with_ack(true).await;
    }

    #[tokio::test]
    async fn mismatched_result_ack_is_outcome_unknown_and_keeps_outbox() {
        let tmp = tempfile::tempdir().unwrap();
        let workspace = tmp.path();
        let pending = persist_pending(workspace);
        let url = spawn_json_ok(ack_body(false, "job-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).await;
        let client = test_client(&url);
        let err = send_result_once(&client, &pending).await.unwrap_err();
        assert!(err.outcome_unknown);
        assert!(matches!(err.kind, ErrorKind::Protocol(_)));
        let outbox = state::result_outbox_record_path(workspace, JOB, ATT);
        assert!(outbox.exists(), "malformed ACK must leave result-outbox");
    }
}
