//! Bridge connection configuration and API-key loading.
//!
//! A `BridgeConfig` is deliberately separate from the Agent `WorkerConfig`:
//! it carries only what the worker needs to reach the identity-scoped server
//! bridge over HTTPS. Parsing is strict (`deny_unknown_fields`, version-locked,
//! absolute paths, validated URL) so a mistyped file fails loudly at the
//! `bridge check` boundary rather than silently pointing the worker elsewhere.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use url::{Host, Url};

/// Regex-aligned workspace alias (matches the server WORKSPACE_REF_RE).
const WORKSPACE_ALIAS_RE: &str = r"^[A-Za-z0-9_-]{1,64}$";

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ConfigError {
    #[error("failed to read config file: {0}")]
    Io(String),
    #[error("config is not valid JSON: {0}")]
    InvalidJson(String),
    #[error("unsupported schema_version {0}; only 1 is accepted")]
    UnsupportedSchema(u32),
    #[error("invalid server_url: {0}")]
    BadServerUrl(String),
    #[error("server_url must not carry credentials, query, or a non-root path")]
    UrlMustBeOrigin,
    #[error("only HTTPS server_url is allowed; HTTP is accepted solely for the literal loopback addresses 127.0.0.1 / [::1]")]
    InsecureScheme,
    #[error("api_key_file must be an absolute path")]
    ApiKeyNotAbsolute,
    #[error("workspace path for alias {0} must be an absolute path")]
    WorkspaceNotAbsolute(String),
    #[error("workspace path for alias {0} does not exist or is not a directory: {1}")]
    WorkspaceMissing(String, String),
    #[error("workspace alias {0} is invalid: {1}")]
    InvalidAlias(String, String),
    #[error("two aliases map to the same canonical directory: {0}")]
    DuplicateCanonicalDir(String),
    #[error("expected_identity.user_id and workspace_id must be non-empty")]
    InvalidExpectedIdentity,
    #[error("api key error: {0}")]
    ApiKey(String),
}

/// Identity binding the client expects the server to confirm via /api/identity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExpectedIdentity {
    pub user_id: String,
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RawConfig {
    schema_version: u32,
    server_url: String,
    api_key_file: PathBuf,
    expected_identity: ExpectedIdentity,
    workspaces: BTreeMap<String, PathBuf>,
}

/// A validated, ready-to-use bridge configuration.
#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub server_base: Url,
    pub api_key_file: PathBuf,
    pub expected_identity: ExpectedIdentity,
    /// workspace alias -> canonical, existing directory (absolute).
    pub workspaces: BTreeMap<String, PathBuf>,
}

/// Validates the URL scheme/host and returns the origin-style base.
fn validate_base(raw: &str) -> Result<Url, ConfigError> {
    let url = Url::parse(raw).map_err(|e| ConfigError::BadServerUrl(e.to_string()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(ConfigError::UrlMustBeOrigin);
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(ConfigError::UrlMustBeOrigin);
    }
    if !matches!(url.path(), "" | "/") {
        return Err(ConfigError::UrlMustBeOrigin);
    }
    let loopback = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        _ => false,
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => return Err(ConfigError::InsecureScheme),
    }
    // Normalize to an origin (drop any empty path).
    let mut base = url;
    if base.path() == "/" {
        base.set_path("");
    }
    Ok(base)
}

impl BridgeConfig {
    pub fn load(path: &Path) -> Result<BridgeConfig, ConfigError> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| ConfigError::Io(format!("{}: {}", path.display(), e)))?;
        Self::from_str(&text)
    }

    #[allow(clippy::should_implement_trait)] // parse boundary; keeps load/parse one call site
    pub fn from_str(text: &str) -> Result<BridgeConfig, ConfigError> {
        let raw: RawConfig =
            serde_json::from_str(text).map_err(|e| ConfigError::InvalidJson(e.to_string()))?;
        if raw.schema_version != 1 {
            return Err(ConfigError::UnsupportedSchema(raw.schema_version));
        }
        let server_base = validate_base(&raw.server_url)?;
        if !raw.api_key_file.is_absolute() {
            return Err(ConfigError::ApiKeyNotAbsolute);
        }
        if raw.expected_identity.user_id.trim().is_empty()
            || raw.expected_identity.workspace_id.trim().is_empty()
        {
            return Err(ConfigError::InvalidExpectedIdentity);
        }
        let alias_re = regex::Regex::new(WORKSPACE_ALIAS_RE).expect("static alias regex is valid");
        let mut workspaces: BTreeMap<String, PathBuf> = BTreeMap::new();
        let mut canonical_to_alias: BTreeMap<PathBuf, String> = BTreeMap::new();
        for (alias, path) in &raw.workspaces {
            if !alias_re.is_match(alias) {
                return Err(ConfigError::InvalidAlias(
                    alias.clone(),
                    "must be 1-64 [A-Za-z0-9_-]".to_string(),
                ));
            }
            if !path.is_absolute() {
                return Err(ConfigError::WorkspaceNotAbsolute(alias.clone()));
            }
            let canon = path
                .canonicalize()
                .map_err(|e| ConfigError::WorkspaceMissing(alias.clone(), e.to_string()))?;
            if !canon.is_dir() {
                return Err(ConfigError::WorkspaceMissing(
                    alias.clone(),
                    "resolved path is not a directory".to_string(),
                ));
            }
            if let Some(existing) = canonical_to_alias.get(&canon) {
                return Err(ConfigError::DuplicateCanonicalDir(format!(
                    "{existing} and {alias}"
                )));
            }
            canonical_to_alias.insert(canon.clone(), alias.clone());
            workspaces.insert(alias.clone(), canon);
        }
        Ok(BridgeConfig {
            server_base,
            api_key_file: raw.api_key_file,
            expected_identity: raw.expected_identity,
            workspaces,
        })
    }

    pub fn resolve_workspace(&self, alias: &str) -> Option<&PathBuf> {
        self.workspaces.get(alias)
    }
}

/// An API key that never prints via `Debug` (only used for the Authorization
/// header). Holds a shared string so a Client can clone the secret cheaply.
#[derive(Clone)]
pub struct ApiKey(Arc<str>);

impl ApiKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn mode_allows_group_or_other(mode: u32) -> bool {
    mode & 0o077 != 0
}

/// Reads an API key from a file with strict local rules:
/// - the file must be owned by the current user,
/// - its permissions must not allow group/other read or write,
/// - content must be non-empty with no internal newline (a single trailing LF or
///   CRLF is allowed and stripped).
pub fn load_api_key(path: &Path) -> Result<ApiKey, ConfigError> {
    let meta = std::fs::metadata(path).map_err(|e| ConfigError::ApiKey(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = unsafe { libc::geteuid() };
        if meta.uid() != current {
            return Err(ConfigError::ApiKey(
                "key file is not owned by the current user".into(),
            ));
        }
        let mode = meta.mode();
        if mode_allows_group_or_other(mode) {
            return Err(ConfigError::ApiKey(
                "key file permissions must not allow group/other read or write (chmod 600/400)"
                    .into(),
            ));
        }
    }
    let bytes = std::fs::read(path).map_err(|e| ConfigError::ApiKey(e.to_string()))?;
    let mut text = String::from_utf8(bytes)
        .map_err(|_| ConfigError::ApiKey("key file is not valid UTF-8".into()))?;
    if text.ends_with("\r\n") {
        text.truncate(text.len() - 2);
    } else if text.ends_with('\n') {
        text.truncate(text.len() - 1);
    }
    if text.is_empty() {
        return Err(ConfigError::ApiKey("key file is empty".into()));
    }
    if text.contains(['\n', '\r']) {
        return Err(ConfigError::ApiKey(
            "key file must contain a single line (no internal newline)".into(),
        ));
    }
    Ok(ApiKey(Arc::from(text)))
}

#[cfg(test)]
mod unit_tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, content: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, content).unwrap();
        p
    }

    fn sample_json(server: &str, key_file: &Path, dirs: &[(&str, &Path)]) -> String {
        let ws = dirs
            .iter()
            .map(|(a, d)| format!("{:?}: {:?}", a, d.display().to_string()))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            r#"{{
              "schema_version": 1,
              "server_url": {server:?},
              "api_key_file": {:?},
              "expected_identity": {{ "user_id": "usr_1", "workspace_id": "ws_1" }},
              "workspaces": {{ {ws} }}
            }}"#,
            key_file.display().to_string(),
            server = server
        )
    }

    #[test]
    fn accepts_valid_https_config() {
        let t = tempfile::tempdir().unwrap();
        let d1 = t.path().join("tools");
        fs::create_dir(&d1).unwrap();
        let key = write(t.path(), "key", "sekret\n");
        let cfg = BridgeConfig::from_str(&sample_json(
            "https://ceo.example.com",
            &key,
            &[("tools", &d1)],
        ))
        .unwrap();
        assert_eq!(cfg.workspaces.len(), 1);
        assert_eq!(cfg.server_base.scheme(), "https");
    }

    #[test]
    fn rejects_unknown_fields() {
        let bad = r#"{"schema_version":1,"server_url":"https://x.example","api_key_file":"/x","expected_identity":{"user_id":"a","workspace_id":"b"},"workspaces":{},"extra":1}"#;
        assert!(BridgeConfig::from_str(bad).is_err());
    }

    #[test]
    fn rejects_bad_schema_version() {
        let bad = r#"{"schema_version":2,"server_url":"https://x.example","api_key_file":"/x","expected_identity":{"user_id":"a","workspace_id":"b"},"workspaces":{}}"#;
        assert!(matches!(
            BridgeConfig::from_str(bad),
            Err(ConfigError::UnsupportedSchema(2))
        ));
    }

    #[test]
    fn rejects_https_required_but_http_loopback_ok() {
        fn cfg(url: &str) -> Result<BridgeConfig, ConfigError> {
            BridgeConfig::from_str(&format!(
                r#"{{"schema_version":1,"server_url":"{url}","api_key_file":"/tmp/k","expected_identity":{{"user_id":"a","workspace_id":"b"}},"workspaces":{{}}}}"#
            ))
        }
        // public http host rejected
        assert!(matches!(
            cfg("http://ceo.example.com"),
            Err(ConfigError::InsecureScheme)
        ));
        // loopback http accepted
        assert!(cfg("http://127.0.0.1:8080").is_ok());
        assert!(cfg("http://[::1]:8080").is_ok());
        assert!(cfg("https://ceo.example.com").is_ok());
    }

    #[test]
    fn rejects_url_with_credentials_or_path() {
        fn cfg(url: &str) -> Result<BridgeConfig, ConfigError> {
            BridgeConfig::from_str(&format!(
                r#"{{"schema_version":1,"server_url":"{url}","api_key_file":"/tmp/k","expected_identity":{{"user_id":"a","workspace_id":"b"}},"workspaces":{{}}}}"#
            ))
        }
        assert!(matches!(
            cfg("https://u:p@ceo.example.com"),
            Err(ConfigError::UrlMustBeOrigin)
        ));
        assert!(matches!(
            cfg("https://ceo.example.com/deep/path"),
            Err(ConfigError::UrlMustBeOrigin)
        ));
        assert!(matches!(
            cfg("https://ceo.example.com?x=1"),
            Err(ConfigError::UrlMustBeOrigin)
        ));
    }

    #[test]
    fn requires_absolute_paths_and_existing_dirs() {
        let t = tempfile::tempdir().unwrap();
        let d1 = t.path().join("tools");
        fs::create_dir(&d1).unwrap();
        // relative key path (bare, not under an absolute tempdir)
        let rel_cfg = format!(
            r#"{{"schema_version":1,"server_url":"https://x.example","api_key_file":"key","expected_identity":{{"user_id":"a","workspace_id":"b"}},"workspaces":{{"tools":{:?}}}}}"#,
            d1.display().to_string()
        );
        assert!(matches!(
            BridgeConfig::from_str(&rel_cfg),
            Err(ConfigError::ApiKeyNotAbsolute)
        ));
        // nonexistent workspace dir
        let miss_cfg = format!(
            r#"{{"schema_version":1,"server_url":"https://x.example","api_key_file":"/tmp/k","expected_identity":{{"user_id":"a","workspace_id":"b"}},"workspaces":{{"tools":{:?}}}}}"#,
            t.path().join("nope").display().to_string()
        );
        assert!(matches!(
            BridgeConfig::from_str(&miss_cfg),
            Err(ConfigError::WorkspaceMissing(_, _))
        ));
    }

    #[test]
    fn rejects_duplicate_canonical_dir() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path().join("shared");
        fs::create_dir(&d).unwrap();
        let cfg = format!(
            r#"{{"schema_version":1,"server_url":"https://x.example","api_key_file":{k:?},"expected_identity":{{"user_id":"a","workspace_id":"b"}},"workspaces":{{"a":{d:?},"b":{d:?}}}}}"#,
            d = d.display().to_string(),
            k = t.path().join("key").display().to_string(),
        );
        assert!(matches!(
            BridgeConfig::from_str(&cfg),
            Err(ConfigError::DuplicateCanonicalDir(_))
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_invalid_key_files() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();

        let empty = write(t.path(), "empty", "");
        assert!(load_api_key(&empty).is_err());

        let inner = write(t.path(), "inner", "a\nb");
        assert!(load_api_key(&inner).is_err());

        // group-readable -> rejected
        let permissive = write(t.path(), "perm", "sekret\n");
        fs::set_permissions(&permissive, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load_api_key(&permissive).is_err());

        // 600 -> accepted; content has single trailing LF stripped.
        let ok = write(t.path(), "ok600", "sekret\n");
        fs::set_permissions(&ok, fs::Permissions::from_mode(0o600)).unwrap();
        let key = load_api_key(&ok).unwrap();
        assert_eq!(key.as_str(), "sekret");
    }
}
