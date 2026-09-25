use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeCreateResponse {
    pub ok: bool,
    pub result: Option<OrcaWorktreeCreateResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaWorktreeCreateResult {
    pub worktree: OrcaWorktreeItem,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalListResponse {
    pub ok: bool,
    pub result: Option<OrcaTerminalListResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaTerminalListResult {
    pub terminals: Vec<OrcaTerminalItem>,
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
    pub handle: String,
    pub condition: String,
    pub satisfied: bool,
    pub elapsed_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrcaErrorPart {
    pub code: Option<String>,
    pub message: Option<String>,
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
}
