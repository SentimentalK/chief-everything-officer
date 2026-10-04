//! Shared owner for bounded operator-cancel convergence of the durable local
//! active-attempt marker (PROJECT-039).
//!
//! The Server is authoritative for the job lifecycle. When the Server's
//! device-scoped read model proves that the EXACT attempt recorded in
//! `active-attempt.json` is terminal CANCELLED, that marker can no longer
//! represent live or ambiguous execution: the attempt is dead and the local
//! durable state must converge through the existing durable cancellation
//! finalization path (sanitized cancelled history + marker removal). Any
//! other server state, transport failure, attempt identity mismatch, or local
//! marker corruption remains fail-closed: no local state is touched and
//! mutating callers keep refusing.
//!
//! Consumers (one shared owner — never separate truth tables):
//! - the daemon recovery path (`recovery_required` convergence), and
//! - server-connected project mutations, which perform ONE bounded
//!   reconciliation before failing closed with TARGET_IN_USE.

use std::time::Duration;
use thiserror::Error;

use crate::client::{ConnectorClient, JobDetail};
use crate::credential::DeviceCredential;
use crate::enrollment::now_utc_ms;
use crate::local_state::{atomic_write_json, remove_durable, ExecutionLock};
use crate::outbox::{operator_cancel_digest, SanitizedHistoryRecord, HISTORY_SCHEMA_VERSION};
use crate::paths::ConnectorPaths;
use crate::scheduler::{ActiveAttempt, SchedulerError};

#[derive(Error, Debug)]
pub enum FinalizeLocalOperatorCancelledError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Local active-attempt state error: {0}")]
    State(#[from] SchedulerError),
}

/// The exact-attempt operator-cancel predicate shared by every convergence
/// consumer: the Server proves the job is terminal CANCELLED AND the
/// device-scoped execution read model carries the EXACT local attempt_id.
/// A missing execution part leaves the attempt identity ambiguous and must
/// never satisfy the predicate.
pub fn server_proves_exact_operator_cancelled(detail: &JobDetail, local_attempt_id: &str) -> bool {
    detail.state == "terminal"
        && detail.execution_status.as_deref() == Some("CANCELLED")
        && detail.execution.as_ref().map(|e| e.attempt_id.as_str()) == Some(local_attempt_id)
}

/// Terminalizes a local active attempt as operator-cancelled (Wave 2B
/// finalization; the single durable owner shared by the daemon and the
/// project-side bounded reconciliation).
///
/// Used when the server has authoritatively CANCELLED the job (stale runner
/// convergence, live interruption, or post-cancel project convergence).
/// Best-effort idempotent: if the active attempt on disk no longer matches
/// (already cleaned up), this is a no-op. History/audit durability is
/// preserved exactly: a sanitized cancelled history record is written before
/// the marker is removed, both atomically and durably.
pub fn finalize_local_operator_cancelled(
    paths: &ConnectorPaths,
    active: &ActiveAttempt,
) -> Result<(), FinalizeLocalOperatorCancelledError> {
    let _lock = ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        Duration::from_secs(5),
        Duration::from_millis(50),
    )?;

    // Re-check under the lock: another path may have already cleaned up.
    let current = match ActiveAttempt::load(&paths.active_attempt_file())? {
        Some(c) if c.attempt_id == active.attempt_id => c,
        _ => return Ok(()),
    };

    let history = SanitizedHistoryRecord {
        schema_version: HISTORY_SCHEMA_VERSION,
        job_id: current.job_id.clone(),
        attempt_id: current.attempt_id.clone(),
        target_id: current.target_id.clone(),
        status: "cancelled".to_string(),
        receipt_sha256: None,
        duration_ms: None,
        terminal_report_sha256: operator_cancel_digest(&current.job_id, &current.attempt_id),
        recorded_at_ms: now_utc_ms(),
    };
    let hist_file = paths.history_file(&current.job_id, &current.attempt_id);
    atomic_write_json(&hist_file, &history)?;

    remove_durable(&paths.active_attempt_file())?;
    Ok(())
}

/// Outcome of ONE bounded reconciliation of the local active-attempt marker
/// against Server truth. `Blocked` always leaves every byte of local state
/// untouched; `reason` is an actionable explanation for the fail-closed
/// refusal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperatorCancelReconciliation {
    /// The Server proved the exact local active attempt is terminal CANCELLED
    /// and the local marker was durably finalized (cancelled history written,
    /// marker removed).
    Finalized,
    /// No local active-attempt marker exists (nothing to converge).
    NoMarker,
    /// The marker remains: the Server could not prove exact operator-cancel.
    Blocked { reason: String },
}

/// ONE bounded reconciliation attempt (single server read + at most one
/// durable finalization): loads the device's local active-attempt marker and
/// converges it when (and only when) the server proves the exact attempt is
/// terminal CANCELLED. No polling, no daemon dependency.
pub async fn reconcile_active_attempt_with_server_operator_cancel(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    cred: &DeviceCredential,
) -> OperatorCancelReconciliation {
    let active = match ActiveAttempt::load(&paths.active_attempt_file()) {
        Ok(None) => return OperatorCancelReconciliation::NoMarker,
        Ok(Some(a)) => a,
        Err(e) => {
            return OperatorCancelReconciliation::Blocked {
                reason: format!(
                "local active-attempt state is corrupt or unreadable ({e}) (LOCAL_STATE_INVALID)"
            ),
            }
        }
    };

    // A marker belonging to another device/server identity can never be
    // reconciled through this credential's device-scoped read model; the
    // daemon treats the same condition as fail-closed recovery. Keep the
    // project path equally conservative.
    if active.server_origin != cred.server_origin || active.device_id != cred.device_id {
        return OperatorCancelReconciliation::Blocked {
            reason: format!(
                "local active attempt identity does not match this device's credential (local server '{}' / device '{}', credential server '{}' / device '{}')",
                active.server_origin, active.device_id, cred.server_origin, cred.device_id
            ),
        };
    }

    let detail = match client.get_job(cred, &active.job_id, false).await {
        Ok(d) => d,
        Err(e) => {
            return OperatorCancelReconciliation::Blocked {
                reason: format!(
                    "server job truth unavailable for job '{}' ({e})",
                    active.job_id
                ),
            }
        }
    };

    if !server_proves_exact_operator_cancelled(&detail, &active.attempt_id) {
        let server_attempt = detail
            .execution
            .as_ref()
            .map(|e| e.attempt_id.as_str())
            .unwrap_or("<missing>");
        return OperatorCancelReconciliation::Blocked {
            reason: format!(
                "server does not prove local attempt is terminal CANCELLED (server state '{}', execution status '{}', server attempt '{}', local attempt '{}')",
                detail.state,
                detail.execution_status.as_deref().unwrap_or("<unknown>"),
                server_attempt,
                active.attempt_id
            ),
        };
    }

    match finalize_local_operator_cancelled(paths, &active) {
        Ok(()) => OperatorCancelReconciliation::Finalized,
        Err(e) => OperatorCancelReconciliation::Blocked {
            reason: format!("durable operator-cancel finalization failed: {e}"),
        },
    }
}
