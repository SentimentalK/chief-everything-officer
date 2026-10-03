use async_trait::async_trait;
use serde::Deserialize;

use super::client::OrcaCliClient;

#[derive(Debug, Deserialize)]
pub struct AgentContextCommand {
    pub command: Option<String>,
    pub path: Vec<String>,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct AgentContextOutput {
    pub commands: Vec<AgentContextCommand>,
}

/// Extracts Orca-known agent IDs from `orca agent-context --json` output.
///
/// V1 source contract:
/// 1. Parse JSON internally with serde.
/// 2. Find command with path `["orchestration", "worker-start"]`.
/// 3. Derive Orca-maintained agent-id examples from its notes
///    (e.g., "--agent takes an Orca agent id enabled on the worker server, such as claude, codex, cursor, antigravity, muse, zcode, opencode, or opencode2.").
/// 4. This is an Orca-known/supported list, NOT proof that each is locally installed.
/// 5. No external jq/grep/awk dependency.
/// 6. If schema extraction fails, fail clearly; NEVER fall back to a hardcoded catalogue.
pub fn extract_known_agents_from_agent_context_json(json_str: &str) -> Result<Vec<String>, String> {
    let ctx: AgentContextOutput = serde_json::from_str(json_str)
        .map_err(|e| format!("failed to parse Orca agent-context JSON: {e}"))?;

    let worker_start = ctx
        .commands
        .iter()
        .find(|c| c.path == ["orchestration", "worker-start"])
        .ok_or_else(|| {
            "command path ['orchestration', 'worker-start'] not found in Orca agent-context"
                .to_string()
        })?;

    let agent_note = worker_start
        .notes
        .iter()
        .find(|n| n.contains("--agent") && n.contains("such as"))
        .ok_or_else(|| {
            "no note with '--agent' and 'such as' found in Orca worker-start command".to_string()
        })?;

    let marker = "such as ";
    let idx = agent_note
        .find(marker)
        .ok_or_else(|| format!("marker '{marker}' not found in agent note"))?;

    let raw_list = &agent_note[idx + marker.len()..];
    // Strip trailing period or sentence terminator
    let trimmed = raw_list.trim().trim_end_matches('.');

    // Split on commas or " or "
    let mut agents = Vec::new();
    for part in trimmed.split(',') {
        let mut cleaned = part.trim();
        if let Some(rest) = cleaned.strip_prefix("or ") {
            cleaned = rest.trim();
        }
        if !cleaned.is_empty() {
            let agent_id = cleaned.trim().to_lowercase();
            if !agent_id.is_empty() && !agents.contains(&agent_id) {
                agents.push(agent_id);
            }
        }
    }

    if agents.is_empty() {
        return Err("failed to derive any agent IDs from Orca agent-context note".into());
    }

    Ok(agents)
}

#[async_trait]
pub trait AgentDiscovery: Send + Sync {
    async fn discover_agents(&self) -> Result<Vec<String>, String>;
}

pub struct OrcaCliAgentDiscovery<'a> {
    pub client: &'a OrcaCliClient,
}

impl<'a> OrcaCliAgentDiscovery<'a> {
    pub fn new(client: &'a OrcaCliClient) -> Self {
        Self { client }
    }
}

#[async_trait]
impl<'a> AgentDiscovery for OrcaCliAgentDiscovery<'a> {
    async fn discover_agents(&self) -> Result<Vec<String>, String> {
        let raw = self
            .client
            .agent_context_raw()
            .await
            .map_err(|e| format!("failed to run 'orca agent-context --json': {e}"))?;
        extract_known_agents_from_agent_context_json(&raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_agent_context_note() {
        let json = r#"{
            "commands": [
                {
                    "command": "orchestration worker-start",
                    "path": ["orchestration", "worker-start"],
                    "notes": [
                        "--agent takes an Orca agent id enabled on the worker server, such as claude, codex, cursor, antigravity, muse, zcode, opencode, or opencode2.",
                        "--model supports Claude, Codex, Cursor..."
                    ]
                }
            ]
        }"#;

        let agents = extract_known_agents_from_agent_context_json(json).unwrap();
        assert_eq!(
            agents,
            vec![
                "claude",
                "codex",
                "cursor",
                "antigravity",
                "muse",
                "zcode",
                "opencode",
                "opencode2"
            ]
        );
    }

    #[test]
    fn fails_on_missing_worker_start() {
        let json = r#"{"commands": []}"#;
        let err = extract_known_agents_from_agent_context_json(json).unwrap_err();
        assert!(err.contains("worker-start"));
    }

    #[test]
    fn fails_on_missing_agent_note() {
        let json = r#"{
            "commands": [
                {
                    "command": "orchestration worker-start",
                    "path": ["orchestration", "worker-start"],
                    "notes": ["some other note"]
                }
            ]
        }"#;
        let err = extract_known_agents_from_agent_context_json(json).unwrap_err();
        assert!(err.contains("no note with '--agent'"));
    }

    #[test]
    fn fails_on_invalid_json() {
        let json = "not valid json";
        let err = extract_known_agents_from_agent_context_json(json).unwrap_err();
        assert!(err.contains("failed to parse Orca agent-context JSON"));
    }
}
