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
}

impl LocalExecutorConfig {
    pub fn new(agent_id: String, command: String) -> Result<Self, ConfigError> {
        let cfg = Self {
            kind: "orca_tui".to_string(),
            agent_id,
            command,
        };
        cfg.validate()?;
        Ok(cfg)
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
        Ok(())
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
