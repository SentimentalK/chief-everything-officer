use std::time::Duration;

use async_trait::async_trait;

use super::client::{OrcaCliClient, OrcaError};
use super::types::{
    OrcaRunCreateResult, OrcaRunItem, OrcaTerminalItem, OrcaWorkerStartResult, TerminalLiveness,
};
use crate::config::LocalTarget;
use crate::scheduler::{
    ActiveAttempt, CleanupOutcome, DispatchOutcome, DispatchReconciliation, ExecutionAdapter,
    InterruptOutcome, PrepareOutcome, PreparedExecution, PreparedExecutionIdentity, WaitOutcome,
};

#[derive(Clone, Debug)]
pub struct OrcaExecutionAdapter {
    pub client: OrcaCliClient,
    pub paths: Option<crate::paths::ConnectorPaths>,
}

impl Default for OrcaExecutionAdapter {
    fn default() -> Self {
        Self::new(OrcaCliClient::default())
    }
}

/// Derives a stable, deterministic per-Attempt mutation identity (UUID v5 format)
/// for orchestration mutations (e.g. "run-create", "worker-start").
/// Retries/restarts of the same Attempt reuse the same identity; different mutation kinds
/// never share the same UUID.
pub fn derive_mutation_request_id(mutation_kind: &str, attempt_id: &str) -> uuid::Uuid {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(b"ceo:orca:mutation:");
    hasher.update(mutation_kind.as_bytes());
    hasher.update(b":");
    hasher.update(attempt_id.as_bytes());
    let hash = hasher.finalize();
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    // Set RFC 4122 variant (bits 6-7 of byte 8 to 10)
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    // Set RFC 4122 version 5 (bits 4-7 of byte 6 to 0101)
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    uuid::Uuid::from_bytes(bytes)
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

pub const ADVISORY_READINESS_TIMEOUT: Duration = Duration::from_secs(5);

/// Positive turn-start evidence from an Orca terminal-send response payload.
///
/// Only an explicit `turn_started` stage reported by Orca counts as proof
/// that the dispatched turn began. `observation`/`provider` values of
/// "unsupported" mean Orca lacks observability for this agent; they are the
/// ABSENCE of evidence and must never be promoted into positive proof that
/// the turn started. A pre-turn tui-idle observed while no positive turn-start
/// evidence exists must keep waiting (never terminalize the attempt).
pub fn send_prompt_turn_started(prompt: &super::types::OrcaSendPromptPart) -> bool {
    prompt
        .stages
        .as_ref()
        .map(|s| s.iter().any(|st| st == "turn_started"))
        .unwrap_or(false)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CoordinatorRecord {
    pub schema_version: u32,
    pub terminal_handle: String,
    pub title: String,
    pub worktree_id: String,
    pub created_at_ms: i64,
}

impl OrcaExecutionAdapter {
    pub fn new(client: OrcaCliClient) -> Self {
        Self {
            client,
            paths: crate::paths::ConnectorPaths::resolve().ok(),
        }
    }

    pub fn with_paths(mut self, paths: crate::paths::ConnectorPaths) -> Self {
        self.paths = Some(paths);
        self
    }

    pub async fn resolve_coordinator_anchor_worktree(&self, fallback_worktree_id: &str) -> String {
        if let Ok(worktrees) = self.client.list_worktrees().await {
            for wt in worktrees {
                if wt.path.ends_with(crate::setup::AGENT_RUNTIME_TARGET_ALIAS)
                    || wt.display_name.as_deref() == Some(crate::setup::AGENT_RUNTIME_TARGET_ALIAS)
                {
                    return wt.id;
                }
            }
        }
        fallback_worktree_id.to_string()
    }

    pub async fn ensure_coordinator_terminal(
        &self,
        anchor_worktree_id: &str,
        device_id: &str,
    ) -> Result<String, String> {
        let is_device_specific = !device_id.trim().is_empty();
        let coordinator_title = if is_device_specific {
            format!("ceo:coordinator:{}", device_id.trim())
        } else {
            "ceo:coordinator".to_string()
        };

        // 1. Try durable record from coordinator_file if available
        if let Some(ref paths) = self.paths {
            let coord_file = paths.coordinator_file();
            if coord_file.is_file() {
                if let Ok(content) = std::fs::read_to_string(&coord_file) {
                    if let Ok(record) = serde_json::from_str::<CoordinatorRecord>(&content) {
                        let record_matches = if is_device_specific {
                            record.title == coordinator_title
                        } else {
                            record.title == coordinator_title || record.title == "ceo:coordinator"
                        };
                        if record_matches {
                            if let Ok(Some(term)) =
                                self.client.show_terminal(&record.terminal_handle).await
                            {
                                if term.liveness() == TerminalLiveness::Live {
                                    return Ok(record.terminal_handle);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 2. Scan live terminals in Orca for an existing live coordinator
        if let Ok(terms) = self.client.list_terminals(None).await {
            for term in terms {
                let matches_title = if is_device_specific {
                    term.title.as_deref() == Some(&coordinator_title)
                } else {
                    term.title.as_deref() == Some(&coordinator_title)
                        || term.title.as_deref() == Some("ceo:coordinator")
                };
                if matches_title && term.liveness() == TerminalLiveness::Live {
                    self.save_coordinator_record(
                        &term.handle,
                        &coordinator_title,
                        term.worktree_id.as_deref().unwrap_or(anchor_worktree_id),
                    );
                    return Ok(term.handle);
                }
            }
        }

        // 3. Create fresh coordinator terminal on anchor worktree
        let created = self
            .client
            .create_terminal(anchor_worktree_id, &coordinator_title, None, None)
            .await
            .map_err(|e| format!("failed to create coordinator terminal: {e}"))?;

        self.save_coordinator_record(&created.handle, &coordinator_title, anchor_worktree_id);
        Ok(created.handle)
    }

    fn save_coordinator_record(&self, handle: &str, title: &str, worktree_id: &str) {
        if let Some(ref paths) = self.paths {
            let record = CoordinatorRecord {
                schema_version: 1,
                terminal_handle: handle.to_string(),
                title: title.to_string(),
                worktree_id: worktree_id.to_string(),
                created_at_ms: chrono::Utc::now().timestamp_millis(),
            };
            if let Ok(json) = serde_json::to_string_pretty(&record) {
                let _ = std::fs::write(paths.coordinator_file(), json);
            }
        }
    }

    async fn run_readiness_gate(
        &self,
        terminal_handle: &str,
    ) -> Result<Option<i64>, ReadinessError> {
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
            .wait_terminal_tui_idle(terminal_handle, ADVISORY_READINESS_TIMEOUT)
            .await;
        match wait_res {
            Ok(resp) => match validate_tui_idle_wait(terminal_handle, &resp) {
                Ok(ValidatedWait::Satisfied { .. }) => {
                    Ok(Some(chrono::Utc::now().timestamp_millis()))
                }
                Ok(ValidatedWait::Unsatisfied { .. }) => Ok(None),
                Err(e) => Err(ReadinessError::ProtocolMismatch(e)),
            },
            Err(ref e) if is_timeout(e) => Ok(None),
            Err(e) => Err(ReadinessError::Retryable(format!(
                "readiness check failed: {e}"
            ))),
        }
    }
    pub async fn derive_pane_key(&self, terminal_id: &str) -> Option<String> {
        self.client
            .show_terminal(terminal_id)
            .await
            .ok()
            .flatten()
            .as_ref()
            .and_then(pane_key_of)
    }

    async fn validate_worker_terminal(
        &self,
        terminal_handle: &str,
        expected_worktree_id: &str,
    ) -> Result<(), String> {
        match self.client.show_terminal(terminal_handle).await {
            Ok(Some(term)) => {
                if term.worktree_id.as_deref() != Some(expected_worktree_id) {
                    return Err(format!(
                        "recovered worker terminal '{terminal_handle}' belongs to worktree '{:?}', expected '{expected_worktree_id}'; preserving evidence",
                        term.worktree_id
                    ));
                }
                if term.liveness() != TerminalLiveness::Live {
                    return Err(format!(
                        "recovered worker terminal '{terminal_handle}' is not live (liveness: {:?}); preserving evidence",
                        term.liveness()
                    ));
                }
                Ok(())
            }
            Ok(None) => Err(format!(
                "recovered worker terminal '{terminal_handle}' not found in Orca; preserving evidence"
            )),
            Err(e) => Err(format!(
                "failed to inspect recovered worker terminal '{terminal_handle}': {e}; preserving evidence"
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn launch_worker_and_reconcile(
        &self,
        coordinator_handle: &str,
        run_id: &str,
        worktree_id: &str,
        agent_id: &str,
        model_opt: Option<&str>,
        spec: &str,
        worker_retry_id: &str,
    ) -> Result<WorkerStartOutcome, String> {
        match self
            .client
            .worker_start(
                coordinator_handle,
                run_id,
                worktree_id,
                agent_id,
                model_opt,
                spec,
                Some(worker_retry_id),
            )
            .await
        {
            Ok(w) => match w.worker_terminal_handle() {
                Some(h) => Ok(WorkerStartOutcome::Terminal(h)),
                None => Ok(WorkerStartOutcome::Outcome(
                    PrepareOutcome::RecoveryRequired {
                        execution: None,
                        reason: format!(
                            "RECOVERY_REQUIRED: worker-start returned ok=true but no worker terminal handle could be correlated. Result: {:?}",
                            w
                        ),
                    },
                )),
            },
            Err(e) => {
                match self.client.request_show(worker_retry_id).await {
                    Ok(show) if show.is_completed() => {
                        let receipt = match show.receipt {
                            Some(r) => r,
                            None => {
                                return Ok(WorkerStartOutcome::Outcome(
                                    PrepareOutcome::RecoveryRequired {
                                        execution: None,
                                        reason: format!(
                                            "request-show completed for worker-start but missing receipt: {e}; preserving evidence"
                                        ),
                                    },
                                ));
                            }
                        };
                        let handle = match extract_worker_terminal_from_receipt(&receipt) {
                            Some(h) => h,
                            None => {
                                return Ok(WorkerStartOutcome::Outcome(
                                    PrepareOutcome::RecoveryRequired {
                                        execution: None,
                                        reason: format!(
                                            "failed to recover worker terminal from request-show receipt: {e}; preserving evidence"
                                        ),
                                    },
                                ));
                            }
                        };
                        match self.validate_worker_terminal(&handle, worktree_id).await {
                            Ok(()) => Ok(WorkerStartOutcome::Terminal(handle)),
                            Err(reason) => Ok(WorkerStartOutcome::Outcome(
                                PrepareOutcome::RecoveryRequired {
                                    execution: None,
                                    reason,
                                },
                            )),
                        }
                    }
                    Ok(show) if show.is_pending() => Ok(WorkerStartOutcome::Outcome(
                        PrepareOutcome::Retryable {
                            execution: None,
                            reason: format!(
                                "worker-start mutation is still pending in Orca: {e}"
                            ),
                        },
                    )),
                    _ => Ok(WorkerStartOutcome::Outcome(
                        PrepareOutcome::RecoveryRequired {
                            execution: None,
                            reason: format!(
                                "failed to start worker for run '{run_id}' and request-show unresolved: {e}"
                            ),
                        },
                    )),
                }
            }
        }
    }
}

enum WorkerStartOutcome {
    Terminal(String),
    Outcome(PrepareOutcome),
}

fn extract_worker_terminal_from_receipt(receipt: &serde_json::Value) -> Option<String> {
    let unwrapped = receipt.get("result").unwrap_or(receipt);
    if let Ok(res) = serde_json::from_value::<OrcaWorkerStartResult>(unwrapped.clone()) {
        if let Some(h) = res.worker_terminal_handle() {
            return Some(h);
        }
    }
    for key in &[
        "agentTerminalHandle",
        "agent_terminal_handle",
        "terminalHandle",
        "terminal_handle",
        "terminalId",
        "terminal_id",
    ] {
        if let Some(h) = unwrapped.get(*key).and_then(|v| v.as_str()) {
            let trimmed = h.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

/// Extracts the `tab:leaf` pane key from a terminal item, if present.
fn pane_key_of(term: &OrcaTerminalItem) -> Option<String> {
    match (&term.tab_id, &term.leaf_id) {
        (Some(tab), Some(leaf)) => Some(format!("{tab}:{leaf}")),
        _ => None,
    }
}

enum ReadinessError {
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

    async fn get_agent_status_baseline(&self, terminal_id: &str) -> Result<Option<i64>, String> {
        let pane_key = match self.derive_pane_key(terminal_id).await {
            Some(pk) => pk,
            None => return Ok(None),
        };
        match self
            .client
            .worktree_ps_bounded(Duration::from_millis(800))
            .await
        {
            Ok(resp) => {
                if let Some(res) = resp.result {
                    for wt in res.worktrees {
                        for ag in wt.agents {
                            if ag.pane_key == pane_key {
                                return Ok(ag.state_started_at);
                            }
                        }
                    }
                }
                Ok(None)
            }
            Err(_) => Ok(None),
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
                        Some(ts)
                    } else {
                        match self.run_readiness_gate(existing_tid).await {
                            Ok(ts) => {
                                if ts.is_none() {
                                    eprintln!(
                                        "Agent readiness not observed via tui-idle for attempt '{}' terminal '{}'; proceeding to dispatch and relying on terminal send acceptance.",
                                        attempt.attempt_id, existing_tid
                                    );
                                }
                                ts
                            }
                            Err(ReadinessError::ProtocolMismatch(r)) => {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: Some(identity),
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
            let expected_title = format!("ceo:{}:{}", attempt.attempt_id, executor.agent_id);
            let legacy_title = format!("ceo:{}", attempt.attempt_id);
            let matching_terminals: Vec<_> = term_list_res
                .terminals
                .into_iter()
                .filter(|t| {
                    (t.title.as_deref() == Some(&expected_title)
                        || t.title.as_deref() == Some(&legacy_title))
                        && t.worktree_id
                            .as_deref()
                            .map(|w| w == worktree.id)
                            .unwrap_or(true)
                })
                .collect();

            match matching_terminals.len() {
                0 => {
                    let term_handle = if let Some(ref _legacy_cmd) = executor.command {
                        // Legacy configs with command remain readable for migration
                        let launch_command = executor
                            .effective_command()
                            .map_err(|e| {
                                format!(
                                    "RECOVERY_REQUIRED: invalid executor configuration for target '{}': {e}",
                                    target.local_path
                                )
                            })?;
                        let term = self
                            .client
                            .create_terminal(
                                &worktree.id,
                                &expected_title,
                                Some(&launch_command),
                                Some(&canonical_target_path),
                            )
                            .await
                            .map_err(|e| format!("failed to create terminal for attempt: {e}"))?;
                        term.handle
                    } else if self.client.supports_agent_session_launch().await {
                        // Logical Agent launch: orchestration launch via coordinator + run-create + worker-start
                        let run_obj = format!("ceo:{}", attempt.attempt_id);
                        let run_retry_id =
                            derive_mutation_request_id("run-create", &attempt.attempt_id)
                                .to_string();
                        let worker_retry_id =
                            derive_mutation_request_id("worker-start", &attempt.attempt_id)
                                .to_string();

                        let runs = match self.client.list_runs().await {
                            Ok(runs) => runs,
                            Err(e) => {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: None,
                                    reason: format!("failed to list orchestration runs: {e}"),
                                });
                            }
                        };

                        let matching_runs: Vec<OrcaRunItem> = runs
                            .into_iter()
                            .filter(|r| r.objective.as_deref() == Some(&run_obj))
                            .collect();

                        if matching_runs.len() > 1 {
                            return Ok(PrepareOutcome::RecoveryRequired {
                                execution: None,
                                reason: format!(
                                    "multiple orchestration runs ({}) found matching objective '{run_obj}'; failing closed to avoid ambiguous reconciliation",
                                    matching_runs.len()
                                ),
                            });
                        }

                        if matching_runs.is_empty() {
                            let anchor_wt_id =
                                self.resolve_coordinator_anchor_worktree(&worktree.id).await;
                            let coordinator_handle = self
                                .ensure_coordinator_terminal(&anchor_wt_id, &attempt.device_id)
                                .await
                                .map_err(|e| {
                                    format!("failed to reconcile coordinator terminal: {e}")
                                })?;

                            let run_item = match self
                                .client
                                .create_run(&coordinator_handle, &run_obj, Some(&run_retry_id))
                                .await
                            {
                                Ok(r) => r,
                                Err(e) => match self.client.request_show(&run_retry_id).await {
                                    Ok(show) if show.is_completed() => {
                                        if let Some(receipt) = show.receipt {
                                            let unwrapped =
                                                receipt.get("result").unwrap_or(&receipt);
                                            if let Ok(res) =
                                                serde_json::from_value::<OrcaRunCreateResult>(
                                                    unwrapped.clone(),
                                                )
                                            {
                                                res.run
                                            } else if let Ok(run) =
                                                serde_json::from_value::<OrcaRunItem>(
                                                    unwrapped.clone(),
                                                )
                                            {
                                                run
                                            } else {
                                                return Err(format!(
                                                    "failed to recover run from request-show receipt: {e}"
                                                ));
                                            }
                                        } else {
                                            return Err(format!(
                                                "request-show completed but missing receipt: {e}"
                                            ));
                                        }
                                    }
                                    Ok(show) if show.is_pending() => {
                                        return Ok(PrepareOutcome::Retryable {
                                            execution: None,
                                            reason: format!(
                                                "run-create mutation is still pending in Orca: {e}"
                                            ),
                                        });
                                    }
                                    _ => {
                                        return Err(format!(
                                            "failed to create orchestration run: {e}"
                                        ));
                                    }
                                },
                            };

                            let spec = format!("ceo:{}", attempt.attempt_id);
                            let model_opt = executor.model.as_deref().filter(|m| *m != "auto");
                            match self
                                .launch_worker_and_reconcile(
                                    &coordinator_handle,
                                    &run_item.id,
                                    &worktree.id,
                                    &executor.agent_id,
                                    model_opt,
                                    &spec,
                                    &worker_retry_id,
                                )
                                .await?
                            {
                                WorkerStartOutcome::Terminal(h) => h,
                                WorkerStartOutcome::Outcome(out) => return Ok(out),
                            }
                        } else {
                            let existing_run = &matching_runs[0];
                            let workers = match self
                                .client
                                .list_workers(Some(&existing_run.id))
                                .await
                            {
                                Ok(w) => w,
                                Err(e) => {
                                    return Ok(PrepareOutcome::RecoveryRequired {
                                        execution: None,
                                        reason: format!(
                                            "AMBIGUOUS_PREPARE_RETRY: failed to list workers for existing run '{}': {e}",
                                            existing_run.id
                                        ),
                                    });
                                }
                            };

                            let candidate_handles: Vec<String> = workers
                                .into_iter()
                                .filter_map(|w| w.agent_terminal_handle)
                                .filter(|h| !h.trim().is_empty())
                                .collect();

                            if candidate_handles.len() > 1 {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: None,
                                    reason: format!(
                                        "AMBIGUOUS_PREPARE_RETRY: multiple workers ({}) found for existing orchestration run '{}'; refusing duplicate worker-start",
                                        candidate_handles.len(),
                                        existing_run.id
                                    ),
                                });
                            }

                            let recoverable_worker = if candidate_handles.len() == 1 {
                                let handle = &candidate_handles[0];
                                match self.client.show_terminal(handle).await {
                                    Ok(Some(term))
                                        if term.worktree_id.as_deref() == Some(&worktree.id)
                                            && term.liveness() == TerminalLiveness::Live =>
                                    {
                                        Some(handle.clone())
                                    }
                                    _ => None,
                                }
                            } else {
                                None
                            };

                            if let Some(handle) = recoverable_worker {
                                handle
                            } else {
                                // No safely recoverable worker exists. Reconcile the stable worker-start request identity before deciding to fail.
                                match self.client.request_show(&worker_retry_id).await {
                                    Ok(show) if show.is_completed() => {
                                        let receipt = match show.receipt {
                                            Some(r) => r,
                                            None => {
                                                return Ok(PrepareOutcome::RecoveryRequired {
                                                    execution: None,
                                                    reason: format!(
                                                        "request-show completed for worker-start on run '{}' but missing receipt; preserving evidence",
                                                        existing_run.id
                                                    ),
                                                });
                                            }
                                        };
                                        let handle = match extract_worker_terminal_from_receipt(
                                            &receipt,
                                        ) {
                                            Some(h) => h,
                                            None => {
                                                return Ok(PrepareOutcome::RecoveryRequired {
                                                    execution: None,
                                                    reason: format!(
                                                        "failed to recover worker terminal from request-show receipt on run '{}'; preserving evidence",
                                                        existing_run.id
                                                    ),
                                                });
                                            }
                                        };
                                        match self
                                            .validate_worker_terminal(&handle, &worktree.id)
                                            .await
                                        {
                                            Ok(()) => handle,
                                            Err(reason) => {
                                                return Ok(PrepareOutcome::RecoveryRequired {
                                                    execution: None,
                                                    reason,
                                                });
                                            }
                                        }
                                    }
                                    Ok(show) if show.is_pending() => {
                                        return Ok(PrepareOutcome::Retryable {
                                            execution: None,
                                            reason: format!(
                                                "worker-start mutation is still pending in Orca for run '{}'",
                                                existing_run.id
                                            ),
                                        });
                                    }
                                    Ok(show) if show.is_absent() => {
                                        if !candidate_handles.is_empty() {
                                            return Ok(PrepareOutcome::RecoveryRequired {
                                                execution: None,
                                                reason: format!(
                                                    "AMBIGUOUS_PREPARE_RETRY: orchestration run '{}' already has unrecoverable workers but worker-start request-show is absent; refusing duplicate worker-start",
                                                    existing_run.id
                                                ),
                                            });
                                        }
                                        let anchor_wt_id = self
                                            .resolve_coordinator_anchor_worktree(&worktree.id)
                                            .await;
                                        let coordinator_handle = self
                                            .ensure_coordinator_terminal(
                                                &anchor_wt_id,
                                                &attempt.device_id,
                                            )
                                            .await
                                            .map_err(|e| {
                                                format!(
                                                    "failed to reconcile coordinator terminal: {e}"
                                                )
                                            })?;
                                        let spec = format!("ceo:{}", attempt.attempt_id);
                                        let model_opt =
                                            executor.model.as_deref().filter(|m| *m != "auto");

                                        match self
                                            .launch_worker_and_reconcile(
                                                &coordinator_handle,
                                                &existing_run.id,
                                                &worktree.id,
                                                &executor.agent_id,
                                                model_opt,
                                                &spec,
                                                &worker_retry_id,
                                            )
                                            .await?
                                        {
                                            WorkerStartOutcome::Terminal(h) => h,
                                            WorkerStartOutcome::Outcome(out) => return Ok(out),
                                        }
                                    }
                                    _ => {
                                        return Ok(PrepareOutcome::RecoveryRequired {
                                            execution: None,
                                            reason: format!(
                                                "AMBIGUOUS_PREPARE_RETRY: orchestration run '{}' already exists for attempt '{}' before local terminal identity was persisted, but no live worker terminal could be safely recovered and worker-start request-show was unavailable or unresolved; refusing duplicate worker-start",
                                                existing_run.id, attempt.attempt_id
                                            ),
                                        });
                                    }
                                }
                            }
                        }
                    } else {
                        return Ok(PrepareOutcome::RecoveryRequired {
                            execution: None,
                            reason: format!(
                                "{}: installed Orca version does not expose the required orchestration Agent launch surface required by Connector",
                                crate::execution_admission::ORCA_AGENT_SESSION_LAUNCH_UNAVAILABLE
                            ),
                        });
                    };

                    let identity = PreparedExecutionIdentity {
                        orca_version: orca_version.clone(),
                        worktree_id: worktree.id.clone(),
                        terminal_id: term_handle.clone(),
                        agent_id: executor.agent_id.clone(),
                    };

                    let ready_at = match self.run_readiness_gate(&term_handle).await {
                        Ok(ts) => {
                            if ts.is_none() {
                                eprintln!(
                                    "Agent readiness not observed via tui-idle for attempt '{}' terminal '{}'; proceeding to dispatch and relying on terminal send acceptance.",
                                    attempt.attempt_id, term_handle
                                );
                            }
                            ts
                        }
                        Err(ReadinessError::ProtocolMismatch(r)) => {
                            return Ok(PrepareOutcome::RecoveryRequired {
                                execution: Some(identity),
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
                    (term_handle, ready_at)
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
                        Some(ts)
                    } else {
                        match self.run_readiness_gate(&handle).await {
                            Ok(ts) => {
                                if ts.is_none() {
                                    eprintln!(
                                        "Agent readiness not observed via tui-idle for attempt '{}' terminal '{}'; proceeding to dispatch and relying on terminal send acceptance.",
                                        attempt.attempt_id, handle
                                    );
                                }
                                ts
                            }
                            Err(ReadinessError::ProtocolMismatch(r)) => {
                                return Ok(PrepareOutcome::RecoveryRequired {
                                    execution: Some(identity),
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
        _attempt: &ActiveAttempt,
        terminal_id: &str,
        prompt_text: &str,
    ) -> Result<DispatchOutcome, String> {
        match self
            .client
            .send_terminal_prompt(terminal_id, prompt_text, None, Some(10))
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
                            if let Some(req_id) = p.request_id.clone() {
                                let has_turn_started = send_prompt_turn_started(&p);
                                return Ok(DispatchOutcome::Accepted {
                                    request_id: req_id,
                                    accepted_at_ms: chrono::Utc::now().timestamp_millis(),
                                    turn_started: has_turn_started,
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
        attempt: &ActiveAttempt,
        terminal_id: &str,
        remaining_timeout: Duration,
    ) -> Result<WaitOutcome, String> {
        // Inspect the authoritative terminal state as part of every wait
        // tick. Orca may retain a terminal tombstone object (orphaned=true
        // and/or an explicit exitCause like operator_close) instead of
        // returning a terminal_not_found error; such a terminal must
        // immediately interrupt the waiting attempt instead of short-polling
        // until the execution deadline.
        //
        // Transient show/transport failures (and `terminal_not_found`, which
        // the client maps to Ok(None)) are deliberately NOT treated as
        // terminal death here; they fall through to the existing bounded
        // observation below, which retains the current not-found/exited
        // error handling.
        let shown_terminal = self.client.show_terminal(terminal_id).await.ok().flatten();
        if let Some(ref term) = shown_terminal {
            if let TerminalLiveness::DefinitelyExited { reason } = term.liveness() {
                return Ok(WaitOutcome::Interrupted {
                    reason: format!("terminal '{terminal_id}' is no longer live: {reason}"),
                });
            }
        }

        let pane_key = shown_terminal.as_ref().and_then(pane_key_of);
        if let Some(ref pk) = pane_key {
            if let Ok(resp) = self
                .client
                .worktree_ps_bounded(Duration::from_millis(800))
                .await
            {
                if let Some(res) = resp.result {
                    for wt in res.worktrees {
                        for ag in wt.agents {
                            if ag.pane_key == *pk {
                                if ag.state == "working" {
                                    return Ok(WaitOutcome::WorkingObserved { elapsed_ms: 100 });
                                }
                                if ag.state == "done" {
                                    let baseline = attempt
                                        .executor
                                        .as_ref()
                                        .and_then(|e| e.dispatch_baseline_state_started_at);
                                    let is_new_generation = match baseline {
                                        Some(b) => ag.state_started_at != Some(b),
                                        None => true,
                                    };
                                    if is_new_generation {
                                        if ag.interrupted {
                                            // Authoritative structured evidence that the
                                            // dispatched turn was interrupted: must never
                                            // map to COMPLETED (and never to a generic
                                            // tui-idle completion either). Fails promptly
                                            // through the existing Interrupted path.
                                            return Ok(WaitOutcome::Interrupted {
                                                reason: format!(
                                                    "agent pane '{pk}' reported state 'done' with interrupted=true"
                                                ),
                                            });
                                        }
                                        return Ok(WaitOutcome::AgentDone { elapsed_ms: 100 });
                                    }
                                }
                                // The pane's Agent is visible in structured ps
                                // output but the observation is not authoritative
                                // for completion (pre-dispatch/baseline state or
                                // any other non-working state). Structured
                                // lifecycle observation IS available for this
                                // Attempt, so generic terminal idle must never
                                // terminalize it: keep waiting inside the pane.
                                return Ok(WaitOutcome::AgentSeen { elapsed_ms: 100 });
                            }
                        }
                    }
                }
            }
        }

        // Bounded short wait on tui-idle (min of remaining_timeout and 1500ms)
        let bounded_wait = remaining_timeout.min(Duration::from_millis(1500));
        match self
            .client
            .wait_terminal_tui_idle(terminal_id, bounded_wait)
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
                elapsed_ms: bounded_wait.as_millis() as u64,
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

    async fn interrupt(
        &self,
        _active: &ActiveAttempt,
        terminal_id: &str,
    ) -> Result<InterruptOutcome, String> {
        match self.client.send_interrupt(terminal_id).await {
            Ok(_) => Ok(InterruptOutcome::Sent),
            Err(e) => {
                eprintln!("Warning: failed to send interrupt to terminal {terminal_id}: {e}");
                Ok(InterruptOutcome::Failed {
                    error: e.to_string(),
                })
            }
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
                if let Some(ref verdict) = close_part.pty_stop_verdict {
                    if verdict == "live" || verdict == "unverifiable" {
                        return CleanupOutcome::RecoveryRequired {
                            code: "TERMINAL_STOP_UNVERIFIABLE".into(),
                            message: format!(
                                "terminal close returned pty_stop_verdict='{verdict}'"
                            ),
                        };
                    }
                }
            }
            Err(OrcaError::Orca {
                ref code,
                ref message,
                ..
            }) => {
                if code == "terminal_stop_unverifiable" || code == "terminal_stop_live" {
                    return CleanupOutcome::RecoveryRequired {
                        code: "TERMINAL_STOP_UNVERIFIABLE".into(),
                        message: format!("terminal close returned unverifiable stop: {message}"),
                    };
                }
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

#[cfg(test)]
mod tests {
    use super::super::types::OrcaSendPromptPart;
    use super::send_prompt_turn_started;

    fn send_prompt(
        stages: Option<Vec<&str>>,
        provider: Option<&str>,
        observation: Option<&str>,
    ) -> OrcaSendPromptPart {
        OrcaSendPromptPart {
            request_id: Some("req_1".into()),
            stages: stages.map(|s| s.into_iter().map(String::from).collect()),
            provider: provider.map(String::from),
            observation: observation.map(String::from),
        }
    }

    #[test]
    fn test_explicit_turn_started_stage_is_positive_evidence() {
        let p = send_prompt(Some(vec!["input_accepted", "turn_started"]), None, None);
        assert!(send_prompt_turn_started(&p));
    }

    #[test]
    fn test_observation_unsupported_is_not_turn_start_evidence() {
        let p = send_prompt(Some(vec!["input_accepted"]), None, Some("unsupported"));
        assert!(!send_prompt_turn_started(&p));
    }

    #[test]
    fn test_provider_unsupported_is_not_turn_start_evidence() {
        let p = send_prompt(Some(vec!["input_accepted"]), Some("unsupported"), None);
        assert!(!send_prompt_turn_started(&p));
    }

    #[test]
    fn test_unsupported_alone_with_no_stages_is_not_turn_start_evidence() {
        let p = send_prompt(None, Some("unsupported"), Some("unsupported"));
        assert!(!send_prompt_turn_started(&p));
    }

    #[test]
    fn test_missing_stages_is_not_turn_start_evidence() {
        let p = send_prompt(None, Some("terminal"), Some("structured"));
        assert!(!send_prompt_turn_started(&p));
    }
}
