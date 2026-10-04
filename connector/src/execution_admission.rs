//! Shared per-Target local execution admission/preflight policy.
//!
//! Both the resident daemon (before persisting a ClaimIntent or issuing any
//! Server claim request) and `doctor` must agree on whether a locally mapped
//! Project/Target can actually be launched by this Device with its CURRENT
//! executor/runtime configuration. A single shared helper prevents the two
//! call sites from drifting apart.
//!
//! Policy (authoritative semantics):
//! 1. Missing executor is not claimable.
//! 2. Invalid executor configuration is not claimable.
//! 3. Logical-only executor (command=None) is not claimable unless Orca
//!    exposes the required orchestration Agent launch surface
//!    (`ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE` otherwise).
//! 4. Explicit legacy command executor remains supported, but is claimable
//!    only if the configured command is locally executable using the shared
//!    cross-platform executable discovery.
//! 5. Global Orca runtime readiness stays a separate, adapter-level gate and
//!    is NOT re-decided here (doctor reports it independently).
//!
//! Lock-boundary invariant (Connector design): `state.lock` protects short
//! local durable-state transitions only. Orca capability probing performs
//! external Orca CLI process I/O and therefore MUST run outside any
//! `state.lock` scope; its result is captured in an [`AgentLaunchSurface`]
//! snapshot and consumed by the purely local evaluation
//! ([`evaluate_executor_compatibility_with_surface`]) both during candidate
//! scanning and in the immediate pre-ClaimIntent re-check under the lock
//! (which performs no `.await`, no Orca CLI process, and no network call).

use crate::config::LocalExecutorConfig;
use crate::setup_frontend::executable_in_path;

/// Human-facing machine code for the logical-only executor incompatibility
/// observed when the installed Orca lacks the Agent-aware launch surface.
pub const ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE: &str = "ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE";

/// Error returned when a Target's executor configuration makes the Target
/// locally unlaunchable (and therefore its pending Server Job unclaimable by
/// this Device). The Server Job is left queued; this is a purely local
/// admission decision with no Server-side mutation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ExecutionCompatibility {
    /// No agent executor configured for the Target.
    #[error("NO_EXECUTOR_CONFIGURED: no agent executor configured")]
    MissingExecutor,
    /// Executor configuration failed validation.
    #[error("INVALID_EXECUTOR_CONFIGURATION: invalid executor configuration: {0}")]
    InvalidExecutor(String),
    /// Logical-only executor, but the installed Orca lacks the required
    /// Agent-aware launch surface.
    #[error(
        "{code}: installed Orca version does not expose the required orchestration \
Agent launch surface required by Connector"
    )]
    AgentLaunchUnavailable { code: String },
    /// Explicit legacy command executor, but its configured command is not
    /// locally executable (executable discovery failed).
    #[error("COMMAND_UNAVAILABLE: configured command executable '{0}' not found in PATH")]
    CommandUnavailable(String),
}

impl ExecutionCompatibility {
    /// Short machine-readable severity code used by Doctor output.
    pub fn code(&self) -> String {
        match self {
            ExecutionCompatibility::MissingExecutor => "NO_EXECUTOR_CONFIGURED".to_string(),
            ExecutionCompatibility::InvalidExecutor(_) => "INVALID_EXECUTOR".to_string(),
            ExecutionCompatibility::AgentLaunchUnavailable { code } => code.clone(),
            ExecutionCompatibility::CommandUnavailable(_) => "COMMAND_UNAVAILABLE".to_string(),
        }
    }

    /// The configured command binary whose local executable discovery failed.
    pub fn missing_command(&self) -> Option<&str> {
        match self {
            ExecutionCompatibility::CommandUnavailable(cmd) => Some(cmd.as_str()),
            _ => None,
        }
    }
}

/// Async runtime surface required by the shared admission policy.
///
/// Implemented by [`crate::orca::client::OrcaCliClient`] in production and by
/// test stubs so the exact same policy can be exercised deterministically.
#[async_trait::async_trait]
pub trait ExecutionCompatibilityProbe: Send + Sync {
    /// Whether the installed Orca exposes a non-orchestrating
    /// existing-worktree Agent-aware launch surface.
    async fn supports_agent_session_launch(&self) -> bool;
}

#[async_trait::async_trait]
impl ExecutionCompatibilityProbe for crate::orca::client::OrcaCliClient {
    async fn supports_agent_session_launch(&self) -> bool {
        crate::orca::client::OrcaCliClient::supports_agent_session_launch(self).await
    }
}

/// Snapshot of the Orca Agent-aware launch-surface capability.
///
/// The probe itself performs external Orca CLI process I/O and must be
/// awaited OUTSIDE any `state.lock` scope; the resulting snapshot is then
/// consumed by the pure evaluator
/// ([`evaluate_executor_compatibility_with_surface`]) under the lock (if
/// any) with no further external I/O.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLaunchSurface {
    /// The installed Orca exposes the required non-orchestrating
    /// existing-worktree Agent-aware launch surface.
    Available,
    /// The installed Orca does not expose the required launch surface (the
    /// probe ran and deterministically reported absence).
    Unavailable,
    /// No probe was performed (or it could not determine capability):
    /// conservatively fail-closed for logical-only executors.
    Unknown,
}

/// Shared executor-compatibility policy (Doctor + daemon admission).
///
/// Callers that do not possess a live Orca probe may pass `None` for the
/// probe only when the executor is NOT logical-only; for a logical-only
/// executor with no probe the conservative fail-closed answer is
/// AgentLaunchUnavailable.
///
/// This wrapper performs the async/external Orca capability probe (only for
/// logical-only executors) and then delegates to the purely local
/// [`evaluate_executor_compatibility_with_surface`]. Callers that already
/// hold a lock (or otherwise cannot await external I/O) must NOT use this
/// wrapper: probe first, then call the pure evaluator with the snapshot.
pub async fn evaluate_executor_compatibility(
    executor: Option<&LocalExecutorConfig>,
    probe: Option<&dyn ExecutionCompatibilityProbe>,
) -> Result<(), ExecutionCompatibility> {
    // The launch surface is only ever consulted for logical-only executors
    // (command=None); every other shape is decided purely locally.
    let surface = match executor.map(|e| e.command.as_deref()) {
        Some(None) => match probe {
            Some(p) if p.supports_agent_session_launch().await => AgentLaunchSurface::Available,
            Some(_) => AgentLaunchSurface::Unavailable,
            None => AgentLaunchSurface::Unknown,
        },
        _ => AgentLaunchSurface::Unknown,
    };
    evaluate_executor_compatibility_with_surface(executor, surface)
}

/// Pure/local executor-compatibility evaluation.
///
/// Consumes the current executor configuration plus an ALREADY-PROBED Orca
/// launch-surface snapshot. This function performs no `.await`, no Orca CLI
/// process spawn, no network call, and no adapter call: it is safe to call
/// while holding `state.lock`. All compatibility exceptions must therefore
/// come from the snapshot, never from a live probe.
pub fn evaluate_executor_compatibility_with_surface(
    executor: Option<&LocalExecutorConfig>,
    agent_launch_surface: AgentLaunchSurface,
) -> Result<(), ExecutionCompatibility> {
    let Some(exec) = executor else {
        return Err(ExecutionCompatibility::MissingExecutor);
    };

    if let Err(e) = exec.validate() {
        return Err(ExecutionCompatibility::InvalidExecutor(e.to_string()));
    }

    match exec.command.as_deref() {
        None => {
            // Logical-only executor: claimable only if the installed Orca
            // exposes the non-orchestrating existing-worktree Agent-aware
            // launch surface required to create the agent terminal. The
            // snapshot (probed outside any lock) is authoritative here;
            // Unknown is conservatively fail-closed.
            match agent_launch_surface {
                AgentLaunchSurface::Available => Ok(()),
                AgentLaunchSurface::Unavailable | AgentLaunchSurface::Unknown => {
                    Err(ExecutionCompatibility::AgentLaunchUnavailable {
                        code: ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE.to_string(),
                    })
                }
            }
        }
        Some(cmd) => {
            // Explicit legacy command executor: the first whitespace-delimited
            // token of the configured command must be locally executable using
            // the existing shared cross-platform executable discovery (a
            // local, non-async PATH lookup).
            let bin = cmd.split_whitespace().next().unwrap_or(cmd);
            if executable_in_path(bin) {
                Ok(())
            } else {
                Err(ExecutionCompatibility::CommandUnavailable(bin.to_string()))
            }
        }
    }
}

/// Convenience alias for the daemon admission check on a mapped Target:
/// returns Ok(()) when this Device can launch the Target's Project with its
/// current executor/runtime configuration.
pub async fn target_execution_admission(
    target_executor: Option<&LocalExecutorConfig>,
    probe: Option<&dyn ExecutionCompatibilityProbe>,
) -> Result<(), ExecutionCompatibility> {
    evaluate_executor_compatibility(target_executor, probe).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Probe {
        launch: bool,
    }

    #[async_trait::async_trait]
    impl ExecutionCompatibilityProbe for Probe {
        async fn supports_agent_session_launch(&self) -> bool {
            self.launch
        }
    }

    #[tokio::test]
    async fn missing_executor_is_not_claimable() {
        let res = evaluate_executor_compatibility(None, None).await;
        assert_eq!(res.unwrap_err(), ExecutionCompatibility::MissingExecutor);
    }

    #[test]
    fn pure_snapshot_evaluation_never_probes_and_is_fail_closed() {
        let exec = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();

        // Available snapshot: claimable. Unavailable snapshot: not claimable.
        assert!(evaluate_executor_compatibility_with_surface(
            Some(&exec),
            AgentLaunchSurface::Available
        )
        .is_ok());
        assert!(evaluate_executor_compatibility_with_surface(
            Some(&exec),
            AgentLaunchSurface::Unavailable
        )
        .is_err());

        // Unknown (no snapshot / undetermined capability) must fail closed:
        // this is what the under-lock pre-ClaimIntent re-check hits when the
        // probe was never performed for the scanned executor shape.
        let err =
            evaluate_executor_compatibility_with_surface(Some(&exec), AgentLaunchSurface::Unknown)
                .unwrap_err();
        assert_eq!(
            err,
            ExecutionCompatibility::AgentLaunchUnavailable {
                code: ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE.to_string()
            }
        );
    }

    #[tokio::test]
    async fn logical_only_claimable_only_with_agent_launch_surface() {
        let exec = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();

        let ok = Probe { launch: true };
        assert!(evaluate_executor_compatibility(Some(&exec), Some(&ok))
            .await
            .is_ok());

        let bad = Probe { launch: false };
        let err = evaluate_executor_compatibility(Some(&exec), Some(&bad))
            .await
            .unwrap_err();
        assert_eq!(
            err,
            ExecutionCompatibility::AgentLaunchUnavailable {
                code: ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE.to_string()
            }
        );
        assert_eq!(err.code(), "ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE");

        // Fail closed with no probe
        assert!(evaluate_executor_compatibility(Some(&exec), None)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn logical_with_model_override_same_surface_requirement() {
        let exec = LocalExecutorConfig::new_logical("cursor".into(), Some("gpt-5".into())).unwrap();
        let bad = Probe { launch: false };
        let err = evaluate_executor_compatibility(Some(&exec), Some(&bad))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            ExecutionCompatibility::AgentLaunchUnavailable { .. }
        ));
    }

    #[tokio::test]
    async fn invalid_executor_rejected() {
        // Force a structurally invalid executor (constructor validates, so it
        // must be built directly here).
        let invalid = LocalExecutorConfig {
            kind: "orca_tui".into(),
            agent_id: "bad agent!".into(),
            command: None,
            model: None,
        };
        let err = evaluate_executor_compatibility(Some(&invalid), None)
            .await
            .unwrap_err();
        assert!(matches!(err, ExecutionCompatibility::InvalidExecutor(_)));
    }

    #[tokio::test]
    async fn legacy_command_claimable_iff_executable_locally() {
        // Positive branch: an absolute-path command that exists locally.
        // executable_in_path() only requires the file to exist for absolute
        // paths, so this is deterministic on every platform.
        let temp = tempfile::tempdir().unwrap();
        let agent_bin = temp.path().join("fake-agent");
        std::fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
        let good = LocalExecutorConfig::new("agy".into(), agent_bin.display().to_string()).unwrap();
        assert!(evaluate_executor_compatibility(Some(&good), None)
            .await
            .is_ok());

        let missing = LocalExecutorConfig::new(
            "cursor".into(),
            "definitely-not-a-real-binary-xyz-9z -f --trust".into(),
        )
        .unwrap();
        let err = evaluate_executor_compatibility(Some(&missing), None)
            .await
            .unwrap_err();
        assert_eq!(
            err,
            ExecutionCompatibility::CommandUnavailable(
                "definitely-not-a-real-binary-xyz-9z".to_string()
            )
        );
        assert_eq!(
            err.missing_command(),
            Some("definitely-not-a-real-binary-xyz-9z")
        );
    }
}
