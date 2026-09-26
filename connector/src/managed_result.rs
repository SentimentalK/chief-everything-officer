use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use thiserror::Error;

pub const MANAGED_RESULT_SCHEMA_VERSION: u32 = 1;
pub const MAX_MANAGED_RESULT_BYTES: usize = 64 * 1024; // 64 KiB limit

#[derive(Error, Debug)]
pub enum ManagedResultError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON decode error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Unsupported managed result schema_version: {0}")]
    UnsupportedSchemaVersion(u32),
    #[error("Correlation mismatch on '{field}': expected '{expected}', got '{actual}'")]
    CorrelationMismatch {
        field: &'static str,
        expected: String,
        actual: String,
    },
    #[error("Invalid managed result content: {0}")]
    InvalidContent(String),
    #[error("Security violation: {0}")]
    SecurityViolation(&'static str),
    #[error("Payload size {bytes} bytes exceeds maximum limit of {limit} bytes")]
    PayloadTooLarge { bytes: u64, limit: usize },
    #[error("Canonicalization error: {0}")]
    Canonicalization(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ManagedResultEnvelope {
    pub schema_version: u32,
    pub job_id: String,
    pub attempt_id: String,
    pub resource_id: String,
    pub summary: String,
    pub operations: Vec<serde_json::Value>,
}

impl ManagedResultEnvelope {
    pub fn validate_correlation(
        &self,
        expected_job_id: &str,
        expected_attempt_id: &str,
        expected_resource_id: Option<&str>,
    ) -> Result<(), ManagedResultError> {
        if self.schema_version != MANAGED_RESULT_SCHEMA_VERSION {
            return Err(ManagedResultError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        if self.job_id != expected_job_id {
            return Err(ManagedResultError::CorrelationMismatch {
                field: "job_id",
                expected: expected_job_id.to_string(),
                actual: self.job_id.clone(),
            });
        }
        if self.attempt_id != expected_attempt_id {
            return Err(ManagedResultError::CorrelationMismatch {
                field: "attempt_id",
                expected: expected_attempt_id.to_string(),
                actual: self.attempt_id.clone(),
            });
        }
        if let Some(expected_res) = expected_resource_id {
            if self.resource_id != expected_res {
                return Err(ManagedResultError::CorrelationMismatch {
                    field: "resource_id",
                    expected: expected_res.to_string(),
                    actual: self.resource_id.clone(),
                });
            }
        }
        if self.summary.trim().is_empty() {
            return Err(ManagedResultError::InvalidContent(
                "summary cannot be empty or whitespace".into(),
            ));
        }
        if self.operations.is_empty() {
            return Err(ManagedResultError::InvalidContent(
                "operations array cannot be empty".into(),
            ));
        }
        for (idx, op) in self.operations.iter().enumerate() {
            if let Some(obj) = op.as_object() {
                if let Some(op_kind) = obj.get("op").and_then(|v| v.as_str()) {
                    if op_kind == "attach_source_asset" {
                        return Err(ManagedResultError::InvalidContent(format!(
                            "operation[{idx}] 'attach_source_asset' is unsupported in V1.8 managed results"
                        )));
                    }
                } else {
                    return Err(ManagedResultError::InvalidContent(format!(
                        "operation[{idx}] missing 'op' discriminator string"
                    )));
                }
            } else {
                return Err(ManagedResultError::InvalidContent(format!(
                    "operation[{idx}] must be a JSON object"
                )));
            }
        }
        Ok(())
    }

    /// Computes RFC 8785 (JSON Canonicalization Scheme - JCS) SHA-256 digest.
    pub fn compute_canonical_sha256(&self) -> Result<String, ManagedResultError> {
        let canonical_bytes = serde_json_canonicalizer::to_vec(self)
            .map_err(|e| ManagedResultError::Canonicalization(e.to_string()))?;
        let mut hasher = Sha256::new();
        hasher.update(&canonical_bytes);
        Ok(format!("{:x}", hasher.finalize()))
    }
}

/// Reads a managed result file from the filesystem with full symlink and size defenses,
/// verifies correlation, and returns the envelope alongside its canonical SHA-256 digest.
pub fn read_and_validate_from_file(
    path: &Path,
    expected_job_id: &str,
    expected_attempt_id: &str,
    expected_resource_id: Option<&str>,
) -> Result<(ManagedResultEnvelope, String), ManagedResultError> {
    let meta = fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() {
        return Err(ManagedResultError::SecurityViolation(
            "managed result file cannot be a symlink",
        ));
    }
    if !meta.is_file() {
        return Err(ManagedResultError::SecurityViolation(
            "managed result path must be a regular file",
        ));
    }
    if meta.len() > MAX_MANAGED_RESULT_BYTES as u64 {
        return Err(ManagedResultError::PayloadTooLarge {
            bytes: meta.len(),
            limit: MAX_MANAGED_RESULT_BYTES,
        });
    }

    let content = fs::read_to_string(path)?;
    let envelope: ManagedResultEnvelope = serde_json::from_str(&content)?;
    envelope.validate_correlation(expected_job_id, expected_attempt_id, expected_resource_id)?;
    let digest = envelope.compute_canonical_sha256()?;
    Ok((envelope, digest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_valid_managed_result_roundtrip_and_jcs_digest() {
        let envelope = ManagedResultEnvelope {
            schema_version: 1,
            job_id: "job-11111111-1111-1111-1111-111111111111".into(),
            attempt_id: "att_22222222-2222-2222-2222-222222222222".into(),
            resource_id: "res-33333333-3333-3333-3333-333333333333".into(),
            summary: "Update resource title and content".into(),
            operations: vec![
                serde_json::json!({
                    "op": "upsert_content",
                    "content": "New resolved body"
                }),
                serde_json::json!({
                    "op": "rename",
                    "display_name": "New Resource Title"
                }),
            ],
        };

        assert!(envelope
            .validate_correlation(
                "job-11111111-1111-1111-1111-111111111111",
                "att_22222222-2222-2222-2222-222222222222",
                Some("res-33333333-3333-3333-3333-333333333333")
            )
            .is_ok());

        let digest = envelope.compute_canonical_sha256().unwrap();
        assert_eq!(
            digest,
            "404a4afe34a4729475ffae07d577d195ca36374eba39ee2e271a9b72b2a41685"
        );

        // Verify key ordering in JCS does not change digest
        let jcs_bytes = serde_json_canonicalizer::to_vec(&envelope).unwrap();
        let canonical_str = String::from_utf8(jcs_bytes).unwrap();
        assert!(canonical_str.starts_with(r#"{"attempt_id":"#));
    }

    #[test]
    fn test_correlation_mismatch_and_empty_checks() {
        let mut envelope = ManagedResultEnvelope {
            schema_version: 1,
            job_id: "job-1".into(),
            attempt_id: "att-1".into(),
            resource_id: "res-1".into(),
            summary: "Summary".into(),
            operations: vec![serde_json::json!({"op": "patch", "patch": "diff"})],
        };

        // Mismatched job_id
        assert!(matches!(
            envelope.validate_correlation("job-2", "att-1", Some("res-1")),
            Err(ManagedResultError::CorrelationMismatch { field: "job_id", .. })
        ));

        // Mismatched attempt_id
        assert!(matches!(
            envelope.validate_correlation("job-1", "att-2", Some("res-1")),
            Err(ManagedResultError::CorrelationMismatch { field: "attempt_id", .. })
        ));

        // Mismatched resource_id
        assert!(matches!(
            envelope.validate_correlation("job-1", "att-1", Some("res-2")),
            Err(ManagedResultError::CorrelationMismatch { field: "resource_id", .. })
        ));

        // Empty summary
        envelope.summary = "   ".into();
        assert!(matches!(
            envelope.validate_correlation("job-1", "att-1", Some("res-1")),
            Err(ManagedResultError::InvalidContent(_))
        ));

        // Empty operations
        envelope.summary = "Valid".into();
        envelope.operations = vec![];
        assert!(matches!(
            envelope.validate_correlation("job-1", "att-1", Some("res-1")),
            Err(ManagedResultError::InvalidContent(_))
        ));

        // Forbidden attach_source_asset
        envelope.operations = vec![serde_json::json!({
            "op": "attach_source_asset",
            "filename": "file.bin"
        })];
        assert!(matches!(
            envelope.validate_correlation("job-1", "att-1", Some("res-1")),
            Err(ManagedResultError::InvalidContent(_))
        ));
    }

    #[test]
    fn test_symlink_rejection() {
        let dir = tempdir().unwrap();
        let target_file = dir.path().join("real.json");
        let symlink_file = dir.path().join("managed-result.json");

        let envelope = ManagedResultEnvelope {
            schema_version: 1,
            job_id: "job-1".into(),
            attempt_id: "att-1".into(),
            resource_id: "res-1".into(),
            summary: "Valid".into(),
            operations: vec![serde_json::json!({"op": "patch", "patch": "diff"})],
        };

        fs::write(&target_file, serde_json::to_string(&envelope).unwrap()).unwrap();
        std::os::unix::fs::symlink(&target_file, &symlink_file).unwrap();

        let res = read_and_validate_from_file(&symlink_file, "job-1", "att-1", Some("res-1"));
        assert!(matches!(res, Err(ManagedResultError::SecurityViolation(_))));
    }

    #[test]
    fn test_size_limit_rejection() {
        let dir = tempdir().unwrap();
        let large_file = dir.path().join("large-result.json");

        let mut f = fs::File::create(&large_file).unwrap();
        // Write 65 KiB
        let chunk = vec![b'a'; 65 * 1024];
        f.write_all(&chunk).unwrap();

        let res = read_and_validate_from_file(&large_file, "job-1", "att-1", Some("res-1"));
        assert!(matches!(res, Err(ManagedResultError::PayloadTooLarge { .. })));
    }
}
