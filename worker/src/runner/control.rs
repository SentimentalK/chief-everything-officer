//! The controlled-execution bridge between the Runner and the Bridge
//! controller.
//!
//! Local mode runs an attempt without any of this: `run_task` /
//! `run_task_with_options` are the unchanged local-mode wrappers. In Bridge
//! mode the controller and the Runner communicate exclusively through the
//! channel pair built by [`control_channel`]:
//!
//! * Runner → controller: a bounded mpsc of [`RunnerSignal`]s. Each signal is
//!   acknowledged with a per-signal oneshot; the Runner will not advance past
//!   that gate until its ack arrives.
//! * controller → Runner: a one-shot [`ExecutionPermit`] (sent exactly once,
//!   after StartIntent + Server start evaluation) and a
//!   `watch::Receiver<Option<StopReason>>` stop channel.
//!
//! If the controller is gone, or either ack/permit channel closes, the Runner
//! must stop — a closed channel is never treated as implicit approval.

use crate::bridge::state::{ProcessIdentity, SafeStopError};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot, watch};

/// One-time permission to send the business prompt. Carried from the controller
/// (which sends it) to the Runner (which receives it).
#[derive(Debug, Clone, Copy)]
pub struct ExecutionPermit;

/// A progress notification from the Runner that the controller must
/// acknowledge before the Runner proceeds to the next irreversible step.
#[derive(Debug)]
pub enum RunnerSignal {
    /// The Executor child process group has been spawned; the controller must
    /// persist its [`ProcessIdentity`] before the Doctor prompt may be sent.
    ProcessSpawned(ProcessIdentity),
    /// Doctor passed (or a valid cache hit) and local preparation is complete;
    /// the controller must persist StartIntent, evaluate Server start, then send
    /// the [`ExecutionPermit`].
    PreparedForTask,
}

/// Why the controller is asking the Runner to stop (or why the Runner is
/// stopping). Drives the terminal mapping of the attempt receipt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// SIGINT/SIGTERM: stop claiming and cancel the current execution.
    UserRequested,
    /// The live identity was revoked or no longer matches the binding.
    IdentityRevoked,
    /// A protocol/identity/configuration error is not recoverable by retry.
    ProtocolError,
    /// A mandatory local state write failed; never proceed to the next action.
    LocalStateWriteFailed,
    /// The execution exceeded its task-timeout budget.
    TaskTimedOut,
    /// The controller process vanished while the Runner was mid-flight.
    ControllerGone,
    /// The Runner/Executor process-group could not be confirmed stopped.
    ProcessStopUnconfirmed,
}

impl StopReason {
    /// A stable, safe code string (never includes tokens or bodies).
    pub fn code(&self) -> &'static str {
        match self {
            StopReason::UserRequested => "USER_REQUESTED",
            StopReason::IdentityRevoked => "IDENTITY_REVOKED",
            StopReason::ProtocolError => "PROTOCOL_ERROR",
            StopReason::LocalStateWriteFailed => "LOCAL_STATE_WRITE_FAILED",
            StopReason::TaskTimedOut => "TASK_TIMED_OUT",
            StopReason::ControllerGone => "CONTROLLER_GONE",
            StopReason::ProcessStopUnconfirmed => "PROCESS_STOP_UNCONFIRMED",
        }
    }

    /// Safe reason for the receipt/control record.
    pub fn safe_reason(&self) -> Option<String> {
        None
    }

    pub fn as_safe_error(&self) -> SafeStopError {
        SafeStopError {
            code: self.code().to_string(),
            reason: self.safe_reason(),
        }
    }
}

/// Bridge association metadata attached to a TaskReceipt for a bridge-managed
/// attempt. `None` for a local run; omitted for old receipts.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeReceiptContext {
    pub server_origin: String,
    pub user_id: String,
    pub workspace_id: String,
    pub workspace_ref: String,
    pub worker_id: String,
    pub job_id: String,
    pub attempt_id: String,
    /// sha256 of the raw Server prompt as claimed (independent of the envelope
    /// actually sent), so a replaced prompt is detectable.
    pub source_prompt_sha256: String,
    pub acceptance_sha256: String,
    /// True once the business prompt may have been written.
    pub task_dispatch_intent: bool,
    /// Stop reason when the attempt was not a clean completion.
    pub stop_reason: Option<SafeStopError>,
}

/// The Runner side of the control pair.
pub struct RunnerControls {
    /// Signals to the controller; each delivered signal must be acked.
    pub signals: mpsc::Sender<(RunnerSignal, oneshot::Sender<()>)>,
    /// One-shot grant to send the business prompt (runner receives it, once).
    pub permit_rx: Option<oneshot::Receiver<ExecutionPermit>>,
    /// Stop channel (controller sets `Some(reason)` to request a stop).
    pub stop: watch::Receiver<Option<StopReason>>,
    /// One-way shared dispatch-intent marker (shared with the controller). The
    /// controller sets it to `true` once it has committed `DispatchIntent`
    /// (business execution is authorized and may have begun). It never resets
    /// to `false`. The Runner reads it to decide NotStarted vs Unverified even
    /// when it never observed the actual business send.
    pub dispatch_intent: Arc<AtomicBool>,
}

/// The controller side of the control pair.
pub struct ControllerHandles {
    pub signals_rx: mpsc::Receiver<(RunnerSignal, oneshot::Sender<()>)>,
    pub permit_tx: oneshot::Sender<ExecutionPermit>,
    pub stop_tx: watch::Sender<Option<StopReason>>,
    /// One-way shared dispatch-intent marker; see [`RunnerControls`].
    pub dispatch_intent: Arc<AtomicBool>,
}

/// Builds the paired Runner/controller channels. The controller must hold onto
/// [`ControllerHandles`]; when it is dropped the Runner observes closed
/// ack/permit/stop channels and stops.
pub fn control_channel() -> (RunnerControls, ControllerHandles) {
    let (signals_tx, signals_rx) = mpsc::channel::<(RunnerSignal, oneshot::Sender<()>)>(16);
    let (permit_tx, permit_rx) = oneshot::channel::<ExecutionPermit>();
    let (stop_tx, stop_rx) = watch::channel::<Option<StopReason>>(None);
    let dispatch_intent = Arc::new(AtomicBool::new(false));
    (
        RunnerControls {
            signals: signals_tx,
            permit_rx: Some(permit_rx),
            stop: stop_rx,
            dispatch_intent: dispatch_intent.clone(),
        },
        ControllerHandles {
            signals_rx,
            permit_tx,
            stop_tx,
            dispatch_intent,
        },
    )
}

/// The gating the current run applies. `Local` keeps the pre-bridge behavior
/// (no signal/permit gates). `Bridge` enforces the full protocol.
pub enum ExecGate {
    Local,
    Bridge(RunnerControls),
}

impl ExecGate {
    pub fn is_bridge(&self) -> bool {
        matches!(self, ExecGate::Bridge(_))
    }

    /// Current stop signal, if any. (Controller-gone is detected through the
    /// permit/ack channels, which close when the controller is dropped, not via
    /// the watch snapshot.)
    pub fn current_stop(&self) -> Option<StopReason> {
        match self {
            ExecGate::Local => None,
            ExecGate::Bridge(c) => c.stop.borrow().clone(),
        }
    }

    /// Whether the controller has committed dispatch intent (business execution
    /// is authorized and may have begun). One-way: once `true` it never reverts.
    /// The Runner uses this (together with an observed send) to classify a stop
    /// as `Unverified` rather than `NotStarted` after the dispatch boundary.
    pub fn dispatch_intent(&self) -> bool {
        match self {
            ExecGate::Local => false,
            ExecGate::Bridge(c) => c.dispatch_intent.load(Ordering::SeqCst),
        }
    }

    /// Sends a signal and waits for its ack. `Local` is a no-op `Ok(())`. On a
    /// closed channel the Runner must stop.
    pub async fn signal_and_ack(&self, signal: RunnerSignal) -> Result<(), StopReason> {
        let ExecGate::Bridge(c) = self else {
            return Ok(());
        };
        // Never wait out a pending stop behind an ack we might not get.
        if let Some(stop) = c.stop.borrow().clone() {
            return Err(stop);
        }
        let (tx, rx) = oneshot::channel::<()>();
        c.signals
            .send((signal, tx))
            .await
            .map_err(|_| StopReason::ControllerGone)?;
        rx.await.map_err(|_| StopReason::ControllerGone)
    }

    /// Awaits the execution permit (Bridge, consumes it), or returns the stop
    /// reason if the permit never arrives. `Local` returns `Ok(())`.
    ///
    /// While the permit is outstanding, a stop request on the shared watch
    /// channel is observed and aborts the wait. A closed permit channel, or a
    /// stop channel whose senders have all vanished, means the controller is
    /// gone (`ControllerGone`) — a closed channel is never implicit approval.
    /// If stop and permit are simultaneously ready, stop takes priority.
    pub async fn await_permit(&mut self) -> Result<(), StopReason> {
        let ExecGate::Bridge(c) = self else {
            return Ok(());
        };
        let Some(rx) = c.permit_rx.take() else {
            // No outstanding permit to await (already consumed or never wired).
            return Err(StopReason::ControllerGone);
        };
        let mut stop_rx = c.stop.clone();
        // Check the current stop value first.
        if let Some(stop) = stop_rx.borrow().clone() {
            return Err(stop);
        }
        let mut permit = rx;
        loop {
            tokio::select! {
                biased;
                changed = stop_rx.changed() => {
                    match changed {
                        Ok(_) => {
                            if let Some(stop) = stop_rx.borrow().clone() {
                                return Err(stop);
                            }
                            // A no-op change; keep waiting for the permit.
                        }
                        Err(_) => return Err(StopReason::ControllerGone),
                    }
                }
                res = &mut permit => {
                    if let Some(stop) = stop_rx.borrow().clone() {
                        return Err(stop);
                    }
                    return match res {
                        Ok(_) => Ok(()),
                        Err(_) => Err(StopReason::ControllerGone),
                    };
                }
            }
        }
    }
}
