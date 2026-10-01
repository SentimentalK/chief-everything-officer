use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Duration;
use thiserror::Error;
use url::Url;

use crate::local_state::{atomic_write_json, ExecutionLock};
use crate::paths::ConnectorPaths;

/// Steady-state durable config schema (PROJECT-036 Slice 1B).
///
/// v3 stores ONLY Device-owned state: `local_path` and the local executor
/// configuration, keyed by the Server-owned immutable `target_id`. All
/// Server-owned Target metadata (workspace membership, alias/name, kind,
/// repository, disabled state, device binding, workspace default Agent
/// Runtime) lives exclusively in the Server catalogue.
pub const CONFIG_SCHEMA_VERSION: u32 = 3;

/// Legacy schema versions accepted ONLY as one-time migration inputs.
const LEGACY_SCHEMA_VERSION_V1: u32 = 1;
const LEGACY_SCHEMA_VERSION_V2: u32 = 2;

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
    #[error(
        "Local config uses legacy schema v{0}; it must be migrated to schema v3 before use. Run any `ceo-connector` command to perform the automatic one-time migration (CONFIG_SCHEMA_MIGRATION_REQUIRED)."
    )]
    LegacySchemaRequiresMigration(u32),
    #[error(
        "Refusing to write legacy schema version {0} to disk; only schema v3 may be persisted (CONFIG_SCHEMA_WRITE_REJECTED)."
    )]
    LegacyWriteRejected(u32),
    #[error(
        "Config schema migration could not acquire the local state lock. Close other Connector operations and retry (CONFIG_MIGRATION_LOCK_BUSY)."
    )]
    MigrationLockBusy,
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

/// Device-owned durable local Target state (schema v3 steady state).
///
/// Keyed by the Server-owned immutable `target_id` in `LocalConfig::targets`.
/// Deliberately contains NO Server-owned Target metadata: workspace_id,
/// alias/name, kind, repository, disabled state, bindings, and the workspace
/// default Agent Runtime relation are all owned by the Server catalogue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LocalTarget {
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

    /// Strict schema-v3 parser. This is the ONLY steady-state on-disk format.
    ///
    /// - v3 is parsed with `deny_unknown_fields` (strictness/security policy).
    /// - Legacy v1/v2 files are rejected with an actionable migration error;
    ///   they are handled exclusively by [`ensure_config_schema_current`].
    /// - Unknown future schema versions fail explicitly.
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

        match version {
            CONFIG_SCHEMA_VERSION => {}
            LEGACY_SCHEMA_VERSION_V1 | LEGACY_SCHEMA_VERSION_V2 => {
                return Err(ConfigError::LegacySchemaRequiresMigration(version));
            }
            other => return Err(ConfigError::UnsupportedSchemaVersion(other)),
        }

        let config: LocalConfig = serde_json::from_value(val)?;
        if config.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::UnsupportedSchemaVersion(config.schema_version));
        }
        for lt in config.targets.values() {
            if let Some(ref exec) = lt.executor {
                exec.validate()?;
            }
        }

        // Ensure server_url in file is a valid normalized origin
        normalize_server_origin(&config.server_url)?;
        Ok(Some(config))
    }

    /// Persists the config atomically. Only the steady-state schema v3 may be
    /// written; legacy versions are rejected explicitly (fail closed).
    pub fn save(&self, path: &Path) -> Result<(), ConfigError> {
        if self.schema_version != CONFIG_SCHEMA_VERSION {
            return Err(ConfigError::LegacyWriteRejected(self.schema_version));
        }
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

// ---------------------------------------------------------------------------
// Legacy schema parsing (transient migration inputs only)
// ---------------------------------------------------------------------------

/// v2 local target shape. Server-owned fields (workspace_id/alias/kind) are
/// parsed only so the old file can be read; they are dropped by the
/// migration and are never treated as authoritative truth.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyLocalTargetV2 {
    #[allow(dead_code)]
    workspace_id: String,
    #[allow(dead_code)]
    alias: String,
    #[allow(dead_code)]
    kind: String,
    local_path: String,
    executor: Option<LocalExecutorConfig>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyLocalConfigV2 {
    #[allow(dead_code)]
    schema_version: u32,
    server_url: String,
    #[serde(default)]
    targets: BTreeMap<String, LegacyLocalTargetV2>,
}

/// v1 local target shape (pre-executor era; no deny_unknown_fields,
/// matching the original v1 parser).
#[derive(Deserialize)]
struct LegacyLocalTargetV1 {
    #[allow(dead_code)]
    workspace_id: String,
    #[allow(dead_code)]
    alias: String,
    #[allow(dead_code)]
    kind: String,
    local_path: String,
}

#[derive(Deserialize)]
struct LegacyLocalConfigV1 {
    #[allow(dead_code)]
    schema_version: u32,
    server_url: String,
    #[serde(default)]
    targets: BTreeMap<String, LegacyLocalTargetV1>,
}

fn peek_schema_version(content: &str) -> Result<u32, ConfigError> {
    let val: serde_json::Value = serde_json::from_str(content)?;
    val.get("schema_version")
        .and_then(|v| v.as_u64())
        .map(|v| v as u32)
        .ok_or(ConfigError::UnsupportedSchemaVersion(0))
}

/// Converts a parsed legacy v2 config into the v3 steady-state shape.
///
/// Contract (PROJECT-036 Slice 1B):
/// - target_id map keys, local_path, executor kind/agent_id/command/model are
///   preserved exactly;
/// - Server-owned workspace_id/alias/kind are dropped (never validated as
///   present truth beyond what parsing the old shape requires);
/// - Device-owned executor state is validated; malformed Device-owned fields
///   fail closed BEFORE anything is written;
/// - no Server contact is made and no Server state is mutated.
fn migrate_legacy_v2(legacy: LegacyLocalConfigV2) -> Result<LocalConfig, ConfigError> {
    let server_url = normalize_server_origin(&legacy.server_url)?;
    let mut targets = BTreeMap::new();
    for (target_id, t) in legacy.targets {
        if let Some(ref exec) = t.executor {
            exec.validate()?;
        }
        targets.insert(
            target_id,
            LocalTarget {
                local_path: t.local_path,
                executor: t.executor,
            },
        );
    }
    Ok(LocalConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        server_url,
        targets,
    })
}

/// Converts a parsed legacy v1 config into the v3 steady-state shape
/// (v1 had no executor support; the migrated target has none configured).
fn migrate_legacy_v1(legacy: LegacyLocalConfigV1) -> Result<LocalConfig, ConfigError> {
    let server_url = normalize_server_origin(&legacy.server_url)?;
    let mut targets = BTreeMap::new();
    for (target_id, t) in legacy.targets {
        targets.insert(
            target_id,
            LocalTarget {
                local_path: t.local_path,
                executor: None,
            },
        );
    }
    Ok(LocalConfig {
        schema_version: CONFIG_SCHEMA_VERSION,
        server_url,
        targets,
    })
}

/// One-time deterministic migration of a legacy schema v1/v2 config file to
/// the schema v3 steady state. No-op when the file is absent or already v3.
///
/// Crash safety: the rewritten v3 file is published via the existing
/// `atomic_write_json` durability primitive (temp file + fsync + rename +
/// directory fsync). A crash at any point leaves either the original valid
/// legacy file or a complete v3 file — never a partial/corrupt config.
///
/// Concurrency safety: migration runs under the shared Connector
/// `state.lock` and RE-READS the file after acquiring the lock. If a
/// concurrent process already migrated the file (or a newer local mutation
/// landed), the on-disk version is no longer legacy and the migration is a
/// no-op — a stale migrated snapshot can never overwrite newer local config.
///
/// No migration markers/progress state are persisted; after a successful
/// rewrite the file on disk is plain schema v3 and future saves write v3 only.
pub fn ensure_config_schema_current(paths: &ConnectorPaths) -> Result<(), ConfigError> {
    let path = paths.config_file();
    if !path.exists() {
        return Ok(());
    }
    let version = peek_schema_version(&fs::read_to_string(&path)?)?;
    if version == CONFIG_SCHEMA_VERSION {
        return Ok(());
    }
    if !matches!(version, LEGACY_SCHEMA_VERSION_V1 | LEGACY_SCHEMA_VERSION_V2) {
        return Err(ConfigError::UnsupportedSchemaVersion(version));
    }

    // Only legacy files take the state lock (steady-state loads stay lock-free).
    let _lock = match ExecutionLock::acquire_with_retry(
        &paths.state_lock_file(),
        Duration::from_secs(3),
        Duration::from_millis(50),
    ) {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(ConfigError::MigrationLockBusy);
        }
        Err(e) => return Err(ConfigError::Io(e)),
    };

    // Re-read under the lock: another process may have migrated the file or
    // applied a newer local mutation in the meantime. Never clobber it.
    let version = peek_schema_version(&fs::read_to_string(&path)?)?;
    if version == CONFIG_SCHEMA_VERSION {
        return Ok(());
    }

    let content = fs::read_to_string(&path)?;
    match version {
        LEGACY_SCHEMA_VERSION_V2 => {
            let legacy: LegacyLocalConfigV2 = serde_json::from_str(&content)?;
            let migrated = migrate_legacy_v2(legacy)?;
            atomic_write_json(&path, &migrated)?;
        }
        LEGACY_SCHEMA_VERSION_V1 => {
            let legacy: LegacyLocalConfigV1 = serde_json::from_str(&content)?;
            let migrated = migrate_legacy_v1(legacy)?;
            atomic_write_json(&path, &migrated)?;
        }
        other => return Err(ConfigError::UnsupportedSchemaVersion(other)),
    }
    Ok(())
}

/// Migration-aware config load used by product code paths that are NOT
/// already holding the state lock: ensures the on-disk config is the v3
/// steady state, then parses it strictly. Paths executing under `state.lock`
/// must use the strict [`LocalConfig::load`] instead (re-locking would
/// self-deadlock).
pub fn load_current_config(paths: &ConnectorPaths) -> Result<Option<LocalConfig>, ConfigError> {
    ensure_config_schema_current(paths)?;
    LocalConfig::load(&paths.config_file())
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
///
/// This is the shared migration-aware profile entrypoint for product code:
/// any legacy v1/v2 config is first migrated to the schema v3 steady state.
pub fn load_bound_profile(paths: &ConnectorPaths) -> Result<BoundProfile, ProfileError> {
    let credential =
        DeviceCredential::load(&paths.credential_file())?.ok_or(ProfileError::NotLoggedIn)?;
    let config = match load_current_config(paths)? {
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
            "schema_version": 3,
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
    fn v2_without_model_field_migrates_to_v3_unchanged() {
        let temp_dir = tempfile::tempdir().unwrap();
        let paths = ConnectorPaths::from_root(temp_dir.path());
        paths.ensure_dirs().unwrap();
        let path = paths.config_file();
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
        ensure_config_schema_current(&paths).unwrap();
        // On-disk file is now schema v3.
        let loaded = LocalConfig::load(&path).unwrap().unwrap();
        assert_eq!(loaded.schema_version, 3);
        let exec = loaded.targets.get("t1").unwrap().executor.as_ref().unwrap();
        assert_eq!(exec.model, None);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.contains("\"schema_version\": 3"));
        assert!(!on_disk.contains("workspace_id"));
        assert!(!on_disk.contains("alias"));
    }

    #[test]
    fn v1_migrates_directly_to_v3() {
        let temp_dir = tempfile::tempdir().unwrap();
        let paths = ConnectorPaths::from_root(temp_dir.path());
        paths.ensure_dirs().unwrap();
        let path = paths.config_file();
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

        ensure_config_schema_current(&paths).unwrap();
        let loaded = LocalConfig::load(&path).unwrap().unwrap();
        assert_eq!(loaded.schema_version, 3);
        assert_eq!(loaded.targets.len(), 1);
        let t1 = loaded.targets.get("t1").unwrap();
        assert_eq!(t1.local_path, "/tmp/repo1");
        assert!(t1.executor.is_none());
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("workspace_id"));
        assert!(!on_disk.contains("alias"));
    }
}
