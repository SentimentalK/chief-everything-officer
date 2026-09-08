//! Reusable async HTTPS client for the identity-scoped bridge.
//!
//! The client owns the transport policy (bounded connect + overall deadline, no
//! redirects/cookies/env-proxy, capped response body) and converts every
//! abnormal response into a structured `ClientError`. It never manufactures an
//! attempt id or lease token and never auto-retries a write request.

use crate::bridge::config::ApiKey;
use crate::bridge::protocol::{
    ClaimOk, ClaimRequest, Execution, IdentityInfo, LeaseOk, LeaseOperationRequest, Pending,
};
use futures_util::StreamExt;
use reqwest::StatusCode;
use std::error::Error;
use std::fmt;
use std::time::Duration;
use url::Url;

/// Response bodies are capped at this many bytes (checked while streaming, so a
/// lying Content-Length cannot defeat the limit).
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const TOTAL_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug)]
pub enum ErrorKind {
    /// HTTP 401 from the auth middleware.
    Unauthorized,
    /// HTTP 403 from the auth middleware.
    Forbidden,
    /// A 3xx response (redirects are never followed, so no credentials leak).
    Redirect(u16),
    /// 4xx/5xx business error; `code`/`reason` are preserved when the server
    /// supplied a legal envelope value (never a raw unknown message).
    Server {
        status: u16,
        code: String,
        reason: Option<String>,
    },
    /// The response did not conform to the protocol.
    Protocol(String),
    /// Response body exceeded the size cap.
    TooLarge,
    /// Network/connect/deadline failure.
    Transport(String),
    /// The live identity did not match the configured expected identity.
    IdentityMismatch { expected: String, actual: String },
}

#[derive(Debug)]
pub struct ClientError {
    pub kind: ErrorKind,
    /// True when the caller cannot know whether a *write* request took effect
    /// (transport fault or ambiguous success) and must retry the original
    /// request rather than treat it as failed.
    pub outcome_unknown: bool,
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.kind {
            ErrorKind::Unauthorized => write!(f, "authentication failed (401)"),
            ErrorKind::Forbidden => write!(f, "access denied (403)"),
            ErrorKind::Redirect(s) => write!(f, "server returned redirect {s}; not followed"),
            ErrorKind::Server {
                status,
                code,
                reason,
            } => {
                if let Some(r) = reason {
                    write!(f, "server error {status} code={code} reason={r}")
                } else {
                    write!(f, "server error {status} code={code}")
                }
            }
            ErrorKind::Protocol(m) => write!(f, "protocol error: {m}"),
            ErrorKind::TooLarge => write!(f, "response body exceeded the size limit"),
            ErrorKind::Transport(m) => write!(f, "connection/network error: {m}"),
            ErrorKind::IdentityMismatch { expected, actual } => {
                write!(f, "identity mismatch: expected {expected}, got {actual}")
            }
        }
    }
}

impl Error for ClientError {}

impl ClientError {
    fn transport(msg: String) -> Self {
        ClientError {
            kind: ErrorKind::Transport(msg),
            outcome_unknown: false,
        }
    }
    fn protocol(msg: impl Into<String>) -> Self {
        ClientError {
            kind: ErrorKind::Protocol(msg.into()),
            outcome_unknown: false,
        }
    }
    fn mark_unknown_write(mut self) -> Self {
        if matches!(self.kind, ErrorKind::Transport(_) | ErrorKind::Protocol(_)) {
            self.outcome_unknown = true;
        }
        self
    }
}

type CResult<T> = Result<T, ClientError>;

/// A reusable bridge client. Not `Debug` (holds the API key).
pub struct BridgeClient {
    http: reqwest::Client,
    base: Url,
    api_key: ApiKey,
}

impl BridgeClient {
    pub fn new(base: Url, api_key: ApiKey) -> CResult<BridgeClient> {
        let http = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(TOTAL_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|e| ClientError::transport(e.to_string()))?;
        Ok(BridgeClient {
            http,
            base,
            api_key,
        })
    }

    fn endpoint(&self, path: &str) -> CResult<Url> {
        let joined = format!("{}{}", self.base.as_str().trim_end_matches('/'), path);
        Url::parse(&joined).map_err(|e| ClientError::protocol(format!("bad endpoint: {e}")))
    }

    async fn send_get(&self, url: Url) -> CResult<reqwest::Response> {
        let req = self.http.get(url).bearer_auth(self.api_key.as_str());
        req.send().await.map_err(|e| {
            let msg = if e.is_timeout() {
                "request timed out".to_string()
            } else {
                e.to_string()
            };
            ClientError::transport(msg)
        })
    }

    async fn send_post(&self, url: Url, body: String) -> CResult<reqwest::Response> {
        let req = self
            .http
            .post(url)
            .bearer_auth(self.api_key.as_str())
            .header("content-type", "application/json")
            .body(body);
        req.send().await.map_err(|e| {
            let msg = if e.is_timeout() {
                "request timed out".to_string()
            } else {
                e.to_string()
            };
            ClientError::transport(msg)
        })
    }

    async fn get_json<T: for<'de> serde::Deserialize<'de>>(&self, path: &str) -> CResult<T> {
        let url = self.endpoint(path)?;
        let resp = self.send_get(url).await?;
        decode_response::<T>(resp).await
    }

    async fn post_json<T: for<'de> serde::Deserialize<'de>>(
        &self,
        path: &str,
        body: String,
        is_write: bool,
    ) -> CResult<T> {
        let url = self.endpoint(path)?;
        let resp = match self.send_post(url, body).await {
            Ok(r) => r,
            Err(e) => return Err(if is_write { e.mark_unknown_write() } else { e }),
        };
        decode_response::<T>(resp)
            .await
            .map_err(|e| if is_write { e.mark_unknown_write() } else { e })
    }

    /// GET /api/identity (raw identity; caller performs the binding check).
    pub async fn identity(&self) -> CResult<IdentityInfo> {
        self.get_json("/api/identity").await
    }

    /// Verify /api/identity matches the configured expected identity.
    pub async fn verify_identity(
        &self,
        expected_user: &str,
        expected_ws: &str,
    ) -> CResult<IdentityInfo> {
        let info = self.identity().await?;
        if info.user_id == expected_user && info.workspace_id == expected_ws {
            Ok(info)
        } else {
            Err(ClientError {
                kind: ErrorKind::IdentityMismatch {
                    expected: format!("{expected_user}/{expected_ws}"),
                    actual: format!("{}/{}", info.user_id, info.workspace_id),
                },
                outcome_unknown: false,
            })
        }
    }

    /// GET /api/worker/jobs/pending
    pub async fn pending(&self, workspace_ref: &str, after: &str) -> CResult<Pending> {
        let mut url = self.endpoint("/api/worker/jobs/pending")?;
        url.query_pairs_mut()
            .append_pair("workspace_ref", workspace_ref)
            .append_pair("after", after);
        let resp = self.send_get(url).await?;
        let p: Pending = decode_response(resp).await?;
        if !p.ok {
            return Err(ClientError::protocol("pending response marked ok=false"));
        }
        Ok(p)
    }

    /// POST /api/worker/jobs/{job}/claim (write; outcome unknown on transport fault).
    pub async fn claim(&self, job_id: &str, req: &ClaimRequest) -> CResult<ClaimOk> {
        let body = serde_json::to_string(req)
            .map_err(|e| ClientError::protocol(format!("encode claim: {e}")))?;
        let path = format!("/api/worker/jobs/{job_id}/claim");
        let ok: ClaimOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(
                ClientError::protocol("claim response marked ok=false").mark_unknown_write()
            );
        }
        Ok(ok)
    }

    /// POST /api/worker/jobs/{job}/start (write; outcome unknown on transport fault).
    pub async fn start(&self, job_id: &str, req: &LeaseOperationRequest) -> CResult<LeaseOk> {
        let body = serde_json::to_string(req)
            .map_err(|e| ClientError::protocol(format!("encode start: {e}")))?;
        let path = format!("/api/worker/jobs/{job_id}/start");
        let ok: LeaseOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(
                ClientError::protocol("start response marked ok=false").mark_unknown_write()
            );
        }
        Ok(ok)
    }

    /// POST /api/worker/jobs/{job}/heartbeat (write; outcome unknown on transport fault).
    pub async fn heartbeat(&self, job_id: &str, req: &LeaseOperationRequest) -> CResult<LeaseOk> {
        let body = serde_json::to_string(req)
            .map_err(|e| ClientError::protocol(format!("encode heartbeat: {e}")))?;
        let path = format!("/api/worker/jobs/{job_id}/heartbeat");
        let ok: LeaseOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(
                ClientError::protocol("heartbeat response marked ok=false").mark_unknown_write()
            );
        }
        Ok(ok)
    }

    /// Accessor so the CLI/test can prove the returned execution is a claimed
    /// (not running) state without conflating the two.
    #[allow(dead_code)]
    pub fn execution_phase(exec: &Execution) -> &str {
        &exec.phase
    }
}

/// Reads the body with a hard streaming cap (never trusts Content-Length alone).
async fn read_bounded(resp: reqwest::Response) -> CResult<Vec<u8>> {
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| ClientError::transport(e.to_string()))?;
        if out.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ClientError {
                kind: ErrorKind::TooLarge,
                outcome_unknown: false,
            });
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Turns an HTTP response into typed JSON or a structured ClientError.
async fn decode_response<T: for<'de> serde::Deserialize<'de>>(
    resp: reqwest::Response,
) -> CResult<T> {
    let status = resp.status();
    let bytes = read_bounded(resp).await?;
    if status.is_success() {
        let parsed: T = serde_json::from_slice(&bytes)
            .map_err(|e| ClientError::protocol(format!("invalid JSON on 2xx: {e}")))?;
        return Ok(parsed);
    }
    // Non-2xx: classify. 3xx means a redirect surfaced (not followed).
    if status.is_redirection() {
        return Err(ClientError {
            kind: ErrorKind::Redirect(status.as_u16()),
            outcome_unknown: false,
        });
    }
    if status == StatusCode::UNAUTHORIZED {
        return Err(ClientError {
            kind: ErrorKind::Unauthorized,
            outcome_unknown: false,
        });
    }
    if status == StatusCode::FORBIDDEN {
        return Err(ClientError {
            kind: ErrorKind::Forbidden,
            outcome_unknown: false,
        });
    }
    // Business errors: preserve code + a legal details.reason only.
    let envelope: Result<crate::bridge::protocol::ErrorEnvelope, _> =
        serde_json::from_slice(&bytes);
    let (code, reason) = match envelope {
        Ok(env) => {
            let code = env.code.filter(|c| !c.is_empty()).or_else(|| {
                env.error
                    .as_ref()
                    .and_then(|e| e.code.map(|c| format!("{c}")))
                    .filter(|s| !s.is_empty())
            });
            (code, env.details.and_then(|d| d.reason))
        }
        Err(_) => (None, None),
    };
    Err(ClientError {
        kind: ErrorKind::Server {
            status: status.as_u16(),
            code: code.unwrap_or_else(|| format!("HTTP_{}", status.as_u16())),
            reason,
        },
        outcome_unknown: false,
    })
}
