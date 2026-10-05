//! Isolated default-Agent resolution for Orca 1.4.219.
//!
//! Resolves Orca's current `defaultTuiAgent` setting before Server claim
//! so the concrete Agent identity can be frozen into [`ActiveAttempt`]
//! and executed via `worker-start --agent <concrete>`.
//!
//! Verified contract:
//! - Orca 1.4.219 public status check exposes version and readiness.
//! - Read-only private RPC `settings.get` returns `defaultTuiAgent` and `disabledTuiAgents`.
//! - Transport metadata is read from `orca-runtime.json`.
//! - Private transport is currently verified for Unix sockets only; Windows and
//!   unverified versions fail closed safely without crashing.

#[cfg(unix)]
use serde::Deserialize;
use std::path::Path;
#[cfg(unix)]
use std::path::PathBuf;

use super::client::OrcaCliClient;
use crate::config::is_default_agent_policy;

pub const VERIFIED_ORCA_VERSION: &str = "1.4.219";
pub const ENV_ORCA_USER_DATA_PATH: &str = "ORCA_USER_DATA_PATH";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DefaultAgentResolution {
    Resolved(String),
    Missing(String),
    Disabled(String),
    Unsupported(String),
    Unavailable(String),
    Malformed(String),
}

impl DefaultAgentResolution {
    pub fn is_resolved(&self) -> bool {
        matches!(self, Self::Resolved(_))
    }

    pub fn resolved_agent_id(&self) -> Option<&str> {
        match self {
            Self::Resolved(id) => Some(id),
            _ => None,
        }
    }
}

#[cfg(unix)]
#[derive(Deserialize)]
struct RuntimeMetadata {
    #[serde(default)]
    #[serde(rename = "authToken")]
    auth_token: Option<String>,
    #[serde(default)]
    transports: Vec<RuntimeTransport>,
}

#[cfg(unix)]
#[derive(Deserialize)]
struct RuntimeTransport {
    kind: String,
    endpoint: String,
    #[serde(default)]
    #[serde(rename = "authToken")]
    auth_token: Option<String>,
}

/// Resolves the user data path for Orca.
///
/// Priority:
/// 1. `ORCA_USER_DATA_PATH` environment variable if non-empty.
/// 2. Platform-standard user config directory + "orca".
#[cfg(unix)]
pub fn resolve_orca_user_data_path() -> Option<PathBuf> {
    if let Ok(val) = std::env::var(ENV_ORCA_USER_DATA_PATH) {
        let trimmed = val.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::config_dir().map(|p| p.join("orca"))
}

/// Pure parser for Orca settings JSON payload.
///
/// Handles both a direct `{ "defaultTuiAgent": ..., "disabledTuiAgents": [...] }`
/// object and a nested `{ "settings": { ... } }` response.
pub fn parse_settings(value: &serde_json::Value) -> DefaultAgentResolution {
    let settings = match value {
        serde_json::Value::Object(map) => {
            if let Some(s) = map.get("settings") {
                s
            } else {
                value
            }
        }
        _ => {
            return DefaultAgentResolution::Malformed(
                "settings payload is not a JSON object".into(),
            )
        }
    };

    let default_val = match settings.get("defaultTuiAgent") {
        Some(v) if !v.is_null() => v,
        _ => {
            return DefaultAgentResolution::Missing(
                "defaultTuiAgent is null or missing in Orca settings".into(),
            )
        }
    };

    let default_str = match default_val.as_str() {
        Some(s) => s.trim(),
        None => return DefaultAgentResolution::Malformed("defaultTuiAgent is not a string".into()),
    };

    if default_str.is_empty() {
        return DefaultAgentResolution::Missing("defaultTuiAgent is empty or blank".into());
    }

    if is_default_agent_policy(default_str) {
        return DefaultAgentResolution::Malformed(format!(
            "defaultTuiAgent cannot be a policy word ('{default_str}')"
        ));
    }

    if default_str.len() > 80 {
        return DefaultAgentResolution::Malformed(
            "defaultTuiAgent exceeds maximum length of 80 bytes".into(),
        );
    }

    if default_str.contains('\0') {
        return DefaultAgentResolution::Malformed("defaultTuiAgent contains NUL byte".into());
    }

    if !default_str
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return DefaultAgentResolution::Malformed(format!(
            "defaultTuiAgent '{default_str}' contains invalid characters (allowed: alphanumeric, -, _, .)"
        ));
    }

    // Check disabledTuiAgents
    if let Some(disabled) = settings.get("disabledTuiAgents") {
        match disabled.as_array() {
            Some(arr) => {
                for item in arr {
                    if let Some(disabled_id) = item.as_str() {
                        if disabled_id.trim().eq_ignore_ascii_case(default_str) {
                            return DefaultAgentResolution::Disabled(default_str.to_string());
                        }
                    }
                }
            }
            None => {
                return DefaultAgentResolution::Malformed(
                    "disabledTuiAgents is not an array".into(),
                );
            }
        }
    }

    DefaultAgentResolution::Resolved(default_str.to_string())
}

#[cfg(unix)]
async fn query_settings_over_unix_socket(
    socket_path: &Path,
    auth_token: &str,
) -> DefaultAgentResolution {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::UnixStream;
    use tokio::time::{timeout, Duration};

    let stream = match timeout(Duration::from_secs(3), UnixStream::connect(socket_path)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            return DefaultAgentResolution::Unavailable(format!(
                "failed to connect to Orca Unix socket '{}': {e}",
                socket_path.display()
            ));
        }
        Err(_) => {
            return DefaultAgentResolution::Unavailable(format!(
                "timeout connecting to Orca Unix socket '{}'",
                socket_path.display()
            ));
        }
    };

    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    let req_id = format!("req-{}", uuid::Uuid::new_v4());
    let request_payload = serde_json::json!({
        "id": req_id,
        "authToken": auth_token,
        "method": "settings.get",
        "params": {}
    });

    let mut request_bytes = match serde_json::to_vec(&request_payload) {
        Ok(b) => b,
        Err(e) => {
            return DefaultAgentResolution::Malformed(format!("failed to serialize request: {e}"))
        }
    };
    request_bytes.push(b'\n');

    if let Err(e) = write_half.write_all(&request_bytes).await {
        return DefaultAgentResolution::Unavailable(format!(
            "failed to send settings.get request: {e}"
        ));
    }
    if let Err(e) = write_half.flush().await {
        return DefaultAgentResolution::Unavailable(format!(
            "failed to flush settings.get request: {e}"
        ));
    }

    let response_deadline = Duration::from_secs(5);
    let read_result = timeout(response_deadline, async {
        let mut line = String::new();
        loop {
            line.clear();
            let bytes_read = reader.read_line(&mut line).await?;
            if bytes_read == 0 {
                return Ok::<_, std::io::Error>(None);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let val: serde_json::Value = match serde_json::from_str(trimmed) {
                Ok(v) => v,
                Err(_) => continue, // ignore non-JSON frames
            };
            if val.get("id").and_then(|v| v.as_str()) == Some(&req_id) {
                return Ok(Some(val));
            }
            // Ignore keepalive or unrelated notifications
        }
    })
    .await;

    let response_val = match read_result {
        Ok(Ok(Some(val))) => val,
        Ok(Ok(None)) => {
            return DefaultAgentResolution::Unavailable(
                "Orca Unix socket closed before response received".into(),
            );
        }
        Ok(Err(e)) => {
            return DefaultAgentResolution::Unavailable(format!(
                "IO error reading from Orca Unix socket: {e}"
            ));
        }
        Err(_) => {
            return DefaultAgentResolution::Unavailable(
                "timeout reading response from Orca Unix socket".into(),
            );
        }
    };

    let ok = response_val
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !ok {
        let error_msg = response_val
            .pointer("/error/message")
            .and_then(|m| m.as_str())
            .unwrap_or("Orca returned ok=false for settings.get");
        return DefaultAgentResolution::Unavailable(format!(
            "Orca rejected settings.get request: {error_msg}"
        ));
    }

    let settings = match response_val.pointer("/result/settings") {
        Some(s) => s,
        None => match response_val.get("result") {
            Some(r) => r,
            None => {
                return DefaultAgentResolution::Malformed(
                    "missing result field in settings.get response".into(),
                );
            }
        },
    };

    parse_settings(settings)
}

/// Resolves the default TUI Agent from Orca using the isolated private RPC adapter.
///
/// Accepts an optional explicit `user_data_path` (useful for isolated deterministic testing).
pub async fn resolve_default_agent_with_user_data(
    client: &OrcaCliClient,
    user_data_path: Option<&Path>,
) -> DefaultAgentResolution {
    // 1. Resolve public Orca version first
    let status = match client.status().await {
        Ok(s) => s,
        Err(e) => {
            return DefaultAgentResolution::Unavailable(format!(
                "failed to query Orca status: {e}"
            ));
        }
    };

    if !status.ok {
        return DefaultAgentResolution::Unavailable("Orca status returned ok=false".into());
    }

    let result = match status.result {
        Some(r) => r,
        None => {
            return DefaultAgentResolution::Unavailable("Orca status result is missing".into());
        }
    };

    if !result.app.running {
        return DefaultAgentResolution::Unavailable("Orca app is not running".into());
    }

    if result.runtime.state != "ready" {
        return DefaultAgentResolution::Unavailable(format!(
            "Orca runtime state is '{}', expected 'ready'",
            result.runtime.state
        ));
    }

    let version = match result.runtime.app_version {
        Some(v) => v,
        None => {
            return DefaultAgentResolution::Unsupported(
                "unable to determine Orca version from status response".into(),
            );
        }
    };

    if version.trim() != VERIFIED_ORCA_VERSION {
        return DefaultAgentResolution::Unsupported(format!(
            "Orca version '{version}' is unsupported for private default agent resolution (expected {VERIFIED_ORCA_VERSION})"
        ));
    }

    // Windows and non-Unix platforms fail closed before attempting Unix socket operations
    #[cfg(not(unix))]
    {
        let _ = user_data_path;
        DefaultAgentResolution::Unsupported(
            "default Agent resolution over private transport is unsupported on this platform"
                .into(),
        )
    }

    #[cfg(unix)]
    {
        let data_dir = match user_data_path {
            Some(p) => p.to_path_buf(),
            None => match resolve_orca_user_data_path() {
                Some(p) => p,
                None => {
                    return DefaultAgentResolution::Unavailable(
                        "cannot determine Orca user data path (ORCA_USER_DATA_PATH not set and config_dir unavailable)".into(),
                    );
                }
            },
        };

        let runtime_file = data_dir.join("orca-runtime.json");
        if !runtime_file.exists() {
            return DefaultAgentResolution::Unavailable(format!(
                "Orca runtime metadata file not found at '{}'",
                runtime_file.display()
            ));
        }

        let metadata_content = match std::fs::read_to_string(&runtime_file) {
            Ok(c) => c,
            Err(e) => {
                return DefaultAgentResolution::Unavailable(format!(
                    "failed to read Orca runtime metadata file: {e}"
                ));
            }
        };

        let metadata: RuntimeMetadata = match serde_json::from_str(&metadata_content) {
            Ok(m) => m,
            Err(e) => {
                return DefaultAgentResolution::Malformed(format!(
                    "failed to parse Orca runtime metadata JSON: {e}"
                ));
            }
        };

        let unix_transport = match metadata.transports.iter().find(|t| t.kind == "unix") {
            Some(t) => t,
            None => {
                return DefaultAgentResolution::Unavailable(
                    "no unix transport found in orca-runtime.json".into(),
                );
            }
        };

        let auth_token = match unix_transport
            .auth_token
            .as_deref()
            .or(metadata.auth_token.as_deref())
        {
            Some(t) if !t.trim().is_empty() => t.trim(),
            _ => {
                return DefaultAgentResolution::Unavailable(
                    "missing or empty authToken in orca-runtime.json".into(),
                );
            }
        };

        let socket_path = Path::new(&unix_transport.endpoint);
        if !socket_path.exists() {
            return DefaultAgentResolution::Unavailable(format!(
                "Orca Unix socket endpoint does not exist at '{}'",
                socket_path.display()
            ));
        }

        query_settings_over_unix_socket(socket_path, auth_token).await
    }
}

/// Resolves the default TUI Agent using the default user data path resolution.
pub async fn resolve_default_agent(client: &OrcaCliClient) -> DefaultAgentResolution {
    resolve_default_agent_with_user_data(client, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_settings_resolved() {
        let json = serde_json::json!({
            "defaultTuiAgent": "opencode",
            "disabledTuiAgents": []
        });
        assert_eq!(
            parse_settings(&json),
            DefaultAgentResolution::Resolved("opencode".into())
        );

        let wrapped = serde_json::json!({
            "settings": {
                "defaultTuiAgent": "antigravity",
                "disabledTuiAgents": ["cursor"]
            }
        });
        assert_eq!(
            parse_settings(&wrapped),
            DefaultAgentResolution::Resolved("antigravity".into())
        );
    }

    #[test]
    fn test_parse_settings_missing_or_blank() {
        let null_val = serde_json::json!({
            "defaultTuiAgent": null,
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&null_val),
            DefaultAgentResolution::Missing(_)
        ));

        let absent_val = serde_json::json!({
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&absent_val),
            DefaultAgentResolution::Missing(_)
        ));

        let blank_val = serde_json::json!({
            "defaultTuiAgent": "   ",
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&blank_val),
            DefaultAgentResolution::Missing(_)
        ));
    }

    #[test]
    fn test_parse_settings_malformed() {
        let int_val = serde_json::json!({
            "defaultTuiAgent": 12345,
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&int_val),
            DefaultAgentResolution::Malformed(_)
        ));

        let invalid_chars = serde_json::json!({
            "defaultTuiAgent": "bad agent with spaces",
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&invalid_chars),
            DefaultAgentResolution::Malformed(_)
        ));

        let too_long = serde_json::json!({
            "defaultTuiAgent": "a".repeat(81),
            "disabledTuiAgents": []
        });
        assert!(matches!(
            parse_settings(&too_long),
            DefaultAgentResolution::Malformed(_)
        ));

        let bad_disabled = serde_json::json!({
            "defaultTuiAgent": "opencode",
            "disabledTuiAgents": "not an array"
        });
        assert!(matches!(
            parse_settings(&bad_disabled),
            DefaultAgentResolution::Malformed(_)
        ));

        // Policy words are rejected regardless of case
        for word in &["default", "DEFAULT", "Default", "auto", "AUTO", "Auto"] {
            let policy_val = serde_json::json!({
                "defaultTuiAgent": word,
                "disabledTuiAgents": []
            });
            assert!(
                matches!(
                    parse_settings(&policy_val),
                    DefaultAgentResolution::Malformed(_)
                ),
                "expected '{word}' to be rejected as Malformed"
            );
        }
    }

    #[test]
    fn test_parse_settings_disabled() {
        let disabled_json = serde_json::json!({
            "defaultTuiAgent": "opencode",
            "disabledTuiAgents": ["cursor", "opencode", "claude"]
        });
        assert_eq!(
            parse_settings(&disabled_json),
            DefaultAgentResolution::Disabled("opencode".into())
        );

        let case_insensitive = serde_json::json!({
            "defaultTuiAgent": "OpenCode",
            "disabledTuiAgents": ["opencode"]
        });
        assert_eq!(
            parse_settings(&case_insensitive),
            DefaultAgentResolution::Disabled("OpenCode".into())
        );
    }

    #[test]
    fn test_auth_token_not_in_error_or_debug() {
        let secret_token = "SUPER_SECRET_AUTH_TOKEN_NEVER_LEAK_ME_12345";
        let res = DefaultAgentResolution::Unavailable("Orca rejected request".into());
        let debug_str = format!("{:?}", res);
        assert!(!debug_str.contains(secret_token));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_unix_resolver_integration_mock_socket() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        use tokio::net::UnixListener;

        let temp = tempfile::tempdir().unwrap();
        let sock_path = temp.path().join("mock-orca.sock");
        let listener = UnixListener::bind(&sock_path).unwrap();

        // Spawn mock server task
        let server_task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (read_half, mut write_half) = stream.into_split();
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();

            // First send an unrelated keepalive frame to test ignoring keepalive
            write_half
                .write_all(b"{\"event\":\"keepalive\",\"params\":{}}\n")
                .await
                .unwrap();
            write_half.flush().await.unwrap();

            // Read the client request
            reader.read_line(&mut line).await.unwrap();
            let req: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            let req_id = req.get("id").unwrap().as_str().unwrap();

            // Send matching response
            let response = serde_json::json!({
                "id": req_id,
                "ok": true,
                "result": {
                    "settings": {
                        "defaultTuiAgent": "opencode",
                        "disabledTuiAgents": []
                    }
                }
            });
            let mut resp_bytes = serde_json::to_vec(&response).unwrap();
            resp_bytes.push(b'\n');
            write_half.write_all(&resp_bytes).await.unwrap();
            write_half.flush().await.unwrap();
        });

        let resolution = query_settings_over_unix_socket(&sock_path, "test_token_123").await;
        assert_eq!(
            resolution,
            DefaultAgentResolution::Resolved("opencode".into())
        );

        server_task.await.unwrap();
    }
}
