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
pub struct OrcaExitCause {
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrcaTerminalItem {
    pub handle: String,
    pub pty_id: Option<String>,
    pub worktree_id: Option<String>,
    pub title: Option<String>,
    pub connected: Option<bool>,
    pub writable: Option<bool>,
    pub orphaned: Option<bool>,
    pub exit_cause: Option<OrcaExitCause>,
    /// Set by Orca when a known agent is running in this terminal.
    /// e.g. `"antigravity"` for AGY sessions.
    pub agent_identity: Option<String>,
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
}
