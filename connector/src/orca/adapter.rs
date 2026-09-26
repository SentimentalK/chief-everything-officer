use std::time::Duration;

use async_trait::async_trait;

use super::client::{OrcaCliClient, OrcaError};
use crate::config::LocalTarget;
use crate::scheduler::{
    ActiveAttempt, DispatchOutcome, DispatchReconciliation, ExecutionAdapter, WaitOutcome,
};

#[derive(Clone, Debug)]
pub struct OrcaExecutionAdapter {
    pub client: OrcaCliClient,
}

impl Default for OrcaExecutionAdapter {
    fn default() -> Self {
        Self::new(OrcaCliClient::default())
    }
}

impl OrcaExecutionAdapter {
    pub fn new(client: OrcaCliClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl ExecutionAdapter for OrcaExecutionAdapter {
    fn name(&self) -> &'static str {
        "orca"
    }

    async fn is_ready(&self) -> bool {
        match self.client.status().await {
            Ok(resp) if resp.ok => {
                if let Some(res) = resp.result {
                    res.app.running && res.runtime.state == "ready"
                } else {
                    false
                }
            }
            _ => false,
        }
    }

    async fn prepare(
        &self,
        attempt: &ActiveAttempt,
        target: &LocalTarget,
    ) -> Result<crate::scheduler::PreparedExecution, String> {
        let executor = target.executor.as_ref().ok_or_else(|| {
            "RECOVERY_REQUIRED: target has no agent executor configured".to_string()
        })?;

        // 1. Resolve fixed local Target in Orca (show worktree by path, repo add if missing)
        let canonical_target_path = std::fs::canonicalize(&target.local_path).map_err(|e| {
            format!(
                "RECOVERY_REQUIRED: target path '{}' canonicalize failed: {e}",
                target.local_path
            )
        })?;

        let worktree = match self
            .client
            .show_worktree_by_path(&canonical_target_path)
            .await
            .map_err(|e| format!("failed to show worktree for target: {e}"))?
        {
            Some(wt) => wt,
            None => {
                let _ = self
                    .client
                    .add_repo(&canonical_target_path)
                    .await
                    .map_err(|e| format!("failed to add repo for target: {e}"))?;
                self.client
                    .show_worktree_by_path(&canonical_target_path)
                    .await
                    .map_err(|e| format!("failed to show worktree after adding repo: {e}"))?
                    .ok_or_else(|| {
                        format!(
                            "RECOVERY_REQUIRED: worktree not found after adding repo for path '{}'",
                            canonical_target_path.display()
                        )
                    })?
            }
        };

        let wt_canonical = std::fs::canonicalize(&worktree.path).map_err(|e| {
            format!(
                "RECOVERY_REQUIRED: worktree path '{}' canonicalize failed: {e}",
                worktree.path
            )
        })?;
        if wt_canonical != canonical_target_path {
            return Err(format!(
                "RECOVERY_REQUIRED: resolved worktree path '{}' does not match target path '{}'",
                wt_canonical.display(),
                canonical_target_path.display()
            ));
        }

        // 2. Terminal reconciliation on title `ceo:<attempt_id>`, scoped to resolved worktree
        let expected_title = format!("ceo:{}", attempt.attempt_id);
        let terminals = self
            .client
            .list_terminals(Some(&worktree.id))
            .await
            .map_err(|e| {
                format!(
                    "failed to list terminals for worktree '{}': {e}",
                    worktree.id
                )
            })?;

        let matching_terminals: Vec<_> = terminals
            .into_iter()
            .filter(|t| {
                t.title.as_deref() == Some(&expected_title)
                    && t.worktree_id
                        .as_deref()
                        .map(|w| w == worktree.id)
                        .unwrap_or(true)
            })
            .collect();

        let (terminal_handle, ready_at) = match matching_terminals.len() {
            0 => {
                let term = self
                    .client
                    .create_terminal(
                        &worktree.id,
                        &expected_title,
                        Some(&executor.command),
                        Some(&canonical_target_path),
                    )
                    .await
                    .map_err(|e| format!("failed to create terminal for attempt: {e}"))?;

                // TUI readiness gate: 60s, retry 120s
                let wait_res = self
                    .client
                    .wait_terminal_tui_idle(&term.handle, Duration::from_secs(60))
                    .await;
                let satisfied = match wait_res {
                    Ok(resp) => resp
                        .result
                        .and_then(|r| r.wait)
                        .map(|w| w.satisfied)
                        .unwrap_or(false),
                    Err(_) => false,
                };

                let satisfied = if !satisfied {
                    let retry_res = self
                        .client
                        .wait_terminal_tui_idle(&term.handle, Duration::from_secs(120))
                        .await;
                    match retry_res {
                        Ok(resp) => resp
                            .result
                            .and_then(|r| r.wait)
                            .map(|w| w.satisfied)
                            .unwrap_or(false),
                        Err(_) => false,
                    }
                } else {
                    true
                };

                if !satisfied {
                    return Err(
                        "RECOVERY_REQUIRED: AGENT_NOT_READY: terminal failed TUI readiness gate"
                            .into(),
                    );
                }
                let now = chrono::Utc::now().timestamp_millis();
                (term.handle, now)
            }
            1 => {
                let handle = matching_terminals.into_iter().next().unwrap().handle;
                let ready_at =
                    if let Some(ts) = attempt.executor.as_ref().and_then(|e| e.agent_ready_at_ms) {
                        ts
                    } else {
                        let wait_res = self
                            .client
                            .wait_terminal_tui_idle(&handle, Duration::from_secs(60))
                            .await;
                        let satisfied = match wait_res {
                            Ok(resp) => resp
                                .result
                                .and_then(|r| r.wait)
                                .map(|w| w.satisfied)
                                .unwrap_or(false),
                            Err(_) => false,
                        };
                        let satisfied = if !satisfied {
                            let retry_res = self
                                .client
                                .wait_terminal_tui_idle(&handle, Duration::from_secs(120))
                                .await;
                            match retry_res {
                                Ok(resp) => resp
                                    .result
                                    .and_then(|r| r.wait)
                                    .map(|w| w.satisfied)
                                    .unwrap_or(false),
                                Err(_) => false,
                            }
                        } else {
                            true
                        };
                        if !satisfied {
                            return Err(
                            "RECOVERY_REQUIRED: AGENT_NOT_READY: terminal failed TUI readiness gate"
                                .into(),
                        );
                        }
                        chrono::Utc::now().timestamp_millis()
                    };
                (handle, ready_at)
            }
            count => {
                return Err(format!(
                    "RECOVERY_REQUIRED: multiple terminals ({count}) found with title '{expected_title}' in worktree '{}'",
                    worktree.id
                ));
            }
        };

        let orca_version = match self.client.status().await {
            Ok(resp) => resp
                .result
                .and_then(|r| r.runtime.app_version)
                .unwrap_or_else(|| "unknown".into()),
            Err(_) => "unknown".into(),
        };

        Ok(crate::scheduler::PreparedExecution {
            orca_version,
            worktree_id: worktree.id,
            terminal_id: terminal_handle,
            agent_id: executor.agent_id.clone(),
            agent_ready_at_ms: ready_at,
        })
    }

    async fn reconcile_dispatch(
        &self,
        attempt: &ActiveAttempt,
        _terminal_id: &str,
    ) -> Result<DispatchReconciliation, String> {
        let send_count = attempt
            .executor
            .as_ref()
            .map(|e| e.dispatch_send_count)
            .unwrap_or(0);

        if send_count == 0 {
            return Ok(DispatchReconciliation::DefinitelyNotDispatched);
        }

        if let Some(req_id) = attempt
            .executor
            .as_ref()
            .and_then(|e| e.dispatch_request_id.as_ref())
        {
            let stage = attempt
                .executor
                .as_ref()
                .and_then(|e| e.dispatch_stage)
                .unwrap_or(crate::scheduler::DispatchStage::InputAccepted);
            return Ok(DispatchReconciliation::Accepted {
                request_id: req_id.clone(),
                stage,
            });
        }

        let last_outcome = attempt
            .executor
            .as_ref()
            .and_then(|e| e.last_dispatch_outcome.as_deref());

        if last_outcome == Some("known_rejected") {
            return Ok(DispatchReconciliation::DefinitelyNotDispatched);
        }

        Ok(DispatchReconciliation::Ambiguous)
    }

    async fn dispatch(
        &self,
        attempt: &ActiveAttempt,
        terminal_id: &str,
        retry_request_id: Option<&str>,
    ) -> Result<DispatchOutcome, String> {
        // Build one deterministic Agent input from prompt and acceptance criteria
        let prompt_text = match (&attempt.prompt, &attempt.acceptance) {
            (Some(p), Some(a)) => format!("TASK\n\n{p}\n\nACCEPTANCE CRITERIA\n\n{a}"),
            (Some(p), None) => format!("TASK\n\n{p}"),
            (None, Some(a)) => format!("ACCEPTANCE CRITERIA\n\n{a}"),
            (None, None) => "".into(),
        };

        match self
            .client
            .send_terminal_prompt(terminal_id, &prompt_text, retry_request_id, Some(10))
            .await
        {
            Ok(resp) if resp.ok => {
                if let Some(send) = resp.result.and_then(|r| r.send) {
                    if send.accepted {
                        if let Some(p) = send.prompt {
                            if let Some(req_id) = p.request_id {
                                let has_turn_started = p
                                    .stages
                                    .as_ref()
                                    .map(|s| s.iter().any(|st| st == "turn_started"))
                                    .unwrap_or(false);
                                let stage = if has_turn_started {
                                    crate::scheduler::DispatchStage::TurnStarted
                                } else {
                                    crate::scheduler::DispatchStage::InputAccepted
                                };
                                return Ok(DispatchOutcome::Accepted {
                                    request_id: req_id,
                                    accepted_at_ms: chrono::Utc::now().timestamp_millis(),
                                    stage,
                                });
                            }
                        }
                        return Ok(DispatchOutcome::AmbiguousTransportFailure {
                            error:
                                "terminal send reported accepted=true but request_id was missing"
                                    .into(),
                        });
                    } else {
                        return Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                            reason: "terminal send rejected before acceptance (accepted=false)"
                                .into(),
                        });
                    }
                }
                Ok(DispatchOutcome::AmbiguousTransportFailure {
                    error: "terminal send returned ok=true but missing send payload".into(),
                })
            }
            Ok(resp) => Ok(DispatchOutcome::AmbiguousTransportFailure {
                error: format!("terminal send returned ok=false: {resp:?}"),
            }),
            Err(OrcaError::Timeout(d)) => Ok(DispatchOutcome::AmbiguousTransportFailure {
                error: format!("timeout after {d:?}"),
            }),
            Err(OrcaError::CommandFailed { ref stderr, code }) => {
                if stderr.contains("rejected_before_acceptance")
                    || stderr.contains("terminal_not_accepting_input")
                {
                    Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                        reason: format!("structured pre-acceptance rejection: {stderr}"),
                    })
                } else {
                    Ok(DispatchOutcome::AmbiguousTransportFailure {
                        error: format!("CLI command failed with code {code:?}: {stderr}"),
                    })
                }
            }
            Err(OrcaError::Orca(ref msg))
                if msg.contains("rejected_before_acceptance")
                    || msg.contains("terminal_not_accepting_input") =>
            {
                Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                    reason: msg.clone(),
                })
            }
            Err(e) => Ok(DispatchOutcome::AmbiguousTransportFailure {
                error: e.to_string(),
            }),
        }
    }

    async fn wait(
        &self,
        _attempt: &ActiveAttempt,
        terminal_id: &str,
        remaining_timeout: Duration,
    ) -> Result<WaitOutcome, String> {
        match self
            .client
            .wait_terminal_tui_idle(terminal_id, remaining_timeout)
            .await
        {
            Ok(resp) => {
                if let Some(wait) = resp.result.as_ref().and_then(|r| r.wait.as_ref()) {
                    if wait.condition.as_deref() == Some("tui-idle") || wait.condition.is_none() {
                        if wait.satisfied {
                            return Ok(WaitOutcome::TuiIdle {
                                elapsed_ms: wait.elapsed_ms.unwrap_or(0),
                            });
                        } else {
                            return Ok(WaitOutcome::TimedOut {
                                elapsed_ms: wait
                                    .elapsed_ms
                                    .unwrap_or(remaining_timeout.as_millis() as u64),
                            });
                        }
                    }
                }
                if !resp.ok {
                    return Err(format!("Terminal wait reported ok=false: {resp:?}"));
                }
                Err("Terminal wait returned unexpected result format".into())
            }
            Err(OrcaError::Timeout(_)) => Ok(WaitOutcome::TimedOut {
                elapsed_ms: remaining_timeout.as_millis() as u64,
            }),
            Err(OrcaError::Orca(ref msg)) => {
                if msg.contains("terminal_not_found")
                    || msg.contains("terminal_exited")
                    || msg.contains("terminal_closed")
                    || msg.contains("no such terminal")
                {
                    Ok(WaitOutcome::Interrupted {
                        reason: msg.clone(),
                    })
                } else if msg.contains("timed_out") || msg.contains("timeout") {
                    Ok(WaitOutcome::TimedOut {
                        elapsed_ms: remaining_timeout.as_millis() as u64,
                    })
                } else {
                    Err(format!("Terminal wait failed: {msg}"))
                }
            }
            Err(OrcaError::CommandFailed { ref stderr, code }) => {
                if stderr.contains("terminal_not_found")
                    || stderr.contains("terminal_exited")
                    || stderr.contains("terminal_closed")
                    || stderr.contains("no such terminal")
                {
                    Ok(WaitOutcome::Interrupted {
                        reason: format!("terminal exited/not found (exit {code:?}): {stderr}"),
                    })
                } else {
                    Err(format!("Terminal wait failed with code {code:?}: {stderr}"))
                }
            }
            Err(e) => Err(format!("Terminal wait transport failure: {e}")),
        }
    }

    async fn close(&self, terminal_id: &str) -> Result<(), String> {
        match self.client.close_terminal(terminal_id).await {
            Ok(resp) => {
                if let Some(close_part) = resp.result.and_then(|r| r.close) {
                    if let Some(ref verdict) = close_part.pty_stop_verdict {
                        if verdict == "live" || verdict == "unverifiable" {
                            return Err(format!(
                                "terminal close rejected: pty_stop_verdict was '{verdict}'"
                            ));
                        }
                    }
                }
            }
            Err(OrcaError::Orca(ref msg))
                if msg.contains("not_found") || msg.contains("no such terminal") =>
            {
                // Terminal already closed/absent
            }
            Err(OrcaError::CommandFailed { ref stderr, .. })
                if stderr.contains("not_found") || stderr.contains("no such terminal") =>
            {
                // Terminal already closed/absent
            }
            Err(e) => return Err(format!("terminal close failed: {e}")),
        }

        // Post-close verification: list terminals, verify handle is absent
        if let Ok(terminals) = self.client.list_terminals(None).await {
            if terminals.iter().any(|t| t.handle == terminal_id) {
                return Err(format!(
                    "terminal cleanup verification failed: terminal '{terminal_id}' still present after close"
                ));
            }
        }
        Ok(())
    }
}
