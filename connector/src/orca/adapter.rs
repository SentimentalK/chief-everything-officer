use async_trait::async_trait;
use std::path::Path;
use std::time::Duration;

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
    ) -> Result<(String, String), String> {
        // 1. Resolve worktree selector
        let worktrees = self
            .client
            .list_worktrees()
            .await
            .map_err(|e| format!("failed to list worktrees: {e}"))?;

        let target_canonical = std::fs::canonicalize(&target.local_path).ok();
        let matched_wt = worktrees.iter().find(|wt| {
            if wt.path == target.local_path {
                return true;
            }
            if let Some(ref c) = target_canonical {
                if let Ok(wt_c) = std::fs::canonicalize(&wt.path) {
                    return wt_c == *c;
                }
            }
            false
        });

        let wt_selector = match matched_wt {
            Some(wt) => wt.id.clone(),
            None => format!("path:{}", target.local_path),
        };

        // 2. Terminal reconciliation on title `ceo:<attempt_id>`
        let expected_title = format!("ceo:{}", attempt.attempt_id);
        let terminals = self
            .client
            .list_terminals(None)
            .await
            .map_err(|e| format!("failed to list terminals: {e}"))?;

        let matching_terminals: Vec<_> = terminals
            .into_iter()
            .filter(|t| t.title.as_deref() == Some(&expected_title))
            .collect();

        match matching_terminals.len() {
            0 => {
                let term = self
                    .client
                    .create_terminal(
                        &wt_selector,
                        &expected_title,
                        None,
                        Some(Path::new(&target.local_path)),
                    )
                    .await
                    .map_err(|e| format!("failed to create terminal for attempt: {e}"))?;
                Ok((wt_selector, term.handle))
            }
            1 => {
                let existing = &matching_terminals[0];
                Ok((wt_selector, existing.handle.clone()))
            }
            count => Err(format!(
                "Multiple terminals ({count}) found with title '{expected_title}': RECOVERY_REQUIRED"
            )),
        }
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

        Ok(DispatchReconciliation::Ambiguous)
    }

    async fn dispatch(
        &self,
        attempt: &ActiveAttempt,
        terminal_id: &str,
        retry_request_id: Option<&str>,
    ) -> Result<DispatchOutcome, String> {
        let prompt = attempt.prompt.as_deref().unwrap_or("");
        match self
            .client
            .send_terminal_prompt(terminal_id, prompt, retry_request_id, Some(10))
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
                    }
                }
                Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                    reason: "send returned accepted=false or missing request_id".into(),
                })
            }
            Ok(_) => Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                reason: "send returned ok=false".into(),
            }),
            Err(OrcaError::Timeout(d)) => Ok(DispatchOutcome::AmbiguousTransportFailure {
                error: format!("timeout after {d:?}"),
            }),
            Err(OrcaError::CommandFailed { code, stderr }) => {
                Ok(DispatchOutcome::KnownRejectedBeforeAcceptance {
                    reason: format!("command failed with code {code:?}: {stderr}"),
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
                if let Some(wait) = resp.result.and_then(|r| r.wait) {
                    if wait.satisfied && wait.condition == "tui-idle" {
                        return Ok(WaitOutcome::TuiIdle {
                            elapsed_ms: wait.elapsed_ms.unwrap_or(0),
                        });
                    }
                }
                if !resp.ok {
                    return Ok(WaitOutcome::TimedOut {
                        elapsed_ms: remaining_timeout.as_millis() as u64,
                    });
                }
                Ok(WaitOutcome::Interrupted {
                    reason: "wait condition not satisfied".into(),
                })
            }
            Err(OrcaError::Timeout(_)) => Ok(WaitOutcome::TimedOut {
                elapsed_ms: remaining_timeout.as_millis() as u64,
            }),
            Err(OrcaError::Orca(ref msg)) if msg.to_lowercase().contains("timeout") => {
                Ok(WaitOutcome::TimedOut {
                    elapsed_ms: remaining_timeout.as_millis() as u64,
                })
            }
            Err(e) => Ok(WaitOutcome::Interrupted {
                reason: e.to_string(),
            }),
        }
    }

    async fn close(&self, terminal_id: &str) -> Result<(), String> {
        let _ = self.client.close_terminal(terminal_id).await;
        Ok(())
    }
}
