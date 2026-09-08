//! Reusable async HTTPS client for the identity-scoped bridge.
//!
//! The client owns the transport policy (bounded connect + overall deadline, no
//! redirects/cookies/env-proxy, capped response body, automatic retries
//! disabled) and converts every abnormal response into a structured
//! `ClientError`. It never manufactures an attempt id or lease token and never
//! auto-retries a write request.
//!
//! Response handling is centralized here (not duplicated per method):
//!   * required-field presence is enforced by the wire types (see protocol.rs),
//!   * value + association + lease-time invariants are checked by the validation
//!     helpers below, and
//!   * every write-request fault is classified once into `outcome_unknown`
//!     following the write/read classification table.

use crate::bridge::config::ApiKey;
use crate::bridge::protocol::{
    ClaimOk, ClaimRequest, ClaimedJob, Execution, HeartbeatOk, IdentityInfo, LeaseOperationRequest,
    Pending, Phase, StartOk,
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

// ---- Server contract constants (mirrored from jobs/schema.ts) ----
const JOB_ID_RE: &str = r"^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const RESOURCE_ID_RE: &str = r"^res-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const WORKSPACE_ALIAS_RE: &str = r"^[A-Za-z0-9_-]{1,64}$";
const UUID_RE: &str = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const WORKER_ID_RE: &str = r"^wrk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const STREAM_ID_RE: &str = r"^([0-9]+)-([0-9]+)$";
const MIN_TIMEOUT_SECONDS: i64 = 60;
const MAX_TIMEOUT_SECONDS: i64 = 7200;
const MAX_PROMPT_BYTES: usize = 64 * 1024;
const MAX_ACCEPTANCE_BYTES: usize = 8 * 1024;
const MAX_JOBS_PER_PAGE: usize = 25;

/// Known server business codes (from jobs/service.ts JobErrorCode). A code that
/// is not in this set is never echoed back to the caller verbatim.
const KNOWN_CODES: &[&str] = &[
    "INVALID_INPUT",
    "BRIDGE_DISABLED",
    "QUEUE_UNAVAILABLE",
    "IDEMPOTENCY_CONFLICT",
    "JOB_NOT_FOUND",
    "RESOURCE_NOT_FOUND",
    "INCOMPLETE_SUBMISSION",
    "JOB_EXPIRED",
    "JOB_ALREADY_CLAIMED",
    "JOB_NOT_CLAIMED",
    "LEASE_MISMATCH",
    "LEASE_EXPIRED",
    "WORKSPACE_MISMATCH",
];

/// Known lease `details.reason` values preserved verbatim; anything else is
/// dropped (never surfaced).
const KNOWN_REASONS: &[&str] = &[
    "EXECUTION_DEADLINE_EXCEEDED",
    "START_DEADLINE_EXCEEDED",
    "LEASE_EXPIRED",
    "CORRUPT_RECORD",
    "INCOMPLETE_SUBMISSION",
];

#[derive(Debug)]
pub enum ErrorKind {
    /// HTTP 401 from the auth middleware.
    Unauthorized,
    /// HTTP 403 from the auth middleware.
    Forbidden,
    /// A 3xx response (redirects are never followed, so no credentials leak).
    Redirect(u16),
    /// 4xx/5xx business error; `code`/`reason` are preserved only when the
    /// server supplied a legal envelope value on the matching status.
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
    /// and must not treat the request as a confirmed failure.
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
    fn transport(msg: impl Into<String>) -> Self {
        ClientError {
            kind: ErrorKind::Transport(msg.into()),
            outcome_unknown: false,
        }
    }
    /// A local (pre-send) or read-side protocol error: outcome is definitely
    /// known (nothing was sent, or no state change was possible).
    fn protocol(msg: impl Into<String>) -> Self {
        ClientError {
            kind: ErrorKind::Protocol(msg.into()),
            outcome_unknown: false,
        }
    }
    /// A write-side protocol failure after the request was sent: outcome unknown.
    fn write_protocol(msg: impl Into<String>) -> Self {
        ClientError {
            kind: ErrorKind::Protocol(msg.into()),
            outcome_unknown: true,
        }
    }
    fn size_exceeded(outcome_unknown: bool) -> Self {
        ClientError {
            kind: ErrorKind::TooLarge,
            outcome_unknown,
        }
    }
    fn redirect(status: u16, outcome_unknown: bool) -> Self {
        ClientError {
            kind: ErrorKind::Redirect(status),
            outcome_unknown,
        }
    }
    /// Central write classification: transport/protocol/size/redirect faults
    /// all mean "could not confirm the write took effect".
    fn mark_write(mut self) -> Self {
        if matches!(
            self.kind,
            ErrorKind::Transport(_)
                | ErrorKind::Protocol(_)
                | ErrorKind::TooLarge
                | ErrorKind::Redirect(_)
        ) {
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
    /// Production constructor: 3 s connect / 8 s total, automatic retries off.
    pub fn new(base: Url, api_key: ApiKey) -> CResult<BridgeClient> {
        Self::new_with_timeouts(base, api_key, CONNECT_TIMEOUT, TOTAL_TIMEOUT)
    }

    /// Test-support constructor that lets a test inject a short budget. The
    /// production `new()` keeps the fixed 3 s / 8 s values.
    pub fn new_with_timeouts(
        base: Url,
        api_key: ApiKey,
        connect: Duration,
        total: Duration,
    ) -> CResult<BridgeClient> {
        let http = reqwest::Client::builder()
            .connect_timeout(connect)
            .timeout(total)
            // reqwest 0.13 retries some low-level protocol NACKs by default.
            // Explicitly disable ALL automatic retries so a write is never
            // silently re-sent behind the caller's back.
            .retry(reqwest::retry::never())
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
                "network/transport failure".to_string()
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
                "network/transport failure".to_string()
            };
            ClientError::transport(msg)
        })
    }

    async fn get_json<T: for<'de> serde::Deserialize<'de>>(&self, path: &str) -> CResult<T> {
        let url = self.endpoint(path)?;
        let resp = self.send_get(url).await?;
        decode_response::<T>(resp, false).await
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
            Err(e) => return Err(if is_write { e.mark_write() } else { e }),
        };
        decode_response::<T>(resp, is_write).await
    }

    /// GET /api/identity (raw identity; caller performs the binding check).
    pub async fn identity(&self) -> CResult<IdentityInfo> {
        self.get_json("/api/identity").await
    }

    /// Verify /api/identity matches the configured expected identity. On any
    /// mismatch the caller must not continue discovery.
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

    /// GET /api/worker/jobs/pending (read: outcome_unknown is always false).
    pub async fn pending(&self, workspace_ref: &str, after: &str) -> CResult<Pending> {
        let mut url = self.endpoint("/api/worker/jobs/pending")?;
        url.query_pairs_mut()
            .append_pair("workspace_ref", workspace_ref)
            .append_pair("after", after);
        let resp = self.send_get(url).await?;
        let p: Pending = decode_response(resp, false).await?;
        if !p.ok {
            return Err(ClientError::protocol("pending response marked ok=false"));
        }
        validate_pending(&p, workspace_ref, after).map_err(ClientError::protocol)?;
        Ok(p)
    }

    /// POST /api/worker/jobs/{job}/claim (write; outcome unknown on transport
    /// fault or an ambiguous success).
    pub async fn claim(&self, job_id: &str, req: &ClaimRequest) -> CResult<ClaimOk> {
        let body = serde_json::to_string(req)
            .map_err(|_| ClientError::protocol("encode claim request"))?;
        let path = format!("/api/worker/jobs/{job_id}/claim");
        let ok: ClaimOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(ClientError::write_protocol(
                "claim response marked ok=false",
            ));
        }
        validate_claim_ok(&ok, job_id, req).map_err(ClientError::write_protocol)?;
        Ok(ok)
    }

    /// POST /api/worker/jobs/{job}/start (write; outcome unknown on transport
    /// fault or an ambiguous success).
    pub async fn start(&self, job_id: &str, req: &LeaseOperationRequest) -> CResult<StartOk> {
        let body = serde_json::to_string(req)
            .map_err(|_| ClientError::protocol("encode start request"))?;
        let path = format!("/api/worker/jobs/{job_id}/start");
        let ok: StartOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(ClientError::write_protocol(
                "start response marked ok=false",
            ));
        }
        validate_lease_ok(
            &ok.execution,
            &req.worker_id,
            &req.attempt_id,
            None,
            &[Phase::Running],
            &ok.server_time,
        )
        .map_err(ClientError::write_protocol)?;
        Ok(ok)
    }

    /// POST /api/worker/jobs/{job}/heartbeat (write; outcome unknown on
    /// transport fault or an ambiguous success).
    pub async fn heartbeat(
        &self,
        job_id: &str,
        req: &LeaseOperationRequest,
    ) -> CResult<HeartbeatOk> {
        let body = serde_json::to_string(req)
            .map_err(|_| ClientError::protocol("encode heartbeat request"))?;
        let path = format!("/api/worker/jobs/{job_id}/heartbeat");
        let ok: HeartbeatOk = self.post_json(&path, body, true).await?;
        if !ok.ok {
            return Err(ClientError::write_protocol(
                "heartbeat response marked ok=false",
            ));
        }
        validate_lease_ok(
            &ok.execution,
            &req.worker_id,
            &req.attempt_id,
            None,
            &[Phase::Claimed, Phase::Running],
            &ok.server_time,
        )
        .map_err(ClientError::write_protocol)?;
        Ok(ok)
    }
}

/// Reads the body with a hard streaming cap (never trusts Content-Length alone).
async fn read_bounded(resp: reqwest::Response, outcome_unknown: bool) -> CResult<Vec<u8>> {
    let mut stream = resp.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                return Err(ClientError {
                    kind: ErrorKind::Transport(format!("read body: {e}")),
                    outcome_unknown,
                });
            }
        };
        if out.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ClientError::size_exceeded(outcome_unknown));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Turns an HTTP response into typed JSON or a structured ClientError. All
/// read/write classification is centralized here.
async fn decode_response<T: for<'de> serde::Deserialize<'de>>(
    resp: reqwest::Response,
    is_write: bool,
) -> CResult<T> {
    let status = resp.status();

    // 401/403 are decided from the status alone; never parse (or trust) a body.
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
    // A redirect that surfaced (not followed) is abnormal.
    if status.is_redirection() {
        return Err(ClientError::redirect(status.as_u16(), is_write));
    }

    let bytes = read_bounded(resp, is_write).await?;

    if status.is_success() {
        return match serde_json::from_slice::<T>(&bytes) {
            Ok(v) => Ok(v),
            // Never echo the raw serde error: it may embed response values.
            Err(e) => {
                let msg = if e.is_syntax() {
                    "invalid response JSON".to_string()
                } else {
                    "invalid response structure".to_string()
                };
                Err(if is_write {
                    ClientError::write_protocol(msg)
                } else {
                    ClientError::protocol(msg)
                })
            }
        };
    }

    // Non-2xx business error. The HTTP status was preserved before any body
    // processing.
    let parsed = parse_business_envelope(&bytes);
    Err(classify_server_error(status.as_u16(), parsed, is_write))
}

/// Parsed business-error envelope with only whitelisted code/reason surviving.
/// `explicitly_failed` is true only when the envelope explicitly carries
/// `ok: false` (absent, `null`, `true`, or a non-bool `ok` never count as an
/// explicit failure). Private to this module; no public protocol surface.
struct ParsedBusinessError {
    code: Option<String>,
    reason: Option<String>,
    explicitly_failed: bool,
}

/// Parses the business-error envelope, returning only whitelisted code/reason.
fn parse_business_envelope(bytes: &[u8]) -> ParsedBusinessError {
    let env: Result<crate::bridge::protocol::ErrorEnvelope, _> = serde_json::from_slice(bytes);
    let env = match env {
        Ok(e) => e,
        Err(_) => {
            return ParsedBusinessError {
                code: None,
                reason: None,
                explicitly_failed: false,
            };
        }
    };
    let code = env
        .code
        .filter(|c| !c.is_empty())
        .or_else(|| {
            env.error
                .as_ref()
                .and_then(|e| e.code)
                .map(|n| n.to_string())
                .filter(|s| !s.is_empty())
        })
        .filter(|c| KNOWN_CODES.contains(&c.as_str()));
    let reason = env
        .details
        .and_then(|d| d.reason)
        .filter(|r| KNOWN_REASONS.contains(&r.as_str()));
    ParsedBusinessError {
        code,
        reason,
        explicitly_failed: env.ok == Some(false),
    }
}

/// Builds the Server-kind ClientError and decides write outcome by the table.
fn classify_server_error(status: u16, parsed: ParsedBusinessError, is_write: bool) -> ClientError {
    let display_code = parsed
        .code
        .clone()
        .unwrap_or_else(|| format!("HTTP_{status}"));
    let outcome_unknown = is_write
        && !is_confirmed_rejection(status, parsed.code.as_deref(), parsed.explicitly_failed);
    ClientError {
        kind: ErrorKind::Server {
            status,
            code: display_code,
            reason: parsed.reason,
        },
        outcome_unknown,
    }
}

/// The ONLY status/code pairings that confirm a write request produced no
/// server state change. The envelope must explicitly carry `ok: false` AND the
/// HTTP status must match the code; otherwise the write outcome stays unknown.
/// `QUEUE_UNAVAILABLE` can never confirm a non-change regardless of `ok`.
fn is_confirmed_rejection(status: u16, code: Option<&str>, explicitly_failed: bool) -> bool {
    if !explicitly_failed {
        return false;
    }

    matches!(
        (status, code),
        (400, Some("INVALID_INPUT"))
            | (404, Some("JOB_NOT_FOUND"))
            | (
                409,
                Some(
                    "JOB_EXPIRED"
                        | "JOB_ALREADY_CLAIMED"
                        | "IDEMPOTENCY_CONFLICT"
                        | "JOB_NOT_CLAIMED"
                        | "LEASE_MISMATCH"
                        | "LEASE_EXPIRED"
                        | "WORKSPACE_MISMATCH"
                )
            )
            | (503, Some("BRIDGE_DISABLED"))
    )
}

// ---------------------------------------------------------------------------
// Semantic validation of successful responses.
// ---------------------------------------------------------------------------

fn job_id_ok(s: &str) -> bool {
    regex_ok(JOB_ID_RE, s)
}
fn resource_id_ok(s: &str) -> bool {
    regex_ok(RESOURCE_ID_RE, s)
}
fn workspace_alias_ok(s: &str) -> bool {
    regex_ok(WORKSPACE_ALIAS_RE, s)
}
fn uuid_ok(s: &str) -> bool {
    regex_ok(UUID_RE, s)
}
fn worker_id_ok(s: &str) -> bool {
    regex_ok(WORKER_ID_RE, s)
}

fn regex_ok(re: &str, s: &str) -> bool {
    regex::Regex::new(re)
        .map(|r| r.is_match(s))
        .unwrap_or(false)
}

/// Two decimal u64 stream-ID parts, parsed losslessly.
fn parse_stream_id(id: &str) -> Option<(u128, u128)> {
    let cap = regex::Regex::new(STREAM_ID_RE).ok()?;
    let c = cap.captures(id)?;
    let ms = c.get(1)?.as_str().parse::<u128>().ok()?;
    let seq = c.get(2)?.as_str().parse::<u128>().ok()?;
    const U64_MAX: u128 = 18_446_744_073_709_551_615;
    if ms > U64_MAX || seq > U64_MAX {
        return None;
    }
    Some((ms, seq))
}

fn rfc3339(s: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
    chrono::DateTime::parse_from_rfc3339(s).ok()
}

/// Validates a Pending response against the request alias + exclusive cursor.
fn validate_pending(p: &Pending, workspace_ref: &str, after: &str) -> Result<(), String> {
    if p.jobs.len() > MAX_JOBS_PER_PAGE {
        return Err("too many jobs in one page".to_string());
    }
    if !workspace_alias_ok(workspace_ref) {
        return Err("workspace alias mismatch".to_string());
    }
    let mut seen = std::collections::HashSet::new();
    for job in &p.jobs {
        if job.workspace_ref != workspace_ref {
            return Err("pending job workspace_ref does not match request".to_string());
        }
        if !job_id_ok(&job.job_id) {
            return Err("invalid job id".to_string());
        }
        if let Some(rid) = &job.resource_id {
            if !resource_id_ok(rid) {
                return Err("invalid resource id".to_string());
            }
        }
        if rfc3339(&job.created_at).is_none() || rfc3339(&job.expires_at).is_none() {
            return Err("invalid job timestamp".to_string());
        }
        if !seen.insert(job.job_id.clone()) {
            return Err("duplicate job id in page".to_string());
        }
    }
    let (cur_ms, cur_seq) = match parse_stream_id(&p.next_cursor) {
        Some(v) => v,
        None => return Err("next_cursor is not a valid stream id".to_string()),
    };
    let (after_ms, after_seq) = parse_stream_id(after)
        .ok_or_else(|| "request cursor is not a valid stream id".to_string())?;
    if (cur_ms, cur_seq) < (after_ms, after_seq) {
        return Err("next_cursor regressed below the request cursor".to_string());
    }
    // A non-empty page, or has_more, must advance the cursor.
    if (!p.jobs.is_empty() || p.has_more) && (cur_ms, cur_seq) == (after_ms, after_seq) {
        return Err("next_cursor did not advance".to_string());
    }
    Ok(())
}

/// Validates a successful Claim response against the request.
fn validate_claim_ok(ok: &ClaimOk, job_id: &str, req: &ClaimRequest) -> Result<(), String> {
    let job = &ok.job;
    if job.job_id != job_id {
        return Err("response job id does not match request".to_string());
    }
    if job.workspace_ref != req.workspace_ref {
        return Err("response workspace_ref does not match request".to_string());
    }
    validate_claimed_job(job)?;
    // A fresh claim must be claimed; an idempotent replay may be claimed or
    // running (the client may already have started after the original claim).
    let allowed: &[Phase] = if ok.replayed {
        &[Phase::Claimed, Phase::Running]
    } else {
        &[Phase::Claimed]
    };
    validate_lease_ok(
        &ok.execution,
        &req.worker_id,
        &req.attempt_id,
        Some(job),
        allowed,
        &ok.server_time,
    )?;
    Ok(())
}

/// Validates a ClaimedJob's value fields (format/limits/range).
fn validate_claimed_job(job: &ClaimedJob) -> Result<(), String> {
    if !job_id_ok(&job.job_id) {
        return Err("invalid job id".to_string());
    }
    if !workspace_alias_ok(&job.workspace_ref) {
        return Err("invalid workspace alias".to_string());
    }
    if let Some(rid) = &job.resource_id {
        if !resource_id_ok(rid) {
            return Err("invalid resource id".to_string());
        }
    }
    if job.prompt.trim().is_empty() {
        return Err("empty prompt".to_string());
    }
    if job.prompt.len() > MAX_PROMPT_BYTES {
        return Err("prompt exceeds server byte limit".to_string());
    }
    if job.acceptance.trim().is_empty() {
        return Err("empty acceptance".to_string());
    }
    if job.acceptance.len() > MAX_ACCEPTANCE_BYTES {
        return Err("acceptance exceeds server byte limit".to_string());
    }
    if job.timeout_seconds < MIN_TIMEOUT_SECONDS || job.timeout_seconds > MAX_TIMEOUT_SECONDS {
        return Err("timeout_seconds out of range".to_string());
    }
    Ok(())
}

/// Validates an execution/lease response against the write request. `job` is
/// Some only for claims (so the execution_deadline == started_at + timeout
/// equality can be checked). `allowed` restricts the permitted phases for the
/// specific operation.
fn validate_lease_ok(
    exec: &Execution,
    worker_id: &str,
    attempt_id: &str,
    job: Option<&ClaimedJob>,
    allowed: &[Phase],
    server_time: &str,
) -> Result<(), String> {
    if exec.worker_id != worker_id {
        return Err("response identity mismatch".to_string());
    }
    if exec.attempt_id != attempt_id {
        return Err("response identity mismatch".to_string());
    }
    if !worker_id_ok(&exec.worker_id) {
        return Err("invalid worker id".to_string());
    }
    if !uuid_ok(&exec.attempt_id) {
        return Err("invalid attempt id".to_string());
    }
    let phase = match exec.phase.as_str() {
        "claimed" => Phase::Claimed,
        "running" => Phase::Running,
        _ => return Err("invalid execution phase".to_string()),
    };
    if !allowed.contains(&phase) {
        return Err("execution phase not allowed for this operation".to_string());
    }
    validate_execution_times(exec, phase, job, server_time)
}

/// Time/order invariants (section 2.4), using only parsed response times.
fn validate_execution_times(
    exec: &Execution,
    phase: Phase,
    job: Option<&ClaimedJob>,
    server_time: &str,
) -> Result<(), String> {
    let claimed = rfc3339(&exec.claimed_at).ok_or("invalid claimed_at")?;
    let start_deadline = rfc3339(&exec.start_deadline).ok_or("invalid start_deadline")?;
    let lease = rfc3339(&exec.lease_expires_at).ok_or("invalid lease_expires_at")?;
    let server = rfc3339(server_time).ok_or("invalid server_time")?;
    let started = match &exec.started_at {
        Some(s) => Some(rfc3339(s).ok_or("invalid started_at")?),
        None => None,
    };
    let exec_deadline = match &exec.execution_deadline {
        Some(s) => Some(rfc3339(s).ok_or("invalid execution_deadline")?),
        None => None,
    };

    match phase {
        Phase::Claimed => {
            if claimed > lease || lease > start_deadline {
                return Err("lease time ordering invalid".to_string());
            }
            // server_time < lease_expires_at && server_time < start_deadline
            if server >= lease || server >= start_deadline {
                return Err("server_time not inside claimed lease window".to_string());
            }
            if exec.started_at.is_some() {
                return Err("claimed execution must not have started_at".to_string());
            }
            if exec.execution_deadline.is_some() {
                return Err("claimed execution must not have execution_deadline".to_string());
            }
        }
        Phase::Running => {
            let started = started.ok_or("running execution missing started_at")?;
            let exec_deadline =
                exec_deadline.ok_or("running execution missing execution_deadline")?;
            if claimed > started || started > lease || lease > exec_deadline {
                return Err("lease time ordering invalid".to_string());
            }
            if started >= start_deadline {
                return Err("started_at not before start_deadline".to_string());
            }
            // server_time < lease_expires_at && server_time < execution_deadline
            if server >= lease || server >= exec_deadline {
                return Err("server_time not inside running lease window".to_string());
            }
            if let Some(job) = job {
                let timeout = chrono::Duration::seconds(job.timeout_seconds);
                if exec_deadline.signed_duration_since(started) != timeout {
                    return Err("execution_deadline != started_at + timeout".to_string());
                }
            }
        }
    }
    Ok(())
}
