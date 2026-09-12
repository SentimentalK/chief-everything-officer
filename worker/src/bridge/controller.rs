//! Bridge controller: discovers identity-scoped jobs, acquires them under
//! persistent assignments via the acquisition module, runs them through the
//! controlled Runner without lease renewal, and saves local receipts and
//! history records — for one canonical workspace / alias per process.
//!
//! There is no heartbeat, lease renewal, lease expiry, Server-derived execution
//! deadline, automatic reassignment, or synthetic infinite lease. Execution
//! authority is established by a confirmed, locally persisted assignment.
//!
//! Local completion saves receipt + history and clears active; it never
//! invents a server-side succeeded.

use crate::bridge::acquisition::{acquire_one, AcquireError, AcquireOutcome};
use crate::bridge::client::{BridgeClient, ClientError, ErrorKind};
use crate::bridge::config::{BridgeConfig, ExpectedIdentity};
use crate::bridge::protocol::{AssignmentStartOk, AssignmentStartRequest};
use crate::bridge::state::{
    self, ActiveAttempt, AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase,
};
use crate::local_state::atomic_write_durable;
use crate::receipt::TaskReceipt;
use crate::runner::control::control_channel;
use crate::runner::{BridgeReceiptContext, Runner, RunnerError, RunnerSignal, StopReason};
use futures_util::future::BoxFuture;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;

pub const TAIL_POLL: Duration = Duration::from_secs(5);
pub const PAGE_PAUSE: Duration = Duration::from_millis(250);
pub const CLAIM_BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(10),
];

pub fn claim_backoff(attempt_index: usize) -> Duration {
    CLAIM_BACKOFF[attempt_index.min(CLAIM_BACKOFF.len() - 1)]
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

pub fn is_retryable_client_error(e: &ClientError) -> bool {
    match &e.kind {
        ErrorKind::Transport(_) => true,
        ErrorKind::Server { code, reason, .. }
            if code == "QUEUE_UNAVAILABLE" && !is_integrity_reason(reason.as_deref()) =>
        {
            true
        }
        _ => false,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum StartEvaluation {
    /// Valid success: persist dispatch intent and execute.
    Dispatch,
    /// Transport failure, timeout, or QUEUE_UNAVAILABLE without integrity reason:
    /// record safe start_unconfirmed, persist dispatch intent and execute.
    DispatchUnconfirmed,
    /// Confirmed rejection, auth, or corrupt/malformed response: stop attempt.
    Stop(StopReason),
}

pub fn evaluate_start_result(res: &Result<AssignmentStartOk, ClientError>) -> StartEvaluation {
    match res {
        Ok(_) => StartEvaluation::Dispatch,
        Err(e) => match &e.kind {
            ErrorKind::Transport(_) => StartEvaluation::DispatchUnconfirmed,
            ErrorKind::Server { code, reason, .. }
                if code == "QUEUE_UNAVAILABLE" && !is_integrity_reason(reason.as_deref()) =>
            {
                StartEvaluation::DispatchUnconfirmed
            }
            ErrorKind::Unauthorized | ErrorKind::Forbidden | ErrorKind::IdentityMismatch { .. } => {
                StartEvaluation::Stop(StopReason::IdentityRevoked)
            }
            ErrorKind::Server { code, .. }
                if matches!(
                    code.as_str(),
                    "ASSIGNMENT_MISMATCH" | "JOB_NOT_FOUND" | "JOB_EXPIRED" | "JOB_ALREADY_CLAIMED"
                ) =>
            {
                StartEvaluation::Stop(StopReason::ProtocolError)
            }
            ErrorKind::Protocol(_) | ErrorKind::Redirect(_) | ErrorKind::TooLarge => {
                StartEvaluation::Stop(StopReason::ProtocolError)
            }
            ErrorKind::Server { reason, .. } if is_integrity_reason(reason.as_deref()) => {
                StartEvaluation::Stop(StopReason::ProtocolError)
            }
            ErrorKind::Server { .. } => StartEvaluation::Stop(StopReason::ProtocolError),
        },
    }
}

fn sha256_of(data: &str) -> String {
    let mut h = Sha256::new();
    h.update(data.as_bytes());
    format!("{:x}", h.finalize())
}

/// Versioned plain-text prompt envelope: task goal + acceptance kept verbatim,
/// plus the managed-workspace constraint. Never injects tokens/keys/credentials.
fn build_envelope(canonical: &Path, payload: &ClaimPayload) -> String {
    format!(
        "# CEO task

You are operating on the managed workspace {:?}; keep outputs          there. Follow the workspace AGENTS.md and Doctor constraints.

         ## Task goal

{}

## Acceptance requirements

{}",
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

/// The controller for one canonical workspace / alias.
pub struct Worker {
    client: Arc<BridgeClient>,
    runner: Runner,
    origin: String,
    expected: ExpectedIdentity,
    workspace_ref: String,
    workspace: PathBuf,
    worker_id: String,
}

impl Worker {
    pub fn new(
        cfg: &BridgeConfig,
        expected: ExpectedIdentity,
        workspace_ref: &str,
        workspace: PathBuf,
        client: BridgeClient,
        runner: Runner,
        worker_id: String,
    ) -> Worker {
        Worker {
            client: Arc::new(client),
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

    /// Runs until stopped.  becomes Some on SIGINT/SIGTERM. Returns
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
                self.acquire_and_run(state, &job_id, stop_rx).await
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
                // The active attempt reached at least RunnerIntent. Before we
                // may clear it, the persisted terminal evidence (receipt +
                // history + actual receipt/envelope bytes) must be verified to
                // genuinely and safely correspond to this attempt. A merely
                // "parseable" history is never enough: field-format legality is
                // not a correct association. We cannot yet confirm the old
                // process is gone, so any failure to prove a safe completion
                // returns RecoveryRequired — we never guess it disappeared.
                let attempt_dir = attempt_dir_for(&self.workspace, &job_id, &attempt_id);
                let binding = self.binding();
                let receipt_path = attempt_dir.join("receipt.json");
                let receipt_bytes = match std::fs::read(&receipt_path) {
                    Ok(b) => b,
                    Err(_) => {
                        emit(
                            "recovery_required",
                            &job_id,
                            &attempt_id,
                            &self.workspace_ref,
                            "dispatch_intent_without_receipt",
                        );
                        return Err(1);
                    }
                };
                let history =
                    match AttemptHistoryRecord::load(&self.workspace, &job_id, &attempt_id) {
                        Ok(Some(h)) => h,
                        Ok(None) | Err(_) => {
                            emit(
                                "recovery_required",
                                &job_id,
                                &attempt_id,
                                &self.workspace_ref,
                                "receipt_without_history",
                            );
                            return Err(1);
                        }
                    };
                let receipt: TaskReceipt = match serde_json::from_slice(&receipt_bytes) {
                    Ok(r) => r,
                    Err(_) => {
                        emit(
                            "recovery_required",
                            &job_id,
                            &attempt_id,
                            &self.workspace_ref,
                            "receipt_unparseable",
                        );
                        return Err(1);
                    }
                };
                let rec_sha = sha256_of_bytes(&receipt_bytes);
                let envelope_sha =
                    match sha256_file(&state::prompt_path(&self.workspace, &job_id, &attempt_id)) {
                        Ok(s) => s,
                        Err(_) => {
                            emit(
                                "recovery_required",
                                &job_id,
                                &attempt_id,
                                &self.workspace_ref,
                                "envelope_unreadable",
                            );
                            return Err(1);
                        }
                    };
                let active_prompt_sha = active.claim.as_ref().map(|c| sha256_of(&c.prompt));
                let active_acceptance_sha = active.claim.as_ref().map(|c| sha256_of(&c.acceptance));
                if let Err(reason) = verify_terminal_evidence(
                    &binding,
                    &self.worker_id,
                    &active,
                    &receipt,
                    &rec_sha,
                    &envelope_sha,
                    &history,
                    active_prompt_sha.as_deref(),
                    active_acceptance_sha.as_deref(),
                ) {
                    emit(
                        "recovery_required",
                        &job_id,
                        &attempt_id,
                        &self.workspace_ref,
                        &format!("evidence:{reason}"),
                    );
                    return Err(1);
                }
                state.active = None;
                state.persist(&self.workspace).map_err(|_| 1)?;
                emit(
                    "bridge_ready",
                    &job_id,
                    &attempt_id,
                    &self.workspace_ref,
                    "finalized",
                );
                Ok(())
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
        let mut consecutive_failures = 0usize;
        loop {
            if let Some(reason) = stop_rx.borrow().clone() {
                return stop_exit(&reason);
            }
            let page = match self.client.pending(&self.workspace_ref, &cursor).await {
                Ok(p) => {
                    consecutive_failures = 0;
                    p
                }
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
                        let delay = claim_backoff(consecutive_failures);
                        consecutive_failures += 1;
                        tokio::select! {
                            biased;
                            _ = stop_rx.changed() => {
                                if let Some(reason) = stop_rx.borrow().clone() {
                                    return stop_exit(&reason);
                                }
                            }
                            _ = tokio::time::sleep(delay) => {}
                        }
                        continue;
                    }
                },
            };

            if !page.jobs.is_empty() {
                for job in &page.jobs {
                    if let Some(reason) = stop_rx.borrow().clone() {
                        return stop_exit(&reason);
                    }
                    if let Err(code) = self.acquire_and_run(state, &job.job_id, stop_rx).await {
                        return code;
                    }
                }
            }

            pages += 1;
            cursor = page.next_cursor.clone();
            if page.has_more {
                if pages >= 4 {
                    tokio::select! {
                        biased;
                        _ = stop_rx.changed() => {
                            if let Some(reason) = stop_rx.borrow().clone() {
                                return stop_exit(&reason);
                            }
                        }
                        _ = tokio::time::sleep(PAGE_PAUSE) => {}
                    }
                    pages = 0;
                }
            } else {
                tokio::select! {
                    biased;
                    _ = stop_rx.changed() => {
                        if let Some(reason) = stop_rx.borrow().clone() {
                            return stop_exit(&reason);
                        }
                    }
                    _ = tokio::time::sleep(TAIL_POLL) => {}
                }
            }
        }
    }

    /// Acquires and executes one job to local completion. Retries transient
    /// acquisition failures with backoff without advancing discovery.
    async fn acquire_and_run(
        &mut self,
        state: &mut BridgeState,
        job_id: &str,
        stop_rx: &mut watch::Receiver<Option<StopReason>>,
    ) -> Result<(), i32> {
        if state.active.as_ref().map(|a| a.job_id.as_str()) != Some(job_id) {
            if job_dir_has_attempts(&self.workspace, job_id) {
                return Ok(());
            }
            if let Some(a) = &state.active {
                if a.job_id != job_id {
                    return Ok(());
                }
            }
        }

        let mut consecutive_failures = 0usize;
        loop {
            if let Some(reason) = stop_rx.borrow().clone() {
                return Err(stop_exit(&reason));
            }

            match acquire_one(
                &self.runner,
                &self.client,
                &self.workspace,
                state,
                job_id,
                stop_rx,
            )
            .await
            {
                Ok(AcquireOutcome::Claimed) => {
                    let active = state.active.clone().ok_or(1)?;
                    return self.finish_claimed(state, active, stop_rx).await;
                }
                Ok(AcquireOutcome::NoLongerPending) => {
                    return Ok(());
                }
                Ok(AcquireOutcome::NotReady) => {
                    emit(
                        "doctor_not_ready",
                        job_id,
                        "",
                        &self.workspace_ref,
                        "doctor_failed",
                    );
                    return Err(1);
                }
                Ok(AcquireOutcome::Stopped(reason)) => {
                    return Err(stop_exit(&reason));
                }
                Err(AcquireError::Client(client_err)) => {
                    if is_retryable_client_error(&client_err) {
                        let delay = claim_backoff(consecutive_failures);
                        consecutive_failures += 1;
                        tokio::select! {
                            biased;
                            _ = stop_rx.changed() => {
                                if let Some(reason) = stop_rx.borrow().clone() {
                                    return Err(stop_exit(&reason));
                                }
                            }
                            _ = tokio::time::sleep(delay) => {}
                        }
                        continue;
                    } else {
                        emit(
                            "bridge_stopped",
                            job_id,
                            "",
                            &self.workspace_ref,
                            "client_error",
                        );
                        return Err(1);
                    }
                }
                Err(e) => {
                    eprintln!("bridge: fatal acquisition error: {e}");
                    emit(
                        "bridge_stopped",
                        job_id,
                        "",
                        &self.workspace_ref,
                        "acquisition_failed",
                    );
                    return Err(1);
                }
            }
        }
    }

    /// Runs an already-claimed attempt to local completion and finalizes it.
    async fn finish_claimed(
        &mut self,
        state: &mut BridgeState,
        active: ActiveAttempt,
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

        let receipt = self
            .run_managed_attempt(state, &job_id, &attempt_id, &active, &prompt_path, stop_rx)
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
            &active.claim_token,
        );
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
            return Err(1);
        }
        Ok(())
    }

    async fn run_managed_attempt(
        &mut self,
        state: &mut BridgeState,
        job_id: &str,
        attempt_id: &str,
        active: &ActiveAttempt,
        prompt_path: &Path,
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

        let (runner_controls, ctl) = control_channel();
        let crate::runner::control::ControllerHandles {
            signals_rx,
            permit_tx,
            stop_tx,
            dispatch_intent,
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

        let token = active.claim_token.clone();
        let mut pending_start: Option<BoxFuture<'static, Result<AssignmentStartOk, ClientError>>> =
            None;
        let mut stopping: Option<StopReason> = None;

        loop {
            // One-way stop: revoke the permit, request stop, then drop the
            // controller channels so any Runner blocked on an ack/permit sees a
            // closed channel (ControllerGone) and stops. A late start response
            // can never reopen dispatch: this branch already returns.
            if let Some(reason) = stopping.take() {
                drop(permit_tx.take());
                let _ = stop_tx.send(Some(reason));
                drop(stop_tx);
                drop(signals_rx);
                return self.collect_receipt(handle.await).await;
            }

            let start_fut = async {
                match pending_start.as_mut() {
                    Some(fut) => fut.await,
                    None => std::future::pending().await,
                }
            };

            let arm = tokio::select! {
                biased;
                _ = stop_rx.changed() => Arm::ExternalStop,
                sig = signals_rx.recv() => Arm::Signal(sig),
                res = start_fut => Arm::StartDone(res),
                res = &mut handle => Arm::Done(Box::new(res)),
            };

            match arm {
                Arm::Done(res) => return self.collect_receipt(*res).await,
                Arm::ExternalStop => {
                    if let Some(reason) = stop_rx.borrow().clone() {
                        stopping = Some(reason);
                    }
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
                        if let Some(reason) = stop_rx.borrow().clone() {
                            stopping = Some(reason);
                            continue;
                        }
                        // Order: Persist StartIntent → acknowledge PreparedForTask → issue start
                        let a = state.active.as_mut().unwrap();
                        a.phase = LocalPhase::StartIntent;
                        if state.persist(&self.workspace).is_err() {
                            stopping = Some(StopReason::LocalStateWriteFailed);
                            continue;
                        }
                        let _ = ack.send(());

                        let c = Arc::clone(&self.client);
                        let wid = self.worker_id.clone();
                        let jid_clone = job_id.to_string();
                        let aid_clone = attempt_id.to_string();
                        let tok_clone = token.clone();
                        pending_start = Some(Box::pin(async move {
                            let req = AssignmentStartRequest {
                                worker_id: wid,
                                attempt_id: aid_clone,
                                claim_token: tok_clone,
                            };
                            c.start_assignment(&jid_clone, &req).await
                        }));
                    }
                    None => {
                        return self.collect_receipt(handle.await).await;
                    }
                },
                Arm::StartDone(res) => {
                    pending_start = None;
                    match evaluate_start_result(&res) {
                        StartEvaluation::Stop(reason) => {
                            stopping = Some(reason);
                        }
                        StartEvaluation::DispatchUnconfirmed => {
                            emit(
                                "start_unconfirmed",
                                job_id,
                                attempt_id,
                                &self.workspace_ref,
                                "transport_or_unavailable",
                            );
                            self.dispatch_permit(
                                state,
                                &dispatch_intent,
                                &mut permit_tx,
                                stop_rx,
                                &mut stopping,
                            );
                        }
                        StartEvaluation::Dispatch => {
                            self.dispatch_permit(
                                state,
                                &dispatch_intent,
                                &mut permit_tx,
                                stop_rx,
                                &mut stopping,
                            );
                        }
                    }
                }
            }
        }
    }

    fn dispatch_permit(
        &self,
        state: &mut BridgeState,
        dispatch_intent: &std::sync::atomic::AtomicBool,
        permit_tx: &mut Option<oneshot::Sender<crate::runner::control::ExecutionPermit>>,
        stop_rx: &watch::Receiver<Option<StopReason>>,
        stopping: &mut Option<StopReason>,
    ) {
        if let Some(reason) = stop_rx.borrow().clone() {
            *stopping = Some(reason);
            return;
        }
        // Commit the one-way shared dispatch-intent marker before persisting:
        // if the write outcome is unknown, the receipt must never claim the
        // business prompt was clearly not started.
        dispatch_intent.store(true, std::sync::atomic::Ordering::SeqCst);
        let a = state.active.as_mut().unwrap();
        a.phase = LocalPhase::DispatchIntent;
        a.task_dispatch_intent = true;
        if state.persist(&self.workspace).is_err() {
            *stopping = Some(StopReason::LocalStateWriteFailed);
            return;
        }
        if let Some(p) = permit_tx.take() {
            let _ = p.send(crate::runner::control::ExecutionPermit);
        }
    }

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

enum Arm {
    ExternalStop,
    Signal(Option<(RunnerSignal, oneshot::Sender<()>)>),
    StartDone(Result<AssignmentStartOk, ClientError>),
    Done(Box<Result<Result<TaskReceipt, RunnerError>, tokio::task::JoinError>>),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AttemptDisposition {
    Continue,
    StopDaemon,
    KeepActiveRecovery,
}

fn classify_disposition(receipt: &TaskReceipt) -> AttemptDisposition {
    let code = receipt
        .error
        .as_ref()
        .map(|e| e.code.as_str())
        .unwrap_or("");
    if code == "PROCESS_STOP_UNCONFIRMED" || code == "LOCAL_STATE_WRITE_FAILED" {
        return AttemptDisposition::KeepActiveRecovery;
    }
    match receipt.execution_status.as_str() {
        "COMPLETED" | "FAILED" | "TIMED_OUT" | "CANCELLED" => AttemptDisposition::Continue,
        // BLOCKED means NotStarted (Doctor/preflight/environment denied): stop
        // so the daemon does not burn the whole queue against a bad workspace.
        "BLOCKED" => AttemptDisposition::StopDaemon,
        // INTERRUPTED = control failure with the attempt finalized.
        "INTERRUPTED" => AttemptDisposition::StopDaemon,
        _ => AttemptDisposition::StopDaemon,
    }
}

#[allow(clippy::too_many_arguments)]
fn verify_terminal_evidence(
    binding: &BridgeBinding,
    worker_id: &str,
    active: &ActiveAttempt,
    receipt: &TaskReceipt,
    receipt_bytes_sha: &str,
    envelope_sha: &str,
    history: &AttemptHistoryRecord,
    active_prompt_sha: Option<&str>,
    active_acceptance_sha: Option<&str>,
) -> Result<(), String> {
    let bc = receipt
        .bridge_context
        .as_ref()
        .ok_or("receipt has no bridge context")?;
    // 1. Server origin / user / workspace / workspace_ref.
    if bc.server_origin != binding.server_origin {
        return Err("receipt server_origin does not match binding".to_string());
    }
    if bc.user_id != binding.user_id {
        return Err("receipt user_id does not match binding".to_string());
    }
    if bc.workspace_id != binding.workspace_id {
        return Err("receipt workspace_id does not match binding".to_string());
    }
    if bc.workspace_ref != binding.workspace_ref {
        return Err("receipt workspace_ref does not match binding".to_string());
    }
    // 2. Worker / job / attempt identity.
    if bc.worker_id != worker_id {
        return Err("receipt worker_id does not match this worker".to_string());
    }
    if bc.job_id != active.job_id || bc.attempt_id != active.attempt_id {
        return Err("receipt job/attempt does not match active attempt".to_string());
    }
    // 3. Source prompt & acceptance hashes must agree with the history record
    // and with the active claim's own fields.
    if bc.source_prompt_sha256 != history.source_prompt_sha256 {
        return Err("receipt source-prompt hash disagrees with history".to_string());
    }
    if bc.acceptance_sha256 != history.acceptance_sha256 {
        return Err("receipt acceptance hash disagrees with history".to_string());
    }
    if let Some(p) = active_prompt_sha {
        if p != history.source_prompt_sha256 {
            return Err("active claim prompt hash disagrees with history".to_string());
        }
    }
    if let Some(a) = active_acceptance_sha {
        if a != history.acceptance_sha256 {
            return Err("active claim acceptance hash disagrees with history".to_string());
        }
    }
    // 4. The actual envelope bytes still match the recorded hash.
    if envelope_sha != history.envelope_sha256 {
        return Err("envelope hash does not match recorded history".to_string());
    }
    // 5. The actual receipt bytes match the recorded hash.
    if receipt_bytes_sha != history.receipt_sha256 {
        return Err("receipt hash does not match recorded history".to_string());
    }
    // 6. Dispatch intent must be consistent across receipt, history and the
    // active attempt's persisted dispatch intent.
    if bc.task_dispatch_intent != history.task_dispatch_intent {
        return Err("receipt dispatch intent disagrees with history".to_string());
    }
    if bc.task_dispatch_intent != active.task_dispatch_intent {
        return Err("receipt dispatch intent disagrees with active state".to_string());
    }
    // 7. The history control credential must correspond to the active attempt's
    // claim token.
    if history.claim_token != active.claim_token {
        return Err("history control token does not match active attempt".to_string());
    }
    // 8. Only a terminal state that is safe to finalize may be cleared; an
    // unconfirmed stop or a failed local-state write must never be auto-cleared.
    if classify_disposition(receipt) == AttemptDisposition::KeepActiveRecovery {
        return Err("terminal state requires recovery".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bridge::state::new_history_record;

    #[test]
    fn claim_backoff_caps_at_schedule_tail() {
        assert_eq!(claim_backoff(0), Duration::from_secs(1));
        assert_eq!(claim_backoff(1), Duration::from_secs(2));
        assert_eq!(claim_backoff(2), Duration::from_secs(4));
        assert_eq!(claim_backoff(3), Duration::from_secs(8));
        assert_eq!(claim_backoff(4), Duration::from_secs(10));
        assert_eq!(claim_backoff(50), Duration::from_secs(10));
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
        let p = "step one  
step two
尾随空格   
";
        let a = "accept a	
accept b";
        let env = build_envelope(Path::new("/ws"), &payload(p, a));
        assert!(env.contains(p), "prompt truncated: {env:?}");
        assert!(env.contains(a), "acceptance truncated: {env:?}");
        assert_eq!(sha256_of(p), sha256_of_bytes(p.as_bytes()));
    }

    fn skeleton_receipt(status: &str, code: Option<&str>) -> TaskReceipt {
        use crate::receipt::{ExecutorInfo, LogSummary, ReceiptError, TimestampsInfo};
        use crate::verifier::BusinessOutcome;
        TaskReceipt {
            job_id: "j".to_string(),
            attempt_id: "a".to_string(),
            workspace: "/ws".to_string(),
            prompt_file: "/ws/p.md".to_string(),
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
    fn start_evaluation_matrix() {
        let ok = Ok(AssignmentStartOk {
            ok: true,
            replayed: false,
            execution: crate::bridge::protocol::AssignmentExecution {
                worker_id: "w".into(),
                attempt_id: "a".into(),
                phase: "running".into(),
                claimed_at: "2026-09-07T00:00:00Z".into(),
                started_at: Some("2026-09-07T00:00:01Z".into()),
            },
            server_time: "2026-09-07T00:00:01Z".into(),
        });
        assert_eq!(evaluate_start_result(&ok), StartEvaluation::Dispatch);

        // Transport -> DispatchUnconfirmed
        let transport_err = Err(ClientError {
            kind: ErrorKind::Transport("timeout".into()),
            outcome_unknown: true,
        });
        assert_eq!(
            evaluate_start_result(&transport_err),
            StartEvaluation::DispatchUnconfirmed
        );

        // QUEUE_UNAVAILABLE without integrity reason -> DispatchUnconfirmed
        let queue_err = Err(ClientError {
            kind: ErrorKind::Server {
                status: 503,
                code: "QUEUE_UNAVAILABLE".into(),
                reason: None,
            },
            outcome_unknown: true,
        });
        assert_eq!(
            evaluate_start_result(&queue_err),
            StartEvaluation::DispatchUnconfirmed
        );

        // QUEUE_UNAVAILABLE with integrity reason -> Stop
        let queue_corrupt = Err(ClientError {
            kind: ErrorKind::Server {
                status: 503,
                code: "QUEUE_UNAVAILABLE".into(),
                reason: Some("CORRUPT_RECORD".into()),
            },
            outcome_unknown: true,
        });
        assert_eq!(
            evaluate_start_result(&queue_corrupt),
            StartEvaluation::Stop(StopReason::ProtocolError)
        );

        // Rejection / mismatch -> Stop
        let mismatch = Err(ClientError {
            kind: ErrorKind::Server {
                status: 409,
                code: "ASSIGNMENT_MISMATCH".into(),
                reason: None,
            },
            outcome_unknown: false,
        });
        assert_eq!(
            evaluate_start_result(&mismatch),
            StartEvaluation::Stop(StopReason::ProtocolError)
        );

        // Auth -> Stop(IdentityRevoked)
        let auth = Err(ClientError {
            kind: ErrorKind::Unauthorized,
            outcome_unknown: false,
        });
        assert_eq!(
            evaluate_start_result(&auth),
            StartEvaluation::Stop(StopReason::IdentityRevoked)
        );
    }

    #[test]
    fn disposition_classification() {
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
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "BLOCKED",
                Some("DOCTOR_VERIFICATION_FAILED")
            )),
            AttemptDisposition::StopDaemon
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt("INTERRUPTED", Some("PROTOCOL_ERROR"))),
            AttemptDisposition::StopDaemon
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "INTERRUPTED",
                Some("PROCESS_STOP_UNCONFIRMED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
    }

    #[test]
    fn disposition_keeps_active_on_local_state_write_failure() {
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "INTERRUPTED",
                Some("LOCAL_STATE_WRITE_FAILED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
    }

    #[test]
    fn disposition_unconfirmed_stop_wins_over_business_status() {
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "FAILED",
                Some("PROCESS_STOP_UNCONFIRMED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "COMPLETED",
                Some("PROCESS_STOP_UNCONFIRMED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
        assert_eq!(
            classify_disposition(&skeleton_receipt(
                "TIMED_OUT",
                Some("PROCESS_STOP_UNCONFIRMED")
            )),
            AttemptDisposition::KeepActiveRecovery
        );
    }

    struct Evidence {
        binding: BridgeBinding,
        worker_id: String,
        active: ActiveAttempt,
        receipt: TaskReceipt,
        rec_sha: String,
        envelope_sha: String,
        history: AttemptHistoryRecord,
        prompt_sha: String,
        accept_sha: String,
    }

    fn binding_for(ws: &str) -> BridgeBinding {
        BridgeBinding {
            server_origin: "https://ceo.example".to_string(),
            user_id: "usr_alice".to_string(),
            workspace_id: "ws_alpha".to_string(),
            workspace_ref: "tools".to_string(),
            canonical_workspace: ws.into(),
        }
    }

    fn make_evidence() -> Evidence {
        let binding = binding_for("/ws");
        let worker_id = "wrk-123e4567-e89b-12d3-a456-426614174000".to_string();
        let token = "ab".repeat(32);
        let prompt = "task goal";
        let accept = "acceptance";
        let envelope = "ENVELOPE-SENT-BYTES";
        let prompt_sha = sha256_of(prompt);
        let accept_sha = sha256_of(accept);
        let envelope_sha = sha256_of(envelope);

        let active = ActiveAttempt {
            job_id: "job-a".to_string(),
            attempt_id: "attempt-a".to_string(),
            claim_token: token.clone(),
            phase: LocalPhase::Running,
            claim: None,
            runner_boot_id: None,
            process: None,
            task_dispatch_intent: true,
            stop_error: None,
        };

        let mut receipt = skeleton_receipt("COMPLETED", None);
        receipt.job_id = "job-a".to_string();
        receipt.attempt_id = "attempt-a".to_string();
        receipt.bridge_context = Some(BridgeReceiptContext {
            server_origin: binding.server_origin.clone(),
            user_id: binding.user_id.clone(),
            workspace_id: binding.workspace_id.clone(),
            workspace_ref: binding.workspace_ref.clone(),
            worker_id: worker_id.clone(),
            job_id: "job-a".to_string(),
            attempt_id: "attempt-a".to_string(),
            source_prompt_sha256: prompt_sha.clone(),
            acceptance_sha256: accept_sha.clone(),
            task_dispatch_intent: true,
            stop_reason: None,
        });
        let rec_bytes = serde_json::to_vec(&receipt).unwrap();
        let rec_sha = sha256_of_bytes(&rec_bytes);
        let history = new_history_record(
            &binding,
            &worker_id,
            "job-a",
            "attempt-a",
            &prompt_sha,
            &accept_sha,
            &envelope_sha,
            &rec_sha,
            true,
            &token,
        );
        Evidence {
            binding,
            worker_id,
            active,
            receipt,
            rec_sha,
            envelope_sha,
            history,
            prompt_sha,
            accept_sha,
        }
    }

    fn verify_ev(ev: &Evidence) -> Result<(), String> {
        verify_terminal_evidence(
            &ev.binding,
            &ev.worker_id,
            &ev.active,
            &ev.receipt,
            &ev.rec_sha,
            &ev.envelope_sha,
            &ev.history,
            Some(&ev.prompt_sha),
            Some(&ev.accept_sha),
        )
    }

    fn resync_receipt_hash(ev: &mut Evidence) {
        let bytes = serde_json::to_vec(&ev.receipt).unwrap();
        let rec_sha = sha256_of_bytes(&bytes);
        ev.history = new_history_record(
            &ev.binding,
            &ev.worker_id,
            &ev.active.job_id,
            &ev.active.attempt_id,
            &ev.history.source_prompt_sha256,
            &ev.history.acceptance_sha256,
            &ev.history.envelope_sha256,
            &rec_sha,
            ev.receipt
                .bridge_context
                .as_ref()
                .map(|b| b.task_dispatch_intent)
                .unwrap_or(false),
            &ev.active.claim_token,
        );
        ev.rec_sha = rec_sha;
    }

    #[test]
    fn terminal_evidence_accepts_fully_consistent_state() {
        let ev = make_evidence();
        assert!(verify_ev(&ev).is_ok());
    }

    #[test]
    fn terminal_evidence_rejects_wrong_worker() {
        let mut ev = make_evidence();
        ev.receipt.bridge_context.as_mut().unwrap().worker_id = "wrk-other".to_string();
        assert!(verify_ev(&ev).unwrap_err().contains("worker_id"));
    }

    #[test]
    fn terminal_evidence_rejects_wrong_attempt_and_binding() {
        let mut ev = make_evidence();
        ev.receipt.bridge_context.as_mut().unwrap().attempt_id = "attempt-other".to_string();
        assert!(verify_ev(&ev).unwrap_err().contains("attempt"));

        let mut ev2 = make_evidence();
        ev2.receipt.bridge_context.as_mut().unwrap().workspace_ref = "different".to_string();
        assert!(verify_ev(&ev2).unwrap_err().contains("workspace_ref"));
    }

    #[test]
    fn terminal_evidence_rejects_format_valid_but_mismatched_receipt_hash() {
        let mut ev = make_evidence();
        ev.receipt.executor.version = "mutated".to_string();
        ev.rec_sha = sha256_of_bytes(&serde_json::to_vec(&ev.receipt).unwrap());
        assert!(
            verify_ev(&ev).unwrap_err().contains("receipt hash"),
            "receipt hash mismatch must be rejected"
        );
        resync_receipt_hash(&mut ev);
        assert!(verify_ev(&ev).is_ok());
    }

    #[test]
    fn terminal_evidence_rejects_tampered_envelope() {
        let mut ev = make_evidence();
        ev.envelope_sha = sha256_of("DIFFERENT-envelope");
        assert!(verify_ev(&ev).unwrap_err().contains("envelope"));
    }

    #[test]
    fn terminal_evidence_rejects_dispatch_intent_mismatch() {
        let mut ev = make_evidence();
        ev.receipt
            .bridge_context
            .as_mut()
            .unwrap()
            .task_dispatch_intent = false;
        assert!(verify_ev(&ev).unwrap_err().contains("dispatch"));

        let mut ev2 = make_evidence();
        ev2.active.task_dispatch_intent = false;
        assert!(verify_ev(&ev2).unwrap_err().contains("dispatch"));
    }

    #[test]
    fn terminal_evidence_rejects_control_token_mismatch() {
        let mut ev = make_evidence();
        ev.history.claim_token = "cd".repeat(32);
        assert!(verify_ev(&ev).unwrap_err().contains("control token"));
    }

    #[test]
    fn terminal_evidence_rejects_unconfirmed_stop_terminal_state() {
        let mut ev = make_evidence();
        ev.receipt.execution_status = "INTERRUPTED".to_string();
        ev.receipt.error = Some(crate::receipt::ReceiptError {
            stage: "x".to_string(),
            code: "PROCESS_STOP_UNCONFIRMED".to_string(),
            message: String::new(),
        });
        resync_receipt_hash(&mut ev);
        assert!(verify_ev(&ev).unwrap_err().contains("requires recovery"));
    }

    #[test]
    fn start_evaluation_dispatches_on_ok_and_lost_response() {
        use crate::bridge::client::ErrorKind;
        use crate::bridge::protocol::{AssignmentExecution, AssignmentStartOk};

        // 1. Clean Ok -> Dispatch
        let ok_eval = evaluate_start_result(&Ok(AssignmentStartOk {
            ok: true,
            replayed: false,
            server_time: "2026-09-07T00:00:00Z".to_string(),
            execution: AssignmentExecution {
                worker_id: "wrk-1".to_string(),
                attempt_id: "att-1".to_string(),
                phase: "running".to_string(),
                claimed_at: "2026-09-07T00:00:00Z".to_string(),
                started_at: Some("2026-09-07T00:00:01Z".to_string()),
            },
        }));
        assert!(matches!(ok_eval, StartEvaluation::Dispatch));

        // 2. Transport fault (outcome_unknown) -> DispatchUnconfirmed
        let transport_err = ClientError {
            kind: ErrorKind::Transport("connection reset by peer".to_string()),
            outcome_unknown: true,
        };
        let transport_eval = evaluate_start_result(&Err(transport_err));
        assert!(matches!(
            transport_eval,
            StartEvaluation::DispatchUnconfirmed
        ));

        // 3. Queue unavailable without integrity -> DispatchUnconfirmed
        let queue_err = ClientError {
            kind: ErrorKind::Server {
                status: 503,
                code: "QUEUE_UNAVAILABLE".to_string(),
                reason: None,
            },
            outcome_unknown: true,
        };
        let queue_eval = evaluate_start_result(&Err(queue_err));
        assert!(matches!(queue_eval, StartEvaluation::DispatchUnconfirmed));

        // 4. Confirmed rejection 409 -> Stop(ProtocolError)
        let reject_err = ClientError {
            kind: ErrorKind::Server {
                status: 409,
                code: "ASSIGNMENT_MISMATCH".to_string(),
                reason: Some("STOLEN_LEASE".to_string()),
            },
            outcome_unknown: false,
        };
        let reject_eval = evaluate_start_result(&Err(reject_err));
        assert!(matches!(
            reject_eval,
            StartEvaluation::Stop(StopReason::ProtocolError)
        ));

        // 5. Auth error -> Stop(IdentityRevoked)
        let auth_err = ClientError {
            kind: ErrorKind::Unauthorized,
            outcome_unknown: false,
        };
        let auth_eval = evaluate_start_result(&Err(auth_err));
        assert!(matches!(
            auth_eval,
            StartEvaluation::Stop(StopReason::IdentityRevoked)
        ));

        // 6. Protocol error -> Stop(ProtocolError)
        let proto_err = ClientError {
            kind: ErrorKind::Protocol("malformed json".to_string()),
            outcome_unknown: false,
        };
        let proto_eval = evaluate_start_result(&Err(proto_err));
        assert!(matches!(
            proto_eval,
            StartEvaluation::Stop(StopReason::ProtocolError)
        ));
    }

    #[test]
    fn disposition_requires_recovery_if_teardown_unconfirmed_or_write_failed() {
        let ev = make_evidence();

        // 1. Clean success -> Continue
        assert_eq!(
            classify_disposition(&ev.receipt),
            AttemptDisposition::Continue
        );

        // 2. Unconfirmed process stop -> KeepActiveRecovery
        let mut unconfirmed_receipt = skeleton_receipt("INTERRUPTED", None);
        unconfirmed_receipt.error = Some(crate::receipt::ReceiptError {
            stage: "teardown".to_string(),
            code: "PROCESS_STOP_UNCONFIRMED".to_string(),
            message: "group live".to_string(),
        });
        assert_eq!(
            classify_disposition(&unconfirmed_receipt),
            AttemptDisposition::KeepActiveRecovery
        );

        // 3. Local state write failed -> KeepActiveRecovery
        let mut write_failed_receipt = skeleton_receipt("COMPLETED", None);
        write_failed_receipt.error = Some(crate::receipt::ReceiptError {
            stage: "persistence".to_string(),
            code: "LOCAL_STATE_WRITE_FAILED".to_string(),
            message: "disk write failed".to_string(),
        });
        assert_eq!(
            classify_disposition(&write_failed_receipt),
            AttemptDisposition::KeepActiveRecovery
        );

        // 4. Blocked preflight / doctor -> StopDaemon
        let blocked_receipt = skeleton_receipt("BLOCKED", None);
        assert_eq!(
            classify_disposition(&blocked_receipt),
            AttemptDisposition::StopDaemon
        );
    }
}
