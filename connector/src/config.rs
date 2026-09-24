use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use thiserror::Error;
use url::Url;

use crate::local_state::atomic_write_json;

pub const CONFIG_SCHEMA_VERSION: u32 = 1;

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalTarget {
    pub workspace_id: String,
    pub alias: String,
    pub kind: String,
    pub local_path: String,
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
        let config: LocalConfig = serde_json::from_str(&content)?;
        if config.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedSchemaVersion(config.schema_version));
        }
        // Ensure server_url in file is a valid normalized origin
        normalize_server_origin(&config.server_url)?;
        Ok(Some(config))
    }

    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        normalize_server_origin(&self.server_url)?;
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
            "schema_version": 1,
            "server_url": "https://ceo.example.com",
            "targets": {},
            "unknown_extra": true
        }"#;
        let res: Result<LocalConfig, _> = serde_json::from_str(bad_json);
        assert!(res.is_err());
    }
}
