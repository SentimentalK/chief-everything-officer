use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;

use super::client::{OrcaCliClient, OrcaError};
use super::types::OrcaWorktreeItem;
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
    ) -> Result<(String, String), String> {
        // 1. Worktree reconciliation
        let worktrees = self
            .client
            .list_worktrees()
            .await
            .map_err(|e| format!("failed to list worktrees: {e}"))?;

        let target_canonical = std::fs::canonicalize(&target.local_path).ok();
        let matching_worktrees: Vec<&OrcaWorktreeItem> = worktrees
            .iter()
            .filter(|wt| {
                if wt.path == target.local_path {
                    return true;
                }
                if let Some(ref c) = target_canonical {
                    if let Ok(wt_c) = std::fs::canonicalize(&wt.path) {
                        return wt_c == *c;
                    }
                }
                false
            })
            .collect();

        let adopted_worktree = match matching_worktrees.len() {
            0 => {
                // 0 -> create worktree -> validate returned path matches configured Target
                let attempt_name = format!("ceo-{}", attempt.attempt_id);
                let created = self
                    .client
                    .create_worktree(&attempt_name, &format!("path:{}", target.local_path))
                    .await
                    .map_err(|e| format!("failed to create worktree for target: {e}"))?;

                let created_canonical = std::fs::canonicalize(&created.path).ok();
                let path_matches = created.path == target.local_path
                    || (target_canonical.is_some() && created_canonical == target_canonical);
                if !path_matches {
                    return Err(format!(
                        "RECOVERY_REQUIRED: created worktree path '{}' does not match target path '{}'",
                        created.path, target.local_path
                    ));
                }
                created.id
            }
            1 => matching_worktrees[0].id.clone(),
            count => {
                // >1 -> use explicitly durable/deterministic Attempt-owned identity if available, otherwise RECOVERY_REQUIRED
                if let Some(owned_wt_id) = attempt
                    .executor
                    .as_ref()
                    .and_then(|e| e.worktree_id.as_deref())
                {
                    if let Some(matched) = matching_worktrees.iter().find(|wt| wt.id == owned_wt_id)
                    {
                        matched.id.clone()
                    } else {
                        return Err(format!(
                            "RECOVERY_REQUIRED: multiple worktrees ({count}) match target '{}', and attempt-owned worktree '{owned_wt_id}' is not among them",
                            target.local_path
                        ));
                    }
                } else {
                    return Err(format!(
                        "RECOVERY_REQUIRED: multiple worktrees ({count}) match target '{}'; ambiguous candidates cannot be adopted",
                        target.local_path
                    ));
                }
            }
        };

        // 2. Terminal reconciliation on title `ceo:<attempt_id>`, scoped to adopted_worktree
        let expected_title = format!("ceo:{}", attempt.attempt_id);
        let terminals = self
            .client
            .list_terminals(Some(&adopted_worktree))
            .await
            .map_err(|e| {
                format!("failed to list terminals for worktree '{adopted_worktree}': {e}")
            })?;

        let matching_terminals: Vec<_> = terminals
            .into_iter()
            .filter(|t| {
                t.title.as_deref() == Some(&expected_title)
                    && t.worktree_id
                        .as_deref()
                        .map(|w| w == adopted_worktree)
                        .unwrap_or(true)
            })
            .collect();

        let terminal_handle = match matching_terminals.len() {
            0 => {
                let term = self
                    .client
                    .create_terminal(
                        &adopted_worktree,
                        &expected_title,
                        None,
                        Some(Path::new(&target.local_path)),
                    )
                    .await
                    .map_err(|e| format!("failed to create terminal for attempt: {e}"))?;
                term.handle
            }
            1 => matching_terminals.into_iter().next().unwrap().handle,
            count => {
                return Err(format!(
                    "RECOVERY_REQUIRED: multiple terminals ({count}) found with title '{expected_title}' in worktree '{adopted_worktree}'"
                ));
            }
        };

        Ok((adopted_worktree, terminal_handle))
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
                    if wait.condition == "tui-idle" {
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
        let _ = self.client.close_terminal(terminal_id).await;
        Ok(())
    }
}
