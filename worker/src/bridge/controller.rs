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
    claim_backoff, stop_at_from_remaining, BootTime, Clock, HEARTBEAT_INTERVAL, TAIL_POLL,
    WATCHDOG_PERIOD,
};
use crate::bridge::protocol::{ClaimRequest, Execution, LeaseOperationRequest};
use crate::bridge::state::{
    self, ActiveAttempt, AttemptHistoryRecord, BridgeBinding, BridgeState, ClaimPayload, LocalPhase,
};
use crate::local_state::atomic_write_durable;
use crate::receipt::TaskReceipt;
use crate::runner::control::control_channel;
use crate::runner::{BridgeReceiptContext, Runner, RunnerError, RunnerSignal, StopReason};
use chrono::{DateTime, FixedOffset};
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
        payload.prompt.trim_end(),
        payload.acceptance.trim_end(),
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

#[derive(Clone, Copy)]
enum StopOrigin {
    Lease,
    Execution,
}

#[derive(Clone, Copy)]
struct LeaseLine {
    stop_at: BootTime,
    origin: StopOrigin,
}

/// The controller for one canonical workspace / alias.
pub struct Worker {
    client: BridgeClient,
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
            client,
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

    fn lease_line_from(
        &self,
        exec: &Execution,
        server_time: &str,
        sent: BootTime,
    ) -> Option<LeaseLine> {
        let running = exec.phase == "running";
        let phase_deadline = if running {
            exec.execution_deadline.as_deref()?
        } else {
            &exec.start_deadline
        };
        let lease_rem = remaining_to(&exec.lease_expires_at, server_time)?;
        let phase_rem = remaining_to(phase_deadline, server_time)?;
        let origin = if running && phase_rem <= lease_rem {
            StopOrigin::Execution
        } else {
            StopOrigin::Lease
        };
        let eff = lease_rem.min(phase_rem);
        let stop_at = stop_at_from_remaining(sent, eff).unwrap_or(sent);
        Some(LeaseLine { stop_at, origin })
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
                self.finish_claimed(state, active, stop_rx).await
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
    Ok(sha256_of(&String::from_utf8_lossy(&bytes)))
}

/// Result of a lease-write HTTP send, produced by an independent arm future.
enum HbResult {
    Ok(LeaseLine),
    Stopped(StopReason),
    /// Response invalid / unconfirmed.
    Unconfirmed,
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
            Some(active) => self.finish_claimed(state, active, stop_rx).await,
            None => {
                state.active = None;
                let _ = state.persist(&self.workspace);
                Ok(())
            }
        }
    }

    /// Replays a claim until its result is known. Returns Some on Confirmed,
    /// None on NotMine; fatal errors are `Err`.
    async fn claim_replay(
        &mut self,
        state: &mut BridgeState,
        job_id: &str,
        attempt_id: &str,
        req: &ClaimRequest,
    ) -> Result<Option<ActiveAttempt>, i32> {
        let window_start = self.clock.now_boot();
        let mut attempt_no = 0usize;
        loop {
            match self.client.claim(job_id, req).await {
                Ok(ok) => {
                    let payload = ClaimPayload::from_wire(&ok.job);
                    let a = state.active.as_mut().unwrap();
                    a.phase = LocalPhase::Claimed;
                    a.claim = Some(payload);
                    if state.persist(&self.workspace).is_err() {
                        return Err(1);
                    }
                    return Ok(state.active.clone());
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
                        let now = self.clock.now_boot();
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

        let receipt = self
            .run_managed_attempt(state, &job_id, &attempt_id, &active, &prompt_path, stop_rx)
            .await?;

        let attempt_dir = attempt_dir_for(&self.workspace, &job_id, &attempt_id);
        let rec_sha = sha256_file(&attempt_dir.join("receipt.json")).unwrap_or_default();
        let history = AttemptHistoryRecord {
            job_id: job_id.clone(),
            attempt_id: attempt_id.clone(),
            worker_id: self.worker_id.clone(),
            receipt_sha256: rec_sha,
            finalized_at: chrono::Utc::now().to_rfc3339(),
        };
        let _ = history.persist(&self.workspace);
        state.active = None;
        let _ = state.persist(&self.workspace);
        emit(
            "local_result_saved",
            &job_id,
            &attempt_id,
            &self.workspace_ref,
            "server_result_reported:false",
        );
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
    Heartbeat(HbResult),
    Done(Result<Result<TaskReceipt, RunnerError>, tokio::task::JoinError>),
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

        let (runner_controls, mut ctl) = control_channel(self.clock.clone());
        let mut permit: Option<oneshot::Sender<crate::runner::control::ExecutionPermit>> =
            Some(ctl.permit_tx);
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
        let mut next_hb = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;

        let token = active.lease_token.clone();
        let mut stopping: Option<StopReason> = None;
        let mut stop_at: Option<BootTime> = None;
        let mut at_execution = false;

        loop {
            if let Some(reason) = stopping.take() {
                // Already signalled stop: wait for the Runner to finish.
                let _ = ctl.stop_tx.send(Some(reason));
                return self.collect_receipt((&mut handle).await).await;
            }

            let arm = tokio::select! {
                _ = stop_rx.changed() => Arm::ExternalStop,
                sig = ctl.signals_rx.recv() => Arm::Signal(sig),
                _ = watchdog.tick() => Arm::Watchdog,
                hb_res = async {
                    tokio::time::sleep_until(next_hb).await;
                    self.send_heartbeat(job_id, attempt_id, token.clone()).await
                } => Arm::Heartbeat(hb_res),
                res = &mut handle => Arm::Done(res),
            };

            match arm {
                Arm::Done(res) => return self.collect_receipt(res).await,
                Arm::ExternalStop => {
                    if let Some(reason) = stop_rx.borrow().clone() {
                        stopping = Some(reason);
                    }
                }
                Arm::Signal(sig) => {
                    match sig {
                        Some((RunnerSignal::ProcessSpawned(identity), ack)) => {
                            let a = state.active.as_mut().unwrap();
                            a.process = Some(identity);
                            a.runner_boot_id = state::current_boot_id();
                            let _ = state.persist(&self.workspace);
                            let _ = ack.send(());
                        }
                        Some((RunnerSignal::PreparedForTask, ack)) => {
                            let _ = ack.send(());
                            if stopping.is_some() {
                                // Do not start; release permit so Runner stops
                                // with dispatch=false.
                                return self.collect_receipt((&mut handle).await).await;
                            }
                            // Persist StartIntent, then call Server start.
                            let a = state.active.as_mut().unwrap();
                            a.phase = LocalPhase::StartIntent;
                            if state.persist(&self.workspace).is_err() {
                                let _ = ctl.stop_tx.send(Some(StopReason::LocalStateWriteFailed));
                                return Err(1);
                            }
                            let req = LeaseOperationRequest {
                                worker_id: self.worker_id.clone(),
                                attempt_id: attempt_id.to_string(),
                                lease_token: token.clone(),
                            };
                            let sent = self.clock.now_boot();
                            match self.client.start(job_id, &req).await {
                                Ok(ok) => {
                                    if let Some(line) =
                                        self.lease_line_from(&ok.execution, &ok.server_time, sent)
                                    {
                                        let a = state.active.as_mut().unwrap();
                                        a.phase = LocalPhase::DispatchIntent;
                                        a.task_dispatch_intent = true;
                                        if state.persist(&self.workspace).is_err() {
                                            let _ = ctl
                                                .stop_tx
                                                .send(Some(StopReason::LocalStateWriteFailed));
                                            return Err(1);
                                        }
                                        stop_at = Some(line.stop_at);
                                        at_execution = matches!(line.origin, StopOrigin::Execution);
                                        if let Some(p) = permit.take() {
                                            let _ =
                                                p.send(crate::runner::control::ExecutionPermit {
                                                    execution_deadline: line.stop_at,
                                                });
                                        }
                                    } else {
                                        stopping = Some(StopReason::LeaseUnconfirmed);
                                    }
                                }
                                Err(e) => stopping = Some(start_error_to_stop(&e)),
                            }
                        }
                        None => {
                            return self.collect_receipt((&mut handle).await).await;
                        }
                    }
                }
                Arm::Watchdog => {
                    let now = self.clock.now_boot();
                    if let Some(sa) = stop_at {
                        if now >= sa {
                            stopping = Some(if at_execution {
                                StopReason::TaskTimedOut
                            } else {
                                StopReason::LeaseExpired { reason: None }
                            });
                        }
                    }
                }
                Arm::Heartbeat(hb) => {
                    match hb {
                        HbResult::Ok(line) => {
                            stop_at = Some(line.stop_at);
                            at_execution = matches!(line.origin, StopOrigin::Execution);
                        }
                        HbResult::Stopped(reason) => stopping = Some(reason),
                        HbResult::Unconfirmed => stopping = Some(StopReason::LeaseUnconfirmed),
                    }
                    next_hb = tokio::time::Instant::now() + HEARTBEAT_INTERVAL;
                }
            }
        }
    }

    /// Sends one heartbeat. Returns the refreshed lease line on success, a stop
    /// reason on a terminal failure, or Unconfirmed on an unusable response.
    async fn send_heartbeat(&self, job_id: &str, attempt_id: &str, token: String) -> HbResult {
        let req = LeaseOperationRequest {
            worker_id: self.worker_id.clone(),
            attempt_id: attempt_id.to_string(),
            lease_token: token,
        };
        let sent = self.clock.now_boot();
        match self.client.heartbeat(job_id, &req).await {
            Ok(ok) => match self.lease_line_from(&ok.execution, &ok.server_time, sent) {
                Some(line) => HbResult::Ok(line),
                None => HbResult::Unconfirmed,
            },
            Err(e) => HbResult::Stopped(lease_error_to_stop(&e)),
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

fn start_error_to_stop(e: &ClientError) -> StopReason {
    match e.kind {
        ErrorKind::Server {
            ref code,
            ref reason,
            ..
        } if code == "LEASE_EXPIRED" => StopReason::LeaseExpired {
            reason: reason.clone(),
        },
        ErrorKind::Unauthorized | ErrorKind::Forbidden | ErrorKind::IdentityMismatch { .. } => {
            StopReason::IdentityRevoked
        }
        ErrorKind::Redirect(_) | ErrorKind::Protocol(_) => StopReason::ProtocolError,
        _ => StopReason::LeaseUnconfirmed,
    }
}

fn lease_error_to_stop(e: &ClientError) -> StopReason {
    start_error_to_stop(e)
}
