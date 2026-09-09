//! Bridge controller: discovers identity-scoped jobs, claims them under a
//! server lease, runs them through the controlled Runner, and keeps the lease
//! alive — for one canonical workspace / alias per process.
//!
//! Per active attempt the controller runs a single async select loop.
//! The select arms are independent futures that each borrow a distinct
//! resource, so no two arms mutate shared locals concurrently: an external stop
//! (`stop_rx.changed()`), the Runner signals, a watchdog tick, a heartbeat HTTP
//! send, and the Runner task completion. Whichever arm fires is turned into an
//! [`Arm`] value and handled in one place after the select, where all shared
//! state (`stop_at`, `stopping`, …) is mutated. Because the heartbeat HTTP send
//! lives inside a select arm future, an 8 s in-flight heartbeat never blocks
//! the watchdog or the stop request.
//!
//! Only one of `start` / heartbeat / claim is ever in flight per attempt: the
//! select services one arm at a time and `start` runs in the post-select
//! handler (never concurrently with a heartbeat, since the loop is single-
//! threaded between select iterations).
//!
//! Each *unforgettable execution decision* is persisted before the matching
//! external action. Local completion saves receipt + history and clears
//! `active`; it never invents a server-side `succeeded`.

use crate::bridge::client::{BridgeClient, ClientError, ErrorKind};
use crate::bridge::config::{BridgeConfig, ExpectedIdentity};
use crate::bridge::lease::{
    claim_backoff, heartbeat_backoff, stop_at_from_remaining, BootTime, Clock, HEARTBEAT_INTERVAL,
    STOP_MARGIN, TAIL_POLL, WATCHDOG_PERIOD,
};
use crate::bridge::protocol::{
    ClaimRequest, Execution, HeartbeatOk, LeaseOperationRequest, StartOk,
};
use crate::bridge::state::{
    self, ActiveAttempt, AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase,
};
use crate::local_state::atomic_write_durable;
use crate::receipt::TaskReceipt;
use crate::runner::control::control_channel;
use crate::runner::{BridgeReceiptContext, Runner, RunnerError, RunnerSignal, StopReason};
use chrono::{DateTime, FixedOffset};
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

fn sha256_of(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    format!("{:x}", h.finalize())
}

/// Versioned plain-text prompt envelope: task goal + acceptance kept verbatim,
/// plus the managed-workspace constraint. Never injects tokens/keys/credentials.
fn build_envelope(canonical: &Path, payload: &ClaimPayload) -> String {
    format!(
        "# CEO task\n\nYou are operating on the managed workspace {:?}; keep outputs \
         there. Follow the workspace AGENTS.md and Doctor constraints.\n\n\
         ## Task goal\n\n{}\n\n## Acceptance requirements\n\n{}",
        canonical.display(),
        payload.prompt,
        payload.acceptance,
    )
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

fn parse_rfc3339(s: &str) -> Option<DateTime<FixedOffset>> {
    DateTime::parse_from_rfc3339(s).ok()
}

fn remaining_to(deadline: &str, server_time: &str) -> Option<Duration> {
    let d = parse_rfc3339(deadline)?;
    let s = parse_rfc3339(server_time)?;
    let rem = d.signed_duration_since(s);
    if rem <= chrono::Duration::zero() {
        None
    } else {
        rem.to_std().ok()
    }
}

/// An in-memory, conservatively-confirmed lease established from a validated
/// Server claim/start/heartbeat response. All deadlines are expressed as local
/// boot-time instants anchored at the moment the request was *sent* (so round
/// trip is conservatively subtracted) — never derived from the local wall
/// clock. `phase` is the last Server-confirmed execution phase.
#[derive(Clone, Copy)]
struct ConfirmedLease {
    /// Conservative local instant past which the confirmed lease may have
    /// expired (lease_expires_at mapped onto boot time, minus nothing here).
    lease_valid_until_boot: BootTime,
    /// Server-determined phase deadline mapped to boot time. In `claimed` it is
    /// the start deadline; in `running` the execution deadline. Heartbeats may
    /// extend the lease but never this deadline.
    phase_deadline_boot: BootTime,
    /// `min(lease_valid_until_boot, phase_deadline_boot) - STOP_MARGIN`; the
    /// line at which the controller must stop issuing new work.
    stop_at_boot: BootTime,
    phase: crate::bridge::protocol::Phase,
}

impl ConfirmedLease {
    /// Builds a conservative lease from a validated response. `sent_boot` is
    /// the boot clock sampled before the request went out. Returns `None` when
    /// the numbers are unusable or the stop line is already in the past (the
    /// lease is immediately expired).
    fn from_execution(
        exec: &Execution,
        server_time: &str,
        sent_boot: BootTime,
    ) -> Option<ConfirmedLease> {
        let running = exec.phase == "running";
        let lease_rem = remaining_to(&exec.lease_expires_at, server_time)?;
        // start_deadline / execution_deadline are always present for the
        // matching phase (the client validated this before we got here).
        let deadline_str = if running {
            exec.execution_deadline.as_deref()?
        } else {
            &exec.start_deadline
        };
        let phase_rem = remaining_to(deadline_str, server_time)?;
        let lease_valid_until_boot = sent_boot.checked_add(lease_rem)?;
        let phase_deadline_boot = sent_boot.checked_add(phase_rem)?;
        let stop_at = stop_at_from_remaining(sent_boot, lease_rem.min(phase_rem))?;
        Some(ConfirmedLease {
            lease_valid_until_boot,
            phase_deadline_boot,
            stop_at_boot: stop_at,
            phase: if running {
                crate::bridge::protocol::Phase::Running
            } else {
                crate::bridge::protocol::Phase::Claimed
            },
        })
    }
}

/// The controller for one canonical workspace / alias.
pub struct Worker {
    client: Arc<BridgeClient>,
    clock: Arc<dyn Clock>,
    runner: Runner,
    origin: String,
    expected: ExpectedIdentity,
    workspace_ref: String,
    workspace: PathBuf,
    worker_id: String,
}

impl Worker {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: &BridgeConfig,
        expected: ExpectedIdentity,
        workspace_ref: &str,
        workspace: PathBuf,
        client: BridgeClient,
        clock: Arc<dyn Clock>,
        runner: Runner,
        worker_id: String,
    ) -> Worker {
        Worker {
            client: Arc::new(client),
            clock,
            runner,
            origin: cfg.server_base.as_str().trim_end_matches('/').to_string(),
            expected,
            workspace_ref: workspace_ref.to_string(),
            workspace,
            worker_id,
        }
    }

    fn binding(&self) -> BridgeBinding {
        BridgeBinding {
            server_origin: self.origin.clone(),
            user_id: self.expected.user_id.clone(),
            workspace_id: self.expected.workspace_id.clone(),
            workspace_ref: self.workspace_ref.clone(),
            canonical_workspace: self.workspace.clone(),
        }
    }

    /// Runs until stopped. `stop_rx` becomes Some on SIGINT/SIGTERM. Returns
    /// the process exit code.
    pub async fn run(&mut self, mut stop_rx: watch::Receiver<Option<StopReason>>) -> i32 {
        let binding = self.binding();
        if let Err(e) = self
            .client
            .verify_identity(&binding.user_id, &binding.workspace_id)
            .await
        {
            eprintln!("bridge: identity check failed: {e}");
            emit(
                "bridge_stopped",
                "",
                "",
                &self.workspace_ref,
                "identity_failed",
            );
            return 1;
        }

        let mut state = match state::try_load_or_fresh(&self.workspace, &binding) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("bridge: fatal state error: {e}");
                emit(
                    "bridge_stopped",
                    "",
                    "",
                    &self.workspace_ref,
                    "state_load_failed",
                );
                return 1;
            }
        };
        self.worker_id = state.worker_id.clone();

        if let Err(code) = self.recover_startup(&mut state, &mut stop_rx).await {
            return code;
        }

        emit("bridge_ready", "", "", &self.workspace_ref, "ready");
        self.discovery_loop(&mut state, &mut stop_rx).await
    }

    async fn recover_startup(
        &mut self,
        state: &mut BridgeState,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> Result<(), i32> {
        let Some(active) = state.active.clone() else {
            return Ok(());
        };
        let job_id = active.job_id.clone();
        let attempt_id = active.attempt_id.clone();
        match active.phase {
            LocalPhase::ClaimIntent | LocalPhase::Claimed => {
                emit(
                    "bridge_ready",
                    &job_id,
                    &attempt_id,
                    &self.workspace_ref,
                    "resume_claim",
                );
                self.finish_claimed(state, active, None, stop_rx).await
            }
            LocalPhase::RecoveryRequired => {
                emit(
                    "recovery_required",
                    &job_id,
                    &attempt_id,
                    &self.workspace_ref,
                    "left_over",
                );
                Err(1)
            }
            _ => {
                let attempt_dir = attempt_dir_for(&self.workspace, &job_id, &attempt_id);
                let receipt_ok = attempt_dir.join("receipt.json").exists();
                let history = AttemptHistoryRecord::load(&self.workspace, &job_id, &attempt_id);
                if receipt_ok && matches!(history, Ok(Some(_))) {
                    state.active = None;
                    let _ = state.persist(&self.workspace);
                    emit(
                        "bridge_ready",
                        &job_id,
                        &attempt_id,
                        &self.workspace_ref,
                        "finalized",
                    );
                    Ok(())
                } else {
                    emit(
                        "recovery_required",
                        &job_id,
                        &attempt_id,
                        &self.workspace_ref,
                        "dispatch_intent_without_receipt",
                    );
                    Err(1)
                }
            }
        }
    }

    async fn discovery_loop(
        &mut self,
        state: &mut BridgeState,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> i32 {
        let mut cursor = "0-0".to_string();
        let mut pages = 0usize;
        loop {
            if let Some(reason) = stop_rx.borrow().clone() {
                return stop_exit(&reason);
            }
            let page = match self.client.pending(&self.workspace_ref, &cursor).await {
                Ok(p) => p,
                Err(e) => match e.kind {
                    ErrorKind::Unauthorized
                    | ErrorKind::Forbidden
                    | ErrorKind::Redirect(_)
                    | ErrorKind::IdentityMismatch { .. } => {
                        emit("bridge_stopped", "", "", &self.workspace_ref, "auth");
                        return 1;
                    }
                    ErrorKind::Server { ref code, .. } if code == "BRIDGE_DISABLED" => {
                        emit(
                            "bridge_stopped",
                            "",
                            "",
                            &self.workspace_ref,
                            "bridge_disabled",
                        );
                        return 1;
                    }
                    ErrorKind::Server { ref code, .. } if code != "QUEUE_UNAVAILABLE" => {
                        emit("bridge_stopped", "", "", &self.workspace_ref, "protocol");
                        return 1;
                    }
                    _ => {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        continue;
                    }
                },
            };

            if !page.jobs.is_empty() {
                for job in &page.jobs {
                    if let Some(reason) = stop_rx.borrow().clone() {
                        return stop_exit(&reason);
                    }
                    if let Err(code) = self.claim_and_run(state, job, stop_rx).await {
                        return code;
                    }
                }
            }

            pages += 1;
            cursor = page.next_cursor.clone();
            if page.has_more {
                if pages >= 4 {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    pages = 0;
                }
            } else {
                tokio::time::sleep(TAIL_POLL).await;
            }
        }
    }
}

fn attempt_dir_for(workspace: &Path, job_id: &str, attempt_id: &str) -> PathBuf {
    crate::config::attempt_dir(workspace, job_id, attempt_id)
}

fn stop_exit(reason: &StopReason) -> i32 {
    match reason {
        StopReason::UserRequested => 0,
        _ => 1,
    }
}

fn job_dir_has_attempts(workspace: &Path, job_id: &str) -> bool {
    let dir = crate::config::job_dir(workspace, job_id).join("attempts");
    match std::fs::read_dir(dir) {
        Ok(mut rd) => rd.next().is_some(),
        Err(_) => false,
    }
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(sha256_of_bytes(&bytes))
}

fn sha256_of_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

/// The two kinds of server lease-write this loop performs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum OpKind {
    Heartbeat,
    Start,
}

/// A lease-write HTTP request held *across* select! rounds so a watchdog/stop
/// tick can never cancel an already-issued request. The future owns clones of
/// the shared client and request strings, so it is `'static`.
enum PendingOp {
    Heartbeat {
        sent_boot: BootTime,
        future: BoxFuture<'static, Result<HeartbeatOk, ClientError>>,
    },
    Start {
        sent_boot: BootTime,
        future: BoxFuture<'static, Result<StartOk, ClientError>>,
    },
}

/// Outcome observed when a retained lease-write future completes, or when a
/// previously scheduled dispatch time is reached.
enum LeaseEvt {
    HeartbeatDone {
        sent: BootTime,
        res: Result<HeartbeatOk, ClientError>,
    },
    StartDone {
        sent: BootTime,
        res: Result<StartOk, ClientError>,
    },
    /// It is time to dispatch the requested op (nothing is currently in flight).
    Due(OpKind),
}

/// What a failed lease-write should lead to next.
#[derive(Debug)]
enum FaultAction {
    /// Retry with the same identity/attempt/token (caller picks the delay).
    Retry,
    /// Terminal: stop and keep the attempt for recovery. Never auto-resend.
    Stop(StopReason),
}

/// Classifies a lease-write failure into retry vs stop. Only transport faults,
/// genuinely retryable server errors (5xx / QUEUE_UNAVAILABLE), and unknown
/// outcomes worth re-confirming retry; confirmed rejections and non-retryable
/// protocol/auth faults stop the attempt (keeping its identity/token).
fn classify_write_fault(e: &ClientError) -> FaultAction {
    use ErrorKind::*;
    match &e.kind {
        Transport(_) => FaultAction::Retry,
        Server { status, .. } if *status >= 500 => FaultAction::Retry,
        Server { code, .. } if code == "QUEUE_UNAVAILABLE" => FaultAction::Retry,
        Server { code, reason, .. } if code == "LEASE_EXPIRED" => {
            FaultAction::Stop(StopReason::LeaseExpired {
                reason: reason.clone(),
            })
        }
        Unauthorized | Forbidden | IdentityMismatch { .. } => {
            FaultAction::Stop(StopReason::IdentityRevoked)
        }
        Redirect(_) | Protocol(_) | TooLarge => FaultAction::Stop(StopReason::ProtocolError),
        // Any other server decision is not a confirmed success; keep the
        // attempt and stop rather than guessing.
        Server { .. } => FaultAction::Stop(StopReason::LeaseUnconfirmed),
    }
}

/// Delay for the `attempt`-th consecutive failure of a lease op, from the fixed
/// heartbeat/start backoff schedule.
fn lease_op_backoff(kind: OpKind, attempt: usize) -> Duration {
    match kind {
        OpKind::Heartbeat => heartbeat_backoff(attempt),
        OpKind::Start => heartbeat_backoff(attempt),
    }
}

/// Conservative mapping from a (claimed-phase) confirmed lease.
fn lease_stop_reason(dispatched: bool) -> StopReason {
    if dispatched {
        StopReason::TaskTimedOut
    } else {
        StopReason::LeaseExpired { reason: None }
    }
}

/// What the daemon should do after one attempt reaches a local end state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptDisposition {
    /// Cleanly finalized and safe to claim the next job.
    Continue,
    /// Finalized but the daemon should stop (control/lease/doctor-blocked), not
    /// consume more jobs from the batch.
    StopDaemon,
    /// Teardown/stop was not confirmed: the process may still be running. Keep
    /// the attempt active for recovery; do not finalize or clear it.
    KeepActiveRecovery,
}

/// Classifies a local attempt outcome into a daemon disposition. Only an
/// explicitly-confirmed unconfirmed-stop (PROCESS_STOP_UNCONFIRMED) keeps the
/// attempt for recovery; every other result is first finalized, then either
/// lets the daemon continue (clean completion, single business failure, task
/// timeout, user-requested cancel) or stops it (doctor/preflight BLOCKED, and
/// lease/control interruptions) so a bad environment is not re-consumed.
fn classify_disposition(receipt: &TaskReceipt) -> AttemptDisposition {
    let code = receipt
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    if code == "PROCESS_STOP_UNCONFIRMED" {
        return AttemptDisposition::KeepActiveRecovery;
    }
    match receipt.execution_status.as_str() {
        "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED" => AttemptDisposition::Continue,
        // BLOCKED means NotStarted (Doctor/preflight/environment denied): stop
        // so the daemon does not burn the whole queue against a bad workspace.
        "BLOCKED" => AttemptDisposition::StopDaemon,
        // INTERRUPTED = lease/control failure with the attempt finalized.
        "INTERRUPTED" => AttemptDisposition::StopDaemon,
        _ => AttemptDisposition::StopDaemon,
    }
}

impl Worker {
    /// Claim and run one discovery candidate to local completion.
    async fn claim_and_run(
        &mut self,
        state: &mut BridgeState,
        job: &crate::bridge::protocol::PendingJob,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> Result<(), i32> {
        if job_dir_has_attempts(&self.workspace, &job.job_id) {
            return Ok(());
        }
        if state.active.as_ref().map(|a| a.job_id.as_str()) == Some(job.job_id.as_str()) {
            return Ok(());
        }
        if let Some(a) = &state.active {
            if matches!(a.phase, LocalPhase::ClaimIntent | LocalPhase::Claimed)
                && a.job_id != job.job_id
            {
                return Ok(());
            }
        }

        let attempt_id = state::new_attempt_id();
        let token = state::generate_lease_token().map_err(|_| 1)?;
        state.active = Some(ActiveAttempt {
            job_id: job.job_id.clone(),
            attempt_id: attempt_id.clone(),
            lease_token: token.clone(),
            phase: LocalPhase::ClaimIntent,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: false,
            stop_error: None,
        });
        if state.persist(&self.workspace).is_err() {
            return Err(1);
        }

        let req = ClaimRequest {
            worker_id: self.worker_id.clone(),
            attempt_id: attempt_id.clone(),
            workspace_ref: self.workspace_ref.clone(),
            lease_token: token,
        };
        match self
            .claim_replay(state, &job.job_id, &attempt_id, &req)
            .await?
        {
            Some((active, lease)) => self.finish_claimed(state, active, lease, stop_rx).await,
            None => {
                state.active = None;
                let _ = state.persist(&self.workspace);
                Ok(())
            }
        }
    }

    /// Replays a claim until its result is known. Returns Some on Confirmed
    /// (with a conservatively-confirmed initial lease), None on NotMine; fatal
    /// errors are `Err`.
    async fn claim_replay(
        &mut self,
        state: &mut BridgeState,
        job_id: &str,
        attempt_id: &str,
        req: &ClaimRequest,
    ) -> Result<Option<(ActiveAttempt, Option<ConfirmedLease>)>, i32> {
        let window_start = self.clock.now_boot().map_err(|_| 1)?;
        let mut attempt_no = 0usize;
        loop {
            // Sample the boot clock before sending so round-trip time is
            // conservatively subtracted from the confirmed lease.
            let sent_boot = self.clock.now_boot().map_err(|_| 1)?;
            match self.client.claim(job_id, req).await {
                Ok(ok) => {
                    let lease =
                        ConfirmedLease::from_execution(&ok.execution, &ok.server_time, sent_boot);
                    if ok.execution.phase == "running" {
                        // The Server already considers this attempt running; we
                        // cannot prove local execution has not started. Preserve
                        // state and require recovery — never resend the prompt.
                        emit(
                            "recovery_required",
                            job_id,
                            attempt_id,
                            &self.workspace_ref,
                            "claim_replayed_running",
                        );
                        let a = state.active.as_mut().unwrap();
                        a.phase = LocalPhase::RecoveryRequired;
                        let _ = state.persist(&self.workspace);
                        return Err(1);
                    }
                    let payload = ClaimPayload::from_wire(&ok.job);
                    let a = state.active.as_mut().unwrap();
                    a.phase = LocalPhase::Claimed;
                    a.claim = Some(payload);
                    if state.persist(&self.workspace).is_err() {
                        return Err(1);
                    }
                    return Ok(state.active.clone().map(|act| (act, lease)));
                }
                Err(e) => match e.kind {
                    ErrorKind::Server { code, .. }
                        if matches!(
                            code.as_str(),
                            "JOB_ALREADY_CLAIMED" | "JOB_EXPIRED" | "JOB_NOT_FOUND"
                        ) =>
                    {
                        return Ok(None);
                    }
                    ErrorKind::Server { code, .. }
                        if matches!(
                            code.as_str(),
                            "IDEMPOTENCY_CONFLICT" | "WORKSPACE_MISMATCH" | "LEASE_MISMATCH"
                        ) =>
                    {
                        emit(
                            "bridge_stopped",
                            job_id,
                            attempt_id,
                            &self.workspace_ref,
                            &code,
                        );
                        return Err(1);
                    }
                    ErrorKind::Unauthorized
                    | ErrorKind::Forbidden
                    | ErrorKind::Redirect(_)
                    | ErrorKind::IdentityMismatch { .. } => {
                        emit(
                            "bridge_stopped",
                            job_id,
                            attempt_id,
                            &self.workspace_ref,
                            "auth",
                        );
                        return Err(1);
                    }
                    _ => {
                        let now = self.clock.now_boot().map_err(|_| 1)?;
                        if now.saturating_sub(window_start)
                            > crate::bridge::lease::CLAIM_RECOVERY_WINDOW
                        {
                            emit(
                                "bridge_stopped",
                                job_id,
                                attempt_id,
                                &self.workspace_ref,
                                "claim_unknown_timeout",
                            );
                            return Err(1);
                        }
                        let delay = claim_backoff(attempt_no);
                        attempt_no += 1;
                        tokio::time::sleep(delay).await;
                    }
                },
            }
        }
    }

    /// Runs an already-claimed attempt to local completion and finalizes it.
    /// `lease` is the conservatively-confirmed initial lease from the claim
    /// response (or `None` on a recovery resume, which re-establishes it via a
    /// heartbeat at the top of the control loop).
    async fn finish_claimed(
        &mut self,
        state: &mut BridgeState,
        active: ActiveAttempt,
        lease: Option<ConfirmedLease>,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> Result<(), i32> {
        let job_id = active.job_id.clone();
        let attempt_id = active.attempt_id.clone();
        let payload = active.claim.clone().ok_or_else(|| {
            emit(
                "bridge_stopped",
                &job_id,
                &attempt_id,
                &self.workspace_ref,
                "state_invalid",
            );
            1
        })?;

        let prompt_path = state::prompt_path(&self.workspace, &job_id, &attempt_id);
        state::ensure_control_dirs(&self.workspace).map_err(|_| 1)?;
        state::reject_symlink_target(&prompt_path).map_err(|_| 1)?;
        if let Some(parent) = prompt_path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| 1)?;
        }
        atomic_write_durable(
            &prompt_path,
            build_envelope(&self.workspace, &payload).as_bytes(),
        )
        .map_err(|_| 1)?;

        let receipt = self
            .run_managed_attempt(
                state,
                &job_id,
                &attempt_id,
                &active,
                &prompt_path,
                lease,
                stop_rx,
            )
            .await?;

        // Decide, from the local execution result + teardown evidence, what the
        // daemon does next. An unconfirmed stop means the process may still be
        // running: never finalize or clear that attempt — keep it for recovery.
        let disposition = classify_disposition(&receipt);
        if disposition == AttemptDisposition::KeepActiveRecovery {
            emit(
                "recovery_required",
                &job_id,
                &attempt_id,
                &self.workspace_ref,
                "stop_unconfirmed",
            );
            let a = state.active.as_mut().unwrap();
            a.phase = LocalPhase::RecoveryRequired;
            if state.persist(&self.workspace).is_err() {
                return Err(1);
            }
            return Err(1);
        }

        let attempt_dir = attempt_dir_for(&self.workspace, &job_id, &attempt_id);
        // Hash the finalized receipt over its raw bytes (never lossy-UTF-8 text),
        // so a hash mismatch means the on-disk evidence differs byte-for-byte.
        let rec_sha = match sha256_file(&attempt_dir.join("receipt.json")) {
            Ok(s) => s,
            Err(_) => {
                emit(
                    "bridge_stopped",
                    &job_id,
                    &attempt_id,
                    &self.workspace_ref,
                    "receipt_unreadable",
                );
                return Err(1);
            }
        };
        // Actual envelope bytes hash: the prompt that was really written and made
        // available to the executor (distinct from the raw claimed prompt).
        let envelope_sha = match sha256_file(&prompt_path) {
            Ok(s) => s,
            Err(_) => {
                emit(
                    "bridge_stopped",
                    &job_id,
                    &attempt_id,
                    &self.workspace_ref,
                    "envelope_unreadable",
                );
                return Err(1);
            }
        };
        let dispatch_happened = receipt
            .bridge_context
            .as_ref()
            .map(|bc| bc.task_dispatch_intent)
            .unwrap_or(false);
        let history = state::new_history_record(
            &self.binding(),
            &self.worker_id,
            &job_id,
            &attempt_id,
            &sha256_of(&payload.prompt),
            &sha256_of(&payload.acceptance),
            &envelope_sha,
            &rec_sha,
            dispatch_happened,
            &active.lease_token,
        );
        // A durable history must be recorded before the active attempt is
        // cleared; neither step may be swallowed.
        history.persist(&self.workspace).map_err(|_| 1)?;
        state.active = None;
        state.persist(&self.workspace).map_err(|_| 1)?;
        emit(
            "local_result_saved",
            &job_id,
            &attempt_id,
            &self.workspace_ref,
            "server_result_reported:false",
        );
        if disposition == AttemptDisposition::StopDaemon {
            // The attempt is finalized (history recorded, active cleared), but
            // the daemon stops rather than consuming further jobs.
            return Err(1);
        }
        let _ = receipt;
        Ok(())
    }
}

/// One outcome of the select loop iteration.
#[allow(clippy::large_enum_variant)]
enum Arm {
    ExternalStop,
    Signal(Option<(RunnerSignal, oneshot::Sender<()>)>),
    Watchdog,
    Lease(LeaseEvt),
    Done(Result<Result<TaskReceipt, RunnerError>, tokio::task::JoinError>),
}

/// Reads the boot clock, mapping a clock fault to a conservative stop reason.
fn boot_now(clock: &dyn Clock) -> Result<BootTime, StopReason> {
    clock.now_boot().map_err(|_| StopReason::LeaseUnconfirmed)
}

/// Builds a retained heartbeat future. It owns clones of the shared client and
/// request strings so the in-flight request survives watchdog/stop ticks.
fn make_heartbeat_future(
    client: &Arc<BridgeClient>,
    worker_id: &str,
    job_id: &str,
    attempt_id: &str,
    token: &str,
) -> BoxFuture<'static, Result<HeartbeatOk, ClientError>> {
    let c = Arc::clone(client);
    let wid = worker_id.to_string();
    let jid = job_id.to_string();
    let aid = attempt_id.to_string();
    let tok = token.to_string();
    Box::pin(async move {
        let req = LeaseOperationRequest {
            worker_id: wid,
            attempt_id: aid,
            lease_token: tok,
        };
        c.heartbeat(&jid, &req).await
    })
}

/// Builds a retained start future.
fn make_start_future(
    client: &Arc<BridgeClient>,
    worker_id: &str,
    job_id: &str,
    attempt_id: &str,
    token: &str,
) -> BoxFuture<'static, Result<StartOk, ClientError>> {
    let c = Arc::clone(client);
    let wid = worker_id.to_string();
    let jid = job_id.to_string();
    let aid = attempt_id.to_string();
    let tok = token.to_string();
    Box::pin(async move {
        let req = LeaseOperationRequest {
            worker_id: wid,
            attempt_id: aid,
            lease_token: tok,
        };
        c.start(&jid, &req).await
    })
}

/// Merges a heartbeat-confirmed lease into the current one. A heartbeat may
/// extend the lease expiry but never the Server-fixed execution/start deadline;
/// the earliest confirmed phase deadline is retained.
fn lease_after_heartbeat(prev: Option<ConfirmedLease>, new: ConfirmedLease) -> ConfirmedLease {
    use crate::bridge::protocol::Phase;
    let deadline = match prev {
        Some(p) if p.phase == Phase::Running && new.phase == Phase::Running => {
            p.phase_deadline_boot.min(new.phase_deadline_boot)
        }
        _ => new.phase_deadline_boot,
    };
    let stop_base = new.lease_valid_until_boot.min(deadline);
    ConfirmedLease {
        lease_valid_until_boot: new.lease_valid_until_boot,
        phase_deadline_boot: deadline,
        stop_at_boot: stop_base.checked_sub(STOP_MARGIN).unwrap_or(stop_base),
        phase: new.phase,
    }
}

impl Worker {
    #[allow(clippy::too_many_arguments)]
    async fn run_managed_attempt(
        &mut self,
        state: &mut BridgeState,
        job_id: &str,
        attempt_id: &str,
        active: &ActiveAttempt,
        prompt_path: &Path,
        initial_lease: Option<ConfirmedLease>,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> Result<TaskReceipt, i32> {
        {
            let a = state.active.as_mut().unwrap();
            a.phase = LocalPhase::RunnerIntent;
            if state.persist(&self.workspace).is_err() {
                return Err(1);
            }
        }

        let context = BridgeReceiptContext {
            server_origin: self.origin.clone(),
            user_id: self.expected.user_id.clone(),
            workspace_id: self.expected.workspace_id.clone(),
            workspace_ref: self.workspace_ref.clone(),
            worker_id: self.worker_id.clone(),
            job_id: job_id.to_string(),
            attempt_id: attempt_id.to_string(),
            source_prompt_sha256: sha256_of(&active.claim.as_ref().unwrap().prompt),
            acceptance_sha256: sha256_of(&active.claim.as_ref().unwrap().acceptance),
            task_dispatch_intent: false,
            stop_reason: None,
        };

        let (runner_controls, ctl) = control_channel(self.clock.clone());
        let crate::runner::control::ControllerHandles {
            signals_rx,
            permit_tx,
            stop_tx,
            clock: _ctl_clock,
        } = ctl;
        let mut permit_tx: Option<oneshot::Sender<crate::runner::control::ExecutionPermit>> =
            Some(permit_tx);
        let mut signals_rx = signals_rx;
        let stop_tx = stop_tx;
        let runner = self.runner.clone();
        let ws = self.workspace.clone();
        let jid = job_id.to_string();
        let aid = attempt_id.to_string();
        let pfile = prompt_path.to_path_buf();
        let timeout = active.claim.as_ref().unwrap().timeout_seconds.max(1) as u64;
        let mut handle: JoinHandle<Result<TaskReceipt, RunnerError>> = tokio::spawn(async move {
            runner
                .run_managed(
                    &ws,
                    &jid,
                    &aid,
                    &pfile,
                    timeout,
                    false,
                    runner_controls,
                    context,
                )
                .await
        });

        let mut watchdog = tokio::time::interval(WATCHDOG_PERIOD);
        watchdog.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        let token = active.lease_token.clone();
        let mut lease = initial_lease;
        let mut pending: Option<PendingOp> = None;
        let mut due: Option<(OpKind, tokio::time::Instant)>;
        let mut hb_fail = 0usize;
        let mut start_fail = 0usize;
        // PreparedForTask received and StartIntent persisted: a Server `start`
        // must be confirmed (and replayable) before any business prompt.
        let mut start_requested = false;
        let mut start_done = false;
        // True once the execution permit is sent (the business prompt may run).
        let mut at_execution = false;
        let mut stopping: Option<StopReason> = None;

        // Establish a confirmed lease promptly: dispatch an immediate heartbeat
        // when none came from the claim, otherwise schedule the normal renewal.
        let now = tokio::time::Instant::now();
        let first_delay = if initial_lease.is_some() {
            HEARTBEAT_INTERVAL
        } else {
            Duration::ZERO
        };
        due = Some((OpKind::Heartbeat, now + first_delay));

        loop {
            // One-way stop: revoke the permit, request stop, then drop the
            // controller channels so any Runner blocked on an ack/permit sees a
            // closed channel (ControllerGone) and stops. A late success response
            // can never reopen the permit: this branch already returned.
            if let Some(reason) = stopping.take() {
                drop(permit_tx.take());
                let _ = stop_tx.send(Some(reason));
                drop(stop_tx);
                drop(signals_rx);
                return self.collect_receipt(handle.await).await;
            }

            // Re-read the boot clock and the current stop line every iteration.
            let now_boot = match boot_now(self.clock.as_ref()) {
                Ok(t) => t,
                Err(stop) => {
                    stopping = Some(stop);
                    continue;
                }
            };
            if let Some(l) = lease {
                if now_boot >= l.stop_at_boot {
                    stopping = Some(lease_stop_reason(at_execution));
                    continue;
                }
            }

            // Build the per-iteration lease arm: poll the retained in-flight op
            // when one exists, otherwise sleep until the next scheduled dispatch.
            // Because the in-flight HTTP future is stored in `pending` (not inside
            // this arm), a watchdog/stop tick that cancels the arm never cancels
            // the request.
            let lease_fut: BoxFuture<LeaseEvt> = if let Some(p) = pending.as_mut() {
                Box::pin(async move {
                    match p {
                        PendingOp::Heartbeat { sent_boot, future } => LeaseEvt::HeartbeatDone {
                            sent: *sent_boot,
                            res: future.as_mut().await,
                        },
                        PendingOp::Start { sent_boot, future } => LeaseEvt::StartDone {
                            sent: *sent_boot,
                            res: future.as_mut().await,
                        },
                    }
                })
            } else if let Some((kind, when)) = due {
                Box::pin(async move {
                    tokio::time::sleep_until(when).await;
                    LeaseEvt::Due(kind)
                })
            } else {
                Box::pin(std::future::pending())
            };

            let arm = tokio::select! {
                _ = stop_rx.changed() => Arm::ExternalStop,
                sig = signals_rx.recv() => Arm::Signal(sig),
                _ = watchdog.tick() => Arm::Watchdog,
                ev = lease_fut => Arm::Lease(ev),
                res = &mut handle => Arm::Done(res),
            };

            match arm {
                Arm::Done(res) => return self.collect_receipt(res).await,
                Arm::ExternalStop => {
                    if let Some(reason) = stop_rx.borrow().clone() {
                        stopping = Some(reason);
                    }
                }
                Arm::Watchdog => {
                    // Lease expiry / clock fault were re-checked at the top of
                    // this iteration; no extra work is needed here.
                }
                Arm::Signal(sig) => match sig {
                    Some((RunnerSignal::ProcessSpawned(identity), ack)) => {
                        let a = state.active.as_mut().unwrap();
                        a.process = Some(identity);
                        a.runner_boot_id = state::current_boot_id();
                        if state.persist(&self.workspace).is_err() {
                            stopping = Some(StopReason::LocalStateWriteFailed);
                            continue;
                        }
                        let _ = ack.send(());
                    }
                    Some((RunnerSignal::PreparedForTask, ack)) => {
                        let _ = ack.send(());
                        if stopping.is_some() {
                            continue;
                        }
                        // Persist StartIntent before issuing Server start.
                        let a = state.active.as_mut().unwrap();
                        a.phase = LocalPhase::StartIntent;
                        if state.persist(&self.workspace).is_err() {
                            stopping = Some(StopReason::LocalStateWriteFailed);
                            continue;
                        }
                        start_requested = true;
                        start_fail = 0;
                        // Keep any in-flight heartbeat; once it completes, Start
                        // is scheduled (never preempt an issued request).
                        if pending.is_none() {
                            due = Some((OpKind::Start, tokio::time::Instant::now()));
                        }
                    }
                    None => {
                        // Runner gone (its channels closed): stop.
                        return self.collect_receipt(handle.await).await;
                    }
                },
                Arm::Lease(ev) => match ev {
                    LeaseEvt::Due(kind) => {
                        if lease
                            .as_ref()
                            .map(|l| now_boot >= l.stop_at_boot)
                            .unwrap_or(false)
                        {
                            stopping = Some(lease_stop_reason(at_execution));
                            continue;
                        }
                        let sent = match boot_now(self.clock.as_ref()) {
                            Ok(t) => t,
                            Err(stop) => {
                                stopping = Some(stop);
                                continue;
                            }
                        };
                        match kind {
                            OpKind::Heartbeat => {
                                pending = Some(PendingOp::Heartbeat {
                                    sent_boot: sent,
                                    future: make_heartbeat_future(
                                        &self.client,
                                        &self.worker_id,
                                        job_id,
                                        attempt_id,
                                        &token,
                                    ),
                                });
                            }
                            OpKind::Start => {
                                pending = Some(PendingOp::Start {
                                    sent_boot: sent,
                                    future: make_start_future(
                                        &self.client,
                                        &self.worker_id,
                                        job_id,
                                        attempt_id,
                                        &token,
                                    ),
                                });
                            }
                        }
                        due = None;
                    }
                    LeaseEvt::HeartbeatDone { sent, res } => {
                        pending = None;
                        match res {
                            Ok(ok) => {
                                let new = match ConfirmedLease::from_execution(
                                    &ok.execution,
                                    &ok.server_time,
                                    sent,
                                ) {
                                    Some(l) => l,
                                    None => {
                                        stopping = Some(StopReason::LeaseUnconfirmed);
                                        continue;
                                    }
                                };
                                lease = Some(lease_after_heartbeat(lease, new));
                                hb_fail = 0;
                                // After a confirmed Start is requested but not yet
                                // done, proceed to Start (never infer approval from
                                // a heartbeat). Otherwise schedule the next renewal.
                                if start_requested && !start_done {
                                    due = Some((OpKind::Start, tokio::time::Instant::now()));
                                } else {
                                    due = Some((
                                        OpKind::Heartbeat,
                                        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
                                    ));
                                }
                            }
                            Err(e) => match classify_write_fault(&e) {
                                FaultAction::Retry => {
                                    hb_fail += 1;
                                    let d = lease_op_backoff(OpKind::Heartbeat, hb_fail);
                                    due =
                                        Some((OpKind::Heartbeat, tokio::time::Instant::now() + d));
                                }
                                FaultAction::Stop(reason) => stopping = Some(reason),
                            },
                        }
                    }
                    LeaseEvt::StartDone { sent, res } => {
                        pending = None;
                        match res {
                            Ok(ok) => {
                                let new = match ConfirmedLease::from_execution(
                                    &ok.execution,
                                    &ok.server_time,
                                    sent,
                                ) {
                                    Some(l) => l,
                                    None => {
                                        stopping = Some(StopReason::LeaseUnconfirmed);
                                        continue;
                                    }
                                };
                                if new.phase != crate::bridge::protocol::Phase::Running {
                                    // start must confirm running; anything else is
                                    // an unconfirmed / illegal transition.
                                    stopping = Some(StopReason::LeaseUnconfirmed);
                                    continue;
                                }
                                lease = Some(new);
                                start_done = true;
                                start_fail = 0;
                                // Persist DispatchIntent *before* granting the
                                // permit: once the permit is out the business
                                // prompt may be sent, so record the intent first.
                                let a = state.active.as_mut().unwrap();
                                a.phase = LocalPhase::DispatchIntent;
                                a.task_dispatch_intent = true;
                                if state.persist(&self.workspace).is_err() {
                                    stopping = Some(StopReason::LocalStateWriteFailed);
                                    continue;
                                }
                                at_execution = true;
                                if let Some(p) = permit_tx.take() {
                                    let _ = p.send(crate::runner::control::ExecutionPermit {
                                        execution_deadline: new.phase_deadline_boot,
                                    });
                                }
                                due = Some((
                                    OpKind::Heartbeat,
                                    tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
                                ));
                            }
                            Err(e) => match classify_write_fault(&e) {
                                FaultAction::Retry => {
                                    start_fail += 1;
                                    let d = lease_op_backoff(OpKind::Start, start_fail);
                                    due = Some((OpKind::Start, tokio::time::Instant::now() + d));
                                }
                                FaultAction::Stop(reason) => stopping = Some(reason),
                            },
                        }
                    }
                },
            }
        }
    }
}
impl Worker {
    async fn collect_receipt(
        &self,
        res: Result<Result<TaskReceipt, RunnerError>, tokio::task::JoinError>,
    ) -> Result<TaskReceipt, i32> {
        match res {
            Ok(Ok(receipt)) => Ok(receipt),
            Ok(Err(e)) => {
                eprintln!("bridge: runner returned an error: {e}");
                Err(1)
            }
            Err(_) => {
                eprintln!("bridge: runner task panicked or was joined unexpectedly");
                Err(1)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::lease::{claim_backoff, stop_at_from_remaining};

    #[test]
    fn remaining_to_is_none_when_past_deadline() {
        // server 12:00:00, deadline 11:59:59 -> already expired.
        assert!(remaining_to("2026-09-07T11:59:59Z", "2026-09-07T12:00:00Z").is_none());
        // server 12:00:00, deadline 12:01:00 -> 60 s.
        let d = remaining_to("2026-09-07T12:01:00Z", "2026-09-07T12:00:00Z").unwrap();
        assert_eq!(d, Duration::from_secs(60));
    }

    #[test]
    fn stop_at_conservatively_subtracts_margin() {
        // sent + 60 s remaining -> stop at sent + 55 s (5 s margin).
        let sent = Duration::from_secs(1000);
        assert_eq!(
            stop_at_from_remaining(sent, Duration::from_secs(60)),
            Some(Duration::from_secs(1055))
        );
    }

    #[test]
    fn claim_backoff_caps_at_schedule_tail() {
        assert_eq!(claim_backoff(0), Duration::from_secs(1));
        assert_eq!(claim_backoff(50), Duration::from_secs(10));
    }

    #[test]
    fn lease_line_uses_min_of_lease_and_start_deadline() {
        let sent = Duration::from_secs(1000);
        // lease expires in 90 s, start_deadline in 300 s -> effective 90 s.
        let eff = remaining_to("2026-09-07T00:01:30Z", "2026-09-07T00:00:00Z").unwrap();
        let sd = remaining_to("2026-09-07T00:05:00Z", "2026-09-07T00:00:00Z").unwrap();
        assert!(sd > eff);
        let stop = stop_at_from_remaining(sent, eff).unwrap();
        // 1000 + 90 - 5 = 1085
        assert_eq!(stop, Duration::from_secs(1085));
    }

    fn exec(phase: &str, start_deadline: &str, exec_deadline: Option<&str>) -> Execution {
        Execution {
            worker_id: "wrk-123e4567-e89b-12d3-a456-426614174000".to_string(),
            attempt_id: "123e4567-e89b-12d3-a456-4266141740ff".to_string(),
            phase: phase.to_string(),
            claimed_at: "2026-09-07T00:00:00Z".to_string(),
            start_deadline: start_deadline.to_string(),
            started_at: exec_deadline.map(|_| "2026-09-07T00:00:10Z".to_string()),
            lease_expires_at: "2026-09-07T00:01:30Z".to_string(),
            execution_deadline: exec_deadline.map(|s| s.to_string()),
        }
    }

    #[test]
    fn confirmed_lease_maps_claimed_deadlines_conservatively() {
        // server_time 00:00:00, sent at boot 1000. Claimed phase: lease expires
        // 00:01:30 (90 s), start_deadline 00:05:00 (300 s). Effective stop uses
        // the earlier lease, minus the 5 s margin.
        let sent = Duration::from_secs(1000);
        let e = exec("claimed", "2026-09-07T00:05:00Z", None);
        let l = ConfirmedLease::from_execution(&e, "2026-09-07T00:00:00Z", sent).unwrap();
        // lease_valid = sent + 90s; phase_deadline = sent + 300s.
        assert_eq!(l.lease_valid_until_boot, Duration::from_secs(1090));
        assert_eq!(l.phase_deadline_boot, Duration::from_secs(1300));
        // stop = min(1090,1300) - 5s = 1085.
        assert_eq!(l.stop_at_boot, Duration::from_secs(1085));
        assert_eq!(l.phase, crate::bridge::protocol::Phase::Claimed);
    }

    #[test]
    fn confirmed_lease_running_uses_execution_deadline() {
        // Running: execution_deadline 00:06:00 (360 s) but lease 00:01:30 (90 s).
        let sent = Duration::from_secs(1000);
        let e = exec(
            "running",
            "2026-09-07T00:05:00Z",
            Some("2026-09-07T00:06:00Z"),
        );
        let l = ConfirmedLease::from_execution(&e, "2026-09-07T00:00:00Z", sent).unwrap();
        assert_eq!(l.phase_deadline_boot, Duration::from_secs(1360));
        assert_eq!(l.lease_valid_until_boot, Duration::from_secs(1090));
        // stop uses the earlier (lease) deadline minus margin.
        assert_eq!(l.stop_at_boot, Duration::from_secs(1085));
        assert_eq!(l.phase, crate::bridge::protocol::Phase::Running);
    }

    #[test]
    fn confirmed_lease_none_when_server_time_past_deadline() {
        // server_time already past lease expiry -> the lease is immediately gone.
        let sent = Duration::from_secs(1000);
        let e = exec("claimed", "2026-09-07T00:05:00Z", None);
        assert!(ConfirmedLease::from_execution(&e, "2026-09-07T00:02:00Z", sent).is_none());
    }

    #[test]
    fn heartbeat_never_extends_execution_deadline() {
        use crate::bridge::protocol::Phase;
        // Prior confirmed running lease: execution deadline at boot 1300.
        let prev = ConfirmedLease {
            lease_valid_until_boot: Duration::from_secs(1090),
            phase_deadline_boot: Duration::from_secs(1300),
            stop_at_boot: Duration::from_secs(1085),
            phase: Phase::Running,
        };
        // A heartbeat response that would map execution deadline later (1400)
        // and extends the lease (1200): the merged lease must keep the earlier
        // phase deadline (1300) and recompute the stop from the earlier value.
        let new = ConfirmedLease {
            lease_valid_until_boot: Duration::from_secs(1200),
            phase_deadline_boot: Duration::from_secs(1400),
            stop_at_boot: Duration::from_secs(1195),
            phase: Phase::Running,
        };
        let merged = lease_after_heartbeat(Some(prev), new);
        // Execution/phase deadline must NOT be extended past 1300.
        assert_eq!(merged.phase_deadline_boot, Duration::from_secs(1300));
        // The heartbeat may still extend the lease valid-until bound.
        assert_eq!(merged.lease_valid_until_boot, Duration::from_secs(1200));
        // stop = min(1200,1300) - margin = 1195.
        assert_eq!(merged.stop_at_boot, Duration::from_secs(1195));
    }

    fn err_of(kind: ErrorKind, unknown: bool) -> ClientError {
        ClientError {
            kind,
            outcome_unknown: unknown,
        }
    }

    #[test]
    fn write_fault_classification_matrix() {
        use ErrorKind::*;
        // Transport faults retry.
        assert!(matches!(
            classify_write_fault(&err_of(Transport("t".into()), true)),
            FaultAction::Retry
        ));
        // 5xx / QUEUE_UNAVAILABLE retry.
        assert!(matches!(
            classify_write_fault(&err_of(
                Server {
                    status: 500,
                    code: "HTTP_500".into(),
                    reason: None
                },
                false
            )),
            FaultAction::Retry
        ));
        assert!(matches!(
            classify_write_fault(&err_of(
                Server {
                    status: 503,
                    code: "QUEUE_UNAVAILABLE".into(),
                    reason: None
                },
                false
            )),
            FaultAction::Retry
        ));
        // A confirmed LEASE_EXPIRED keeps the server's safe reason.
        match classify_write_fault(&err_of(
            Server {
                status: 409,
                code: "LEASE_EXPIRED".into(),
                reason: Some("EXECUTION_DEADLINE_EXCEEDED".into()),
            },
            false,
        )) {
            FaultAction::Stop(StopReason::LeaseExpired { reason }) => {
                assert_eq!(reason.as_deref(), Some("EXECUTION_DEADLINE_EXCEEDED"));
            }
            other => panic!("expected LeaseExpired stop, got {other:?}"),
        }
        // Auth and non-retryable protocol faults stop, never hot-loop.
        assert!(matches!(
            classify_write_fault(&err_of(Unauthorized, false)),
            FaultAction::Stop(StopReason::IdentityRevoked)
        ));
        assert!(matches!(
            classify_write_fault(&err_of(Redirect(302), true)),
            FaultAction::Stop(StopReason::ProtocolError)
        ));
        assert!(matches!(
            classify_write_fault(&err_of(Protocol("x".into()), true)),
            FaultAction::Stop(StopReason::ProtocolError)
        ));
        // Any other server decision is not a confirmed success.
        assert!(matches!(
            classify_write_fault(&err_of(
                Server {
                    status: 409,
                    code: "JOB_NOT_FOUND".into(),
                    reason: None
                },
                false
            )),
            FaultAction::Stop(StopReason::LeaseUnconfirmed)
        ));
    }

    #[test]
    fn clock_failure_maps_to_conservative_stop() {
        use crate::bridge::lease::{Clock, FailingClock};
        let fc = FailingClock;
        assert!(fc.now_boot().is_err());
        // boot_now maps a clock fault to a stop reason, never to a time.
        assert_eq!(boot_now(&fc).unwrap_err(), StopReason::LeaseUnconfirmed);
    }

    #[test]
    fn backoff_schedules_cap_at_tail() {
        assert_eq!(
            lease_op_backoff(OpKind::Heartbeat, 0),
            Duration::from_secs(1)
        );
        assert_eq!(lease_op_backoff(OpKind::Start, 3), Duration::from_secs(5));
        assert_eq!(
            lease_op_backoff(OpKind::Heartbeat, 100),
            Duration::from_secs(5)
        );
    }

    fn payload(prompt: &str, acceptance: &str) -> ClaimPayload {
        ClaimPayload {
            workspace_ref: "tools".to_string(),
            resource_id: None,
            prompt: prompt.to_string(),
            acceptance: acceptance.to_string(),
            timeout_seconds: 300,
            payload_sha256: String::new(),
        }
    }

    #[test]
    fn envelope_keeps_prompt_verbatim_with_unicode_and_trailing_ws() {
        // Trailing spaces/newlines and non-ASCII must survive the envelope
        // untouched (they are never trimmed away).
        let p = "step one  \nstep two\n尾随空格   \n";
        let a = "accept a\t\naccept b";
        let env = build_envelope(Path::new("/ws"), &payload(p, a));
        assert!(env.contains(p), "prompt truncated: {env:?}");
        assert!(env.contains(a), "acceptance truncated: {env:?}");
        // The source-prompt hash must be over the verbatim claimed text bytes.
        assert_eq!(sha256_of(p), sha256_of_bytes(p.as_bytes()));
    }

    fn skeleton_receipt(status: &str, code: Option<&str>) -> TaskReceipt {
        use crate::receipt::{ExecutorInfo, LogSummary, ReceiptError, TimestampsInfo};
        use crate::verifier::BusinessOutcome;
        TaskReceipt {
            job_id: "j".to_string(),
            attempt_id: "a".to_string(),
            workspace: "/w".to_string(),
            prompt_file: "/w/p.md".to_string(),
            prompt_sha256: "0".repeat(64),
            execution_status: status.to_string(),
            business_outcome: BusinessOutcome::Failed,
            executor: ExecutorInfo {
                executor_type: "test_stub".to_string(),
                version: "v".to_string(),
                conversation_id: None,
            },
            doctor: None,
            doctor_cache_hit: false,
            local_check_duration_ms: 0,
            current_doctor_metrics: None,
            cached_doctor_metrics: None,
            timestamps: TimestampsInfo {
                started_at: chrono::Utc::now(),
                finished_at: chrono::Utc::now(),
                duration_ms: 0,
            },
            artifacts: Vec::new(),
            logs: LogSummary {
                events_path: String::new(),
                stdout_path: String::new(),
                stderr_path: String::new(),
                stdout_snippet: String::new(),
                stderr_snippet: String::new(),
                dropped_lines_count: 0,
                log_truncated: false,
            },
            error: code.map(|c| ReceiptError {
                stage: "x".to_string(),
                code: c.to_string(),
                message: String::new(),
            }),
            bridge_context: None,
        }
    }

    #[test]
    fn disposition_classification() {
        // Business results that finalize cleanly let the daemon continue.
        assert_eq!(
            classify_disposition(&skeleton_receipt("COMPLETED", None)),
            AttemptDisposition::Continue
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt("FAILED", Some("TASK_EXECUTION_FAILED"))),
            AttemptDisposition::Continue
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt("TIMED_OUT", Some("TIMEOUT"))),
            AttemptDisposition::Continue
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt("CANCELLED", Some("USER_REQUESTED"))),
            AttemptDisposition::Continue
        );
        // Doctor/preflight BLOCKED (NotStarted) stops the daemon.
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "BLOCKED",
                Some("DOCTOR_VERIFICATION_FAILED")
            )),
            AttemptDisposition::StopDaemon
        );
        // Lease/control interruptions finalize then stop the daemon.
        assert_eq!(
            classify_disposition(&skeleton_receipt("INTERRUPTED", Some("LEASE_EXPIRED"))),
            AttemptDisposition::StopDaemon
        );
        // An unconfirmed process stop must NOT be finalized: keep for recovery.
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "INTERRUPTED",
                Some("PROCESS_STOP_UNCONFIRMED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
    }
}
