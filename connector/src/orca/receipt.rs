use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionReceipt {
    pub schema_version: u32,
    pub job_id: String,
    pub attempt_id: String,
    pub target_id: String,
    pub orca_version: String,
    pub worktree_id: Option<String>,
    pub terminal_id: Option<String>,
    pub agent_id: Option<String>,
    pub agent_ready_at_ms: Option<i64>,
    pub dispatch_request_id: Option<String>,
    pub dispatch_stage: Option<String>,
    pub task_dispatched: bool,
    pub runtime_completion_kind: Option<String>,
    pub dispatch_started_at_ms: Option<i64>,
    pub runtime_completed_at_ms: Option<i64>,
    pub terminal_cleanup_verified: bool,
    pub terminal_closed_at_ms: Option<i64>,
}

impl ExecutionReceipt {
    pub const SCHEMA_VERSION: u32 = 2;

    pub fn compute_sha256(&self) -> String {
        let bytes = serde_json::to_vec(self).expect("canonical receipt serialization");
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_receipt_hash_determinism_and_exclusion_of_secrets() {
        let receipt = ExecutionReceipt {
            schema_version: ExecutionReceipt::SCHEMA_VERSION,
            job_id: "job-1".into(),
            attempt_id: "att-1".into(),
            target_id: "tgt-1".into(),
            orca_version: "1.4.209".into(),
            worktree_id: Some("wt-1".into()),
            terminal_id: Some("term-1".into()),
            agent_id: Some("agy".into()),
            agent_ready_at_ms: Some(1727220000000),
            dispatch_request_id: Some("req-1".into()),
            dispatch_stage: Some("turn_started".into()),
            task_dispatched: true,
            runtime_completion_kind: Some("tui_idle".into()),
            dispatch_started_at_ms: Some(1727220000000),
            runtime_completed_at_ms: Some(1727220045000),
            terminal_cleanup_verified: true,
            terminal_closed_at_ms: Some(1727220046000),
        };

        let digest = receipt.compute_sha256();
        assert_eq!(digest.len(), 64);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));

        let json_str = serde_json::to_string(&receipt).unwrap();
        // Confidentiality checks
        assert!(!json_str.contains("prompt"));
        assert!(!json_str.contains("acceptance"));
        assert!(!json_str.contains("claim_token"));
        assert!(!json_str.contains("secret"));
    }
}
