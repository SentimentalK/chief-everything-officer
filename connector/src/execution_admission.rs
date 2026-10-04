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

use serde::{Deserialize, Serialize};

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

    /// Probe the Orca Agent launch surface snapshot.
    async fn probe_agent_launch_surface(&self) -> AgentLaunchSurface {
        if self.supports_agent_session_launch().await {
            AgentLaunchSurface::Available
        } else {
            AgentLaunchSurface::Unavailable
        }
    }

    /// Probe the global Orca runtime readiness.
    async fn probe_runtime_readiness(&self) -> OrcaRuntimeReadiness {
        OrcaRuntimeReadiness::Ready
    }
}

#[async_trait::async_trait]
impl ExecutionCompatibilityProbe for crate::orca::client::OrcaCliClient {
    async fn supports_agent_session_launch(&self) -> bool {
        crate::orca::client::OrcaCliClient::supports_agent_session_launch(self).await
    }

    async fn probe_agent_launch_surface(&self) -> AgentLaunchSurface {
        crate::orca::client::OrcaCliClient::probe_agent_session_launch(self).await
    }

    async fn probe_runtime_readiness(&self) -> OrcaRuntimeReadiness {
        crate::orca::client::OrcaCliClient::probe_runtime_readiness(self).await
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

/// Global Orca runtime readiness state observed by probing `orca status --json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrcaRuntimeReadiness {
    Ready,
    NotReady { code: String, reason: String },
    ProbeFailed { code: String, reason: String },
}

/// Machine-readable verdict on whether a Project is runnable on the current Device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProjectRunnableStatus {
    Runnable,
    NotRunnable,
    Unknown,
}

impl std::fmt::Display for ProjectRunnableStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectRunnableStatus::Runnable => write!(f, "runnable"),
            ProjectRunnableStatus::NotRunnable => write!(f, "not_runnable"),
            ProjectRunnableStatus::Unknown => write!(f, "unknown"),
        }
    }
}

/// Explicit per-Project runtime assessment verdict with machine-readable code
/// and explanatory reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRunnableAssessment {
    pub status: ProjectRunnableStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ProjectRunnableAssessment {
    pub fn runnable() -> Self {
        Self {
            status: ProjectRunnableStatus::Runnable,
            code: None,
            reason: None,
        }
    }

    pub fn not_runnable(code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            status: ProjectRunnableStatus::NotRunnable,
            code: Some(code.into()),
            reason: Some(reason.into()),
        }
    }

    pub fn unknown(code: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            status: ProjectRunnableStatus::Unknown,
            code: Some(code.into()),
            reason: Some(reason.into()),
        }
    }

    pub fn is_runnable(&self) -> bool {
        self.status == ProjectRunnableStatus::Runnable
    }
}

/// Point-in-time snapshot of the current Device's execution runtime environment.
///
/// Probed once outside any lock and reused across projects to prevent redundant
/// external CLI process invocations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceRuntimeSnapshot {
    pub orca_readiness: OrcaRuntimeReadiness,
    pub launch_surface: AgentLaunchSurface,
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

/// Probes the device runtime environment once to obtain an immutable snapshot
/// for evaluating project runnability.
pub async fn probe_device_runtime_snapshot(
    probe: Option<&dyn ExecutionCompatibilityProbe>,
) -> DeviceRuntimeSnapshot {
    let Some(p) = probe else {
        return DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::ProbeFailed {
                code: "PROBE_UNAVAILABLE".to_string(),
                reason: "no runtime probe provided".to_string(),
            },
            launch_surface: AgentLaunchSurface::Unknown,
        };
    };

    let orca_readiness = p.probe_runtime_readiness().await;
    let launch_surface = match orca_readiness {
        OrcaRuntimeReadiness::Ready => p.probe_agent_launch_surface().await,
        OrcaRuntimeReadiness::NotReady { ref code, .. } if code == "ORCA_CLI_NOT_FOUND" => {
            AgentLaunchSurface::Unavailable
        }
        OrcaRuntimeReadiness::NotReady { .. } => p.probe_agent_launch_surface().await,
        OrcaRuntimeReadiness::ProbeFailed { .. } => AgentLaunchSurface::Unknown,
    };

    DeviceRuntimeSnapshot {
        orca_readiness,
        launch_surface,
    }
}

/// Evaluates whether a Project is currently runnable on this Device.
///
/// Runnable=true only when BOTH structural/local Project prerequisites represented
/// by current Project/Target state are acceptable for execution AND the current
/// Device/runtime/executor is presently admissible using existing execution-admission
/// and runtime readiness facts.
pub fn evaluate_project_runnability(
    structural_status: &str,
    executor: Option<&LocalExecutorConfig>,
    snapshot: &DeviceRuntimeSnapshot,
) -> ProjectRunnableAssessment {
    // 1. Structural prerequisites check
    if structural_status != "READY" {
        return ProjectRunnableAssessment::not_runnable(
            structural_status,
            format!("project structural configuration status is '{structural_status}'"),
        );
    }

    // 2. Executor configuration
    let Some(exec) = executor else {
        return ProjectRunnableAssessment::not_runnable(
            "NO_EXECUTOR_CONFIGURED",
            "no agent executor configured",
        );
    };

    if let Err(e) = exec.validate() {
        return ProjectRunnableAssessment::not_runnable(
            "INVALID_EXECUTOR",
            format!("invalid executor configuration: {e}"),
        );
    }

    // 3. Command vs Logical executor compatibility & runtime readiness
    match exec.command.as_deref() {
        Some(cmd) => {
            let bin = cmd.split_whitespace().next().unwrap_or(cmd);
            if !executable_in_path(bin) {
                return ProjectRunnableAssessment::not_runnable(
                    "COMMAND_UNAVAILABLE",
                    format!("configured command executable '{bin}' not found in PATH"),
                );
            }

            match &snapshot.orca_readiness {
                OrcaRuntimeReadiness::Ready => ProjectRunnableAssessment::runnable(),
                OrcaRuntimeReadiness::NotReady { code, reason } => {
                    ProjectRunnableAssessment::not_runnable(code, reason)
                }
                OrcaRuntimeReadiness::ProbeFailed { code, reason } => {
                    ProjectRunnableAssessment::unknown(code, reason)
                }
            }
        }
        None => {
            match &snapshot.orca_readiness {
                OrcaRuntimeReadiness::ProbeFailed { code, reason } => {
                    return ProjectRunnableAssessment::unknown(code, reason);
                }
                OrcaRuntimeReadiness::NotReady { code, reason } => {
                    return ProjectRunnableAssessment::not_runnable(code, reason);
                }
                OrcaRuntimeReadiness::Ready => {}
            }

            match snapshot.launch_surface {
                AgentLaunchSurface::Available => ProjectRunnableAssessment::runnable(),
                AgentLaunchSurface::Unavailable => ProjectRunnableAssessment::not_runnable(
                    ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE,
                    "installed Orca version does not expose the required orchestration Agent launch surface required by Connector",
                ),
                AgentLaunchSurface::Unknown => ProjectRunnableAssessment::unknown(
                    "PROBE_FAILED",
                    "Orca Agent launch capability probe failed or could not be determined",
                ),
            }
        }
    }
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

    #[tokio::test]
    async fn evaluate_project_runnability_scenarios() {
        let logical_exec = LocalExecutorConfig::new_logical("antigravity".into(), None).unwrap();

        let temp = tempfile::tempdir().unwrap();
        let agent_bin = temp.path().join("fake-agent");
        std::fs::write(&agent_bin, b"#!/bin/sh\n").unwrap();
        let cmd_exec =
            LocalExecutorConfig::new("agy".into(), agent_bin.display().to_string()).unwrap();

        let missing_cmd_exec =
            LocalExecutorConfig::new("cursor".into(), "non-existent-binary-12345".into()).unwrap();

        let ready_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::Ready,
            launch_surface: AgentLaunchSurface::Available,
        };

        // 1. Structural READY + logical executor + ready Orca + supported launch surface => runnable.
        let res = evaluate_project_runnability("READY", Some(&logical_exec), &ready_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::Runnable);
        assert!(res.is_runnable());
        assert_eq!(res.code, None);
        assert_eq!(res.reason, None);

        // 2. Structural READY + logical executor + unsupported launch surface => not runnable with same code.
        let unsupported_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::Ready,
            launch_surface: AgentLaunchSurface::Unavailable,
        };
        let res = evaluate_project_runnability("READY", Some(&logical_exec), &unsupported_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::NotRunnable);
        assert!(!res.is_runnable());
        assert_eq!(
            res.code.as_deref(),
            Some(ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE)
        );

        // 3. Structural READY + explicit command present and executable => runnable when Orca ready.
        let res = evaluate_project_runnability("READY", Some(&cmd_exec), &ready_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::Runnable);
        assert!(res.is_runnable());

        // 4. Missing/non-executable explicit command => not runnable.
        let res = evaluate_project_runnability("READY", Some(&missing_cmd_exec), &ready_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::NotRunnable);
        assert_eq!(res.code.as_deref(), Some("COMMAND_UNAVAILABLE"));

        // No executor configured => not runnable
        let res = evaluate_project_runnability("READY", None, &ready_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::NotRunnable);
        assert_eq!(res.code.as_deref(), Some("NO_EXECUTOR_CONFIGURED"));

        // 5. Structural non-READY => not runnable regardless of executor.
        for non_ready in &[
            "UNBOUND",
            "PATH_MISSING",
            "TARGET_DISABLED",
            "REPOSITORY_MISMATCH",
            "LOCAL_ONLY",
            "SERVER_BOUND_NOT_LOCAL",
        ] {
            let res = evaluate_project_runnability(non_ready, Some(&logical_exec), &ready_snapshot);
            assert_eq!(
                res.status,
                ProjectRunnableStatus::NotRunnable,
                "status {non_ready} should not be runnable"
            );
            assert_eq!(res.code.as_deref(), Some(*non_ready));

            let res_cmd = evaluate_project_runnability(non_ready, Some(&cmd_exec), &ready_snapshot);
            assert_eq!(
                res_cmd.status,
                ProjectRunnableStatus::NotRunnable,
                "status {non_ready} should not be runnable for cmd executor"
            );
            assert_eq!(res_cmd.code.as_deref(), Some(*non_ready));
        }

        // 6. Explicit Orca runtime non-ready => not runnable.
        let app_not_running_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::NotReady {
                code: "ORCA_NOT_RUNNING".to_string(),
                reason: "Orca desktop app is not running".to_string(),
            },
            launch_surface: AgentLaunchSurface::Available,
        };
        let res =
            evaluate_project_runnability("READY", Some(&logical_exec), &app_not_running_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::NotRunnable);
        assert_eq!(res.code.as_deref(), Some("ORCA_NOT_RUNNING"));

        let res_cmd =
            evaluate_project_runnability("READY", Some(&cmd_exec), &app_not_running_snapshot);
        assert_eq!(res_cmd.status, ProjectRunnableStatus::NotRunnable);
        assert_eq!(res_cmd.code.as_deref(), Some("ORCA_NOT_RUNNING"));

        let cli_not_found_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::NotReady {
                code: "ORCA_CLI_NOT_FOUND".to_string(),
                reason: "Orca CLI not found in PATH".to_string(),
            },
            launch_surface: AgentLaunchSurface::Unavailable,
        };
        let res =
            evaluate_project_runnability("READY", Some(&logical_exec), &cli_not_found_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::NotRunnable);
        assert_eq!(res.code.as_deref(), Some("ORCA_CLI_NOT_FOUND"));

        // 7. Orca runtime/capability probe error/indeterminate => unknown, never runnable=true.
        let probe_err_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::ProbeFailed {
                code: "PROBE_FAILED".to_string(),
                reason: "connection timeout".to_string(),
            },
            launch_surface: AgentLaunchSurface::Unknown,
        };
        let res = evaluate_project_runnability("READY", Some(&logical_exec), &probe_err_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::Unknown);
        assert!(!res.is_runnable());
        assert_eq!(res.code.as_deref(), Some("PROBE_FAILED"));

        let res_cmd = evaluate_project_runnability("READY", Some(&cmd_exec), &probe_err_snapshot);
        assert_eq!(res_cmd.status, ProjectRunnableStatus::Unknown);
        assert!(!res_cmd.is_runnable());

        // Surface unknown while runtime ready => unknown for logical executor
        let surface_unknown_snapshot = DeviceRuntimeSnapshot {
            orca_readiness: OrcaRuntimeReadiness::Ready,
            launch_surface: AgentLaunchSurface::Unknown,
        };
        let res =
            evaluate_project_runnability("READY", Some(&logical_exec), &surface_unknown_snapshot);
        assert_eq!(res.status, ProjectRunnableStatus::Unknown);
        assert!(!res.is_runnable());
        assert_eq!(res.code.as_deref(), Some("PROBE_FAILED"));
    }
}
