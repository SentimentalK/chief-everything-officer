use base64::Engine;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;

use crate::client::{ClientError, ConnectorClient, EnrollmentPollOutcome};
use crate::config::{normalize_server_origin, ConfigError, LocalConfig};
use crate::credential::{CredentialError, DeviceCredential};
use crate::local_state::{atomic_write_json, remove_durable, ExecutionLock};
use crate::paths::ConnectorPaths;

pub const ENROLLMENT_SCHEMA_VERSION: u32 = 1;

#[derive(Error, Debug)]
pub enum EnrollmentError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("Local state invalid: {0}")]
    LocalStateInvalid(String),
    #[error("Cannot switch server origin from '{existing}' to '{requested}': local state is server-bound")]
    ServerOriginMismatch { existing: String, requested: String },
    #[error("Enrollment denied by user")]
    AccessDenied,
    #[error("Enrollment expired")]
    Expired,
    #[error("Enrollment not found on server")]
    NotFound,
    #[error("Reserved ID mismatch: server returned device '{actual_dev}' / cred '{actual_cred}', but reserved '{reserved_dev}' / '{reserved_cred}'")]
    ReservedIdMismatch {
        reserved_dev: String,
        reserved_cred: String,
        actual_dev: String,
        actual_cred: String,
    },
    #[error("Cannot logout while active attempt or pending report outbox exists (UNRESOLVED_EXECUTION_STATE)")]
    UnresolvedExecutionState,
    #[error("Unsupported schema version: {0}")]
    UnsupportedSchemaVersion(u32),
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PendingEnrollmentSession {
    pub schema_version: u32,
    pub server_origin: String,
    pub device_code: String,
    pub user_code: String,
    pub reserved_device_id: String,
    pub reserved_credential_id: String,
    pub secret: String,
    pub expires_at_ms: i64,
    pub poll_interval_seconds: u64,
}

impl fmt::Debug for PendingEnrollmentSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PendingEnrollmentSession")
            .field("schema_version", &self.schema_version)
            .field("server_origin", &self.server_origin)
            .field("device_code", &"[REDACTED]")
            .field("user_code", &self.user_code)
            .field("reserved_device_id", &self.reserved_device_id)
            .field("reserved_credential_id", &self.reserved_credential_id)
            .field("secret", &"[REDACTED]")
            .field("expires_at_ms", &self.expires_at_ms)
            .field("poll_interval_seconds", &self.poll_interval_seconds)
            .finish()
    }
}

impl PendingEnrollmentSession {
    pub fn is_expired(&self, now_ms: i64) -> bool {
        self.expires_at_ms <= now_ms
    }

    pub fn load(path: &Path) -> Result<Option<Self>, EnrollmentError> {
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let session: PendingEnrollmentSession = serde_json::from_str(&content)?;
        if session.schema_version != ENROLLMENT_SCHEMA_VERSION {
            return Err(EnrollmentError::UnsupportedSchemaVersion(
                session.schema_version,
            ));
        }
        normalize_server_origin(&session.server_origin)?;
        Ok(Some(session))
    }

    pub fn save(&self, path: &Path) -> Result<(), EnrollmentError> {
        normalize_server_origin(&self.server_origin)?;
        atomic_write_json(path, self)?;
        Ok(())
    }
}

pub fn now_utc_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn generate_secret_and_digest() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let secret = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);

    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    let digest = format!("{:x}", hasher.finalize());

    (secret, digest)
}

pub fn default_platform() -> &'static str {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        "linux-x86_64"
    }
    #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
    {
        "linux-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "macos-aarch64"
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "aarch64")
    )))]
    {
        "unknown"
    }
}

/// Executes the `ceo-connector login` flow with crash recovery and coexistence rules.
pub async fn login_flow(
    paths: &ConnectorPaths,
    server_input: &str,
    display_name_override: Option<String>,
    no_open: bool,
) -> Result<(), EnrollmentError> {
    paths.ensure_dirs()?;
    let server_origin = normalize_server_origin(server_input)?;
    let client = ConnectorClient::new(&server_origin)?;

    // 1. Single Server Origin Check:
    // If config.json already exists for another server and has targets/credential/state, reject.
    if let Some(cfg) = LocalConfig::load(&paths.config_file())? {
        if cfg.server_url != server_origin {
            let has_targets = !cfg.targets.is_empty();
            let has_cred = paths.credential_file().exists();
            let has_active = paths.active_attempt_file().exists();
            let has_outbox =
                paths.outbox_dir().exists() && fs::read_dir(paths.outbox_dir())?.next().is_some();

            if has_targets || has_cred || has_active || has_outbox {
                return Err(EnrollmentError::ServerOriginMismatch {
                    existing: cfg.server_url,
                    requested: server_origin,
                });
            }
        }
    }

    // 2. Coexistence Check:
    let existing_cred = DeviceCredential::load(&paths.credential_file())?;
    let pending_session = PendingEnrollmentSession::load(&paths.enrollment_file())?;

    if let (Some(cred), Some(sess)) = (&existing_cred, &pending_session) {
        if cred.server_origin != sess.server_origin {
            return Err(EnrollmentError::LocalStateInvalid(
                "credential and pending enrollment reference different server origins".into(),
            ));
        }

        match client.identity(cred).await {
            Ok(ident) => {
                if ident.device.id == cred.device_id && ident.credential.id == cred.credential_id {
                    // Credential is valid and authoritative!
                    if sess.reserved_device_id == cred.device_id
                        && sess.reserved_credential_id == cred.credential_id
                    {
                        // Clean up stale enrollment session.
                        let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                        remove_durable(&paths.enrollment_file())?;
                    } else {
                        return Err(EnrollmentError::LocalStateInvalid(
                            "stale enrollment reserved IDs conflict with active valid credential"
                                .into(),
                        ));
                    }
                    println!("Already logged in as device '{}'.", cred.device_id);
                    return Ok(());
                }
            }
            Err(ClientError::Unauthorized) => {
                // Credential is dead.
            }
            Err(e) => return Err(EnrollmentError::Client(e)),
        }
    } else if let Some(cred) = &existing_cred {
        if cred.server_origin == server_origin {
            match client.identity(cred).await {
                Ok(ident) => {
                    if ident.device.id == cred.device_id
                        && ident.credential.id == cred.credential_id
                    {
                        println!("Already logged in as device '{}'.", cred.device_id);
                        return Ok(());
                    }
                }
                Err(ClientError::Unauthorized) => {
                    // Credential is dead.
                }
                Err(e) => return Err(EnrollmentError::Client(e)),
            }
        }
    }

    // 3. Resolve or Initiate Pending Enrollment:
    let session = if let Some(sess) = pending_session {
        if sess.server_origin == server_origin && !sess.is_expired(now_utc_ms()) {
            println!(
                "Resuming existing pending enrollment for server: {}",
                sess.server_origin
            );
            sess
        } else {
            remove_durable(&paths.enrollment_file())?;
            create_fresh_enrollment(paths, &client, &server_origin, display_name_override).await?
        }
    } else {
        create_fresh_enrollment(paths, &client, &server_origin, display_name_override).await?
    };

    println!();
    println!("============================================================");
    println!("  CEO Connector Device Enrollment");
    println!("============================================================");
    println!("  User Code:        {}", session.user_code);
    println!("  Reserved Device:  {}", session.reserved_device_id);
    println!(
        "  Verification URL: {}/connector/enroll?user_code={}",
        session.server_origin, session.user_code
    );
    println!("============================================================");
    println!();

    if !no_open {
        let url = format!(
            "{}/connector/enroll?user_code={}",
            session.server_origin, session.user_code
        );
        // Best-effort open in browser
        let _ = std::process::Command::new("xdg-open").arg(&url).spawn();
    }

    // 4. Poll Loop:
    let mut interval = session.poll_interval_seconds.max(2);
    let device_code = session.device_code.clone();

    loop {
        if session.is_expired(now_utc_ms()) {
            remove_durable(&paths.enrollment_file())?;
            return Err(EnrollmentError::Expired);
        }

        tokio::time::sleep(Duration::from_secs(interval)).await;

        match client.poll_enrollment_token(&device_code).await? {
            EnrollmentPollOutcome::Pending => {
                // Keep waiting
            }
            EnrollmentPollOutcome::SlowDown => {
                interval += 5;
            }
            EnrollmentPollOutcome::AccessDenied => {
                remove_durable(&paths.enrollment_file())?;
                return Err(EnrollmentError::AccessDenied);
            }
            EnrollmentPollOutcome::Expired => {
                remove_durable(&paths.enrollment_file())?;
                return Err(EnrollmentError::Expired);
            }
            EnrollmentPollOutcome::NotFound => {
                remove_durable(&paths.enrollment_file())?;
                return Err(EnrollmentError::NotFound);
            }
            EnrollmentPollOutcome::InvalidGrant => {
                remove_durable(&paths.enrollment_file())?;
                return Err(EnrollmentError::LocalStateInvalid(
                    "server returned invalid_grant".into(),
                ));
            }
            EnrollmentPollOutcome::Approved(token_resp) => {
                // Verify returned IDs match reserved IDs!
                if token_resp.device.id != session.reserved_device_id
                    || token_resp.credential.id != session.reserved_credential_id
                {
                    return Err(EnrollmentError::ReservedIdMismatch {
                        reserved_dev: session.reserved_device_id,
                        reserved_cred: session.reserved_credential_id,
                        actual_dev: token_resp.device.id,
                        actual_cred: token_resp.credential.id,
                    });
                }

                // Construct Bearer token and verify identity with server!
                let candidate_cred = DeviceCredential::new(
                    session.server_origin.clone(),
                    "".into(), // user_id will be populated from GET /identity
                    session.reserved_device_id.clone(),
                    session.reserved_credential_id.clone(),
                    session.secret.clone(),
                    token_resp.credential.expires_at_ms,
                )?;

                let ident = client.identity(&candidate_cred).await?;
                if ident.device.id != session.reserved_device_id
                    || ident.credential.id != session.reserved_credential_id
                {
                    return Err(EnrollmentError::ReservedIdMismatch {
                        reserved_dev: session.reserved_device_id,
                        reserved_cred: session.reserved_credential_id,
                        actual_dev: ident.device.id,
                        actual_cred: ident.credential.id,
                    });
                }

                let final_cred = DeviceCredential::new(
                    session.server_origin.clone(),
                    ident.user_id,
                    ident.device.id,
                    ident.credential.id,
                    session.secret.clone(),
                    ident.credential.expires_at_ms,
                )?;

                // Persist credential under state.lock
                let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;
                final_cred.save(&paths.credential_file())?;

                // Update config with server_url
                let mut config = LocalConfig::load(&paths.config_file())?
                    .unwrap_or_else(|| LocalConfig::new(session.server_origin.clone()).unwrap());
                config.server_url = session.server_origin.clone();
                config.save(&paths.config_file())?;

                // Durably remove enrollment.json
                remove_durable(&paths.enrollment_file())?;

                println!(
                    "Successfully authenticated as device '{}'!",
                    final_cred.device_id
                );
                return Ok(());
            }
        }
    }
}

async fn create_fresh_enrollment(
    paths: &ConnectorPaths,
    client: &ConnectorClient,
    server_origin: &str,
    display_name_override: Option<String>,
) -> Result<PendingEnrollmentSession, EnrollmentError> {
    let hostname = std::env::var("HOSTNAME").unwrap_or_else(|_| "unknown-device".into());
    let display_name = display_name_override.unwrap_or(hostname);
    let platform = default_platform();

    let (secret, digest) = generate_secret_and_digest();
    let begin_resp = client
        .begin_enrollment(&display_name, platform, &digest)
        .await?;

    let expires_at_ms = now_utc_ms() + (begin_resp.expires_in as i64 * 1000);
    let session = PendingEnrollmentSession {
        schema_version: ENROLLMENT_SCHEMA_VERSION,
        server_origin: server_origin.to_string(),
        device_code: begin_resp.device_code,
        user_code: begin_resp.user_code,
        reserved_device_id: begin_resp.device_id,
        reserved_credential_id: begin_resp.credential_id,
        secret,
        expires_at_ms,
        poll_interval_seconds: begin_resp.interval,
    };

    // Durably write BEFORE returning or opening browser!
    session.save(&paths.enrollment_file())?;
    Ok(session)
}

/// Executes the `ceo-connector logout` flow with active attempt and outbox safety checks.
pub async fn logout_flow(paths: &ConnectorPaths) -> Result<(), EnrollmentError> {
    let cred = match DeviceCredential::load(&paths.credential_file())? {
        Some(c) => c,
        None => {
            println!("No credential found. Already logged out.");
            return Ok(());
        }
    };

    let client = ConnectorClient::new(&cred.server_origin)?;

    // Acquire state.lock to serialize with daemon and ensure no concurrent attempt starts
    let _lock = ExecutionLock::acquire(&paths.state_lock_file())?;

    // Check active attempt and outbox
    if paths.active_attempt_file().exists() {
        return Err(EnrollmentError::UnresolvedExecutionState);
    }

    if paths.outbox_dir().exists() {
        let mut entries = fs::read_dir(paths.outbox_dir())?;
        if entries.next().is_some() {
            return Err(EnrollmentError::UnresolvedExecutionState);
        }
    }

    // Call server revocation
    match client.self_revoke(&cred).await {
        Ok(()) => {
            remove_durable(&paths.credential_file())?;
            println!("Device credential successfully revoked and removed locally.");
            Ok(())
        }
        Err(ClientError::Unauthorized) => {
            // Already revoked on server, safe to remove locally
            remove_durable(&paths.credential_file())?;
            println!("Device was already revoked on server. Local credential removed.");
            Ok(())
        }
        Err(e) => {
            // Transport or 5xx: DO NOT remove credential!
            Err(EnrollmentError::Client(e))
        }
    }
}
