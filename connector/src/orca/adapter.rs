use std::time::Duration;

use async_trait::async_trait;

use super::client::{OrcaCliClient, OrcaError};
use crate::config::LocalTarget;
use crate::scheduler::{
    ActiveAttempt, CleanupOutcome, DispatchOutcome, DispatchReconciliation, ExecutionAdapter,
    PrepareOutcome, PreparedExecution, PreparedExecutionIdentity, WaitOutcome,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidatedWait {
    Satisfied { elapsed_ms: u64 },
    Unsatisfied { elapsed_ms: u64 },
}

pub fn validate_tui_idle_wait(
    expected_terminal: &str,
    response: &crate::orca::types::OrcaTerminalWaitResponse,
) -> Result<ValidatedWait, String> {
    if !response.ok {
        return Err("ORCA_PROTOCOL_MISMATCH: wait response ok is false".into());
    }
    let res = response.result.as_ref().ok_or_else(|| {
        "ORCA_PROTOCOL_MISMATCH: wait response missing result payload".to_string()
    })?;
    let wait = res
        .wait
        .as_ref()
        .ok_or_else(|| "ORCA_PROTOCOL_MISMATCH: wait response missing wait payload".to_string())?;
    let handle = wait
        .handle
        .as_deref()
        .ok_or_else(|| "ORCA_PROTOCOL_MISMATCH: wait payload missing handle".to_string())?;
    if handle != expected_terminal {
        return Err(format!(
            "ORCA_PROTOCOL_MISMATCH: wait handle mismatch: expected '{expected_terminal}', got '{handle}'"
        ));
    }
    let condition = wait
        .condition
        .as_deref()
        .ok_or_else(|| "ORCA_PROTOCOL_MISMATCH: wait payload missing condition".to_string())?;
    if condition != "tui-idle" {
        return Err(format!(
            "ORCA_PROTOCOL_MISMATCH: wait condition mismatch: expected 'tui-idle', got '{condition}'"
        ));
    }
    let elapsed = wait.elapsed_ms.unwrap_or(0);
    if wait.satisfied {
        Ok(ValidatedWait::Satisfied {
            elapsed_ms: elapsed,
        })
    } else {
        Ok(ValidatedWait::Unsatisfied {
            elapsed_ms: elapsed,
        })
    }
}

impl OrcaExecutionAdapter {
    pub fn new(client: OrcaCliClient) -> Self {
        Self { client }
    }

    async fn run_readiness_gate(&self, terminal_handle: &str) -> Result<i64, ReadinessError> {
        let is_timeout = |err: &OrcaError| -> bool {
            match err {
                OrcaError::Timeout(_) => true,
                OrcaError::Orca { code, message, .. } => {
                    code == "timeout"
                        || code == "timed_out"
                        || message.contains("timed_out")
                        || message.contains("timeout")
                }
                _ => false,
            }
        };

        let wait_res = self
            .client
            .wait_terminal_tui_idle(terminal_handle, Duration::from_secs(60))
            .await;
        match wait_res {
            Ok(resp) => match validate_tui_idle_wait(terminal_handle, &resp) {
                Ok(ValidatedWait::Satisfied { .. }) => Ok(chrono::Utc::now().timestamp_millis()),
                Ok(ValidatedWait::Unsatisfied { .. }) => Err(ReadinessError::NotReady(
                    "AGENT_NOT_READY: terminal failed TUI readiness gate".into(),
                )),
                Err(e) => Err(ReadinessError::ProtocolMismatch(e)),
            },
            Err(ref e) if is_timeout(e) => Err(ReadinessError::NotReady(
                "AGENT_NOT_READY: terminal readiness timed out".into(),
            )),
            Err(e) => Err(ReadinessError::Retryable(format!(
                "readiness check failed: {e}"
            ))),
        }
    }
}

enum ReadinessError {
    NotReady(String),
    Retryable(String),
    ProtocolMismatch(String),
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
    ) -> Result<PrepareOutcome, String> {
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

        let orca_version = match self.client.status().await {
            Ok(resp) => resp
                .result
                .and_then(|r| r.runtime.app_version)
                .unwrap_or_else(|| "unknown".into()),
            Err(_) => "unknown".into(),
        };

        // 2. Terminal reconciliation on title `ceo:<attempt_id>`, scoped to resolved worktree
        let term_list_res = self
            .client
            .list_terminals_result(Some(&worktree.id))
            .await
            .map_err(|e| {
                format!(
                    "failed to list terminals for worktree '{}': {e}",
                    worktree.id
                )
            })?;

        if term_list_res.truncated {
            return Ok(PrepareOutcome::RecoveryRequired {
                execution: None,
                reason: "TERMINAL_LIST_TRUNCATED: terminal list was truncated by Orca".into(),
            });
        }

        let (terminal_handle, ready_at) = if let Some(existing_tid) = attempt
            .executor
            .as_ref()
            .and_then(|e| e.terminal_id.as_ref())
        {
            match self.client.show_terminal(existing_tid).await {
                Ok(Some(term)) => {
                    let identity = PreparedExecutionIdentity {
                        orca_version: orca_version.clone(),
                        worktree_id: worktree.id.clone(),
                        terminal_id: existing_tid.clone(),
                        agent_id: executor.agent_id.clone(),
                    };
                    if term.worktree_id.as_deref() != Some(&worktree.id) {
                        return Ok(PrepareOutcome::RecoveryRequired {
                            execution: Some(identity),
                            reason: format!(
                                "recorded terminal '{}' belongs to worktree '{:?}', expected '{}'",
                                existing_tid, term.worktree_id, worktree.id
                            ),
                        });
                    }
                    let ready_at = if let Some(ts) =
                        attempt.executor.as_ref().and_then(|e| e.agent_ready_at_ms)
                    {
                        ts
                    } else {
                        match self.run_readiness_gate(existing_tid).await {
                            Ok(ts) => ts,
                            Err(ReadinessError::ProtocolMismatch(r)) => {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: Some(identity),
                                    reason: r,
                                });
                            }
                            Err(ReadinessError::NotReady(r)) => {
                                return Ok(PrepareOutcome::NotReady {
                                    execution: identity,
                                    reason: r,
                                });
                            }
                            Err(ReadinessError::Retryable(r)) => {
                                return Ok(PrepareOutcome::Retryable {
                                    execution: Some(identity),
                                    reason: r,
                                });
                            }
                        }
                    };
                    (existing_tid.clone(), ready_at)
                }
                Ok(None) => {
                    return Ok(PrepareOutcome::RecoveryRequired {
                        execution: None,
                        reason: format!(
                            "previously recorded terminal '{existing_tid}' not found in Orca"
                        ),
                    });
                }
                Err(OrcaError::Orca {
                    ref code,
                    ref message,
                    ..
                }) if code == "terminal_handle_stale" => {
                    return Ok(PrepareOutcome::RecoveryRequired {
                        execution: None,
                        reason: format!(
                            "previously recorded terminal '{existing_tid}' handle is stale: {message}"
                        ),
                    });
                }
                Err(e) => {
                    return Ok(PrepareOutcome::Retryable {
                        execution: None,
                        reason: format!("failed to inspect existing terminal: {e}"),
                    });
                }
            }
        } else {
            let expected_title = format!("ceo:{}", attempt.attempt_id);
            let matching_terminals: Vec<_> = term_list_res
                .terminals
                .into_iter()
                .filter(|t| {
                    t.title.as_deref() == Some(&expected_title)
                        && t.worktree_id
                            .as_deref()
                            .map(|w| w == worktree.id)
                            .unwrap_or(true)
                })
                .collect();

            match matching_terminals.len() {
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

                    let identity = PreparedExecutionIdentity {
                        orca_version: orca_version.clone(),
                        worktree_id: worktree.id.clone(),
                        terminal_id: term.handle.clone(),
                        agent_id: executor.agent_id.clone(),
                    };

                    let ready_at = match self.run_readiness_gate(&term.handle).await {
                        Ok(ts) => ts,
                        Err(ReadinessError::ProtocolMismatch(r)) => {
                            return Ok(PrepareOutcome::RecoveryRequired {
                                execution: Some(identity),
                                reason: r,
                            });
                        }
                        Err(ReadinessError::NotReady(r)) => {
                            return Ok(PrepareOutcome::NotReady {
                                execution: identity,
                                reason: r,
                            });
                        }
                        Err(ReadinessError::Retryable(r)) => {
                            return Ok(PrepareOutcome::Retryable {
                                execution: Some(identity),
                                reason: r,
                            });
                        }
                    };
                    (term.handle, ready_at)
                }
                1 => {
                    let handle = matching_terminals.into_iter().next().unwrap().handle;
                    let identity = PreparedExecutionIdentity {
                        orca_version: orca_version.clone(),
                        worktree_id: worktree.id.clone(),
                        terminal_id: handle.clone(),
                        agent_id: executor.agent_id.clone(),
                    };
                    let ready_at = if let Some(ts) =
                        attempt.executor.as_ref().and_then(|e| e.agent_ready_at_ms)
                    {
                        ts
                    } else {
                        match self.run_readiness_gate(&handle).await {
                            Ok(ts) => ts,
                            Err(ReadinessError::ProtocolMismatch(r)) => {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: Some(identity),
                                    reason: r,
                                });
                            }
                            Err(ReadinessError::NotReady(r)) => {
                                return Ok(PrepareOutcome::NotReady {
                                    execution: identity,
                                    reason: r,
                                });
                            }
                            Err(ReadinessError::Retryable(r)) => {
                                return Ok(PrepareOutcome::Retryable {
                                    execution: Some(identity),
                                    reason: r,
                                });
                            }
                        }
                    };
                    (handle, ready_at)
                }
                count => {
                    return Ok(PrepareOutcome::RecoveryRequired {
                        execution: None,
                        reason: format!(
                            "multiple terminals ({count}) found with title '{expected_title}' in worktree '{}'",
                            worktree.id
                        ),
                    });
                }
            }
        };

        Ok(PrepareOutcome::Ready(PreparedExecution {
            orca_version,
            worktree_id: worktree.id,
            terminal_id: terminal_handle,
            agent_id: executor.agent_id.clone(),
            agent_ready_at_ms: ready_at,
        }))
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
            return Ok(DispatchReconciliation::Accepted {
                request_id: req_id.clone(),
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
            .send_terminal_prompt(terminal_id, &prompt_text, None, Some(10))
            .await
        {
            Ok(resp) => {
                if let Some(send) = resp.result.and_then(|r| r.send) {
                    if send.handle != terminal_id {
                        return Ok(DispatchOutcome::RecoveryRequired {
                            code: "DISPATCH_TERMINAL_CORRELATION_MISMATCH".into(),
                            message: format!(
                                "send response handle '{}' did not match expected terminal '{terminal_id}'",
                                send.handle
                            ),
                        });
                    }
                    if send.accepted {
                        if let Some(p) = send.prompt {
                            if let Some(req_id) = p.request_id {
                                return Ok(DispatchOutcome::Accepted {
                                    request_id: req_id,
                                    accepted_at_ms: chrono::Utc::now().timestamp_millis(),
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
            Err(OrcaError::Orca {
                ref code,
                ref message,
                ..
            }) => {
                if code == "rejected_before_acceptance"
                    || code == "terminal_not_accepting_input"
                    || message.contains("rejected_before_acceptance")
                    || message.contains("terminal_not_accepting_input")
                {
                    Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                        reason: format!("{code}: {message}"),
                    })
                } else {
                    Ok(DispatchOutcome::AmbiguousTransportFailure {
                        error: format!("{code}: {message}"),
                    })
                }
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
            Ok(resp) => match validate_tui_idle_wait(terminal_id, &resp) {
                Ok(ValidatedWait::Satisfied { elapsed_ms }) => {
                    Ok(WaitOutcome::TuiIdle { elapsed_ms })
                }
                Ok(ValidatedWait::Unsatisfied { elapsed_ms }) => {
                    Ok(WaitOutcome::TimedOut { elapsed_ms })
                }
                Err(e) => Err(e),
            },
            Err(OrcaError::Timeout(_)) => Ok(WaitOutcome::TimedOut {
                elapsed_ms: remaining_timeout.as_millis() as u64,
            }),
            Err(OrcaError::Orca {
                ref code,
                ref message,
                ..
            }) => {
                if code == "terminal_not_found"
                    || code == "terminal_exited"
                    || code == "terminal_closed"
                    || code == "terminal_handle_stale"
                    || message.contains("terminal_not_found")
                    || message.contains("terminal_exited")
                    || message.contains("terminal_closed")
                    || message.contains("no such terminal")
                {
                    Ok(WaitOutcome::Interrupted {
                        reason: format!("{code}: {message}"),
                    })
                } else if code == "timed_out"
                    || code == "timeout"
                    || message.contains("timed_out")
                    || message.contains("timeout")
                {
                    Ok(WaitOutcome::TimedOut {
                        elapsed_ms: remaining_timeout.as_millis() as u64,
                    })
                } else {
                    Err(format!("Terminal wait failed: {code}: {message}"))
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

    async fn close(&self, terminal_id: &str) -> CleanupOutcome {
        let close_res = self.client.close_terminal(terminal_id).await;
        match close_res {
            Ok(resp) => {
                let close_part = match resp.result.and_then(|r| r.close) {
                    Some(part) => part,
                    None => {
                        return CleanupOutcome::RecoveryRequired {
                            code: "TERMINAL_CLOSE_PAYLOAD_MISSING".into(),
                            message: "terminal close returned ok=true but missing close payload"
                                .into(),
                        };
                    }
                };
                if close_part.handle != terminal_id {
                    return CleanupOutcome::RecoveryRequired {
                        code: "TERMINAL_CLOSE_CORRELATION_MISMATCH".into(),
                        message: format!(
                            "close handle mismatch: expected '{terminal_id}', got '{}'",
                            close_part.handle
                        ),
                    };
                }
                if close_part.pty_killed != Some(true) {
                    return CleanupOutcome::RecoveryRequired {
                        code: "TERMINAL_STOP_UNVERIFIABLE".into(),
                        message: format!(
                            "terminal close returned pty_killed={:?}, expected Some(true)",
                            close_part.pty_killed
                        ),
                    };
                }
            }
            Err(OrcaError::Orca {
                ref code,
                ref message,
                ..
            }) => {
                if code == "terminal_not_found" {
                    match self.client.list_terminals_result(None).await {
                        Ok(res) => {
                            if res.truncated {
                                return CleanupOutcome::RecoveryRequired {
                                    code: "TERMINAL_LIST_TRUNCATED".into(),
                                    message: "terminal inventory was truncated by Orca".into(),
                                };
                            }
                            if res.terminals.iter().any(|t| t.handle == terminal_id) {
                                return CleanupOutcome::Retryable {
                                    reason: format!(
                                        "terminal close reported terminal_not_found but '{terminal_id}' still present in inventory"
                                    ),
                                };
                            }
                            return CleanupOutcome::AlreadyAbsent {
                                verified_at_ms: chrono::Utc::now().timestamp_millis(),
                            };
                        }
                        Err(e) => {
                            return CleanupOutcome::Retryable {
                                reason: format!("failed to list terminals during AlreadyAbsent verification: {e}"),
                            };
                        }
                    }
                }
                if code == "terminal_handle_stale" {
                    return CleanupOutcome::RecoveryRequired {
                        code: "TERMINAL_HANDLE_STALE".into(),
                        message: format!("terminal close returned stale handle: {message}"),
                    };
                }
                return CleanupOutcome::Retryable {
                    reason: format!("terminal close failed: {code}: {message}"),
                };
            }
            Err(OrcaError::Timeout(_)) => {
                return CleanupOutcome::Retryable {
                    reason: "terminal close timed out".into(),
                };
            }
            Err(e) => {
                return CleanupOutcome::Retryable {
                    reason: format!("terminal close transport error: {e}"),
                };
            }
        }

        // Post-close verification:
        // Check active terminals in inventory
        match self.client.list_terminals_result(None).await {
            Ok(res) => {
                if res.truncated {
                    return CleanupOutcome::RecoveryRequired {
                        code: "TERMINAL_LIST_TRUNCATED".into(),
                        message: "terminal inventory was truncated by Orca".into(),
                    };
                }
                if res.terminals.iter().any(|t| t.handle == terminal_id) {
                    return CleanupOutcome::Retryable {
                        reason: format!(
                            "terminal '{terminal_id}' still present in active inventory after close"
                        ),
                    };
                }
            }
            Err(e) => {
                return CleanupOutcome::Retryable {
                    reason: format!("failed to list terminals during cleanup verification: {e}"),
                };
            }
        }

        CleanupOutcome::VerifiedClosed {
            closed_at_ms: chrono::Utc::now().timestamp_millis(),
        }
    }
}
