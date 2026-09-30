use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use thiserror::Error;
use url::Url;

use crate::local_state::atomic_write_json;

pub const CONFIG_SCHEMA_VERSION: u32 = 2;

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid server URL: {0}")]
    InvalidServerUrl(String),
    #[error("Server URL must be an origin without credentials, query, or path: {0}")]
    NotAnOrigin(String),
    #[error("Unsupported schema version: {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("Invalid executor configuration: {0}")]
    InvalidExecutor(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalExecutorConfig {
    pub kind: String,
    pub agent_id: String,
    pub command: String,
    /// Optional per-target model override applied by the shared core launch
    /// policy when creating a new agent terminal/session. Absent (None)
    /// preserves the agent's normal default/Auto model selection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// Maximum accepted length for a model override value.
pub const MAX_EXECUTOR_MODEL_LEN: usize = 128;

impl LocalExecutorConfig {
    pub fn new(agent_id: String, command: String) -> Result<Self, ConfigError> {
        Self::new_with_model(agent_id, command, None)
    }

    pub fn new_with_model(
        agent_id: String,
        command: String,
        model: Option<String>,
    ) -> Result<Self, ConfigError> {
        let cfg = Self {
            kind: "orca_tui".to_string(),
            agent_id,
            command,
            model,
        };
        cfg.validate()?;
        Ok(cfg)
    }

    /// Explicit executor capability mapping for per-target model overrides.
    /// Intentionally minimal: only the Cursor Agent CLI has a verified launch
    /// contract (`--model <model>`). Future agents add their own entry after
    /// their CLI contract is verified. This shared-core mapping is the single
    /// place model-capable agents are declared; platform modules and Orca
    /// never own model routing.
    pub fn agent_supports_model_override(agent_id: &str) -> bool {
        agent_id == "cursor"
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        if self.kind != "orca_tui" {
            return Err(ConfigError::InvalidExecutor(format!(
                "unsupported executor kind '{}', must be 'orca_tui'",
                self.kind
            )));
        }
        let agent_id = self.agent_id.trim();
        if agent_id.is_empty() {
            return Err(ConfigError::InvalidExecutor(
                "agent_id cannot be empty".into(),
            ));
        }
        if agent_id.len() > 80 {
            return Err(ConfigError::InvalidExecutor(
                "agent_id exceeds maximum length of 80 bytes".into(),
            ));
        }
        if agent_id.contains('\0') {
            return Err(ConfigError::InvalidExecutor(
                "agent_id cannot contain NUL byte".into(),
            ));
        }
        if !agent_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        {
            return Err(ConfigError::InvalidExecutor(
                "agent_id contains invalid characters (allowed: alphanumeric, -, _, .)".into(),
            ));
        }
        let command = self.command.trim();
        if command.is_empty() {
            return Err(ConfigError::InvalidExecutor(
                "command cannot be empty".into(),
            ));
        }
        if command.len() > 1024 {
            return Err(ConfigError::InvalidExecutor(
                "command exceeds maximum length of 1024 bytes".into(),
            ));
        }
        if command.contains('\0') {
            return Err(ConfigError::InvalidExecutor(
                "command cannot contain NUL byte".into(),
            ));
        }
        if let Some(model) = &self.model {
            Self::validate_model_override(&self.agent_id, command, model)?;
        }
        Ok(())
    }

    fn validate_model_override(
        agent_id: &str,
        command: &str,
        model: &str,
    ) -> Result<(), ConfigError> {
        if !Self::agent_supports_model_override(agent_id) {
            return Err(ConfigError::InvalidExecutor(format!(
                "model override is not supported for agent '{agent_id}' (only 'cursor' has a verified model launch contract)"
            )));
        }
        let model = model.trim();
        if model.is_empty() {
            return Err(ConfigError::InvalidExecutor("model cannot be empty".into()));
        }
        if model.len() > MAX_EXECUTOR_MODEL_LEN {
            return Err(ConfigError::InvalidExecutor(
                "model exceeds maximum length of 128 bytes".into(),
            ));
        }
        for c in model.chars() {
            if c.is_ascii_control() || c == '\0' {
                return Err(ConfigError::InvalidExecutor(
                    "model cannot contain NUL, newline, or other control characters".into(),
                ));
            }
            if c.is_whitespace() {
                return Err(ConfigError::InvalidExecutor(
                    "model cannot contain whitespace (the verified Cursor CLI contract takes a single argument, e.g. `gpt-5` or `claude-opus-4-8[context=1m,effort=high,fast=false]`)".into(),
                ));
            }
        }
        // The model flag is appended to the existing command; a command that
        // already carries `--model` would result in the flag appearing twice.
        if command.split_whitespace().any(|t| t == "--model") {
            return Err(ConfigError::InvalidExecutor(
                "command already contains '--model'; remove it from the command before setting a model override".into(),
            ));
        }
        Ok(())
    }

    /// Returns the effective agent launch command used when creating a *new*
    /// agent terminal/session for this Target (shared core launch policy).
    ///
    /// - No model override: the configured command is returned unchanged.
    /// - Model override set: the verified Cursor CLI `--model <model>` option
    ///   is appended exactly once to the configured command.
    ///
    /// Recovery/reconciliation of an existing recorded terminal must not use
    /// this to restart a terminal; the override only applies at creation time.
    pub fn effective_command(&self) -> Result<String, ConfigError> {
        self.validate()?;
        match &self.model {
            None => Ok(self.command.clone()),
            Some(model) => Ok(format!("{} --model {}", self.command, model)),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalTarget {
    pub workspace_id: String,
    pub alias: String,
    pub kind: String,
    pub local_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<LocalExecutorConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalConfig {
    pub schema_version: u32,
    pub server_url: String,
    #[serde(default)]
    pub targets: BTreeMap<String, LocalTarget>,
}

impl LocalConfig {
    pub fn new(server_url: String) -> Result<Self, ConfigError> {
        let normalized = normalize_server_origin(&server_url)?;
        Ok(Self {
            schema_version: CONFIG_SCHEMA_VERSION,
            server_url: normalized,
            targets: BTreeMap::new(),
        })
    }

    pub fn load(path: &Path) -> Result<Option<Self>, ConfigError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let val: serde_json::Value = serde_json::from_str(&content)?;
        let version = val
            .get("schema_version")
            .and_then(|v| v.as_u64())
            .ok_or(ConfigError::UnsupportedSchemaVersion(0))? as u32;

        let config = match version {
            1 => {
                #[derive(Deserialize)]
                struct LocalConfigV1 {
                    server_url: String,
                    #[serde(default)]
                    targets: BTreeMap<String, LocalTargetV1>,
                }
                #[derive(Deserialize)]
                struct LocalTargetV1 {
                    workspace_id: String,
                    alias: String,
                    kind: String,
                    local_path: String,
                }
                let v1: LocalConfigV1 = serde_json::from_value(val)?;
                let mut targets = BTreeMap::new();
                for (tid, t) in v1.targets {
                    targets.insert(
                        tid,
                        LocalTarget {
                            workspace_id: t.workspace_id,
                            alias: t.alias,
                            kind: t.kind,
                            local_path: t.local_path,
                            executor: None,
                        },
                    );
                }
                LocalConfig {
                    schema_version: CONFIG_SCHEMA_VERSION,
                    server_url: v1.server_url,
                    targets,
                }
            }
            CONFIG_SCHEMA_VERSION => {
                let cfg: LocalConfig = serde_json::from_value(val)?;
                for lt in cfg.targets.values() {
                    if let Some(ref exec) = lt.executor {
                        exec.validate()?;
                    }
                }
                cfg
            }
            other => return Err(ConfigError::UnsupportedSchemaVersion(other)),
        };

        // Ensure server_url in file is a valid normalized origin
        normalize_server_origin(&config.server_url)?;
        Ok(Some(config))
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        normalize_server_origin(&self.server_url)?;
        for lt in self.targets.values() {
            if let Some(ref exec) = lt.executor {
                exec.validate()?;
            }
        }
        atomic_write_json(path, self)?;
        Ok(())
    }
}

/// Normalizes and validates a server URL into an authoritative origin string.
///
/// Rules:
/// - Must use https:// scheme, UNLESS host is loopback: 127.0.0.1 or [::1].
/// - Must have no username or password.
/// - Path must be empty or `/`.
/// - Query and fragment are forbidden.
/// - Output is strictly `scheme://host[:port]` without trailing slash.
pub fn normalize_server_origin(input: &str) -> Result<String, ConfigError> {
    let parsed = Url::parse(input)
        .map_err(|e| ConfigError::InvalidServerUrl(format!("{}: {}", input, e)))?;

    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ConfigError::NotAnOrigin(
            "credentials are not allowed in server origin".into(),
        ));
    }

    if parsed.path() != "" && parsed.path() != "/" {
        return Err(ConfigError::NotAnOrigin(format!(
            "path is not allowed in server origin: {}",
            parsed.path()
        )));
    }

    if parsed.query().is_some() {
        return Err(ConfigError::NotAnOrigin(
            "query parameters are not allowed in server origin".into(),
        ));
    }

    if parsed.fragment().is_some() {
        return Err(ConfigError::NotAnOrigin(
            "fragment is not allowed in server origin".into(),
        ));
    }

    let host = parsed
        .host_str()
        .ok_or_else(|| ConfigError::InvalidServerUrl("missing host in server URL".into()))?;

    let is_loopback = host == "127.0.0.1" || host == "::1" || host == "[::1]";

    match parsed.scheme() {
        "https" => {}
        "http" if is_loopback => {}
        "http" => {
            return Err(ConfigError::InvalidServerUrl(
                "http:// is only permitted for literal loopback addresses (127.0.0.1, [::1])"
                    .into(),
            ))
        }
        other => {
            return Err(ConfigError::InvalidServerUrl(format!(
                "unsupported scheme '{}', must be https",
                other
            )))
        }
    }

    let origin = if let Some(port) = parsed.port() {
        format!("{}://{}:{}", parsed.scheme(), host, port)
    } else {
        format!("{}://{}", parsed.scheme(), host)
    };

    Ok(origin)
}

use crate::credential::{CredentialError, DeviceCredential};
use crate::paths::ConnectorPaths;

#[derive(Debug, Clone)]
pub struct BoundProfile {
    pub config: LocalConfig,
    pub credential: DeviceCredential,
}

#[derive(Error, Debug)]
pub enum ProfileError {
    #[error("Not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
    #[error("Configuration not found. Please run `ceo-connector login` first.")]
    ConfigNotFound,
    #[error("Local credential server mismatch: config origin is '{expected}', but credential origin is '{actual}' (LOCAL_CREDENTIAL_SERVER_MISMATCH)")]
    LocalCredentialServerMismatch { expected: String, actual: String },
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
}

/// Loads both config and credential, verifying that config.server_url matches credential.server_origin.
pub fn load_bound_profile(paths: &ConnectorPaths) -> Result<BoundProfile, ProfileError> {
    let credential =
        DeviceCredential::load(&paths.credential_file())?.ok_or(ProfileError::NotLoggedIn)?;
    let config = match LocalConfig::load(&paths.config_file())? {
        Some(cfg) => cfg,
        None => LocalConfig::new(credential.server_origin.clone())?,
    };

    let normalized_config_origin =
        normalize_server_origin(&config.server_url).map_err(ProfileError::Config)?;

    if normalized_config_origin != credential.server_origin {
        return Err(ProfileError::LocalCredentialServerMismatch {
            expected: normalized_config_origin,
            actual: credential.server_origin,
        });
    }

    Ok(BoundProfile { config, credential })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_normalization_rules() {
        assert_eq!(
            normalize_server_origin("https://ceo.example.com").unwrap(),
            "https://ceo.example.com"
        );
        assert_eq!(
            normalize_server_origin("https://ceo.example.com/").unwrap(),
            "https://ceo.example.com"
        );
        assert_eq!(
            normalize_server_origin("http://127.0.0.1:4000/").unwrap(),
            "http://127.0.0.1:4000"
        );
        assert_eq!(
            normalize_server_origin("http://[::1]:8080").unwrap(),
            "http://[::1]:8080"
        );

        // Disallow localhost http (literal 127.0.0.1 or ::1 required)
        assert!(normalize_server_origin("http://localhost:4000").is_err());
        // Disallow public http
        assert!(normalize_server_origin("http://ceo.example.com").is_err());
        // Disallow paths
        assert!(normalize_server_origin("https://ceo.example.com/api").is_err());
        // Disallow queries
        assert!(normalize_server_origin("https://ceo.example.com?foo=bar").is_err());
        // Disallow credentials
        assert!(normalize_server_origin("https://user:pass@ceo.example.com").is_err());
    }

    #[test]
    fn config_deny_unknown_fields() {
        let bad_json = r#"{
            "schema_version": 2,
            "server_url": "https://ceo.example.com",
            "targets": {},
            "unknown_extra": true
        }"#;
        let res: Result<LocalConfig, _> = serde_json::from_str(bad_json);
        assert!(res.is_err());
    }

    #[test]
    fn executor_config_validation() {
        let valid = LocalExecutorConfig::new("agy".into(), "agy".into());
        assert!(valid.is_ok());

        let invalid_kind = LocalExecutorConfig {
            kind: "other".into(),
            agent_id: "agy".into(),
            command: "agy".into(),
            model: None,
        };
        assert!(invalid_kind.validate().is_err());

        let empty_agent = LocalExecutorConfig::new("".into(), "agy".into());
        assert!(empty_agent.is_err());

        let long_agent = LocalExecutorConfig::new("a".repeat(81), "agy".into());
        assert!(long_agent.is_err());

        let bad_chars_agent =
            LocalExecutorConfig::new("agy agent with spaces".into(), "agy".into());
        assert!(bad_chars_agent.is_err());

        let empty_cmd = LocalExecutorConfig::new("agy".into(), "   ".into());
        assert!(empty_cmd.is_err());

        let long_cmd = LocalExecutorConfig::new("agy".into(), "a".repeat(1025));
        assert!(long_cmd.is_err());
    }

    #[test]
    fn executor_model_override_validation() {
        // Valid cursor model (plain id and bracket-parameterized form)
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "/home/sentimentalk/.local/bin/agent -f --trust".into(),
            Some("gpt-5".into())
        )
        .is_ok());
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "/home/sentimentalk/.local/bin/agent -f --trust".into(),
            Some("claude-opus-4-8[context=1m,effort=high,fast=false]".into())
        )
        .is_ok());

        // Unsupported agent + model fails explicitly, no silent fallback
        let err =
            LocalExecutorConfig::new_with_model("agy".into(), "agy".into(), Some("gpt-5".into()));
        assert!(
            matches!(err, Err(ConfigError::InvalidExecutor(msg)) if msg.contains("not supported for agent 'agy'"))
        );

        // Empty
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("   ".into())
        )
        .is_err());
        // NUL
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("gpt\0-5".into())
        )
        .is_err());
        // Newline / control chars
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("gpt\n-5".into())
        )
        .is_err());
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("gpt\u{7}-5".into())
        )
        .is_err());
        // Whitespace (would split arguments at the terminal boundary)
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("gpt 5".into())
        )
        .is_err());
        // Overlong
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent".into(),
            Some("a".repeat(MAX_EXECUTOR_MODEL_LEN + 1))
        )
        .is_err());
        // Command already carries --model -> would appear twice
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent --model gpt-5".into(),
            Some("gpt-5".into())
        )
        .is_err());
        // '--models' as part of another token is not a duplicate --model flag
        assert!(LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "agent --models-dir /x".into(),
            Some("gpt-5".into())
        )
        .is_ok());
    }

    #[test]
    fn executor_effective_command_composition() {
        let no_model =
            LocalExecutorConfig::new("cursor".into(), "/path/agent -f --trust".into()).unwrap();
        // Byte-for-byte unchanged when no model override
        assert_eq!(
            no_model.effective_command().unwrap(),
            "/path/agent -f --trust"
        );

        let with_model = LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "/path/agent -f --trust".into(),
            Some("gpt-5".into()),
        )
        .unwrap();
        assert_eq!(
            with_model.effective_command().unwrap(),
            "/path/agent -f --trust --model gpt-5"
        );
        // Idempotent: repeated calls append exactly once
        assert_eq!(
            with_model.effective_command().unwrap(),
            with_model.effective_command().unwrap()
        );

        let unsupported =
            LocalExecutorConfig::new_with_model("agy".into(), "agy".into(), Some("gpt-5".into()));
        assert!(unsupported.is_err());
    }

    #[test]
    fn executor_config_without_model_field_loads_as_default() {
        let json = r#"{
            "kind": "orca_tui",
            "agent_id": "cursor",
            "command": "/path/agent -f --trust"
        }"#;
        let cfg: LocalExecutorConfig = serde_json::from_str(json).unwrap();
        assert_eq!(cfg.model, None);
        assert_eq!(cfg.effective_command().unwrap(), "/path/agent -f --trust");
    }

    #[test]
    fn executor_config_with_model_round_trips() {
        let cfg = LocalExecutorConfig::new_with_model(
            "cursor".into(),
            "/path/agent -f --trust".into(),
            Some("gpt-5".into()),
        )
        .unwrap();
        let json = serde_json::to_string(&cfg).unwrap();
        assert!(json.contains("\"model\":\"gpt-5\""));
        let back: LocalExecutorConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back, cfg);
        // None model is omitted from serialization
        let none_json = serde_json::to_string(
            &LocalExecutorConfig::new("cursor".into(), "agent".into()).unwrap(),
        )
        .unwrap();
        assert!(!none_json.contains("model"));
    }

    #[test]
    fn config_v2_without_model_field_loads_unchanged() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("config.json");
        let v2_json = r#"{
            "schema_version": 2,
            "server_url": "https://ceo.example.com",
            "targets": {
                "t1": {
                    "workspace_id": "ws-1",
                    "alias": "repo1",
                    "kind": "coding",
                    "local_path": "/tmp/repo1",
                    "executor": {
                        "kind": "orca_tui",
                        "agent_id": "cursor",
                        "command": "/path/agent -f --trust"
                    }
                }
            }
        }"#;
        std::fs::write(&path, v2_json).unwrap();
        let loaded = LocalConfig::load(&path).unwrap().unwrap();
        let exec = loaded.targets.get("t1").unwrap().executor.as_ref().unwrap();
        assert_eq!(exec.model, None);
    }

    #[test]
    fn v1_to_v2_migration() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("config.json");
        let v1_json = r#"{
            "schema_version": 1,
            "server_url": "https://ceo.example.com",
            "targets": {
                "t1": {
                    "workspace_id": "ws-1",
                    "alias": "repo1",
                    "kind": "github_repo",
                    "local_path": "/tmp/repo1"
                }
            }
        }"#;
        std::fs::write(&path, v1_json).unwrap();

        let loaded = LocalConfig::load(&path).unwrap().unwrap();
        assert_eq!(loaded.schema_version, 2);
        assert_eq!(loaded.targets.len(), 1);
        let t1 = loaded.targets.get("t1").unwrap();
        assert_eq!(t1.alias, "repo1");
        assert!(t1.executor.is_none());
    }
}
