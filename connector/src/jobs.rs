use thiserror::Error;

use crate::client::{ClientError, ConnectorClient, JobDetail, JobListQuery, JobListResponse};
use crate::config::{ConfigError, ProfileError};
use crate::credential::CredentialError;
use crate::paths::ConnectorPaths;
use crate::render::{push_field, push_line, push_multiline_field, push_opt_field};

#[derive(Error, Debug)]
pub enum JobError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Config error: {0}")]
    Config(#[from] ConfigError),
    #[error("Credential error: {0}")]
    Credential(#[from] CredentialError),
    #[error("Client error: {0}")]
    Client(#[from] ClientError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Not logged in. Please run `ceo-connector login` first.")]
    NotLoggedIn,
}

impl From<ProfileError> for JobError {
    fn from(err: ProfileError) -> Self {
        match err {
            ProfileError::NotLoggedIn => JobError::NotLoggedIn,
            ProfileError::ConfigNotFound => JobError::NotLoggedIn,
            ProfileError::LocalCredentialServerMismatch { expected, actual } => {
                JobError::Client(ClientError::LocalCredentialServerMismatch { expected, actual })
            }
            ProfileError::Config(e) => JobError::Config(e),
            ProfileError::Credential(e) => JobError::Credential(e),
            ProfileError::Io(e) => JobError::Io(e),
        }
    }
}

/// Lifecycle states accepted by `job list --state` (server-aligned set).
pub const JOB_STATE_FILTERS: &[&str] = &["queued", "claimed", "running", "expired", "terminal"];

/// Validates a `--state` filter value; used as a clap value parser so
/// invalid states are rejected at argument parsing time.
pub fn parse_state_filter(raw: &str) -> Result<String, String> {
    let s = raw.trim().to_lowercase();
    if JOB_STATE_FILTERS.contains(&s.as_str()) {
        Ok(s)
    } else {
        Err(format!(
            "invalid job state '{}'. Valid states: {}",
            raw,
            JOB_STATE_FILTERS.join(", ")
        ))
    }
}

/// Filters for `job list`, mapped 1:1 onto the server read query.
#[derive(Debug, Clone, Default)]
pub struct JobListFilters {
    pub state: Option<String>,
    pub target_id: Option<String>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl JobListFilters {
    fn to_query(&self) -> JobListQuery {
        JobListQuery {
            state: self.state.clone(),
            target_id: self.target_id.clone(),
            limit: self.limit,
            cursor: self.cursor.clone(),
        }
    }
}

pub async fn job_list(
    paths: &ConnectorPaths,
    filters: JobListFilters,
    json_format: bool,
) -> Result<(), JobError> {
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;
    let res = client.list_jobs(&cred, &filters.to_query()).await?;

    if json_format {
        println!("{}", serde_json::to_string_pretty(&res)?);
    } else {
        print!("{}", render_job_list(&res));
    }
    Ok(())
}

pub async fn job_show(
    paths: &ConnectorPaths,
    job_id: &str,
    include_task: bool,
    json_format: bool,
) -> Result<(), JobError> {
    let profile = crate::config::load_bound_profile(paths)?;
    let cred = profile.credential;
    let client = ConnectorClient::new(&cred.server_origin)?;
    let detail = client.get_job(&cred, job_id, include_task).await?;

    if json_format {
        println!("{}", serde_json::to_string_pretty(&detail)?);
    } else {
        print!("{}", render_job_detail(&detail));
    }
    Ok(())
}

/// Renders the job list as vertical blocks, newest first (server order).
pub fn render_job_list(res: &JobListResponse) -> String {
    if res.jobs.is_empty() {
        return "No jobs found.\n".to_string();
    }

    let mut out = String::new();
    for job in &res.jobs {
        push_line(&mut out, 0, &format!("Job: {}", job.job_id));
        push_line(
            &mut out,
            2,
            &format!("Target: {} ({})", job.target_alias, job.target_id),
        );
        push_field(&mut out, 2, "State", &job.state);
        push_opt_field(&mut out, 2, "Execution status", &job.execution_status);
        push_opt_field(&mut out, 2, "Business outcome", &job.business_outcome);
        push_field(&mut out, 2, "Created", &job.created_at);
        push_opt_field(&mut out, 2, "Expires", &job.expires_at);
        push_line(&mut out, 0, "");
    }
    match &res.next_cursor {
        Some(cursor) => push_line(&mut out, 0, &format!("Next cursor: {cursor}")),
        None => push_line(&mut out, 0, "End of results."),
    }
    out
}

/// Renders one job in detail as a vertical block.
pub fn render_job_detail(job: &JobDetail) -> String {
    let mut out = String::new();
    push_line(&mut out, 0, &format!("Job: {}", job.job_id));
    push_field(&mut out, 2, "Request ID", &job.request_id);
    push_line(
        &mut out,
        2,
        &format!("Target: {} ({})", job.target_alias, job.target_id),
    );
    push_field(&mut out, 2, "State", &job.state);
    push_field(&mut out, 2, "Created", &job.created_at);
    push_opt_field(&mut out, 2, "Expires", &job.expires_at);
    push_field(
        &mut out,
        2,
        "Execution timeout",
        &format!("{}s", job.execution_timeout_seconds),
    );
    push_opt_field(&mut out, 2, "Execution status", &job.execution_status);
    push_opt_field(&mut out, 2, "Business outcome", &job.business_outcome);

    if let Some(exec) = &job.execution {
        push_line(&mut out, 2, "Attempt:");
        push_field(&mut out, 4, "ID", &exec.attempt_id);
        push_field(&mut out, 4, "Phase", &exec.phase);
        push_field(&mut out, 4, "Claimed", &exec.claimed_at);
        push_opt_field(&mut out, 4, "Started", &exec.started_at);
    }

    if let Some(report) = &job.report {
        push_line(&mut out, 2, "Report:");
        push_field(&mut out, 4, "Finished", &report.finished_at);
        push_field(
            &mut out,
            4,
            "Duration",
            &format!("{} ms", report.duration_ms),
        );
        push_field(&mut out, 4, "Receipt sha256", &report.receipt_sha256);
        match &report.error {
            Some(err) => push_line(
                &mut out,
                4,
                &format!(
                    "Error: stage={}, code={}, message={}",
                    err.stage, err.code, err.message
                ),
            ),
            None => push_line(&mut out, 4, "Error: <none>"),
        };
    }

    if let Some(result) = &job.result {
        push_line(&mut out, 2, "Result:");
        push_field(&mut out, 4, "Resource", &result.resource_id);
        push_field(&mut out, 4, "Commit", &result.commit);
        push_field(&mut out, 4, "Payload sha256", &result.payload_sha256);
    }

    if let Some(task) = &job.task {
        push_multiline_field(&mut out, 2, "Prompt", &task.prompt);
        push_multiline_field(&mut out, 2, "Acceptance", &task.acceptance);
    }

    out
}
