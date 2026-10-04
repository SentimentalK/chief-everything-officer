use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaErrorPart {
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrcaFailureEnvelope {
    #[serde(default)]
    pub id: Option<String>,
    pub ok: bool,
    pub error: OrcaErrorPart,
    #[serde(rename = "_meta", default)]
    pub meta: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaStatusResponse {
    pub ok: bool,
    pub result: Option<OrcaStatusResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaStatusResult {
    pub app: OrcaAppStatus,
    pub runtime: OrcaRuntimeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaAppStatus {
    pub running: bool,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaRuntimeStatus {
    pub state: String,
    pub reachable: bool,
    pub app_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeItem {
    pub id: String,
    #[serde(rename = "instanceId")]
    pub instance_id: Option<String>,
    #[serde(rename = "repoId")]
    pub repo_id: Option<String>,
    pub path: String,
    pub branch: Option<String>,
    #[serde(rename = "isMainWorktree")]
    pub is_main_worktree: Option<bool>,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeListResponse {
    pub ok: bool,
    pub result: Option<OrcaWorktreeListResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeListResult {
    pub worktrees: Vec<OrcaWorktreeItem>,
    #[serde(default)]
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeShowResponse {
    pub ok: bool,
    pub result: Option<OrcaWorktreeShowResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeShowResult {
    pub worktree: OrcaWorktreeItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRepoAddResponse {
    pub ok: bool,
    pub result: Option<OrcaRepoAddResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRepoAddResult {
    pub repo: OrcaRepoItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaRepoItem {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminalExitCause {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminalItem {
    pub handle: String,
    pub pty_id: Option<String>,
    pub worktree_id: Option<String>,
    pub title: Option<String>,
    pub tab_id: Option<String>,
    pub leaf_id: Option<String>,
    pub preview: Option<String>,
    // Authoritative structured liveness fields. Orca may retain a terminal
    // tombstone object after the terminal is no longer live (e.g. after an
    // operator close) instead of returning a terminal_not_found error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub orphaned: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connected: Option<bool>,
    // Parsed for payload fidelity only: a temporary non-writable state is NOT
    // terminal death and must never be treated as such.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_cause: Option<OrcaTerminalExitCause>,
}

/// Authoritative structured liveness classification of an Orca terminal.
///
/// Based only on structured Orca fields (never title/preview heuristics):
/// - [`TerminalLiveness::DefinitelyExited`] means Orca authoritatively
///   reported the terminal as no longer live (an explicit structured exit
///   cause and/or `orphaned: true`), so waiting attempts must be interrupted
///   immediately instead of polling until the execution deadline.
/// - [`TerminalLiveness::Unknown`] means the liveness fields are absent or
///   ambiguous; callers must retain their existing bounded/retryable
///   behavior and must not infer terminal death.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalLiveness {
    Live,
    DefinitelyExited { reason: String },
    Unknown,
}

impl OrcaTerminalItem {
    /// Classifies the structured liveness of this terminal as reported by Orca.
    pub fn liveness(&self) -> TerminalLiveness {
        if let Some(cause) = self.exit_cause.as_ref().filter(|c| !c.kind.is_empty()) {
            let mut reason = format!("exitCause.kind={}", cause.kind);
            if let Some(msg) = cause.message.as_deref().filter(|m| !m.is_empty()) {
                reason.push_str(&format!(": {msg}"));
            }
            return TerminalLiveness::DefinitelyExited { reason };
        }
        if self.orphaned == Some(true) {
            return TerminalLiveness::DefinitelyExited {
                reason: "orphaned".into(),
            };
        }
        // Note: `writable` alone is deliberately NOT treated as death.
        if self.connected == Some(true) {
            TerminalLiveness::Live
        } else {
            TerminalLiveness::Unknown
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreePsResponse {
    pub ok: bool,
    pub result: Option<OrcaWorktreePsResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreePsResult {
    #[serde(default)]
    pub worktrees: Vec<OrcaWorktreePsItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaWorktreePsItem {
    pub worktree_id: String,
    #[serde(default)]
    pub agents: Vec<OrcaAgentPsItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaAgentPsItem {
    pub pane_key: String,
    pub state: String,
    #[serde(default)]
    pub interrupted: bool,
    pub state_started_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalListResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalListResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalListResult {
    pub terminals: Vec<OrcaTerminalItem>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalShowResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalShowResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalShowResult {
    pub terminal: OrcaTerminalItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalCreateResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalCreateResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalCreateResult {
    pub terminal: OrcaTerminalItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalSendResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalSendResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalSendResult {
    pub send: Option<OrcaSendPart>,
    pub mutation: Option<OrcaMutationPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaSendPart {
    pub handle: String,
    pub accepted: bool,
    pub bytes_written: Option<u64>,
    pub prompt: Option<OrcaSendPromptPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaSendPromptPart {
    pub request_id: Option<String>,
    #[serde(default)]
    pub stages: Option<Vec<String>>,
    pub provider: Option<String>,
    pub observation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaMutationPart {
    pub request_id: Option<String>,
    pub replayed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalWaitResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalWaitResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalWaitResult {
    pub wait: Option<OrcaWaitPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaWaitPart {
    pub handle: Option<String>,
    pub condition: Option<String>,
    pub satisfied: bool,
    pub elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalCloseResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalCloseResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminalCloseResult {
    pub close: Option<OrcaClosePart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaClosePart {
    pub handle: String,
    pub close_mode: Option<String>,
    pub pty_killed: Option<bool>,
    pub pty_stop_verdict: Option<String>,
    pub pty_stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRunItem {
    pub id: String,
    pub objective: Option<String>,
    #[serde(rename = "coordinator_handle")]
    pub coordinator_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRunCreateResponse {
    pub ok: bool,
    pub result: Option<OrcaRunCreateResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRunCreateResult {
    pub run: OrcaRunItem,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRunListResponse {
    pub ok: bool,
    pub result: Option<OrcaRunListResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaRunListResult {
    pub runs: Vec<OrcaRunItem>,
    #[serde(default, rename = "nextCursor")]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaWorkerItem {
    pub dispatch_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub agent_terminal_handle: Option<String>,
    pub worker_state: Option<String>,
    pub dispatch_status: Option<String>,
    pub terminal_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorkerListResponse {
    pub ok: bool,
    pub result: Option<OrcaWorkerListResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorkerListResult {
    #[serde(default)]
    pub workers: Vec<OrcaWorkerItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorkerEffect {
    pub kind: String,
    #[serde(default)]
    pub action: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorkerStartResponse {
    pub ok: bool,
    pub result: Option<OrcaWorkerStartResult>,
    pub error: Option<OrcaErrorPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaWorkerStartResult {
    #[serde(rename = "runId")]
    pub run_id: Option<String>,
    #[serde(rename = "taskId")]
    pub task_id: Option<String>,
    #[serde(rename = "dispatchId")]
    pub dispatch_id: Option<String>,
    pub state: Option<String>,
    pub stage: Option<String>,
    #[serde(default)]
    pub effects: Vec<OrcaWorkerEffect>,
    #[serde(default)]
    pub terminal_handle: Option<String>,
}

impl OrcaWorkerStartResult {
    /// Defensively correlates the worker terminal handle from the worker-start response.
    pub fn worker_terminal_handle(&self) -> Option<String> {
        // 1. Direct field if present
        if let Some(ref h) = self.terminal_handle {
            if !h.trim().is_empty() {
                return Some(h.trim().to_string());
            }
        }
        // 2. Search effects for terminal role agent
        for eff in &self.effects {
            if eff.kind == "terminal" && eff.role.as_deref() == Some("agent") {
                if let Some(ref id) = eff.id {
                    if !id.trim().is_empty() {
                        return Some(id.trim().to_string());
                    }
                }
            }
        }
        // 3. Search effects for dispatch_input
        for eff in &self.effects {
            if eff.kind == "dispatch_input" {
                if let Some(ref id) = eff.id {
                    if !id.trim().is_empty() {
                        return Some(id.trim().to_string());
                    }
                }
            }
        }
        // 4. Any effect whose id starts with "term_"
        for eff in &self.effects {
            if let Some(ref id) = eff.id {
                let trimmed = id.trim();
                if trimmed.starts_with("term_") {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }
}
