//! Deliver persisted outbox reports. The HTTP client stays single-shot;
//! this module owns retry, ACK cleanup, and fail-closed evidence binding.

use crate::bridge::client::{BridgeClient, ClientError, ErrorKind};
use crate::bridge::outbox::{self, list_pending, PendingReportRecord};
use crate::bridge::protocol::ExecutionReportOk;
use crate::bridge::report;
use crate::bridge::state::{self, BridgeBinding};
use crate::local_state::remove_durable;
use crate::runner::StopReason;
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

/// Classify a report-client error. `outcome_unknown` retries even when the
/// kind is `Protocol` (lost or malformed response after a possible commit).
/// Integrity `QUEUE_UNAVAILABLE` and pre-send local protocol failures stop.
pub fn classify_delivery_error(err: &ClientError) -> DeliveryClass {
    match &err.kind {
        ErrorKind::Unauthorized | ErrorKind::Forbidden | ErrorKind::IdentityMismatch { .. } => {
            DeliveryClass::Stop
        }
        ErrorKind::Server { code, reason, .. }
            if code == "QUEUE_UNAVAILABLE" && is_integrity_reason(reason.as_deref()) =>
        {
            DeliveryClass::Stop
        }
        ErrorKind::Server { code, .. }
            if matches!(
                code.as_str(),
                "JOB_NOT_FOUND" | "ASSIGNMENT_MISMATCH" | "REPORT_CONFLICT" | "JOB_FINISHED"
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
        _ if is_transient_infra(err) => DeliveryClass::Retry,
        _ => DeliveryClass::Stop,
    }
}

fn is_integrity_reason(reason: Option<&str>) -> bool {
    let Some(r) = reason else { return false };
    matches!(
        r,
        "CORRUPT_RECORD"
            | "CORRUPT_PLACEHOLDER"
            | "INCOMPLETE_SUBMISSION"
            | "UNSUPPORTED_SCHEMA_VERSION"
            | "INVALID_SCRIPT_RESPONSE"
            | "INVALID_ARGUMENT"
            | "UNSUPPORTED_OPERATION"
            | "CLOCK_REGRESSION"
    )
}

fn is_transient_infra(err: &ClientError) -> bool {
    match &err.kind {
        ErrorKind::Transport(_) => true,
        ErrorKind::Server { code, reason, .. }
            if code == "QUEUE_UNAVAILABLE" && !is_integrity_reason(reason.as_deref()) =>
        {
            true
        }
        _ => false,
    }
}

pub fn is_retryable_identity_error(err: &ClientError) -> bool {
    is_transient_infra(err)
}

fn emit(event: &str, job_id: &str, attempt_id: &str, workspace_ref: &str, extra: &str) {
    let obj = serde_json::json!({
        "event": event,
        "job_id": job_id,
        "attempt_id": attempt_id,
        "workspace_ref": workspace_ref,
        "local_state": extra,
    });
    println!(
        "{}",
        serde_json::to_string(&obj).unwrap_or_else(|_| "{}".to_string())
    );
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

/// Send the stored request once. Caller must already have rebound evidence.
pub async fn send_pending_once(
    client: &BridgeClient,
    pending: &PendingReportRecord,
) -> Result<ExecutionReportOk, ClientError> {
    client
        .report_execution(&pending.job_id, &pending.request)
        .await
}

/// Remove the pending file after a validated ACK. Failure means cleanup
/// durability is unknown: the Server already has the result.
pub fn ack_cleanup(workspace: &Path, pending: &PendingReportRecord) -> Result<(), std::io::Error> {
    let path = state::outbox_record_path(workspace, &pending.job_id, &pending.attempt_id);
    remove_durable(&path)
}

/// Verify identity, retrying only transient unavailability.
pub async fn verify_identity_until_ready(
    client: &BridgeClient,
    user_id: &str,
    workspace_id: &str,
    workspace_ref: &str,
    stop_rx: &mut watch::Receiver<Option<StopReason>>,
) -> Result<(), i32> {
    let mut failures = 0usize;
    loop {
        if let Some(reason) = current_stop(stop_rx) {
            return Err(stop_exit_code(&reason));
        }
        match client.verify_identity(user_id, workspace_id).await {
            Ok(_) => return Ok(()),
            Err(e) if is_retryable_identity_error(&e) => {
                emit(
                    "identity_retry",
                    "",
                    "",
                    workspace_ref,
                    "transient_unavailable",
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
            Err(e) => {
                eprintln!("bridge: identity check failed: {e}");
                emit("bridge_stopped", "", "", workspace_ref, "identity_failed");
                return Err(1);
            }
        }
    }
}

fn stop_exit_code(reason: &StopReason) -> i32 {
    match reason {
        StopReason::UserRequested => 0,
        _ => 1,
    }
}

/// Drain every pending report oldest-first. Stops the daemon on permanent
/// conflict or unconfirmed cleanup.
pub async fn drain_pending(
    client: &BridgeClient,
    workspace: &Path,
    binding: &BridgeBinding,
    worker_id: &str,
    stop_rx: &mut watch::Receiver<Option<StopReason>>,
) -> Result<(), i32> {
    let pending = match list_pending(workspace, binding) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("bridge: pending outbox is invalid: {e}");
            emit(
                "bridge_stopped",
                "",
                "",
                &binding.workspace_ref,
                "outbox_invalid",
            );
            return Err(1);
        }
    };
    for rec in pending {
        deliver_one(client, workspace, binding, worker_id, &rec, stop_rx).await?;
    }
    Ok(())
}

pub async fn deliver_one(
    client: &BridgeClient,
    workspace: &Path,
    binding: &BridgeBinding,
    worker_id: &str,
    pending: &PendingReportRecord,
    stop_rx: &mut watch::Receiver<Option<StopReason>>,
) -> Result<(), i32> {
    let mut failures = 0usize;
    loop {
        if let Some(reason) = current_stop(stop_rx) {
            return Err(stop_exit_code(&reason));
        }
        if let Err(e) =
            report::validate_pending_against_evidence(workspace, binding, worker_id, pending)
        {
            eprintln!("bridge: pending report evidence mismatch: {e}");
            emit(
                "bridge_stopped",
                &pending.job_id,
                &pending.attempt_id,
                &binding.workspace_ref,
                "outbox_evidence_mismatch",
            );
            return Err(1);
        }
        match send_pending_once(client, pending).await {
            Ok(ok) => {
                if let Err(e) = ack_cleanup(workspace, pending) {
                    eprintln!("bridge: pending cleanup durability unknown: {e}");
                    emit(
                        "bridge_stopped",
                        &pending.job_id,
                        &pending.attempt_id,
                        &binding.workspace_ref,
                        "cleanup_unknown",
                    );
                    return Err(1);
                }
                let extra = if ok.replayed {
                    "replayed:true"
                } else {
                    "replayed:false"
                };
                emit(
                    "server_result_reported",
                    &pending.job_id,
                    &pending.attempt_id,
                    &binding.workspace_ref,
                    extra,
                );
                return Ok(());
            }
            Err(e) => match classify_delivery_error(&e) {
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

pub fn has_pending(workspace: &Path, binding: &BridgeBinding) -> Result<bool, outbox::OutboxError> {
    Ok(!list_pending(workspace, binding)?.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transport() -> ClientError {
        ClientError {
            kind: ErrorKind::Transport("reset".to_string()),
            outcome_unknown: true,
        }
    }
    fn protocol_unknown() -> ClientError {
        ClientError {
            kind: ErrorKind::Protocol("malformed 2xx".to_string()),
            outcome_unknown: true,
        }
    }
    fn protocol_local() -> ClientError {
        ClientError {
            kind: ErrorKind::Protocol("invalid job id".to_string()),
            outcome_unknown: false,
        }
    }
    fn conflict() -> ClientError {
        ClientError {
            kind: ErrorKind::Server {
                status: 409,
                code: "REPORT_CONFLICT".to_string(),
                reason: None,
            },
            outcome_unknown: false,
        }
    }
    fn queue() -> ClientError {
        ClientError {
            kind: ErrorKind::Server {
                status: 503,
                code: "QUEUE_UNAVAILABLE".to_string(),
                reason: None,
            },
            outcome_unknown: true,
        }
    }
    fn queue_corrupt() -> ClientError {
        ClientError {
            kind: ErrorKind::Server {
                status: 503,
                code: "QUEUE_UNAVAILABLE".to_string(),
                reason: Some("CORRUPT_RECORD".to_string()),
            },
            outcome_unknown: true,
        }
    }
    fn unauthorized() -> ClientError {
        ClientError {
            kind: ErrorKind::Unauthorized,
            outcome_unknown: false,
        }
    }

    #[test]
    fn classifier_retries_outcome_unknown_protocol_and_transport() {
        assert_eq!(classify_delivery_error(&transport()), DeliveryClass::Retry);
        assert_eq!(
            classify_delivery_error(&protocol_unknown()),
            DeliveryClass::Retry
        );
        assert_eq!(classify_delivery_error(&queue()), DeliveryClass::Retry);
    }

    #[test]
    fn classifier_stops_on_local_protocol_auth_conflict_and_integrity() {
        assert_eq!(
            classify_delivery_error(&protocol_local()),
            DeliveryClass::Stop
        );
        assert_eq!(classify_delivery_error(&conflict()), DeliveryClass::Stop);
        assert_eq!(
            classify_delivery_error(&unauthorized()),
            DeliveryClass::Stop
        );
        assert_eq!(
            classify_delivery_error(&queue_corrupt()),
            DeliveryClass::Stop
        );
    }

    #[test]
    fn delivery_backoff_caps_at_30s() {
        assert_eq!(delivery_backoff(0), Duration::from_secs(1));
        assert_eq!(delivery_backoff(4), Duration::from_secs(15));
        assert_eq!(delivery_backoff(5), Duration::from_secs(30));
        assert_eq!(delivery_backoff(50), Duration::from_secs(30));
    }
}
