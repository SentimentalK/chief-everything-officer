use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CACHE_CONTROL, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use thiserror::Error;

use crate::config::normalize_server_origin;
use crate::credential::DeviceCredential;

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("Local credential server mismatch: config origin is '{expected}', but credential origin is '{actual}'")]
    LocalCredentialServerMismatch { expected: String, actual: String },

    #[error("Authentication required / 401 Unauthorized")]
    Unauthorized,

    #[error("Server unavailable (status {status}): {message}")]
    ServerUnavailable { status: u16, message: String },

    #[error("Target error: {code}: {message}")]
    TargetError { code: String, message: String },

    #[error("Job error: {code}: {message}")]
    JobError { code: String, message: String },

    #[error("Network/HTTP error: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Unexpected error response: status {status}, body: {body}")]
    UnexpectedResponse { status: u16, body: String },
}

#[derive(Debug, Clone)]
pub struct ConnectorClient {
    server_origin: String,
    http: reqwest::Client,
}

// ---------------------------------------------------------------------------
// DTOs (Tolerate additive unknown fields from Server)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnrollmentBeginResponse {
    pub device_code: String,
    pub user_code: String,
    pub device_id: String,
    pub credential_id: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollmentDevicePart {
    pub id: String,
    pub display_name: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollmentCredentialPart {
    pub id: String,
    pub expires_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EnrollmentTokenResponse {
    pub device: EnrollmentDevicePart,
    pub credential: EnrollmentCredentialPart,
    #[serde(default)]
    pub replayed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnrollmentPollOutcome {
    Pending,
    SlowDown,
    Approved(EnrollmentTokenResponse),
    AccessDenied,
    Expired,
    NotFound,
    InvalidGrant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceIdentityResponse {
    pub user_id: String,
    pub device: EnrollmentDevicePart,
    pub credential: EnrollmentCredentialPart,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceRepoPart {
    pub provider: String,
    pub external_id: String,
    pub full_name: String,
    pub branch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceItem {
    pub id: String,
    pub role: String,
    pub workspace_repository: Option<WorkspaceRepoPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspacesResponse {
    pub workspaces: Vec<WorkspaceItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetRepositoryPart {
    pub provider: String,
    pub external_id: String,
    pub full_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceBindingPart {
    pub id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorTargetProjection {
    pub target_id: String,
    pub workspace_id: String,
    pub alias: String,
    pub display_name: String,
    pub kind: String,
    pub repository: Option<TargetRepositoryPart>,
    pub disabled: bool,
    pub disabled_at: Option<String>,
    pub this_device_binding: Option<DeviceBindingPart>,
    pub active_binding_count: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetsResponse {
    pub targets: Vec<ConnectorTargetProjection>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterTargetInput {
    pub workspace_id: String,
    pub alias: String,
    pub display_name: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<RegisterTargetRepoSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterTargetRepoSource {
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterTargetResponse {
    pub target: ConnectorTargetProjectionTarget,
    pub binding: DeviceBindingPart,
    pub target_created: bool,
    pub binding_created: bool,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorTargetProjectionTarget {
    pub id: String,
    pub workspace_id: String,
    pub alias: String,
    pub display_name: String,
    pub kind: String,
    pub repository: Option<TargetRepositoryPart>,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BindTargetResponse {
    pub target_id: String,
    pub binding_id: String,
    pub enabled: bool,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingJobCandidate {
    pub job_id: String,
    pub target_id: String,
    pub workspace_id: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingJobsResponse {
    pub jobs: Vec<PendingJobCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimJobResponseJob {
    pub job_id: String,
    pub workspace_id: String,
    pub target_id: String,
    pub user_id: String,
    pub prompt: String,
    pub acceptance: Option<String>,
    pub resource_id: Option<String>,
    pub execution_timeout_seconds: u32,
    pub result_target: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimJobResponseAttempt {
    pub attempt_id: String,
    pub phase: String,
    pub claimed_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaimJobResponse {
    pub job: ClaimJobResponseJob,
    pub attempt: ClaimJobResponseAttempt,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartJobResponse {
    pub job_id: String,
    pub attempt_id: String,
    pub phase: String,
    pub started_at_ms: i64,
    pub replayed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportJobResponse {
    pub job_id: String,
    pub attempt_id: String,
    pub status: String,
    pub terminal: bool,
    pub replayed: bool,
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

impl ConnectorClient {
    pub fn new(server_origin: &str) -> Result<Self, ClientError> {
        let normalized = normalize_server_origin(server_origin).map_err(|e| {
            ClientError::UnexpectedResponse {
                status: 400,
                body: format!("Invalid server origin: {e}"),
            }
        })?;

        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;

        Ok(Self {
            server_origin: normalized,
            http,
        })
    }

    pub fn server_origin(&self) -> &str {
        &self.server_origin
    }

    fn check_origin(&self, credential: &DeviceCredential) -> Result<(), ClientError> {
        if self.server_origin != credential.server_origin {
            return Err(ClientError::LocalCredentialServerMismatch {
                expected: self.server_origin.clone(),
                actual: credential.server_origin.clone(),
            });
        }
        Ok(())
    }

    fn auth_headers(&self, credential: &DeviceCredential) -> Result<HeaderMap, ClientError> {
        self.check_origin(credential)?;
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
        let token = credential.bearer_token();
        let auth_val = HeaderValue::from_str(&format!("Bearer {}", token)).map_err(|_| {
            ClientError::UnexpectedResponse {
                status: 400,
                body: "Invalid character in Bearer token".into(),
            }
        })?;
        headers.insert(AUTHORIZATION, auth_val);
        Ok(headers)
    }

    // 1. Begin enrollment
    pub async fn begin_enrollment(
        &self,
        display_name: &str,
        platform: &str,
        credential_secret_sha256: &str,
    ) -> Result<EnrollmentBeginResponse, ClientError> {
        let url = format!("{}/api/connector/enrollments", self.server_origin);
        let body = serde_json::json!({
            "display_name": display_name,
            "platform": platform,
            "credential_secret_sha256": credential_secret_sha256,
        });

        let resp = self
            .http
            .post(&url)
            .header(CONTENT_TYPE, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: EnrollmentBeginResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 503 {
            Err(ClientError::ServerUnavailable {
                status: 503,
                message: text,
            })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 2. Poll enrollment token
    pub async fn poll_enrollment_token(
        &self,
        device_code: &str,
    ) -> Result<EnrollmentPollOutcome, ClientError> {
        let url = format!("{}/api/connector/enrollments/token", self.server_origin);
        let body = serde_json::json!({ "device_code": device_code });

        let resp = self
            .http
            .post(&url)
            .header(CONTENT_TYPE, "application/json")
            .header(CACHE_CONTROL, "no-store")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: EnrollmentTokenResponse = serde_json::from_str(&text)?;
            return Ok(EnrollmentPollOutcome::Approved(res));
        }

        if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(err) = err_json.get("error").and_then(|v| v.as_str()) {
                return match err {
                    "authorization_pending" => Ok(EnrollmentPollOutcome::Pending),
                    "slow_down" => Ok(EnrollmentPollOutcome::SlowDown),
                    "access_denied" => Ok(EnrollmentPollOutcome::AccessDenied),
                    "expired_token" => Ok(EnrollmentPollOutcome::Expired),
                    "enrollment_not_found" => Ok(EnrollmentPollOutcome::NotFound),
                    "invalid_grant" => Ok(EnrollmentPollOutcome::InvalidGrant),
                    _ => Err(ClientError::UnexpectedResponse {
                        status: status.as_u16(),
                        body: text,
                    }),
                };
            }
        }

        Err(ClientError::UnexpectedResponse {
            status: status.as_u16(),
            body: text,
        })
    }

    // 3. Identity verification
    pub async fn identity(
        &self,
        credential: &DeviceCredential,
    ) -> Result<DeviceIdentityResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/identity", self.server_origin);

        let resp = self.http.get(&url).headers(headers).send().await?;
        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: DeviceIdentityResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if status.is_server_error() {
            Err(ClientError::ServerUnavailable {
                status: status.as_u16(),
                message: text,
            })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 4. Self revoke
    pub async fn self_revoke(&self, credential: &DeviceCredential) -> Result<(), ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/device/revoke", self.server_origin);

        let resp = self.http.post(&url).headers(headers).send().await?;
        let status = resp.status();

        if status.is_success() || status.as_u16() == 401 {
            Ok(())
        } else if status.is_server_error() {
            let text = resp.text().await?;
            Err(ClientError::ServerUnavailable {
                status: status.as_u16(),
                message: text,
            })
        } else {
            let text = resp.text().await?;
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 5. Workspaces
    pub async fn list_workspaces(
        &self,
        credential: &DeviceCredential,
    ) -> Result<Vec<WorkspaceItem>, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/workspaces", self.server_origin);

        let resp = self.http.get(&url).headers(headers).send().await?;
        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: WorkspacesResponse = serde_json::from_str(&text)?;
            Ok(res.workspaces)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if status.is_server_error() {
            Err(ClientError::ServerUnavailable {
                status: status.as_u16(),
                message: text,
            })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 6. Targets catalog
    pub async fn list_targets(
        &self,
        credential: &DeviceCredential,
        workspace_id: Option<&str>,
    ) -> Result<Vec<ConnectorTargetProjection>, ClientError> {
        let headers = self.auth_headers(credential)?;
        let mut url = format!("{}/api/connector/targets", self.server_origin);
        if let Some(ws) = workspace_id {
            url.push_str(&format!("?workspace_id={}", ws));
        }

        let resp = self.http.get(&url).headers(headers).send().await?;
        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: TargetsResponse = serde_json::from_str(&text)?;
            Ok(res.targets)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if status.is_server_error() {
            Err(ClientError::ServerUnavailable {
                status: status.as_u16(),
                message: text,
            })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 7. Register target
    pub async fn register_target(
        &self,
        credential: &DeviceCredential,
        input: &RegisterTargetInput,
    ) -> Result<RegisterTargetResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/targets/register", self.server_origin);

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(input)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: RegisterTargetResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::TargetError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 8. Bind target
    pub async fn bind_target(
        &self,
        credential: &DeviceCredential,
        target_id: &str,
    ) -> Result<BindTargetResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!(
            "{}/api/connector/targets/{}/bind",
            self.server_origin, target_id
        );

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: BindTargetResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::TargetError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 9. Unbind target
    pub async fn unbind_target(
        &self,
        credential: &DeviceCredential,
        target_id: &str,
    ) -> Result<(), ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!(
            "{}/api/connector/targets/{}/unbind",
            self.server_origin, target_id
        );

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({}))
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            Ok(())
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::TargetError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 10. Pending jobs
    pub async fn pending_jobs(
        &self,
        credential: &DeviceCredential,
        limit: Option<usize>,
    ) -> Result<Vec<PendingJobCandidate>, ClientError> {
        let headers = self.auth_headers(credential)?;
        let mut url = format!("{}/api/connector/jobs/pending", self.server_origin);
        if let Some(l) = limit {
            url.push_str(&format!("?limit={}", l));
        }

        let resp = self.http.get(&url).headers(headers).send().await?;
        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: PendingJobsResponse = serde_json::from_str(&text)?;
            Ok(res.jobs)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if status.is_server_error() {
            Err(ClientError::ServerUnavailable {
                status: status.as_u16(),
                message: text,
            })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 11. Claim job
    pub async fn claim_job(
        &self,
        credential: &DeviceCredential,
        job_id: &str,
        attempt_id: &str,
        claim_token: &str,
    ) -> Result<ClaimJobResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/jobs/{}/claim", self.server_origin, job_id);
        let body = serde_json::json!({
            "attempt_id": attempt_id,
            "claim_token": claim_token,
        });

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: ClaimJobResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::JobError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 12. Start job
    pub async fn start_job(
        &self,
        credential: &DeviceCredential,
        job_id: &str,
        attempt_id: &str,
        claim_token: &str,
    ) -> Result<StartJobResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!("{}/api/connector/jobs/{}/start", self.server_origin, job_id);
        let body = serde_json::json!({
            "attempt_id": attempt_id,
            "claim_token": claim_token,
        });

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: StartJobResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::JobError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }

    // 13. Report job
    pub async fn report_job(
        &self,
        credential: &DeviceCredential,
        job_id: &str,
        attempt_id: &str,
        claim_token: &str,
        report: &serde_json::Value,
    ) -> Result<ReportJobResponse, ClientError> {
        let headers = self.auth_headers(credential)?;
        let url = format!(
            "{}/api/connector/jobs/{}/report",
            self.server_origin, job_id
        );
        let body = serde_json::json!({
            "attempt_id": attempt_id,
            "claim_token": claim_token,
            "report": report,
        });

        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await?;

        let status = resp.status();
        let text = resp.text().await?;

        if status.is_success() {
            let res: ReportJobResponse = serde_json::from_str(&text)?;
            Ok(res)
        } else if status.as_u16() == 401 {
            Err(ClientError::Unauthorized)
        } else if let Ok(err_json) = serde_json::from_str::<serde_json::Value>(&text) {
            let code = err_json
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let msg = err_json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            Err(ClientError::JobError { code, message: msg })
        } else {
            Err(ClientError::UnexpectedResponse {
                status: status.as_u16(),
                body: text,
            })
        }
    }
}
