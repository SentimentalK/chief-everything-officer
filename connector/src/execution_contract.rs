use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const REPORT_SCHEMA_VERSION: u32 = 2;
pub const MAX_REPORT_ERROR_MESSAGE_BYTES: usize = 2048;
pub const MAX_EXECUTOR_VERSION_BYTES: usize = 256;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[allow(non_camel_case_types)]
pub enum ExecutionStatus {
    COMPLETED,
    FAILED,
    TIMED_OUT,
    CANCELLED,
    BLOCKED,
    INTERRUPTED,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[allow(non_camel_case_types)]
pub enum BusinessOutcome {
    UNVERIFIED,
    FAILED,
    NOT_STARTED,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionReportExecutor {
    #[serde(rename = "type")]
    pub executor_type: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionReportError {
    pub stage: String,
    pub code: String,
    pub message: String,
}

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExecutionReport {
    pub schema_version: u32,
    pub execution_status: ExecutionStatus,
    pub business_outcome: BusinessOutcome,
    pub task_dispatched: bool,
    pub finished_at_ms: i64,
    pub duration_ms: i64,
    pub executor: ExecutionReportExecutor,
    pub receipt_sha256: String,
    pub error: Option<ExecutionReportError>,
}

#[derive(Error, Debug, PartialEq, Eq)]
pub enum ExecutionReportValidationError {
    #[error("Invalid schema_version: expected 2, got {0}")]
    InvalidSchemaVersion(u32),
    #[error("Invalid finished_at_ms: must be between 0 and {MAX_SAFE_INTEGER}, got {0}")]
    InvalidFinishedAt(i64),
    #[error("Invalid duration_ms: must be between 0 and {MAX_SAFE_INTEGER}, got {0}")]
    InvalidDuration(i64),
    #[error("Completed report must not have error")]
    CompletedReportHasError,
    #[error("Non-completed report must include error")]
    NonCompletedReportMissingError,
    #[error("Undispatched task must have business_outcome NOT_STARTED")]
    UndispatchedNotStarted,
    #[error("Unverified business outcome requires task_dispatched true")]
    UnverifiedRequiresDispatched,
    #[error("Invalid executor: {0}")]
    InvalidExecutor(String),
    #[error("Invalid receipt_sha256: {0}")]
    InvalidReceipt(String),
    #[error("Invalid error object: {0}")]
    InvalidError(String),
}

impl ExecutionReport {
    pub fn validate(&self) -> Result<(), ExecutionReportValidationError> {
        if self.schema_version != REPORT_SCHEMA_VERSION {
            return Err(ExecutionReportValidationError::InvalidSchemaVersion(
                self.schema_version,
            ));
        }

        if self.finished_at_ms < 0 || self.finished_at_ms > MAX_SAFE_INTEGER {
            return Err(ExecutionReportValidationError::InvalidFinishedAt(
                self.finished_at_ms,
            ));
        }

        if self.duration_ms < 0 || self.duration_ms > MAX_SAFE_INTEGER {
            return Err(ExecutionReportValidationError::InvalidDuration(
                self.duration_ms,
            ));
        }

        if self.execution_status == ExecutionStatus::COMPLETED && self.error.is_some() {
            return Err(ExecutionReportValidationError::CompletedReportHasError);
        }

        if self.execution_status != ExecutionStatus::COMPLETED && self.error.is_none() {
            return Err(ExecutionReportValidationError::NonCompletedReportMissingError);
        }

        if !self.task_dispatched && self.business_outcome != BusinessOutcome::NOT_STARTED {
            return Err(ExecutionReportValidationError::UndispatchedNotStarted);
        }

        if self.business_outcome == BusinessOutcome::UNVERIFIED && !self.task_dispatched {
            return Err(ExecutionReportValidationError::UnverifiedRequiresDispatched);
        }

        if self.executor.executor_type.is_empty()
            || self.executor.executor_type.len() > 64
            || !self
                .executor
                .executor_type
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-')
        {
            return Err(ExecutionReportValidationError::InvalidExecutor(
                "executor.type must be 1-64 [A-Za-z0-9_.-]".into(),
            ));
        }

        if self.executor.version.trim().is_empty()
            || self.executor.version.len() > MAX_EXECUTOR_VERSION_BYTES
        {
            return Err(ExecutionReportValidationError::InvalidExecutor(
                "executor.version must be non-empty and <= 256 bytes".into(),
            ));
        }

        if self.receipt_sha256.len() != 64
            || !self
                .receipt_sha256
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err(ExecutionReportValidationError::InvalidReceipt(
                "receipt_sha256 must be 64 lowercase hex characters".into(),
            ));
        }

        if let Some(ref err) = self.error {
            if err.stage.is_empty()
                || err.stage.len() > 64
                || !err
                    .stage
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                return Err(ExecutionReportValidationError::InvalidError(
                    "error.stage must be 1-64 [A-Za-z0-9_-]".into(),
                ));
            }

            if err.code.is_empty()
                || err.code.len() > 64
                || !err
                    .code
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
            {
                return Err(ExecutionReportValidationError::InvalidError(
                    "error.code must be 1-64 [A-Z0-9_]".into(),
                ));
            }

            if err.message.trim().is_empty() || err.message.len() > MAX_REPORT_ERROR_MESSAGE_BYTES {
                return Err(ExecutionReportValidationError::InvalidError(
                    "error.message must be non-empty and <= 2048 bytes".into(),
                ));
            }
        }

        Ok(())
    }
}

/// Owned correlation data injected into the managed-result section of the Agent prompt.
/// Uses owned data to avoid lifetime issues when the PathBuf is created inline at the call-site.
#[derive(Debug, Clone)]
pub struct ManagedContract {
    pub path: std::path::PathBuf,
    pub job_id: String,
    pub attempt_id: String,
    pub resource_id: String,
}

/// Builds a deterministic, structured execution prompt for CEO managed-result Jobs.
pub fn build_execution_prompt(
    task: Option<&str>,
    acceptance: Option<&str>,
    managed_contract: Option<&ManagedContract>,
) -> String {
    let mut sections = Vec::new();

    if let Some(t) = task {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            sections.push(format!("TASK\n\n{trimmed}"));
        }
    }

    if let Some(a) = acceptance {
        let trimmed = a.trim();
        if !trimmed.is_empty() {
            sections.push(format!("ACCEPTANCE CRITERIA\n\n{trimmed}"));
        }
    }

    if let Some(mc) = managed_contract {
        let contract = format!(
            "MANAGED RESULT CONTRACT\n\nCEO JOB\nJob ID: {job_id}\nAttempt ID: {attempt_id}\nResource ID: {resource_id}\n\nWhen your task is complete, you MUST write a single JSON file to this EXACT path:\n{path}\n\nThe JSON must follow this schema:\n{{\n  \"schema_version\": 1,\n  \"job_id\": \"{job_id}\",\n  \"attempt_id\": \"{attempt_id}\",\n  \"resource_id\": \"{resource_id}\",\n  \"summary\": \"<1-2 sentence description>\",\n  \"operations\": [\n    {{\n      \"op\": \"upsert_content\",\n      \"content\": \"<full extracted content as string>\"\n    }}\n  ]\n}}\n\nAllowed ops: upsert_content, upsert_evidence, upsert_summary, append_interaction, patch_topics, rename\nForbidden ops: attach_source_asset\n\nRules:\n1. Do NOT place this file in the git repository.\n2. Write only valid JSON encoded in UTF-8.\n3. Do not generate empty or partial files.\n4. Do NOT call CEO Server APIs directly.\n5. Do NOT modify resources/** in the git workspace.\n6. job_id, attempt_id, resource_id are given above — do NOT guess or invent them.",
            job_id = mc.job_id,
            attempt_id = mc.attempt_id,
            resource_id = mc.resource_id,
            path = mc.path.display(),
        );
        sections.push(contract);
    }

    sections.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_sample_report() -> ExecutionReport {
        ExecutionReport {
            schema_version: 2,
            execution_status: ExecutionStatus::COMPLETED,
            business_outcome: BusinessOutcome::UNVERIFIED,
            task_dispatched: true,
            finished_at_ms: 1727220000000,
            duration_ms: 1500,
            executor: ExecutionReportExecutor {
                executor_type: "agent".into(),
                version: "1.0.0".into(),
            },
            receipt_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                .into(),
            error: None,
        }
    }

    #[test]
    fn valid_report_passes_validation() {
        let rep = valid_sample_report();
        assert!(rep.validate().is_ok());
    }

    #[test]
    fn numeric_bounds_validation() {
        let mut rep = valid_sample_report();
        rep.finished_at_ms = -1;
        assert_eq!(
            rep.validate(),
            Err(ExecutionReportValidationError::InvalidFinishedAt(-1))
        );

        rep.finished_at_ms = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            rep.validate(),
            Err(ExecutionReportValidationError::InvalidFinishedAt(
                MAX_SAFE_INTEGER + 1
            ))
        );

        rep.finished_at_ms = 1727220000000;
        rep.duration_ms = -1;
        assert_eq!(
            rep.validate(),
            Err(ExecutionReportValidationError::InvalidDuration(-1))
        );

        rep.duration_ms = MAX_SAFE_INTEGER + 1;
        assert_eq!(
            rep.validate(),
            Err(ExecutionReportValidationError::InvalidDuration(
                MAX_SAFE_INTEGER + 1
            ))
        );
    }

    #[test]
    fn build_execution_prompt_none_target() {
        let prompt =
            build_execution_prompt(Some("Fix bug in parser"), Some("All tests green"), None);
        assert_eq!(
            prompt,
            "TASK\n\nFix bug in parser\n\nACCEPTANCE CRITERIA\n\nAll tests green"
        );
    }

    #[test]
    fn build_execution_prompt_with_managed_contract() {
        let mc = ManagedContract {
            path: std::path::PathBuf::from(
                "/var/ceo/state/runtime/att-123/managed-result.json",
            ),
            job_id: "job-aaaaaaaa-0000-0000-0000-000000000001".into(),
            attempt_id: "att-123".into(),
            resource_id: "res_456".into(),
        };
        let prompt = build_execution_prompt(
            Some("Update docs"),
            Some("Doc matches schema"),
            Some(&mc),
        );
        assert!(prompt.starts_with(
            "TASK\n\nUpdate docs\n\nACCEPTANCE CRITERIA\n\nDoc matches schema\n\nMANAGED RESULT CONTRACT\n\n"
        ));
        assert!(prompt.contains("/var/ceo/state/runtime/att-123/managed-result.json"));
        assert!(prompt.contains("\"resource_id\": \"res_456\""));
        assert!(prompt.contains("\"job_id\": \"job-aaaaaaaa-0000-0000-0000-000000000001\""));
        assert!(prompt.contains("\"attempt_id\": \"att-123\""));
        // Correct op; no forbidden op
        assert!(prompt.contains("\"op\": \"upsert_content\""));
        assert!(!prompt.contains("replace_body"));
    }
}
