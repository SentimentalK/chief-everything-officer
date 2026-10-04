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
//!    exposes the required non-orchestrating existing-worktree Agent-aware
//!    launch surface (`ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE` otherwise).
//! 4. Explicit legacy command executor remains supported, but is claimable
//!    only if the configured command is locally executable using the shared
//!    cross-platform executable discovery.
//! 5. Global Orca runtime readiness stays a separate, adapter-level gate and
//!    is NOT re-decided here (doctor reports it independently).

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
        "{code}: installed Orca version does not expose a non-orchestrating \
existing-worktree Agent-aware launch surface required by Connector"
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

/// Shared executor-compatibility policy (Doctor + daemon admission).
///
/// Callers that do not possess a live Orca probe may pass `None` for the
/// probe only when the executor is NOT logical-only; for a logical-only
/// executor with no probe the conservative fail-closed answer is
/// AgentLaunchUnavailable.
pub async fn evaluate_executor_compatibility(
    executor: Option<&LocalExecutorConfig>,
    probe: Option<&dyn ExecutionCompatibilityProbe>,
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
            // launch surface required to create the agent terminal.
            let supported = match probe {
                Some(p) => p.supports_agent_session_launch().await,
                None => false,
            };
            if supported {
                Ok(())
            } else {
                Err(ExecutionCompatibility::AgentLaunchUnavailable {
                    code: ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE.to_string(),
                })
            }
        }
        Some(cmd) => {
            // Explicit legacy command executor: the first whitespace-delimited
            // token of the configured command must be locally executable using
            // the existing shared cross-platform executable discovery.
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
