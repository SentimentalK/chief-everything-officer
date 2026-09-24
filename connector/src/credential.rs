use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::Path;
use thiserror::Error;

use crate::config::normalize_server_origin;
use crate::local_state::atomic_write_json;

pub const CREDENTIAL_SCHEMA_VERSION: u32 = 1;

#[derive(Error, Debug)]
pub enum CredentialError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Invalid server origin in credential: {0}")]
    InvalidOrigin(String),
    #[error("Unsupported schema version: {0}")]
    UnsupportedSchemaVersion(u32),
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeviceCredential {
    pub schema_version: u32,
    pub server_origin: String,
    pub user_id: String,
    pub device_id: String,
    pub credential_id: String,
    pub secret: String,
    pub expires_at_ms: i64,
}

impl fmt::Debug for DeviceCredential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DeviceCredential")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("user_id", &self.user_id)
            .field("device_id", &self.device_id)
            .field("credential_id", &self.credential_id)
            .field("secret", &"[REDACTED]")
            .field("expires_at_ms", &self.expires_at_ms)
            .finish()
    }
}

impl DeviceCredential {
    pub fn new(
        server_origin: String,
        user_id: String,
        device_id: String,
        credential_id: String,
        secret: String,
        expires_at_ms: i64,
    ) -> Result<Self, CredentialError> {
        let normalized = normalize_server_origin(&server_origin)
            .map_err(|e| CredentialError::InvalidOrigin(e.to_string()))?;
        Ok(Self {
            schema_version: CREDENTIAL_SCHEMA_VERSION,
            server_origin: normalized,
            user_id,
            device_id,
            credential_id,
            secret,
            expires_at_ms,
        })
    }

    pub fn bearer_token(&self) -> String {
        format!("ceo_dev1.{}.{}", self.credential_id, self.secret)
    }

    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms <= now_ms
    }

    pub fn load(path: &Path) -> Result<Option<Self>, CredentialError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let cred: DeviceCredential = serde_json::from_str(&content)?;
        if cred.schema_version != CREDENTIAL_SCHEMA_VERSION {
            return Err(CredentialError::UnsupportedSchemaVersion(
                cred.schema_version,
            ));
        }
        normalize_server_origin(&cred.server_origin)
            .map_err(|e| CredentialError::InvalidOrigin(e.to_string()))?;
        Ok(Some(cred))
    }

    pub fn save(&self, path: &Path) -> Result<(), CredentialError> {
        normalize_server_origin(&self.server_origin)
            .map_err(|e| CredentialError::InvalidOrigin(e.to_string()))?;
        atomic_write_json(path, self)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_secret() {
        let cred = DeviceCredential::new(
            "https://ceo.example.com".into(),
            "usr_123".into(),
            "dev_456".into(),
            "dcr_789".into(),
            "super-secret-key".into(),
            999999999,
        )
        .unwrap();

        let debug_str = format!("{:?}", cred);
        assert!(!debug_str.contains("super-secret-key"));
        assert!(debug_str.contains("[REDACTED]"));
        assert_eq!(cred.bearer_token(), "ceo_dev1.dcr_789.super-secret-key");
    }

    #[test]
    fn credential_deny_unknown_fields() {
        let bad_json = r#"{
            "schema_version": 1,
            "server_origin": "https://ceo.example.com",
            "user_id": "usr_1",
            "device_id": "dev_1",
            "credential_id": "dcr_1",
            "secret": "s",
            "expires_at_ms": 100,
            "extra": "bad"
        }"#;
        let res: Result<DeviceCredential, _> = serde_json::from_str(bad_json);
        assert!(res.is_err());
    }
}
